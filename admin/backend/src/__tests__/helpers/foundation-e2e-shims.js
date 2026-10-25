// Guest shims for foundation-e2e.docker.test.js: this sandbox stands in for a
// foundation guest, so the REAL host code (mock2/host.js runHost('incus', …),
// foundation-stack.js, foundation-service.js) runs unchanged and these two
// tiny executables, first on PATH, play the guest's side:
//
//   incus exec <guest> [--cwd D] [--env K=V]… -- <cmd…>
//       runs <cmd…> here with stdin/stdout/stderr passed through and the exit
//       code returned. The environment is a clean one, like `incus exec`'s
//       (PATH, HOME, USER, LANG), plus the guest's additions (I2_GUEST_ENV, a
//       KEY=VALUE file standing in for what the guest's /etc/environment would
//       add: the test layout's DATABASE_URL and FOUNDATION_KEY_FILE). The guest
//       app directory /srv/app (foundation-service.js APP_DIR) maps to the
//       test's app dir. Only `exec` is implemented; anything else fails loudly.
//   systemd-run [--quiet] [--collect] --unit=U [--working-directory=D]
//               [--setenv=K=V]… [-p Prop=V]… <cmd…>
//       starts <cmd…> DETACHED (its own session, stdio to a log file) in D,
//       with --setenv applied and then EnvironmentFile= read (a later setting
//       wins, as in systemd; /etc/environment gets the I2_GUEST_ENV additions).
//       A unit name still running is refused ("already exists").
//
// Every invocation's argv is appended to I2_SHIM_LOG (JSON lines), so the test
// can prove no secret ever crossed on a command line. Test-only; never shipped.

import fs from 'node:fs';
import path from 'node:path';

