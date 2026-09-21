// Setup engine — THE deploy operation (docs/features/setup-engine.md § "The
// deploy"). One implementation of install → migrate → build → stop → mint →
// unit → start → health → verify, over an injected guest executor, so the same
// code runs in the host runner (`incus exec` as root on the host) and in the
// backend's in-process fallback (the nsenter pivot) when no runner is live.
// There is no second deploy path.
//
// Pure of native dependencies: deploy-logic, component-logic, auth-data-logic,
// readiness-logic, scaffold text and the guest probes are all dependency-free
// modules. Everything the operation needs to know about the PROJECT — the
// installed components' secret contracts, the port, the app dir — arrives in
// the plan as references the server resolved (deploy.js builds it); the run
// contract is read from the guest's own mock2.yaml when the plan does not
// carry it. No value that is a secret is ever in the plan: the mint generates
// its values here, writes them into the guest's environment file, and records
// only their NAMES (job.generated), which a retry reuses because
// planSecretMint never overwrites a key that exists.
//
// Ownership (R2): `job.fence()` is called before every guest command and
// throws when the job's owner or epoch moved; `job.checkpoint()` is written
// BEFORE the app is stopped (app_stopped: true, disruptive: true) and again
// when the new unit is started (app_stopped: false). The recovery references
// (unit file, environment file, generated key names, the data guard, the
// contract) live under checkpoint.recovery and are never cleared by the
// operation — they outlive the stopped-app marker until verification is done.
//
// Before anything else, the operation reaps scripts a previous writer left in
// the guest (every deploy script carries DEPLOY_MARKER in its command line)
// and confirms none survive; a writer that cannot be stopped fails the
// operation rather than racing it.

import { createHash } from 'node:crypto';
import {
  parseRunContract, deployPlan, deployStepLabel, buildDevServiceUnit, validateDeployEnvironment, execStartForStartCommand,
  deployFailureMessage, DEPLOY_STEP_TIMEOUTS_MS, freeWebPortScript, portHoldersReportScript, servingProbeScript,
  restartVerdict, restartOutcomeText, newBuildId, sanitizeBuildId, buildIdStampScript, buildStampReportScript, interpretBuildStamp,
  LEGACY_SW_JS, BUILD_ID_PLACEHOLDER,
} from '../../mock2/deploy-logic.js';
import { secretMintGuards, secretDataGuards, componentSecretKeys, planSecretMint } from '../../mock2/component-logic.js';
import { authDataProbeScript, parseAuthDataProbe, classifyRows, decideMasterSecretMint } from '../../mock2/auth-data-logic.js';
import { mergeEnvFile } from '../mcp-ext/logic.js';
import { scaffoldPwaFiles } from '../../mock2/scaffold.js';
import { installBrowserScript } from '../../mock2/scaffold-e2e.js';
import { activeKeyScript, credentialProbeScript, credentialVerdict, healthScript, parseHealth, verificationFromObservations, parseUnitStatus } from './guest-probes.js';
import { sanitizeReason } from './logic.js';

