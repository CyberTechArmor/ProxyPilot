// Disposable browser-level proof only. It never contacts the public demo.
// Usage: set PLAYWRIGHT_CORE_DIR and CHROMIUM_EXECUTABLE, then run with Node.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSyntheticSignInBrowserBroker, SYNTHETIC_ORIGIN } from '../../admin/backend/src/lib/operational-browser-broker.js';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT_CORE_DIR || !process.env.CHROMIUM_EXECUTABLE)
  throw new Error('PLAYWRIGHT_CORE_DIR and CHROMIUM_EXECUTABLE are required');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_DIR);
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,headless:true});
const ref = {run_id:randomUUID(),attempt_id:randomUUID(),fence:1};
let reserved = 0, denied = 0, approved = 0;
const fixture = (redirect=false, subresource=false) => ({
  async newContext(options) {
    assert.equal(options.acceptDownloads,false);
    assert.equal(options.serviceWorkers,'block');
    const context = await browser.newContext(options);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== SYNTHETIC_ORIGIN) throw new Error('Network fence failed before fixture');
      approved++;
      if (url.pathname === '/' && redirect)
        return route.fulfill({status:302,headers:{location:'https://outside.invalid/escape'},body:''});
      if (url.pathname === '/api/session')
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({authenticated:false,email:null})});
      if (url.pathname === '/api/files')
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({files:[{id:'sample-metrics',name:'sample-metrics.csv'}]})});
      if (url.pathname === '/api/logout')
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({authenticated:false})});
      const html = `<html><body><button onclick="document.getElementById('dlg').showModal()">Sign in</button>
        <dialog id="dlg" aria-label="Sign in to your workspace">Sign in to your workspace</dialog>
        <button>Sign out</button>${subresource?'<img src="https://outside.invalid/tracker">':''}</body></html>`;
      return route.fulfill({status:200,contentType:'text/html',body:html});
    });
    context.on('requestfailed', request => {if(request.url().startsWith('https://outside.invalid/')) denied++;});
    return context;
  },
});

try {
  const broker = await createSyntheticSignInBrowserBroker({browser:fixture(false,true),
    reserveAction:async()=>{if (++reserved>25) {
      const error=new Error('ACTION_LIMIT'); error.code='ACTION_LIMIT'; throw error;
    }}});
  try {
    assert.deepEqual(await broker.perform({...ref,action:'open_landing'}),{at:'landing'});
    assert.deepEqual(await broker.perform({...ref,action:'open_login'}),{at:'login_dialog'});
    assert.deepEqual(await broker.perform({...ref,action:'read_session'}),{untrusted_page_claim_authenticated:false});
    assert.deepEqual(await broker.perform({...ref,action:'read_files'}),{untrusted_page_claim_sample_present:true});
    await assert.rejects(broker.perform({...ref,action:'submit_bound_fixture'}),
      {code:'CREDENTIAL_BROKER_UNAVAILABLE'});
    for (let i=0;i<21;i++) await broker.perform({...ref,action:'read_session'});
    await assert.rejects(broker.perform({...ref,action:'read_session'}),{code:'ACTION_LIMIT'});
    assert.equal(reserved,26);
  } finally {await broker.close();}

  const redirectBroker = await createSyntheticSignInBrowserBroker({browser:fixture(true),
    reserveAction:async()=>{}});
  try {await assert.rejects(redirectBroker.perform({...ref,action:'open_landing'}));}
  finally {await redirectBroker.close();}
  assert.ok(approved >= 4);
  assert.ok(denied >= 2, `expected subresource and redirect denials, got ${denied}`);
  process.stdout.write(JSON.stringify({approved_fixture_requests:approved,blocked_cross_origin_requests:denied,
    reserved_actions:reserved,credential_submission:'closed'})+'\n');
} finally {await browser.close();}
