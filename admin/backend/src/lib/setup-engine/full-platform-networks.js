// Restricted networks after apply (3f): a reviewed change of the ADDITIONAL
// addresses, with the effective allowlist re-rendered.
//
//   networksReview(db, additional)          → preview + reviewToken (inert)
//   queueNetworksChange(db, input, by, via) → the update_platform_networks backend step
//   applyNetworksChange(db, { job, fence, render }) → that step: rows, then re-render
//   vpnFollowReview / queueVpnFollow        → the same step, queued by the system
//                                             when the VPN subnet changed
//   refreshVpnNetworks(db, { readStatus })  → observe the VPN, record it, follow it
//
// The effective allowlist of local recovery and every restricted platform
// route is (built-in VPN networks) ∪ (additional addresses) — see
// platform-networks.js. VPN networks are derived and never edited here; the
// additional list is edited at any time, INCLUDING after SSO is active: the
// restricted networks are not part of the SSO fingerprint, so the SSO record's
// list is rewritten in place and its verification stands. /0 and an empty
// effective list are refused. The review lists every route whose allowlist
// changes and every record that carries the list; the step rewrites exactly
// those, under the backend's route leases, and re-renders the hostnames.
// Dashboard changes need fresh local step-up and are audited by the route.

import { z } from 'zod';
import { readFullPlatform, installedTargets, digest, fail } from './full-platform-store.js';
import { serviceReaders } from './full-platform-services.js';
import { ownedRoute } from './full-platform-mcp.js';
import { createJob, getJob, jobView } from './store.js';
import { validateRouteEdgeOptions } from '../caddy-site-file.js';
import { renderDomains } from '../route-render.js';
import { vpnNetworks, vpnFromStatus, recordVpnNetworks, additionalOf, effectiveNetworks } from './platform-networks.js';
import { refreshAdminSnippet } from './platform-access.js';

