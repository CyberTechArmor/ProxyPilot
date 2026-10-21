// Application storage targets: applications and Dev Studio projects, one key
// format, and what is happening on each guest now (jobs, leases, builds).

import test from 'node:test';
import assert from 'node:assert/strict';
import { listTargets, resolveTarget, activityFor, parseTargetKey, guestBusy } from '../lib/app-storage/targets.js';
import { databases, registerNodus, buildNodusGuest, makeRoot, cleanupRoot, addDeployHistory, DEPLOY_HISTORY } from './helpers/app-storage-world.js';

const NOW = Date.parse('2026-10-20T23:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function job(mainDb, { id, kind, app, status = 'running', epoch = 1 }) {
  mainDb.prepare('INSERT INTO setup_jobs (id, kind, app, status, epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, app, status, epoch, iso(NOW), iso(NOW));
}

test('targets: every application and every project with a guest; one key format', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  const { mock2Db } = databases();
  registerNodus(mock2Db, buildNodusGuest(root, NOW));
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path, created_at) VALUES (4, 'Shop', 'm2-4', 'active', '/var/lib/proxypilot/mock2/repos/4.git', '2026-10-01 10:00:00')").run();
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path) VALUES (5, 'Old', NULL, 'archived', '/x/5.git')").run();
  mock2Db.prepare("INSERT INTO mock2_projects (id, name, container_name, lifecycle, repo_path) VALUES (6, 'New', NULL, 'provisioning', '/x/6.git')").run();
  const list = listTargets({ mock2Db });
  assert.deepEqual(list.map((x) => [x.key, x.guest]), [['application:1', 'pp-nodus'], ['project:6', 'm2-6'], ['project:4', 'm2-4']]);
  const app = resolveTarget('application:1', { mock2Db });
  assert.equal(app.name, 'Nodus');
  assert.equal(app.profile.releaseRoot, '/opt/nodus-releases');
  assert.deepEqual(app.profile.preservePaths, ['/var/lib/nodus', '/opt/nodus/voice/models']);
  assert.equal(app.live.sha.length, 40);
  assert.equal(app.candidates[0].validation.passed, true);
  const proj = resolveTarget('project:4', { mock2Db });
  assert.deepEqual([proj.guest, proj.repoPath, proj.appDir], ['m2-4', '/var/lib/proxypilot/mock2/repos/4.git', '/srv/app']);
  assert.throws(() => resolveTarget('project:5', { mock2Db }), (e) => e.code === 'TARGET_NOT_FOUND' && e.status === 404, 'an archived project has no guest');
  assert.throws(() => resolveTarget('application:99', { mock2Db }), (e) => e.code === 'TARGET_NOT_FOUND' && e.status === 404);
  for (const bad of ['application:0', 'app:1', 'project:1; drop', '', null, 'project:01']) assert.throws(() => parseTargetKey(bad), (e) => e.code === 'INVALID_TARGET' && e.status === 400, String(bad));
});

test('activity of an application: its open jobs, build attempts, a restore, the lease, other applications', () => {
  const { mainDb } = databases();
  const target = { key: 'application:1', kind: 'application', id: 1, guest: 'pp-nodus' };
  assert.deepEqual(activityFor(target, { mainDb, now: NOW }).openJobs, []);
  job(mainDb, { id: 'job-v', kind: 'application_validate', app: 'pp-nodus', epoch: 2 });
  job(mainDb, { id: 'job-r', kind: 'restore_snapshot', app: 'pp-nodus', status: 'queued' });
  job(mainDb, { id: 'job-old', kind: 'application_validate', app: 'pp-nodus', status: 'succeeded' });
  job(mainDb, { id: 'job-other', kind: 'application_deploy', app: 'pp-other' });
  mainDb.prepare("INSERT INTO setup_locks (app, owner, operation, job_id, epoch, acquired_at, lease_expires_at) VALUES ('pp-nodus', 'runner@h#1', 'application_validate', 'job-v', 2, ?, ?)").run(iso(NOW), iso(NOW + 30_000));
  const a = activityFor(target, { mainDb, now: NOW });
  assert.deepEqual(a.openJobs.map((j) => j.id).sort(), ['job-r', 'job-v']);
  assert.deepEqual(a.activeAttempts, ['job-v-2']);
  assert.equal(a.buildActive, true);
  assert.equal(a.openRestoreJob, true);
  assert.equal(a.anyApplicationJobOpen, true);
  assert.deepEqual(a.leaseHeld, { operation: 'application_validate', jobId: 'job-v', stale: false });
  assert.ok(a.openJobIds.includes('job-v-2'));
  assert.equal(guestBusy(a), true);
  // The cleanup job's own rescan leaves itself out.
  const self = activityFor(target, { mainDb, now: NOW, excludeJobId: 'job-v' });
  assert.equal(self.activeAttempts.length, 0);
  assert.equal(self.leaseHeld, null);
  // An expired lease is not held; a stale one (needs recovery) is.
  mainDb.prepare("UPDATE setup_locks SET lease_expires_at = ? WHERE app = 'pp-nodus'").run(iso(NOW - 1000));
  assert.equal(activityFor(target, { mainDb, now: NOW }).leaseHeld, null);
  mainDb.prepare("UPDATE setup_locks SET stale_since = ? WHERE app = 'pp-nodus'").run(iso(NOW - 1000));
  assert.equal(activityFor(target, { mainDb, now: NOW }).leaseHeld.stale, true);
});

