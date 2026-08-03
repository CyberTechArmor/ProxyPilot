// Runtime observation tools (run-taxonomy fix #1/B1): http_probe and
// browser_probe. Pure logic tests for probe-logic.js — native-free by
// construction (no container, no Playwright, no DB).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROBE_TARGETS, PROBE_MAX_PER_CYCLE, PROBE_MAX_SELECTORS, PROBE_MAX_HEADERS,
  httpProbePlan, browserProbePlan, shellQuote, probeBudget,
  formatHttpProbeResult, formatBrowserProbeResult,
  httpProbeCommand, parseCurlDashI,
} from '../mock2/probe-logic.js';

// ---- httpProbePlan ----

test('httpProbePlan: requires an explicit target', () => {
  const r = httpProbePlan({ path: '/api/notes' });
  assert.ok(r.error);
  assert.match(r.error, /target must be one of/);
});

test('httpProbePlan: rejects a path that does not start with /', () => {
  const r = httpProbePlan({ target: 'deployed', path: 'api/notes' });
  assert.ok(r.error);
});

test('httpProbePlan: rejects an absolute URL (:// anywhere)', () => {
  const r = httpProbePlan({ target: 'deployed', path: '/redirect?to=http://evil.example' });
  assert.ok(r.error);
});

test('httpProbePlan: rejects a protocol-relative path (//evil.example)', () => {
  const r = httpProbePlan({ target: 'deployed', path: '//evil.example/x' });
  assert.ok(r.error);
});

test('httpProbePlan: rejects a header value containing a newline', () => {
  const r = httpProbePlan({ target: 'deployed', path: '/', headers: { 'x-test': 'a\nSet-Cookie: evil=1' } });
  assert.ok(r.error);
});

test('httpProbePlan: rejects a header key containing a newline', () => {
  const r = httpProbePlan({ target: 'deployed', path: '/', headers: { 'x-test\r\nx-evil': 'v' } });
  assert.ok(r.error);
});

test('httpProbePlan: rejects too many headers', () => {
  const headers = {};
  for (let i = 0; i < PROBE_MAX_HEADERS + 1; i++) headers[`x-${i}`] = 'v';
  const r = httpProbePlan({ target: 'deployed', path: '/', headers });
  assert.ok(r.error);
});

test('httpProbePlan: uppercases the method and defaults to GET', () => {
  const r1 = httpProbePlan({ target: 'deployed', path: '/api' });
  assert.equal(r1.method, 'GET');
  const r2 = httpProbePlan({ target: 'deployed', path: '/api', method: 'post' });
  assert.equal(r2.method, 'POST');
});

test('httpProbePlan: rejects an unknown method', () => {
  const r = httpProbePlan({ target: 'deployed', path: '/', method: 'TRACE' });
  assert.ok(r.error);
});

