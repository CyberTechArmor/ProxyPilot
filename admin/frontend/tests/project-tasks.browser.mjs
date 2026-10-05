// Real pages, router, transactions, CSRF and consent. No host/provider/site is
// contacted. Signed launch, logout, overlap and revocation are runtime tests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { operationalSelectedBrowserMigration1118, operationalPublicNavigationMigration1123 } from '../../backend/src/lib/operational-selected-browser-schema.js';
import { operationalProjectTasksMigration1126 } from '../../backend/src/lib/operational-project-tasks-schema.js';
import { createSelectedBrowserService } from '../../backend/src/lib/operational-selected-browser-service.js';
import { createProjectTasks } from '../../backend/src/lib/operational-project-tasks.js';
import { startHarness, SUDO_PASSWORD, SUDO_TOTP } from './agent-runs-harness.mjs';

const require=createRequire(import.meta.url),axe=readFileSync(require.resolve('../../backend/node_modules/axe-core/axe.min.js'),'utf8');
const artifacts=process.env.BROWSER_ARTIFACTS||'.artifacts/project-tasks';mkdirSync(artifacts,{recursive:true});
let h;
h=await startHarness({execution:false,selectedBrowserFixture:world=>{
  for(const migration of [operationalSelectedBrowserMigration1118,operationalPublicNavigationMigration1123,operationalProjectTasksMigration1126])migration(world.f.adapter);
  const verifyElevation=a=>(h?.sudoUntil.get(a.id)||0)>Date.now(),verifyControl=a=>h?.controlGrants.has(a.jti)===true;
  const runs=createSelectedBrowserService({db:world.f.adapter,verifyElevation,verifyControl});
  return {execution:{configured:false},runs,projects:createProjectTasks({db:world.f.adapter,store:world.f.store,runs,isEnabled:()=>true,verifyElevation,verifyControl})};
}});
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||chromium.executablePath(),headless:true,args:process.env.LIGHTHOUSE_DIR?['--remote-debugging-port=9265']:[]});
const context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:'America/Detroit'});
await context.addCookies([{name:'pp_harness_user',value:'owner',url:h.origin},{name:'pp_csrf',value:'project-task-fixture',url:h.origin}]);
const page=await context.newPage(),errors=[],layouts=[],lighthouseScores=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
const proof=async path=>{const response=await context.request.post(h.origin+path,{headers:{'X-CSRF-Token':'project-task-fixture'},data:{password:SUDO_PASSWORD,totpCode:SUDO_TOTP}});assert.equal(response.status(),200);};
async function audit(surface) {
  // Audit the settled dialog, not an intermediate opacity animation frame.
  if(await page.getByRole('dialog').count())await page.getByRole('dialog').evaluate(el=>Promise.all(el.getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
  await page.evaluate(()=>{document.documentElement.style.overflowX='visible';document.body.style.overflowX='visible';});
  if(await page.getByRole('dialog').count()){
    const save=page.getByRole('dialog').getByRole('button',{name:/^Accept & save/});const box=await save.boundingBox();assert(box&&box.y>=0&&box.y+box.height<=page.viewportSize().height,`${surface} save stays visible`);
  }
  const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));assert(layout.scrollWidth<=layout.width+1,`${surface} overflows at ${layout.width}`);layouts.push({surface,...layout});
  await page.addScriptTag({content:axe});const result=await page.evaluate(()=>axe.run(document.querySelector('[role="dialog"]')||document.querySelector('[data-selected-project]')||document.body,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  if(result.violations.length)writeFileSync(`${artifacts}/accessibility-failure.json`,JSON.stringify({surface,width:layout.width,violations:result.violations},null,2));
  assert.deepEqual(result.violations.map(v=>({id:v.id,impact:v.impact})),[],`${surface} accessibility`);
  if(layout.width===375&&process.env.LIGHTHOUSE_DIR) {
    const directory=process.env.LIGHTHOUSE_DIR,{startFlow}=await import(pathToFileURL(`${directory}/node_modules/lighthouse/core/index.js`)),
      {default:puppeteer}=await import(pathToFileURL(`${directory}/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js`));
    const connection=await puppeteer.connect({browserURL:'http://127.0.0.1:9265'});
    try {
      const tab=(await connection.pages()).find(tab=>tab.url()===page.url());
      const flow=await startFlow(tab,{name:surface,config:{extends:'lighthouse:default',settings:{onlyCategories:['accessibility'],formFactor:'mobile',screenEmulation:{disabled:true}}}});
      await flow.snapshot({name:surface});const lhr=(await flow.createFlowResult()).steps.at(-1).lhr,score=Math.round(lhr.categories.accessibility.score*100);
      assert(score>=90,`${surface} Lighthouse accessibility`);lighthouseScores.push({surface,score});writeFileSync(`${artifacts}/${surface}.lhr.json`,JSON.stringify(lhr,null,2));
    }finally{connection.disconnect();}
  }
}
try {
  await proof('/api/auth/sudo');await proof('/api/auth/agent-control');
  await page.goto(h.origin+'/operational-projects');await page.getByRole('button',{name:'New project',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Accept & save',exact:true}).waitFor();
  assert.equal(await dialog.locator('input[required],textarea[required]').count(),3);
  assert.equal(await dialog.getByRole('button',{name:'Accept & save',exact:true}).isDisabled(),true);
  await dialog.getByLabel('Name',{exact:true}).fill('Pricing comparison');await dialog.getByLabel('Websites',{exact:true}).fill('example.com/pricing, shop.example.com/plans');await dialog.getByLabel('Goal',{exact:true}).fill('Compare prices and summarize the plans for a small team.');
  for(const width of [360,375,768,1280,1920]){await page.setViewportSize({width,height:900});await audit('new-project');}
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:`${artifacts}/new-project.png`});
  await dialog.getByRole('button',{name:'Accept & save',exact:true}).click();
  await page.getByRole('heading',{name:'Pricing comparison',exact:true}).waitFor();const pid=new URL(page.url()).pathname.split('/').at(-1);
  assert.equal(h.world.f.store.get(h.world.users.owner,pid).current_version.version_number,1);
  assert.equal(h.world.f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_consents WHERE project_id=?').get(pid).n,1);
  assert.equal(h.world.f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_runs').get().n,0);
  assert.equal(h.requests.filter(r=>r.method==='POST'&&r.path==='/api/operational-projects/project-tasks').length,1);
  await page.getByRole('button',{name:'Run now',exact:true}).waitFor();await page.getByRole('button',{name:'Schedule',exact:true}).waitFor();
  for(const width of [360,375,768,1280,1920]){await page.setViewportSize({width,height:900});await audit('overview');}
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:`${artifacts}/project-overview.png`});
  await page.getByRole('button',{name:'Schedule',exact:true}).click();await dialog.getByLabel('Repeat').selectOption('weekly');await dialog.getByLabel('Weekday').selectOption('1');await dialog.getByLabel('Time',{exact:true}).fill('09:00');assert.equal(await dialog.getByLabel('Timezone').inputValue(),'America/Detroit');
  for(const width of [360,375,768,1280,1920]){await page.setViewportSize({width,height:900});await audit('schedule');}
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:`${artifacts}/schedule.png`});
  await dialog.getByRole('button',{name:'Accept & save schedule',exact:true}).click();await page.getByText('Schedule · Active',{exact:true}).waitFor();
  await page.reload();await page.getByText('Schedule · Active',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByText('Schedule · Paused',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Accept & resume',exact:true}).click();await page.getByText('Schedule · Active',{exact:true}).waitFor();
  // Changing an existing daily schedule to weekly keeps a valid default day.
  await page.getByRole('button',{name:'Edit schedule',exact:true}).click();
  await dialog.getByLabel('Repeat').selectOption('daily');
  await dialog.getByRole('button',{name:'Accept & save schedule',exact:true}).click();await page.getByText('Schedule · Active',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Edit schedule',exact:true}).click();
  await dialog.getByLabel('Repeat').selectOption('weekly');assert.equal(await dialog.getByLabel('Weekday').inputValue(),'1');
  await dialog.getByRole('button',{name:'Accept & save schedule',exact:true}).click();await page.getByText('Schedule · Active',{exact:true}).waitFor();
  // A background refresh must not replace the revision captured by an open
  // schedule form and silently overwrite another tab's newly saved timing.
  await page.getByRole('button',{name:'Edit schedule',exact:true}).click();
  const current=(await (await context.request.get(h.origin+`/api/operational-projects/${pid}/task`)).json());
  const project=h.world.f.store.get(h.world.users.owner,pid),schedule=current.schedules[0];
  const concurrent=await context.request.put(h.origin+`/api/operational-projects/${pid}/task/schedule`,{headers:{'X-CSRF-Token':'project-task-fixture','If-Match':`"${schedule.revision}"`},data:{timing:{...schedule.timing,time:'10:00'},authorize_unattended:true,task_revision:current.task.revision,project_revision:project.revision,configuration_revision:current.task.configuration.revision}});
  assert.equal(concurrent.status(),200);
  const refreshed=page.waitForResponse(r=>r.url().endsWith(`/${pid}/task`)&&r.request().method()==='GET');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await refreshed;
  await dialog.getByLabel('Time',{exact:true}).fill('11:00');
  await dialog.getByRole('button',{name:'Accept & save schedule',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'This project changed.'}).waitFor();
  assert.equal(await dialog.getByLabel('Time',{exact:true}).inputValue(),'11:00');
  assert.equal((await (await context.request.get(h.origin+`/api/operational-projects/${pid}/task`)).json()).schedules[0].timing.time,'10:00');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Edit goal & settings',exact:true}).click();await dialog.getByLabel('Goal').fill('Compare only annual plans.');assert.equal(await dialog.getByLabel('Websites').isVisible(),true);assert.equal(await dialog.getByLabel('Websites').inputValue(),'https://example.com/pricing\nhttps://shop.example.com/plans');
  for(const width of [360,375,768,1280,1920]){await page.setViewportSize({width,height:900});await audit('edit-settings');}
  await dialog.getByRole('button',{name:'Accept & save',exact:true}).click();await page.getByText('Schedule · Paused',{exact:true}).waitFor();
  assert.equal(h.world.f.store.get(h.world.users.owner,pid).current_version.version_number,2);
  await page.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('button',{name:'Schedule',exact:true}).waitFor();
  await page.getByText('The browser runtime is unavailable. Check browser runtime readiness in Agents.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Run now',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('dialog').count(),0,'accepted session proofs must not ask again');
  assert(!h.requests.some(r=>r.method==='POST'&&r.path===`/api/operational-projects/${pid}/task/start`));
  assert.equal(h.world.f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_runs').get().n,0,'no installed host means no launch');
  // Legacy saved settings are never silently expanded. The visible owner
  // acceptance saves a new pinned policy/guide and matching disclosure consent.
  const old=(await (await context.request.get(h.origin+`/api/operational-projects/${pid}/task`)).json()).task.configuration;
  const oldPolicy=structuredClone(old.configuration);oldPolicy.destinations.request_rules=[];
  h.world.f.store.updateBrowserConfiguration(h.world.users.owner,pid,old.id,old.revision,{configuration:oldPolicy});
  await page.reload();await page.getByRole('button',{name:'Accept page-loading defaults',exact:true}).click();
  await page.getByText('Page-loading defaults accepted. Review any blocked run, then Run again.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Accept page-loading defaults',exact:true}).count(),0);
  const accepted=(await (await context.request.get(h.origin+`/api/operational-projects/${pid}/task`)).json());
  assert.equal(accepted.task.configuration.configuration.destinations.request_rules.length,4);
  assert.equal(h.world.f.store.get(h.world.users.owner,pid).current_version.version_number,3);
  // Scripted lifecycle responses isolate button behavior; signed launch and
  // stop/re-run are exercised with the real backend in runtime tests.
  const starts=[],ready={can_start:true,state:'ready',active_run:null,latest_run:null,checks:[]};
  await page.route(`**/api/operational-projects/${pid}/task/readiness`,route=>route.fulfill({json:ready}));
  await page.route(`**/api/operational-projects/${pid}/task/start`,async route=>{starts.push(route.request().postDataJSON());await route.fulfill({status:202,json:{run:{id:crypto.randomUUID(),state:'running'}}});});
  await page.getByRole('button',{name:'Check readiness',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-project-task] button').disabled);
  const firstStart=page.waitForResponse(r=>r.url().endsWith(`/${pid}/task/start`)&&r.request().method()==='POST');await page.getByRole('button',{name:'Run now',exact:true}).click();await firstStart;assert.equal(starts.length,1);
  await page.goto(h.origin+`/operational-projects/${pid}`);
  ready.can_start=false;ready.state='active';ready.active_run={id:crypto.randomUUID(),state:'awaiting_approval'};ready.latest_run=ready.active_run;
  await page.getByRole('button',{name:'Check readiness',exact:true}).click();await page.getByRole('button',{name:'Open active run',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Run again',exact:true}).isDisabled(),true);
  ready.can_start=true;ready.state='ready';ready.active_run=null;ready.latest_run={id:crypto.randomUUID(),state:'cancelled'};
  await page.getByRole('button',{name:'Check readiness',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-project-task] button').disabled);
  const secondStart=page.waitForResponse(r=>r.url().endsWith(`/${pid}/task/start`)&&r.request().method()==='POST');await page.getByRole('button',{name:'Run again',exact:true}).click();await secondStart;assert.equal(starts.length,2);assert.notEqual(starts[0].idempotency_key,starts[1].idempotency_key);
  await page.goto(h.origin+`/operational-projects/${pid}`);
  const blockedId=crypto.randomUUID(),uncertaintyId=crypto.randomUUID(),decisions=[];
  let unresolved=true;const blockedAttempt=crypto.randomUUID();h.controlGrants.clear();h.sudoUntil.clear();
  const blockedData=()=>({run:{id:blockedId,state:'uncertain',revision:8,attempt_id:blockedAttempt,fence:1,configuration_name:'Blocked browser task'},authorization:{elevated:(h.sudoUntil.get(h.world.users.owner.id)||0)>Date.now(),control_verified:h.controlGrants.size>0},controls:{},pending_approvals:[],receipts:[],uncertainties:unresolved?[{id:uncertaintyId,kind:'EXTERNAL_EFFECT_UNVERIFIED',state:'unresolved'}]:[]});
  ready.can_start=false;ready.state='blocked';ready.active_run=null;ready.latest_run={id:blockedId,state:'uncertain'};ready.review_runs=[{id:blockedId,state:'uncertain',unresolved_count:1}];ready.checks=[{kind:'uncertainty',state:'blocked',code:'UNRESOLVED_EFFECT'}];
  await page.route(`**/api/operational-projects/${pid}/browser-agent-runs/${blockedId}`,route=>route.fulfill({json:blockedData()}));
  await page.route(`**/api/operational-projects/${pid}/browser-agent-runs/${blockedId}/uncertainties/${uncertaintyId}/reconcile`,async route=>{
    decisions.push(route.request().postDataJSON());assert.equal(route.request().headers()['if-match'],'"8"');unresolved=false;
    ready.can_start=true;ready.state='ready';ready.review_runs=[];ready.checks=[];await route.fulfill({json:blockedData()});
  });
  await page.getByRole('button',{name:'Check readiness',exact:true}).click();await page.getByRole('button',{name:'Review blocked run',exact:true}).click();
  assert.equal(new URL(page.url()).searchParams.get('browser_run'),blockedId);assert.equal(new URL(page.url()).searchParams.get('browser_panel'),'review');
  await page.getByRole('button',{name:'I verified no effect occurred',exact:true}).waitFor();assert.equal(starts.length,2,'opening review cannot replay');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.getByRole('button',{name:'Back to project',exact:true}).isVisible(),true,'review provides a mobile return path');
  await page.getByRole('button',{name:'Verify session for review',exact:true}).click();
  const controlDialog=page.getByRole('dialog',{name:'Confirm it is you'});await controlDialog.waitFor();
  await controlDialog.getByLabel('Password',{exact:true}).fill(SUDO_PASSWORD);await controlDialog.getByLabel('Authenticator code',{exact:true}).fill(SUDO_TOTP);await controlDialog.getByRole('button',{name:'Confirm',exact:true}).click();
  const sudoDialog=page.getByRole('dialog',{name:'Confirm with password + TOTP'});await sudoDialog.getByLabel('Password',{exact:true}).fill(SUDO_PASSWORD);await sudoDialog.getByLabel('Authenticator Code',{exact:true}).fill(SUDO_TOTP);await sudoDialog.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Session verified. Select the intended decision below.'}).waitFor();assert.equal(decisions.length,0,'verification cannot submit or replay a decision');assert.equal(starts.length,2);
  await page.getByRole('button',{name:'I verified no effect occurred',exact:true}).click();await page.getByRole('status').filter({hasText:'Outcome recorded. Use Back to project, then Run again.'}).waitFor();
  assert.deepEqual(decisions,[{decision:'verified_no_effect'}]);assert.equal(starts.length,2,'recording outcome cannot replay');
  await page.getByRole('button',{name:'Back to project',exact:true}).click();
  await page.getByRole('button',{name:'Run again',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('[data-project-task] button').disabled);
  const recoveredStart=page.waitForResponse(r=>r.url().endsWith(`/${pid}/task/start`)&&r.request().method()==='POST');await page.getByRole('button',{name:'Run again',exact:true}).click();await recoveredStart;
  assert.equal(starts.length,3);assert.equal(new Set(starts.map(v=>v.idempotency_key)).size,3);
  assert.deepEqual(errors,[]);
  writeFileSync(`${artifacts}/results.json`,JSON.stringify({passed:true,layouts,lighthouse:lighthouseScores,page_errors:errors},null,2));console.log(JSON.stringify({passed:true,layouts:layouts.length,lighthouse:lighthouseScores}));
}finally{await context.close();await browser.close();await h.close();}
