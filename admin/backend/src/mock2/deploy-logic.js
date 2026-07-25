// Mock2 deploy PURE decision layer (Run phase). Native-free, unit-tested
// stub-first (risk R9). Everything about "install → migrate → build → swap the
// systemd unit → restart" that can be decided WITHOUT Incus/exec lives here:
// parsing the manifest run contract (declared, not discovered — ADR-005),
// building the systemd-unit string, the ordered step plan, and the derived
// deploy status token the UI keys off.
//
// deploy.js (the host/exec half) and provision.js/runner.js import these; the
// tests import ONLY this module.
//
// Terminology (risk R7): the AI build component is the runner; nothing here is
// named "agent".

// The default run contract the scaffold declares in mock2.yaml. `install` is
// `npm ci || npm install` because the seed ships no lockfile (npm ci needs one),
// so the first install falls through to `npm install`; later cycles with a
// committed lockfile use the faster, reproducible `npm ci`.
export const DEFAULT_RUN_CONTRACT = Object.freeze({
  runtime: 'node-express',
  install: 'npm ci || npm install',
  migrate: 'npm run migrate',
  build: 'npm run build',
  start: 'npm run start',
});

// parseRunContract(yamlText) → the declared run contract from a mock2.yaml.
// A narrow line parser (like parseManifestWebPort): the manifest shape is fixed
// by the template, and the values are executed in the container, so a strict,
// dependency-free parse is a feature. Reads the keys under a top-level `run:`
// block. Returns { hasContract, runtime?, install?, migrate?, build?, start? };
// hasContract is true only when a `start` command is declared (the minimum to
// run the app). A manifest with no run block (the old placeholder projects)
// yields { hasContract: false } — the deploy step is skipped for those.
export function parseRunContract(yamlText) {
  const lines = String(yamlText || '').split(/\r?\n/);
  const raw = {};
  let inRun = false;
  for (const line of lines) {
    if (/^run:\s*(#.*)?$/.test(line)) { inRun = true; continue; }
    if (!inRun) continue;
    // A non-indented, non-blank line ends the run block.
    if (/^\S/.test(line)) break;
    const m = line.match(/^\s+([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) raw[m[1]] = value;
  }
  const contract = {};
  for (const key of ['runtime', 'install', 'migrate', 'build', 'start']) {
    if (raw[key]) contract[key] = raw[key];
  }
  return { hasContract: !!contract.start, ...contract };
}

// shell-single-quote a string for safe embedding inside a '...' shell literal.
function shSingleQuote(s) {
  return String(s).replace(/'/g, "'\\''");
}

// execStartForStartCommand(startCommand, { appDir }) → the systemd ExecStart line
// value for a manifest `start` command. Wrapped in `/bin/sh -lc '…'` so a shell
// command like `npm run start` (not an absolute path) is valid as ExecStart, the
// login shell loads the container env, and the working dir is the app dir.
// Single quotes in the command are escaped so a runner-edited start command can
// never break the unit.
export function execStartForStartCommand(startCommand, { appDir = '/srv/app' } = {}) {
  const cmd = String(startCommand || '').trim();
  const inner = `cd ${appDir} && exec ${cmd}`;
  return `/bin/sh -lc '${shSingleQuote(inner)}'`;
}

// The placeholder pre-build ExecStart (serve.py). Kept here so template.js and
// the deploy step build the systemd unit through ONE function (below), and the
// serve.py unit stays byte-for-byte what M2 shipped.
export function execStartForServePy(appDir = '/srv/app') {
  return `/usr/bin/python3 ${appDir}/serve.py`;
}

// buildDevServiceUnit({ appDir, webPort, execStart }) → the mock2-dev.service
// systemd unit text. The ONLY thing that varies between the pre-build placeholder
// (serve.py) and a deployed app is ExecStart, so both go through here — the
// deploy step rewrites the unit by calling this with the app's start command.
// WantedBy=multi-user.target means a container restart (idle-stop/wake) brings
// whatever was last written back up automatically.
export function buildDevServiceUnit({ appDir = '/srv/app', webPort = 3000, execStart } = {}) {
  return `[Unit]
Description=Mock2 project dev server
After=network.target

[Service]
Type=simple
WorkingDirectory=${appDir}
Environment=PORT=${webPort}
# A dev-plane app should log an unhandled promise rejection and keep serving, not
# hard-exit and crash-loop (Node's default since v15 is to exit the process). One
# unhandled async error in a route would otherwise take the whole app down and
# fail the deploy health check. This makes the app resilient without touching its
# code (applies to any Node ExecStart; ignored by non-Node ExecStart like serve.py).
Environment=NODE_OPTIONS=--unhandled-rejections=warn
# Inherit any operator-set container env. The leading '-' makes it optional.
EnvironmentFile=-/etc/environment
ExecStart=${execStart}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

// freeWebPortScript(webPort) → a shell snippet that frees the app's web port
// BEFORE the deploy (re)starts the unit. Without it, a fresh `systemctl restart`
// can race a listener a PRIOR deploy left holding the port — a detached child /
// orphan that escaped the unit's control group, which `restart` cannot reap — so
// the new instance crash-loops on EADDRINUSE (Restart=on-failure, every 2s) until
// the old holder finally dies, often long after the health window has closed and
// the deploy has been marked failed. This stops the unit (killing its cgroup),
// then best-effort kills anything STILL bound to the port (psmisc `fuser`, else
// `lsof`, else an `ss`-parsed PID), clears any tripped restart-rate limiter, and
// pauses briefly so the kernel releases the socket. All steps are `|| true`: a
// clean deploy has nothing extra to kill and passes straight through.
// Shared POSIX-sh helpers, tool-INDEPENDENT: minimal container images ship
// without iproute2/psmisc/lsof, and every `command -v`-guarded reaper then
// silently no-ops while the wait-loop breaks instantly — the port stays held,
// the app crash-loops on EADDRINUSE, and the diagnostics report "(nothing
// bound)" over a held port. /proc/net/tcp{,6} (hex port, state 0A = LISTEN)
// plus a /proc/*/fd socket-inode scan work everywhere.
function portShellHelpers(p) {
  const hex = Number(p).toString(16).toUpperCase().padStart(4, '0');
  return [
    // ANY socket with this local port in a state other than TIME_WAIT (06)
    // blocks bind() even with SO_REUSEADDR — a killed server's keep-alive
    // connections linger as ownerless FIN_WAIT sockets for ~60s and produce
    // the paradox "EADDRINUSE but no listener". LISTEN-only checks look
    // straight past them, so everything here considers all blocking states.
    `mock2_port_inodes() { awk '$4 != "06" && $2 ~ /:${hex}$/ {print $10}' /proc/net/tcp /proc/net/tcp6 2>/dev/null; }`,
    `mock2_port_busy() {`,
    `  if command -v ss >/dev/null 2>&1; then [ -n "$(ss -tanH "sport = :${p}" 2>/dev/null | grep -v TIME-WAIT)" ]; return $?; fi`,
    `  [ -n "$(mock2_port_inodes)" ]`,
    `}`,
    `mock2_port_pids() {`,
    `  for ino in $(mock2_port_inodes); do`,
    `    for fd in /proc/[0-9]*/fd/*; do`,
    `      [ "$(readlink "$fd" 2>/dev/null)" = "socket:[$ino]" ] && echo "$fd" | cut -d/ -f3`,
    `    done`,
    `  done | sort -u`,
    `}`,
    // Force-close ownerless sockets (FIN_WAIT etc. have no pid to kill).
    // ss -K needs iproute2 + CONFIG_INET_DIAG_DESTROY; best-effort like the rest.
    `mock2_port_kill_sockets() { command -v ss >/dev/null 2>&1 && ss -K "sport = :${p}" >/dev/null 2>&1 || true; }`,
  ].join('\n');
}

export function freeWebPortScript(webPort = 3000) {
  const p = Number(webPort) || 3000;
  return [
    portShellHelpers(p),
    `systemctl stop mock2-dev.service 2>/dev/null || true`,
    // The provision fallback can leave a nohup'd serve.py OUTSIDE the unit's
    // cgroup — `systemctl stop` never reaps it and it holds the port forever.
    `pkill -f '[s]erve\\.py' 2>/dev/null || true`,
    // Reap any remaining holder with EVERY tool available, then the /proc
    // fallback that needs no tools at all.
    `if command -v fuser >/dev/null 2>&1; then fuser -k ${p}/tcp 2>/dev/null || true; fi`,
    `if command -v lsof >/dev/null 2>&1; then kill $(lsof -t -i:${p} 2>/dev/null) 2>/dev/null || true; fi`,
    `if command -v ss >/dev/null 2>&1; then`,
    `  pid=$(ss -ltnpH "sport = :${p}" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2);`,
    `  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true;`,
    `fi`,
    `for hp in $(mock2_port_pids); do kill "$hp" 2>/dev/null || true; done`,
    `mock2_port_kill_sockets`,
    // Wait (bounded, ~20s) until the kernel actually releases EVERY blocking
    // socket — the dead server's FIN_WAIT connections expire on their own
    // (~60s worst case) but ss -K reaps them instantly where supported.
    // Escalate to SIGKILL early; keep force-closing sockets each pass.
    `i=0; while [ $i -lt 20 ]; do`,
    `  if mock2_port_busy; then`,
    `    if [ $i -eq 3 ]; then`,
    `      fuser -k -KILL ${p}/tcp 2>/dev/null || true`,
    `      pkill -9 -f '[s]erve\\.py' 2>/dev/null || true`,
    `      for hp in $(mock2_port_pids); do kill -9 "$hp" 2>/dev/null || true; done`,
    `    fi`,
    `    mock2_port_kill_sockets`,
    `    i=$((i+1)); sleep 1;`,
    `  else break; fi`,
    `done`,
    `systemctl reset-failed mock2-dev.service 2>/dev/null || true`,
    `sleep 1`,
  ].join('\n');
}

// portHoldersReportScript(port) → prints WHO listens on the port, for the
// health-failure diagnostics. ss when present; /proc fallback (with pid +
// command name) otherwise — never a false "(nothing bound)".
export function portHoldersReportScript(webPort = 3000) {
  const p = Number(webPort) || 3000;
  return [
    portShellHelpers(p),
    `if command -v ss >/dev/null 2>&1; then`,
    // ALL states, not just LISTEN: a dead server's FIN_WAIT sockets block
    // bind() while no listener exists — they must show up here by state.
    `  ss -tanp "sport = :${p}" 2>/dev/null | grep -v '^State' || echo "(no socket on :${p} in any state)"`,
    `else`,
    `  pids=$(mock2_port_pids)`,
    `  if [ -n "$(mock2_port_inodes)" ] && [ -z "$pids" ]; then`,
    `    echo "OWNERLESS socket(s) on :${p} (dead process's FIN_WAIT connections — they block bind for ~60s, no pid to kill)"`,
    `  elif [ -z "$pids" ]; then`,
    `    echo "(no socket on :${p} — via /proc; ss not installed)"`,
    `  else`,
    `    for hp in $pids; do echo "pid $hp ($(cat /proc/$hp/comm 2>/dev/null)): $(tr '\\0' ' ' < /proc/$hp/cmdline 2>/dev/null | cut -c1-140)"; done`,
    `  fi`,
    `fi`,
  ].join('\n');
}

// The ordered deploy steps and their bounded timeouts (R5 — an install/build
// spends wall-clock; every step is time-bounded). `migrate` and `build` are
// skipped when the contract omits them; `install` and `start` are the minimum.
export const DEPLOY_STEP_TIMEOUTS_MS = Object.freeze({
  install: 600000, // npm install can be minutes
  migrate: 180000,
  build: 300000,
  start: 60000,
  // Covers the 45-poll serving loop in deploy.js (a refused connection fails
  // instantly, so each poll costs ~2s sleep; a dead server's lingering
  // FIN_WAIT sockets can block the new bind for ~60s and the window must
  // OUTLAST that) plus
  // the journal dump — a first boot that spends a while in a restart loop
  // (e.g. waiting out a lingering port holder) still gets counted as serving
  // once it recovers, instead of being marked failed while actually fine.
  health: 240000,
});

// deployPlan(contract) → the ordered [{ key, command, timeoutMs }] the deploy
// step runs, skipping steps the contract does not declare. `start` is handled
// separately (it rewrites the unit, it is not a plain command), so it is not in
// this list.
export function deployPlan(contract = {}) {
  const steps = [];
  for (const key of ['install', 'migrate', 'build']) {
    if (contract[key]) steps.push({ key, command: contract[key], timeoutMs: DEPLOY_STEP_TIMEOUTS_MS[key] });
  }
  return steps;
}

export function deployStepLabel(key) {
  return {
    install: 'Installing dependencies…',
    migrate: 'Running database migrations…',
    build: 'Building the application…',
    start: 'Starting the application…',
    health: 'Verifying the app is serving…',
  }[key] || 'Deploying…';
}

// deployProjectStatus(deployStatus) → the derived project-status token for a
// cycle's stored deploy_status (used by deriveProjectStatus). One place so the
// tile and the detail page agree. Returns null for "no deploy signal" (the
// project keeps its container-liveness status).
export function deployProjectStatus(deployStatus) {
  if (deployStatus === 'deploying') return 'deploying';
  if (deployStatus === 'deploy_failed') return 'deploy_failed';
  if (deployStatus === 'serving') return 'serving';
  return null;
}

// deployFailureMessage(step, detail) → the actionable, plain-language error a
// deploy failure surfaces (never a silent "succeeded"). Egress failures point the
// operator host-side (the bridge NAT / host internet) so they know the fix is not
// in the code.
export function deployFailureMessage(step, detail = '') {
  const d = String(detail || '').trim();
  const looksLikeEgress = /ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|proxy|registry\.npmjs|network|could not resolve|unable to connect|403 Forbidden|407/i.test(d);
  const base = {
    install: 'Dependency install failed',
    migrate: 'Database migration failed',
    build: 'Build failed',
    start: 'The app did not start',
    health: 'The app is not serving on its web port — it most likely started, then crashed (see the app output below; a repeating restart / exit-code means a crash loop, usually an unhandled error thrown after it began listening)',
  }[step] || 'Deploy failed';
  const egressHint = looksLikeEgress && (step === 'install')
    ? ' — the container could not reach the npm registry. Egress is the bridge\'s Incus NAT: confirm the host has working internet and the m2br* bridge has ipv4.nat=true (the firewall logs egress but never blocks the internet path).'
    : '';
  // Keep BOTH ends of a long detail. A plain tail-slice here silently destroyed
  // the health check's diagnostic HEAD (MOCK2_NOT_SERVING, service state, the
  // port-holders line naming the EADDRINUSE culprit) that deploy.js carefully
  // put first — the operator only ever saw journal fragments.
  const trimmed = d.length > 1600 ? `${d.slice(0, 900)}\n… (trimmed) …\n${d.slice(-600)}` : d;
  return `${base}${egressHint}${d ? `: ${trimmed}` : '.'}`;
}

// ---- build identity (PWA cache correctness) ----
//
// A deploy stamps a unique BUILD ID into public/sw.js, public/build-id.js and
// public/build-id.txt. This is what makes a deploy actually reach the browser:
// a service worker only updates when sw.js's BYTES change, and it only drops
// stale assets when the cache NAME changes. A hardcoded cache name did neither,
// so a client could keep running pre-deploy JS while the server served the new
// build. Pure so both halves are unit-testable without a container.

export const BUILD_ID_PLACEHOLDER = '__MOCK2_BUILD_ID__';
// A stamped id: 14-digit UTC timestamp + a short base36 suffix.
export const BUILD_ID_RE = /^[0-9]{14}-[a-z0-9]{1,4}$/;

// newBuildId — unique per deploy, sortable, and safe inside a JS string literal
// and a CacheStorage key (digits, dash, lowercase base36 only).
export function newBuildId(now = new Date(), rand = Math.random()) {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); // YYYYMMDDhhmmss
  const suffix = Math.floor(Math.abs(rand) * 1e6).toString(36).slice(0, 4) || '0';
  return `${ts}-${suffix}`;
}

// sanitizeBuildId — never let anything but [A-Za-z0-9-] reach a sed expression
// or a cache name.
export function sanitizeBuildId(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'unknown';
}

// buildIdStampScript — the in-container script that re-stamps the id. The sed
// alternation matches the ORIGINAL placeholder *or* an already-stamped id, so a
// re-deploy re-stamps correctly instead of only working the first time. Every
// file is optional: a project from an older scaffold is left untouched rather
// than failing the deploy.
// buildStampReportScript — read back what the deploy actually stamped, so the
// post-deploy check can prove the client-facing plumbing is correct instead of
// assuming it. Emits three KEY=value lines (missing files report `-`).
export function buildStampReportScript(appDir) {
  return `cd '${appDir}' 2>/dev/null || exit 0
printf 'TXT=%s\\n' "$(cat public/build-id.txt 2>/dev/null | tr -d '\\n' || echo -)"
printf 'JS=%s\\n' "$(sed -n \"s/.*__APP_BUILD_ID *= *'\\\\([^']*\\\\)'.*/\\\\1/p\" public/build-id.js 2>/dev/null | head -1 || echo -)"
printf 'SW=%s\\n' "$(sed -n \"s/.*BUILD_ID *= *'\\\\([^']*\\\\)'.*/\\\\1/p\" public/sw.js 2>/dev/null | head -1 || echo -)"`;
}

// interpretBuildStamp — turn that report into a verdict. PURE.
//   ok:            all three agree on a real (stamped) id → a deploy reaches clients
//   instrumented:  the project HAS the build-id plumbing at all
//   stale_risk:    the plumbing is present but not consistently stamped, which is
//                  the precondition for "my fix never reached the browser"
export function interpretBuildStamp(stdout = '') {
  const get = (k) => {
    const m = String(stdout).match(new RegExp(`^${k}=(.*)$`, 'm'));
    const v = m ? m[1].trim() : '';
    return v && v !== '-' ? v : null;
  };
  const txt = get('TXT'); const js = get('JS'); const sw = get('SW');
  const instrumented = !!(txt || js || sw);
  if (!instrumented) {
    return { ok: true, instrumented: false, stale_risk: false, txt, js, sw, detail: 'no build-id plumbing (pre-instrumentation project) — PWA cache staleness cannot be detected here' };
  }
  const unstamped = [txt, js, sw].filter((v) => v === BUILD_ID_PLACEHOLDER);
  if (unstamped.length) {
    return { ok: false, instrumented: true, stale_risk: true, txt, js, sw, detail: 'build id was never stamped (placeholder still present) — the service worker will not update and clients can serve pre-deploy assets' };
  }
  if (!(txt && js && sw)) {
    return { ok: false, instrumented: true, stale_risk: true, txt, js, sw, detail: `build-id plumbing incomplete (txt=${txt || '-'} js=${js || '-'} sw=${sw || '-'})` };
  }
  if (!(txt === js && js === sw)) {
    return { ok: false, instrumented: true, stale_risk: true, txt, js, sw, detail: `build ids disagree (txt=${txt} js=${js} sw=${sw}) — clients may run a different build than the server serves` };
  }
  return { ok: true, instrumented: true, stale_risk: false, txt, js, sw, detail: `build ${txt} stamped consistently (sw + client + server)` };
}

export function buildIdStampScript(appDir, buildId) {
  const id = sanitizeBuildId(buildId);
  const sub = `s/${BUILD_ID_PLACEHOLDER}\\|[0-9]\\{14\\}-[a-z0-9]\\{1,4\\}/${id}/g`;
  return `cd '${appDir}' 2>/dev/null || exit 0
[ -f public/sw.js ] && sed -i '${sub}' public/sw.js || true
[ -f public/build-id.js ] && sed -i '${sub}' public/build-id.js || true
[ -d public ] && printf '%s\\n' '${id}' > public/build-id.txt || true
echo "MOCK2_BUILD_ID:${id}"`;
}

// The pre-instrumentation service worker, verbatim. A project whose public/sw.js
// still hashes to this is running the KNOWN-BROKEN version (hardcoded cache name
// => the worker never updates and stale assets are never purged), so it is safe
// to replace during the retrofit. Anything else — a worker a build customized —
// is left untouched and reported instead, matching the auth wiring's
// keep-existing rule.
export const LEGACY_SW_JS = `// Conservative PWA service worker: network-first, cache fallback.
// Caches ONLY same-origin navigations, styles, scripts, and images — never
// /api responses, so live data is always live. Bump CACHE to invalidate.
const CACHE = 'app-shell-v1';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  const cacheable = req.mode === 'navigate' ||
    ['style', 'script', 'image', 'manifest'].includes(req.destination);
  if (!cacheable) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || Response.error()))
  );
});
`;
