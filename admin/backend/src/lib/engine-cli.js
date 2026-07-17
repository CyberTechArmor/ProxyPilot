// Shared Python-engine CLI bridge. Extracted from routes/cves.js so the
// CVE-research module (lib/cve-research.js) can shell out to the SAME
// engine subprocess logic (nsenter host-pivot decision, PYTHONPATH
// resolution, JSON-line parsing) instead of forking a second copy that
// could drift from it.
//
// Engine commands split into two lanes:
//
//   In-container — pure YAML manipulation: validate, mark-seen,
//   dismiss, show, list. These read/write the inbox dir
//   (bind-mounted from the host) but don't shell out to apt-get /
//   systemctl / etc.
//
//   Host-pivot — anything that runs host commands: poll, run-one,
//   inventory, check, and paste (its post-import auto-check runs the
//   detection probe). These need apt-get / dpkg-query, snapshot tools,
//   the running kernel etc., so they pivot through `nsenter -t 1` into
//   the host namespace (Phase A architecture — same pattern as
//   caddy-driver.js). Probes MUST run on the host: the dashboard image
//   is Alpine, where a Debian probe (dpkg-query …) can't find the
//   package and reports a false "not affected" for every entry.
//
// Outside Docker (tests, dev), every command runs directly.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Read lazily (functions, not module-load-time consts) rather than
// snapshotting process.env at import time. Two reasons: production
// deploys never change these after boot so it makes no behavioral
// difference there, but the test suite re-imports routes/cves.js per
// test with different PROXYPILOT_INBOX_DIR / PROXYPILOT_HOSTNAME values
// (see __tests__/cves.test.js's loadRouter) — this module sits behind a
// static import, so ES module caching means it only loads ONCE across
// the whole test file. A frozen const here would silently keep serving
// the first test's inbox dir to every later test.
export function getInboxDir() { return process.env.PROXYPILOT_INBOX_DIR || '/var/lib/proxypilot/cve-inbox'; }
export function getInventoryPath() { return process.env.PROXYPILOT_INVENTORY_PATH || '/var/lib/proxypilot/inventory.json'; }
export function getEngineBin() { return process.env.PROXYPILOT_ENGINE_BIN || 'python3'; }
export function getEngineModule() { return process.env.PROXYPILOT_ENGINE_MODULE || 'proxypilot.engine'; }
export function getHostname() { return process.env.PROXYPILOT_HOSTNAME || ''; }

export const HOST_PIVOT_COMMANDS = new Set(['poll', 'run-one', 'inventory', 'check', 'paste']);
export const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// CVE filenames are constrained to the canonical CVE-YYYY-NNNN[N..] shape
// so a malicious id can't traverse out of the inbox dir.
export const CVE_ID_RE = /^CVE-\d{4}-\d{4,7}$/;

export function safePath(cveId) {
  if (!CVE_ID_RE.test(cveId)) return null;
  return `${getInboxDir()}/${cveId}.yaml`;
}

// Spawn the Python engine and capture its single-line JSON result. All
// write actions go through here so the YAML mutation lives in the engine
// module, not duplicated in Node. Optionally feeds bytes on stdin (used
// for `validate` / `paste`, which read YAML from there).
export function runEngine(args, { timeoutMs = 30 * 60 * 1000, stdinText = null } = {}) {
  // Build the argv. In Docker we wrap with nsenter so the spawn pivots
  // into the host namespace where the engine + python3 are installed.
  // Outside Docker we run the engine directly.
  //
  // The engine CLI's --inbox / --host flags come BEFORE the subcommand,
  // so prepend them here. Tests + alternate deployments override
  // INBOX_DIR / HOSTNAME via env, and we want those values to actually
  // reach the subprocess.
  const hostname = getHostname();
  const engineBin = getEngineBin();
  const engineModule = getEngineModule();
  const globalArgs = ['--inbox', getInboxDir()];
  if (hostname) globalArgs.push('--host', hostname);
  // First positional after globalArgs is the subcommand — that's what
  // we route on for the in-container vs. host-pivot decision.
  const subcommand = args[0] || '';
  const needsHostPivot = isInDocker && HOST_PIVOT_COMMANDS.has(subcommand);
  let bin, fullArgs;
  if (needsHostPivot) {
    bin = 'nsenter';
    // -m mount, -u uts, -n net, -i ipc, -p pid (so signals reach the
    // right pid tree). We don't need -U because the host runs as the
    // same root.
    fullArgs = ['-t', '1', '-m', '-u', '-n', '-i', '-p', '--',
                engineBin, '-m', engineModule, ...globalArgs, ...args];
  } else {
    bin = engineBin;
    fullArgs = ['-m', engineModule, ...globalArgs, ...args];
  }
  // PYTHONPATH for the engine module. Two cases:
  //   - In-container path: the Dockerfile copies proxypilot/ to
  //     /app/proxypilot and sets PYTHONPATH=/app. process.env.PYTHONPATH
  //     already carries that, so we keep it untouched.
  //   - Host pivot: the host has the package at PROXYPILOT_INSTALL_DIR
  //     (default /opt/proxypilot) — install.sh copies it there. Prepend
  //     that so the host's python3 finds the module.
  const installDir = process.env.PROXYPILOT_INSTALL_DIR || '/opt/proxypilot';
  const pythonPath = needsHostPivot
    ? installDir + (process.env.PYTHONPATH ? ':' + process.env.PYTHONPATH : '')
    : (process.env.PYTHONPATH || '/app');
  const childEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: pythonPath,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(bin, fullArgs, { env: childEnv });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`engine timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        if (needsHostPivot) {
          err = new Error(
            'engine spawn failed: nsenter not found in container. ' +
            'Rebuild the dashboard image (apk add util-linux) or set ' +
            'pid:host in docker-compose.');
        } else {
          err = new Error(
            `engine spawn failed: ${engineBin} not found. ` +
            'In-container engine should be installed via the admin Dockerfile ' +
            '(python3 + py3-ruamel.yaml). Rebuild the image.');
        }
      }
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      // The engine writes one JSON line per command. Even on non-zero
      // exit it's expected to emit a parseable {"ok":false,"error":...}.
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(lastLine);
        if (code !== 0 && parsed.ok !== false) parsed.exit_code = code;
        resolve(parsed);
      } catch {
        // Common case: `No module named proxypilot` — the host has
        // python3 but the engine package isn't on PYTHONPATH. Surface
        // a remediation hint instead of a raw stderr dump.
        const errText = stderr.trim();
        if (/No module named ['\"]?proxypilot/.test(errText)) {
          reject(new Error(
            `engine package not found on host PYTHONPATH (${installDir}). ` +
            `Run install.sh / update.sh, or set PROXYPILOT_INSTALL_DIR to ` +
            `the directory containing the proxypilot/ package.`));
          return;
        }
        if (/No module named ['\"]?ruamel/.test(errText)) {
          reject(new Error(
            'ruamel.yaml not installed on the host. ' +
            'Install with: apt install python3-ruamel.yaml  (Debian/Ubuntu) ' +
            'or: pip3 install ruamel.yaml'));
          return;
        }
        reject(new Error(`engine exited ${code}; stderr: ${errText.slice(0, 500)}`));
      }
    });
    if (stdinText !== null) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}
