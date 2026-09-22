// Real update.sh functions and the real Docker maintenance stanza, run in a
// temporary installation. Only service management / Docker / readiness are
// simulated; the runner and backend hold real SQLite connections in this
// process while bash performs the actual backup, relocation and restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = readFileSync(join(REPO, 'update.sh'), 'utf8');
const UNIT = 'proxypilot-setup-runner.service';
const skip = process.getuid?.() !== 0 ? 'update functions require root' : false;
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const lift = (name) => {
  const match = SOURCE.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^}`, 'm'));
  assert.ok(match, `real function ${name}`);
  return match[0];
};
const maintenance = SOURCE.slice(SOURCE.indexOf('        # Do not enter maintenance'), SOURCE.indexOf('        $DC_CMD up -d') + '        $DC_CMD up -d'.length);
assert.ok(maintenance.includes('migrate_db_layout'));
const nativeStartup = SOURCE.slice(SOURCE.indexOf('    # Check if PM2 is available', SOURCE.indexOf('    # Non-Docker deployment:')), SOURCE.indexOf('    # Second gate:'));
assert.ok(nativeStartup.includes('pm2 start src/index.js'));
const traps = SOURCE.match(/^trap 'on_error' EXIT\ntrap 'exit 130' INT\ntrap 'exit 143' TERM/m)?.[0];
assert.ok(traps, 'the production exit/signal handlers');

function harness(t, { legacy = false, refuseStop = false, falseStop = false, queryFail = false, absent = false, failBuild = false, failDown = false, restartFail = false, staleSidecars = false, failEnvWrite = false, nativeStop = 'stopped', nativeMode = 'pm2' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pp-maintenance-'));
  const install = join(root, 'opt/proxypilot');
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  const env = join(install, '.env');
  const original = join(install, legacy ? 'data/proxypilot.db' : 'data/db/proxypilot.db');
  const current = join(install, 'data/db/proxypilot.db');
  const trace = [];
  let runner = null, backend = null;
  for (const p of [join(install, 'data/db'), bin, state, join(root, 'etc/systemd/system'), join(root, 'src/deploy')]) mkdirSync(p, { recursive: true });
  const originalEnv = `DATABASE_PATH=/data/${legacy ? '' : 'db/'}proxypilot.db\nJWT_SECRET=existing-jwt\nTOTP_ENCRYPTION_KEY=existing-key\nSETUP_EXECUTOR_POLICY=backend-allowed\nCUSTOM_SETTING=keep-me\n`;
  writeFileSync(env, originalEnv);
  writeFileSync(join(install, 'docker-compose.yml'), 'services: {proxypilot: {}}\n');
  copyFileSync(join(REPO, 'deploy', UNIT), join(root, 'src/deploy', UNIT));
  const db = new DatabaseSync(original);
  db.exec("CREATE TABLE users (name TEXT); INSERT INTO users VALUES ('existing-user'); CREATE TABLE changes (value TEXT); INSERT INTO changes VALUES ('backup-state');");
  db.close();
  const envDb = () => join(install, readFileSync(env, 'utf8').match(/^DATABASE_PATH=(.*)$/m)[1].replace(/^\//, ''));
  const open = (path) => {
    const d = new DatabaseSync(path);
    d.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    return d;
  };
  function closeRunner() {
    if (runner) {
      const sidecars = staleSidecars ? ['-wal', '-shm'].map((s) => [s, existsSync(runner.location() + s) ? readFileSync(runner.location() + s) : null]) : [];
      const path = runner.location();
      runner.close(); runner = null;
      // Simulate sidecars left by a crashed writer after the connection is
      // gone; the restore must remove these even when the backup had no WAL.
      for (const [suffix, bytes] of sidecars) if (bytes) writeFileSync(path + suffix, bytes);
      trace.push('runner closed');
    }
    rmSync(join(state, 'active'), { force: true });
  }
  function closeBackend() {
    if (backend) { backend.close(); backend = null; trace.push('backend closed'); }
    rmSync(join(state, 'backend-active'), { force: true });
  }
  function openRunner(path = envDb()) {
    assert.equal(runner, null);
    runner = open(path);
    writeFileSync(join(state, 'active'), '1');
    trace.push(`runner opened ${path}`);
  }
  // A request/ack bridge lets the bash stubs stop/start the real connections.
  // Every filesystem mutation remains the actual command from update.sh.
  const timer = setInterval(() => {
    const request = join(state, 'request');
    if (!existsSync(request)) return;
    const action = readFileSync(request, 'utf8').trim();
    if (!action) return;
    rmSync(request);
    let rc = 0;
    try {
      trace.push(action);
      if (action === 'stop') closeRunner();
      if (action === 'restart') {
        // All declared namespace paths must exist BEFORE service startup.
        for (const p of ['opt/proxypilot/data', 'var/lib/proxypilot', 'root/.proxypilot', 'etc/sysctl.d']) assert.ok(existsSync(join(root, p)), p);
        closeRunner(); openRunner();
      }
      if (action === 'down') { assert.equal(runner, null, 'runner must stop before Docker down'); closeBackend(); }
      if (action === 'up') { closeBackend(); backend = open(envDb()); }
      if (action === 'native-start') {
        backend = open(envDb());
        backend.exec("INSERT INTO changes VALUES ('failed-native-start');");
        writeFileSync(join(state, 'backend-active'), '1');
      }
      if (action === 'native-stop') closeBackend();
      if (action === 'status') {
        assert.ok(runner, 'a real runner connection exists at readiness');
        assert.equal(runner.location(), envDb(), 'readiness is for the final database path');
        assert.deepEqual(runner.prepare('SELECT name FROM users').all().map((x) => x.name), ['existing-user']);
      }
    } catch (e) { trace.push(`ERROR: ${e.message}`); rc = 1; }
    writeFileSync(join(state, 'ack'), String(rc));
  }, 5);
  const bridge = `request() { rm -f "$FAKE_STATE/ack"; printf '%s' "$1" > "$FAKE_STATE/request"; for i in $(seq 1 500); do if [ -f "$FAKE_STATE/ack" ]; then return "$(cat "$FAKE_STATE/ack")"; fi; /bin/sleep 0.01; done; exit 98; }\n`;
  const writeExe = (name, body) => writeFileSync(join(bin, name), '#!/bin/bash\nset -e\n' + body, { mode: 0o755 });
  writeExe('systemctl', bridge + `echo "systemctl $*" >> "$FAKE_STATE/calls"
