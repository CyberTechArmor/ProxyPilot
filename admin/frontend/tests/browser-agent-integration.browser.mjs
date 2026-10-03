// Real Agents page, cookie/CSRF client, C0 HTTP routes and SQLite store.
// The selected runtime exposes readonly uninstalled readiness only. No host,
// model, credential or website operation exists in this fixture.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {chromium} from '../../backend/node_modules/playwright-core/index.mjs';
import {startHarness} from './agent-runs-harness.mjs';

const require=createRequire(import.meta.url),axeSource=readFileSync(require.resolve('../../backend/node_modules/axe-core/axe.min.js'),'utf8');
const artifacts=process.env.BROWSER_ARTIFACTS;if(artifacts)mkdirSync(artifacts,{recursive:true});
const lighthouseTools=process.env.BROWSER_LIGHTHOUSE_TOOLS;
const report={checks:[],layouts:[],page_errors:[]},browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/usr/bin/chromium',headless:true,args:lighthouseTools?['--remote-debugging-port=9237']:[]});
const h=await startHarness({execution:false,selectedBrowserFixture:world=>({execution:{configured:false},runs:{
  list(actor,pid){world.f.store.get(actor,pid);return {runs:[]};},
  readiness(actor,pid,cid){const {configuration}=world.f.store.browserConfiguration(actor,pid,cid),project=world.f.store.get(actor,pid);return {
    contract_version:'selected-browser.v1',can_start:false,pins:{project_revision:project.revision,configuration_revision:configuration.revision,configuration_sha256:configuration.configuration_sha256},
    checks:[{kind:'runtime',state:'blocked',code:'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED'}],model_consent:{allowed:false}};},
}})});
const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.page_errors.push(e.message));
try{
  const project=h.world.f.store.get(h.world.users.owner,h.world.p.id),configuration=JSON.parse(readFileSync(new URL('../src/components/operational-projects/browser-configuration-example.json',import.meta.url)));
  configuration.name='Canonical selected configuration';configuration.work.guide_ref={id:h.world.version.id,sha256:h.world.version.content_hash};
  const saved=h.world.f.store.createBrowserConfiguration(h.world.users.owner,project.id,project.revision,{configuration,source_text:'Synthetic immutable source for the shared editor.'});
  await context.addCookies([{name:'pp_harness_user',value:'owner',url:h.origin},{name:'pp_csrf',value:'shared-editor-csrf',url:h.origin}]);
  await context.addInitScript(user=>{localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('mock2HintDismissed','1');},h.world.users.owner);
  await page.goto(`${h.origin}/operational-projects/${project.id}?section=Agents`);
  const panel=page.locator('.browser-configurations'),runtime=page.getByRole('region',{name:'Selected browser runtime',exact:true});
  await runtime.waitFor();await panel.getByRole('button',{name:'Review configuration Canonical selected configuration',exact:true}).click();
  assert.equal(await panel.count(),1);assert.equal(await panel.getByLabel('Browser configuration JSON',{exact:true}).count(),1);assert.equal(await panel.getByRole('textbox',{name:'Original source',exact:true}).count(),1);
  assert.equal(await page.getByRole('navigation',{name:'Operation sections'}).getByRole('button',{name:'Browser agents',exact:true}).count(),0);
  assert.equal(await panel.getByText('Execution unavailable. Selected-site browser execution is not included in this release.',{exact:false}).count(),0);
  await runtime.getByRole('button',{name:'Check readiness',exact:true}).click();await runtime.getByText('Runtime readiness refreshed.',{exact:true}).waitFor();
  assert.equal(await runtime.getByRole('button',{name:'Start browser run',exact:true}).isDisabled(),true);await runtime.getByText(/installed, isolated browser runner/).waitFor();
  report.checks.push('API contract presence mounts one canonical editor in Agents even when runtime configured=false; fresh runtime readiness still blocks Start');
  await panel.getByRole('textbox',{name:'Configuration name',exact:true}).fill('Reviewed shared editor revision');
  assert.equal(await runtime.getByRole('button',{name:'Give model consent',exact:true}).isDisabled(),true);assert.equal(await runtime.getByRole('button',{name:'Check readiness',exact:true}).isDisabled(),true);
  await panel.getByRole('button',{name:'Validate configuration',exact:true}).click();await panel.getByText('Configuration validated. Review before explicitly saving.',{exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Save browser configuration',exact:true}).isDisabled(),true);await panel.getByRole('checkbox',{name:/I reviewed this configuration/}).check();
  await panel.getByRole('button',{name:'Save browser configuration',exact:true}).click();await panel.getByText('Configuration revision 2',{exact:true}).waitFor();
  const current=h.world.f.store.browserConfiguration(h.world.users.owner,project.id,saved.configuration.id).configuration;
  assert.equal(current.revision,2);assert.equal(current.source_text,'Synthetic immutable source for the shared editor.');assert.equal(current.configuration.name,'Reviewed shared editor revision');
  assert.equal(await runtime.getByRole('button',{name:'Start browser run',exact:true}).isDisabled(),true);report.checks.push('shared editor explicit validate/review/save reaches real C0 routes; source and revision retained; no consent or Start');
  // Only the conversion provider response is scripted; persistence uses real routes.
  let conversionSource = null;
  await page.route('**/browser-agent-configurations/convert/readiness', r => r.fulfill({json:{available:true}}));
  await page.route('**/browser-agent-configurations/convert', async r => {
    conversionSource=r.request().postDataJSON().source_text;
    await r.fulfill({json:{conversion:{id:'ui-conversion',state:'completed',source_text:conversionSource,result:{configuration:{...configuration,work:{...configuration.work,instructions:conversionSource}},requires_review:true,persisted:false,execution_enabled:false}}}});
  });
  await panel.getByRole('button',{name:'New browser configuration',exact:true}).click();
  assert.equal(await panel.getByLabel('Browser configuration JSON',{exact:true}).isVisible(),false);
  await panel.getByLabel('Website URL (optional if included in your request)',{exact:true}).fill('https://selected.example/reports');
  await panel.getByLabel('Original source',{exact:true}).fill('Summarize reports.');
  await panel.getByLabel('Additional task rules',{exact:true}).selectOption('custom');
  await panel.getByLabel('Task rules in plain language',{exact:true}).fill('Exclude archived reports.');
  await panel.getByLabel('Additional task rules',{exact:true}).selectOption('skip');
  await panel.getByText('Prepare a draft from instructions, images or files',{exact:true}).click();
  await panel.getByRole('button',{name:'Check conversion readiness',exact:true}).click();
  await panel.getByRole('checkbox',{name:/I reviewed: Send the original instructions/}).check();
  await panel.getByRole('button',{name:'Suggest editable draft',exact:true}).click();
  await panel.getByRole('button',{name:'Place suggestion in editor for review',exact:true}).waitFor();
  assert.equal(conversionSource,'Website: https://selected.example/reports\n\nSummarize reports.');
  await panel.getByLabel('Additional task rules',{exact:true}).selectOption('custom');
  assert.equal(await panel.getByRole('button',{name:'Place suggestion in editor for review',exact:true}).isDisabled(),true);
  await panel.getByRole('checkbox',{name:/I reviewed: Send the original instructions/}).check();
  await panel.getByRole('button',{name:'Suggest editable draft',exact:true}).click();
  await panel.getByRole('button',{name:'Place suggestion in editor for review',exact:true}).click();
  assert.match(conversionSource,/Additional task rules:\nExclude archived reports\.$/);
  assert.equal(await panel.getByLabel('Browser task instructions',{exact:true}).inputValue(),conversionSource);
  assert.equal(await panel.getByRole('button',{name:'Save browser configuration',exact:true}).isDisabled(),true);
  await panel.getByRole('button',{name:'Validate configuration',exact:true}).click();
  await panel.getByRole('checkbox',{name:/I reviewed this configuration/}).check();
  await panel.getByRole('button',{name:'Save browser configuration',exact:true}).click();
  await panel.getByText('Configuration revision 1',{exact:true}).waitFor();
  assert.equal(await panel.getByLabel('Original source',{exact:true}).inputValue(),conversionSource);
  report.checks.push('request converts without JSON; skipped rules excluded, selected rules included, stale suggestion blocked, explicit save preserves source');
  for(const [width,height]of[[360,640],[375,667],[768,640],[1280,800],[1920,900]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>{document.documentElement.style.overflowX='visible';document.body.style.overflowX='visible';});
    const dimensions=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,scrollTop:document.scrollingElement.scrollTop}));
    assert.equal(dimensions.scrollWidth,width);assert.ok(dimensions.scrollHeight<=height);assert.equal(dimensions.scrollTop,0);
    await runtime.getByRole('button',{name:'Start browser run',exact:true}).scrollIntoViewIfNeeded();const control=await runtime.getByRole('button',{name:'Start browser run',exact:true}).boundingBox();assert.ok(control.x>=0&&control.x+control.width<=width&&control.y>=0&&control.y+control.height<=height,JSON.stringify({width,height,control}));if(width<640)assert.ok(control.height>=44,'Primary mobile action is at least44px');
    await page.evaluate(axeSource);const axe=await page.evaluate(()=>window.axe.run(document.querySelector('.browser-configurations'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(axe.violations.map(v=>v.id),[]);
    report.layouts.push({...dimensions,accessibility_violations:0});if(artifacts)await page.screenshot({path:`${artifacts}/shared-runtime-${width}x${height}.png`});
  }
  report.checks.push('all five actual viewports use internal scrolling with reachable runtime actions and zero document overflow or axe violations');
  if(lighthouseTools){
    const tools=createRequire(`${lighthouseTools}/package.json`),{snapshot}=await import(`${lighthouseTools}/node_modules/lighthouse/core/index.js`),puppeteer=tools('puppeteer-core');
    await page.setViewportSize({width:375,height:667});await runtime.getByRole('button',{name:'Check readiness',exact:true}).click();await runtime.getByText('Runtime readiness refreshed.',{exact:true}).waitFor();
    const auditBrowser=await puppeteer.connect({browserURL:'http://127.0.0.1:9237'});
    try {const auditPage=(await auditBrowser.pages()).find(p=>p.url()===page.url());assert.ok(auditPage);await auditPage.setViewport({width:375,height:667,isMobile:true,hasTouch:true,deviceScaleFactor:1});
      const result=await snapshot(auditPage,{config:{extends:'lighthouse:default',settings:{onlyCategories:['accessibility'],formFactor:'mobile'}},flags:{logLevel:'error'}}),score=result.lhr.categories.accessibility.score;
      assert.ok(score>=0.9,`Mobile Lighthouse accessibility ${score}`);report.lighthouse_mobile={score,width:375,height:667,gather_mode:'snapshot',page:'Real Agents page, canonical selected editor and uninstalled runtime'};
      if(artifacts)writeFileSync(`${artifacts}/lighthouse-shared-runtime-mobile.json`,JSON.stringify(result.lhr,null,2)+'\n');
    }finally{await auditBrowser.disconnect();}
  }

  // Exercise the real public-run component and non-replaying HTTP client with
  // scripted cleanup replies. Host proof is covered by the runtime tests.
  const publicId='10000000-0000-4000-8000-000000000001',attemptId='10000000-0000-4000-8000-000000000002';
  let publicData={run:{id:publicId,attempt_id:attemptId,configuration_id:'10000000-0000-4000-8000-000000000003',revision:3,state:'uncertain',execution_mode:'public_navigation',result_code:'LAUNCH_UNCERTAIN',launch_failure_code:'NETWORK_ROUTE_UNVERIFIED',uncertain:true,usage:{requests:0,response_bytes:0}},
    controls:{can_cancel:false,can_live:false},receipts:[],uncertainties:[{id:'cleanup-fixture',kind:'CLEANUP_UNVERIFIED',state:'unresolved'}]};
  let retries=0;
  await page.route('**/browser-agent-runs',r=>r.fulfill({json:{runs:[publicData.run]}}));
  await page.route('**/browser-agent-runs/'+publicId,r=>r.fulfill({json:publicData}));
  await page.route('**/browser-agent-runs/'+publicId+'/retry-cleanup',async r=>{
    retries++;assert.equal(r.request().method(),'POST');assert.equal(r.request().headers()['if-match'],'"3"');
    if(retries===1)return r.fulfill({status:403,json:{error:'Cleanup needs a verified session.',code:'ELEVATION_REQUIRED'}});
    publicData={...publicData,run:{...publicData.run,revision:4,uncertain:false},
      receipts:[{closed:{browser:true,network:true,session:true,temporary_files:true}}],
      uncertainties:[{...publicData.uncertainties[0],state:'reconciled',decision:'signed_cleanup_verified'}]};
    return r.fulfill({json:publicData});
  });
  await page.reload();
  await page.getByRole('button',{name:'Inspect browser run',exact:true}).click();
  const publicRun=page.getByRole('region',{name:'Public browser activity',exact:true});
  await publicRun.getByText('Browser launch refused: NETWORK ROUTE UNVERIFIED',{exact:true}).waitFor();
  await publicRun.getByRole('button',{name:'Verify session for cleanup',exact:true}).waitFor();
  await publicRun.getByRole('button',{name:'Retry verified cleanup',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Cleanup needs a verified session. (ELEVATION_REQUIRED)'}).waitFor();
  await page.waitForTimeout(100);
  assert.equal(retries,1);assert.equal(await publicRun.getByRole('button',{name:'Retry verified cleanup',exact:true}).count(),1);
  await publicRun.getByRole('button',{name:'Retry verified cleanup',exact:true}).click();
  await runtime.getByText('Cleanup checked. Inspect the receipt and check browser readiness again.',{exact:true}).waitFor();
  assert.equal(retries,2);assert.equal(await publicRun.getByRole('button',{name:'Retry verified cleanup',exact:true}).count(),0);
  await publicRun.getByText('Cleanup: browser closed · network closed · session closed · temporary files closed',{exact:true}).waitFor();
  assert.equal(await page.getByText(publicId,{exact:true}).count(),1);
  report.checks.push('uncertain public-run history offers explicit verified cleanup; elevation refusal stays visible with no replay; signed closure hides retry and retains the run');
  assert.deepEqual(report.page_errors,[]);assert.equal(h.requests.some(r=>r.method!=='GET'&&/\/start|\/model-consent|\/convert/.test(r.path)),false);assert.equal(h.world.supervisor.calls.length,0);report.passed=true;
}finally{await context.close();await h.close();await browser.close();if(artifacts)writeFileSync(`${artifacts}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
