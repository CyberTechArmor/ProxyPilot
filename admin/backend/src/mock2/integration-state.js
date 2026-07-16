// Mock2 integration-truthfulness STATE — the thin better-sqlite3 half (migration
// 520) behind the pure decision layers. Append-only + content-hashed so the
// records satisfy the constraint that gate outputs, verifications, and findings
// are hash-referenced from the applicable versioned record and never rewritten.
//
// The stub registry lives in the project REPO as state/stub-registry.json (like
// state/rules.md / state/acceptance.json — it must survive archive and be part of
// the hash-chained history); this module reads a supplied snapshot of it. The
// gate results, verification evidence, and findings live in mock2.db (queryable,
// orchestrator-owned) mirroring the change-record split (03-data-model.md).
//
// Native (getMock2Db) — reached only on an enabled host. Pure decisions are in
// stub-logic.js / verification-logic.js / integration-logic.js (unit-tested).
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { validateStubEntry } from './stub-logic.js';
import { contentHash } from './integration-enforcement.js';
import { requireActorId } from './verification-logic.js';

const nowIso = () => new Date().toISOString();

// ---- stub registry (state/stub-registry.json, read as a snapshot string) ----

export const STUB_REGISTRY_PATH = 'state/stub-registry.json';
export const STUB_REGISTRY_SCHEMA_VERSION = 1;

// Parse + validate the in-repo stub registry document. Tolerant: an absent or
// malformed file yields an empty registry (no approved simulations), never a throw.
export function parseStubRegistry(text) {
  let doc;
  try { doc = JSON.parse(String(text || '')); } catch { return { schema_version: STUB_REGISTRY_SCHEMA_VERSION, stubs: [] }; }
  if (!doc || typeof doc !== 'object') return { schema_version: STUB_REGISTRY_SCHEMA_VERSION, stubs: [] };
  const stubs = (Array.isArray(doc.stubs) ? doc.stubs : []).filter((s) => validateStubEntry(s).ok);
  return { schema_version: STUB_REGISTRY_SCHEMA_VERSION, stubs };
}

// Open (unresolved) approved simulations from a parsed registry — the input to
// the work-file context injection (stub-logic.stubContextForCycle).
export function listOpenStubs(registryText) {
  return parseStubRegistry(registryText).stubs.filter((s) => !s.status || s.status === 'open');
}

// ---- gate result (mock2_cycles.integration_gate_json + a queryable copy) ----

export function recordIntegrationGate(cycleId, decision) {
  const db = getMock2Db();
  try {
    db.prepare(`UPDATE mock2_cycles SET integration_gate_json = ? WHERE id = ?`)
      .run(JSON.stringify(decision), Number(cycleId));
  } catch (e) { console.warn('[mock2] integration gate result write failed:', e?.message); }
  return decision;
}

// ---- findings (append-only, hash-referenced) ----

// Persist integration-gate / screening / migration findings, each content-hashed
// and source-referenced (source_ref = the change record seq / framework audit id
// that produced it). Append-only: nothing here updates a prior finding's hash.
export function recordIntegrationFindings({ projectId, cycleId = null, origin, findings = [], frameworkVersionId = null, sourceRef = null }) {
  const db = getMock2Db();
  const insert = db.prepare(`
    INSERT INTO mock2_integration_findings
      (project_id, cycle_id, origin, kind, subsystem, file, detail, severity, blocking, status,
       framework_version_id, source_ref, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
  `);
  const out = [];
  const tx = db.transaction(() => {
    for (const f of findings) {
      const payload = {
        project_id: Number(projectId), cycle_id: cycleId == null ? null : Number(cycleId),
        origin, kind: f.kind, subsystem: f.subsystem || null, file: f.file || null,
        detail: typeof f.detail === 'string' ? f.detail : JSON.stringify(f.detail || f.message || {}),
        severity: f.severity || null, blocking: f.blocking ? 1 : 0,
        framework_version_id: frameworkVersionId ?? null, source_ref: sourceRef ?? null,
      };
      const hash = contentHash(payload);
      const info = insert.run(payload.project_id, payload.cycle_id, payload.origin, payload.kind,
        payload.subsystem, payload.file, payload.detail, payload.severity, payload.blocking,
        payload.framework_version_id, payload.source_ref, hash, nowIso());
      out.push(info.lastInsertRowid);
    }
  });
  try { tx(); } catch (e) { console.warn('[mock2] integration findings write failed:', e?.message); }
  return out;
}