test('httpProbePlan: a valid plan carries headers as [key, value] pairs', () => {
  const r = httpProbePlan({ target: 'working', path: '/api/notes', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.equal(r.error, undefined);
  assert.equal(r.target, 'working');
  assert.deepEqual(r.headers, [['content-type', 'application/json']]);
  assert.equal(r.body, '{"a":1}');
});

// ---- browserProbePlan ----

test('browserProbePlan: requires an explicit target', () => {
  const r = browserProbePlan({ path: '/' });
  assert.ok(r.error);
});

test('browserProbePlan: rejects a bad path the same way httpProbePlan does', () => {
  assert.ok(browserProbePlan({ target: 'deployed', path: 'x' }).error);
  assert.ok(browserProbePlan({ target: 'deployed', path: '//x' }).error);
});

test('browserProbePlan: caps selectors at 10', () => {
  const selectors = Array.from({ length: PROBE_MAX_SELECTORS + 1 }, (_, i) => `.sel-${i}`);
  const r = browserProbePlan({ target: 'deployed', path: '/', selectors });
  assert.ok(r.error);
});

test('browserProbePlan: rejects a non-string selector', () => {
  const r = browserProbePlan({ target: 'deployed', path: '/', selectors: [{ bad: true }] });
  assert.ok(r.error);
});

test('browserProbePlan: a valid plan normalises role and domSelector', () => {
  const r = browserProbePlan({ target: 'deployed', path: '/notes', role: ' admin ', selectors: ['.foo'], dom_selector: '.bar' });
  assert.equal(r.error, undefined);
  assert.equal(r.role, 'admin');
  assert.equal(r.domSelector, '.bar');
  assert.deepEqual(r.selectors, ['.foo']);
});

test('browserProbePlan: role and domSelector default to null when absent', () => {
  const r = browserProbePlan({ target: 'deployed', path: '/' });
  assert.equal(r.role, null);
  assert.equal(r.domSelector, null);
  assert.deepEqual(r.selectors, []);
});

// ---- shellQuote ----

test('shellQuote: wraps in single quotes and escapes embedded quotes', () => {
  assert.equal(shellQuote('hello'), "'hello'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("shellQuote: a path of '; rm -rf / #' survives as one literal argument", () => {
  const evil = "'; rm -rf / #";
  const quoted = shellQuote(evil);
  // Reconstructing what a POSIX shell would see: every quote is closed and
  // escaped, so the whole thing is ONE argument, never unescaped shell syntax.
  assert.equal(quoted, "''\\''; rm -rf / #'");
  assert.equal((quoted.match(/(?<!\\)'/g) || []).length % 2, 0);
});

test('shellQuote: null/undefined become empty-string literals, not "null"/"undefined"', () => {
  assert.equal(shellQuote(null), "''");
  assert.equal(shellQuote(undefined), "''");
});

// ---- probeBudget ----

test('probeBudget: allows up to the cap, then returns the redirect message', () => {
  assert.equal(probeBudget(0).allowed, true);
  assert.equal(probeBudget(PROBE_MAX_PER_CYCLE - 1).allowed, true);
  const spent = probeBudget(PROBE_MAX_PER_CYCLE);
  assert.equal(spent.allowed, false);
  assert.match(spent.message, /probe budget spent/);
  assert.match(spent.message, /halt/);
});

test('probeBudget: respects a custom max', () => {
  assert.equal(probeBudget(2, 3).allowed, true);
  assert.equal(probeBudget(3, 3).allowed, false);
});

// ---- httpProbeCommand / parseCurlDashI ----

test('httpProbeCommand: builds a loopback URL from webPort, never from model input', () => {
  const cmd = httpProbeCommand({ webPort: 4000, method: 'GET', path: '/api/notes', headers: [], body: null });
  assert.match(cmd, /http:\/\/127\.0\.0\.1:4000\/api\/notes/);
  assert.match(cmd, /^curl /);
  assert.match(cmd, /-X GET/);
});

test('httpProbeCommand: quotes headers and body safely', () => {
  const cmd = httpProbeCommand({ webPort: 3000, method: 'POST', path: '/x', headers: [['content-type', 'application/json']], body: '{"a":1}' });
  assert.match(cmd, /-H 'content-type: application\/json'/);
  assert.match(cmd, /--data-raw '\{"a":1\}'/);
});

test('httpProbeCommand: a malicious path segment cannot break out of the quoted URL', () => {
  const cmd = httpProbeCommand({ webPort: 3000, method: 'GET', path: "/x'; rm -rf / #", headers: [], body: null });
  // The whole URL argument stays inside a single-quoted, escaped literal.
  assert.match(cmd, /'http:\/\/127\.0\.0\.1:3000\/x'\\''; rm -rf \/ #'/);
});

test('parseCurlDashI: splits status, headers, and body', () => {
  const raw = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}';
  const out = parseCurlDashI(raw);
  assert.equal(out.status, 200);
  assert.match(out.headers, /Content-Type: application\/json/);
  assert.equal(out.body, '{"ok":true}');
});

test('parseCurlDashI: a redirect chain keeps the FINAL header block', () => {
  const raw = 'HTTP/1.1 302 Found\r\nLocation: /login\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>';
  const out = parseCurlDashI(raw);
  assert.equal(out.status, 200);
  assert.doesNotMatch(out.headers, /302/);
});

test('parseCurlDashI: garbage input never throws', () => {
  assert.doesNotThrow(() => parseCurlDashI(''));
  assert.doesNotThrow(() => parseCurlDashI('not even close to http'));
  const out = parseCurlDashI('not even close to http');
  assert.equal(out.status, null);
});

// ---- formatHttpProbeResult / formatBrowserProbeResult ----

test('formatHttpProbeResult: the first line names which target was probed', () => {
  const deployed = formatHttpProbeResult({ target: 'deployed', method: 'GET', path: '/', raw: { status: 200, headers: 'x', body: 'ok' } });
  assert.match(deployed.split('\n')[0], /target: deployed/);
  const working = formatHttpProbeResult({ target: 'working', method: 'GET', path: '/', raw: { status: 200, headers: 'x', body: 'ok' } });
  assert.match(working.split('\n')[0], /target: working/);
});

test('formatHttpProbeResult: caps the body and says how much was dropped', () => {
  const bigBody = 'x'.repeat(9000);
  const out = formatHttpProbeResult({ target: 'deployed', method: 'GET', path: '/', raw: { status: 200, headers: '', body: bigBody } });
  assert.match(out, /truncated, 9000 chars total/);
});

test('formatHttpProbeResult: surfaces an error without a status line', () => {
  const out = formatHttpProbeResult({ target: 'deployed', method: 'GET', path: '/', raw: { error: 'curl exited 7: connection refused' } });
  assert.match(out, /error: curl exited 7/);
  assert.doesNotMatch(out, /status:/);
});

test('formatBrowserProbeResult: the first line names which target was probed', () => {
  const out = formatBrowserProbeResult({ target: 'working', path: '/notes', consoleErrors: [], networkFailures: [], selectors: [] });
  assert.match(out.split('\n')[0], /target: working/);
});

test('formatBrowserProbeResult: reports computed style per selector — the docs2 .popover.menu regression fixture', () => {
  // The report's own worst case: docs2 spent five cycles guessing at a
  // display:none rule a single computed-style read would have surfaced
  // immediately. This is the shape that read must produce.
  const out = formatBrowserProbeResult({
    target: 'deployed',
    path: '/documents',
    consoleErrors: [],
    networkFailures: [],
    selectors: [{ selector: '.popover.menu', found: true, visible: false, computed: { display: 'none', visibility: 'visible' } }],
  });
  assert.match(out, /\.popover\.menu.*found=true visible=false/);
  assert.match(out, /display: none/);
});

test('formatBrowserProbeResult: unavailable connector surfaces plainly', () => {
  const out = formatBrowserProbeResult({ target: 'deployed', path: '/', unavailable: true, detail: 'playwright-core is not installed' });
  assert.match(out, /error: playwright-core is not installed/);
});

test('formatBrowserProbeResult: lists console errors and network failures when present', () => {
  const out = formatBrowserProbeResult({
    target: 'deployed', path: '/', selectors: [],
    consoleErrors: ['TypeError: x is not a function'],
    networkFailures: ['GET /api/notes → 500'],
  });
  assert.match(out, /console errors:\n- TypeError/);
  assert.match(out, /network failures:\n- GET \/api\/notes → 500/);
});

test('formatBrowserProbeResult: caps the DOM excerpt', () => {
  const out = formatBrowserProbeResult({ target: 'deployed', path: '/', selectors: [], dom: '<div>'.repeat(1000) });
  assert.match(out, /dom truncated/);
});

// ---- PROBE_TARGETS sanity ----

test('PROBE_TARGETS is exactly deployed and working', () => {
  assert.deepEqual([...PROBE_TARGETS], ['deployed', 'working']);
});
