// Mock2 deploy step (Run phase) — the host/exec half. After a build cycle's
// gates pass (or on rehydrate of an already-built project), this runs INSIDE the
// fenced container, through host.js (R3 — never a raw exec): install deps →
// migrate against the in-container Postgres (ADR-008) → build → rewrite the
// mock2-dev.service ExecStart to the manifest `start` command → daemon-reload +
// restart → verify the app is actually serving. "Succeeded" means "running": a
// failure at any step is returned as a distinct, actionable result (deploy-logic
// deployFailureMessage), never a silent success.
//
// The DECISIONS (run-contract parse, unit string, step plan) are the pure
// deploy-logic.js; this module is the exec orchestration. It is always called by
// a holder of the checkout lock (ADR-004 — the runner cycle, or the rehydrate
// job that owns the container), so it does not take the lock itself.
//
// The install/migrate/build commands reach the internet over the bridge's Incus
// NAT (squid was removed). We still source /etc/environment so any operator-set
// env is honored, but there is no proxy to configure; if the registry is
// unreachable the deploy fails loudly.
//
// Terminology (risk R7): nothing here is named "agent".

import { createHash } from 'node:crypto';
import { sh, b64 } from './host.js';
import { scaffoldPwaFiles } from './scaffold.js';
import {
  parseRunContract, deployPlan, deployStepLabel, buildDevServiceUnit,
  execStartForStartCommand, deployFailureMessage, DEPLOY_STEP_TIMEOUTS_MS,
  freeWebPortScript, portHoldersReportScript,
  newBuildId, sanitizeBuildId, buildIdStampScript, buildStampReportScript, interpretBuildStamp,
  LEGACY_SW_JS,
} from './deploy-logic.js';
import { parseDeclaredEgress } from './egress-logic.js';
// The declared default port; a project row normally carries its own.
import { DEFAULT_WEB_PORT } from './template.js';
import { updateProject } from './projects.js';
import { installBrowserScript } from './scaffold-e2e.js';

const UNIT_PATH = '/etc/systemd/system/mock2-dev.service';

