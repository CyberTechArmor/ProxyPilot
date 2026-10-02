// Local fixture-only journeys for the authorized saved-approved guide policy.
// Run after combining the Operations UI and guide-policy commits. No host,
// credential, enrollment, runtime activation or remote infrastructure is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { guideHash } from '../../backend/src/lib/operational-projects-workflow.js';
import { startHarness } from './agent-runs-harness.mjs';

const h=await startHarness({execution:false});
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/opt/pw-browsers/chromium',headless:true});
const contexts=[];
const errors=[],report={source_commit:process.env.SOURCE_COMMIT,real_router:true,layout:[],screenshots:[],controlled_evidence_cas:false};
const artifacts=process.env.BROWSER_ARTIFACTS;
if(artifacts)mkdirSync(artifacts,{recursive:true});
async function as(role,width=375) {
  const context=await browser.newContext({viewport:{width,height:900}});contexts.push(context);
  await context.addCookies([{name:'pp_harness_user',value:role,url:h.origin},{name:'pp_csrf',value:'operations-guide-fixture',url:h.origin}]);
  await context.addInitScript(()=>localStorage.setItem('mock2HintDismissed','1'));
  const page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(90000);
  page.on('pageerror',e=>errors.push(e.message));
  return page;
}
const sections=page=>page.getByRole('navigation',{name:'Operation sections'});
async function audit(page,width,state) {
  await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});
  const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth}));
  assert(size.scroll<=size.width,`${state} overflow at ${width}: ${size.scroll}`);
  report.layout.push({width,state,...size});
  if(artifacts){const name=`guide-${state}-${width}.png`;await page.screenshot({path:`${artifacts}/${name}`,animations:'disabled',fullPage:true});report.screenshots.push(name);}
}
try {
  const owner=await as('owner');
  const created=h.world.f.store.create(h.world.users.owner,{name:'Fixture reporting procedure',description:'A private local guide fixture'});
  const id=created.id;
  await owner.goto(h.origin+'/operational-projects/'+id+'?section=Guide');
  await sections(owner).getByRole('button',{name:'Guide',exact:true}).click();
  await owner.getByLabel('Guide title').fill('Reporting procedure v1');
  await owner.getByLabel('Instructions',{exact:true}).fill('Read the local reporting fixture and summarize the result.');
  const beforeRequests=h.requests.length;
  await owner.getByRole('button',{name:'Save and approve',exact:true}).click();
  await owner.getByRole('button',{name:'Edit guide',exact:true}).waitFor();
  const first=h.world.f.store.get(h.world.users.owner,id).current_version;
  assert.equal(first.version_number,1);
  assert.equal(first.content_hash,guideHash(first.title,first.instructions));
  assert.equal(h.requests.slice(beforeRequests).some(r=>r.method==='POST'&&/\/submissions$/.test(r.path)),false,'save must not require separate submission');
  await owner.getByRole('button',{name:'Edit guide',exact:true}).click();
  await owner.getByLabel('Guide title').fill('Reporting procedure v2');
  await owner.getByLabel('Instructions',{exact:true}).fill('Read the local reporting fixture and note the source version.');
  await owner.getByRole('button',{name:'Save and approve',exact:true}).click();
  await owner.getByRole('button',{name:'Edit guide',exact:true}).waitFor();
  const second=h.world.f.store.get(h.world.users.owner,id).current_version;
  assert.equal(second.version_number,2);
  const pinned=h.world.f.store.version(h.world.users.owner,id,first.id).version;
  assert.equal(pinned.instructions,first.instructions,'earlier approved content stays immutable');
  assert.equal(pinned.content_hash,first.content_hash);

  // Reproduce an existing pending snapshot without implicitly approving it in
  // fixture setup. A deliberate user action is the only publication trigger.
  const pendingProject=h.world.f.store.create(h.world.users.owner,{name:'Fixture pending guide'});
  const title='Previously saved guide',instructions='Preserve these exact pending instructions.';
  const submissionId=randomUUID(),contentHash=guideHash(title,instructions);
  h.world.f.db.prepare('UPDATE ops_guide_drafts SET title=?,instructions=?,revision=revision+1 WHERE project_id=?').run(title,instructions,pendingProject.id);
  h.world.f.db.prepare('INSERT INTO ops_guide_submissions(id,project_id,draft_revision,title,instructions,content_hash,contributors_json,submitted_by,submitted_at) VALUES(?,?,?,?,?,?,?,?,?)').run(submissionId,pendingProject.id,2,title,instructions,contentHash,JSON.stringify([h.world.users.owner.id]),h.world.users.owner.id,new Date().toISOString());
  await owner.goto(h.origin+'/operational-projects/'+pendingProject.id+'?section=Guide');
  await owner.getByRole('heading',{name:'Saved snapshot awaiting approval'}).waitFor();
  assert.equal(h.world.f.store.get(h.world.users.owner,pendingProject.id).current_version,null);
  for(const width of [360,375,390,768,1280]){await owner.setViewportSize({width,height:900});await audit(owner,width,'pending');}
  await owner.getByRole('button',{name:'Save and approve',exact:true}).click();
  await owner.getByRole('button',{name:'Edit guide',exact:true}).waitFor();
  const approved=h.world.f.store.get(h.world.users.owner,pendingProject.id).current_version;
  assert.equal(approved.content_hash,contentHash);
  assert.equal(approved.submission_id,submissionId);
  assert.equal(approved.instructions,instructions);
  const project=h.world.f.store.get(h.world.users.owner,pendingProject.id);
  h.world.f.store.grant(h.world.users.owner,pendingProject.id,h.world.users.viewer.id,project.revision,{role:'viewer'});
  const viewer=await as('viewer');
  await viewer.goto(h.origin+'/operational-projects/'+pendingProject.id+'?section=Guide');
  await viewer.getByRole('heading',{name:'Previously saved guide',exact:true}).waitFor();
  assert.equal(await viewer.getByRole('button',{name:'Save and approve',exact:true}).count(),0);
  assert.equal(await viewer.getByRole('button',{name:'Edit guide',exact:true}).count(),0);
  for(const width of [360,375,390,768,1280]) {
    await viewer.setViewportSize({width,height:900});await audit(viewer,width,'viewer');
    await owner.setViewportSize({width,height:900});await owner.getByRole('button',{name:'Edit guide',exact:true}).click();
    await owner.getByLabel('Guide title').waitFor();const save=owner.getByRole('button',{name:'Save and approve',exact:true});
    if(width<640)assert((await save.boundingBox()).height>=44,'phone save target must be at least 44px');
    await audit(owner,width,'edit');
    await sections(owner).getByRole('button',{name:'Overview',exact:true}).click();
    await sections(owner).getByRole('button',{name:'Guide',exact:true}).click();
    await owner.getByRole('button',{name:'Save and approve',exact:true}).waitFor();
    // Discarding local input reloads the current base; it never publishes it.
    await owner.getByRole('button',{name:'Discard local draft edits',exact:true}).click();
    // The revision was explicitly started above. Publish it once to restore
    // the read state for the next width; publication must still be deliberate.
    await save.click();await owner.getByRole('button',{name:'Edit guide',exact:true}).waitFor();
  }

  // Controlled API response reproduction of a remounted evidence editor. The
  // actual guide UI must retain its older text revision, even when an evidence
  // selection is saved against a newer server revision. Backend CAS and real
  // evidence integrity are covered separately by operational-guide-save.test.
  const cas=h.world.f.store.create(h.world.users.owner,{name:'Fixture concurrent evidence guide'});
  let revision=1,references=[{demonstration_id:randomUUID(),revision_id:randomUUID(),item_position:0,object_id:randomUUID(),annotation_id:randomUUID(),available:false}];
  const casRequests=[];
  await owner.route('**/api/operational-projects/capabilities',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({enabled:true,ui_available:true,evidence_enabled:true,agents_metadata_enabled:false,agent_runs_enabled:false})}));
  await owner.route(`**/api/operational-projects/${cas.id}/**`,async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    const answer=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    casRequests.push({path,method,ifMatch:request.headers()['if-match']});
    if(path.endsWith('/demonstrations'))return answer({demonstrations:[],next_cursor:null});
    if(path.endsWith('/draft/evidence')&&method==='PUT'){
      assert.equal(request.headers()['if-match'],`"${revision}"`);
      references=request.postDataJSON().references;revision++;return answer({revision});
    }
    if(path.endsWith('/draft')&&method==='PATCH')return answer({error:'The guide changed. Reload before saving.'},412);
    if(path.endsWith('/draft'))return answer({draft:{title:'Saved server guide',instructions:revision===1?'Initial saved instructions.':'Concurrent server instructions.',revision,status:'draft',evidence:{references}}});
    return route.continue();
  });
  await owner.setViewportSize({width:375,height:900});
  await owner.goto(h.origin+'/operational-projects/'+cas.id+'?section=Guide');
  await owner.getByLabel('Guide title').fill('Retain my local title');
  await owner.getByLabel('Instructions',{exact:true}).fill('Retain my local instructions');
  revision=2;
  await owner.getByRole('button',{name:'Refresh',exact:true}).click();
  await owner.getByText('Server state refreshed; unsaved forms retained.',{exact:true}).waitFor();
  await sections(owner).getByRole('button',{name:'Overview',exact:true}).click();
  await sections(owner).getByRole('button',{name:'Guide',exact:true}).click();
  await owner.getByRole('button',{name:'Detach selection 1',exact:true}).click();
  await owner.getByRole('button',{name:'Save evidence selection',exact:true}).click();
  await owner.getByText('Exact evidence selection saved; entered guide text retained.',{exact:true}).waitFor();
  await owner.getByRole('button',{name:'Save and approve',exact:true}).click();await owner.getByRole('alert').waitFor();
  assert.equal(casRequests.find(r=>r.path.endsWith('/draft')&&r.method==='PATCH').ifMatch,'"1"');
  assert.equal(await owner.getByLabel('Guide title').inputValue(),'Retain my local title');
  assert.equal(await owner.getByLabel('Instructions',{exact:true}).inputValue(),'Retain my local instructions');
  report.controlled_evidence_cas=true;await audit(owner,375,'stale-evidence');
  assert.deepEqual(errors,[]);
  assert.equal(h.requests.some(r=>r.method==='POST'&&/\/agent-runs$|\/tasks$|\/task-proposals\/.+\/start$/.test(r.path)),false,'guide actions never start execution');
  console.log('ok - atomic guide save, immutable revisions, explicit pending approval, viewer access, five-width layouts, stale-evidence CAS and no run starts');
} finally {
  if(artifacts)writeFileSync(`${artifacts}/report.json`,JSON.stringify({...report,errors},null,2));
  await Promise.all(contexts.map(context=>context.close()));
  await browser.close();await h.close();
}
