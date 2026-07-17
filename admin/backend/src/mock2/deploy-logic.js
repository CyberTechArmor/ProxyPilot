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
export function freeWebPortScript(webPort = 3000) {
  const p = Number(webPort) || 3000;
  return [
    `systemctl stop mock2-dev.service 2>/dev/null || true`,
    // The provision fallback can leave a nohup'd serve.py OUTSIDE the unit's
    // cgroup — `systemctl stop` never reaps it and it holds the port forever.
    `pkill -f '[s]erve\\.py' 2>/dev/null || true`,
    // Reap any remaining holder with EVERY tool available (not first-match —
    // fuser can be absent while lsof isn't, and vice versa).
    `if command -v fuser >/dev/null 2>&1; then fuser -k ${p}/tcp 2>/dev/null || true; fi`,
    `if command -v lsof >/dev/null 2>&1; then kill $(lsof -t -i:${p} 2>/dev/null) 2>/dev/null || true; fi`,
    `if command -v ss >/dev/null 2>&1; then`,
    `  pid=$(ss -ltnpH "sport = :${p}" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2);`,
    `  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true;`,
    `fi`,
    // Wait (bounded) until the kernel actually releases the socket — a TERM'd
    // holder can linger past a fixed 1s pause and the fresh instance then
    // crash-loops on EADDRINUSE. Escalate to SIGKILL halfway through.
    `i=0; while [ $i -lt 6 ]; do`,
    `  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${p} "; then`,
    `    if [ $i -eq 3 ]; then fuser -k -KILL ${p}/tcp 2>/dev/null || true; pkill -9 -f '[s]erve\\.py' 2>/dev/null || true; fi`,
    `    i=$((i+1)); sleep 1;`,
    `  else break; fi`,
    `done`,
    `systemctl reset-failed mock2-dev.service 2>/dev/null || true`,
    `sleep 1`,
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
  health: 45000,
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
  return `${base}${egressHint}${d ? `: ${d.slice(-600)}` : '.'}`;
}