// Run a script inside the container (base64-streamed to `incus exec -- sh`, so
// no quoting hazard). Always resolves { code, stdout, stderr }.
function containerSh(containerName, script, { timeoutMs = 120000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

// Every deploy-step script carries this marker in its command line (a no-op
// shell comment), so a NEW deploy can reap scripts a DEAD backend left running
// in the container. The in-process queue serializes deploys within one backend
// process, but a backend restart (node --watch, an update) mid-deploy orphans
// the in-container script — it keeps running npm/systemctl and fights the next
// deploy (the ETXTBSY / EADDRINUSE churn seen after frequent restarts).
const DEPLOY_MARKER = 'mock2_deploy_marker';

// See the install-skip note in deployProjectUnqueued. The stamp lives INSIDE
// node_modules on purpose: any install path that wipes the tree (npm ci)
// wipes the stamp with it, so a half-installed tree can never read as fresh.
const INSTALL_STAMP_PATH = 'node_modules/.mock2-install-stamp';
const MANIFEST_HASH_CMD = `cat package.json package-lock.json 2>/dev/null | sha256sum | cut -d' ' -f1`;

// Run a deploy command in the app dir. Sources /etc/environment (so any
// operator-set env is present) then runs the command; egress is the bridge NAT.
// `set -a` makes the `KEY=VALUE` lines exported.
function runInApp(containerName, appDir, command, timeoutMs) {
  const script = `: ${DEPLOY_MARKER}\nset -a\n. /etc/environment 2>/dev/null || true\nset +a\ncd '${appDir}' || exit 97\n${command}\n`;
  return containerSh(containerName, script, { timeoutMs });
}

function tail(r) {
  return `${r?.stdout || ''}${r?.stderr ? `\n${r.stderr}` : ''}`.trim().slice(-800);
}

// readRunContract(containerName, appDir) → parse the deployed app's mock2.yaml
// run contract from the working tree (declared, not discovered — ADR-005).
export async function readRunContract(containerName, appDir = '/srv/app') {
  const r = await containerSh(containerName, `cat '${appDir}/mock2.yaml' 2>/dev/null`);
  return parseRunContract(r.stdout || '');
}

// readDeclaredEgress(containerName, appDir) → the parsed `egress:` list the app
// declares in mock2.yaml (declared, never discovered — extends ADR-005). The caller syncs
// it into the grant store (egress-grants.syncDeclaredEgress) so each new
// declaration becomes a pending admin-queue item and a removed one is revoked.
export async function readDeclaredEgress(containerName, appDir = '/srv/app') {
  const r = await containerSh(containerName, `cat '${appDir}/mock2.yaml' 2>/dev/null`);
  return parseDeclaredEgress(r.stdout || '');
}

// All deploy entry points — the build cycle's deploy stage, "Retry deploy",
// the base-app deploy, the rehydrate restore — can fire independently, and two
// deploys interleaving on ONE container stomp the same unit and web port: each
// runs freeWebPortScript then `systemctl start`, so one instance binds and the
// other crash-loops on EADDRINUSE until the health window closes. One
// in-process queue per container serializes them; a queued deploy simply runs
// after the current one finishes (idempotent — it redeploys the same checkout).
const deployQueues = new Map();

// deployProject({ containerName, appDir, webPort, runContract, onStep }) →
// { ok, step, error }. Runs the ordered plan, then swaps the unit and restarts,
// then health-checks the web port. onStep(key, label) reports progress (wired to
// setJob so the CycleCard shows "Installing dependencies…" etc.).
export async function deployProject(args) {
  const key = String(args?.containerName || '');
  const prev = deployQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => deployProjectUnqueued(args));
  deployQueues.set(key, run);
  try {
    return await run;
  } finally {
    if (deployQueues.get(key) === run) deployQueues.delete(key);
  }
}

async function deployProjectUnqueued({
  containerName, appDir = '/srv/app', webPort = 3000, runContract, onStep = null,
}) {
  // Reap deploy scripts a dead backend orphaned in this container (see
  // DEPLOY_MARKER) — they keep running npm/systemctl and corrupt this deploy.
  // pkill never signals its own process, so carrying the marker string in the
  // killer's own command line is safe.
  await containerSh(containerName, `pkill -9 -f ${DEPLOY_MARKER} 2>/dev/null || true`).catch(() => {});

  const contract = runContract && runContract.hasContract
    ? runContract
    : await readRunContract(containerName, appDir);

  // No run contract (an old placeholder project) — nothing to deploy; the
  // placeholder serve.py keeps serving. Not a failure.
  if (!contract.hasContract) {
    return { ok: true, skipped: true };
  }

  const report = (key) => { if (onStep) onStep(key, deployStepLabel(key)); };

  // 1) install → migrate → build (each bounded, proxy env sourced).
  for (const step of deployPlan(contract)) {
    report(step.key);
    // Install skip: sha256 of package.json + package-lock.json, stamped into
    // node_modules after a successful install. Unchanged manifests + an
    // existing node_modules ⇒ nothing to install — a quick edit that touched
    // one HTML file otherwise paid a full `npm ci` (often the longest
    // non-model step) on every deploy. `npm ci` deletes node_modules, so a
    // real install clears the stamp until it succeeds again; the dependency
    // repair passes rewrite the manifests, which changes the hash and forces
    // the install back on. Only for npm-based contracts — a custom install
    // command may do more than the manifests describe.
    if (step.key === 'install' && /npm/.test(step.command)) {
      const fresh = await runInApp(
        containerName, appDir,
        `hash=$(${MANIFEST_HASH_CMD})\n[ -d node_modules ] && [ -f '${INSTALL_STAMP_PATH}' ] && [ "$(cat '${INSTALL_STAMP_PATH}' 2>/dev/null)" = "$hash" ] && echo MOCK2_INSTALL_FRESH || true`,
        30000,
      );
      if (/MOCK2_INSTALL_FRESH/.test(fresh.stdout || '')) {
        if (onStep) onStep('install', 'Dependencies unchanged — install skipped.');
        continue;
      }
    }
    let r = await runInApp(containerName, appDir, step.command, step.timeoutMs);
    // ETXTBSY on install is a transient race on a native binary (esbuild's
    // postinstall re-executes the file npm just wrote — a known npm flake on
    // container filesystems, or the wake of a concurrent install that has
    // since been serialized away). One clean retry after the tree settles
    // resolves it; any other failure is real and returned as-is.
    if (r.code !== 0 && step.key === 'install' && /ETXTBSY|text file busy/i.test(tail(r))) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      r = await runInApp(containerName, appDir, step.command, step.timeoutMs);
    }
    if (r.code !== 0) {
      return { ok: false, step: step.key, error: deployFailureMessage(step.key, tail(r)) };
    }
    if (step.key === 'install') {
      await runInApp(containerName, appDir, `hash=$(${MANIFEST_HASH_CMD}); printf '%s' "$hash" > '${INSTALL_STAMP_PATH}'`, 15000).catch(() => {});
    }
  }

  // 1a) The Playwright browser, once per container.
  //
  //     The project ships a real browser suite (scaffold-e2e.js) and Playwright
  //     needs a Chromium (~170MB) to run it. Installed HERE rather than at
  //     provision so an EXISTING project picks it up on its next deploy too,
  //     and guarded by an "is it already there" check so it costs one `ls` on
  //     every deploy after the first.
  //
  //     Strictly best-effort: no egress, a slow CDN or a full disk must never
  //     fail a deploy over a test tool. When it does not land, the e2e gate
  //     skips with the exact command to run.
  await installE2eBrowser(containerName, appDir, onStep).catch(() => {});

  // 1b) Stamp this deploy's BUILD ID into the PWA plumbing, after the build (so
  //     the built output is stamped too) and before the restart.
  //
  //     This is the fix for the "I deployed but the browser still runs the old
  //     code" class of failure: a service worker only updates when sw.js's BYTES
  //     change, and it only drops old cached assets when the cache NAME changes.
  //     With a hardcoded cache name neither ever happened, so a client could
  //     serve pre-deploy JS indefinitely while the server served the new build —
  //     three builds were burned chasing exactly that ghost. Stamping a fresh id
  //     per deploy changes both, and writes the id where the post-deploy check
  //     can compare what the CLIENT ran against what the SERVER has.
  //
  //     Best-effort by design: a project without these files (an older scaffold)
  //     is simply left alone — never a deploy failure.
  await retrofitPwaBuildPlumbing(containerName, appDir).catch(() => {});
  await stampBuildId(containerName, appDir).catch(() => {});

  // 2) Rewrite the systemd unit's ExecStart to the manifest `start` command,
  //    reload, and restart. WantedBy=multi-user.target already persists, so a
  //    later container restart brings the built app back (idempotency point 5).
  report('start');
  const execStart = execStartForStartCommand(contract.start, { appDir });
  const unit = buildDevServiceUnit({ appDir, webPort, execStart });
  const swap = await containerSh(
    containerName,
    `: ${DEPLOY_MARKER}\n`
      + `printf '%s' '${b64(unit)}' | base64 -d > ${UNIT_PATH}\n`
      + `systemctl daemon-reload\n`
      + `systemctl enable mock2-dev.service >/dev/null 2>&1 || true\n`
      // Free the web port before starting so a fresh instance never races an
      // orphan a prior deploy left on it (the EADDRINUSE crash-loop). Then a
      // clean start rather than restart-into-a-storm.
      + `${freeWebPortScript(webPort)}\n`
      + `systemctl start mock2-dev.service\n`,
    { timeoutMs: DEPLOY_STEP_TIMEOUTS_MS.start },
  );
  if (swap.code !== 0) {
    return { ok: false, step: 'start', error: deployFailureMessage('start', tail(swap)) };
  }

  // 3) Health-check: the app must actually SERVE ITS SHELL before we call the
  //    cycle "succeeded" ("succeeded" ⇒ running AND not erroring). Poll the port a
  //    few times (the app needs a moment to bind). A booted-but-broken app that
  //    answers the root with a 5xx is NOT serving — that's the "compiles but
  //    doesn't work" failure mode, and calling it success is exactly what let
  //    broken builds ship. So we accept any 2xx/3xx/4xx (the app is up and its
  //    own routing is its concern) but treat a 5xx server error on the shell, or a
  //    refused/failed CONNECTION (000), as not-serving.
  report('health');
  const health = await containerSh(
    containerName,
    `: ${DEPLOY_MARKER}\nlast="000"\ni=0\nwhile [ $i -lt 45 ]; do\n`
      + `  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${webPort}/" 2>/dev/null)\n`
      + `  [ -n "$code" ] && last="$code"\n`
      + `  if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then echo "MOCK2_SERVING ($code)"; exit 0; fi\n`
      + `  i=$((i+1)); sleep 2\n`
      + `done\n`
      + `echo "MOCK2_NOT_SERVING (last http_code: $last)"\n`
      + `echo "# service state:"; systemctl is-active mock2-dev.service 2>&1 || true\n`
      // Who holds the web port RIGHT NOW — when the crash reason is
      // EADDRINUSE this names the offending process instead of leaving the
      // operator guessing. Tool-independent: falls back to /proc when ss is
      // not installed (the old ss-only line printed "(nothing bound)" over a
      // held port on minimal images).
      + `echo "# port ${webPort} holders:"\n${portHoldersReportScript(webPort)}\n`
      + `echo "# recent app output (this is the crash reason if it exits after starting, or the 5xx cause):"\n`
      + `journalctl -u mock2-dev.service --no-pager -n 25 2>/dev/null || true\n`,
    { timeoutMs: DEPLOY_STEP_TIMEOUTS_MS.health },
  );
  if (!/MOCK2_SERVING/.test(health.stdout || '')) {
    // Keep BOTH ends of the output: the head carries the status line, service
    // state, and the port-holder identification (the EADDRINUSE culprit); the
    // tail carries the crash reason from the journal. A plain tail-slice let a
    // long journal push the holder line out of the message entirely.
    const raw = `${health?.stdout || ''}${health?.stderr ? `\n${health.stderr}` : ''}`.trim();
    const detail = raw.length > 2600
      ? `${raw.slice(0, 1200)}\n… (trimmed) …\n${raw.slice(-1200)}`
      : raw;
    return { ok: false, step: 'health', error: deployFailureMessage('health', detail) };
  }

  // The app answers — but does what it serves actually REACH a browser? Read
  // back the stamped build ids. A stale-risk verdict is reported alongside a
  // successful deploy (it is a client-cache warning, not a serving failure), so
  // the operator learns immediately instead of after several "please fix" rounds.
  const buildStamp = await verifyBuildStamp(containerName, appDir);

  return { ok: true, step: 'serving', buildStamp };
}

