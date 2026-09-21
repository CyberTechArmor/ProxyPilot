// lib/http-server-timeouts.js — the request-body clock is off, the headers
// clock is not. The load-bearing fact: Node 20 defaults requestTimeout to
// 300 000 ms, which killed two 249 GiB migration uploads at five minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { applyStreamingTimeouts, HEADERS_TIMEOUT_MS } from '../lib/http-server-timeouts.js';

test('a real http.Server starts with the 5-minute body clock, and leaves without it', () => {
  const server = http.createServer();
  assert.equal(server.requestTimeout, 300_000, 'the Node default this exists to remove');
  const got = applyStreamingTimeouts(server);
  assert.equal(server.requestTimeout, 0, 'no clock on the body: a 249 GiB rootfs takes as long as it takes');
  assert.equal(server.headersTimeout, HEADERS_TIMEOUT_MS, 'headers still have to arrive promptly');
  assert.deepEqual(got, { requestTimeout: 0, headersTimeout: HEADERS_TIMEOUT_MS });
  server.close();
});
