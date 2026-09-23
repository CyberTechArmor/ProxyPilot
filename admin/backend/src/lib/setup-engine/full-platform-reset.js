// Full Platform reset — "blow it out and start over", reviewed like every
// other runtime action: a preview listing every container, route, DB row
// (and, with purge, every directory, volume and network) it will remove, a
// review digest over exactly that inventory, and a job the host runner
// executes under the same fencing as the coordinator.
//
//   resetReview(db, { purgeData })      → the preview + reviewToken (inert)
//   queueReset(db, input, by, { via })  → the full_platform_apply job, operation "reset"
//   runReset(db, full, job, exec, deps) → the runner side (full-platform-op.js dispatches)
//   removeResetRoutes(db, { resetJob, fence, render }) → the backend Caddy step
//
// Default mode stops and removes the OWNED containers (inspected IDs, the
// ownership label and data mounts checked first — the lifecycle helper),
// removes the owned Caddy routes, and discards the saved plan, operations and
// service records so step 1 starts clean. Data directories, volumes,
// networks, keys and protected credentials stay where they are.
//
// purge_data additionally deletes the owned data — AFTER a backup set was
// written into the exports directory and read back: containers are stopped
// first (a stopped copy is the consistent SQLite/PostgreSQL copy the
// guided-vaultwarden backup table asks for), every owned directory and volume
// is archived, the discarded ProxyPilot records are written as JSON (their
// protected values stay ciphertext), a sha256 manifest is written, and every
// archive is listed back with tar and re-hashed before the first deletion.
//
// Always refused: an external service (its record is left untouched), any
// runtime without this installation's ownership label or marker, active SSO
// (ProxyPilot login depends on it), active Pomerium application policies,
// and any queued or running platform operation.

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readFullPlatform, installedTargets, digest, fail, RESET_ROUTES_APP } from './full-platform-store.js';
import { serviceReaders } from './full-platform-services.js';
import { removeOwnedContainers, readOwnedMarker, ownedRoot, ownerRef } from './full-platform-lifecycle.js';
import { containerNames, ownedRoute, PLATFORM_APPS, SERVICE_IDS, jobSummary } from './full-platform-mcp.js';
import { createJob, getJob, jobView, acquireLock, renewLock, releaseLock, readLock, takeoverLock } from './store.js';
import { resourceNames } from './keycloak-logic.js';
import { namesFor as infisicalNames } from './infisical-runtime.js';
import { namesFor as baoNames } from './openbao-logic.js';
import { namesFor as vaultNames } from './vaultwarden-logic.js';
import { renderDomains } from '../route-render.js';

export { RESET_ROUTES_APP };
export const RESET_EXPORTS_DIR = '/var/lib/proxypilot/mcp-exports';
export const resetSchema = z.object({ revision: z.number().int().positive(), reviewToken: z.string().regex(/^[a-f0-9]{64}$/), purgeData: z.boolean(), reviewed: z.literal(true) }).strict();

const has = (db, table) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
const OPEN = ['queued', 'running'];
// Lazy: this module sits on an import cycle with full-platform-mcp.js (through
// the executor), so its bindings are read at call time, never at load time.
const resetApps = () => [...PLATFORM_APPS, RESET_ROUTES_APP];
const CREDENTIAL_TABLE = { pomerium: 'setup_pomerium_credentials', infisical: 'setup_infisical_credentials', openbao: 'setup_openbao_credentials', vaultwarden: 'setup_vaultwarden_credentials' };

function networksFor(service, row) {
  if (service === 'keycloak') return [resourceNames(row.id).network];
  if (service === 'infisical') { const n = infisicalNames(row); return [n.network, n.proxyNetwork]; }
  if (service === 'openbao') return [baoNames(row).network];
  if (service === 'vaultwarden') return [vaultNames(row).network];
  return []; // Pomerium runs on the host network
}
function volumesFor(service, row) {
  if (service === 'keycloak') return [resourceNames(row.id).volume];
  if (service === 'infisical') { const n = infisicalNames(row); return [n.databaseVolume, n.redisVolume, n.proxyVolume]; }
  if (service === 'openbao') { const n = baoNames(row); return [n.volume, n.logs]; }
  return []; // Vaultwarden and Pomerium keep their data in the owned directory
}

