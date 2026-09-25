import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { makeDb,config } from '../src/__tests__/helpers/full-platform-fixture.js';
import { readFullPlatform } from '../src/lib/setup-engine/full-platform-store.js';
const require=createRequire(resolve(process.env.FP_BROWSER_MODULES||'.','package.json')),puppeteer=require('puppeteer-core');
const root=mkdtempSync(join(tmpdir(),'fp-browser-')),path=join(root,'db.sqlite'),evidence=resolve(process.env.FP_EVIDENCE_DIR||'docs/evidence');mkdirSync(evidence,{recursive:true});
const out={date:new Date().toISOString(),execution:'Built frontend and production HTTP/auth/CSRF/SQLite; no real platform service installation or human login ceremony.',audits:[],checks:[],errors:[]};
let child,browser,fixture,db;
const start=async()=>{child=fork(new URL('../src/__tests__/helpers/full-platform-api-process.js',import.meta.url),[path],{stdio:['ignore','ignore','inherit','ipc']});fixture=(await once(child,'message'))[0];};
const stop=async()=>{if(child){const end=once(child,'exit');child.send('close');await end;child=null;}};
try{
 await start();db=makeDb(path);browser=await puppeteer.launch({executablePath:process.env.FP_CHROMIUM,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--disable-gpu']});const page=await browser.newPage();page.on('pageerror',e=>out.errors.push(e.message));
 page.on('response',async r=>{if(r.url().includes('/api/setup/platform/full')&&r.status()>=400)out.errors.push({status:r.status(),body:await r.text()});});
 const open=async()=>{await page.setCookie({name:'pp_token',value:fixture.tokens.admin,url:fixture.url,httpOnly:true},{name:'pp_csrf',value:'fixture-csrf',url:fixture.url});await page.goto(fixture.url+'/platform-setup',{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('#full-platform-setup')&&!document.querySelector('#full-platform-setup').textContent.includes('Loading saved setup'));};
 const click=async text=>{await page.waitForFunction(t=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===t&&!b.disabled),{},text);await page.evaluate(t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t&&!b.disabled).click(),text);};
 const audit=async state=>{await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});for(const width of [360,375,390,768,1280,1920]){await page.setViewport({width,height:width<768?800:1000});await new Promise(r=>setTimeout(r,200));const a=await page.evaluate(()=>{const card=document.querySelector('#full-platform-setup');const owners=[];for(let e=card.parentElement;e;e=e.parentElement)if(['auto','scroll'].includes(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+1)owners.push(e.tagName);return{scrollOwners:owners.length,width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,cardWidth:card.clientWidth,cardScrollWidth:card.scrollWidth,shortButtons:[...card.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().height>0&&b.getBoundingClientRect().height<44).map(b=>b.textContent)};});assert.equal(a.width,a.scrollWidth,state+' document overflow');assert(a.cardScrollWidth<=a.cardWidth,state+' setup overflow');assert.equal(a.shortButtons.length,0);assert.equal(a.scrollOwners,1,state+' single scroll owner');out.audits.push({state,...a});if(['domains','review','administrator'].includes(state)&&[360,1280].includes(width)){await page.evaluate(()=>{for(let e=document.querySelector('#full-platform-setup').parentElement;e;e=e.parentElement)e.scrollTop=0;});await page.screenshot({path:join(evidence,`fp-${state}-${width}.png`)});}}};
 await page.setViewport({width:360,height:800});await open();await audit('domains');
 const wanted=config();for(const [id,value]of Object.entries({'full-public':wanted.publicOrigin,'full-recovery':wanted.recoveryOrigin,...Object.fromEntries(Object.entries(wanted.services).map(([id,s])=>['full-'+id,s.url]))})){
  await page.select('#'+id+'-domain','example.com');const input=await page.$('#'+id+'-subdomain');assert(input,'Address input '+id);await input.click({clickCount:3});await page.keyboard.type(new URL(value).hostname.replace('.example.com',''));
 }
 await click('Review setup');await page.waitForSelector('#full-networks');await page.type('#full-networks','10.20.30.0/24');await audit('review');
 const before=db.prepare('SELECT count(*) n FROM setup_jobs').get().n;await click('Save reviewed plan');await page.waitForFunction(()=>document.body.textContent.includes('Plan saved. No services or identity settings changed.'));assert.equal(db.prepare('SELECT count(*) n FROM setup_jobs').get().n,before);assert.equal(readFullPlatform(db).revision,1);out.checks.push('Browser save uses production API and is inert');
 await click('Apply saved setup');await page.waitForFunction(()=>document.body.textContent.includes('Operation queued'));const job=readFullPlatform(db).last_job_id;assert(job);await audit('queued');
 await stop();await start();await open();assert.equal(readFullPlatform(db).last_job_id,job);await page.waitForFunction(()=>document.body.textContent.includes('Operation queued'));out.checks.push('API process restart and page reload preserve the same reviewed plan and queued operation');
 await click('4. Administrator and recovery');await audit('administrator');
 await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});const axe=await page.evaluate(()=>window.axe.run(document.querySelector('#full-platform-setup')));out.axeViolations=axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}));assert.equal(out.axeViolations.length,0,JSON.stringify(out.axeViolations));
 const lighthouse=(await import(pathToFileURL(require.resolve('lighthouse')))).default;const lh=await lighthouse(fixture.url+'/platform-setup',{port:Number(new URL(browser.wsEndpoint()).port),onlyCategories:['accessibility'],output:'json',logLevel:'error',disableStorageReset:true});out.lighthouseScore=lh.lhr.categories.accessibility.score*100;assert(out.lighthouseScore>=90);assert.equal(out.errors.length,0);writeFileSync(join(evidence,'fp-browser.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({audits:out.audits.length,checks:out.checks.length,axe:out.axeViolations.length,lighthouse:out.lighthouseScore}));
}catch(e){console.error(JSON.stringify(out));throw e;}finally{if(browser)await browser.close();if(db)db.close();await stop();rmSync(root,{recursive:true,force:true});}
