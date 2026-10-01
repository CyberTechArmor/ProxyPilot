import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSelfEditHandlers } from '../routes/mcp-tools/self-edit.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LEGACY = readFileSync(new URL('./fixtures/pre-pinned-update.sh', import.meta.url));
assert.equal(createHash('sha1').update(`blob ${LEGACY.length}\0`).update(LEGACY).digest('hex'), '5ed35ad1f283ba0f4c880d095180225043ad5d81', 'genuine update.sh from pre-repair main 984a57b9');
const CONTRACT_FILES = ['update.sh', 'scripts/update-git.sh', 'scripts/update-runner.sh',
  'cmd/agent/methods/update.go', 'admin/backend/src/lib/self-update.js',
  'admin/backend/src/lib/self-update-logic.js', 'admin/backend/src/routes/mcp-tools/self-edit.js'];
function installContract(dir) {
  for (const file of CONTRACT_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), readFileSync(join(ROOT, file)));
  }
}

function setup(t, { legacyBase = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pp-self-pin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = join(root, 'live'), candidate = join(root, 'candidate'), state = join(root, 'state.json');
  mkdirSync(live);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid' };
  const git = (dir, ...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(live, 'init', '-q', '-b', 'main');
  writeFileSync(join(live, 'file'), 'base');
  if (legacyBase) writeFileSync(join(live, 'update.sh'), LEGACY);
  else installContract(live);
  git(live, 'add', '.'); git(live, 'commit', '-q', '-m', 'base');
  const base = git(live, 'rev-parse', 'HEAD');
  git(root, 'clone', '-q', live, candidate);
  git(candidate, 'checkout', '-q', '-b', 'candidate');
  if (legacyBase) installContract(candidate);
  writeFileSync(join(candidate, 'file'), 'candidate');
  git(candidate, 'add', '.'); git(candidate, 'commit', '-q', '-m', 'candidate');
  const head = git(candidate, 'rev-parse', 'HEAD');
  writeFileSync(state, JSON.stringify({ candidate: { base_sha: base }, checks: { sha: head, ok: true }, rollback_points: [] }));
  const requests = [], commands = [], plans = [], behavior = {};
  const kit = {
    ctx: {
      runHostCapture: async (command, argv) => {
        assert.equal(command, 'git'); commands.push(argv);
        if (behavior.failTag && argv.includes('tag')) return { status: 128, stdout: '', stderr: 'tag refused' };
        const r = spawnSync(command, argv, { encoding: 'utf8', env });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      },
      selfUpdateInstalled: async () => ({ reachable: true, configured: true, source_dir: live, branch: 'main', dirty: false }),
      selfUpdateStatus: async () => ({ status: 'idle' }),
      selfUpdateStart: async (options) => { requests.push(options); if (behavior.failRequest) throw new Error('request refused'); return { id: 'fixture-update' }; },
      SELF_UPDATE_POLICY: { enabled: true },
    },
    ok: (value) => value, err: (error) => ({ error }), mutation: (_name, _spec, fn) => fn, reader: (_name, fn) => fn,
    confirmToken: () => null, dry: (_args, plan) => { plans.push(plan); return null; }, tail: (s = '') => s,
    hostSh: async (_command, args) => ({ stdout: existsSync(join(args[0], '.git')) ? 'yes' : 'no' }),
    policy: { self_edit: { candidate_dir: candidate, state_file: state, candidate_branch: 'candidate', required_checks_for_promote: ['backend-tests'] } },
  };
  const handlers = createSelfEditHandlers(kit), auth = { created_by: 'fixture' };
  const call = (name, args = {}) => handlers[name](args, auth, {}, {});
  return { live, candidate, state, base, head, git, requests, commands, plans, behavior, call };
}

test('promotion and rollback request exact builds of their chosen commit', async (t) => {
  const s = setup(t);
  const promoted = await s.call('promote_self');
  assert.equal(promoted.promoted, true, promoted.error);
  assert.equal(s.git(s.live, 'rev-parse', 'HEAD'), s.head);
  assert.deepEqual(s.requests[0], { requestedBy: 'mcp-self:fixture', buildCurrentSha: s.head });
  assert.ok(s.plans.some(p => p.to_sha === s.head && p.then.includes('--build-current=' + s.head)));
  const rollback = await s.call('rollback_self');
  assert.equal(rollback.rolled_back, true, rollback.error);
  assert.equal(s.git(s.live, 'rev-parse', 'HEAD'), s.base);
  assert.deepEqual(s.requests[1], { requestedBy: 'mcp-self-rollback:fixture', buildCurrentSha: s.base });
  assert.ok(s.plans.some(p => p.to_sha === s.base && p.then.includes('--build-current=' + s.base)));
  assert.equal(s.commands.filter((a) => a.includes('merge')).length, 1);
  assert.ok(s.commands.some((a) => a.includes('merge') && a.at(-1) === s.head), 'promotion merges the immutable checked SHA');
});

test('failed tag or dirty lockfile stops rollback before reset or build request', async (t) => {
  const s = setup(t);
  await s.call('promote_self'); s.requests.length = 0; s.commands.length = 0;
  s.behavior.failTag = true;
  const refused = await s.call('rollback_self');
  assert.match(refused.error, /Could not tag/);
  assert.equal(s.git(s.live, 'rev-parse', 'HEAD'), s.head);
  assert.equal(s.requests.length, 0);
  assert.ok(!s.commands.some((a) => a.includes('reset')));
  s.behavior.failTag = false;
  writeFileSync(join(s.live, 'package-lock.json'), '{}');
  assert.match((await s.call('rollback_self')).error, /including lockfiles/);
  assert.equal(s.requests.length, 0);
});

test('refused rebuild restores the previous checkout and preserves a rollback tag', async (t) => {
  const s = setup(t); s.behavior.failRequest = true;
  assert.match((await s.call('promote_self')).error, /rebuild request was refused/);
  assert.equal(s.git(s.live, 'rev-parse', 'HEAD'), s.base);
  assert.match(s.git(s.live, 'tag', '--list'), /pp-rollback-/);
});

test('rollback across the repair boundary refuses a genuine legacy target before reset, tag or request', async (t) => {
  const s = setup(t, { legacyBase: true });
  assert.equal(s.git(s.live, 'rev-parse', 'HEAD:update.sh'), '5ed35ad1f283ba0f4c880d095180225043ad5d81');
  s.git(s.live, 'fetch', '-q', s.candidate, 'candidate');
  s.git(s.live, 'merge', '--ff-only', s.head); // simulate the reviewed first repair bootstrap
  writeFileSync(s.state, JSON.stringify({ rollback_points: [{ sha: s.base }] }));
  const before = readFileSync(s.state, 'utf8');
  const r = await s.call('rollback_self');
  assert.match(r.error, /does not declare the repaired exact-build contract/);
  assert.equal(s.git(s.live, 'rev-parse', 'HEAD'), s.head);
  assert.equal(s.git(s.live, 'tag', '--list'), '');
  assert.equal(readFileSync(s.state, 'utf8'), before);
  assert.equal(s.requests.length, 0, 'no root-runner or runtime request');
  assert.ok(!s.commands.some(a => a.includes('reset') || a.includes('tag') || a.includes('merge') || a.includes('fetch')));
});

test('promotion refuses a changed exact-build contract before changing live source', async (t) => {
  const s = setup(t);
  writeFileSync(join(s.candidate, 'update.sh'), '#!/bin/bash\n# ProxyPilot pinned-build contract: 1\nexit 0\n');
  s.git(s.candidate, 'add', '.'); s.git(s.candidate, 'commit', '-q', '-m', 'changed updater');
  const r = await s.call('promote_self');
  assert.match(r.error, /Exact-build contract differs at update.sh/);
  assert.equal(s.git(s.live, 'rev-parse', 'HEAD'), s.base);
  assert.equal(s.git(s.live, 'tag', '--list'), '');
  assert.equal(s.requests.length, 0);
});
