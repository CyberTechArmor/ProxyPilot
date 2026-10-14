import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfGitHandlers } from '../routes/mcp-tools/self-git.js';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
async function fixture(t, { dirty = false, changed = false, failFetch = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pp-self-git-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = []; let liveReads = 0, switched = false;
  const statePath = join(dir, 'state.json');
  await writeFile(statePath, JSON.stringify({ candidate: { head_sha: BASE }, checks: { sha: BASE, ok: true }, promotions: [{ to_sha: BASE }] }));
  const fn = (name, options, run) => args => run(args, { created_by: 'test' }, null, {});
  const kit = {
    mutation: fn, ok: data => data, err: error => ({ error }), dry: (args, preview) => args.dry_run ? { dry_run: true, preview } : null,
    policy: { self_edit: { candidate_dir: join(dir, 'candidate'), state_file: statePath, candidate_branch: 'pp-candidate' } },
    ctx: {
      selfUpdateInstalled: async () => ({ reachable: true, configured: true, source_dir: '/live' }),
      selfUpdateStatus: async () => ({ status: 'idle' }),
      runHostCapture: async (bin, argv) => {
        const path = argv[3], args = argv.slice(4); calls.push({ path, args });
        let stdout = '';
        if (args[0] === 'rev-parse') {
          if (args[1] === '--git-dir') stdout = '.git';
          else if (args[1] === 'FETCH_HEAD^{commit}') stdout = HEAD;
          else if (path === '/live') stdout = changed && ++liveReads > 1 ? HEAD : BASE;
          else stdout = switched ? HEAD : BASE;
        }
        if (args[0] === 'status') stdout = dirty ? ' M tracked.js' : '';
        if (args[0] === 'remote') stdout = 'https://github.com/example/proxypilot.git';
        if (args[0] === 'checkout') switched = true;
        return { status: failFetch && args[0] === 'fetch' ? 1 : 0, stdout, stderr: '' };
      },
    },
  };
  return { run: createSelfGitHandlers(kit).prepare_self_from_git, calls, statePath };
}
test('remote preparation previews without fetching or changing state', async t => {
  const f = await fixture(t);
  const r = await f.run({ sha: HEAD, expected_live_sha: BASE, dry_run: true });
  assert.equal(r.dry_run, true);
  assert.ok(!f.calls.some(c => ['fetch', 'checkout', 'update-ref'].includes(c.args[0])));
});
test('preparation preserves the old ref and evidence, stages exact SHA and invalidates checks', async t => {
  const f = await fixture(t);
  const r = await f.run({ sha: HEAD, expected_live_sha: BASE, confirm: true });
  assert.equal(r.prepared, true);
  assert.ok(f.calls.some(c => c.args[0] === 'update-ref' && c.args[2] === BASE));
  assert.ok(f.calls.some(c => c.args[0] === 'merge-base' && c.args[2] === BASE && c.args[3] === HEAD));
  assert.ok(!f.calls.some(c => c.path === '/live' && c.args[0] !== 'rev-parse' && c.args[0] !== 'status' && c.args[0] !== 'remote'));
  const state = JSON.parse(await readFile(f.statePath));
  assert.equal(state.candidate.head_sha, HEAD);
  assert.equal(state.candidate.base_sha, BASE);
  assert.equal(state.checks, null);
  assert.equal(state.promotions.length, 1);
  assert.equal(state.candidate_history[0].candidate.head_sha, BASE);
});
test('dirty or stale live source refuses before writes, and fetch failure does not switch', async t => {
  for (const mode of [{ dirty: true }, { changed: true }, { failFetch: true }]) {
    const f = await fixture(t, mode);
    try { await f.run({ sha: HEAD, expected_live_sha: BASE, confirm: true }); } catch { /* wrapper converts to tool error */ }
    assert.ok(!f.calls.some(c => c.args[0] === 'checkout'));
    assert.equal(JSON.parse(await readFile(f.statePath)).checks.ok, true);
  }
});
