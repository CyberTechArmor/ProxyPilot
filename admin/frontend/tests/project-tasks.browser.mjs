// Real pages, router, transactions, CSRF and consent. No host/provider/site is
// contacted. Signed launch, logout, overlap and revocation are runtime tests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||chromium.executablePath(),headless:true});
const context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:'America/Detroit'});
await context.addCookies([{name:'pp_harness_user',value:'owner',url:h.origin},{name:'pp_csrf',value:'project-task-fixture',url:h.origin}]);
const page=await context.newPage(),errors=[],layouts=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
const proof=async path=>{const response=await context.request.post(h.origin+path,{headers:{'X-CSRF-Token':'project-task-fixture'},data:{password:SUDO_PASSWORD,totpCode:SUDO_TOTP}});assert.equal(response.status(),200);};
async function audit(surface) {
  await page.evaluate(()=>{document.documentElement.style.overflowX='visible';document.body.style.overflowX='visible';});
  const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));assert(layout.scrollWidth<=layout.width+1,`${surface} overflows at ${layout.width}`);layouts.push({surface,...layout});
  await page.addScriptTag({content:axe});const result=await page.evaluate(()=>axe.run(document.querySelector('[role="dialog"]')||document.querySelector('[data-selected-project]')||document.body,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  assert.deepEqual(result.violations.map(v=>({id:v.id,impact:v.impact})),[],`${surface} accessibility`);
}
try {
  await proof('/api/auth/sudo');await proof('/api/auth/agent-control');
  await page.goto(h.origin+'/operational-projects');await page.getByRole('button',{name:'New project',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Accept & save',exact:true}).waitFor();
  assert.equal(await dialog.locator('input[required],textarea[required]').count(),2);
  assert.equal(await dialog.getByRole('button',{name:'Accept & save',exact:true}).isDisabled(),true);
  await dialog.getByLabel('Name',{exact:true}).fill('Pricing comparison');await dialog.getByLabel('Goal',{exact:true}).fill('Read https://example.com/pricing and summarize the plans for a small team.');
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
  await page.getByRole('button',{name:'Schedule',exact:true}).click();await dialog.getByLabel('Repeat').selectOption('weekly');await dialog.getByLabel('Weekday').selectOption('1');await dialog.getByLabel('Time').fill('09:00');assert.equal(await dialog.getByLabel('Timezone').inputValue(),'America/Detroit');
  for(const width of [360,375,768,1280,1920]){await page.setViewportSize({width,height:900});await audit('schedule');}
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:`${artifacts}/schedule.png`});
  await dialog.getByRole('button',{name:'Accept & save schedule',exact:true}).click();await page.getByText('Schedule · Active',{exact:true}).waitFor();
  await page.reload();await page.getByText('Schedule · Active',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByText('Schedule · Paused',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Accept & resume',exact:true}).click();await page.getByText('Schedule · Active',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Edit goal & settings',exact:true}).click();await dialog.getByLabel('Goal').fill('Read https://example.com/pricing and compare only annual plans.');
  for(const width of [360,375,768,1280,1920]){await page.setViewportSize({width,height:900});await audit('edit-settings');}
  await dialog.getByRole('button',{name:'Accept & save',exact:true}).click();await page.getByText('Schedule · Paused',{exact:true}).waitFor();
  assert.equal(h.world.f.store.get(h.world.users.owner,pid).current_version.version_number,2);
  await page.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('button',{name:'Schedule',exact:true}).waitFor();
  await page.getByRole('button',{name:'Run now',exact:true}).click();await page.getByRole('alert').filter({hasText:'INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED'}).waitFor();
  assert.equal(await page.getByRole('dialog').count(),0,'accepted session proofs must not ask again');
  assert(h.requests.some(r=>r.method==='POST'&&r.path===`/api/operational-projects/${pid}/task/start`));
  assert.equal(h.world.f.db.prepare('SELECT COUNT(*) AS n FROM ops_selected_browser_runs').get().n,0,'no installed host means no launch');
  assert.deepEqual(errors,[]);
  writeFileSync(`${artifacts}/results.json`,JSON.stringify({passed:true,layouts,page_errors:errors},null,2));console.log(JSON.stringify({passed:true,layouts:layouts.length}));
}finally{await context.close();await browser.close();await h.close();}
