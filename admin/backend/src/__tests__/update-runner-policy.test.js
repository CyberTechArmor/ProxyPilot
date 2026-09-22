// update.sh — the setup-runner step of an update, driven as REAL bash.
//
// Two defects confirmed on main@2577a71 (after PR #610), each a regression
// here:
//
//   1. `sync_env_keys` runs before `install_setup_runner` and copied
//      `SETUP_EXECUTOR_POLICY=runner-required` verbatim from .env.example
//      into a deployed .env that never had the line — so an installation was
//      flipped to runner-required before the runner had started or opened
//      the database, and the readiness step then saw "a line already
//      exists" and never touched it. The policy is the readiness step's to
//      record, only on its evidence, and only when absent.
//   2. `install_setup_runner` restarted the runner only when its unit file
//      changed or the unit was inactive: an active runner kept executing the
//      previous version's modules after every update that left the unit
//      file alone.
//
// The functions under test are lifted verbatim out of update.sh (together
// with the log helpers and resolve_env_path they call) and run in the order
// the script runs them, against a temp root: the absolute paths the script
// hard-codes (/opt/proxypilot, /etc/systemd/system, /usr/local/bin/proxypilot)
// are redirected into it, and `systemctl`, `proxypilot` and `sleep` are
// stubs on PATH that record every call and answer from a state directory.
// The functions skip themselves when not root (EUID is read-only), so the
// suite skips there rather than pretending.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const UPDATE_SH = join(REPO, 'update.sh');
const UNIT = 'proxypilot-setup-runner.service';
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

const FAKE_SYSTEMCTL = `#!/bin/bash
# state dir: active (0/1), enabled (0/1), restart_fail (exit code), restart_leaves (0/1 → active after restart)
S="$FAKE_STATE"
echo "systemctl $*" >> "$S/calls"
case "$1" in
  is-active) [ "$(cat "$S/active" 2>/dev/null)" = "1" ] && exit 0 || exit 3 ;;
  is-enabled) [ "$(cat "$S/enabled" 2>/dev/null)" = "1" ] && exit 0 || exit 1 ;;
  enable) echo 1 > "$S/enabled"; exit 0 ;;
  daemon-reload) exit 0 ;;
  restart)
    rc="$(cat "$S/restart_fail" 2>/dev/null || echo 0)"
    if [ "$rc" != "0" ]; then echo "Job for $2 failed because the control process exited with error code." >&2; exit "$rc"; fi
    echo "$(cat "$S/restart_leaves" 2>/dev/null || echo 1)" > "$S/active"
    exit 0 ;;
  *) exit 0 ;;
esac
`;
const FAKE_PROXYPILOT = `#!/bin/bash
echo "proxypilot $*" >> "$FAKE_STATE/calls"
exit "$(cat "$FAKE_STATE/status_rc" 2>/dev/null || echo 0)"
`;
const FAKE_SLEEP = `#!/bin/bash
echo "sleep $*" >> "$FAKE_STATE/calls"
exit 0
`;

/**
 * A temp installation: the checkout (SCRIPT_DIR) with .env.example and the
 * unit, the deployed .env under the redirected /opt/proxypilot, the
 * redirected /etc/systemd/system, the stubs.
 */
