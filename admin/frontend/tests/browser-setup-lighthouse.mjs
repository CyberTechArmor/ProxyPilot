// Mobile accessibility snapshots of the actual four-step Agents page.
// Session/router/store are disposable fixtures; no runner/provider/site proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';

const repo=resolve(process.env.TEST_REPO_ROOT||fileURLToPath(new URL('../../..',import.meta.url)));
const installed=process.env.LIGHTHOUSE_DIR;
assert(installed,'Set LIGHTHOUSE_DIR to an independently installed Lighthouse package root');
const { startFlow }=await import(pathToFileURL(join(installed,'node_modules/lighthouse/core/index.js')).href);
const { default:puppeteer }=await import(pathToFileURL(join(installed,'node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js')).href);
const {startHarness}=await import(pathToFileURL(join(repo,'admin/frontend/tests/agent-runs-harness.mjs')).href);
const artifact=process.env.BROWSER_ARTIFACTS;if(artifact)mkdirSync(artifact,{recursive:true});
const report={provenance:'Actual dashboard route with disposable authenticated store/router fixtures; no production/provider/browser acceptance',source_head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),source_dirty:!!execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repo,encoding:'utf8'}).trim(),component_sha256:createHash('sha256').update(readFileSync(join(repo,'admin/frontend/src/components/operational-projects/BrowserConfigurations.jsx'))).digest('hex'),minimum:90,viewport:{width:375,height:900},scores:[],page_errors:[],outbound:[]};
const profile=mkdtempSync(join(tmpdir(),'pp-browser-setup-lighthouse-')),port=Number(process.env.LIGHTHOUSE_PORT||9463);
let h,ctx,connected,page;
try{
 h=await startHarness({execution:false});
 ctx=await chromium.launchPersistentContext(profile,{executablePath:process.env.BROWSER_EXE||'/usr/bin/chromium',headless:true,viewport:report.viewport,isMobile:true,hasTouch:true,args:['--no-sandbox','--no-proxy-server',`--remote-debugging-port=${port}`]});
 await ctx.addCookies([{name:'pp_harness_user',value:'owner',url:h.origin},{name:'pp_csrf',value:'setup-lighthouse',url:h.origin}]);
 await ctx.addInitScript(user=>{localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('pp-theme','office');localStorage.setItem('mock2HintDismissed','1');},h.world.users.owner);
 await ctx.route('**/*',route=>{const url=route.request().url();if(!url.startsWith(h.origin)&&!url.startsWith('data:')){report.outbound.push(url);return route.abort();}return route.continue();});
 page=await ctx.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.page_errors.push(e.message));
 await page.goto(`${h.origin}/operational-projects/${h.world.p.id}?section=Agents`);
 const setup=page.locator('.browser-configurations');await setup.waitFor();
 await setup.getByLabel('Website URL (optional if included in your request)',{exact:true}).fill('https://example.org/');
 await setup.getByLabel('Objective',{exact:true}).fill('Read the public publication date.');
 await setup.getByLabel('Expected result',{exact:true}).fill('A cited publication date.');
 await setup.getByRole('button',{name:'Prepare settings from fields',exact:true}).click();
 connected=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});const current=(await connected.pages()).find(tab=>tab.url()===page.url());assert(current);
 const flow=await startFlow(current,{name:'Browser setup mobile accessibility',config:{extends:'lighthouse:default',settings:{onlyCategories:['accessibility'],formFactor:'mobile',screenEmulation:{disabled:true}}}});
 for(const [number,label]of[[1,'Work'],[2,'Connections'],[3,'Controls'],[4,'Review']]){
  assert.equal(await page.evaluate(()=>innerWidth),375,'audit retains the375px mobile viewport');await setup.getByRole('button',{name:`${number}. ${label}`,exact:true}).click();await setup.getByRole('navigation',{name:'Browser setup sections',exact:true}).scrollIntoViewIfNeeded();
  await flow.snapshot({name:`Browser setup ${label}`});const result=await flow.createFlowResult(),lhr=result.steps.at(-1).lhr,score=Math.round(lhr.categories.accessibility.score*100);
  const failures=Object.values(lhr.audits).filter(a=>a.score===0&&a.scoreDisplayMode==='binary').map(a=>({id:a.id,title:a.title,details:a.details}));report.scores.push({step:label,score,form_factor:lhr.configSettings.formFactor,failures});
  if(artifact){writeFileSync(join(artifact,`setup-${label.toLowerCase()}.lhr.json`),JSON.stringify(lhr,null,2));await page.screenshot({path:join(artifact,`setup-${label.toLowerCase()}-mobile.png`),fullPage:true});}
  console.log(`${label}: ${score}`);assert.equal(lhr.configSettings.formFactor,'mobile');assert(score>=report.minimum,`${label} accessibility below90`);assert.deepEqual(failures.map(f=>f.id),[],`${label} accessibility findings`);
 }
 assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.outbound,[]);assert.equal(h.world.supervisor.calls.length,0);assert.equal(h.world.f.db.prepare('SELECT COUNT(*) AS n FROM ops_browser_agent_configurations').get().n,0);
 report.passed=true;
}finally{
 if(artifact)writeFileSync(join(artifact,'browser-setup-lighthouse-report.json'),JSON.stringify(report,null,2));
 connected?.disconnect();await ctx?.close();await h?.close();const target=resolve(profile);assert.equal(dirname(target),resolve(tmpdir()));assert(basename(target).startsWith('pp-browser-setup-lighthouse-'));rmSync(target,{recursive:true,force:true});
}
