// Declared egress grants — the DB store (mock2_egress_grants, in mock2.db).
//
// The host-acting half of the declared-egress feature (extends the ADR-005
// "declared, never discovered" discipline to egress; the fence is ADR-010). The pure
// decision layer (parse, validate, nft render) is egress-logic.js; this file is
// the durable store + the admin-queue coupling, so it imports better-sqlite3 (via
// getMock2Db) and the queue helpers. Reached only on an enabled host through the
// gated router, never from tests (which import egress-logic.js directly).
//
// Lifecycle of a grant:
//   declared (mock2.yaml egress:) → syncDeclaredEgress inserts a `pending` row +
//   raises an `egress_grant` admin-queue item → an admin approves (grant→approved,
//   queue→resolved) or denies (grant→denied, queue→dismissed) → the fence
//   reconcile wires ONLY approved grants → removing the declaration revokes it
//   (grant→revoked) so the next reconcile drops the rule.
//
// Nothing here is inferred: a grant exists only because the app declared it, and
// it is wired only because an admin approved it.

import { getMock2Db } from './db.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';
import { grantKey, normalizeProtocol, isEgressHost, isEgressPort, validateOperatorEgressInput } from './egress-logic.js';
import { probeHostReachable } from './network.js';

// The queue dedupe_key for a grant — stable per (project, host, port, protocol) so
// a re-declared entry re-opens the same queue row rather than piling up.
export function egressQueueKey(projectId, g) {
  return `egress:${Number(projectId)}:${grantKey(g)}`;
}

function shortDetail(g) {
  const reason = String(g.reason || '').trim();
  return `Egress to ${g.host}:${g.port}/${g.protocol}${reason ? ` — ${reason}` : ''}`;
}

export function getEgressGrant(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_egress_grants WHERE id = ?`).get(Number(id));
}

export function listEgressGrants(projectId, { status = null } = {}) {
  const db = getMock2Db();
  if (status) {
    return db.prepare(
      `SELECT * FROM mock2_egress_grants WHERE project_id = ? AND status = ? ORDER BY requested_at DESC, id DESC`,
    ).all(Number(projectId), status);
  }
  return db.prepare(
    `SELECT * FROM mock2_egress_grants WHERE project_id = ? ORDER BY requested_at DESC, id DESC`,
  ).all(Number(projectId));
}

// APPROVED grants for a project — the only ones the fence ever wires.
export function listApprovedEgressGrants(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_egress_grants WHERE project_id = ? AND status = 'approved' ORDER BY id`)
    .all(Number(projectId));
}