function setup({ env, unitInstalled = true, active = true, enabled = true, restartFail = 0, restartLeaves = 1, statusRc = 0, example = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pp-update-'));
  const src = join(root, 'src');
  const install = join(root, 'opt', 'proxypilot');
  const systemd = join(root, 'etc', 'systemd', 'system');
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  for (const d of [join(src, 'deploy'), install, systemd, bin, state]) mkdirSync(d, { recursive: true });
  writeFileSync(join(src, '.env.example'), example ?? [
    '# Who executes setup jobs',
    'SETUP_EXECUTOR_POLICY=runner-required',
    '# A newly introduced non-secret key',
    'NEW_PLAIN_KEY=example-default',
    '',
  ].join('\n'));
  copyFileSync(join(REPO, 'deploy', UNIT), join(src, 'deploy', UNIT));
  if (unitInstalled) copyFileSync(join(REPO, 'deploy', UNIT), join(systemd, UNIT));
  if (env != null) writeFileSync(join(install, '.env'), env);
  writeFileSync(join(bin, 'systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
  writeFileSync(join(bin, 'proxypilot'), FAKE_PROXYPILOT, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), FAKE_SLEEP, { mode: 0o755 });
  writeFileSync(join(state, 'active'), active ? '1' : '0');
  writeFileSync(join(state, 'enabled'), enabled ? '1' : '0');
  writeFileSync(join(state, 'restart_fail'), String(restartFail));
  writeFileSync(join(state, 'restart_leaves'), String(restartLeaves));
  writeFileSync(join(state, 'status_rc'), String(statusRc));
  const log = join(root, 'update.log');
  writeFileSync(log, '');
  // The functions, verbatim, with the hard-coded absolute paths redirected.
  const lifted = ['log', 'log_verbose', 'resolve_env_path', 'sync_env_keys', 'install_setup_runner']
    .map((fn) => `source <(sed -n '/^${fn}()/,/^}/p' ${JSON.stringify(UPDATE_SH)} | sed -e "s#/opt/proxypilot#${install}#g" -e "s#/etc/systemd/system#${systemd}#g" -e "s#/usr/local/bin/proxypilot#${bin}/proxypilot#g")`)
    .join('\n');
  const run = (body) => {
    const script = `
set -e
export PATH=${JSON.stringify(bin)}:$PATH
export FAKE_STATE=${JSON.stringify(state)}
SCRIPT_DIR=${JSON.stringify(src)}
INSTALL_DIR=${JSON.stringify(install)}
LOG_FILE=${JSON.stringify(log)}
VERBOSE=false
RED='' GREEN='' YELLOW='' CYAN='' NC=''
${lifted}
${body}
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    return r;
  };
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  return {
    root, run,
    env: () => read(join(install, '.env')),
    calls: () => (read(join(state, 'calls')) || '').trim().split('\n').filter(Boolean),
    log: () => read(log),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const policyLines = (env) => (env || '').split('\n').filter((l) => /^SETUP_EXECUTOR_POLICY=/.test(l));
const BASE_ENV = 'DOMAIN=pp.test\nJWT_SECRET=x\n';
const skip = ROOT_USER ? false : 'the lifted functions skip themselves when not root (EUID is read-only)';

test('policy absent, runner healthy: sync_env_keys adds every other key but not the policy; install_setup_runner records runner-required only after the restart and the readiness checks', { skip }, (t) => {
  const h = setup({ env: BASE_ENV });
  t.after(h.cleanup);
  // Phase 1: the generic sync alone, exactly as the script runs it first.
  const s1 = h.run('sync_env_keys; echo "SYNC_DONE"');
  assert.match(s1.stdout, /SYNC_DONE/, s1.stderr);
  assert.match(h.env(), /^NEW_PLAIN_KEY=example-default$/m, 'the other new key is still synced (legacy behaviour)');
  assert.deepEqual(policyLines(h.env()), [], 'the policy is NOT copied from .env.example by the generic sync');
  assert.doesNotMatch(s1.stdout, /SETUP_EXECUTOR_POLICY/, 'nor listed as synced');
  // Phase 2: the readiness step, in the script's order.
  const s2 = h.run('install_setup_runner; echo "RUNNER_DONE"');
  assert.match(s2.stdout, /RUNNER_DONE/, s2.stderr);
  assert.deepEqual(policyLines(h.env()), ['SETUP_EXECUTOR_POLICY=runner-required'], 'recorded once, by the readiness step');
  const calls = h.calls();
  const restart = calls.findIndex((c) => c === `systemctl restart ${UNIT}`);
  const active = calls.findIndex((c, i) => i > restart && c === `systemctl is-active --quiet ${UNIT}`);
  const status = calls.findIndex((c) => /^proxypilot setup-runner status --install-dir .* --json$/.test(c));
  assert.ok(restart >= 0 && active > restart && status > active, `restart, then active, then status: ${calls.join(' | ')}`);
  assert.match(s2.stdout, /Setup runner ready/);
  assert.match(s2.stdout, /Recorded SETUP_EXECUTOR_POLICY=runner-required/);
});

test('policy absent, runner failure: no premature promotion — the line is never introduced, the failure is red, and the legacy in-process executor is named', { skip }, (t) => {
  for (const [label, opts] of [['the unit never becomes active', { restartLeaves: 0, active: false }], ['the unit is active but cannot open the database', { statusRc: 1 }]]) {
    const h = setup({ env: BASE_ENV, ...opts });
    t.after(h.cleanup);
    const r = h.run('sync_env_keys; install_setup_runner; echo "DONE"');
    assert.match(r.stdout, /DONE/, `${label}: ${r.stderr}`);
    assert.deepEqual(policyLines(h.env()), [], `${label}: no policy line introduced`);
    assert.match(h.env(), /^NEW_PLAIN_KEY=example-default$/m, `${label}: the ordinary sync still happened`);
    assert.match(r.stdout, /Setup runner did NOT start or cannot open the database/, label);
    assert.match(r.stdout, /SETUP_EXECUTOR_POLICY was not set to runner-required: the dashboard container keeps executing deploys itself/, label);
    assert.doesNotMatch(r.stdout, /Setup runner ready/, label);
    assert.ok(h.calls().includes(`systemctl restart ${UNIT}`), `${label}: the restart was still attempted`);
  }
});

test('explicit policies are preserved: backend-allowed stays on success and on failure; runner-required stays on failure and the failure says the installation requires the runner', { skip }, (t) => {
  const cases = [
    ['backend-allowed, healthy', { env: `${BASE_ENV}SETUP_EXECUTOR_POLICY=backend-allowed\n` }, 'SETUP_EXECUTOR_POLICY=backend-allowed', /Setup runner ready/],
    ['backend-allowed, runner down', { env: `${BASE_ENV}SETUP_EXECUTOR_POLICY=backend-allowed\n`, restartLeaves: 0, active: false }, 'SETUP_EXECUTOR_POLICY=backend-allowed', /was not set to runner-required/],
    ['runner-required, runner down', { env: `${BASE_ENV}SETUP_EXECUTOR_POLICY=runner-required\n`, restartLeaves: 0, active: false }, 'SETUP_EXECUTOR_POLICY=runner-required', /This installation REQUIRES the runner: every deploy will queue until it is running/],
    ['runner-required, database unreadable', { env: `${BASE_ENV}SETUP_EXECUTOR_POLICY=runner-required\n`, statusRc: 2 }, 'SETUP_EXECUTOR_POLICY=runner-required', /This installation REQUIRES the runner/],
  ];
  for (const [label, opts, expectLine, expectOut] of cases) {
    const h = setup(opts);
    t.after(h.cleanup);
    const r = h.run('sync_env_keys; install_setup_runner; echo "DONE"');
    assert.match(r.stdout, /DONE/, `${label}: ${r.stderr}`);
    assert.deepEqual(policyLines(h.env()), [expectLine], `${label}: the explicit line is the only one, unchanged`);
    assert.match(r.stdout, expectOut, label);
    assert.doesNotMatch(r.stdout, /Recorded SETUP_EXECUTOR_POLICY/, `${label}: nothing recorded over an explicit choice`);
  }
});

test('an active runner with an unchanged unit file is restarted onto the updated code', { skip }, (t) => {
  const h = setup({ env: `${BASE_ENV}SETUP_EXECUTOR_POLICY=runner-required\n`, unitInstalled: true, active: true, enabled: true });
  t.after(h.cleanup);
  const r = h.run('install_setup_runner; echo "DONE"');
  assert.match(r.stdout, /DONE/, r.stderr);
  const calls = h.calls();
  assert.ok(calls.includes(`systemctl restart ${UNIT}`), `restarted although the unit file is unchanged and the unit active: ${calls.join(' | ')}`);
  assert.ok(!calls.includes('systemctl daemon-reload'), 'no unit change, no daemon-reload');
  assert.doesNotMatch(r.stdout, /Installed setup runner unit/);
  assert.match(r.stdout, /restarted onto the updated code/);
});

test('a refused restart is never a ready result: an old process still active does not pass, nothing is promoted, and the failure is visible', { skip }, (t) => {
  // The service manager refuses the restart; the OLD process stays active
  // and would open the database — that must not read as ready.
  const h = setup({ env: BASE_ENV, restartFail: 1, active: true, statusRc: 0 });
  t.after(h.cleanup);
  const r = h.run('sync_env_keys; install_setup_runner; echo "DONE"');
  assert.match(r.stdout, /DONE/, r.stderr);
  assert.match(r.stdout, /Could not restart proxypilot-setup-runner\.service: Job for .* failed .* the runner is still on the previous version's code/);
  assert.match(r.stdout, /Setup runner did NOT start or cannot open the database/);
  assert.doesNotMatch(r.stdout, /Setup runner ready/, 'no false ready result');
  assert.deepEqual(policyLines(h.env()), [], 'no promotion on a refused restart');
  assert.ok(!h.calls().some((c) => /^proxypilot setup-runner status/.test(c)), 'the database check is not run for a process that is not on the new code');
  // The same refusal on a runner-required installation keeps the policy and says so.
  const h2 = setup({ env: `${BASE_ENV}SETUP_EXECUTOR_POLICY=runner-required\n`, restartFail: 1, active: true });
  t.after(h2.cleanup);
  const r2 = h2.run('install_setup_runner; echo "DONE"');
  assert.match(r2.stdout, /DONE/, r2.stderr);
  assert.deepEqual(policyLines(h2.env()), ['SETUP_EXECUTOR_POLICY=runner-required']);
  assert.match(r2.stdout, /This installation REQUIRES the runner/);
});

test('ratchet: the policy key is excluded from the generic env sync, and the runner restart no longer depends on a changed unit file', () => {
  const s = readFileSync(UPDATE_SH, 'utf8');
  const sync = s.slice(s.indexOf('sync_env_keys()'), s.indexOf('set_env_key()'));
  assert.match(sync, /case "\$key" in SETUP_EXECUTOR_POLICY\) continue ;; esac/, 'sync_env_keys skips the policy key');
  const fn = s.slice(s.indexOf('install_setup_runner()'));
  assert.doesNotMatch(fn, /if \[ "\$changed" = true \] \|\| ! systemctl is-active/, 'the conditional restart is gone');
  assert.match(fn, /if ! restart_out="\$\(systemctl restart "\$unit" 2>&1\)"; then/, 'the restart is unconditional and its status is read (no tee pipeline: set -e without pipefail)');
  assert.match(fn, /if \[ "\$restart_ok" = true \]; then\n\s+for i in 1 2 3 4 5 6 7 8 9 10; do/, 'readiness is only checked after a restart the service manager accepted');
  assert.ok(s.indexOf('sync_env_keys\n', s.indexOf('# After pulling, sync .env')) < s.indexOf('    install_setup_runner\n'), 'the order that made the defect possible is unchanged: the sync runs first, so the exclusion is what protects the policy');
  assert.match(readFileSync(join(REPO, '.env.example'), 'utf8'), /^SETUP_EXECUTOR_POLICY=runner-required$/m, '.env.example still carries runner-required (a fresh install reads it after its own readiness check); the exclusion above is what keeps it out of an updated .env');
});
