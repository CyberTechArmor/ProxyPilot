// Runtime observation (run-taxonomy fix #1/B1) — the REAL Playwright executor
// against in-test HTTP fixtures. Skipped (visibly, not silently green) when
// Playwright isn't installed, mirroring mock2-ui-checks.e2e.test.js exactly —
// mock2-probe-logic.test.js covers the pure layer everywhere.
//
// The docs2 `.popover.menu { display:none }` saga from the run-taxonomy report
// is the regression fixture: five cycles of reasoning about behaviour missed
// what a single computed-style read surfaces immediately. That is the case
// this file proves browser_probe actually catches.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { runBrowserProbe } from '../mock2/browser-probe.js';
import { httpProbeCommand, parseCurlDashI } from '../mock2/probe-logic.js';

const execFileP = promisify(execFile);

let hasPlaywright = true;
try { await import('playwright-core'); } catch {
  try { await import('playwright'); } catch { hasPlaywright = false; }
}

// The docs2 regression: a control PRESENT in the DOM but hidden by a CSS rule
// (not [hidden], not display via inline style) — the exact shape five cycles
// of reasoning missed.
const POPOVER_PAGE = `<!doctype html><html><head><style>
.popover.menu { display: none; }
</style></head><body>
<button id="open-export">Export</button>
<div class="popover menu" id="export-menu">
  <a href="/export/pdf">PDF</a>
</div>
<script>
  document.getElementById('open-export').addEventListener('click', () => {
    document.getElementById('export-menu').classList.remove('menu');
  });
</script>
</body></html>`;

const THROWS_PAGE = `<!doctype html><html><body>
<h1>Broken page</h1>
<script>throw new Error('boom - a real console error');</script>
</body></html>`;

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/documents') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(POPOVER_PAGE);
        return;
      }
      if (req.url === '/broken') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(THROWS_PAGE);
        return;
      }
      if (req.url === '/api/broken') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test(
  'browser_probe reports computed display:none for a present-but-hidden element (the docs2 .popover.menu regression fixture)',
  { skip: !hasPlaywright && 'playwright not installed' },
  async () => {
    const { server, url } = await startFixtureServer();
    try {
      const result = await runBrowserProbe({
        baseUrl: url,
        input: { target: 'deployed', path: '/documents', selectors: ['.popover.menu', '#open-export'] },
      });
      assert.equal(result.error, undefined);
      const menu = result.selectors.find((s) => s.selector === '.popover.menu');
      assert.equal(menu.found, true);
      assert.equal(menu.visible, false);
      assert.equal(menu.computed.display, 'none');
      const button = result.selectors.find((s) => s.selector === '#open-export');
      assert.equal(button.found, true);
      assert.equal(button.visible, true);
    } finally {
      server.close();
    }
  },
);

test(
  'browser_probe collects a console error thrown on page load',
  { skip: !hasPlaywright && 'playwright not installed' },
  async () => {
    const { server, url } = await startFixtureServer();
    try {
      const result = await runBrowserProbe({ baseUrl: url, input: { target: 'deployed', path: '/broken' } });
      assert.equal(result.error, undefined);
      assert.ok(result.consoleErrors.length >= 1);
      assert.match(result.consoleErrors[0], /boom - a real console error/);
    } finally {
      server.close();
    }
  },
);

test(
  'browser_probe reports a DOM excerpt for a requested selector',
  { skip: !hasPlaywright && 'playwright not installed' },
  async () => {
    const { server, url } = await startFixtureServer();
    try {
      const result = await runBrowserProbe({ baseUrl: url, input: { target: 'deployed', path: '/documents', domSelector: '#open-export' } });
      assert.match(result.dom, /Export<\/button>/);
    } finally {
      server.close();
    }
  },
);

test(
  'browser_probe: an absent selector is reported found=false, not an error',
  { skip: !hasPlaywright && 'playwright not installed' },
  async () => {
    const { server, url } = await startFixtureServer();
    try {
      const result = await runBrowserProbe({ baseUrl: url, input: { target: 'deployed', path: '/documents', selectors: ['.does-not-exist'] } });
      assert.equal(result.selectors[0].found, false);
    } finally {
      server.close();
    }
  },
);

// This one exercises httpProbeCommand + parseCurlDashI against REAL curl
// output — the exact command runner.js's runHttpProbe hands to execInContainer
// — rather than a container (there is none in this sandbox). Gated on curl
// existing on PATH, not on Playwright.
let hasCurl = true;
try { await execFileP('curl', ['--version']); } catch { hasCurl = false; }

test(
  'http_probe command + parser: returns the real status and body for a 500 (real curl, not a mock)',
  { skip: !hasCurl && 'curl not installed' },
  async () => {
    const { server, url } = await startFixtureServer();
    try {
      const port = new URL(url).port;
      // httpProbeCommand targets 127.0.0.1:webPort — swap in the fixture's
      // port so this exercises the SAME command shape runHttpProbe builds.
      const cmd = httpProbeCommand({ webPort: port, method: 'GET', path: '/api/broken', headers: [], body: null });
      const { stdout } = await execFileP('sh', ['-c', cmd]);
      const out = parseCurlDashI(stdout);
      assert.equal(out.status, 500);
      assert.match(out.body, /"error":"internal"/);
    } finally {
      server.close();
    }
  },
);
