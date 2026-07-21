// Crash safety net (LEARNINGS #13). Origin: opening the annotate-screenshot
// dialog launched Playwright in-process; a stray async rejection killed the
// backend (Node exits on unhandled rejections), systemd restarted it, and the
// operator's 4-hour build cycle was marked "orphaned by restart". The net in
// index.js logs and keeps serving. Native-free static check: the handlers
// must stay registered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('backend registers the unhandled-rejection safety net', () => {
  assert.ok(/process\.on\('unhandledRejection'/.test(src), 'unhandledRejection handler missing');
  assert.ok(/process\.on\('uncaughtException'/.test(src), 'uncaughtException handler missing');
  const netAt = src.indexOf("process.on('unhandledRejection'");
  const listenAt = src.indexOf('server.listen(');
  assert.ok(netAt !== -1 && listenAt !== -1 && netAt < listenAt, 'safety net must be registered before the server starts listening');
});