export const DEPLOY_MARKER = 'mock2_deploy_marker';
export const UNIT_NAME = 'mock2-dev.service';
export const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;
export const INSTALL_STAMP_PATH = 'node_modules/.mock2-install-stamp';
const MANIFEST_HASH_CMD = `cat package.json package-lock.json 2>/dev/null | sha256sum | cut -d' ' -f1`;
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const shq = (s) => String(s).replace(/'/g, "'\\''");

export class PreviousWriterAliveError extends Error {
  constructor(container, survivors) {
    super(`a previous deploy's scripts are still running in ${container} after being signalled (${survivors} process(es)); refusing to deploy over them`);
    this.name = 'PreviousWriterAliveError';
    this.code = 'PREVIOUS_WRITER_ALIVE';
  }
}

// reapOrphansScript() → kills every process carrying the marker, then reports
// how many still carry it: `ORPHANS:<n>`. pkill never signals its own shell
// (the marker rides in this script's own text too, which is why the count
// excludes the reporting shell by pid).
export function reapOrphansScript() {
  return [
    `pkill -9 -f ${DEPLOY_MARKER} 2>/dev/null || true`,
    'sleep 1',
    `n=$(pgrep -f ${DEPLOY_MARKER} 2>/dev/null | grep -v "^$$\$" | wc -l | tr -d ' ')`,
    'echo "ORPHANS:${n:-0}"',
    '',
  ].join('\n');
}

export function parseOrphans(stdout) {
  const m = String(stdout || '').match(/^ORPHANS:(\d+)/m);
  return m ? Number(m[1]) : null;
}

function tail(r) {
  return `${r?.stdout || ''}${r?.stderr ? `\n${r.stderr}` : ''}`.trim().slice(-800);
}

function noopJob() {
  return { fence: () => {}, checkpoint: () => 0, generated: () => 0, event: () => {}, onStep: null };
}

// resolveDeployPlan(params) → the operation's inputs with defaults applied.
export function resolveDeployPlan(params = {}) {
  return {
    container: String(params.container || ''),
    appDir: String(params.appDir || '/srv/app'),
    webPort: Number(params.webPort) || 3000,
    unit: UNIT_NAME,
    environmentFile: String(params.environmentFile || '/etc/environment'),
    contract: params.contract || null,
    secrets: { configs: Array.isArray(params.secrets?.configs) ? params.secrets.configs : [], newlyProvisioned: params.secrets?.newlyProvisioned === true },
    guard: params.guard || null,
    reapOrphans: params.reapOrphans !== false,
  };
}

// runDeployOperation({ params, exec, job, log }) → the deploy result:
//   { ok: true, skipped: true }                                  no run contract
//   { ok: true, step: 'serving', buildStamp, verification, minted }
//   { ok: false, step, error, verification? }                    a distinct failure
// Throws only on a fence (ownership moved) or an executor failure it cannot
// express as a step result.
export async function runDeployOperation({ params, exec, job = noopJob(), log = () => {} }) {
  const p = resolveDeployPlan(params);
  const { container, appDir, webPort, environmentFile } = p;
  const guestRaw = (script, timeoutMs) => exec.guest(container, script, { timeoutMs });
  // Before the disruptive step every fence is a SAFE point: a requested
  // cancel is honoured there (CancelledError) and nothing has changed in the
  // guest but its build outputs. From the stop onward a cancel is not
  // honoured mid-way — the operation finishes bringing the app up.
  let disruptiveBegun = false;
  const guest = async (phase, script, timeoutMs) => {
    job.fence({ safe: !disruptiveBegun });
    const r = await guestRaw(script, timeoutMs);
    return r || { code: -1, stdout: '', stderr: 'no result from the guest executor' };
  };
  const runInApp = (command, timeoutMs) => guest('run', `: ${DEPLOY_MARKER}\nset -a\n. ${environmentFile} 2>/dev/null || true\nset +a\ncd '${appDir}' || exit 97\n${command}\n`, timeoutMs);
  const report = (key, label) => { try { job.onStep?.(key, label || deployStepLabel(key)); } catch { /* */ } };
  const mark = (phase, data, message) => { try { job.checkpoint(phase, data, message); } catch { /* never fails the deploy */ } };

  // 0) Nobody else's scripts may be running in this guest.
  if (p.reapOrphans) {
    const reap = await guest('reap', reapOrphansScript(), 30_000);
    const survivors = parseOrphans(reap.stdout);
    if (survivors == null) log('reap', `could not count orphan scripts in ${container}: ${tail(reap)}`);
    else if (survivors > 0) {
      const again = await guest('reap', reapOrphansScript(), 30_000);
      const left = parseOrphans(again.stdout);
      if (left == null || left > 0) throw new PreviousWriterAliveError(container, left ?? survivors);
    }
  }

  // The contract: from the plan, or the guest's own manifest.
  let contract = p.contract && p.contract.hasContract ? p.contract : null;
  if (!contract) {
    const y = await guest('contract', `cat '${appDir}/mock2.yaml' 2>/dev/null || true\n`, 15_000);
    contract = parseRunContract(y.stdout || '');
  }
  if (!contract.hasContract) return { ok: true, skipped: true };

  const recovery = {
    container, appDir, webPort, unit: p.unit, unitPath: UNIT_PATH, environmentFile,
    contract: { install: contract.install || null, migrate: contract.migrate || null, build: contract.build || null, start: contract.start },
    guard: p.guard || null, generatedKeys: [],
  };
  mark('starting', { app_stopped: false, resumable: true, container, webPort, unit: p.unit, recovery }, 'deploy started; install, migrate and build come first');

  // 1) install → migrate → build.
  for (const step of deployPlan(contract)) {
    report(step.key);
    if (step.key === 'install' && /npm/.test(step.command)) {
      const fresh = await runInApp(`hash=$(${MANIFEST_HASH_CMD})\n[ -d node_modules ] && [ -f '${INSTALL_STAMP_PATH}' ] && [ "$(cat '${INSTALL_STAMP_PATH}' 2>/dev/null)" = "$hash" ] && echo MOCK2_INSTALL_FRESH || true`, 30_000);
      if (/MOCK2_INSTALL_FRESH/.test(fresh.stdout || '')) { report('install', 'Dependencies unchanged — install skipped.'); continue; }
    }
    let r = await runInApp(step.command, step.timeoutMs);
    if (r.code !== 0 && step.key === 'install' && /ETXTBSY|text file busy/i.test(tail(r))) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      r = await runInApp(step.command, step.timeoutMs);
    }
    if (r.code !== 0) return { ok: false, step: step.key, error: deployFailureMessage(step.key, tail(r)) };
    if (step.key === 'install') await runInApp(`hash=$(${MANIFEST_HASH_CMD}); printf '%s' "$hash" > '${INSTALL_STAMP_PATH}'`, 15_000).catch((e) => { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; });
    mark(step.key, { app_stopped: false, resumable: true }, `${step.key} finished`);
  }

  // 1a) The e2e browser (best effort) and the PWA build stamp.
  // Best effort — except that a fence or a cancel raised inside them is the
  // operation's to honour, never to swallow.
  const control = (e) => { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; };
  await installE2eBrowser(runInApp, appDir, report).catch(control);
  await retrofitPwaBuildPlumbing(guest, appDir).catch(control);
  const buildId = await stampBuildId(guest, appDir).catch((e) => { control(e); return null; });

  // 1.5) The disruptive step. The checkpoint goes first.
  report('start');
  mark('build_done', { app_stopped: false, resumable: true, buildId: buildId?.buildId || null }, 'install, migrate and build finished; about to stop the application');
  const restartUnit = async () => {
    const r = await guestRaw(`systemctl daemon-reload >/dev/null 2>&1 || true\nsystemctl start ${p.unit} >/dev/null 2>&1 || true\n${servingProbeScript(webPort, 10)}`, 90_000).catch(() => null);
    const verdict = restartVerdict(r?.stdout);
    mark('restart_attempted', { app_stopped: verdict !== 'serving', restart_verdict: verdict }, `restart attempted after a failure: ${verdict}`);
    return restartOutcomeText(verdict);
  };
  disruptiveBegun = true;
  mark('stopping_app', { app_stopped: true, resumable: false, disruptive: true }, 'stopping the application before the key check and mint');
  const stop = await guest('stop', `: ${DEPLOY_MARKER}\nsystemctl stop ${p.unit} >/dev/null 2>&1 || true\n${freeWebPortScript(webPort)}\n`, DEPLOY_STEP_TIMEOUTS_MS.start);
  if (stop.code !== 0) {
    const back = await restartUnit();
    return { ok: false, step: 'start', error: deployFailureMessage('start', `could not stop the running app before the key check: ${tail(stop)}. ${back}`) };
  }

  // Mint the secrets the installed components own (the gate-one rules, in
  // full: markers on source AND built artifact, the data probe as the app's
  // role, never overwrite an existing key, defer and say why).
  let requiredSecretKeys = [];
  let minted = [];
  let deferred = [];
  try {
    const m = await mintComponentSecrets({ guest, appDir, environmentFile, configs: p.secrets.configs, newlyProvisioned: p.secrets.newlyProvisioned, writersStopped: true, job });
    if (!m.ok) {
      const back = await restartUnit();
      return { ok: false, step: 'start', error: deployFailureMessage('start', `could not mint the application's secrets: ${m.error}. ${back}`) };
    }
    requiredSecretKeys = m.required;
    minted = m.minted;
    deferred = m.deferred;
    if (m.minted.length) {
      recovery.generatedKeys = [...new Set([...recovery.generatedKeys, ...m.minted])];
      mark('secrets_minted', { app_stopped: true, resumable: false, recovery }, `minted ${m.minted.join(', ')} into ${environmentFile} (names only)`);
    }
  } catch (e) {
    if (e?.code === 'FENCED') throw e;
    const back = await restartUnit();
    return { ok: false, step: 'start', error: deployFailureMessage('start', `application secret minting failed: ${e?.message || e}. ${back}`) };
  }

  // 2) The unit.
  const execStart = execStartForStartCommand(contract.start, { appDir });
  const unit = buildDevServiceUnit({ appDir, webPort, execStart });
  const envRead = await guest('env', `cat ${environmentFile} 2>/dev/null || true`, 15_000);
  const mode = validateDeployEnvironment({ unitText: unit, environmentText: envRead.stdout || '', requiredKeys: requiredSecretKeys });
  if (!mode.ok) {
    const back = await restartUnit();
    return { ok: false, step: 'start', error: deployFailureMessage('start', `${mode.error}. ${back}`) };
  }
  const swap = await guest('unit', `: ${DEPLOY_MARKER}\nprintf '%s' '${b64(unit)}' | base64 -d > ${UNIT_PATH}\nsystemctl daemon-reload\nsystemctl enable ${p.unit} >/dev/null 2>&1 || true\n${freeWebPortScript(webPort)}\nsystemctl start ${p.unit}\n`, DEPLOY_STEP_TIMEOUTS_MS.start);
  mark('unit_written', { app_stopped: true, unit_swapped: true }, 'new unit file written');
  if (swap.code !== 0) {
    const back = await restartUnit();
    return { ok: false, step: 'start', error: deployFailureMessage('start', `${tail(swap)}\n${back}`) };
  }
  mark('app_started', { app_stopped: false, unit_swapped: true }, 'new unit written and started; health check next');

  // 3) Health: the app must SERVE.
  report('health');
  const health = await guest('health', `: ${DEPLOY_MARKER}\nlast="000"\ni=0\nwhile [ $i -lt 45 ]; do\n`
    + `  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${webPort}/" 2>/dev/null)\n`
    + `  [ -n "$code" ] && last="$code"\n`
    + `  if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then echo "MOCK2_SERVING ($code)"; exit 0; fi\n`
    + `  i=$((i+1)); sleep 2\ndone\n`
    + `echo "MOCK2_NOT_SERVING (last http_code: $last)"\n`
    + `echo "# service state:"; systemctl is-active ${p.unit} 2>&1 || true\n`
    + `echo "# port ${webPort} holders:"\n${portHoldersReportScript(webPort)}\n`
    + `echo "# recent app output (this is the crash reason if it exits after starting, or the 5xx cause):"\n`
    + `journalctl -u ${p.unit} --no-pager -n 25 2>/dev/null || true\n`, DEPLOY_STEP_TIMEOUTS_MS.health);
  const obs = { unit: parseUnitStatus('UNIT_LOADED:yes\nUNIT_ENABLED:enabled\nUNIT_ACTIVE:unknown\n'), port: null, health: null, credential: null };
  if (!/MOCK2_SERVING/.test(health.stdout || '')) {
    const raw = `${health?.stdout || ''}${health?.stderr ? `\n${health.stderr}` : ''}`.trim();
    const detail = raw.length > 2600 ? `${raw.slice(0, 1200)}\n… (trimmed) …\n${raw.slice(-1200)}` : raw;
    obs.port = { observed: true, responding: false, code: 0 };
    return { ok: false, step: 'health', error: deployFailureMessage('health', detail), verification: verificationFromObservations(obs), minted, deferred };
  }
  obs.port = { observed: true, responding: true, code: Number((health.stdout.match(/MOCK2_SERVING \((\d+)\)/) || [])[1]) || 200 };

  // 4) Verification (R4): application health, then the stored credential
  //    under the configured key. The application-owned rung is the server's
  //    (deploy.js verifyCredentialUse); it is left null here, by name.
  const buildStamp = await verifyBuildStamp(guest, appDir);
  obs.health = parseHealth((await guest('health_check', healthScript(webPort), 60_000)).stdout);
  if (p.guard) {
    try {
      const envKey = String((await guest('read_active_key', activeKeyScript(environmentFile), 15_000)).stdout || '').trim();
      const probeRun = await guest('verify_credential', credentialProbeScript(p.guard), 30_000);
      obs.credential = credentialVerdict({ guard: p.guard, envKey, probeStdout: probeRun.stdout });
    } catch (e) {
      if (e?.code === 'FENCED') throw e;
      obs.credential = { verified: null, code: null, detail: `the credential probe could not run: ${sanitizeReason(e?.message || String(e))}` };
    }
  } else {
    obs.credential = { verified: null, code: null, detail: 'no data guard recorded for this app; the stored-credential check was not run' };
  }
  const verification = verificationFromObservations({ ...obs, credentialUse: { verified: null, detail: 'application-owned credential check not run by the deploy (the server runs it after the job)' } });
  mark('verified', { app_stopped: false, verification_state: verification.state }, `verification: ${verification.label}`);
  return { ok: true, step: 'serving', buildStamp, verification, minted, deferred };
}

