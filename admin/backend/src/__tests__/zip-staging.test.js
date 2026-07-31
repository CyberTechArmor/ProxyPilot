// Unit tests for lib/zip-staging.js — the parked-upload registry
// behind the two-phase zip endpoints. Native-free: only node
// built-ins are involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stageZipUpload, getZipUpload, discardZipUpload } from '../lib/zip-staging.js';

function makeTempZip() {
  const dir = mkdtempSync(join(tmpdir(), 'pp-stage-test-'));
  const p = join(dir, 'upload.zip');
  writeFileSync(p, 'zipbytes');
  return p;
}

test('staged uploads are scoped to their kind + owning resource', () => {
  const zipPath = makeTempZip();
  const rec = stageZipUpload({ kind: 'service', refId: 'svc-1', zipPath, entries: [] });
  assert.ok(rec.id);
  assert.equal(getZipUpload(rec.id, 'service', 'svc-1'), rec);
  // Same id cannot be replayed against another service, the other
  // flow, or a bogus id.
  assert.equal(getZipUpload(rec.id, 'service', 'svc-2'), null);
  assert.equal(getZipUpload(rec.id, 'lxc', 'svc-1'), null);
  assert.equal(getZipUpload('nope', 'service', 'svc-1'), null);
});

test('discard removes the record and the parked archive (cancel writes nothing else)', async () => {
  const zipPath = makeTempZip();
  const rec = stageZipUpload({ kind: 'lxc', refId: 'web', zipPath, entries: [] });
  assert.equal(existsSync(zipPath), true);
  assert.equal(await discardZipUpload(rec.id), true);
  assert.equal(existsSync(zipPath), false);
  assert.equal(getZipUpload(rec.id, 'lxc', 'web'), null);
  // Discarding an unknown/expired id is a no-op, not an error.
  assert.equal(await discardZipUpload(rec.id), false);
});