case "$1" in
 show)
  ${queryFail ? 'exit 1' : ':'}
  if [[ "$*" == *LoadState* ]]; then echo ${absent ? 'not-found' : 'loaded'};
  elif [ -f "$FAKE_STATE/active" ]; then echo active; else echo inactive; fi ;;
 stop) if [ -f "$FAKE_STATE/refuse-stop" ]; then exit 1; fi; ${refuseStop ? 'exit 1' : falseStop ? 'exit 0' : 'request stop'} ;;
 restart) ${restartFail ? 'exit 1' : 'request restart'} ;;
 is-active) test -f "$FAKE_STATE/active" ;;
 is-enabled|enable|daemon-reload) exit 0 ;;
 *) exit 97 ;;
esac
`);
  writeExe('docker', bridge + `echo "docker $*" >> "$FAKE_STATE/calls"
case "$2" in
 version) exit 0 ;;
 down) ${failDown ? 'exit 22' : 'request down'} ;;
 build) exit ${failBuild ? 23 : 0} ;;
 up) request up ;;
 *) exit 97 ;;
esac
`);
  writeExe('proxypilot', bridge + 'request status\n');
  writeExe('pm2', bridge + `echo "pm2 $*" >> "$FAKE_STATE/calls"
case "$1" in
 delete) exit 0 ;;
 start) request native-start; exit 31 ;;
 stop) ${nativeStop === 'refused' ? 'exit 1' : nativeStop === 'still-running' ? 'exit 0' : 'request native-stop'} ;;
 pid) if [ -f "$FAKE_STATE/backend-active" ]; then echo 424242; else echo 0; fi ;;
 *) exit 97 ;;
esac
`);
  // An actual child process stands in for nohup. Its signal handler closes
  // the real SQLite writer via the same bridge as the PM2 test double.
  writeExe('nohup', bridge + `echo $$ > "$FAKE_STATE/native-pid"
