// Fixture API for the Application storage pages: one stateful handler for
// every /api/** call the real app makes on those pages, built from
// fixtures/app-storage-fixture.mjs (DESIGN §2.6 / §6 shapes). The browser
// journey (app-storage.browser.mjs) serves it through page.route; the
// Lighthouse check (app-storage-lighthouse.mjs) through a vite middleware.
// It records every write so the journey can assert exactly what was sent.

import {
  CHECK_ID, CLEANUP_ID, NEW_CHECK_ID, NODUS_KEY, PROJECT_KEY,
  cleanupResult, cleanupRunning, nodusCheck, nodusPolicy, overview, policyResponse, targetDetail,
} from './fixtures/app-storage-fixture.mjs';

export const USER = { id: 'storage-admin', username: 'admin', role: 'admin', permissions: [] };

export function createWorld(now = Date.now(), { noCheck = false, sharedHost = false } = {}) {
  const state = {
    now,
    latestCheck: noCheck ? null : nodusCheck(now, { sharedHost }),
    checkRequests: [],     // { key }
    checkPolls: new Map(), // checkId -> polls answered
    checkTargets: new Map(),
    projectChecked: false,
    cleanupAttempts: 0,    // POSTs, including the one answered with the sudo prompt
    cleanupPosts: [],      // accepted bodies { body, csrf }
    cleanupPolls: 0,
    cleanups: [],
    sudoArmed: true,
    sudoPosts: 0,
    policy: nodusPolicy(),
    revision: 1,
    source: 'preserved',
    proposedRules: ['caches', 'tempFiles', 'testArtifacts', 'logs', 'history'],
    policyUpdatedAt: null,
    policyUpdatedBy: null,
    policyPuts: [],
    unexpected: [],
  };

  const json = (status, body) => ({ status, body });

  function handle(method, url, body, headers = {}) {
    const u = new URL(url, 'http://fixture');
    const p = u.pathname;
    const t = Date.now();
    if (p === '/api/auth/verify') return json(200, { user: USER });
    if (p === '/api/user/profile') return json(200, { user: { ...USER, hasPasskey: false } });
    if (p === '/api/auth/sso/session') return json(200, { canReauthenticate: false });
    if (p === '/api/auth/sudo' && method === 'POST') { state.sudoPosts += 1; return json(200, { ok: true, sudo_until: new Date(t + 300000).toISOString() }); }
    if (p === '/api/notifications') return json(200, { notifications: [], unread_count: 0 });
    if (p === '/api/notifications/unread-count') return json(200, { count: 0, unread_count: 0 });
    if (p === '/api/mock2/status') return json(404, { error: 'disabled' });
    if (p === '/api/user/version') return json(200, { version: 'browser-test' });
    if (p === '/api/user/version/check') return json(200, { updateAvailable: false });

    if (!p.startsWith('/api/app-storage/')) return json(200, {});

    if (p === '/api/app-storage/overview' && method === 'GET') {
      const o = overview(state.now);
      if (state.projectChecked) {
        const row = o.targets.find((x) => x.key === PROJECT_KEY);
        row.lastCheck = { checkId: 'chk_project', finishedAt: new Date(t - 1000).toISOString(), status: 'complete', totals: { guest: { usedBytes: 21.3e9 } }, eligibleBytes: 6.4e9 };
      }
      return json(200, o);
    }
    let m = /^\/api\/app-storage\/targets\/(application|project)\/(\d+)(\/checks|\/cleanups|\/policy)?$/.exec(p);
    if (m) {
      const key = `${m[1]}:${m[2]}`;
      const sub = m[3] || '';
      if (sub === '/checks' && method === 'POST') {
        const checkId = key === NODUS_KEY ? NEW_CHECK_ID : `chk_${m[1]}-${m[2]}-${state.checkRequests.length}`;
        state.checkRequests.push({ key, csrf: headers['x-csrf-token'] });
        state.checkPolls.set(checkId, 0);
        state.checkTargets.set(checkId, key);
        return json(202, { checkId, status: 'running', reused: false });
      }
      if (sub === '/cleanups' && method === 'POST') {
        state.cleanupAttempts += 1;
        if (state.sudoArmed) { state.sudoArmed = false; return json(401, { error: 'sudo_required', sudo_required: true }); }
        state.cleanupPosts.push({ body, csrf: headers['x-csrf-token'] });
        const items = [...(body.items || []), ...(body.snapshots || []), ...(body.exports || [])];
        if (!items.length) return json(200, { changed: false, message: 'Nothing was selected, so nothing was changed.' });
        state.cleanupPolls = 0;
        state.cleanups = [{ id: CLEANUP_ID, status: 'queued', origin: 'user', scope: body.scope, createdAt: new Date(t).toISOString() }];
        return json(200, { changed: true, cleanupId: CLEANUP_ID, jobId: 'job-cleanup-1', estimate: { bytes: 0 } });
      }
      if (sub === '/policy' && method === 'GET') return json(200, { ...policyResponse({ policy: state.policy, revision: state.revision, source: state.source, updatedAt: state.policyUpdatedAt, updatedBy: state.policyUpdatedBy, updatedByName: state.policyUpdatedBy != null ? 'admin' : null, checkId: state.latestCheck?.checkId ?? null }), proposedRules: state.proposedRules });
      if (sub === '/policy' && method === 'PUT') {
        state.policyPuts.push({ body, csrf: headers['x-csrf-token'] });
        if (body.expectedRevision !== state.revision) return json(409, { error: { code: 'POLICY_REVISION_CONFLICT', message: 'The rules changed.' } });
        state.policy = body.policy;
        state.revision += 1;
        state.source = 'edited';
        state.policyUpdatedAt = new Date(t).toISOString();
        state.policyUpdatedBy = '1';
        state.proposedRules = state.proposedRules.filter((r) => !body.policy.rules[r]?.enabled);
        return json(200, { policy: state.policy, revision: state.revision });
      }
      if (sub === '' && method === 'GET') {
        if (key !== NODUS_KEY) return json(404, { error: { code: 'TARGET_NOT_FOUND', message: 'This application was not found.' } });
        return json(200, targetDetail(state.now, { check: state.latestCheck, cleanups: state.cleanups }));
      }
    }
    m = /^\/api\/app-storage\/checks\/([A-Za-z0-9_:-]+)$/.exec(p);
    if (m && method === 'GET') {
      const id = m[1];
      if (id === CHECK_ID) return json(200, state.latestCheck);
      const polls = state.checkPolls.get(id) ?? 0;
      state.checkPolls.set(id, polls + 1);
      const key = state.checkTargets.get(id);
      if (polls < 1) return json(200, { checkId: id, status: 'running', startedAt: new Date(t).toISOString(), target: { key } });
      if (key === NODUS_KEY) { state.latestCheck = nodusCheck(t, { checkId: id, ageMs: 0 }); return json(200, state.latestCheck); }
      if (key === PROJECT_KEY) state.projectChecked = true;
      return json(200, { checkId: id, status: 'complete', target: { key }, finishedAt: new Date(t).toISOString() });
    }
    m = /^\/api\/app-storage\/cleanups\/([A-Za-z0-9_-]+)$/.exec(p);
    if (m && method === 'GET') {
      const last = state.cleanupPosts.at(-1)?.body || { items: [], snapshots: [], exports: [], scope: 'items' };
      state.cleanupPolls += 1;
      if (state.cleanupPolls < 2) return json(200, cleanupRunning(t));
      const done = cleanupResult(state.latestCheck, last, t);
      state.cleanups = [{ id: done.id, status: done.status, origin: 'user', scope: done.scope, createdAt: done.createdAt, finishedAt: done.finishedAt, result: done.result }];
      return json(200, done);
    }
    state.unexpected.push(`${method} ${p}`);
    return json(404, { error: { code: 'NOT_FOUND', message: `Unexpected ${method} ${p}` } });
  }

  return { state, handle };
}