function ssoFor(db, ownedKeycloakId) {
  if (!has(db, 'sso_config')) return null;
  const r = db.prepare('SELECT * FROM sso_config WHERE id=1').get();
  if (!r) return null;
  const c = JSON.parse(r.config_json);
  return { row: r, config: c, owned: !!ownedKeycloakId && c.connectionId === ownedKeycloakId };
}

/** The inventory, blockers and preview. Throws only when there is nothing to review. */
export function resetReview(db, { purgeData = false, ignoreJobs = [] } = {}) {
  const full = readFullPlatform(db);
  if (!full) throw fail('No Full Platform setup is saved. Individual Custom / Advanced adapters are not reset here.');
  const targets = installedTargets(db), owned = [], external = [];
  for (const id of SERVICE_IDS) {
    const t = targets[id]; if (!t) continue;
    const row = id === 'keycloak' ? t.row : serviceReaders[id](db);
    if (t.mode === 'install') owned.push({ service: id, row });
    else external.push({ service: id, url: t.url, note: 'External connection: its record and runtime are left untouched.' });
  }
  const keycloak = owned.find((o) => o.service === 'keycloak')?.row || null;
  const sso = ssoFor(db, keycloak?.id);
  const blockers = [];
  const open = db.prepare(`SELECT * FROM setup_jobs WHERE app IN (${resetApps().map(() => '?').join(',')}) AND status IN ('queued','running')`).all(...resetApps()).filter((j) => !ignoreJobs.includes(j.id));
  for (const j of open) blockers.push(`Operation ${j.id} (${j.kind}) is ${j.status}. Wait for it before resetting.`);
  if (sso?.row.active) blockers.push('SSO is active and ProxyPilot sign-in depends on this identity provider. Disable SSO from local recovery first (Platform Setup → Custom / Advanced → Single sign-on).');
  if (owned.some((o) => o.service === 'pomerium') && has(db, 'setup_route_protection') && db.prepare("SELECT 1 FROM setup_route_protection WHERE state!='removed' LIMIT 1").get()) blockers.push('Saved application policies depend on Pomerium. Retire those access dependencies before resetting.');

  const services = owned.map(({ service, row }) => {
    const route = ownedRoute(service, row);
    return { service, ref: ownerRef(service, row), containers: containerNames(service, row), directory: ownedRoot(service, row), volumes: volumesFor(service, row), networks: networksFor(service, row), route: route ? { ...route, hostname: new URL(row.config?.origin || row.origin).hostname } : null };
  });
  const recorded = (id) => has(db, 'service_http_routes') && !!db.prepare('SELECT 1 FROM service_http_routes WHERE id=?').get(id);
  const routes = services.filter((s) => s.route && recorded(s.route.route_id)).map((s) => ({ route_id: s.route.route_id, service_id: s.route.service_id, hostname: s.route.hostname }));
  if (sso?.owned && has(db, 'service_http_routes')) {
    const rec = db.prepare("SELECT id, service_id, domain FROM service_http_routes WHERE id='proxypilot-local-recovery'").get();
    if (rec) routes.push({ route_id: rec.id, service_id: rec.service_id, hostname: rec.domain });
  }
  const rows = recordPlan(db, { owned, sso, purgeData });
  const count = (r) => (has(db, r.table) ? db.prepare(`SELECT count(*) n FROM ${r.table} WHERE ${r.where}`).get(...r.args).n : 0);
  const recordCounts = rows.map((r) => ({ table: r.table, rows: count(r), what: r.what }));
  const inventory = { revision: full.revision, purgeData, services, routes, records: recordCounts, external: external.map((e) => e.service), blockers };
  const reviewToken = digest(inventory);
  return {
    revision: full.revision, purgeData, reviewToken, blockers, external,
    remove: {
      containers: services.flatMap((s) => s.containers.map((name) => ({ service: s.service, name, owner_label: `io.proxypilot.${s.service}=${s.ref}` }))),
      routes, records: recordCounts.filter((r) => r.rows),
      ...(purgeData ? { directories: services.map((s) => ({ service: s.service, path: s.directory })), volumes: services.flatMap((s) => s.volumes.map((name) => ({ service: s.service, name }))), networks: services.flatMap((s) => s.networks.map((name) => ({ service: s.service, name }))) } : {}),
    },
    retain: purgeData
      ? { note: 'Nothing owned is retained on the host except the backup set. External services, the OpenBao recovery package directory, the installation key and ProxyPilot users/sessions are untouched.' }
      : { directories: services.map((s) => ({ service: s.service, path: s.directory })), volumes: services.flatMap((s) => s.volumes), networks: services.flatMap((s) => s.networks), credentials: 'Protected credential rows (setup_full_credentials, setup_*_credentials, sso_credentials) and the installation key stay in place.',
        note: 'A later managed install at the same fixed paths (Vaultwarden, OpenBao, Infisical, Pomerium) finds the retained ownership marker of the discarded record and refuses to adopt it; restore that record or reset again with purge_data to reuse those paths. Keycloak uses a new per-installation directory.' },
    backup: purgeData ? { directory: `${RESET_EXPORTS_DIR}/platform-reset-<job id>`, contents: ['<service>-files.tar.gz for every owned directory', '<volume>.tar.gz for every owned volume', 'proxypilot-records.json (the discarded rows; protected values remain ciphertext under the installation key)', 'manifest.json (sha256 and size of every file)'], verified: 'Every archive is listed back with tar and re-hashed before the first deletion; any mismatch stops the reset with nothing deleted.' } : null,
    effects: [
      'Refuses to start while any platform operation is queued or running, while SSO is active, or while Pomerium application policies are active.',
      'Stops and removes only the listed owned containers, by inspected immutable ID, after checking each ownership label (and, without purge, its data mounts).',
      'Removes the owned Caddy routes through the backend route step and re-renders their hostnames.',
      'Discards the saved Full Platform plan, the shared service plan, platform operations and the owned service records, so Platform Setup starts at step 1.',
      purgeData ? 'Writes and verifies the backup set, then deletes the owned directories, volumes and networks.' : 'Keeps data directories, volumes, networks, keys and protected credentials in place.',
    ],
  };
}