const INCUS = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const argv = process.argv.slice(2);
const E = process.env;
if (E.I2_SHIM_LOG) fs.appendFileSync(E.I2_SHIM_LOG, JSON.stringify({ shim: 'incus', argv }) + '\n');
const fail = (code, msg) => { process.stderr.write(msg + '\n'); process.exit(code); };
const [sub, name, ...rest] = argv;
if (sub !== 'exec') fail(64, 'i2 incus shim: only "incus exec" is implemented (got: ' + argv.join(' ') + ')');
if (name !== E.I2_GUEST) fail(1, 'Error: Failed to get instance "' + name + '": not found');
const mapPath = (p) => (p === '/srv/app' ? E.I2_APP_DIR : (p.startsWith('/srv/app/') ? E.I2_APP_DIR + p.slice(8) : p));
let cwd = '/root';
const extra = {};
let i = 0;
for (; i < rest.length; i += 1) {
  const a = rest[i];
  if (a === '--') { i += 1; break; }
  const val = (flag) => (a === flag ? rest[++i] : a.slice(flag.length + 1));
  if (a === '--cwd' || a.startsWith('--cwd=')) cwd = val('--cwd');
  else if (a === '--env' || a.startsWith('--env=')) { const kv = val('--env'); const at = kv.indexOf('='); extra[kv.slice(0, at)] = kv.slice(at + 1); }
  else if (a === '-T' || a === '--force-noninteractive') { /* no tty either way */ }
  else fail(64, 'i2 incus shim: unsupported incus exec flag ' + a);
}
const cmd = rest.slice(i).map(mapPath);
if (!cmd.length) fail(64, 'i2 incus shim: no command');
const guestEnv = {};
if (E.I2_GUEST_ENV) {
  for (const line of fs.readFileSync(E.I2_GUEST_ENV, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) guestEnv[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
const control = Object.fromEntries(Object.entries(E).filter(([k]) => k.startsWith('I2_')));
const env = {
  PATH: E.I2_BIN + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/root', USER: 'root', LANG: 'C.UTF-8', ...control, ...guestEnv, ...extra,
};
const child = spawn(cmd[0], cmd.slice(1), { cwd: mapPath(cwd), env, stdio: 'inherit' });
child.on('error', (e) => fail(127, 'i2 incus shim: ' + e.message));
child.on('exit', (code, signal) => process.exit(code == null ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code));
`;

const SYSTEMD_RUN = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const E = process.env;
if (E.I2_SHIM_LOG) fs.appendFileSync(E.I2_SHIM_LOG, JSON.stringify({ shim: 'systemd-run', argv }) + '\n');
const fail = (code, msg) => { process.stderr.write(msg + '\n'); process.exit(code); };
let unit = null; let wd = '/'; let quiet = false;
const setenv = []; const envFiles = [];
let i = 0;
for (; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('-')) break;
  if (a === '--') { i += 1; break; }
  const val = (flag) => (a === flag ? argv[++i] : a.slice(flag.length + 1));
  if (a === '--quiet' || a === '-q') quiet = true;
  else if (a === '--collect' || a === '-G' || a === '--no-block') { /* transient, collected */ }
  else if (a === '--unit' || a.startsWith('--unit=')) unit = val('--unit');
  else if (a === '--working-directory' || a.startsWith('--working-directory=')) wd = val('--working-directory');
  else if (a === '--setenv' || a.startsWith('--setenv=')) setenv.push(val('--setenv'));
  else if (a === '-p' || a === '--property' || a.startsWith('--property=')) {
    const prop = a === '-p' ? argv[++i] : val('--property');
    if (prop.startsWith('EnvironmentFile=')) envFiles.push(prop.slice('EnvironmentFile='.length));
  } else fail(64, 'i2 systemd-run shim: unsupported option ' + a);
}
const cmd = argv.slice(i);
if (!unit || !cmd.length) fail(64, 'i2 systemd-run shim: needs --unit and a command');
const units = path.join(E.I2_STATE_DIR, 'units');
fs.mkdirSync(units, { recursive: true });
const pidFile = path.join(units, unit + '.pid');
try {
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  process.kill(pid, 0);
  fail(1, 'Failed to start transient service unit: Unit ' + unit + '.service already exists.');
} catch (e) { if (e && e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }
const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' };
const apply = (kv) => { const at = kv.indexOf('='); if (at > 0) env[kv.slice(0, at)] = kv.slice(at + 1).replace(/^"(.*)"$/, '$1'); };
for (const kv of setenv) apply(kv);
for (const raw of envFiles) {
  const optional = raw.startsWith('-');
  const file = optional ? raw.slice(1) : raw;
  const files = [file, ...(file === '/etc/environment' && E.I2_GUEST_ENV ? [E.I2_GUEST_ENV] : [])];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (optional || f !== file) continue; fail(1, 'Failed to load environment file ' + f); }
    for (const line of text.split('\n')) if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) apply(line);
  }
}
const out = fs.openSync(path.join(units, unit + '.log'), 'a');
const child = spawn(cmd[0], cmd.slice(1), { cwd: wd, env, detached: true, stdio: ['ignore', out, out] });
child.on('error', (e) => fail(1, 'i2 systemd-run shim: ' + e.message));
fs.writeFileSync(pidFile, String(child.pid));
fs.appendFileSync(path.join(units, 'all.pids'), child.pid + '\n');
child.unref();
if (!quiet) process.stderr.write('Running as unit: ' + unit + '.service\n');
process.exit(0);
`;

// installGuestShims(binDir) → writes `incus` and `systemd-run` (0755), run by
// this node binary (absolute shebang: the shims never depend on PATH for node).
export function installGuestShims(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  for (const [name, body] of [['incus', INCUS], ['systemd-run', SYSTEMD_RUN]]) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!${process.execPath}\n// i2 foundation e2e guest shim (test-only, CommonJS)${body}`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  return { incus: path.join(binDir, 'incus'), systemdRun: path.join(binDir, 'systemd-run') };
}

// The detached job processes the systemd-run shim started (for teardown).
export function startedUnitPids(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, 'units', 'all.pids'), 'utf8').split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
}

// The unit logs (diagnostics when a job does not finish).
export function unitLogs(stateDir) {
  const dir = path.join(stateDir, 'units');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.log')); } catch { return ''; }
  return names.map((n) => `--- ${n}\n${fs.readFileSync(path.join(dir, n), 'utf8').slice(-3000)}`).join('\n');
}
