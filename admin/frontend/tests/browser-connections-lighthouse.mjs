// Mobile accessibility fixture; no production site or provider is contacted.
// LIGHTHOUSE_ROOT points to an independently installed Lighthouse package root.
import { createServer } from 'vite';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const lighthouseRoot = process.env.LIGHTHOUSE_ROOT;
if (!lighthouseRoot) throw new Error('Set LIGHTHOUSE_ROOT to the installed lighthouse package directory');
const { default: lighthouse } = await import(`${lighthouseRoot}/core/index.js`);
const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
server.middlewares.stack.unshift({ route: '/api', handle: (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url.includes('/auth/verify') ? { user: { id: 'fixture', username: 'fixture', role: 'user' } } : req.url.endsWith('/capabilities') ? { metadata_available: true, execution_available: false } : { connections: [], next_cursor: null }));
} });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const port = Number(process.env.LIGHTHOUSE_DEBUG_PORT || 9449);
const context = await chromium.launch({ executablePath: process.env.BROWSER_EXE || '/tmp/chromium', headless: true, args: ['--no-sandbox', `--remote-debugging-port=${port}`] });
try {
  const { lhr } = await lighthouse(`${origin}/tests/browser-connections-fixture.html?modal=true`, { port, onlyCategories: ['accessibility'], output: 'json', logLevel: 'error' });
  const report = { provenance: 'Disposable browser connection metadata fixture', score: Math.round(lhr.categories.accessibility.score * 100), form_factor: lhr.configSettings.formFactor, failing: Object.values(lhr.audits).filter(a => a.score === 0 && a.scoreDisplayMode === 'binary').map(a => a.id) };
  const destination = process.env.LIGHTHOUSE_REPORT || '/tmp/proxypilot-browser-connections/lighthouse.json';
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); if (report.score < 90) process.exitCode = 1;
} finally { await context.close(); await server.close(); }