// Record the commit the app is now SERVING (best-effort). Every successful
// deploy path calls this; the runner's verified-no-op deploy skip compares it
// to HEAD so committed-but-undeployed work always deploys.
// stampBuildId — write this deploy's build id into the PWA plumbing (sw.js,
// build-id.js, build-id.txt) inside the container. The script itself is pure
// (deploy-logic.buildIdStampScript) so its idempotency is unit-tested.
export async function stampBuildId(containerName, appDir = '/srv/app', buildId = newBuildId()) {
  const id = sanitizeBuildId(buildId);
  const r = await containerSh(containerName, buildIdStampScript(appDir, id), { timeoutMs: 20000 });
  return { ok: /MOCK2_BUILD_ID:/.test(r.stdout || ''), buildId: id };
}

// retrofitPwaBuildPlumbing — bring a project built BEFORE this instrumentation
// up to date, on its next deploy, without ever clobbering a customization.
//
// Two rules, matching the auth wiring's keep-existing semantics:
//   * build-id.js / build-id.txt are ADDITIVE — written only when absent.
//   * public/sw.js is replaced ONLY when it is byte-identical to the known
//     legacy worker (the hardcoded-cache version that can never update). A
//     worker a build has customized is left alone; verifyBuildStamp then
//     reports the residual stale risk rather than silently overwriting work.
export async function retrofitPwaBuildPlumbing(containerName, appDir = '/srv/app') {
  const legacyHash = createHash('sha256').update(LEGACY_SW_JS, 'utf8').digest('hex');
  const { swJs: CURRENT_SW_JS, buildIdJs: BUILD_ID_JS } = scaffoldPwaFiles();
  const script = `cd '${appDir}' 2>/dev/null || exit 0
[ -d public ] || exit 0
[ -f public/build-id.js ] || printf '%s' '${b64(BUILD_ID_JS)}' | base64 -d > public/build-id.js
[ -f public/build-id.txt ] || printf '%s\n' '${BUILD_ID_PLACEHOLDER}' > public/build-id.txt
if [ -f public/sw.js ]; then
  cur=$(sha256sum public/sw.js 2>/dev/null | cut -d' ' -f1)
  if [ "$cur" = '${legacyHash}' ]; then
    printf '%s' '${b64(CURRENT_SW_JS)}' | base64 -d > public/sw.js
    echo MOCK2_SW_RETROFIT
  fi
fi
echo MOCK2_RETROFIT_DONE`;
  const r = await containerSh(containerName, script, { timeoutMs: 20000 });
  return { ok: /MOCK2_RETROFIT_DONE/.test(r.stdout || ''), swReplaced: /MOCK2_SW_RETROFIT/.test(r.stdout || '') };
}

