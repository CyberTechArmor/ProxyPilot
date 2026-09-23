import { z } from 'zod';
import { join } from 'node:path';
import { digest, fail, readFullPlatform, installedTargets } from './full-platform-store.js';
import { createJob, getJob, jobView, acquireLock, renewLock, releaseLock, readLock, takeoverLock } from './store.js';
import { applyService, serviceReaders } from './full-platform-services.js';
import { resourceNames, KEYCLOAK_ROOT } from './keycloak-logic.js';
import { POMERIUM_APP, POMERIUM_ROOT } from './pomerium-logic.js';
import { namesFor as infisicalNames } from './infisical-runtime.js';
import { INFISICAL_ROOT } from './infisical-logic.js';
import { namesFor as baoNames, OPENBAO_ROOT } from './openbao-logic.js';
import { namesFor as vaultNames, VAULTWARDEN_ROOT } from './vaultwarden-logic.js';
import { readPrivate, atomicPrivate } from './pomerium-runtime.js';
import { logConfigCurrent } from './owned-runtime.js';

// Resolved per service: only Keycloak's root is per installation (its id is
// the kc-… string). Building every entry eagerly joined the other services'
// integer row id (1) and threw for all of them.
export const ownedRoot = (service, row) => (service === 'keycloak' ? join(KEYCLOAK_ROOT, String(row?.id || '')) : { pomerium: POMERIUM_ROOT, infisical: INFISICAL_ROOT, openbao: OPENBAO_ROOT, vaultwarden: VAULTWARDEN_ROOT }[service]);
export const ownerRef = (service, row) => (service === 'keycloak' ? row.id : row.credential_ref);

/** The protected ownership marker under the service root, checked against the saved record. */
export function readOwnedMarker(service, row, root) {
  const marker = JSON.parse(readPrivate(join(root, service === 'infisical' ? 'protected.json' : 'owner.json')));
  const identity = service === 'infisical' ? marker.identity : marker;
  if (identity.origin !== (row.config?.origin || row.origin) || (identity.ref || identity.id) !== ownerRef(service, row) || service === 'keycloak' && identity.realm !== row.realm) throw fail('Protected ownership differs from the reviewed installation.');
  return marker;
}

/**
 * Stop and remove the named owned containers of one service, by inspected
 * immutable ID. Every present container's ownership label (and its data
 * mounts, when retaining data) is established BEFORE the first stop/removal;
 * one foreign or drifted container refuses the whole set. Never --volumes;
 * no volume, network or file is touched here. `call(args)` runs `docker args`.
 */
export async function removeOwnedContainers({ service, row, names, root, call, checkMounts = true, stopOnly = false }) {
  const marker = readOwnedMarker(service, row, root);
  const present = (await call(['container', 'ls', '-a', '--format', '{{.Names}}'])).trim().split('\n');
  const inspected = [];
  for (const name of names.filter(n => present.includes(n))) {
    let actual; try { actual = JSON.parse(await call(['container', 'inspect', name]))[0]; } catch (e) { if (e.fullPlatformSafe) throw e; throw fail('Container ownership could not be read.'); }
    if (actual?.Config?.Labels?.[`io.proxypilot.${service}`] !== ownerRef(service, row) || !actual.Id) throw fail('A listed runtime belongs to another installation. Nothing was removed.');
    if (checkMounts) {
      const n = service === 'keycloak' ? resourceNames(row.id) : service === 'infisical' ? infisicalNames(row) : service === 'openbao' ? baoNames(row) : null;
      const dataMounts = service === 'keycloak' && name === n.database ? [['volume', n.volume, '/var/lib/postgresql/data']]
        : service === 'infisical' ? (name === n.database ? [['volume', n.databaseVolume, '/var/lib/postgresql/data']] : name === n.redis ? [['volume', n.redisVolume, '/data']] : name === n.proxy ? [['volume', n.proxyVolume, '/root/.infisical']] : [])
        : service === 'openbao' ? [['volume', n.volume, '/openbao/file'], ['volume', n.logs, '/openbao/logs']]
        : service === 'vaultwarden' ? [['bind', join(root, 'data'), '/data']] : [];
      if (dataMounts.some(([type, source, target]) => !actual.Mounts?.some(m => m.Type === type && (type === 'volume' ? m.Name : m.Source) === source && m.Destination === target && m.RW))) throw fail('Runtime data mounts differ from the retained-data review. Restore the recorded storage configuration before removing runtime.');
    }
    inspected.push({ name, id: actual.Id, running: actual.State?.Running });
  }
  for (const c of inspected) {
    // Operate on the inspected immutable ID, never a name that could change.
    if (c.running) await call(['stop', '--time', '30', c.id]);
    if (!stopOnly) await call(['rm', c.id]); // no --volumes, no volume/network/file deletion
  }
  return { marker, containers: inspected };
}