test('activity of a Dev Studio project: running cycles, a started queue row, a held checkout, a deploy job', () => {
  const { mock2Db, mainDb } = databases();
  const target = { key: 'project:4', kind: 'project', id: 4, guest: 'm2-4' };
  assert.equal(activityFor(target, { mainDb, mock2Db, now: NOW }).buildActive, false);
  mock2Db.prepare("INSERT INTO mock2_cycles (id, project_id, status) VALUES (1, 4, 'succeeded')").run();
  assert.equal(activityFor(target, { mainDb, mock2Db, now: NOW }).buildActive, false);
  mock2Db.prepare("INSERT INTO mock2_cycles (id, project_id, status) VALUES (2, 4, 'running')").run();
  assert.equal(activityFor(target, { mainDb, mock2Db, now: NOW }).buildActive, true);
  mock2Db.prepare("UPDATE mock2_cycles SET status = 'failed'").run();
  mock2Db.prepare("INSERT INTO mock2_build_queue (project_id, status) VALUES (4, 'started')").run();
  assert.equal(activityFor(target, { mainDb, mock2Db, now: NOW }).buildActive, true);
  mock2Db.prepare('DELETE FROM mock2_build_queue').run();
  mock2Db.prepare("INSERT INTO mock2_locks (project_id, holder_cycle_id, acquired_at, last_write_at) VALUES (4, 9, 'x', 'x')").run();
  assert.equal(activityFor(target, { mainDb, mock2Db, now: NOW }).buildActive, true);
  mock2Db.prepare('DELETE FROM mock2_locks').run();
  job(mainDb, { id: 'dep', kind: 'deploy', app: 'm2-4' });
  const a = activityFor(target, { mainDb, mock2Db, now: NOW });
  assert.equal(a.buildActive, true);
  assert.match(a.reasons.join(' '), /deploy of this project/);
});

test('an interrupted application job (recovery_required, not yet recovered) is still open: its attempt and the transfer copies stay protected', () => {
  const { mainDb } = databases();
  const target = { key: 'application:1', kind: 'application', id: 1, guest: 'pp-nodus' };
  job(mainDb, { id: 'job-d', kind: 'application_deploy', app: 'pp-nodus', status: 'recovery_required', epoch: 3 });
  job(mainDb, { id: 'job-x', kind: 'restore_snapshot', app: 'pp-nodus', status: 'recovery_required' });
  const a = activityFor(target, { mainDb, now: NOW });
  assert.deepEqual(a.openJobs.map((j) => [j.id, j.status]), [['job-d', 'recovery_required']], 'only application jobs count while recovery_required');
  assert.deepEqual(a.activeAttempts, ['job-d-3']);
  assert.deepEqual(a.recoveryAttempts, ['job-d-3']);
  assert.ok(a.openJobIds.includes('job-d-3'));
  assert.equal(a.anyApplicationJobOpen, true);
  assert.equal(a.buildActive, true);
  assert.ok(a.reasons.includes('An application deploy job was interrupted and needs recovery.'));
  assert.equal(guestBusy(a), true);
  // Another application's interrupted job keeps the shared transfer copies too.
  assert.equal(activityFor({ ...target, guest: 'pp-other' }, { mainDb, now: NOW }).anyApplicationJobOpen, true);
  // Once recovered it is closed.
  mainDb.prepare("UPDATE setup_jobs SET outcome = 'application_recovered' WHERE id = 'job-d'").run();
  const after = activityFor(target, { mainDb, now: NOW });
  assert.deepEqual([after.openJobs.length, after.activeAttempts.length, after.anyApplicationJobOpen, after.buildActive], [0, 0, false, false]);
});

test('an application target carries the previous release from the deploy history, and each candidate\'s own live record', (t) => {
  const root = makeRoot(); t.after(() => cleanupRoot(root));
  const { mock2Db } = databases();
  const id = registerNodus(mock2Db, buildNodusGuest(root, NOW));
  assert.equal(resolveTarget('application:1', { mock2Db }).previousLive, null, 'no history: unknown');
  addDeployHistory(mock2Db, id, { now: NOW });
  const app = resolveTarget('application:1', { mock2Db });
  assert.deepEqual(app.previousLive, { ...DEPLOY_HISTORY });
  const rb = app.candidates.find((c) => c.sha === DEPLOY_HISTORY.sha);
  assert.equal(rb.live.releasePath, DEPLOY_HISTORY.path);
});
