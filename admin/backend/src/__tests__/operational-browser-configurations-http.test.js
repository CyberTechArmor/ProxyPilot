import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { operationsFixture } from './helpers/operations-fixture.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { csrfProtection } from '../middleware/csrf.js';

const configuration = () => JSON.parse(readFileSync(new URL('../../../../contracts/browser-agent/fixtures/general-agent.draft.json',import.meta.url),'utf8'));
test('real HTTP browser drafts enforce current authority, CSRF, pins and inert endpoints', async () => {
  const f = operationsFixture(), owner = f.addUser(), editor = f.addUser(), viewer = f.addUser(), outsider = f.addUser();
  const p = f.store.create(owner,{name:'HTTP browser configurations'}), revision = () => f.store.get(owner,p.id).revision;
  for (const [user,role] of [[editor,'editor'],[viewer,'viewer']]) f.store.grant(owner,p.id,user.id,revision(),{role});
  const guide = f.store.saveDraft(owner,p.id,f.store.draft(owner,p.id).revision,{title:'Selected-site guide',instructions:'Review the requested information.'}).version;
  const c = configuration(); c.work.guide_ref = {id:guide.id,sha256:guide.content_hash};
  const input = {configuration:c,source_text:'Original source bytes: café\nSecond line.'};
  let metadata = false, operations = true;
  const app = express(), users = new Map([owner,editor,viewer,outsider].map(u => [u.id,u]));
  app.use(express.json());app.use((req,_res,next) => { req.user=users.get(req.get('X-Fixture-Actor'));req.cookies={pp_csrf:'fixture-csrf'};next(); });
  app.use('/api/operational-projects',csrfProtection,createOperationsRouter({Router:express.Router,store:f.store,
    enabled:()=>operations,agentsEnabled:()=>metadata,agentRunsEnabled:false,lookupLimiter:(_r,_s,next)=>next()}));
  const server = app.listen(0,'127.0.0.1'); await new Promise(done => server.once('listening',done));
  const base = `http://127.0.0.1:${server.address().port}/api/operational-projects`;
  const call = async (suffix,{actor=owner,method='GET',body,match,csrf=true}={}) => {
    const response = await fetch(base+suffix,{method,headers:{'X-Fixture-Actor':actor?.id || '',
      ...(csrf ? {'X-CSRF-Token':'fixture-csrf'} : {}),...(body ? {'Content-Type':'application/json'} : {}),
      ...(match == null ? {} : {'If-Match':`"${match}"`})},...(body ? {body:JSON.stringify(body)} : {})});
    const text=await response.text();
    return {status:response.status,etag:response.headers.get('etag'),body:response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text};
  };
  const path = `/${p.id}/browser-agent-configurations`;
  try {
    assert.equal((await call('/capabilities')).body.browser_draft_configuration_available,false);
    assert.equal((await call(path,{method:'POST',body:input,match:revision()})).status,404);
    metadata=true;
    const caps=(await call('/capabilities')).body;
    assert.equal(caps.browser_draft_configuration_available,true);assert.equal(caps.agent_runs_enabled,false);
    assert.equal((await call(path,{actor:null})).status,401);assert.equal((await call(path,{actor:outsider})).status,404);
    assert.equal((await call(path+'/validate',{actor:viewer,method:'POST',body:input})).status,403);
    assert.equal((await call(path,{method:'POST',body:input,match:revision(),csrf:false})).status,403);
    assert.equal((await call(path,{method:'POST',body:input})).status,428);
    const preview=await call(path+'/validate',{actor:editor,method:'POST',body:input});
    assert.equal(preview.status,200);assert.equal(preview.body.persisted,false);assert.equal(preview.body.readiness.can_start,false);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ops_browser_agent_configurations').get().n,0);
    const created=await call(path,{actor:editor,method:'POST',body:input,match:revision()});
    assert.equal(created.status,201);assert.equal(created.etag,'"1"');assert.equal(created.body.configuration.source_text,input.source_text);
    const id=created.body.configuration.id;
    assert.equal((await call(path+'/'+id,{actor:viewer})).body.configuration.configuration_sha256,created.body.configuration.configuration_sha256);
    assert.equal((await call(path+'/'+id,{method:'PATCH',body:input,match:2})).status,412);
    const update=structuredClone(input);update.configuration.name='Edited JSON draft';
    assert.equal((await call(path+'/'+id,{method:'PATCH',body:update,match:1})).etag,'"2"');
    const historical=f.db.prepare('SELECT source_text,configuration_json FROM ops_browser_agent_configuration_versions WHERE configuration_id=? ORDER BY revision').all(id);
    assert.equal(historical.length,2);assert.equal(JSON.parse(historical[0].configuration_json).name,c.name);assert.equal(historical[0].source_text,input.source_text);
    for (const suffix of [`/${id}/start`,`/${id}/model-consent`,'/convert']) assert.equal((await call(path+suffix,{method:'POST',body:{},match:2})).status,404);
    for (const suffix of ['/browser-agent-runs','/browser-assets']) assert.equal((await call(`/${p.id}`+suffix)).status,404);
    const invalid=structuredClone(input);invalid.configuration.budgets.max_seconds=0;invalid.configuration['PRIVATE_CANARY_KEY']='PRIVATE_CANARY_VALUE';
    const refused=await call(path+'/validate',{method:'POST',body:invalid});
    assert.equal(refused.status,400);assert.ok(refused.body.issues.some(i=>i.path.join('.')==='configuration.budgets.max_seconds'));
    assert.equal(JSON.stringify(refused.body).includes('PRIVATE_CANARY'),false,'errors do not echo unknown keys or values');
    f.store.startRevision(owner,p.id,f.store.draft(owner,p.id).revision,{version_id:guide.id,discard_draft:true});
    f.store.saveDraft(owner,p.id,f.store.draft(owner,p.id).revision,{title:'New guide',instructions:'A changed guide.'});
    assert.equal((await call(path+'/validate',{method:'POST',body:input})).status,409);
    const readiness=(await call(`${path}/${id}/readiness`)).body.readiness;
    assert.equal(readiness.can_start,false);assert.equal(readiness.execution_enabled,false);assert.ok(readiness.checks.some(v=>v.code==='GUIDE_STALE'));
    assert.ok(readiness.checks.some(v=>v.code==='SELECTED_BROWSER_RUNTIME_NOT_IMPLEMENTED'));
    f.db.prepare('DELETE FROM ops_project_grants WHERE project_id=? AND user_id=?').run(p.id,editor.id);
    assert.equal((await call(path+'/'+id,{actor:editor})).status,404);
    assert.equal((await call(path+'/'+id,{actor:editor,method:'PATCH',body:input,match:2})).status,404);
    operations=false;assert.equal((await call(path)).status,404);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_runs').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ops_agent_credential_bindings').get().n,0);
  } finally { await new Promise(done=>server.close(done));f.close(); }
});