// priorBlockedSignatures — the finding-set signatures of EARLIER blocked cycles
// in the same request (chronological), read from each cycle's stored gate result.
// The B.4 loop breaker compares the current block against these. Excludes the
// current cycle. Best-effort: an unreadable gate json contributes nothing.
export function priorBlockedSignatures(requestId, currentCycleId) {
  if (requestId == null) return [];
  const rows = getMock2Db()
    .prepare(`SELECT id, integration_gate_json FROM mock2_cycles WHERE request_id = ? AND id <> ? ORDER BY id ASC`)
    .all(Number(requestId), Number(currentCycleId || 0));
  const sigs = [];
  for (const r of rows) {
    if (!r.integration_gate_json) continue;
    try {
      const d = JSON.parse(r.integration_gate_json);
      if (d && d.blocking && d.finding_signature) sigs.push(d.finding_signature);
    } catch { /* skip unreadable */ }
  }
  return sigs;
}

export function listOpenIntegrationFindings(projectId, { subsystem = null } = {}) {
  const db = getMock2Db();
  if (subsystem) {
    return db.prepare(`SELECT * FROM mock2_integration_findings WHERE project_id = ? AND status = 'open' AND subsystem = ? ORDER BY id`).all(Number(projectId), subsystem);
  }
  return db.prepare(`SELECT * FROM mock2_integration_findings WHERE project_id = ? AND status = 'open' ORDER BY id`).all(Number(projectId));
}

// ---- operator-verification checklist (append-only evidence table) ----

// Open a verification checklist for a cycle: record each item as an unconfirmed
// row. Confirmations/waivers are SEPARATE append-only rows (recordVerification)
// so history is never mutated. Returns the item ids opened.
export function openVerificationChecklist({ projectId, cycleId, checklist = [] }) {
  // The checklist items themselves are stored on the cycle's gate json + surfaced
  // via the API; the mock2_integration_verifications table holds only actual
  // confirmations/waivers/ supersessions (evidence), so opening a checklist is a
  // no-op persistence-wise beyond the gate json already written. This function
  // exists so the runner has a single call site and the intent is explicit.
  return (checklist || []).map((c) => c.item_id);
}

// Append a confirmation / waiver as immutable evidence (validated upstream by
// verification-logic.validateConfirmation). supersedesId links a reverification
// to the record it replaces without mutating that record.
export function recordVerification(record) {
  const db = getMock2Db();
  const payload = {
    project_id: Number(record.project_id), cycle_id: record.cycle_id == null ? null : Number(record.cycle_id),
    item_id: record.item_id, manifest_id: record.manifest_id, manifest_hash: record.manifest_hash,
    subsystem: record.subsystem || null, operator_id: requireActorId(record.operator_id, 'operator_id'), role: record.role || 'operator',
    environment: record.environment, endpoint_classification: record.endpoint_classification,
    observed_result: record.observed_result || null, waived: record.waived ? 1 : 0,
    waiver_reason: record.waiver_reason || null, evidence_ref: record.evidence_ref || null,
    expires_at: record.expires_at || null, supersedes_id: record.supersedes_id ?? null,
  };
  const hash = contentHash(payload);
  const info = db.prepare(`
    INSERT INTO mock2_integration_verifications
      (project_id, cycle_id, item_id, manifest_id, manifest_hash, subsystem, operator_id, role,
       environment, endpoint_classification, observed_result, waived, waiver_reason, evidence_ref,
       expires_at, supersedes_id, content_hash, created_at)
    VALUES (@project_id, @cycle_id, @item_id, @manifest_id, @manifest_hash, @subsystem, @operator_id, @role,
       @environment, @endpoint_classification, @observed_result, @waived, @waiver_reason, @evidence_ref,
       @expires_at, @supersedes_id, @content_hash, @created_at)
  `).run({ ...payload, content_hash: hash, created_at: nowIso() });
  // Mark the superseded row (append-only: we set a superseded_at pointer, never
  // rewrite its content or hash).
  if (payload.supersedes_id != null) {
    try { db.prepare(`UPDATE mock2_integration_verifications SET superseded_at = ? WHERE id = ?`).run(nowIso(), Number(payload.supersedes_id)); } catch { /* best effort */ }
  }
  return db.prepare(`SELECT * FROM mock2_integration_verifications WHERE id = ?`).get(info.lastInsertRowid);
}