// ── the mint (a faithful port of component-install.ensureComponentSecrets) ──

async function mintComponentSecrets({ guest, appDir, environmentFile, configs, newlyProvisioned, writersStopped, job }) {
  const owned = (configs || []).filter((c) => c && c.secret === true && c.generate === true);
  if (!owned.length) return { ok: true, minted: [], deferred: [], required: [] };
  const deferred = [];
  let eligible = owned;
  const guards = secretMintGuards(owned);
  if (guards.length) {
    const script = guards.map((g) => {
      const src = `grep -q -F -- '${shq(g.contains)}' '${appDir}/${shq(g.path)}' 2>/dev/null`;
      if (!g.built) return `if ${src}; then echo "MARKER OK ${g.key}"; else echo "MARKER MISSING ${g.key}"; fi`;
      const builtPath = `'${appDir}/${shq(g.built)}'`;
      return `if ! ${src}; then echo "MARKER MISSING ${g.key}"; elif [ ! -e ${builtPath} ]; then echo "MARKER NOBUILD ${g.key}"; elif grep -q -F -- '${shq(g.contains)}' ${builtPath} 2>/dev/null; then echo "MARKER OK ${g.key}"; else echo "MARKER STALE ${g.key}"; fi`;
    }).join('\n');
    const r = await guest('markers', script, 15_000);
    const verdict = new Map();
    for (const l of String(r.stdout || '').split('\n')) {
      const m = l.match(/^MARKER (OK|MISSING|NOBUILD|STALE) (\S+)$/);
      if (m) verdict.set(m[2], m[1]);
    }
    for (const g of guards) {
      const v = verdict.get(g.key) || 'MISSING';
      if (v === 'OK') continue;
      const reason = v === 'NOBUILD'
        ? `the compiled artifact ${g.built} does not exist yet — the running service executes the build, so ${g.key} is minted by the deploy once the build exists`
        : v === 'STALE'
          ? `the compiled artifact ${g.built} does not carry "${g.contains}" while ${g.path} does — a stale build is not the code that will run; ${g.key} keeps its current value until a deploy rebuilds it`
          : `${g.path} in this project does not carry "${g.contains}" — the installed component predates the code that migrates data encrypted under the previous value, so ${g.key} keeps its current value (a component upgrade brings the code; the key is minted on the deploy after that)`;
      deferred.push({ key: g.key, reason });
    }
    eligible = owned.filter((c) => (verdict.get(c.key) || (guards.some((g) => g.key === c.key) ? 'MISSING' : 'OK')) === 'OK');
  }
  const cur = await guest('env', `cat ${environmentFile} 2>/dev/null || true`, 15_000);
  if (cur.code !== 0) return { ok: false, minted: [], deferred, required: [], error: `could not read ${environmentFile}: ${tail(cur).slice(-200)}` };
  const envText = cur.stdout || '';
  const envKeys = new Set(envFileKeysOf(envText));
  for (const { key, guard } of secretDataGuards(eligible)) {
    if (envKeys.has(key)) continue;
    let probe;
    try {
      const r = await guest('data_probe', authDataProbeScript(guard), 20_000);
      probe = parseAuthDataProbe(r.stdout || '');
    } catch (e) {
      if (e?.code === 'FENCED') throw e;
      probe = { state: 'unknown', rows: [], detail: `probe failed: ${e?.message || e}` };
    }
    const d = decideMasterSecretMint({ probe, envHasKey: false, newlyProvisioned, writersStopped, classification: classifyRows(probe.rows, { legacy: [guard.legacy_default] }) });
    if (d.mint === 'ok') continue;
    deferred.push({ key, reason: d.reason });
    eligible = eligible.filter((c) => c.key !== key);
  }
  const required = componentSecretKeys(eligible);
  if (!eligible.length) return { ok: true, minted: [], deferred, required };
  const plan = planSecretMint(envText, eligible);
  if (!plan.minted.length) return { ok: true, minted: [], deferred, required };
  const w = await guest('env_write', `umask 022\nprintf '%s' '${b64(mergeEnvFile(envText, plan.vars))}' | base64 -d > ${environmentFile}.mock2-tmp && chmod 0644 ${environmentFile}.mock2-tmp && mv -f ${environmentFile}.mock2-tmp ${environmentFile}`, 15_000);
  if (w.code !== 0) return { ok: false, minted: [], deferred, required, error: `could not write ${environmentFile}: ${tail(w).slice(-200)}` };
  for (const key of plan.minted) { try { job.generated({ kind: 'secret', name: key, where: environmentFile }); } catch { /* */ } }
  return { ok: true, minted: plan.minted, deferred, required };
}