trap 'request native-stop; exit 0' TERM
request native-start
while :; do /bin/sleep 0.01; done
`);
  writeExe('sleep', nativeMode === 'nohup' ? `
if [ "$1" = 3 ]; then
 for i in $(seq 1 500); do
  if [ -f "$FAKE_STATE/backend-active" ]; then exit 0; fi
  /bin/sleep 0.01
 done
 exit 98
fi
/bin/sleep 0.01
` : 'exit 0\n');
  // Observe actual cp/mv/rm targets, rejecting any destructive database
  // operation while the simulated service still has its real connection.
  for (const name of ['cp', 'mv', 'rm']) writeExe(name, `
for p in "$@"; do
 case "$p" in */proxypilot.db|*/proxypilot.db-wal|*/proxypilot.db-shm)
  if [ "${name}" != cp ] || [ "$p" = "\${!#}" ]; then
   echo "${name} $p" >> "$FAKE_STATE/calls"
   if [ -f "$FAKE_STATE/active" ]; then echo 'UNSAFE database mutation with active runner' >&2; exit 96; fi
   if [ -f "$FAKE_STATE/backend-active" ]; then echo 'UNSAFE database mutation with active backend' >&2; exit 96; fi
  fi ;;
 esac
done
exec /bin/${name} "$@"
`);
  // Inject a failure after the DB moved but before its .env was rewritten.
  if (failEnvWrite) writeExe('awk', `if [[ "$*" == *DATABASE_PATH* ]]; then exit 27; fi\nexec /usr/bin/awk "$@"\n`);
  const functions = ['log', 'log_verbose', 'backup_db', 'stop_setup_runner', 'stop_native_backend', 'stop_update_writers', 'migrate_db_layout', 'restore_db', 'on_error', 'install_setup_runner'].map(lift).join('\n')
    .replaceAll('/opt/proxypilot', install)
    .replaceAll('/etc/systemd/system', join(root, 'etc/systemd/system'))
    .replaceAll('/usr/local/bin/proxypilot', join(bin, 'proxypilot'))
    .replaceAll('/root/.proxypilot', join(root, 'root/.proxypilot'))
    .replaceAll('/etc/sysctl.d', join(root, 'etc/sysctl.d'))
    .replaceAll('/var/lib/proxypilot', join(root, 'var/lib/proxypilot'));
  const prelude = `set -e
