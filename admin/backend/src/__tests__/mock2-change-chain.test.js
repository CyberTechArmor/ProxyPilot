// Mock2 Phase M6 tests — the change-record hash chain (03-data-model.md).
//
// Stub-first (risk R9): imports ONLY change-logic.js (crypto is Node stdlib, not
// better-sqlite3). The chain is the audit spine — it MUST verify, and a tamper
// MUST be caught — so both are unit-tested here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalJson, changePayload, computeChangeHash, verifyChangeChain, changeRecordFile,
} from '../mock2/change-logic.js';

test('canonicalJson: keys sorted recursively, arrays preserved', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ z: { y: 1, x: 2 }, a: [3, 1, 2] }), '{"a":[3,1,2],"z":{"x":2,"y":1}}');
  // deterministic regardless of insertion order
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test('computeChangeHash: seq 1 uses empty prev_hash, chains deterministically', () => {
  const r1 = { project_id: 1, cycle_id: 5, seq: 1, initiated_by: 3, framework_version: 1, framework_version_id: 1, summary: 'first', created_at: '2026-07-10T00:00:00Z' };
  const h1 = computeChangeHash('', r1);
  assert.match(h1, /^[0-9a-f]{64}$/);
  // stable across calls
  assert.equal(computeChangeHash('', r1), h1);
  // a different prev_hash yields a different hash
  assert.notEqual(computeChangeHash('deadbeef', r1), h1);
});

test('changePayload: excludes the DB id (not part of intent)', () => {
  const p = changePayload({ id: 999, project_id: 1, seq: 1, summary: 's' });
  assert.equal('id' in p, false);
  assert.equal(p.summary, 's');
});

function buildChain() {
  const rows = [];
  let prev = '';
  const base = [
    { project_id: 1, cycle_id: 5, seq: 1, initiated_by: 3, acting_as_admin: 0, framework_version: 1, framework_version_id: 1, gates_run: '[]', commit_sha: 'a1', summary: 'seq1', created_at: 't1' },
    { project_id: 1, cycle_id: 6, seq: 2, initiated_by: 3, acting_as_admin: 0, framework_version: 1, framework_version_id: 1, gates_run: '[]', commit_sha: 'a2', summary: 'seq2', created_at: 't2' },
    { project_id: 1, cycle_id: 7, seq: 3, initiated_by: 4, acting_as_admin: 1, framework_version: 2, framework_version_id: 3, gates_run: '[]', commit_sha: 'a3', summary: 'seq3', created_at: 't3' },
  ];
  for (const b of base) {
    const hash = computeChangeHash(prev, b);
    rows.push({ ...b, prev_hash: prev, hash });
    prev = hash;
  }
  return rows;
}

test('verifyChangeChain: a well-formed chain verifies', () => {
  const r = verifyChangeChain(buildChain());
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.equal(r.brokenAt, null);
});

test('verifyChangeChain: empty chain is trivially ok', () => {
  assert.equal(verifyChangeChain([]).ok, true);
});

test('verifyChangeChain: catches a tampered payload', () => {
  const chain = buildChain();
  chain[1].summary = 'TAMPERED'; // hash no longer matches the payload
  const r = verifyChangeChain(chain);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 2);
  assert.match(r.reason, /hash mismatch/);
});

test('verifyChangeChain: catches a broken prev_hash link', () => {
  const chain = buildChain();
  chain[2].prev_hash = 'not-the-previous-hash';
  const r = verifyChangeChain(chain);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 3);
  assert.match(r.reason, /link mismatch/);
});

test('verifyChangeChain: catches a sequence gap', () => {
  const chain = buildChain();
  chain[1].seq = 5; // gap
  const r = verifyChangeChain(chain);
  assert.equal(r.ok, false);
  assert.match(r.reason, /sequence/);
});

test('changeRecordFile: mirror carries hashes + payload', () => {
  const chain = buildChain();
  const mirror = changeRecordFile(chain[0]);
  assert.equal(mirror.seq, 1);
  assert.equal(mirror.hash, chain[0].hash);
  assert.equal(mirror.summary, 'seq1');
});
