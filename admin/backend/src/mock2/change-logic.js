// Mock2 change-record PURE hash-chain layer (Phase M6, 03-data-model.md). The
// change record is append-only and hash-chained: each row's
//   hash = sha256(prev_hash + canonical_json(payload))
// with prev_hash = '' for seq 1. The chain is the audit spine — it must verify,
// so the canonicalization and the hash function are pure and unit-tested
// (stub-first, risk R9), and change-records.js (the native half) computes hashes
// through THESE functions so what's stored and what verifies can never diverge.
//
// crypto is a Node stdlib module (not better-sqlite3), so importing it keeps this
// module native-free and test-safe.
//
// Terminology (risk R7): nothing here is named "agent".

import { createHash } from 'crypto';

// Deterministic JSON: object keys sorted recursively, arrays kept in order,
// primitives untouched. A single canonical form is what makes the chain
// reproducible across processes and machines (a re-serialize on a different
// host must produce byte-identical input to the hash).
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

// The stable subset of a change record that the hash covers. Deliberately the
// fields that describe WHAT the checkpoint recorded — not the DB id (assigned by
// SQLite, not part of the intent). seq + prev_hash chain it; the rest is the
// content the record attests to.
export function changePayload(record = {}) {
  return {
    project_id: record.project_id ?? null,
    cycle_id: record.cycle_id ?? null,
    seq: record.seq ?? null,
    initiated_by: record.initiated_by ?? null,
    acting_as_admin: record.acting_as_admin ? 1 : 0,
    framework_version: record.framework_version ?? null,
    framework_version_id: record.framework_version_id ?? null,
    rules_touched: record.rules_touched ?? null,
    gates_run: record.gates_run ?? null,
    commit_sha: record.commit_sha ?? null,
    summary: record.summary ?? '',
    created_at: record.created_at ?? null,
  };
}

// hash = sha256(prev_hash + canonical_json(payload)). prev_hash is '' for the
// first record in a project's chain.
export function computeChangeHash(prevHash, record) {
  const payload = changePayload(record);
  return createHash('sha256').update(String(prevHash || '') + canonicalJson(payload)).digest('hex');
}

// verifyChangeChain — recompute every hash from its predecessor and confirm it
// matches what was stored. Rows must be in ascending seq order. Returns
//   { ok, count, brokenAt } — brokenAt is the seq of the first mismatch, or null.
// Also catches a broken prev_hash link (a row whose prev_hash isn't the previous
// row's stored hash) and a seq gap.
export function verifyChangeChain(rows = []) {
  let prevHash = '';
  let prevSeq = 0;
  for (const row of rows) {
    // Sequence must be strictly increasing and contiguous from 1.
    if (Number(row.seq) !== prevSeq + 1) {
      return { ok: false, count: rows.length, brokenAt: row.seq, reason: 'sequence gap or misorder' };
    }
    // The stored prev_hash must equal the running hash.
    if (String(row.prev_hash || '') !== prevHash) {
      return { ok: false, count: rows.length, brokenAt: row.seq, reason: 'prev_hash link mismatch' };
    }
    const expected = computeChangeHash(prevHash, row);
    if (row.hash !== expected) {
      return { ok: false, count: rows.length, brokenAt: row.seq, reason: 'hash mismatch' };
    }
    prevHash = row.hash;
    prevSeq = Number(row.seq);
  }
  return { ok: true, count: rows.length, brokenAt: null, reason: null };
}

// The in-repo mirror of a change record (03-data-model.md: state/changes/<seq>.json)
// so rehydrate restores the readable history even if mock2.db is lost. The mirror
// carries the hashes too, so a repo-only verify is possible.
export function changeRecordFile(row) {
  return {
    seq: row.seq,
    prev_hash: row.prev_hash,
    hash: row.hash,
    ...changePayload(row),
  };
}