export const lifecycleSchema = z.object({ revision: z.number().int().positive(), service: z.enum(['keycloak', 'pomerium', 'infisical', 'openbao', 'vaultwarden']), action: z.enum(['repair', 'reinstall', 'remove']), reviewToken: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true), retainData: z.literal(true) }).strict();
export function lifecycleReview(db, service, action) {
  const full = readFullPlatform(db), t = installedTargets(db)[service];
  if (!full || !t) throw fail('No saved installation is available for this action.');
  if (t.mode !== 'install') throw fail('External connections do not authorize repair, reinstallation or removal of their resources.');
  const row = service === 'keycloak' ? t.row : serviceReaders[service](db), owner = row.credential_ref || row.id;
  const names = service === 'keycloak' ? resourceNames(row.id) : service === 'pomerium' ? { server: POMERIUM_APP } : { infisical: infisicalNames, openbao: baoNames, vaultwarden: vaultNames }[service](row);
  const containers = service === 'infisical' ? [names.proxy, names.server, names.redis, names.database] : service === 'keycloak' ? [names.server, names.database] : [names.server];
  const blockers = [];
  if (action !== 'repair' && service === 'keycloak') {
    if (db.prepare('SELECT 1 FROM sso_config WHERE id=1').get()) blockers.push('ProxyPilot identity/recovery configuration depends on this Keycloak. Keep it available; repair its recorded operation.');
    for (const id of ['pomerium', 'openbao', 'vaultwarden']) if (serviceReaders[id](db)?.config.connectionId === row.id) blockers.push(`${id} depends on this identity provider.`);
  }
  if (action !== 'repair' && service === 'pomerium' && db.prepare("SELECT name FROM sqlite_master WHERE name='setup_route_protection'").get() && db.prepare("SELECT 1 FROM setup_route_protection WHERE state!='removed' LIMIT 1").get()) blockers.push('Saved application policies depend on Pomerium. Review and retire those access dependencies before runtime removal.');
  const fingerprint = digest([full.revision, service, action, owner, row.config || [row.origin, row.realm], containers, blockers]);
  return { revision: full.revision, service, action, containers, retainData: true, blockers, reviewToken: fingerprint,
    effects: action === 'repair' ? ['Repeat the existing adapter’s owned checks and missing-resource reconciliation.', 'Owned containers created before the readable-log fix (log driver other than “local”) are stopped and recreated by inspected ID with the same data, so their logs can be read. Containers already on the local driver are not touched.'] : ['Stop and remove only the listed owned containers. Existing Caddy routes remain fail-closed.', 'Persistent volumes, directories, databases, realm, vault keys, recovery material, networks and protected credentials are retained.', action === 'reinstall' ? 'Recreate compatible runtime through the existing adapter using the retained configuration and data.' : 'The service remains unavailable until an explicitly reviewed reinstall.'],
    unsupported: 'Data deletion, credential rotation and hostname/realm migration are not part of these actions.' };
}
export function queueLifecycle(db, raw, by, { via = 'ui' } = {}) {
  const p = lifecycleSchema.parse(raw); db.exec('BEGIN IMMEDIATE');
  try {
    const full = readFullPlatform(db), review = lifecycleReview(db, p.service, p.action);
    if (!full || p.revision !== full.revision || p.reviewToken !== review.reviewToken || review.blockers.length) throw fail(review.blockers.join(' ') || 'Review the current saved runtime action.');
    if (full.last_job_id && ['queued', 'running'].includes(getJob(db, full.last_job_id)?.status)) throw fail('Wait for the current platform operation before requesting a runtime action.');
    const job = createJob(db, { app: 'pp-full-platform', kind: 'full_platform_apply', plan: { params: { revision: p.revision, operation: 'lifecycle' } }, requestedBy: by, via, reason: `Reviewed ${p.service} ${p.action}; all data and credentials retained.` });
    const state = { ...full.state, lifecycle: { service: p.service, action: p.action, reviewToken: p.reviewToken } };
    db.prepare('UPDATE setup_full_platform SET state_json=?,last_job_id=? WHERE id=1').run(JSON.stringify(state), job.id);
    db.exec('COMMIT'); return { job: jobView(job), created: true };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export async function runLifecycle(db, full, job, exec, { roots = {} } = {}) {
  const request = full.state.lifecycle, review = lifecycleReview(db, request.service, request.action);
  if (request.reviewToken !== review.reviewToken || review.blockers.length) throw fail('The lifecycle review or dependencies changed. No runtime was removed.');
  const state = { ...full.state, lifecycle: { ...request }, removed: { ...full.state.removed } };
  const persist = () => { job.fence(); db.prepare('UPDATE setup_full_platform SET state_json=? WHERE id=1 AND last_job_id=?').run(JSON.stringify(state), job.id); };
  const service = request.service, app = `pp-platform-${service}`, row = service === 'keycloak' ? installedTargets(db).keycloak.row : serviceReaders[service](db);
  const owner = getJob(db, job.id)?.owner;
  if (request.action !== 'repair' && !request.removed) {
    let lock = acquireLock(db, { app, owner, jobId: job.id, operation: 'retained_runtime_lifecycle', leaseMs: 120000 });
    if (!lock.ok && lock.reason === 'stale' && readLock(db, app)?.job_id === job.id) lock = takeoverLock(db, { app, by: owner, jobId: job.id, operation: 'retained_runtime_lifecycle', leaseMs: 120000, reason: 'Resume this explicitly reviewed container-only operation.' });
    if (!lock.ok) throw fail('The selected service has an active or unresolved operation.');
    const fence = () => { job.fence(); if (!renewLock(db, { app, owner, epoch: lock.lock.epoch, leaseMs: 120000 })) throw fail('The service lifecycle lease was lost.'); };
    const call = async args => { fence(); const result = await exec.host(['docker', ...args], { timeoutMs: 60000 }); fence(); if (result.code !== 0) throw fail('The owned runtime operation failed. Private runtime output is withheld; data and credentials are retained.'); return result.stdout; };
    try {
      const root = roots[service] || ownedRoot(service, row);
      const { marker } = await removeOwnedContainers({ service, row, names: review.containers, root, call });
      if (service === 'vaultwarden') {
        // The G7 adapter otherwise correctly refuses missing attempted runtime.
        // Permit only this reviewed recreation, after it rechecks retained keys/data.
        marker.reinstall = job.id; fence(); atomicPrivate(join(root, 'owner.json'), JSON.stringify(marker));
        const resources = { ...(row.resources || {}), retainedReinstall: job.id };
        db.prepare('UPDATE setup_vaultwarden SET resources_json=? WHERE id=1').run(JSON.stringify(resources));
      }
      if (service === 'keycloak') db.prepare('UPDATE setup_keycloak SET verified_json=NULL,verified_at=NULL WHERE id=?').run(row.id);
      else db.prepare(`UPDATE setup_${service} SET verified_json=NULL WHERE id=1`).run();
      state.removed[service] = true; state.lifecycle.removed = true; persist();
    } finally { releaseLock(db, { app, owner, epoch: lock.lock.epoch }); }
  }
  // Repair migrates containers still on an unreadable log driver (3a): only
  // those are stopped and removed by inspected ID (labels and data mounts
  // checked first); the adapter below recreates them with LOG_ARGS.
  if (request.action === 'repair' && !state.lifecycle.logsChecked) {
    let lock = acquireLock(db, { app, owner, jobId: job.id, operation: 'retained_runtime_log_migration', leaseMs: 120000 });
    if (!lock.ok && lock.reason === 'stale' && readLock(db, app)?.job_id === job.id) lock = takeoverLock(db, { app, by: owner, jobId: job.id, operation: 'retained_runtime_log_migration', leaseMs: 120000, reason: 'Resume this reviewed repair.' });
    if (!lock.ok) throw fail('The selected service has an active or unresolved operation.');
    const fence = () => { job.fence(); if (!renewLock(db, { app, owner, epoch: lock.lock.epoch, leaseMs: 120000 })) throw fail('The service lifecycle lease was lost.'); };
    const call = async args => { fence(); const result = await exec.host(['docker', ...args], { timeoutMs: 60000 }); fence(); if (result.code !== 0) throw fail('The owned runtime operation failed. Data and credentials are retained.'); return result.stdout; };
    try {
      const present = (await call(['container', 'ls', '-a', '--format', '{{.Names}}'])).trim().split('\n');
      const legacy = [];
      for (const name of review.containers.filter(n => present.includes(n))) {
        let actual; try { actual = JSON.parse(await call(['container', 'inspect', name]))[0]; } catch (e) { if (e.fullPlatformSafe) throw e; throw fail('Container ownership could not be read.'); }
        if (!logConfigCurrent(actual?.HostConfig)) legacy.push(name);
      }
      if (legacy.length) {
        const root = roots[service] || ownedRoot(service, row);
        const { marker } = await removeOwnedContainers({ service, row, names: legacy, root, call });
        if (service === 'vaultwarden') {
          marker.reinstall = job.id; fence(); atomicPrivate(join(root, 'owner.json'), JSON.stringify(marker));
          db.prepare('UPDATE setup_vaultwarden SET resources_json=? WHERE id=1').run(JSON.stringify({ ...(row.resources || {}), retainedReinstall: job.id }));
        }
      }
      state.lifecycle.logsChecked = true; state.lifecycle.logsMigrated = legacy; persist();
    } finally { releaseLock(db, { app, owner, epoch: lock.lock.epoch }); }
  }
  if (request.action === 'remove') return { verification: { state: 'runtime_removed_data_retained', label: `${service} runtime removed. Data, credentials, recovery material and fail-closed routes retained.`, complete: false } };
  let child = state.lifecycle.child && getJob(db, state.lifecycle.child);
  if (!child) {
    if (service === 'keycloak') {
      child = createJob(db, { app, kind: 'keycloak_setup', plan: { params: { installationId: row.id, revision: full.plan_revision } }, requestedBy: full.created_by, via: 'ui', retryOf: row.last_job_id, reason: 'Reviewed repair or compatible retained-data reinstall.' });
      db.prepare('UPDATE setup_keycloak SET last_job_id=?,route_job_id=NULL WHERE id=?').run(child.id, row.id);
    } else child = applyService(db, service, full.created_by).job;
    state.lifecycle.child = child.id; persist();
  }
  child = getJob(db, child.id);
  if (['queued', 'running'].includes(child.status)) return { waiting: true, reason: 'The existing service adapter is checking the retained-data runtime.' };
  if (child.status !== 'succeeded') throw fail(`${service} needs attention in its recorded child operation. Retained data and credentials were not replaced.`);
  delete state.removed[service]; persist();
  return { verification: { state: 'runtime_reconciled', label: `${service} adapter finished. Complete any recorded recovery or access handoff; this action alone does not certify Full Platform completion.`, complete: false } };
}