function recordPlan(db, { owned, sso, purgeData }) {
  const out = [
    { table: 'setup_full_platform', where: 'id=1', args: [], what: 'saved Full Platform plan and progress' },
    { table: 'setup_platform_plan', where: 'id=1', args: [], what: 'shared service plan' },
  ];
  for (const { service, row } of owned) {
    if (service === 'keycloak') out.push({ table: 'setup_keycloak', where: "id=? AND ownership='managed'", args: [row.id], what: 'managed Keycloak installation record' });
    else out.push({ table: `setup_${service}`, where: 'id=1', args: [], what: `${service} service record` });
    if (service === 'pomerium') out.push({ table: 'setup_route_protection', where: "state='removed'", args: [], what: 'retired Pomerium route policies' });
    if (purgeData && CREDENTIAL_TABLE[service]) out.push({ table: CREDENTIAL_TABLE[service], where: 'id=?', args: [row.credential_ref], what: `${service} protected credentials` });
  }
  if (sso?.owned) {
    out.push({ table: 'sso_config', where: 'id=1 AND active=0', args: [], what: 'inactive ProxyPilot SSO record naming the owned Keycloak (the observer reference)' });
    out.push({ table: 'sso_evidence', where: 'fingerprint=?', args: [sso.row.fingerprint], what: 'SSO check evidence for that record' });
    out.push({ table: 'sso_recovery_checks', where: 'fingerprint=?', args: [sso.row.fingerprint], what: 'pending recovery checks for that record' });
    out.push({ table: 'sso_flows', where: 'fingerprint=?', args: [sso.row.fingerprint], what: 'pending SSO sign-in flows for that record' });
    out.push({ table: 'sso_links', where: 'issuer=?', args: [sso.config.issuer || ''], what: 'account links to the owned issuer' });
    out.push({ table: 'sso_pending', where: 'issuer=?', args: [sso.config.issuer || ''], what: 'pending identities of the owned issuer' });
    if (purgeData) for (const ref of [sso.config.clientSecretRef, sso.config.readerSecretRef].filter(Boolean)) out.push({ table: 'sso_credentials', where: 'id=?', args: [ref], what: 'SSO client credentials' });
  }
  if (purgeData) out.push({ table: 'setup_full_credentials', where: '1=1', args: [], what: 'Full Platform protected references (bootstrap copy, client secrets)' });
  const apps = resetApps().map(() => '?').join(',');
  out.push({ table: 'setup_job_events', where: `job_id IN (SELECT id FROM setup_jobs WHERE app IN (${apps}) AND status NOT IN ('queued','running'))`, args: [...resetApps()], what: 'platform operation event logs' });
  out.push({ table: 'setup_jobs', where: `app IN (${apps}) AND status NOT IN ('queued','running')`, args: [...resetApps()], what: 'finished platform operations' });
  out.push({ table: 'setup_locks', where: `app IN (${apps}) AND job_id IS NULL`, args: [...resetApps()], what: 'released platform leases' });
  return out;
}

