// Isolated rendering of the real panel; no live API or update operation.
import { createServer } from 'vite';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : require('../../backend/node_modules/playwright-core');
const html = resolve(root, '__self-update-check.html');
const jsx = resolve(root, '__self-update-check.jsx');
const evidence = process.env.UI_EVIDENCE_DIR;
const info = {
  currentVersion: '1.4.0', latestVersion: '1.4.0', updateReason: 'up_to_date', canUpdate: true,
  installed: { short_sha: 'bbbbbbbbbb', branch: 'main' }, agent: { reachable: true },
  running: { short_sha: 'aaaaaaaaaa', built_at: '2026-10-03T15:00:00Z', dirty: false },
  deployment: { status: 'restart_or_rebuild_required' },
  standards: { seed_version: '0.3.0', site_version: '1.14.0', update_available: true, status: 'adoption_required' },
};
let server, browser;
try {
  await writeFile(html, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__self-update-check.jsx"></script></body></html>');
  await writeFile(jsx, `import React from 'react'; import {createRoot} from 'react-dom/client'; import Panel from './src/components/SelfUpdatePanel.jsx'; import './src/index.css'; createRoot(document.getElementById('root')).render(<main style={{padding:16,maxWidth:900,margin:'auto'}}><h1>Application settings</h1><Panel updateInfo={${JSON.stringify(info)}} checking={false} onRefresh={()=>{}}/></main>);`);
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'idle', phases: [] }) }));
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const width of [360, 375, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__self-update-check.html`);
    await page.getByText('Running build', { exact: true }).waitFor();
    await page.getByText('aaaaaaaaaa', { exact: false }).waitFor();
    await page.getByText('The running build differs from the checkout.', { exact: false }).waitFor();
    await page.getByText('adoption required in a new ProxyPilot build', { exact: true }).waitFor();
    await page.addStyleTag({ content: 'html,body { overflow-x: visible !important; }' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}`);
    if (evidence) await page.screenshot({ path: resolve(evidence, `self-update-${width}.png`), fullPage: true });
  }
  console.log('Real SelfUpdatePanel: running/checkout mismatch and adoption message passed at 360, 375, 768, 1280, 1920 px, without horizontal overflow.');
} finally {
  await browser?.close(); await server?.close();
  await Promise.all([unlink(html).catch(() => {}), unlink(jsx).catch(() => {})]);
}
