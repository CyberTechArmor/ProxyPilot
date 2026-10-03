// Real app, shared cookie/CSRF client, Operations HTTP routes and SQLite store.
// Only authentication/session fixtures and the legacy supervisor are scripted.
// No external website, model provider or host is contacted.
import assert from 'node:assert/strict';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { startHarness } from './agent-runs-harness.mjs';

const artifacts=process.env.BROWSER_ARTIFACTS;if(artifacts)mkdirSync(artifacts,{recursive:true});
const report={journeys:[],layouts:[],a11y:[],started_at:new Date().toISOString()};
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/usr/bin/chromium',headless:true});
const h=await startHarness({execution:false}),contexts=[];
const path=`/${h.world.p.id}/browser-agent-configurations`;
const imported=JSON.parse(readFileSync(new URL('../src/components/operational-projects/browser-configuration-example.json',import.meta.url),'utf8'));
const source='Original instructions: café\nPRIVATE_SOURCE_CANARY retained exactly.';
const wrap=JSON.stringify({configuration:imported,source_text:source},null,2);
const count=table=>h.world.f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const panel=page=>page.locator('.browser-configurations');
const json=page=>panel(page).getByLabel('Browser configuration JSON',{exact:true});
const review=page=>panel(page).getByRole('checkbox',{name:/I reviewed this configuration/});
const save=page=>panel(page).getByRole('button',{name:'Save browser configuration',exact:true});
async function as(role,width=1280){
  const context=await browser.newContext({viewport:{width,height:800}});contexts.push(context);
  await context.addCookies([{name:'pp_harness_user',value:role,url:h.origin},{name:'pp_csrf',value:'config-csrf',url:h.origin}]);
  const u=h.world.users[role];await context.addInitScript(user=>{localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('mock2HintDismissed','1');},u);
  const page=await context.newPage();page.setDefaultTimeout(12000);page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
  await page.goto(`${h.origin}/operational-projects/${h.world.p.id}?section=Agents`);await panel(page).waitFor();
  await panel(page).getByRole('status').filter({hasText:'Loading configurations…'}).waitFor({state:'hidden'});return page;
}
async function journey(name,fn){try{await fn();report.journeys.push({name,passed:true});console.log(`ok - ${name}`);}catch(e){report.journeys.push({name,passed:false,error:e.message});throw e;}}
async function validate(page){await panel(page).getByRole('button',{name:'Validate configuration',exact:true}).click();await panel(page).getByText('Configuration validated. Review before explicitly saving.',{exact:true}).waitFor();}
let owner,record;
try{
  await journey('paste, typed errors, editable settings and explicit current-guide validation/save',async()=>{
    owner=await as('owner');await json(owner).fill('{unfinished');await panel(owner).getByRole('button',{name:'Validate configuration',exact:true}).click();
    await panel(owner).getByRole('alert').filter({hasText:'Enter valid JSON.'}).waitFor();assert.equal(await json(owner).inputValue(),'{unfinished');
    const malformed=structuredClone(imported);malformed.work=null;await json(owner).fill(JSON.stringify(malformed));
    await panel(owner).getByRole('button',{name:'Validate configuration',exact:true}).click();await panel(owner).getByRole('alert').filter({hasText:'configuration.work'}).waitFor();assert.deepEqual(owner.errors,[]);
    await json(owner).fill(wrap);assert.equal(await panel(owner).getByLabel('Original source',{exact:true}).inputValue(),source);
    assert.equal(count('ops_browser_agent_configurations'),0);assert.equal(await save(owner).isDisabled(),true);
    await panel(owner).getByRole('button',{name:'Use current approved guide',exact:true}).click();
    await panel(owner).getByLabel('Configuration name',{exact:true}).fill('First reviewed browser configuration');
    await panel(owner).getByLabel('Maximum seconds',{exact:true}).fill('120');
    assert.equal(await panel(owner).getByLabel('Original source',{exact:true}).inputValue(),source);
    await validate(owner);assert.equal(count('ops_browser_agent_configurations'),0);assert.equal(await save(owner).isDisabled(),true);
    await review(owner).check();assert.equal(await save(owner).isDisabled(),false);await save(owner).click();
    await panel(owner).getByText('Configuration saved as a non-executable draft. No run started.',{exact:true}).waitFor();
    record=h.world.f.db.prepare('SELECT * FROM ops_browser_agent_configurations').get();assert.equal(record.source_text,source);assert.equal(record.revision,1);assert.equal(record.execution_enabled,0);
    const config=JSON.parse(record.configuration_json);assert.equal(config.work.guide_ref.id,h.world.version.id);assert.equal(config.work.guide_ref.sha256,h.world.version.content_hash);assert.equal(config.budgets.max_seconds,120);
    const post=h.requests.find(r=>r.path===`/api/operational-projects${path}`&&r.method==='POST');assert.ok(post,'saved through the real authenticated HTTP route');
  });
  await journey('editing retains source, immutable history and stale-revision input',async()=>{
    await panel(owner).getByLabel('Configuration name',{exact:true}).fill('Second reviewed revision');assert.equal(await review(owner).isDisabled(),true);
    await validate(owner);await review(owner).check();await save(owner).click();await panel(owner).getByText('Configuration revision 2',{exact:true}).waitFor();
    const versions=h.world.f.db.prepare('SELECT * FROM ops_browser_agent_configuration_versions WHERE configuration_id=? ORDER BY revision').all(record.id);
    assert.equal(versions.length,2);assert.equal(versions[0].source_text,source);assert.equal(JSON.parse(versions[0].configuration_json).name,'First reviewed browser configuration');
    const concurrent=JSON.parse(versions[1].configuration_json);concurrent.name='Concurrent reviewed revision';concurrent.budgets.max_seconds=180;
    h.world.f.store.updateBrowserConfiguration(h.world.users.owner,h.world.p.id,record.id,2,{configuration:concurrent});
    await panel(owner).getByLabel('Configuration name',{exact:true}).fill('Local retained edit');await validate(owner);await review(owner).check();await save(owner).click();
    await panel(owner).getByRole('alert').filter({hasText:'Your edits are retained'}).waitFor();assert.equal(JSON.parse(await json(owner).inputValue()).name,'Local retained edit');assert.equal(await save(owner).isDisabled(),true);
    const retained=await json(owner).inputValue(),retainedSource=await panel(owner).getByLabel('Original source',{exact:true}).inputValue();
    const patches=h.requests.filter(r=>r.path===`/api/operational-projects${path}/${record.id}`&&r.method==='PATCH').length;
    await panel(owner).getByRole('button',{name:'Refresh project details',exact:true}).click();
    await panel(owner).getByText('Project and configuration list refreshed. Local edits retained; any revision conflict still requires reconciliation.',{exact:true}).waitFor();
    assert.equal(await json(owner).inputValue(),retained);assert.equal(await panel(owner).getByLabel('Original source',{exact:true}).inputValue(),retainedSource);
    await panel(owner).getByRole('button',{name:'Review configuration Concurrent reviewed revision',exact:true}).waitFor();
    assert.equal(await panel(owner).getByRole('button',{name:'Validate configuration',exact:true}).isDisabled(),true);assert.equal(await review(owner).isDisabled(),true);assert.equal(await save(owner).isDisabled(),true);
    assert.equal(h.requests.filter(r=>r.path===`/api/operational-projects${path}/${record.id}`&&r.method==='PATCH').length,patches);
    assert.equal(h.world.f.db.prepare('SELECT revision FROM ops_browser_agent_configurations WHERE id=?').get(record.id).revision,3);
    await panel(owner).getByRole('button',{name:'Reload saved configuration',exact:true}).click();await panel(owner).getByText('Configuration revision 3',{exact:true}).waitFor();assert.equal(JSON.parse(await json(owner).inputValue()).name,'Concurrent reviewed revision');
    assert.equal(JSON.parse(await json(owner).inputValue()).budgets.max_seconds,180);
    await panel(owner).getByLabel('Configuration name',{exact:true}).fill('Reviewed after reconciliation');await validate(owner);await review(owner).check();
    const updated=owner.waitForRequest(r=>r.method()==='PATCH'&&r.url().endsWith(`${path}/${record.id}`));await save(owner).click();
    assert.equal((await updated).headers()['if-match'],'"3"');await panel(owner).getByText('Configuration revision 4',{exact:true}).waitFor();
    const reconciled=JSON.parse(h.world.f.db.prepare('SELECT configuration_json FROM ops_browser_agent_configurations WHERE id=?').get(record.id).configuration_json);
    assert.equal(reconciled.name,'Reviewed after reconciliation');assert.equal(reconciled.budgets.max_seconds,180);
  });
  await journey('new draft conflict requires explicit refreshed-project acceptance and retains edits',async()=>{
    await panel(owner).getByRole('button',{name:'New browser configuration',exact:true}).click();await json(owner).fill(wrap);
    await panel(owner).getByRole('button',{name:'Use current approved guide',exact:true}).click();
    await panel(owner).getByLabel('Configuration name',{exact:true}).fill('Unsaved retained draft');await validate(owner);await review(owner).check();
    const project=h.world.f.store.get(h.world.users.owner,h.world.p.id);
    h.world.f.store.update(h.world.users.owner,h.world.p.id,project.revision,{description:'Concurrent project metadata edit'});
    await save(owner).click();await panel(owner).getByRole('alert').filter({hasText:'Your edits are retained'}).waitFor();
    const retained=await json(owner).inputValue(),original=await panel(owner).getByLabel('Original source',{exact:true}).inputValue();
    const accept=panel(owner).getByRole('button',{name:'Accept refreshed project revision for this draft',exact:true});assert.equal(await accept.isDisabled(),true);
    await panel(owner).getByRole('button',{name:'Refresh project details',exact:true}).click();
    await panel(owner).getByText('Project and configuration list refreshed. Local edits retained; any revision conflict still requires reconciliation.',{exact:true}).waitFor();
    assert.equal(await json(owner).inputValue(),retained);assert.equal(await panel(owner).getByLabel('Original source',{exact:true}).inputValue(),original);
    assert.equal(await panel(owner).getByRole('button',{name:'Validate configuration',exact:true}).isDisabled(),true);assert.equal(await review(owner).isDisabled(),true);assert.equal(await save(owner).isDisabled(),true);assert.equal(count('ops_browser_agent_configurations'),1);
    await owner.setViewportSize({width:360,height:640});await owner.evaluate(()=>{document.documentElement.style.overflowX='visible';document.body.style.overflowX='visible';});
    await accept.scrollIntoViewIfNeeded();const control=await accept.boundingBox();assert.ok(control.x>=0&&control.x+control.width<=360&&control.height>=44);
    assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth),360);
    await accept.click();assert.equal(await json(owner).inputValue(),retained);assert.equal(await panel(owner).getByLabel('Original source',{exact:true}).inputValue(),original);
    assert.equal(await review(owner).isDisabled(),true);await validate(owner);await review(owner).check();assert.equal(await save(owner).isDisabled(),false);
    assert.equal(count('ops_browser_agent_configurations'),1);
    await owner.setViewportSize({width:1280,height:800});
  });
  await journey('exact paste provenance survives structured editing and example load never saves',async()=>{
    await panel(owner).getByRole('button',{name:'New browser configuration',exact:true}).click();
    const exact='  '+JSON.stringify(imported)+'\n';await json(owner).fill(exact);await panel(owner).getByLabel('Configuration name',{exact:true}).fill('Changed after exact paste');
    assert.equal(await panel(owner).getByLabel('Original source',{exact:true}).inputValue(),exact);assert.equal(count('ops_browser_agent_configurations'),1);
    await panel(owner).getByRole('button',{name:'Load example for editing',exact:true}).click();assert.equal(count('ops_browser_agent_configurations'),1);
    await panel(owner).getByRole('button',{name:'Use current approved guide',exact:true}).click();await validate(owner);
    assert.equal(await save(owner).isDisabled(),true);assert.equal(h.world.supervisor.calls.length,0);
    assert.equal(await panel(owner).getByRole('button',{name:/Start|Give model consent|Convert/}).count(),0);
    const storage=await owner.evaluate(()=>Object.entries(localStorage));assert.equal(JSON.stringify(storage).includes('PRIVATE_SOURCE_CANARY'),false);
  });
  await journey('phone/tablet/desktop internal scrolling, accessible form and fixed viewport',async()=>{
    let AxeBuilder;if(process.env.BROWSER_TEST_TOOLS){const require=createRequire(`${process.env.BROWSER_TEST_TOOLS}/package.json`);AxeBuilder=require('@axe-core/playwright').default;}
    for(const [width,height]of[[360,640],[375,667],[768,640],[1280,800],[1920,900]]){
      await owner.setViewportSize({width,height});await owner.evaluate(()=>{document.documentElement.style.overflowX='visible';document.body.style.overflowX='visible';});
      const viewport=await owner.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,scrollTop:document.scrollingElement.scrollTop}));
      assert.equal(viewport.scrollWidth,width);assert.ok(viewport.scrollHeight<=height);assert.equal(viewport.scrollTop,0);report.layouts.push(viewport);
      await panel(owner).getByLabel('Maximum tokens',{exact:true}).scrollIntoViewIfNeeded();const field=await panel(owner).getByLabel('Maximum tokens',{exact:true}).boundingBox();assert.ok(field.y>=0&&field.y+field.height<=height,'budget control reachable through internal scrolling');
      if(artifacts)await owner.screenshot({path:`${artifacts}/budget-editor-${width}.png`});
      await panel(owner).getByRole('heading',{name:'Readiness: execution unavailable',exact:true}).scrollIntoViewIfNeeded();
      if(artifacts)await owner.screenshot({path:`${artifacts}/readiness-${width}.png`});
      if(AxeBuilder){const results=await new AxeBuilder({page:owner}).include('.browser-configurations').analyze();assert.deepEqual(results.violations.map(v=>v.id),[]);report.a11y.push({width,height,violations:0});}
      if(artifacts){await panel(owner).getByRole('heading',{name:'Browser configurations',exact:true}).scrollIntoViewIfNeeded();await owner.screenshot({path:`${artifacts}/configuration-${width}.png`});}
    }
    await owner.reload();await panel(owner).getByRole('button',{name:'Review configuration Reviewed after reconciliation',exact:true}).waitFor();assert.equal(count('ops_browser_agent_configurations'),1);
  });
  await journey('current guide changes block validation; readonly roles cannot edit; revocation clears private input',async()=>{
    const editor=await as('editor');await json(editor).fill(wrap);await panel(editor).getByRole('button',{name:'Use current approved guide',exact:true}).click();
    const old=h.world.version;h.world.f.store.startRevision(h.world.users.owner,h.world.p.id,h.world.f.store.draft(h.world.users.owner,h.world.p.id).revision,{version_id:old.id,discard_draft:true});
    h.world.f.store.saveDraft(h.world.users.owner,h.world.p.id,h.world.f.store.draft(h.world.users.owner,h.world.p.id).revision,{title:'Changed guide',instructions:'Changed approved instructions.'});
    await panel(editor).getByRole('button',{name:'Validate configuration',exact:true}).click();await panel(editor).getByRole('alert').filter({hasText:'The selected guide is not current'}).waitFor();assert.equal(await save(editor).isDisabled(),true);
    h.world.f.db.prepare('DELETE FROM ops_project_grants WHERE project_id=? AND user_id=?').run(h.world.p.id,h.world.users.editor.id);
    await panel(editor).getByRole('button',{name:'Validate configuration',exact:true}).click();await editor.waitForFunction(()=>!document.querySelector('.browser-configurations textarea'));
    assert.equal((await editor.locator('main').innerText()).includes(source),false);
    const viewer=await as('viewer');assert.equal(await panel(viewer).getByRole('button',{name:/New browser configuration|Validate configuration|Save browser configuration/}).count(),0);
    await panel(viewer).getByRole('button',{name:/Review configuration/}).click();assert.equal(await json(viewer).isDisabled(),true);assert.equal(await panel(viewer).getByLabel('Original source',{exact:true}).inputValue(),source);
    await panel(viewer).getByRole('button',{name:'Check configuration readiness',exact:true}).click();await panel(viewer).getByText('The pinned guide is no longer current.',{exact:true}).waitFor();
  });
  assert.equal(count('ops_agent_runs'),0);assert.equal(h.world.supervisor.calls.length,0);
  assert.equal(h.requests.some(r=>/\/browser-agent-runs|\/browser-assets|\/browser-agent-configurations\/convert|\/browser-agent-configurations\/[^/]+\/(start|model-consent)/.test(r.path)),false);
  report.execution_requests=0;report.model_calls=0;report.external_contacts=0;report.passed=true;
}finally{
  for(const context of contexts)await context.close();await h.close();await browser.close();report.finished_at=new Date().toISOString();
  if(artifacts)writeFileSync(`${artifacts}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
