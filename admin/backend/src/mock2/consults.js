// Mock2 consult data access (mock2_consults, migration 515). One row per escalation
// "second opinion" (the bounded, advisory-only Fable 5 call). Each consult is its own
// cost SEGMENT in the request roll-up. The caps (1/halt, 2/request) are enforced from
// these counts by consult-logic.consultAllowed.
//
// Native (getMock2Db) — reached only on an enabled host.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';

const nowIso = () => new Date().toISOString();

export function getConsult(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_consults WHERE id = ?`).get(Number(id));
}

export function listConsultsForRequest(requestId) {
  if (requestId == null) return [];
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_consults WHERE request_id = ? ORDER BY id ASC`)
    .all(Number(requestId));
}

export function listConsultsForCycle(cycleId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_consults WHERE cycle_id = ? ORDER BY id ASC`)
    .all(Number(cycleId));
}

// Cap inputs: how many consults already fired for this halt (cycle) and this request.
export function countConsultsForCycle(cycleId) {
  return getMock2Db().prepare(`SELECT COUNT(*) AS n FROM mock2_consults WHERE cycle_id = ?`).get(Number(cycleId)).n;
}

export function countConsultsForRequest(requestId) {
  if (requestId == null) return 0;
  return getMock2Db().prepare(`SELECT COUNT(*) AS n FROM mock2_consults WHERE request_id = ?`).get(Number(requestId)).n;
}

export function insertConsult({
  projectId, requestId = null, cycleId = null, trigger, model = null,
  inputTokens = 0, outputTokens = 0, costCents = 0,
  diagnosis = null, paths = null, suggestedResume = null, requestedBy = null,
}) {
  const info = getMock2Db()
    .prepare(
      `INSERT INTO mock2_consults
         (project_id, request_id, cycle_id, trigger, model, input_tokens, output_tokens, cost_cents,
          diagnosis, paths_json, suggested_resume, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Number(projectId), requestId == null ? null : Number(requestId), cycleId == null ? null : Number(cycleId),
      String(trigger), model == null ? null : String(model),
      Math.round(Number(inputTokens) || 0), Math.round(Number(outputTokens) || 0), Number(costCents) || 0,
      diagnosis == null ? null : String(diagnosis),
      paths == null ? null : (typeof paths === 'string' ? paths : JSON.stringify(paths)),
      suggestedResume == null ? null : String(suggestedResume),
      requestedBy ?? null, nowIso(),
    );
  return getConsult(info.lastInsertRowid);
}

// Client-safe view (also the shape request-log folds into its consult segments).
export function publicConsultShape(row) {
  if (!row) return null;
  let paths = [];
  if (row.paths_json) { try { paths = JSON.parse(row.paths_json); } catch { paths = []; } }
  return {
    id: row.id,
    project_id: row.project_id,
    request_id: row.request_id ?? null,
    cycle_id: row.cycle_id ?? null,
    trigger: row.trigger,
    model: row.model || null,
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    cost_cents: row.cost_cents ?? 0,
    diagnosis: row.diagnosis || null,
    paths,
    suggested_resume: row.suggested_resume || null,
    created_at: row.created_at || null,
  };
}
