// Restricted administrator networks after apply (3f): a reviewed change.
//
//   networksReview(db, networks)            → preview + reviewToken (inert)
//   queueNetworksChange(db, input, by, via) → the update_platform_networks backend step
//   applyNetworksChange(db, { job, fence, render }) → that step: rows, then re-render
//
// Before this, validateExisting refused any change to recoveryNetworks once
// a revision was applied, and the only way out was a reset. The review lists
// every route whose allowlist changes and every record that carries the list;
// the step rewrites exactly those, under the backend's route leases, and
// re-renders the affected hostnames. /0 and an empty list are refused as at
// save time. Active SSO blocks the change: its recovery route is bound to the
// verified SSO fingerprint — disable SSO from local recovery first. An
// inactive SSO record gets a new revision and fingerprint (its checks re-run
// on the next continue), exactly as saving it from Custom setup would.

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFullPlatform, installedTargets, digest, fail } from './full-platform-store.js';
import { serviceReaders } from './full-platform-services.js';
import { ownedRoute } from './full-platform-mcp.js';
import { createJob, getJob, jobView } from './store.js';
import { validateRouteEdgeOptions } from '../caddy-site-file.js';
import { renderDomains } from '../route-render.js';

export const NETWORKS_APP = 'pp-platform-networks';
export const NETWORKS_KIND = 'update_platform_networks';
const OPEN = ['queued', 'running'];
const has = (db, t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
const RECOVERY_ROUTE = 'proxypilot-local-recovery';
export const networksSchema = z.object({ revision: z.number().int().positive(), reviewToken: z.string().regex(/^[a-f0-9]{64}$/), networks: z.array(z.string().max(50)).max(30), reviewed: z.literal(true) }).strict();

export function normalizeNetworks(list) {
  if (!Array.isArray(list)) throw fail('restricted_networks must be a list of IP addresses or CIDRs.');
  const out = [...new Set(list.map((n) => String(n).trim()).filter(Boolean))];
  if (!out.length) throw fail('At least one restricted administrator/VPN network is required; an empty list would remove the restriction.', 'FULL_PLATFORM_NETWORKS_INVALID');
  if (out.some((n) => /\/0$/.test(n))) throw fail('Unrestricted access (/0) is refused. Use the administrator/VPN networks.', 'FULL_PLATFORM_NETWORKS_INVALID');
  const v = validateRouteEdgeOptions({ ip_allowlist: out });
  if (v.error) throw fail(v.error, 'FULL_PLATFORM_NETWORKS_INVALID');
  return out;
}

function ssoRow(db) { return has(db, 'sso_config') ? db.prepare('SELECT * FROM sso_config WHERE id=1').get() || null : null; }

/** Preview of a restricted-network change. Throws only for an invalid list or no saved setup. */
export function networksReview(db, networks, { ignoreJob = null } = {}) {
  const full = readFullPlatform(db);
  if (!full) throw fail('No Full Platform setup is saved.');
  const after = normalizeNetworks(networks), before = full.config.recoveryNetworks;
  const blockers = [];
  const prior = full.last_job_id && getJob(db, full.last_job_id);
  if (prior && prior.id !== ignoreJob && OPEN.includes(prior.status)) blockers.push(`Operation ${prior.id} is ${prior.status}. Wait for it before changing the restricted networks.`);
  const targets = installedTargets(db);
  const records = [{ record: 'setup_full_platform', what: 'saved Full Platform plan (recoveryNetworks)' }];
  const routeIds = [];
  for (const id of ['infisical', 'openbao', 'vaultwarden']) {
    const row = serviceReaders[id](db);
    if (!row) continue;
    records.push({ record: `setup_${id}`, what: `${id} service record (allowedIps)` });
    if (targets[id]?.mode === 'install') { const r = ownedRoute(id, row); if (r) routeIds.push(r.route_id); }
    const last = row.last_job_id && getJob(db, row.last_job_id);
    if (last && OPEN.includes(last.status)) blockers.push(`${id} job ${last.id} is ${last.status}. Wait for it.`);
  }
  const sso = ssoRow(db);
  if (sso?.active) blockers.push('SSO is active and its recovery route is bound to the verified SSO record. Disable SSO from local recovery first, then change the networks.');
  if (sso) { records.push({ record: 'sso_config', what: 'ProxyPilot SSO record (recoveryNetworks): a new revision; its SSO and recovery checks re-run on the next continue' }); routeIds.push(RECOVERY_ROUTE); }
  const routes = has(db, 'service_http_routes') ? routeIds.map((id) => db.prepare('SELECT id, domain, ip_allowlist_json FROM service_http_routes WHERE id=?').get(id)).filter(Boolean).map((r) => ({ route_id: r.id, hostname: r.domain, before: r.ip_allowlist_json ? JSON.parse(r.ip_allowlist_json) : null, after })) : [];
  const unchanged = digest(before) === digest(after);
  if (unchanged) blockers.push('The restricted networks are already exactly these.');
  const reviewToken = digest({ revision: full.revision, before, after, routes, records: records.map((r) => r.record), blockers });
  return { revision: full.revision, before, after, routes, records, blockers, reviewToken,
    effects: ['Rewrites the restricted-network allowlist on each listed route and record, then re-renders those hostnames in Caddy (validated before reload).', 'Nothing else in the plan changes; no container is restarted.', ...(sso ? ['The inactive SSO record gets a new revision: continue the saved setup to re-run its checks.'] : [])] };
}

export function queueNetworksChange(db, raw, by, { via = 'ui' } = {}) {
  const p = networksSchema.parse(raw);
  db.exec('BEGIN IMMEDIATE');
  try {
    const full = readFullPlatform(db), review = networksReview(db, p.networks);
    if (!full || p.revision !== full.revision || p.reviewToken !== review.reviewToken) throw fail('The network change preview is stale. Review it again.', 'NETWORKS_REVIEW_STALE');
    if (review.blockers.length) throw fail(review.blockers.join(' '), 'NETWORKS_BLOCKED');
    const job = createJob(db, { app: NETWORKS_APP, kind: NETWORKS_KIND, plan: { params: { revision: full.revision, reviewToken: p.reviewToken } }, requestedBy: by, via, retryOf: full.last_job_id, reason: `Reviewed restricted-network change: ${review.after.join(', ')}.` });
    const state = { ...full.state, networksChange: { networks: review.after, reviewToken: p.reviewToken, job: job.id } };
    db.prepare('UPDATE setup_full_platform SET state_json=?,last_job_id=? WHERE id=1').run(JSON.stringify(state), job.id);
    db.exec('COMMIT');
    return { job: jobView(job), created: true, review };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** The backend step: rewrite the reviewed rows, then re-render the affected hostnames. */
export async function applyNetworksChange(db, { jobId, fence, render }) {
  const full = readFullPlatform(db), change = full?.state?.networksChange;
  if (!full || !change || change.job !== jobId || full.last_job_id !== jobId) throw fail('Superseded restricted-network change.');
  const review = networksReview(db, change.networks, { ignoreJob: jobId });
  if (review.blockers.length) throw fail(`${review.blockers.join(' ')} Nothing was changed.`);
  if (review.reviewToken !== change.reviewToken) throw fail('The routes or records changed after review. Nothing was changed; review the network change again.');
  const after = JSON.stringify(review.after);
  fence();
  db.exec('BEGIN IMMEDIATE');
  try {
    const state = { ...full.state }; delete state.networksChange;
    db.prepare('UPDATE setup_full_platform SET config_json=?, state_json=? WHERE id=1 AND last_job_id=?').run(JSON.stringify({ ...full.config, recoveryNetworks: review.after }), JSON.stringify(state), jobId);
    for (const id of ['infisical', 'openbao', 'vaultwarden']) {
      const row = serviceReaders[id](db); if (!row) continue;
      db.prepare(`UPDATE setup_${id} SET config_json=? WHERE id=1`).run(JSON.stringify({ ...row.config, allowedIps: review.after }));
    }
    const sso = ssoRow(db);
    if (sso && !sso.active) {
      const config = { ...JSON.parse(sso.config_json), recoveryNetworks: review.after }, revision = sso.revision + 1;
      const fingerprint = createHash('sha256').update(JSON.stringify({ revision, config })).digest('hex');
      db.prepare('UPDATE sso_config SET revision=?, config_json=?, fingerprint=?, verified_json=NULL, verified_at=NULL, job_id=NULL, route_job_id=NULL WHERE id=1 AND active=0').run(revision, JSON.stringify(config), fingerprint);
    }
    for (const r of review.routes) db.prepare('UPDATE service_http_routes SET ip_allowlist_json=? WHERE id=?').run(after, r.route_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  fence();
  const domains = [...new Set(review.routes.map((r) => r.hostname))];
  if (domains.length) await renderDomains({ db, domains, ...render, fence });
  return { created: [], existing: domains, conflicts: [], rendered: domains };
}