function envFileKeysOf(text) {
  const keys = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// ── the best-effort extras, as in deploy.js ─────────────────────────────

async function installE2eBrowser(runInApp, appDir, report) {
  const control = (e) => { if (e?.code === 'FENCED' || e?.code === 'CANCELLED') throw e; };
  const probe = await runInApp('[ -f playwright.config.ts ] || [ -f playwright.config.js ] || exit 1\n[ -n "$(ls -A "$HOME/.cache/ms-playwright" 2>/dev/null)" ] && exit 1\nexit 0', 20_000).catch((e) => { control(e); return { code: 1 }; });
  if (probe.code !== 0) return;
  report('e2e-browser', 'Installing the test browser (one time)…');
  await runInApp(installBrowserScript(appDir), 600_000).catch((e) => { control(e); return null; });
}

async function retrofitPwaBuildPlumbing(guest, appDir) {
  const legacyHash = createHash('sha256').update(LEGACY_SW_JS, 'utf8').digest('hex');
  const { swJs, buildIdJs } = scaffoldPwaFiles();
  const script = `cd '${appDir}' 2>/dev/null || exit 0
[ -d public ] || exit 0
[ -f public/build-id.js ] || printf '%s' '${b64(buildIdJs)}' | base64 -d > public/build-id.js
[ -f public/build-id.txt ] || printf '%s\n' '${BUILD_ID_PLACEHOLDER}' > public/build-id.txt
if [ -f public/sw.js ]; then
  cur=$(sha256sum public/sw.js 2>/dev/null | cut -d' ' -f1)
  if [ "$cur" = '${legacyHash}' ]; then
    printf '%s' '${b64(swJs)}' | base64 -d > public/sw.js
    echo MOCK2_SW_RETROFIT
  fi
fi
echo MOCK2_RETROFIT_DONE`;
  const r = await guest('pwa', script, 20_000);
  return { ok: /MOCK2_RETROFIT_DONE/.test(r.stdout || ''), swReplaced: /MOCK2_SW_RETROFIT/.test(r.stdout || '') };
}

async function stampBuildId(guest, appDir) {
  const id = sanitizeBuildId(newBuildId());
  const r = await guest('stamp', buildIdStampScript(appDir, id), 20_000);
  return { ok: /MOCK2_BUILD_ID:/.test(r.stdout || ''), buildId: id };
}

async function verifyBuildStamp(guest, appDir) {
  try {
    const r = await guest('stamp_report', buildStampReportScript(appDir), 15_000);
    return interpretBuildStamp(r.stdout || '');
  } catch (err) {
    if (err?.code === 'FENCED') throw err;
    return { ok: true, instrumented: false, stale_risk: false, detail: `build-stamp check skipped: ${err?.message || err}` };
  }
}