// syncDeclaredEgress(projectId, declared) — reconcile the parsed mock2.yaml
// `egress:` list against the stored grants for a project. Called on deploy (the
// app's declaration is the source of truth):
//   * a declared entry with no stored grant → INSERT a `pending` row + raise an
//     `egress_grant` queue item (admin must approve before it is wired).
//   * a declared entry whose stored grant is `denied`/`revoked` → left as-is
//     (an admin's decision is sticky; re-declaring does not silently re-request,
//     but re-opening it is a manual admin action). A `pending`/`approved` grant
//     is kept.
//   * a stored grant NO LONGER declared → REVOKE it (status→revoked) and resolve
//     its queue item, so the next fence reconcile removes the rule.
// Returns { added, revoked, pending, approved } id lists for the caller to log.
export function syncDeclaredEgress(projectId, declared = []) {
  const db = getMock2Db();
  const pid = Number(projectId);
  const decl = [];
  const declKeys = new Set();
  for (const d of declared) {
    const protocol = normalizeProtocol(d.protocol);
    if (!isEgressHost(d.host) || !isEgressPort(d.port) || !protocol) continue;
    const g = { host: String(d.host).trim().toLowerCase(), port: Number(d.port), protocol, reason: String(d.reason || '').trim() };
    const k = grantKey(g);
    if (declKeys.has(k)) continue;
    declKeys.add(k);
    decl.push(g);
  }

  const existing = db.prepare(`SELECT * FROM mock2_egress_grants WHERE project_id = ?`).all(pid);
  const byKey = new Map(existing.map((r) => [grantKey(r), r]));

  const added = [];
  for (const g of decl) {
    const k = grantKey(g);
    const row = byKey.get(k);
    if (!row) {
      const r = db.prepare(
        `INSERT INTO mock2_egress_grants (project_id, host, port, protocol, reason, status, requested_at)
         VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      ).run(pid, g.host, g.port, g.protocol, g.reason || null);
      const id = Number(r.lastInsertRowid);
      added.push(id);
      raiseQueueItem({
        kind: 'egress_grant',
        dedupe_key: egressQueueKey(pid, g),
        ref_table: 'mock2_egress_grants',
        ref_id: id,
        detail: shortDetail(g),
        project_id: pid,
      });
    } else if (row.reason !== (g.reason || null) && (row.status === 'pending' || row.status === 'approved')) {
      // Keep the reason text fresh on a still-live grant (the declaration is the
      // source of truth for why); never touches an admin's status decision.
      db.prepare(`UPDATE mock2_egress_grants SET reason = ? WHERE id = ?`).run(g.reason || null, row.id);
    }
  }

  const revoked = [];
  for (const row of existing) {
    // Operator-initiated grants are NOT reconciled against mock2.yaml — an admin
    // opened them directly, so a declaration sweep must never revoke them.
    if (row.origin === 'operator') continue;
    if (declKeys.has(grantKey(row))) continue;      // still declared
    if (row.status === 'revoked' || row.status === 'denied') continue;
    db.prepare(`UPDATE mock2_egress_grants SET status = 'revoked', decided_at = datetime('now') WHERE id = ?`).run(row.id);
    revoked.push(row.id);
    try { resolveQueueItem(egressQueueKey(pid, row), { resolution: 'egress declaration removed' }); } catch { /* best effort */ }
  }

  const after = db.prepare(`SELECT id, status FROM mock2_egress_grants WHERE project_id = ?`).all(pid);
  return {
    added,
    revoked,
    pending: after.filter((r) => r.status === 'pending').map((r) => r.id),
    approved: after.filter((r) => r.status === 'approved').map((r) => r.id),
  };
}

// setEgressGrantStatus(id, status, { decidedBy }) — the admin decision. Approving
// or denying stamps who + when; the fence reconcile keys off `approved`. Returns
// the updated row.
export function setEgressGrantStatus(id, status, { decidedBy = null } = {}) {
  if (!['pending', 'approved', 'denied', 'revoked'].includes(status)) throw new Error(`bad egress status ${status}`);
  getMock2Db().prepare(
    `UPDATE mock2_egress_grants
        SET status = ?, decided_by = ?, decided_at = datetime('now')
      WHERE id = ?`,
  ).run(status, decidedBy == null ? null : Number(decidedBy), Number(id));
  return getEgressGrant(id);
}

// insertOperatorEgressGrant — an ADMIN opens the build fence to a LAN/external
// host:port directly, independent of any mock2.yaml declaration. The grant is
// created ALREADY APPROVED with origin 'operator' (the admin IS the approval), so
// the next reconcileMock2Firewall punches the scoped allow-hole. Idempotent on
// (project, host, port, protocol): an existing row is re-approved and re-stamped
// with origin 'operator' rather than duplicated. Returns { ok, grant } or
// { ok:false, error }.
export function insertOperatorEgressGrant({ projectId, host, port, protocol = 'tcp', reason = '', decidedBy = null }) {
  const v = validateOperatorEgressInput({ host, port, protocol });
  if (!v.ok) return v;
  const db = getMock2Db();
  const pid = Number(projectId);
  const existing = db.prepare(
    `SELECT * FROM mock2_egress_grants WHERE project_id = ? AND host = ? AND port = ? AND protocol = ?`,
  ).get(pid, v.host, v.port, v.protocol);
  if (existing) {
    db.prepare(
      `UPDATE mock2_egress_grants
          SET status = 'approved', origin = 'operator', reason = ?, decided_by = ?, decided_at = datetime('now')
        WHERE id = ?`,
    ).run(String(reason || '').trim() || existing.reason || null, decidedBy == null ? null : Number(decidedBy), existing.id);
    return { ok: true, grant: getEgressGrant(existing.id), reused: true };
  }
  const r = db.prepare(
    `INSERT INTO mock2_egress_grants (project_id, host, port, protocol, reason, status, origin, requested_at, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, 'approved', 'operator', datetime('now'), ?, datetime('now'))`,
  ).run(pid, v.host, v.port, v.protocol, String(reason || '').trim() || null, decidedBy == null ? null : Number(decidedBy));
  return { ok: true, grant: getEgressGrant(Number(r.lastInsertRowid)) };
}

// probeEgressGrants(ids) — measure host reachability for a set of grants and
// record it (acceptance #5: validate the HOST can route to the destination FIRST,
// so a blocked outbound reads as policy vs host-down). Called on a fresh
// declaration so the pending grant already shows "host reachable" / "no route
// from host" before an admin decides, and again at approval. Best-effort per
// grant; a probe failure just leaves `reachable` unset. Never throws.
export async function probeEgressGrants(ids = []) {
  for (const id of ids) {
    const g = getEgressGrant(id);
    if (!g) continue;
    const probe = await probeHostReachable(g.host, g.port).catch(() => null);
    if (probe && probe.reachable) setEgressGrantReachable(id, probe.reachable);
  }
}

// setEgressGrantReachable(id, reachable) — record the host-reachability probe
// result (network.js probeHostReachable) on the grant, so the admin and the build
// cycle can see whether the HOST can even route to the destination (acceptance
// #5) before/independent of the wiring. One of ok/refused/timeout/unreachable/
// dns_fail (or null before a probe).
export function setEgressGrantReachable(id, reachable) {
  getMock2Db().prepare(`UPDATE mock2_egress_grants SET reachable = ? WHERE id = ?`).run(reachable == null ? null : String(reachable), Number(id));
  return getEgressGrant(id);
}
