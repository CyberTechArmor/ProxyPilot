// lib/self-update.js against an in-process agent stub (the agent.test.js
// pattern) and a stub fetch. What matters: an unreachable agent or a failing
// network is a FIELD in the answer, never a throw; the log/state fallback to
// the host file works while the agent restarts; the flag allowlist holds
// before anything reaches the agent; the check cache behaves.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  installedState, updateStatus, startUpdate, checkForUpdates, clearUpdateCheckCache,
  fetchLatestFromGitHub, fetchStandardsManifest, noteCompletedUpdateOnBoot, readStandardsSeedVersion,
} from '../lib/self-update.js';
import { agentCall } from '../lib/agent.js';

const ID = '11111111-2222-4333-8444-555555555555';

function startStubAgent(socketPath, handler) {
  const server = net.createServer((conn) => {
    let buf = Buffer.alloc(0);
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const req = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      conn.end(JSON.stringify(handler(req)) + '\n');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

// A `call` bound to the stub socket, so the driver's default agentCall path
// (params, timeouts, error mapping) is what runs.
async function withAgent(handler, run) {
  const dir = await mkdtemp(join(tmpdir(), 'pp-self-update-'));
  const socketPath = join(dir, 'agent.sock');
  const server = await startStubAgent(socketPath, handler);
  const call = (method, params, opts = {}) => agentCall(method, params, { ...opts, socketPath });
  try {
    await run(call, dir);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const deadCall = () => agentCall('x', {}, { socketPath: '/nonexistent/pp-agent.sock', timeoutMs: 500 });

test('installedState: facts from the agent; transport failure → reachable:false, never a throw', async () => {
  clearUpdateCheckCache();
  await withAgent((req) => ({ id: req.id, result: { configured: true, fresh: true, branch: 'main', head_sha: 'abc123', dirty: false, agent_version: 'v1' } }), async (call) => {
    const inst = await installedState({ call, force: true });
    assert.equal(inst.reachable, true);
    assert.equal(inst.sha, 'abc123');
    assert.equal(inst.branch, 'main');
    assert.equal(inst.agent_version, 'v1');
  });
  const down = await installedState({ call: deadCall, force: true });
  assert.equal(down.reachable, false);
  assert.match(down.error, /agent_unreachable/);
  await withAgent((req) => ({ id: req.id, error: { code: 'method_not_found', message: 'old agent' } }), async (call) => {
    const inst = await installedState({ call, force: true });
    assert.equal(inst.reachable, false);
    assert.match(inst.error, /method_not_found: old agent/);
  });
});

test('installedState caches reachable facts for a minute unless forced', async () => {
  clearUpdateCheckCache();
  let calls = 0;
  const call = async () => { calls++; return { configured: true, head_sha: `sha${calls}` }; };
  let t = 1_000_000;
  const now = () => t;
  assert.equal((await installedState({ call, now })).sha, 'sha1');
  assert.equal((await installedState({ call, now })).sha, 'sha1');
  assert.equal(calls, 1);
  assert.equal((await installedState({ call, now, force: true })).sha, 'sha2');
  t += 61_000;
  assert.equal((await installedState({ call, now })).sha, 'sha3');
  clearUpdateCheckCache();
});

test('updateStatus: agent answer → progress; agent down → host file; nothing → idle', async () => {
  await withAgent((req) => {
    assert.equal(req.method, 'update.status');
    assert.equal(req.params.id, ID);
    assert.equal(req.params.log_tail_bytes, 2048);
    return { id: req.id, result: { id: ID, status: 'running', phase: 'Pulling latest code', phase_index: 2, log_tail: '\x1b[34m[2/7] Pulling\x1b[0m', id_match: true, pending: false } };
  }, async (call) => {
    const p = await updateStatus({ id: ID, logTailBytes: 2048, call });
    assert.equal(p.agent.reachable, true);
    assert.equal(p.status, 'running');
    assert.equal(p.log_tail, '[2/7] Pulling');
    assert.equal(p.phases.find((x) => x.index === 2).state, 'active');
  });
  const fromFile = await updateStatus({ id: ID, call: deadCall, readState: async ({ id }) => ({ id, status: 'success', finished_at: '2026-09-05T00:00:00Z', log_tail: 'done', pending: false, id_match: true }) });
  assert.equal(fromFile.agent.reachable, false);
  assert.equal(fromFile.agent.source, 'file');
  assert.equal(fromFile.status, 'success');
  assert.equal(fromFile.log_tail, 'done');
  assert.match(fromFile.agent.error, /agent_unreachable/);
  const enoent = Object.assign(new Error('no state'), { code: 'ENOENT' });
  const idle = await updateStatus({ call: deadCall, readState: async () => { throw enoent; } });
  assert.equal(idle.status, 'idle');
  assert.equal(idle.agent.reachable, false);
  assert.equal(idle.agent.source, null);
});

test('startUpdate: allowlist before the wire; agent codes surface as .code', async () => {
  await assert.rejects(startUpdate({ requestedBy: 'admin', flags: ['--discard-local'], call: async () => { throw new Error('must not be called'); } }), (e) => e.code === 'invalid_params');
  await withAgent((req) => {
    assert.equal(req.method, 'update.request');
    assert.deepEqual(req.params, { requested_by: 'Thomas_van_Dijk', flags: ['--rebuild'] });
    return { id: req.id, result: { id: ID, requested_at: '2026-09-05T00:00:00Z', flags: '--rebuild', state_path: '/s', log_path: '/l' } };
  }, async (call) => {
    const r = await startUpdate({ requestedBy: 'Thomas van Dijk', rebuild: true, call });
    assert.equal(r.id, ID);
    assert.equal(r.flags, '--rebuild');
    assert.equal(r.log_path, '/l');
  });
  await withAgent((req) => ({ id: req.id, error: { code: 'update_in_progress', message: 'update x is running (Pulling)' } }), async (call) => {
    await assert.rejects(startUpdate({ requestedBy: 'admin', call }), (e) => e.code === 'update_in_progress' && /Pulling/.test(e.message));
  });
  await assert.rejects(startUpdate({ requestedBy: 'admin', call: deadCall }), (e) => e.code === 'agent_unreachable');
});

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [pattern, resp] of routes) {
      if (url.includes(pattern)) {
        if (resp instanceof Error) throw resp;
        const status = resp.status || 200;
        return { ok: status >= 200 && status < 300, status, json: async () => resp.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test('fetchLatestFromGitHub: release + commit + compare; 404 release → package.json; failures are fields', async () => {
  const { fetchImpl, calls } = stubFetch([
    ['/releases/latest', { body: { tag_name: 'v1.5.0', html_url: 'https://gh/rel', body: 'notes', published_at: '2026-09-01T00:00:00Z' } }],
    ['/commits/main', { body: { sha: 'newsha', commit: { committer: { date: '2026-09-04T00:00:00Z' }, message: 'subject\n\nbody' } } }],
    ['/compare/oldsha...main', { body: { ahead_by: 4 } }],
  ]);
  const r = await fetchLatestFromGitHub({ repo: 'o/r', installedSha: 'oldsha', fetchImpl });
  assert.equal(r.release.version, '1.5.0');
  assert.equal(r.release.tag, 'v1.5.0');
  assert.equal(r.mainCommit.sha, 'newsha');
  assert.equal(r.mainCommit.message, 'subject');
  assert.equal(r.commitsBehind, 4);
  assert.equal(r.error, null);
  assert.equal(calls.length, 3);

  const noRel = stubFetch([
    ['/releases/latest', { status: 404, body: {} }],
    ['raw.githubusercontent.com/o/r/main/admin/backend/package.json', { body: { version: '1.4.2' } }],
    ['/commits/main', { body: { sha: 'oldsha', commit: {} } }],
  ]);
  const r2 = await fetchLatestFromGitHub({ repo: 'o/r', installedSha: 'oldsha', fetchImpl: noRel.fetchImpl });
  assert.equal(r2.release, null);
  assert.equal(r2.fallbackVersion, '1.4.2');
  assert.equal(r2.commitsBehind, 0, 'same sha → 0 behind without a compare call');
  assert.ok(!noRel.calls.some((u) => u.includes('/compare/')));

  const broken = stubFetch([['api.github.com', new Error('ENOTFOUND api.github.com')]]);
  const r3 = await fetchLatestFromGitHub({ repo: 'o/r', fetchImpl: broken.fetchImpl });
  assert.equal(r3.release, null);
  assert.equal(r3.mainCommit, null);
  assert.match(r3.error, /ENOTFOUND/);
  assert.match((await fetchLatestFromGitHub({ repo: '', fetchImpl: broken.fetchImpl })).error, /no GitHub repository/);
});

test('fetchStandardsManifest is best-effort', async () => {
  const ok = stubFetch([['manifest.json', { body: { version: '0.4.0', changelog: [{ version: '0.4.0' }] } }]]);
  assert.deepEqual(await fetchStandardsManifest({ fetchImpl: ok.fetchImpl }), { site_version: '0.4.0', changelog: [{ version: '0.4.0' }], error: null });
  const down = stubFetch([['manifest.json', new Error('timeout')]]);
  const r = await fetchStandardsManifest({ fetchImpl: down.fetchImpl });
  assert.equal(r.site_version, null);
  assert.match(r.error, /timeout/);
  const seed = readStandardsSeedVersion();
  assert.match(seed.version, /^\d+\.\d+\.\d+$/);
  assert.equal(seed.manifest, 'https://mock2.fractionate.ai/manifest.json');
});

test('checkForUpdates: composes, caches network results for 10 min, force bypasses, agent down is a field', async () => {
  clearUpdateCheckCache();
  const { fetchImpl, calls } = stubFetch([
    ['/releases/latest', { body: { tag_name: 'v1.5.0', html_url: 'https://gh/rel', body: null } }],
    ['/commits/main', { body: { sha: 'newsha', commit: { committer: { date: '2026-09-04T00:00:00Z' } } } }],
    ['/compare/', { body: { ahead_by: 2 } }],
    ['manifest.json', { body: { version: '0.4.0' } }],
  ]);
  let t = 1_000_000;
  const now = () => t;
  await withAgent((req) => ({ id: req.id, result: { configured: true, branch: 'main', head_sha: 'oldsha', dirty: false } }), async (call) => {
    const a = await checkForUpdates({ repo: 'o/r', currentVersion: '1.4.0', fetchImpl, call, now });
    assert.equal(a.updateAvailable, true);
    assert.equal(a.latestVersion, '1.5.0');
    assert.equal(a.commits_behind, 2);
    assert.equal(a.standards.update_available, true);
    assert.equal(a.installed.sha, 'oldsha');
    assert.equal(a.canUpdate, true);
    assert.equal(a.cached, false);
    const n = calls.length;
    t += 60_000;
    const b = await checkForUpdates({ repo: 'o/r', currentVersion: '1.4.0', fetchImpl, call, now });
    assert.equal(b.cached, true);
    assert.equal(calls.length, n, 'cache hit → no network');
    const c = await checkForUpdates({ repo: 'o/r', currentVersion: '1.4.0', force: true, fetchImpl, call, now });
    assert.equal(c.cached, false);
    assert.ok(calls.length > n, 'force → network');
    t += 11 * 60_000;
    const d = await checkForUpdates({ repo: 'o/r', currentVersion: '1.4.0', fetchImpl, call, now });
    assert.equal(d.cached, false, 'TTL expired');
  });
  clearUpdateCheckCache();
  const down = await checkForUpdates({ repo: 'o/r', currentVersion: '1.4.0', fetchImpl, call: deadCall, now });
  assert.equal(down.agent.reachable, false);
  assert.equal(down.canUpdate, false);
  assert.equal(down.latestVersion, '1.5.0', 'GitHub still answers when the agent is down');
  clearUpdateCheckCache();
});

test('noteCompletedUpdateOnBoot audits a fresh success once and clears the dismissal', async () => {
  const finished = new Date(Date.now() - 5 * 60_000).toISOString();
  const settings = { update_dismissed: 'true', dismissed_version: '1.5.0' };
  const audits = [];
  const deps = {
    getSetting: (k) => settings[k] ?? null,
    setSetting: (k, v) => { settings[k] = v; },
    logAudit: (...a) => audits.push(a),
  };
  await withAgent((req) => ({ id: req.id, result: { id: ID, status: 'success', finished_at: finished, from_sha: 'a', to_sha: 'b', from_version: '1.4.0', to_version: '1.5.0', requested_by: 'admin', flags: '' } }), async (call) => {
    const r = await noteCompletedUpdateOnBoot({ ...deps, call });
    assert.equal(r.id, ID);
    assert.equal(audits.length, 1);
    assert.equal(audits[0][1], 'SELF_UPDATE_COMPLETED');
    assert.equal(audits[0][3], ID);
    assert.equal(settings.last_update_id, ID);
    assert.equal(settings.last_update_version, '1.5.0');
    assert.equal(settings.update_dismissed, 'false');
    // Second boot: already recorded.
    assert.equal(await noteCompletedUpdateOnBoot({ ...deps, call }), null);
    assert.equal(audits.length, 1);
  });
  // Agent down and no state file: nothing to record, no throw.
  const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
  assert.equal(await noteCompletedUpdateOnBoot({ ...deps, call: deadCall, readState: async () => { throw enoent; } }), null);
});
