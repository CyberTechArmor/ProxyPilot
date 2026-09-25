// UI acceptance against an isolated database and real setup API. Host execution is not attempted; this is NOT Infisical/Agent Proxy/Caddy execution.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,rmSync,writeFileSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ids,identityInput } from '../src/__tests__/helpers/infisical-fixture.js';
import assert from 'node:assert/strict';
const require=createRequire(resolve(process.env.G5_BROWSER_MODULES||'.','package.json'));
const puppeteer=require('puppeteer-core');
const dir=mkdtempSync(join(tmpdir(),'g5-browser-')),dbPath=join(dir,'fixture.sqlite');
const evidence=resolve(process.env.G5_EVIDENCE_DIR||'../../docs/evidence');mkdirSync(evidence,{recursive:true});
let child,browser;
const start=async()=>{child=fork(new URL('../src/__tests__/helpers/infisical-api-process.js',import.meta.url),[dbPath],{stdio:['ignore','ignore','inherit','ipc']});return (await once(child,'message'))[0];};
const stop=async()=>{const end=once(child,'exit');child.send('close');await end;child=null;};
const out={date:new Date().toISOString().slice(0,10),execution:'Built frontend + real local API/SQLite; no host execution; no real secrets stack',audits:[],errors:[]};
try {
  let fixture=await start();browser=await puppeteer.launch({executablePath:process.env.G5_CHROMIUM,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();page.on('pageerror',e=>out.errors.push(e.message));
  const open=async()=>{await page.setCookie({name:'pp_token',value:fixture.tokens.admin,url:fixture.url,httpOnly:true},{name:'pp_csrf',value:'fixture-csrf',url:fixture.url});await page.goto(fixture.url+'/platform-setup',{waitUntil:'networkidle0'});await page.waitForSelector('#infisical-setup');};
  await open();
  const click=async text=>{await page.waitForFunction(t=>[...document.querySelectorAll('#infisical-setup button')].some(b=>b.textContent===t&&!b.disabled),{},text);await page.evaluate(t=>[...document.querySelectorAll('#infisical-setup button')].find(b=>b.textContent===t).click(),text);};
  const audit=async state=>{
    for(const width of [360,375,768,1280,1920]) {
      await page.setViewport({width,height:width<768?740:900});
      await page.addStyleTag({content:'html,body {overflow-x:visible!important}'});
      const metrics=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,shortButtons:[...document.querySelectorAll('#infisical-setup button')].filter(b=>b.getBoundingClientRect().height>0&&b.getBoundingClientRect().height<44).map(b=>b.textContent)}));
      assert.equal(metrics.scrollWidth,metrics.clientWidth,`${state}: overflow at ${width}`);assert.equal(metrics.shortButtons.length,0);
      out.audits.push({state,width,...metrics});
      if(state==='identity-review'&&[360,1280].includes(width)) {await page.$eval('[aria-label="Review Infisical changes"]',el=>el.scrollIntoView({block:'center',behavior:'instant'}));await page.screenshot({path:join(evidence,`g5-setup-${width}.png`)});}
    }
  };
  await audit('configuration');
  await page.setViewport({width:375,height:740});
  await page.type('#if-host','10.20.30.40');await page.type('#if-vm','g5-disposable');await page.type('#if-ips','10.20.30.40,192.0.2.40');await click('Save reviewed secrets targets');
  await page.waitForSelector('#if-org');await audit('identity-form');
  await page.setViewport({width:375,height:740});await page.type('#if-org',ids.org);await page.type('#if-project',ids.project);
  for(const role of ['workload','proxy','agent'])for(const field of ['identityId','clientId','clientSecret'])await page.type(`#if-${role}-${field}`,identityInput[role][field]);
  await click('Save reviewed test identities');await page.waitForFunction(()=>document.querySelector('#infisical-setup').textContent.includes('Exact policies and proxied service'));
  await audit('identity-review');
  await page.setViewport({width:375,height:740});await page.$eval('label[for=if-reviewed]',el=>el.scrollIntoView({block:'center',behavior:'instant'}));await page.focus('#if-reviewed');await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('#if-reviewed').checked);await click('Apply / retry reviewed setup');
  await page.waitForFunction(()=>document.querySelector('#infisical-setup').textContent.includes('Job: queued'));
  await stop();fixture=await start();await open();await page.waitForFunction(()=>document.querySelector('#infisical-setup').textContent.includes('Job: queued'));out.apiRestart='encrypted references, reviewed identities and queued job reopened';
  await audit('pending-reopened');
  const visible=await page.$eval('#infisical-setup',el=>el.textContent);for(const role of ['workload','proxy','agent'])assert(!visible.includes(identityInput[role].clientSecret));out.redaction='saved credentials absent from rendered state';
  await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});const axe=await page.evaluate(async()=>await window.axe.run(document.querySelector('#infisical-setup')));out.axeViolations=axe.violations.map(x=>({id:x.id,impact:x.impact,nodes:x.nodes.length}));assert.equal(out.axeViolations.length,0);
  const lighthouse=(await import(pathToFileURL(require.resolve('lighthouse')))).default;
  const port=Number(new URL(browser.wsEndpoint()).port);
  const report=await lighthouse(fixture.url+'/platform-setup',{port,onlyCategories:['accessibility'],output:'json',logLevel:'error',disableStorageReset:true});out.lighthouseScore=report.lhr.categories.accessibility.score*100;assert(out.lighthouseScore>=90);
  assert.equal(out.errors.length,0);writeFileSync(join(evidence,'g5-browser.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({audits:out.audits.length,axe:out.axeViolations.length,lighthouse:out.lighthouseScore,apiRestart:out.apiRestart}));
} catch(e) {console.error(JSON.stringify(out));throw e;} finally {if(browser)await browser.close();if(child)await stop();rmSync(dir,{recursive:true,force:true});}