export function queueReset(db, raw, by, { via = 'ui' } = {}) {
  const p = resetSchema.parse(raw); db.exec('BEGIN IMMEDIATE');
  try {
    const full = readFullPlatform(db), review = resetReview(db, { purgeData: p.purgeData });
    if (!full || p.revision !== full.revision || p.reviewToken !== review.reviewToken) throw fail('The reset preview changed. Review it again before resetting.', 'RESET_REVIEW_STALE');
    if (review.blockers.length) throw fail(review.blockers.join(' '), 'RESET_BLOCKED');
    const job = createJob(db, { app: 'pp-full-platform', kind: 'full_platform_apply', plan: { params: { revision: full.revision, operation: 'reset' } }, requestedBy: by, via, retryOf: full.last_job_id,
      reason: p.purgeData ? 'Reviewed Full Platform reset with data purge; a verified backup set is written first.' : 'Reviewed Full Platform reset; data directories, volumes, keys and credentials retained.' });
    const state = { ...full.state, reset: { purgeData: p.purgeData, reviewToken: p.reviewToken, stage: 'queued', done: {} } };
    db.prepare('UPDATE setup_full_platform SET state_json=?,last_job_id=? WHERE id=1').run(JSON.stringify(state), job.id);
    db.exec('COMMIT'); return { job: jobView(job), created: true };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The runner side. Resumable: every stage is recorded before the next begins. */
export async function runReset(db, full, job, exec, { roots = {}, exportsDir = RESET_EXPORTS_DIR, now = () => new Date().toISOString() } = {}) {
  const state = { ...full.state, reset: { ...full.state.reset, done: { ...full.state.reset?.done } } };
  const reset = state.reset;
  const persist = () => { job.fence(); db.prepare('UPDATE setup_full_platform SET state_json=? WHERE id=1 AND last_job_id=?').run(JSON.stringify(state), job.id); };
  if (reset.stage === 'queued') {
    const review = resetReview(db, { purgeData: reset.purgeData, ignoreJobs: [job.id] });
    if (review.reviewToken !== reset.reviewToken) throw fail('The reset inventory changed after review. Nothing was removed; review the reset again.');
    if (review.blockers.length) throw fail(`${review.blockers.join(' ')} Nothing was removed.`);
    // Freeze exactly what was reviewed; later stages act only on this list.
    const targets = installedTargets(db);
    reset.plan = {
      services: SERVICE_IDS.filter((id) => targets[id]?.mode === 'install').map((service) => {
        const row = service === 'keycloak' ? targets.keycloak.row : serviceReaders[service](db);
        return { service, ref: ownerRef(service, row), containers: containerNames(service, row), volumes: volumesFor(service, row), networks: networksFor(service, row), directory: roots[service] || ownedRoot(service, row) };
      }),
      routes: review.remove.routes,
    };
    reset.stage = 'runtime'; persist();
  }
  const owner = getJob(db, job.id)?.owner;
  const rowOf = (service) => (service === 'keycloak' ? db.prepare('SELECT * FROM setup_keycloak WHERE id=?').get(reset.plan.services.find((s) => s.service === 'keycloak').ref) : serviceReaders[service](db));

  if (reset.stage === 'runtime') {
    // Hold every owned service's lease for the whole runtime stage, like the
    // per-service lifecycle action does for one.
    const leases = [];
    const fence = () => { job.fence(); for (const l of leases) if (!renewLock(db, { app: l.app, owner, epoch: l.epoch, leaseMs: 120000 })) throw fail('A service lease was lost during reset. Nothing further was removed.'); };
    const docker = async (args) => { fence(); const r = await exec.host(['docker', ...args], { timeoutMs: 120000 }); fence(); if (r.code !== 0) throw fail('An owned runtime operation failed during reset. Private runtime output is withheld; nothing further was removed.'); return r.stdout; };
    const host = async (argv, timeoutMs = 1800000) => { fence(); const r = await exec.host(argv, { timeoutMs }); fence(); if (r.code !== 0) throw fail(`Backup step ${argv[0]} failed during reset. Nothing was deleted.`); return r.stdout; };
    try {
      for (const s of reset.plan.services) {
        const app = `pp-platform-${s.service}`;
        let lock = acquireLock(db, { app, owner, jobId: job.id, operation: 'platform_reset', leaseMs: 120000 });
        if (!lock.ok && lock.reason === 'stale' && readLock(db, app)?.job_id === job.id) lock = takeoverLock(db, { app, by: owner, jobId: job.id, operation: 'platform_reset', leaseMs: 120000, reason: 'Resume this reviewed reset.' });
        if (!lock.ok) throw fail(`${s.service} has an active or unresolved operation. Nothing further was removed.`);
        leases.push({ app, epoch: lock.lock.epoch });
      }
      const present = { container: new Set((await docker(['container', 'ls', '-a', '--format', '{{.Names}}'])).trim().split('\n').filter(Boolean)) };
      // 1. Establish ownership of everything that will be touched, before any change.
      const plan = [];
      for (const s of reset.plan.services) {
        const row = rowOf(s.service);
        let markerOk = true;
        try { readOwnedMarker(s.service, row, s.directory); } catch (e) {
          if (existsSync(s.directory) || s.containers.some((n) => present.container.has(n))) throw fail(`${s.service}: protected ownership could not be established (${e.fullPlatformSafe ? e.message : 'marker unreadable'}). Nothing was removed.`);
          markerOk = false; // never installed on this host: no directory and no container
        }
        // Every present container's ownership label, for EVERY service, before
        // the first stop — one foreign container refuses the whole reset.
        for (const name of s.containers.filter((n) => present.container.has(n))) {
          const actual = JSON.parse(await docker(['container', 'inspect', name]))[0];
          if (actual?.Config?.Labels?.[`io.proxypilot.${s.service}`] !== s.ref) throw fail(`Container ${name} belongs to another installation. Nothing was removed.`);
        }
        const volumes = [], networks = [];
        if (reset.purgeData) {
          for (const [kind, names, out] of [['volume', s.volumes, volumes], ['network', s.networks, networks]]) {
            const listed = new Set((await docker([kind, 'ls', '--format', '{{.Name}}'])).trim().split('\n').filter(Boolean));
            for (const name of names.filter((n) => listed.has(n))) {
              const info = JSON.parse(await docker([kind, 'inspect', name]))[0];
              if (info?.Labels?.[`io.proxypilot.${s.service}`] !== s.ref) throw fail(`${kind} ${name} does not carry this installation's ownership label. Nothing was removed.`);
              out.push({ name, mountpoint: info.Mountpoint || null });
            }
          }
        }
        plan.push({ ...s, row, markerOk, volumes, networks });
      }
      // 2. Purge: stop, archive, verify — all before the first removal.
      if (reset.purgeData && !reset.done.backup) {
        for (const s of plan) if (s.markerOk) await removeOwnedContainers({ service: s.service, row: s.row, names: s.containers, root: s.directory, call: docker, checkMounts: false, stopOnly: true });
        const dir = join(exportsDir, `platform-reset-${job.id}`);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const files = [];
        for (const s of plan) {
          if (s.markerOk && existsSync(s.directory)) { const out = join(dir, `${s.service}-files.tar.gz`); await host(['tar', '-C', s.directory, '-czf', out, '.']); files.push({ file: out, source: s.directory }); }
          for (const v of s.volumes) { if (!v.mountpoint) throw fail(`Volume ${v.name} has no host mountpoint to archive. Nothing was deleted.`); const out = join(dir, `${v.name}.tar.gz`); await host(['tar', '-C', v.mountpoint, '-czf', out, '.']); files.push({ file: out, source: `volume:${v.name}` }); }
        }
        const records = {};
        for (const r of resetRecordPlan(db, full.revision, reset.purgeData)) if (has(db, r.table)) records[r.table] = db.prepare(`SELECT * FROM ${r.table} WHERE ${r.where}`).all(...r.args);
        const recordsPath = join(dir, 'proxypilot-records.json');
        writeFileSync(recordsPath, JSON.stringify({ written_at: now(), job: job.id, note: 'Protected values are ciphertext under this installation key; the key itself is not copied here.', records }, null, 2), { mode: 0o600 });
        files.push({ file: recordsPath, source: 'proxypilot-db' });
        const manifest = files.map((f) => ({ name: f.file.slice(dir.length + 1), source: f.source, bytes: statSync(f.file).size, sha256: sha256File(f.file) }));
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ written_at: now(), job: job.id, files: manifest }, null, 2), { mode: 0o600 });
        // Read the set back: every archive lists, every hash matches, nothing is empty.
        for (const m of manifest) {
          const path = join(dir, m.name);
          if (!existsSync(path) || statSync(path).size !== m.bytes || !m.bytes || sha256File(path) !== m.sha256) throw fail(`Backup file ${m.name} did not verify. Nothing was deleted.`);
          if (m.name.endsWith('.tar.gz')) await host(['tar', '-tzf', path], 600000);
        }
        reset.done.backup = { directory: dir, files: manifest.length, verified_at: now() }; persist();
      }
      // 3. Remove runtime (and, with purge, the owned data).
      for (const s of plan) {
        if (reset.done[`runtime:${s.service}`]) continue;
        if (s.markerOk) await removeOwnedContainers({ service: s.service, row: s.row, names: s.containers, root: s.directory, call: docker, checkMounts: !reset.purgeData });
        if (reset.purgeData) {
          for (const v of s.volumes) await docker(['volume', 'rm', v.name]);
          for (const n of s.networks) await docker(['network', 'rm', n.name]);
          if (s.markerOk && existsSync(s.directory)) {
            const target = resolve(s.directory), st = lstatSync(target);
            if (!st.isDirectory() || st.isSymbolicLink() || target.split('/').filter(Boolean).length < 3) throw fail(`${s.service}: refusing to delete ${target}.`);
            fence(); rmSync(target, { recursive: true, force: true });
          }
        }
        reset.done[`runtime:${s.service}`] = true; persist();
      }
      reset.stage = 'routes'; persist();
    } finally { for (const l of leases) releaseLock(db, { app: l.app, owner, epoch: l.epoch }); }
  }

  if (reset.stage === 'routes') {
    let child = reset.routesJob && getJob(db, reset.routesJob);
    if (!reset.plan.routes.length) { reset.stage = 'records'; persist(); }
    else {
      if (!child) {
        child = createJob(db, { app: RESET_ROUTES_APP, kind: 'remove_platform_routes', plan: { params: { resetJob: job.id } }, requestedBy: getJob(db, job.id)?.requested_by || 'platform_reset', via: 'system', reason: 'Remove the owned Full Platform Caddy routes reviewed for reset.' });
        reset.routesJob = child.id; persist();
      }
      if (OPEN.includes(child.status)) return { waiting: true, reason: 'Waiting for the owned Caddy routes to be removed.' };
      if (child.status !== 'succeeded') throw fail('Owned route removal failed. Runtime changes are recorded; retry the reset review to finish the remaining steps.');
      reset.stage = 'records'; persist();
    }
  }

  // 4. Discard the records. The setup row goes last, in the same transaction.
  job.fence();
  const plan = resetRecordPlan(db, full.revision, reset.purgeData);
  const summary = { purgeData: reset.purgeData, backup: reset.done.backup || null, services: reset.plan.services.map((s) => s.service), routes: reset.plan.routes.map((r) => r.hostname) };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of plan) if (has(db, r.table)) db.prepare(`DELETE FROM ${r.table} WHERE ${r.where}`).run(...r.args);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { verification: { state: 'platform_reset', complete: true, ...summary,
    label: `Full Platform reset finished: ${summary.services.length} owned service(s) removed${reset.purgeData ? ` and their data deleted after the verified backup set at ${summary.backup?.directory}` : '; data directories, volumes, keys and credentials retained'}. Platform Setup starts at step 1.` } };
}

