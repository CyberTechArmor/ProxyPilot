import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCleanupRequest, resolveSelection, selectionEstimate, scopeItemIds, snapshotItemIds, approvedRootsFor, pathAllowed,
  checkFreshness, SelectionError, NOTHING_SELECTED, ALL_ELIGIBLE_SCOPE_TEXT, REMOVAL_ORDER,
} from '../lib/app-storage/selection.js';

const NOW = Date.parse('2026-10-20T23:00:00Z');
const RELEASES = '/opt/nodus-releases';
const oldRelease = `${RELEASES}/${'6'.repeat(40)}-p6-11111111-1111-4111-8111-111111111111`;
const target = { key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus', profile: { sourceDir: '/opt/nodus', releaseRoot: RELEASES, preservePaths: ['/var/lib/nodus', '/opt/nodus/embed/models'], envFiles: ['/etc/nodus/nodus.env'] }, serviceHome: '/var/lib/nodus' };
const id = n => n.padEnd(16, '0');
const item = (over) => ({ precision: 'exact', location: 'guest', logicalBytes: 100, allocatedBytes: 50, identity: { dev: 1, ino: 2, mtimeMs: 3, size: 4 }, ...over });
function check(over = {}) {
  return {
    version: 1, checkId: 'chk-1', target: { key: 'application:1', kind: 'application', id: 1, name: 'Nodus', guest: 'pp-nodus' },
    origin: 'user', status: 'complete', startedAt: '2026-10-20T22:30:00Z', finishedAt: '2026-10-20T22:31:00Z',
    totals: { dataset: { snapshotsBytes: 900 } },
    items: [
      item({ id: id('a1'), category: 'releases', kind: 'release', path: oldRelease, status: 'eligible', action: 'remove-release', allocatedBytes: 4000, label: 'Old release' }),
      item({ id: id('a2'), category: 'temp', kind: 'group', path: null, status: 'eligible', action: 'remove', label: 'nodus-embed-* (2 folders)', memoryBacked: true, allocatedBytes: 10, members: [{ path: '/tmp/nodus-embed-a1b2', identity: { dev: 9, ino: 1 } }, { path: '/tmp/nodus-embed-c3d4', identity: { dev: 9, ino: 2 } }] }),
      item({ id: id('a3'), category: 'caches', kind: 'directory', path: '/root/.cache/ms-playwright', status: 'eligible', action: 'remove', allocatedBytes: 300 }),
      item({ id: id('a4'), category: 'logs', kind: 'journal', path: '/var/log/journal', status: 'eligible', action: 'vacuum-journal', allocatedBytes: 600, targetBytes: 256 * 1024 * 1024, recoverableBytes: 200 }),
      item({ id: id('a5'), category: 'running_app', kind: 'release', path: `${RELEASES}/live`, status: 'protected', action: null, reason: 'The release the application is running now.' }),
      item({ id: id('a6'), category: 'other', kind: 'directory', path: '/opt/nodus-w48', status: 'investigate', action: null, reason: 'Not created by ProxyPilot.' }),
      item({ id: id('a7'), category: 'history', kind: 'file', path: '/var/backups/proxypilot-db/app-pre-deploy-x.sql', status: 'eligible', action: 'remove', allocatedBytes: 70 }),
      item({ id: id('s1'), category: 'snapshots', kind: 'snapshot', path: null, name: 'snap-1', status: 'eligible', action: 'delete-snapshot', identity: { createdAt: '2026-10-01T12:00:00.123456789Z' }, allocatedBytes: 100 }),
      item({ id: id('s2'), category: 'snapshots', kind: 'snapshot', path: null, name: 'snap-2', status: 'eligible', action: 'delete-snapshot', identity: { createdAt: '2026-10-02T12:00:00Z' }, allocatedBytes: 200 }),
      item({ id: id('e1'), category: 'exports', kind: 'export', path: null, status: 'eligible', action: 'delete-export', identity: { exportId: 7, createdAt: '2026-10-03T00:00:00Z' }, allocatedBytes: 5000 }),
    ],
    ...over,
  };
}
const validate = (request, over = {}) => validateCleanupRequest({ check: check(), latest: check(), targetKey: 'application:1', now: NOW, request, ...over });
const rejects = (fn, code, status) => assert.throws(fn, err => { assert.ok(err instanceof SelectionError); assert.equal(err.code, code); assert.equal(err.status, status); return true; });

test('none: an empty selection changes nothing, whatever the check', () => {
  assert.deepEqual(validate({ items: [], snapshots: [], exports: [] }), { ok: true, empty: true, message: NOTHING_SELECTED });
  assert.deepEqual(validateCleanupRequest({ check: null, request: {}, now: NOW }), { ok: true, empty: true, message: NOTHING_SELECTED }, 'no check is needed to do nothing');
});

test('one: the stored entry is copied from the check, never from the request', () => {
  const v = validate({ items: [id('a3')] });
  const [entry] = resolveSelection(v);
  assert.equal(entry.path, '/root/.cache/ms-playwright');
  assert.deepEqual(entry.identity, { dev: 1, ino: 2, mtimeMs: 3, size: 4 });
  assert.equal(entry.action, 'remove'); assert.equal(entry.location, 'guest');
  const tampered = validate({ items: [id('a3')], paths: ['/etc'] });
  assert.equal(resolveSelection(tampered)[0].path, '/root/.cache/ms-playwright');
});

test('several: files come out data-farthest first, then snapshots, then exports', () => {
  const v = validate({ items: [id('a1'), id('a7'), id('a3'), id('a2'), id('a4')], snapshots: [id('s1')], exports: [id('e1')], acknowledgeSnapshotLoss: true });
  const order = resolveSelection(v).map(e => e.category);
  assert.deepEqual(order, ['temp', 'caches', 'logs', 'history', 'releases', 'snapshots', 'exports']);
  assert.deepEqual(REMOVAL_ORDER.slice(0, 2), ['temp', 'caches']);
  const group = resolveSelection(v)[0];
  assert.deepEqual(group.members.map(m => m.path), ['/tmp/nodus-embed-a1b2', '/tmp/nodus-embed-c3d4']);
});

test('categories and all-eligible scopes never include snapshots or exports', () => {
  assert.deepEqual(scopeItemIds(check(), { scope: 'categories', categories: ['temp', 'caches', 'snapshots', 'exports'] }), [id('a2'), id('a3')]);
  const all = scopeItemIds(check(), { scope: 'all-eligible' });
  assert.deepEqual(all, [id('a1'), id('a2'), id('a3'), id('a4'), id('a7')]);
  assert.ok(!all.includes(id('s1')) && !all.includes(id('e1')));
  assert.match(ALL_ELIGIBLE_SCOPE_TEXT, /every category except Snapshots and Exports/);
  assert.deepEqual(snapshotItemIds(check()), [id('s1'), id('s2')]);
  const v = validate({ items: all, scope: 'all-eligible' });
  assert.equal(v.scope, 'all-eligible');
  assert.equal(v.snapshots.length, 0);
});

test('deselect: an id the client dropped after review is simply absent', () => {
  const all = scopeItemIds(check(), { scope: 'all-eligible' });
  const v = validate({ items: all.filter(x => x !== id('a1')), scope: 'all-eligible' });
  assert.equal(resolveSelection(v).some(e => e.id === id('a1')), false);
  assert.equal(resolveSelection(v).length, all.length - 1);
});

test('a stale, superseded, unfinished, foreign or missing check is refused with CHECK_STALE', () => {
  rejects(() => validate({ items: [id('a3')] }, { now: NOW + 61 * 60 * 1000 }), 'CHECK_STALE', 409);
  try { validate({ items: [id('a3')] }, { now: NOW + 61 * 60 * 1000 }); } catch (e) { assert.match(e.message, /Run a new storage check first; this one is from 2026-10-20T22:31:00Z\./); }
  rejects(() => validate({ items: [id('a3')] }, { latest: check({ checkId: 'chk-2' }) }), 'CHECK_STALE', 409);
  rejects(() => validate({ items: [id('a3')] }, { check: check({ status: 'running' }), latest: null }), 'CHECK_STALE', 409);
  rejects(() => validate({ items: [id('a3')] }, { check: check({ status: 'failed' }), latest: null }), 'CHECK_STALE', 409);
  rejects(() => validate({ items: [id('a3')] }, { targetKey: 'application:2' }), 'CHECK_STALE', 409);
  rejects(() => validate({ items: [id('a3')] }, { check: null }), 'CHECK_STALE', 409);
  assert.equal(checkFreshness({ check: check({ status: 'partial' }), latest: check({ status: 'partial' }), now: NOW }), null, 'a partial check may be acted on');
});

test('protected, needs-a-look, unknown and wrong-list ids are refused with NOT_ELIGIBLE and their reasons', () => {
  let error;
  try { validate({ items: [id('a5'), id('a6'), 'ffffffffffffffff', id('s1')], snapshots: [id('a3')], exports: [id('s2')], acknowledgeSnapshotLoss: true }); } catch (e) { error = e; }
  assert.equal(error.code, 'NOT_ELIGIBLE'); assert.equal(error.status, 409);
  const reasons = Object.fromEntries(error.details.items.map(x => [x.id, x.reason]));
  assert.match(reasons[id('a5')], /Not eligible: The release the application is running now/);
  assert.match(reasons[id('a6')], /Not eligible: Not created by ProxyPilot/);
  assert.equal(reasons.ffffffffffffffff, 'Not part of this storage check.');
  assert.match(reasons[id('s1')], /selected separately/);
  assert.match(reasons[id('a3')], /Only restore points/);
  assert.match(reasons[id('s2')], /Only downloadable copies/);
  rejects(() => validate({ items: [id('a3'), id('a5')] }), 'NOT_ELIGIBLE', 409);
});

test('snapshots require the explicit acknowledgement', () => {
  rejects(() => validate({ snapshots: [id('s1')] }), 'SNAPSHOT_ACK_REQUIRED', 400);
  rejects(() => validate({ items: [id('a3')], snapshots: [id('s1')], acknowledgeSnapshotLoss: false }), 'SNAPSHOT_ACK_REQUIRED', 400);
  const v = validate({ snapshots: [id('s1')], acknowledgeSnapshotLoss: true });
  assert.equal(resolveSelection(v)[0].name, 'snap-1');
  assert.equal(resolveSelection(v)[0].identity.createdAt, '2026-10-01T12:00:00.123456789Z');
  assert.equal(validate({ exports: [id('e1')] }).exports.length, 1, 'exports need no snapshot acknowledgement');
});

test('malformed requests are refused before anything is looked up', () => {
  rejects(() => validate({ items: 'all' }), 'INVALID_REQUEST', 400);
  rejects(() => validate({ items: [{ id: 'x' }] }), 'INVALID_REQUEST', 400);
  rejects(() => validate({ items: ['../etc'] }), 'INVALID_REQUEST', 400);
  rejects(() => validate({ items: [id('a3')], scope: 'everything' }), 'INVALID_REQUEST', 400);
  rejects(() => validate({ snapshots: [id('s1')], acknowledgeSnapshotLoss: 'yes' }), 'INVALID_REQUEST', 400);
});

test('the estimate dedupes, keeps memory apart, and says when snapshots still hold space', () => {
  const v = validate({ items: [id('a3'), id('a3'), id('a2'), id('a4')] });
  const est = selectionEstimate(resolveSelection(v), check());
  assert.equal(est.diskBytes, 300 + 200); assert.equal(est.memoryBytes, 10); assert.equal(est.precision, 'estimate');
  assert.ok(est.notes.some(n => /only returned after those snapshots are deleted/.test(n)));
  assert.ok(est.notes.some(n => /memory, not disk/.test(n)));
  const all = selectionEstimate(resolveSelection(validate({ snapshots: [id('s1'), id('s2')], acknowledgeSnapshotLoss: true })), check());
  assert.equal(all.snapshotBytes, 900, 'all snapshots selected: about the dataset snapshot total');
  const one = selectionEstimate(resolveSelection(validate({ snapshots: [id('s1')], acknowledgeSnapshotLoss: true })), check());
  assert.equal(one.snapshotBytes, 100);
});

test('approved roots follow the category; paths outside them, inside data, or of the wrong name are refused', () => {
  assert.deepEqual(approvedRootsFor({ category: 'temp' }, target), ['/tmp', '/var/tmp']);
  assert.deepEqual(approvedRootsFor({ category: 'releases', action: 'remove-release' }, target), [RELEASES]);
  assert.deepEqual(approvedRootsFor({ category: 'workspaces' }, target), [`${RELEASES}/.staging`]);
  assert.deepEqual(approvedRootsFor({ category: 'archives', location: 'host' }, target), ['/var/lib/proxypilot/application-release-transfers']);
  assert.deepEqual(approvedRootsFor({ category: 'data' }, target), []);
  assert.deepEqual(approvedRootsFor({ category: 'snapshots' }, target), []);
  const ok = (it) => assert.equal(pathAllowed(it, target).ok, true, JSON.stringify(it));
  const no = (it, re) => { const r = pathAllowed(it, target); assert.equal(r.ok, false, JSON.stringify(it)); if (re) assert.match(r.reason, re); };
  ok({ category: 'temp', path: '/tmp/playwright-download-x' });
  ok({ category: 'temp', kind: 'group', members: [{ path: '/tmp/a' }, { path: '/var/tmp/b' }] });
  no({ category: 'temp', kind: 'group', members: [{ path: '/tmp/a' }, { path: '/etc/b' }] }, /Outside/);
  no({ category: 'temp', path: '/tmp' }, /Outside/);
  no({ category: 'temp', path: '/tmp/a/b' }, /Outside/);
  no({ category: 'temp', path: '/tmp/../etc' }, /usable location/);
  ok({ category: 'releases', action: 'remove-release', path: oldRelease });
  no({ category: 'releases', action: 'remove-release', path: `${RELEASES}/adopted-c5adcdaf` }, /Outside/);
  no({ category: 'releases', action: 'remove-release', path: `/opt/${'6'.repeat(40)}-p6-11111111-1111-4111-8111-111111111111` }, /Outside/);
  ok({ category: 'workspaces', path: `${RELEASES}/.staging/11111111-1111-4111-8111-111111111111-1` });
  no({ category: 'workspaces', path: `${RELEASES}/.staging/operator-note` }, /Outside/);
  ok({ category: 'history', path: '/etc/environment.pre-abc' });
  ok({ category: 'history', path: '/etc/systemd/system/nodus.service.pre-abc' });
  no({ category: 'history', path: '/etc/passwd' }, /Outside/);
  ok({ category: 'logs', path: '/var/log/postgresql/postgresql-17-main.log.1' });
  no({ category: 'logs', path: '/var/log/journal/abc/system.journal' }, /Outside/);
  ok({ category: 'caches', path: '/var/lib/nodus/.npm/_cacache' });
  ok({ category: 'caches', path: '/home/alice/.cache/pip' });
  no({ category: 'caches', path: '/var/lib/nodus/handoff' }, /Outside/);
  const withData = { ...target, profile: { ...target.profile, preservePaths: ['/tmp/x/models'] } };
  assert.match(pathAllowed({ category: 'temp', path: '/tmp/x' }, withData).reason, /Contains data/);
  const project = { key: 'project:4', kind: 'project', id: 4, guest: 'm2-4' };
  assert.equal(pathAllowed({ category: 'test_reports', path: '/srv/app/test-results' }, project).ok, true);
  assert.equal(pathAllowed({ category: 'test_reports', path: '/srv/app/src' }, project).ok, false);
  assert.equal(pathAllowed({ category: 'test_reports', path: '/srv/app/.mock2/evidence/run-1.json' }, project).ok, true);
  assert.equal(pathAllowed({ category: 'caches', path: '/srv/app/.mock2/cache' }, project).ok, true);
  assert.equal(pathAllowed({ category: 'test_reports', path: `${RELEASES}/x/test-results` }, target).ok, false, 'never inside a sealed release');
  assert.equal(pathAllowed({ category: 'test_reports', path: '/opt/nodus-w48/test-results' }, target).ok, true);
});
