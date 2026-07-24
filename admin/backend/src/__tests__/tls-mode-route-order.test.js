// Route-ordering regression (human-caught defect). Origin: toggling the Global
// TLS mode on the TLS Certificates page returned "certificate not found". Cause:
// Express matches routes in registration order, and the parametric
// `PUT /:id` (cert rotate) was registered BEFORE the literal `PUT /tls-mode`.
// So `PUT /tls-certs/tls-mode` matched `/:id` with id="tls-mode", the cert
// lookup failed, and the toggle 404'd instead of changing the mode.
//
// Native-free static check (mirrors backend-safety-net.test.js): the literal
// `/tls-mode` route MUST be registered before the parametric `/:id` routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../routes/tls-certs.js', import.meta.url), 'utf8');

test('PUT /tls-mode is registered before the parametric /:id routes', () => {
  const modeAt = src.indexOf("router.put('/tls-mode'");
  const putIdAt = src.indexOf("router.put('/:id'");
  const getIdAt = src.indexOf("router.get('/:id'");
  const delIdAt = src.indexOf("router.delete('/:id'");

  assert.ok(modeAt !== -1, "PUT /tls-mode route not found");
  assert.ok(putIdAt !== -1, "PUT /:id route not found");

  // The collision that produced the bug: PUT /:id must come AFTER /tls-mode.
  assert.ok(
    modeAt < putIdAt,
    "PUT '/tls-mode' must be registered before PUT '/:id' or Express treats 'tls-mode' as a cert id (\"certificate not found\")",
  );
  // Keep every parametric route after the literal one for good measure.
  for (const [name, at] of [['GET /:id', getIdAt], ['DELETE /:id', delIdAt]]) {
    if (at !== -1) assert.ok(modeAt < at, `PUT '/tls-mode' must be registered before ${name}`);
  }
});