// verifyBuildStamp — read back the stamped ids and judge whether a deploy can
// actually reach a browser. Never throws and never fails a deploy: it reports,
// so the cycle can surface "clients may be serving a stale cache" instead of
// the operator discovering it three builds later.
export async function verifyBuildStamp(containerName, appDir = '/srv/app') {
  try {
    const r = await containerSh(containerName, buildStampReportScript(appDir), { timeoutMs: 15000 });
    return interpretBuildStamp(r.stdout || '');
  } catch (err) {
    return { ok: true, instrumented: false, stale_risk: false, detail: `build-stamp check skipped: ${err?.message || err}` };
  }
}

export async function stampDeployedCommit(projectId, containerName, appDir) {
  try {
    const r = await containerSh(containerName, `git -C '${appDir}' rev-parse HEAD 2>/dev/null\n`, { timeoutMs: 30000 });
    const sha = String(r.stdout || '').trim().split('\n').pop().trim();
    if (/^[0-9a-f]{40}$/.test(sha)) updateProject(projectId, { deployed_commit: sha });
  } catch { /* the stamp is advisory; a miss only costs one redundant deploy */ }
}

// ---- "is it actually serving?" ----------------------------------------
//
// WHY THIS EXISTS. A build can finish, pass every gate, checkpoint cleanly —
// and leave nothing answering on the project's URL. It happened: the anomaly
// tripwire HELD the deploy of a project's very first build, so the app was
// never started, and the only signal was the design review screenshotting
// ERR_CONNECTION_REFUSED. The operator had to notice and press Deploy.
//
// Nothing in the pipeline asked the simplest possible question afterwards:
// does the URL answer? This asks it, and fixes it when the answer is no.