export PATH=${quote(bin)}:$PATH FAKE_STATE=${quote(state)}
SCRIPT_DIR=${quote(join(root, 'src'))}
INSTALL_DIR=${quote(install)}
LOG_FILE=${quote(join(root, 'update.log'))}
VERBOSE=false
RED='' GREEN='' YELLOW='' BLUE='' NC=''
DB_BACKUP_FILE='' DB_BACKUP_SOURCE='' BACKUPS_TO_KEEP=5
DB_MAINTENANCE_STARTED=false DB_LAYOUT_NEW_PATH='' DB_LAYOUT_ENV_BACKUP='' DB_LAYOUT_ENV_PATH=''
NATIVE_BACKEND_MODE=''
DC_CMD='docker compose'
${functions}
`;
  const run = (body) => new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', prelude + '\n' + body], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (s) => { stdout += s; }); child.stderr.on('data', (s) => { stderr += s; });
    child.on('error', reject); child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
  const snapshot = `backup_db ${quote(original)}\n`;
  const rows = (path = original) => { const d = new DatabaseSync(path); try { return d.prepare('SELECT value FROM changes').all().map((r) => r.value); } finally { d.close(); } };
  t.after(() => {
    clearInterval(timer);
    if (existsSync(join(state, 'native-pid'))) {
      try { process.kill(Number(readFileSync(join(state, 'native-pid'), 'utf8')), 'SIGKILL'); } catch { /* child already reaped */ }
    }
    closeRunner(); closeBackend(); rmSync(root, { recursive: true, force: true });
  });
  return { root, original, current, env, originalEnv, run, snapshot, trace, rows, openRunner,
    mutate: () => runner.exec("INSERT INTO changes VALUES ('post-backup');"),
    runnerOpen: () => runner !== null,
    calls: () => existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8') : '',
  };
}

test('U1: failed PM2/native startup restores the backup only after its database writer stops', { skip }, async (t) => {
  for (const [nativeMode, nativeStop] of [['pm2', 'stopped'], ['pm2', 'refused'], ['pm2', 'still-running'], ['nohup', 'stopped']]) {
    const h = harness(t, { nativeStop, nativeMode }); h.openRunner();
    // Execute the real startup branch and handlers with no Docker install.
    // PM2 writes to real SQLite and reports a failed start while still open.
    const selectNohup = nativeMode === 'nohup' ? 'command() { if [ "$*" = "-v pm2" ]; then return 1; fi; builtin command "$@"; }\n' : '';
    const startup = nativeStartup.replaceAll('/tmp/proxypilot.log', join(h.root, 'native.log'));
    const r = await h.run(h.snapshot + 'INSTALL_DIR=""\n' + traps + '\n' + selectNohup + startup + '\nexit 31');
    assert.equal(r.status, 31, r.stdout + r.stderr);
    assert.ok(h.trace.includes('native-start'));
    if (nativeMode === 'pm2') assert.ok(h.calls().includes('pm2 stop proxypilot'));
    assert.doesNotMatch(h.calls(), /docker compose/);
    assert.doesNotMatch(r.stderr, /UNSAFE/);
    assert.equal(readFileSync(h.env, 'utf8'), h.originalEnv);
    if (nativeStop === 'stopped') {
      assert.match(r.stdout, /Database restored/);
      assert.deepEqual(h.rows(), ['backup-state'], 'failed-start changes must not survive rollback');
      const calls = h.calls();
      if (nativeMode === 'pm2') assert.ok(calls.indexOf('pm2 stop proxypilot') < calls.indexOf(`cp ${h.original}`), 'stop before real restore copy');
      assert.ok(h.trace.indexOf('backend closed') < h.trace.indexOf('restart'), 'writer closed before runner recovery');
      assert.ok(h.trace.includes('status'), 'runner readiness checked after recovery');
    } else {
      assert.match(r.stdout, /Recovery refused or failed/);
      assert.doesNotMatch(r.stdout, /Database restored/);
      assert.deepEqual(h.rows(), ['backup-state', 'failed-native-start']);
      assert.ok(!h.trace.includes('restart'));
    }
  }
});

for (const legacy of [false, true]) {
  test(`U1: ${legacy ? 'legacy' : 'current'} layout stops an open runner, rebuilds, restarts and checks the final path`, { skip }, async (t) => {
    const h = harness(t, { legacy }); h.openRunner();
    const r = await h.run(h.snapshot + traps + '\n' + maintenance);
    assert.equal(r.status, 0, r.stdout + r.stderr + h.trace.join('\n'));
    assert.deepEqual(h.rows(h.current), ['backup-state']);
    assert.ok(h.trace.indexOf('runner closed') < h.trace.indexOf('down'));
    assert.ok(h.trace.lastIndexOf('restart') < h.trace.lastIndexOf('up'));
    assert.ok(h.trace.includes('status'));
    assert.ok(!h.trace.some((x) => x.startsWith('ERROR:')), h.trace.join('\n'));
    assert.match(readFileSync(h.env, 'utf8'), /^DATABASE_PATH=\/data\/db\/proxypilot.db$/m);
    if (legacy) assert.equal(existsSync(h.original), false);
  });
  for (const ending of ['false', 'exit 17', 'kill -TERM $$', 'kill -INT $$']) {
    test(`U1: ${legacy ? 'legacy' : 'current'} recovery for ${ending} closes both writers and restores the matching layout`, { skip }, async (t) => {
      const h = harness(t, { legacy });
      // Snapshot first, then keep a real runner connection with newer data.
      // Re-use backup paths across separate shell invocations.
      const b = await h.run(h.snapshot + `printf '%s' "$DB_BACKUP_FILE" > ${quote(join(h.root, 'backup-path'))}`);
      assert.equal(b.status, 0, b.stderr);
      h.openRunner(); h.mutate();
      const r = await h.run(`DB_BACKUP_FILE=$(cat ${quote(join(h.root, 'backup-path'))})\nDB_BACKUP_SOURCE=${quote(h.original)}\n${traps}\n${maintenance}\n${ending}`);
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Database restored/);
      assert.deepEqual(h.rows(), ['backup-state'], 'no post-backup rows survive');
      assert.equal(readFileSync(h.env, 'utf8'), h.originalEnv, 'configuration and encryption keys unchanged');
      if (legacy) assert.equal(existsSync(h.current), false, 'no second DB left after layout recovery');
      assert.ok(h.trace.includes('backend closed'), 'failed backend stopped for restore');
      assert.equal(h.trace.filter((x) => x === 'status').length, 2, 'readiness after update and after recovery');
      assert.ok(!h.trace.some((x) => x.startsWith('ERROR:')), h.trace.join('\n'));
      assert.doesNotMatch(r.stderr, /UNSAFE/);
    });
  }
}

for (const opts of [{ refuseStop: true }, { falseStop: true }, { queryFail: true }]) {
  test(`U1: unsafe stop ${JSON.stringify(opts)} refuses relocation AND restore with the connection active`, { skip }, async (t) => {
    const h = harness(t, { legacy: true, ...opts }); h.openRunner(); h.mutate();
    const r = await h.run(h.snapshot + `${traps}\n${maintenance}`);
    assert.notEqual(r.status, 0);
    assert.ok(h.runnerOpen());
    assert.equal(existsSync(h.original), true); assert.equal(existsSync(h.current), false);
    assert.equal(readFileSync(h.env, 'utf8'), h.originalEnv);
    assert.doesNotMatch(h.calls(), /docker compose down|^mv /m);
    const restore = await h.run(h.snapshot + 'restore_db');
    assert.notEqual(restore.status, 0);
    assert.ok(h.runnerOpen());
    assert.deepEqual(h.rows(), ['backup-state', 'post-backup']);
    assert.doesNotMatch(restore.stdout, /Database restored/);
  });
}

test('U1: no backup WAL, real failed-update WAL/SHM: restore removes stale sidecars after stopping the runner', { skip }, async (t) => {
  const h = harness(t, { staleSidecars: true });
  await h.run(h.snapshot + `printf '%s' "$DB_BACKUP_FILE" > ${quote(join(h.root, 'backup-path'))}`);
  h.openRunner(); h.mutate();
  assert.ok(existsSync(h.original + '-wal'));
  const r = await h.run(`DB_BACKUP_FILE=$(cat ${quote(join(h.root, 'backup-path'))})\nDB_BACKUP_SOURCE=${quote(h.original)}\nrestore_db`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(h.original + '-wal'), false);
  assert.equal(existsSync(h.original + '-shm'), false);
  assert.deepEqual(h.rows(), ['backup-state']);
});

test('U1: a WAL-bearing backup restores its own WAL; SHM is rebuilt, never copied', { skip }, async (t) => {
  const h = harness(t); h.openRunner(); h.mutate();
  const b = await h.run(h.snapshot + `printf '%s' "$DB_BACKUP_FILE" > ${quote(join(h.root, 'backup-path'))}`);
  assert.equal(b.status, 0, b.stderr);
  const backup = readFileSync(join(h.root, 'backup-path'), 'utf8');
  assert.ok(existsSync(backup + '-wal'));
  h.mutate();
  const r = await h.run(`DB_BACKUP_FILE=${quote(backup)}\nDB_BACKUP_SOURCE=${quote(h.original)}\nrestore_db`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(h.original + '-shm'), false);
  assert.deepEqual(h.rows(), ['backup-state', 'post-backup'], 'only the row already in the backup WAL survives');
});

for (const opts of [{ failBuild: true }, { failEnvWrite: true }]) {
  test(`U1: legacy failure ${JSON.stringify(opts)} restores original path and config before runner readiness`, { skip }, async (t) => {
    const h = harness(t, { legacy: true, ...opts }); h.openRunner();
    const r = await h.run(h.snapshot + traps + '\n' + maintenance);
    assert.notEqual(r.status, 0);
    if (opts.failEnvWrite) {
      // The injected awk failure also stops only the rewrite, not recovery cp.
      assert.match(r.stdout, /Database restored/);
    }
    assert.deepEqual(h.rows(), ['backup-state']);
    assert.equal(readFileSync(h.env, 'utf8'), h.originalEnv);
    assert.equal(existsSync(h.current), false);
  });
}

test('U1: failure to stop Docker refuses restore and does not restart services', { skip }, async (t) => {
  const h = harness(t, { failDown: true }); h.openRunner();
  const r = await h.run(h.snapshot + traps + '\n' + maintenance);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /Recovery refused or failed/);
  assert.doesNotMatch(r.stdout, /Database restored/);
  assert.ok(!h.trace.includes('restart'));
});

test('U1: a runner that refuses to stop during failure recovery prevents restore', { skip }, async (t) => {
  const h = harness(t, { legacy: true }); h.openRunner(); h.mutate();
  const r = await h.run(h.snapshot + traps + '\n' + maintenance + '\n: > "$FAKE_STATE/refuse-stop"\nexit 19');
  assert.equal(r.status, 19);
  assert.match(r.stdout, /Recovery refused or failed/);
  assert.doesNotMatch(r.stdout, /Database restored/);
  assert.ok(h.runnerOpen());
  assert.deepEqual(h.rows(h.current), ['backup-state', 'post-backup']);
  assert.equal(existsSync(h.original), false, 'the old path is not recreated behind an active connection');
  assert.equal(h.trace.filter((x) => x === 'restart').length, 1, 'no recovery restart');
});

test('U2: updating the unit preserves existing CLI data and configuration', { skip }, async (t) => {
  const h = harness(t);
  const cliDir = join(h.root, 'root/.proxypilot'); mkdirSync(cliDir, { recursive: true });
  const cliDb = join(cliDir, 'proxypilot.db');
  const db = new DatabaseSync(cliDb); db.exec("CREATE TABLE settings (value TEXT); INSERT INTO settings VALUES ('existing-firewall-state')"); db.close();
  const bytes = readFileSync(cliDb);
  writeFileSync(join(cliDir, 'config.yaml'), 'database: {path: ~/.proxypilot/proxypilot.db}\n');
  const r = await h.run('install_setup_runner');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readFileSync(cliDb), bytes);
  assert.equal(readFileSync(join(cliDir, 'config.yaml'), 'utf8'), 'database: {path: ~/.proxypilot/proxypilot.db}\n');
  assert.ok(h.trace.includes('status'));
});

test('U1: a pre-runner installation can relocate and install its first runner', { skip }, async (t) => {
  const h = harness(t, { legacy: true, absent: true });
  const r = await h.run(h.snapshot + traps + '\n' + maintenance);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(h.trace.includes('status'));
});

test('U2: unit grants only the existing CLI DB and atomic sysctl directory writes, preserving hardening', () => {
  const unit = readFileSync(join(REPO, 'deploy', UNIT), 'utf8');
  for (const line of ['ProtectHome=read-only', 'ProtectSystem=full', 'NoNewPrivileges=true', 'PrivateTmp=true', 'Environment=HOME=/root']) assert.ok(unit.split('\n').includes(line), line);
  assert.equal(unit.match(/^ReadWritePaths=(.*)$/m)[1], '/opt/proxypilot/data /var/lib/proxypilot /root/.proxypilot /etc/sysctl.d');
  assert.match(readFileSync(join(REPO, 'cli/src/config.js'), 'utf8'), /path: '~\/\.proxypilot\/proxypilot.db'/);
  const config = readFileSync(join(REPO, 'admin/backend/src/lib/setup-engine/config-logic.js'), 'utf8');
  assert.match(config, /mktemp/); assert.match(config, /mv -f/);
  assert.match(readFileSync(join(REPO, 'admin/backend/src/lib/l4-reserved-ports.js'), 'utf8'), /\/etc\/sysctl.d\/99-proxypilot-l4-reserved.conf/);
  const install = readFileSync(join(REPO, 'install.sh'), 'utf8');
  assert.ok(install.indexOf('mkdir -p /opt/proxypilot/data /var/lib/proxypilot /root/.proxypilot /etc/sysctl.d') < install.indexOf('systemctl restart proxypilot-setup-runner.service'));
});