export const NETWORKS_APP = 'pp-platform-networks';
export const NETWORKS_KIND = 'update_platform_networks';
const OPEN = ['queued', 'running'];
const has = (db, t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
const RECOVERY_ROUTE = 'proxypilot-local-recovery';
export const networksSchema = z.object({ revision: z.number().int().positive(), reviewToken: z.string().regex(/^[a-f0-9]{64}$/), additionalNetworks: z.array(z.string().max(50)).max(30), reviewed: z.literal(true) }).strict();

/** The additional list as entered: trimmed, de-duplicated, no /0, each a valid IP/CIDR. May be empty. */
export function normalizeAdditional(list) {
  if (!Array.isArray(list)) throw fail('additional networks must be a list of IP addresses or CIDRs.', 'FULL_PLATFORM_NETWORKS_INVALID');
  const out = [...new Set(list.map((n) => String(n).trim()).filter(Boolean))];
  if (out.some((n) => /\/0$/.test(n))) throw fail('Unrestricted access (/0) is refused. Add specific administrator addresses or networks.', 'FULL_PLATFORM_NETWORKS_INVALID');
  if (out.length) { const v = validateRouteEdgeOptions({ ip_allowlist: out }); if (v.error) throw fail(v.error, 'FULL_PLATFORM_NETWORKS_INVALID'); }
  return out;
}

/** Effective = VPN ∪ additional; an empty effective list would remove the restriction and is refused. */
export function normalizeNetworks(list, vpn = []) {
  const out = effectiveNetworks(vpn, normalizeAdditional(list));
  if (!out.length) throw fail('At least one restricted network is required. The VPN is not enabled here, so add at least one administrator address; an empty list would remove the restriction.', 'FULL_PLATFORM_NETWORKS_INVALID');
  return out;
}

function ssoRow(db) { return has(db, 'sso_config') ? db.prepare('SELECT * FROM sso_config WHERE id=1').get() || null : null; }

/** Preview of a restricted-network change. Throws only for an invalid list or no saved setup. */
export function networksReview(db, additional, { ignoreJob = null, vpn = vpnNetworks(db) } = {}) {
  const full = readFullPlatform(db);
  if (!full) throw fail('No Full Platform setup is saved.');
  const extra = normalizeAdditional(additional);
  const after = normalizeNetworks(extra, vpn), before = full.config.recoveryNetworks || [];
  const beforeAdditional = additionalOf(full.config, vpn);
  const blockers = [];
  const prior = full.last_job_id && getJob(db, full.last_job_id);
  if (prior && prior.id !== ignoreJob && OPEN.includes(prior.status)) blockers.push(`Operation ${prior.id} is ${prior.status}. Wait for it before changing the restricted networks.`);
  const targets = installedTargets(db);
  const records = [{ record: 'setup_full_platform', what: 'saved Full Platform plan (additionalNetworks and the effective list)' }];
  const routeIds = [];
  for (const id of ['infisical', 'openbao', 'vaultwarden']) {
    const row = serviceReaders[id](db);
    if (!row) continue;
    records.push({ record: `setup_${id}`, what: `${id} service record (allowedIps)` });
    if (targets[id]?.mode === 'install') { const r = ownedRoute(id, row); if (r) routeIds.push(r.route_id); }
    const last = row.last_job_id && getJob(db, row.last_job_id);
    if (last && OPEN.includes(last.status) && last.id !== ignoreJob) blockers.push(`${id} job ${last.id} is ${last.status}. Wait for it.`);
  }
  // Keycloak's /admin, when restricted (platform-access.js), carries the same list.
  const kc = targets.keycloak?.row;
  if (kc?.ownership === 'managed' && has(db, 'service_http_routes') && db.prepare('SELECT ip_allowlist_json FROM service_http_routes WHERE id=?').get(`keycloak-route-${kc.id}`)?.ip_allowlist_json) routeIds.push(`keycloak-route-${kc.id}`);
  const sso = ssoRow(db);
  if (sso) { records.push({ record: 'sso_config', what: `ProxyPilot SSO record (recoveryNetworks), rewritten in place — ${sso.active ? 'SSO stays active and verified' : 'its verification stands'}; the networks are not part of the SSO fingerprint` }); routeIds.push(RECOVERY_ROUTE); }
  const routes = has(db, 'service_http_routes') ? routeIds.map((id) => db.prepare('SELECT id, domain, ip_allowlist_json FROM service_http_routes WHERE id=?').get(id)).filter(Boolean).map((r) => ({ route_id: r.id, hostname: r.domain, before: r.ip_allowlist_json ? JSON.parse(r.ip_allowlist_json) : null, after })) : [];
  const stale = routes.some((r) => digest(r.before) !== digest(after));
  if (digest(before) === digest(after) && digest(beforeAdditional) === digest(extra) && !stale) blockers.push('The restricted networks are already exactly these.');
  const reviewToken = digest({ revision: full.revision, vpn, before, after, additional: extra, routes, records: records.map((r) => r.record), blockers });
  return { revision: full.revision, vpn_networks: vpn, additional_networks: extra, before_additional: beforeAdditional, before, after, routes, records, blockers, reviewToken,
    effects: ['Rewrites the effective allowlist (VPN networks + additional addresses) on each listed route and record, then re-renders those hostnames in Caddy (validated before reload). The change is live when the step finishes.', 'Nothing else in the plan changes; no container is restarted; SSO verification and activation are unaffected.'] };
}

function queue(db, review, by, via, reason) {
  const full = readFullPlatform(db);
  // The review token is kept in state only: a job plan is redacted on write
  // (SECRET_KEY_RE matches "token"), so it could never be compared later.
  const job = createJob(db, { app: NETWORKS_APP, kind: NETWORKS_KIND, plan: { params: { revision: full.revision } }, requestedBy: by, via, retryOf: full.last_job_id, reason });
  const state = { ...full.state, networksChange: { additional: review.additional_networks, vpn: review.vpn_networks, networks: review.after, reviewToken: review.reviewToken, job: job.id } };
  db.prepare('UPDATE setup_full_platform SET state_json=?,last_job_id=? WHERE id=1').run(JSON.stringify(state), job.id);
  return job;
}

export function queueNetworksChange(db, raw, by, { via = 'ui' } = {}) {
  const p = networksSchema.parse(raw);
  db.exec('BEGIN IMMEDIATE');
  try {
    const full = readFullPlatform(db), review = networksReview(db, p.additionalNetworks);
    if (!full || p.revision !== full.revision || p.reviewToken !== review.reviewToken) throw fail('The network change preview is stale. Review it again.', 'NETWORKS_REVIEW_STALE');
    if (review.blockers.length) throw fail(review.blockers.join(' '), 'NETWORKS_BLOCKED');
    const job = queue(db, review, by, via, `Reviewed restricted-network change: VPN ${review.vpn_networks.join(', ') || 'none'} + additional ${review.additional_networks.join(', ') || 'none'}.`);
    db.exec('COMMIT');
    return { job: jobView(job), created: true, review };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Does the applied allowlist lag the VPN networks? (the VPN subnet changed, or was first observed) → review + due, or null */
export function vpnFollowReview(db) {
  const full = readFullPlatform(db);
  if (!full?.approved_revision) return null;
  const vpn = vpnNetworks(db), additional = additionalOf(full.config, vpn);
  let review; try { review = networksReview(db, additional, { vpn }); } catch { return null; }
  return { ...review, due: !review.blockers.some((b) => /already exactly/.test(b)) };
}

/** Queue the step that follows a VPN change. Returns { job, review }, or null when nothing is due or it must wait. */
export function queueVpnFollow(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const review = vpnFollowReview(db);
    if (!review?.due || review.blockers.length) { db.exec('COMMIT'); return null; }
    const job = queue(db, review, 'vpn-sync', 'system', `The VPN networks changed (${review.vpn_networks.join(', ') || 'VPN disabled'}); re-rendering the restricted allowlist with the additional addresses.`);
    db.exec('COMMIT');
    return { job: jobView(job), review };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * Observe the VPN (readStatus → `proxypilot --json vpn status`), record its
 * networks, and when the applied allowlist no longer matches, queue the step.
 * An unreadable status changes nothing. → { observed, before, changed, queued }
 */
export async function refreshVpnNetworks(db, { readStatus }) {
  let status = null; try { status = await readStatus(); } catch { status = null; }
  const observed = vpnFromStatus(status);
  if (!observed) return { observed: null, changed: false, queued: null };
  const { changed, before, after } = recordVpnNetworks(db, observed);
  const queued = queueVpnFollow(db);
  return { observed: after, before, changed, queued };
}

/** The backend step: rewrite the reviewed rows, then re-render the affected hostnames. */
export async function applyNetworksChange(db, { jobId, fence, render }) {
  const full = readFullPlatform(db), change = full?.state?.networksChange;
  if (!full || !change || change.job !== jobId || full.last_job_id !== jobId) throw fail('Superseded restricted-network change.');
  const review = networksReview(db, change.additional ?? change.networks, { ignoreJob: jobId, vpn: change.vpn ?? vpnNetworks(db) });
  if (review.blockers.length) throw fail(`${review.blockers.join(' ')} Nothing was changed.`);
  if (review.reviewToken !== change.reviewToken) throw fail('The routes or records changed after review. Nothing was changed; review the network change again.');
  const after = JSON.stringify(review.after);
  fence();
  db.exec('BEGIN IMMEDIATE');
  try {
    const state = { ...full.state }; delete state.networksChange;
    db.prepare('UPDATE setup_full_platform SET config_json=?, state_json=? WHERE id=1 AND last_job_id=?').run(JSON.stringify({ ...full.config, additionalNetworks: review.additional_networks, recoveryNetworks: review.after }), JSON.stringify(state), jobId);
    for (const id of ['infisical', 'openbao', 'vaultwarden']) {
      const row = serviceReaders[id](db); if (!row) continue;
      db.prepare(`UPDATE setup_${id} SET config_json=? WHERE id=1`).run(JSON.stringify({ ...row.config, allowedIps: review.after }));
    }
    // In place, active or not: the list is outside the SSO fingerprint, so the
    // revision, fingerprint, verification and activation all stand.
    if (ssoRow(db)) db.prepare("UPDATE sso_config SET config_json=json_set(config_json, '$.recoveryNetworks', json(?)) WHERE id=1").run(after);
    for (const r of review.routes) db.prepare('UPDATE service_http_routes SET ip_allowlist_json=? WHERE id=?').run(after, r.route_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  fence();
  // A VPN-only dashboard follows the same list (its snippet is reloaded with the domains below).
  refreshAdminSnippet(db, review.after);
  const domains = [...new Set(review.routes.map((r) => r.hostname))];
  if (domains.length) await renderDomains({ db, domains, ...render, fence });
  return { created: [], existing: domains, conflicts: [], rendered: domains };
}
