// Mock2 change-record data access (mock2_change_records, in mock2.db) — Phase M6.
// Append-only and hash-chained (03-data-model.md): one record per checkpoint,
// each chained to the last by sha256(prev_hash + canonical_json(payload)). The
// chain is the audit spine and MUST verify — the hashing itself is the pure
// change-logic.js so what's stored and what verifies can never diverge.
//
// Records are ALSO mirrored to the repo as state/changes/<seq>.json on each
// checkpoint (the runner writes the mirror into the container working tree so it
// rides the next push); the DB rows are the queryable, hash-chained source of
// truth. Native (getMock2Db) — reached only on an enabled host.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { computeChangeHash, verifyChangeChain, changeRecordFile } from './change-logic.js';

const nowIso = () => new Date().toISOString();

export function listChangeRecords(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_change_records WHERE project_id = ? ORDER BY seq ASC`)
    .all(Number(projectId));
}

export function lastChangeRecord(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_change_records WHERE project_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(Number(projectId));
}

// Insert a hash-chained change record for a checkpoint. seq and prev_hash are
// derived inside a transaction from the project's last record, so concurrent
// checkpoints can't collide or fork the chain (the lock already serializes work
// per project, but the transaction is the correctness guarantee — risk R4). The
// hash is computed through the pure change-logic so it matches verification.
export function insertChangeRecord({
  projectId, cycleId = null, initiatedBy, actingAsAdmin = 0,
  frameworkVersion, frameworkVersionId, rulesTouched = null, gatesRun = null,
  commitSha = null, summary,
}) {
  const db = getMock2Db();
  let row;
  const tx = db.transaction(() => {
    const last = lastChangeRecord(projectId);
    const seq = last ? Number(last.seq) + 1 : 1;
    const prevHash = last ? last.hash : '';
    const createdAt = nowIso();
    const record = {
      project_id: Number(projectId),
      cycle_id: cycleId == null ? null : Number(cycleId),
      seq,
      initiated_by: initiatedBy ?? null,
      acting_as_admin: actingAsAdmin ? 1 : 0,
      framework_version: Number(frameworkVersion),
      framework_version_id: Number(frameworkVersionId),
      rules_touched: rulesTouched == null ? null : (typeof rulesTouched === 'string' ? rulesTouched : JSON.stringify(rulesTouched)),
      gates_run: gatesRun == null ? null : (typeof gatesRun === 'string' ? gatesRun : JSON.stringify(gatesRun)),
      commit_sha: commitSha,
      summary: String(summary || ''),
      created_at: createdAt,
    };
    const hash = computeChangeHash(prevHash, record);
    const info = db
      .prepare(
        `INSERT INTO mock2_change_records
           (project_id, cycle_id, seq, prev_hash, hash, initiated_by, acting_as_admin,
            framework_version, framework_version_id, rules_touched, gates_run, commit_sha, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.project_id, record.cycle_id, seq, prevHash, hash, record.initiated_by, record.acting_as_admin,
        record.framework_version, record.framework_version_id, record.rules_touched, record.gates_run,
        record.commit_sha, record.summary, createdAt);
    row = db.prepare(`SELECT * FROM mock2_change_records WHERE id = ?`).get(info.lastInsertRowid);
  });
  tx();
  return row;
}

// Verify a project's whole chain (M10 exposes this as /verify-chain; M6 uses it
// in the verify checklist). Reads the rows in seq order and recomputes.
export function verifyProjectChain(projectId) {
  return verifyChangeChain(listChangeRecords(projectId));
}

// The in-repo mirror JSON for a record (state/changes/<seq>.json). The runner
// writes this into the container so rehydrate restores readable history even if
// mock2.db is lost.
export function changeRecordMirror(row) {
  return changeRecordFile(row);
}