// installE2eBrowser — the one-time Chromium download for the project's own
// Playwright suite. Idempotent (the script returns immediately when the browser
// cache is populated) and never throws into the deploy.
export async function ensureE2eBrowser(project) {
  const containerName = project?.container_name;
  if (!containerName || project.lifecycle !== 'active') return;
  await installE2eBrowser(containerName, '/srv/app', null);
}

async function installE2eBrowser(containerName, appDir, onStep) {
  const probe = await runInApp(
    containerName, appDir,
    '[ -f playwright.config.ts ] || [ -f playwright.config.js ] || exit 1\n'
    + '[ -n "$(ls -A "$HOME/.cache/ms-playwright" 2>/dev/null)" ] && exit 1\n'
    + 'exit 0',
    20000,
  ).catch(() => ({ code: 1 }));
  // Non-zero means "no suite" or "already installed" — either way, nothing to do.
  if (probe.code !== 0) return;
  if (onStep) onStep('e2e-browser', 'Installing the test browser (one time)…');
  const r = await runInApp(containerName, appDir, installBrowserScript(appDir), 600000).catch(() => null);
  if (!r || r.code !== 0) {
    console.warn(`[mock2] e2e browser install did not complete for ${containerName} — the e2e gate will skip until it does`);
  }
}

// probeServing — one cheap request from INSIDE the container. Same accept rule
// as the deploy health check: anything under 500 means the app is up and its
// own routing is its business; a 5xx or a refused connection is not serving.
export async function probeServing(project, { timeoutMs = 15000 } = {}) {
  const containerName = project?.container_name;
  const port = project?.web_port || DEFAULT_WEB_PORT;
  if (!containerName || project.lifecycle !== 'active') {
    return { serving: false, reason: 'the project is not online' };
  }
  try {
    const r = await containerSh(
      containerName,
      `code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}/" 2>/dev/null)\n`
      + `echo "CODE:\${code:-000}"\n`,
      { timeoutMs },
    );
    const code = (String(r.stdout || '').match(/CODE:(\d+)/) || [])[1] || '000';
    const n = Number(code);
    return { serving: n > 0 && n < 500, code: n, reason: n === 0 ? 'connection refused' : `http ${n}` };
  } catch (e) {
    return { serving: false, reason: e?.message || 'probe failed' };
  }
}

// ensureServing — probe, and deploy if the app is not answering.
//
// Idempotent and cheap in the happy path (one curl). Best-effort: it never
// throws into the caller, because the caller is usually a build closing out.
// Returns { serving, redeployed, error }.
export async function ensureServing(project, { reason = 'post-build' } = {}) {
  const first = await probeServing(project);
  if (first.serving) return { serving: true, redeployed: false };

  console.warn(`[mock2] project ${project?.id} is not serving after ${reason} (${first.reason}) — deploying`);
  try {
    const out = await deployProject({
      containerName: project.container_name,
      webPort: project.web_port || DEFAULT_WEB_PORT,
      projectId: project.id,
    });
    if (!out?.ok) return { serving: false, redeployed: true, error: out?.error || `deploy failed at ${out?.step || 'unknown'}` };
    const after = await probeServing(project);
    return { serving: after.serving, redeployed: true, error: after.serving ? null : after.reason };
  } catch (e) {
    return { serving: false, redeployed: false, error: e?.message || 'deploy threw' };
  }
}
