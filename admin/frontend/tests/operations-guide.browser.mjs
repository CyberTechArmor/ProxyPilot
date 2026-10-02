// Local fixture-only journeys for the authorized saved-approved guide policy.
// Run after combining the Operations UI and guide-policy commits. No host,
// credential, enrollment, runtime activation or remote infrastructure is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';
import { guideHash } from '../../backend/src/lib/operational-projects-workflow.js';
import { startHarness } from './agent-runs-harness.mjs';

const h=await startHarness({execution:false});
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/opt/pw-browsers/chromium',headless:true});
const contexts=[];
async function as(role,width=375) {
  const context=await browser.newContext({viewport:{width,height:900}});contexts.push(context);
  await context.addCookies([{name:'pp_harness_user',value:role,url:h.origin},{name:'pp_csrf',value:'operations-guide-fixture',url:h.origin}]);
  await context.addInitScript(()=>localStorage.setItem('mock2HintDismissed','1'));
  const page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(90000);
  return page;
}
const sections=page=>page.getByRole('navigation',{name:'Operation sections'});
try {
  const owner=await as('owner');
  await owner.goto(h.origin+'/operational-projects');
  assert.equal(await owner.getByRole('dialog').count(),0,'creation form must not dominate landing page');
  await owner.getByRole('button',{name:'New project',exact:true}).click();
  const dialog=owner.getByRole('dialog');
  await dialog.getByRole('heading',{name:'New project',exact:true}).waitFor();
  assert.equal(await dialog.getByLabel(/account ID/i).count(),0,'creation must not ask for raw account IDs');
  await dialog.getByLabel('Name',{exact:true}).fill('Fixture reporting procedure');
  await dialog.getByLabel('Purpose (optional)').fill('A private local guide fixture');
  await dialog.getByRole('button',{name:'Create project',exact:true}).click();
  await owner.getByRole('heading',{name:'Fixture reporting procedure',exact:true}).waitFor();
  const id=new URL(owner.url()).pathname.split('/').at(-1);
  const grants=h.world.f.db.prepare('SELECT * FROM ops_project_grants WHERE project_id=?').all(id);
  assert.equal(grants.length,0,'new project remains private to owner');
  assert.equal(await owner.getByLabel('Archive reason').count(),0,'archive belongs in Details');
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
  assert.equal(h.requests.some(r=>r.method==='POST'&&/\/agent-runs$|\/tasks$|\/task-proposals\/.+\/start$/.test(r.path)),false,'guide actions never start execution');
  console.log('ok - private creation, atomic guide save, immutable revisions, explicit pending approval, viewer access and no run starts');
} finally {
  await Promise.all(contexts.map(context=>context.close()));
  await browser.close();await h.close();
}