// The current (non-superseded) confirmations for a project's items.
export function listActiveVerifications(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_integration_verifications WHERE project_id = ? AND superseded_at IS NULL ORDER BY id`)
    .all(Number(projectId));
}

// projectChecklistItems(projectId) — PATCH2 B.2: every live-verification checklist
// item the project's cycles have produced, deduped by item_id keeping the LATEST
// (highest cycle id — its manifest_hash is current). This is the CAPABILITY-scoped
// set (a capability's live checks persist across cycles), the input to
// verification-logic.capabilityCheckStatus. Read from each cycle's stored gate
// result; best-effort on an unreadable json.
export function projectChecklistItems(projectId) {
  const rows = getMock2Db()
    .prepare(`SELECT id, integration_gate_json FROM mock2_cycles WHERE project_id = ? AND integration_gate_json IS NOT NULL ORDER BY id ASC`)
    .all(Number(projectId));
  const byItem = new Map();
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.integration_gate_json); } catch { continue; }
    for (const it of (d?.checklist || [])) {
      if (it && it.item_id) byItem.set(it.item_id, it); // later cycle wins
    }
  }
  return [...byItem.values()];
}

// ---- blocked-deviation resolutions (PATCH B.1 backfill + B.2 waiver) ----

// recordIntegrationResolution — append-only, content-hashed record of a resolution
// action on a blocked-deviation finding (migration 522). kind:
//   'manifest_backfill' — an operator declared an undeclared capability; the
//      committed manifest entry is stored (manifest_entry_json + hash), routed_to
//      'building' (the resume re-runs the gate against it).
//   'analysis_limitation_waiver' — an admin confirmed unprovable-but-real code;
//      the inspected file/function + the analyzer's stated limitation are stored,
//      routed_to 'pending-operator-verification' (NEVER 'succeeded'). A manifest
//      hash is stored so a manifest change re-opens the waiver.
export function recordIntegrationResolution(rec) {
  const db = getMock2Db();
  const payload = {
    project_id: Number(rec.project_id), cycle_id: rec.cycle_id == null ? null : Number(rec.cycle_id),
    kind: String(rec.kind), finding_class: rec.finding_class || null, finding_kind: rec.finding_kind || null,
    subsystem: rec.subsystem || null, file: rec.file || null, inspected: rec.inspected || null,
    analyzer_limitation: rec.analyzer_limitation || null,
    manifest_id: rec.manifest_id || null, manifest_hash: rec.manifest_hash || null,
    manifest_entry_json: rec.manifest_entry_json ? (typeof rec.manifest_entry_json === 'string' ? rec.manifest_entry_json : JSON.stringify(rec.manifest_entry_json)) : null,
    reason: rec.reason || null, routed_to: rec.routed_to || null,
    decided_by: requireActorId(rec.decided_by, 'decided_by'), role: rec.role || 'operator',
  };
  const hash = contentHash(payload);
  const info = db.prepare(`
    INSERT INTO mock2_integration_resolutions
      (project_id, cycle_id, kind, finding_class, finding_kind, subsystem, file, inspected,
       analyzer_limitation, manifest_id, manifest_hash, manifest_entry_json, reason, routed_to,
       decided_by, role, content_hash, created_at)
    VALUES (@project_id, @cycle_id, @kind, @finding_class, @finding_kind, @subsystem, @file, @inspected,
       @analyzer_limitation, @manifest_id, @manifest_hash, @manifest_entry_json, @reason, @routed_to,
       @decided_by, @role, @content_hash, @created_at)
  `).run({ ...payload, content_hash: hash, created_at: nowIso() });
  return db.prepare(`SELECT * FROM mock2_integration_resolutions WHERE id = ?`).get(info.lastInsertRowid);
}

export function listIntegrationResolutions(projectId, { cycleId = null } = {}) {
  const db = getMock2Db();
  if (cycleId != null) {
    return db.prepare(`SELECT * FROM mock2_integration_resolutions WHERE project_id = ? AND cycle_id = ? ORDER BY id`).all(Number(projectId), Number(cycleId));
  }
  return db.prepare(`SELECT * FROM mock2_integration_resolutions WHERE project_id = ? ORDER BY id`).all(Number(projectId));
}

// Active (non-superseded-by-manifest-change) analysis-limitation waivers for a
// project — a waiver whose stored manifest_hash still matches the current entry
// hash is live; a changed hash re-opens it (B.2 reverification trigger, enforced
// by the caller via verification-logic.supersessionNeeded).
export function listProvenanceWaivers(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_integration_resolutions WHERE project_id = ? AND kind = 'analysis_limitation_waiver' ORDER BY id`)
    .all(Number(projectId));
}
