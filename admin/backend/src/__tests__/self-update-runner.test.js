// scripts/update-runner.sh — the root oneshot behind "Update now" — driven
// end to end under bash with its directories pointed at a temp tree and a
// fake update.sh. This is the machine check for the request-file contract:
// what the agent writes (update.go) is what the runner accepts, forged /
// stale / disallowed requests are refused with a reason, a run records
// state.json + <id>.log + done.<id>, and `check` records the checkout facts
// the dashboard shows. Also pins update.sh's --yes contract at source level.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('../../../../scripts/update-runner.sh', import.meta.url));
const UPDATE_SH = fileURLToPath(new URL('../../../../update.sh', import.meta.url));

const FAKE_UPDATE_SH = `#!/bin/bash
echo "args: $*"
echo -e "\\033[0;34m[0/7] Backing up database...\\033[0m"
echo "[1/7] Fetching latest changes..."
echo "[2/7] Pulling latest code..."
echo "[3.5/7] Installing host-side agent (Phase A scaffold)..."
echo "[7/7] Restarting ProxyPilot..."
if [ "\${FAKE_UPTODATE:-}" = 1 ]; then echo "Code is already up to date!"; fi
if [ "\${FAKE_FAIL:-}" = 1 ]; then echo "boom: simulated failure"; exit 3; fi
echo "done"
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pp-runner-'));
  const run = join(root, 'run');
  const state = join(root, 'state');
  const src = join(root, 'src');
  mkdirSync(run); mkdirSync(state); mkdirSync(join(src, 'admin', 'backend'), { recursive: true });
  writeFileSync(join(src, 'update.sh'), FAKE_UPDATE_SH, { mode: 0o755 });
  writeFileSync(join(src, 'admin', 'backend', 'package.json'), '{\n  "name": "x",\n  "version": "1.4.0"\n}\n');
  const git = (...args) => execFileSync('git', ['-C', src, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const env = {
    ...process.env,
    PROXYPILOT_UPDATE_RUN_DIR: run,
    PROXYPILOT_UPDATE_STATE_DIR: state,
    PROXYPILOT_UPDATE_LOCK: join(root, 'lock'),
    PROXYPILOT_UPDATE_REQUEST_OWNER: userInfo().username,
  };
  const runner = (args = [], extraEnv = {}) => spawnSync('bash', [RUNNER, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv } });
  const readJson = (name) => JSON.parse(readFileSync(join(state, name), 'utf8'));
  let n = 0;
  const request = ({ id, action = 'update', flags = '', ageSec = 0, nonce = 'a'.repeat(32), writeNonce = true, requestedBy = 'admin' }) => {
    id = id || `11111111-2222-4333-8444-5555555555${String(n++).padStart(2, '0')}`;
    if (writeNonce) writeFileSync(join(run, `nonce.${id}`), nonce + '\n');
    const at = Math.floor(Date.now() / 1000) - ageSec;
    writeFileSync(join(run, 'request.json'), JSON.stringify({ id, action, requested_by: requestedBy, requested_at: new Date(at * 1000).toISOString(), requested_at_unix: at, nonce, flags }) + '\n');
    return id;
  };
  return { root, run, state, src, git, runner, readJson, request, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('record-source + check record the checkout facts, including dirtiness', (t) => {
  const s = setup();
  t.after(s.cleanup);
  assert.equal(s.runner(['record-source', s.src]).status, 0);
  assert.equal(readFileSync(join(s.state, 'source-dir'), 'utf8').trim(), s.src);
  assert.equal(s.runner(['record-source', s.root]).status, 2, 'not a checkout → refused');
  assert.equal(s.runner(['check']).status, 0);
  let facts = s.readJson('installed.json');
  assert.equal(facts.configured, true);
  assert.equal(facts.branch, 'main');
  assert.match(facts.head_sha, /^[0-9a-f]{40}$/);
  assert.equal(facts.head_short, facts.head_sha.slice(0, 10));
  assert.equal(facts.dirty, false);
  assert.deepEqual(facts.dirty_files, []);
  assert.equal(facts.installed_version, '1.4.0');
  assert.ok(Math.abs(facts.checked_at_unix - Date.now() / 1000) < 30);
  // A local edit shows up; a drifted package-lock.json does not (update.sh restores it).
  writeFileSync(join(s.src, 'notes.txt'), 'x');
  writeFileSync(join(s.src, 'admin', 'backend', 'package-lock.json'), '{}');
  s.git('add', join(s.src, 'admin', 'backend', 'package-lock.json'));
  s.git('commit', '-q', '-m', 'lock');
  writeFileSync(join(s.src, 'admin', 'backend', 'package-lock.json'), '{"drift":1}');
  s.runner(['check']);
  facts = s.readJson('installed.json');
  assert.equal(facts.dirty, true);
  assert.equal(facts.dirty_count, 1);
  assert.deepEqual(facts.dirty_files, ['?? notes.txt']);
});

test('check without a recorded checkout records configured:false with the fix', (t) => {
  const s = setup();
  t.after(s.cleanup);
  assert.equal(s.runner(['check']).status, 1);
  const facts = s.readJson('installed.json');
  assert.equal(facts.configured, false);
  assert.match(facts.error, /install\.sh or update\.sh/);
});

test('a valid update request runs update.sh --yes with the allowlisted flags and records the run', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.runner(['record-source', s.src]);
  const id = s.request({ flags: '--rebuild', requestedBy: 'Thomas' });
  const r = s.runner();
  assert.equal(r.status, 0, r.stderr);
  const st = s.readJson('state.json');
  assert.equal(st.id, id);
  assert.equal(st.status, 'success');
  assert.equal(st.exit_code, 0);
  assert.equal(st.phase_index, 7);
  assert.equal(st.requested_by, 'Thomas');
  assert.equal(st.flags, '--rebuild');
  assert.match(st.from_sha, /^[0-9a-f]{40}$/);
  assert.equal(st.to_sha, st.from_sha);
  assert.equal(st.from_version, '1.4.0');
  assert.equal(st.up_to_date, false);
  assert.equal(st.reason, null);
  assert.deepEqual(s.readJson(`state.${id}.json`), st, 'per-id state mirrors the latest');
  const log = readFileSync(join(s.state, `${id}.log`), 'utf8');
  assert.match(log, /^args: --yes --rebuild$/m, 'update.sh got --yes plus the flags, nothing else');
  assert.match(log, /\[2\/7\] Pulling latest code/);
  assert.ok(existsSync(join(s.state, `done.${id}`)));
  assert.deepEqual(readdirSync(s.run), [], 'request and nonce consumed');
  // The check runs again after the update: installed.json is fresh.
  assert.equal(s.readJson('installed.json').head_sha, st.to_sha);
});

test('phases are tracked from the [n/7] markers (3.5 included) and a failure keeps the last line as the reason', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.runner(['record-source', s.src]);
  const id = s.request({});
  const r = s.runner([], { FAKE_FAIL: '1' });
  assert.notEqual(r.status, 0);
  const st = s.readJson('state.json');
  assert.equal(st.status, 'failed');
  assert.equal(st.exit_code, 3);
  assert.equal(st.phase_index, 7);
  assert.equal(st.phase, 'Restarting ProxyPilot');
  assert.equal(st.reason, 'boom: simulated failure');
  assert.ok(existsSync(join(s.state, `done.${id}`)));
  // The phase tracker wrote intermediate states; the 3.5 marker parsed as a number.
  assert.ok(readFileSync(join(s.state, `${id}.log`), 'utf8').includes('[3.5/7]'));
});

test('an up-to-date checkout without --rebuild is a success flagged up_to_date', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.runner(['record-source', s.src]);
  s.request({});
  s.runner([], { FAKE_UPTODATE: '1' });
  const st = s.readJson('state.json');
  assert.equal(st.status, 'success');
  assert.equal(st.up_to_date, true);
  assert.equal(st.phase, 'Already up to date');
});

test('forged, stale, malformed and disallowed requests are refused with a reason and nothing runs', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.runner(['record-source', s.src]);
  const cases = [
    ['nonce_mismatch', { writeNonce: false }],
    ['nonce_mismatch', { nonce: 'b'.repeat(32), writeNonce: true, mismatch: true }],
    ['stale', { ageSec: 500 }],
    ['invalid_flags', { flags: '--discard-local' }],
    ['invalid_flags', { flags: '--rebuild --enable-mock2 --verbose' }],
    ['malformed', { action: 'shell' }],
    ['malformed', { requestedBy: 'admin; rm -rf /' }],
  ];
  for (const [code, opts] of cases) {
    let id;
    if (opts.mismatch) {
      id = s.request({ nonce: 'a'.repeat(32) });
      writeFileSync(join(s.run, `nonce.${id}`), 'c'.repeat(32) + '\n');
    } else {
      id = s.request(opts);
    }
    const r = s.runner();
    assert.notEqual(r.status, 0, `${code}: runner must exit non-zero`);
    const st = s.readJson(`state.${id}.json`);
    assert.equal(st.status, 'refused', `${code}: ${JSON.stringify(st)}`);
    assert.match(st.reason, new RegExp(`^${code}:`), `${code}: reason ${st.reason}`);
    assert.ok(!existsSync(join(s.state, `${id}.log`)) || readFileSync(join(s.state, `${id}.log`), 'utf8') === '', `${code}: update.sh must not have run`);
    assert.deepEqual(readdirSync(s.run), [], `${code}: request + nonce cleaned up`);
  }
  // A request with a non-uuid id is refused under "unknown".
  writeFileSync(join(s.run, 'request.json'), JSON.stringify({ id: '../../etc', action: 'update', requested_by: 'a', requested_at_unix: Math.floor(Date.now() / 1000), nonce: 'a'.repeat(32), flags: '' }) + '\n');
  s.runner();
  assert.match(s.readJson('state.unknown.json').reason, /^malformed: request id/);
});

test('a refusal never clobbers state.json while another run is recorded as running', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.runner(['record-source', s.src]);
  const liveId = '11111111-2222-4333-8444-ffffffffffff';
  writeFileSync(join(s.state, 'state.json'), JSON.stringify({ id: liveId, status: 'running', phase: 'Pulling latest code' }) + '\n');
  const id = s.request({ ageSec: 500 });
  s.runner();
  assert.equal(s.readJson(`state.${id}.json`).status, 'refused');
  assert.equal(s.readJson('state.json').id, liveId, 'the live run is still the latest');
});

test('a check request refreshes installed.json without touching run state', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.runner(['record-source', s.src]);
  s.request({ action: 'check', requestedBy: 'agent' });
  const r = s.runner();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.readJson('installed.json').configured, true);
  assert.ok(!existsSync(join(s.state, 'state.json')));
  assert.deepEqual(readdirSync(s.run), []);
});

test('no request file is a clean no-op; history is pruned to the newest 10 runs', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.runner(['record-source', s.src]);
  assert.equal(s.runner().status, 0);
  for (let i = 0; i < 12; i++) {
    s.request({});
    s.runner();
  }
  const states = readdirSync(s.state).filter((f) => /^state\.[0-9a-f-]{36}\.json$/.test(f));
  assert.equal(states.length, 10);
  const logs = readdirSync(s.state).filter((f) => f.endsWith('.log'));
  assert.equal(logs.length, 10);
});

test('update.sh: every prompt is guarded by --yes, and --discard-local is the only way past local changes', () => {
  const sh = readFileSync(UPDATE_SH, 'utf8');
  const lines = sh.split('\n');
  const prompts = lines.map((l, i) => [l, i]).filter(([l]) => /^\s*read -p /.test(l));
  assert.ok(prompts.length >= 2, 'update.sh has interactive prompts');
  for (const [l, i] of prompts) {
    const before = lines.slice(Math.max(0, i - 25), i).join('\n');
    assert.match(before, /\[ "\$ASSUME_YES" = true \]/, `prompt at line ${i + 1} (${l.trim()}) is not guarded by --yes`);
  }
  assert.match(sh, /--yes\|-y\)\s*\n\s*ASSUME_YES=true/);
  assert.match(sh, /--discard-local\)\s*\n\s*DISCARD_LOCAL=true/);
  assert.match(sh, /\$GIT_CMD reset --hard HEAD/);
  assert.match(sh, /\$GIT_CMD clean -fd\b/);
  assert.doesNotMatch(sh, /clean -fdx/, 'ignored files (.env, data/) must survive --discard-local');
  // The re-exec after the pull forwards the original arguments, --yes included.
  assert.match(sh, /exec bash "\$SCRIPT_DIR\/update\.sh" --rebuild "\$@"/);
  // The runner is installed and the checkout recorded on every update.
  assert.match(sh, /install_update_runner\(\)/);
  assert.match(sh, /"\$runner_dst" record-source "\$SCRIPT_DIR"/);
  assert.match(sh, /systemctl enable proxypilot-update\.path/);
});

test('the systemd units and the agent unit agree on the request directory', () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(`../../../../deploy/${p}`, import.meta.url)), 'utf8');
  const path = read('proxypilot-update.path');
  const service = read('proxypilot-update.service');
  const agent = read('proxypilot-agent.service');
  assert.match(path, /^PathExists=\/run\/proxypilot-update\/request\.json$/m);
  assert.match(path, /^Unit=proxypilot-update\.service$/m);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=\/usr\/local\/sbin\/proxypilot-update-runner$/m);
  assert.match(service, /^KillMode=process$/m);
  assert.match(service, /^TimeoutStartSec=3600$/m);
  assert.doesNotMatch(service, /^User=/m, 'the runner is root: that is the point');
  assert.doesNotMatch(service, /^\[Install\]/m, 'only the path unit starts it');
  assert.match(agent, /^RuntimeDirectory=proxypilot-agent proxypilot-update$/m);
  assert.match(agent, /^NoNewPrivileges=true$/m);
  const runner = readFileSync(RUNNER, 'utf8');
  assert.match(runner, /\nmain "\$@"\n$/, 'main is the last line so bash parses the whole file before running');
  for (const f of [path, service, runner]) {
    assert.doesNotMatch(f, /claude|anthropic|openai|gpt/i, 'no model or vendor names in the runner or units');
  }
});
