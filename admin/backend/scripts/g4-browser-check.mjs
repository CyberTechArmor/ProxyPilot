// UI acceptance against an isolated database and real setup API. Host completion
// is scripted below; this is NOT Pomerium/Keycloak/Caddy execution.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,rmSync,writeFileSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const require=createRequire(resolve(process.env.G4_BROWSER_MODULES||'.','package.json'));
const puppeteer=require('puppeteer-core');
const dir=mkdtempSync(join(tmpdir(),'g4-browser-')),dbPath=join(dir,'fixture.sqlite');
const evidence=resolve(process.env.G4_EVIDENCE_DIR||'../../docs/evidence');mkdirSync(evidence,{recursive:true});
let child,browser;
const start=async()=>{child=fork(new URL('../src/__tests__/helpers/pomerium-api-process.js',import.meta.url),[dbPath],{stdio:['ignore','ignore','inherit','ipc']});return (await once(child,'message'))[0];};
const stop=async()=>{const end=once(child,'exit');child.send('close');await end;child=null;};
const out={date:new Date().toISOString().slice(0,10),execution:'Built frontend + real local API/SQLite; host completion scripted; no real gateway stack',audits:[],errors:[]};
try {
  let fixture=await start();browser=await puppeteer.launch({executablePath:process.env.G4_CHROMIUM,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();page.on('pageerror',e=>out.errors.push(e.message));
  const open=async()=>{await page.setCookie({name:'pp_token',value:fixture.tokens.admin,url:fixture.url,httpOnly:true},{name:'pp_csrf',value:'fixture-csrf',url:fixture.url});await page.goto(fixture.url+'/platform-setup',{waitUntil:'networkidle0'});await page.waitForSelector('#pomerium-setup');};
  await open();
  const click=async text=>{await page.waitForFunction(t=>[...document.querySelectorAll('#pomerium-setup button')].some(b=>b.textContent===t&&!b.disabled),{},text);await page.evaluate(t=>[...document.querySelectorAll('#pomerium-setup button')].find(b=>b.textContent===t).click(),text);};
  const audit=async state=>{
    for(const width of [360,375,768,1280,1920]) {
      await page.setViewport({width,height:width<768?740:900});
      await page.addStyleTag({content:'html,body {overflow-x:visible!important}'});
      const metrics=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,shortButtons:[...document.querySelectorAll('#pomerium-setup button')].filter(b=>b.getBoundingClientRect().height>0&&b.getBoundingClientRect().height<44).map(b=>b.textContent)}));
      assert.equal(metrics.scrollWidth,metrics.clientWidth,`${state}: overflow at ${width}`);assert.equal(metrics.shortButtons.length,0);
      out.audits.push({state,width,...metrics});
      if(state==='route-review'&&[360,1280].includes(width)) {await page.$eval('[aria-label="Reviewed gateway route change"]',el=>el.scrollIntoView({block:'center'}));await page.screenshot({path:join(evidence,`g4-setup-${width}.png`)});}
    }
  };
  await audit('configuration');
  await page.setViewport({width:375,height:740});await page.select('#pm-identity','kc-aabbccddeeff');await page.type('#pm-secret','g4-browser-dummy-client-secret');await click('Save reviewed gateway settings');
  await page.waitForSelector('#pm-route');await page.select('#pm-route','test-route');await page.click('#pomerium-setup input[type=checkbox]');await click('Review route protection');
  await page.waitForSelector('[aria-label="Reviewed gateway route change"]');await audit('route-review');
  await page.setViewport({width:375,height:740});await click('Apply reviewed protection');
  await page.waitForFunction(()=>document.querySelector('#pomerium-setup').textContent.includes('app.example.com · pending'));
  await stop();fixture=await start();await open();await page.waitForFunction(()=>document.querySelector('#pomerium-setup').textContent.includes('app.example.com · pending'));out.apiRestart='pending intent and job reopened';
  // Script only host completion so the UI can exercise explicit removal.
  const db=new DatabaseSync(dbPath);db.exec("UPDATE setup_jobs SET status='succeeded'; UPDATE setup_route_protection SET state='protected';");db.close();
  await page.reload({waitUntil:'networkidle0'});await click('Review removal of protection');await page.waitForSelector('[aria-label="Reviewed gateway route change"]');
  await audit('removal-review');await page.setViewport({width:375,height:740});await click('Confirm removal and restore direct route');
  await page.waitForFunction(()=>document.querySelector('#pomerium-setup').textContent.includes('app.example.com · removing'));out.explicitRemoval='review and submit through real API';
  await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});const axe=await page.evaluate(async()=>await window.axe.run(document.querySelector('#pomerium-setup')));out.axeViolations=axe.violations.map(x=>({id:x.id,impact:x.impact,nodes:x.nodes.length}));assert.equal(out.axeViolations.length,0);
  const lighthouse=(await import(pathToFileURL(require.resolve('lighthouse')))).default;
  const port=Number(new URL(browser.wsEndpoint()).port);
  const report=await lighthouse(fixture.url+'/platform-setup',{port,onlyCategories:['accessibility'],output:'json',logLevel:'error',disableStorageReset:true});out.lighthouseScore=report.lhr.categories.accessibility.score*100;assert(out.lighthouseScore>=90);
  assert.equal(out.errors.length,0);writeFileSync(join(evidence,'g4-browser.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({audits:out.audits.length,axe:out.axeViolations.length,lighthouse:out.lighthouseScore,apiRestart:out.apiRestart}));
} catch(e) {console.error(JSON.stringify(out));throw e;} finally {if(browser)await browser.close();if(child)await stop();rmSync(dir,{recursive:true,force:true});}