// The record plan is rebuilt at the end from the frozen reset state rather
// than recomputed from the (by now partly removed) inventory.
function resetRecordPlan(db, _revision, purgeData) {
  const full = readFullPlatform(db);
  const services = full?.state?.reset?.plan?.services || [];
  const owned = services.map((s) => ({ service: s.service, row: s.service === 'keycloak' ? { id: s.ref } : { credential_ref: s.ref } }));
  const keycloakId = services.find((s) => s.service === 'keycloak')?.ref;
  const sso = ssoFor(db, keycloakId);
  // The reset job and its route step are finished or running here; they are
  // the record of what happened and are kept.
  const keep = [full.last_job_id, full.state.reset.routesJob || full.last_job_id];
  return recordPlan(db, { owned, sso, purgeData }).map((r) => r.table === 'setup_job_events' ? { ...r, where: `${r.where} AND job_id NOT IN (?, ?)`, args: [...r.args, ...keep] }
    : r.table === 'setup_jobs' ? { ...r, where: `${r.where} AND id NOT IN (?, ?)`, args: [...r.args, ...keep] } : r);
}

/** Backend step: delete the frozen owned route rows (exact ids only) and re-render their hostnames. */
export async function removeResetRoutes(db, { resetJob, fence, render }) {
  const full = readFullPlatform(db);
  if (!full || full.last_job_id !== resetJob || full.state?.reset?.stage !== 'routes' || !OPEN.includes(getJob(db, resetJob)?.status)) throw fail('Superseded reset route step.');
  const routes = full.state.reset.plan.routes, domains = [];
  fence();
  for (const r of routes) {
    const row = db.prepare('SELECT id, service_id, domain FROM service_http_routes WHERE id=?').get(r.route_id);
    if (row && (row.service_id !== r.service_id || row.domain !== r.hostname)) throw fail(`Route ${r.route_id} changed since the reset review; it was not removed.`);
    if (row) { db.prepare('DELETE FROM service_http_routes WHERE id=?').run(r.route_id); domains.push(r.hostname); }
    if (!db.prepare('SELECT 1 FROM service_http_routes WHERE service_id=?').get(r.service_id)) db.prepare('DELETE FROM services WHERE id=?').run(r.service_id);
    fence();
  }
  if (domains.length) await renderDomains({ db, domains, ...render, fence });
  return { created: [], existing: [], conflicts: [], rendered: domains, removed: domains };
}

export const resetJobSummary = (db, id) => jobSummary(getJob(db, id));
