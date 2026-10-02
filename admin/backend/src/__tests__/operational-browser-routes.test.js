import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerBrowserRoutes} from '../routes/operational-browser.js';
import {OperationsError,assertOperation,assertRevision,parse} from '../lib/operational-projects-logic.js';
import {selectedDecisionSchema,selectedReconcileSchema,selectedHumanInputSchema,SELECTED_BROWSER_CONSENT} from '../lib/operational-selected-browser-contract.js';
import {csrfProtection} from '../middleware/csrf.js';
import {fixtureRouter,operationsFixture} from './helpers/operations-fixture.js';

function fixture({assetBodyParser}={}) {
  const f=operationsFixture(),owner=f.addUser(),viewer=f.addUser(),outsider=f.addUser('admin'),project=f.store.create(owner,{name:'Browser routes'}).id;
  f.store.grant(owner,project,viewer.id,f.store.get(owner,project).revision,{role:'viewer'});
  const config=randomUUID(),runId=randomUUID(),attempt=randomUUID(),assetId=randomUUID(),conversionId=randomUUID(),approval=randomUUID();
  let metadata=true,runs=true,revision=6;const calls=[];
  const access=(actor,p,action='read')=> {const v=f.store.get(actor,p);assertOperation(v.own_role,action,!!v.archived_at);return v;};
  const current=()=>({run:{id:runId,project_id:project,revision,attempt_id:attempt,fence:1,state:'paused'},controls:{}});
  const mutator=(name,proof=false)=> (actor,p,rid,rev,body)=> {
    access(actor,p,'run');if(rid!==runId)throw new OperationsError(404,'Run not found');
    assertRevision(rev,revision);if(proof&&(!actor.elevated||!actor.control_verified))throw new OperationsError(403,'Proof required');
    if(name==='decision')parse(selectedDecisionSchema,body);
    if(name==='controlInput')parse(selectedHumanInputSchema,body);
    calls.push({name,actor,p,rid,rev,body});revision++;return current();
  };
  const runService={
    get(actor,p,rid){access(actor,p);if(rid!==runId)throw new OperationsError(404,'Run not found');return current();},
    list(actor,p){access(actor,p);return{runs:[current().run]};},
    sources(actor,p,rid){access(actor,p);if(rid!==runId)throw new OperationsError(404,'Run not found');calls.push({name:'sources',p,rid});return{sources:[{id:assetId,state:'unavailable',code:'PRIVATE_SOURCE_UNAVAILABLE'}]};},
    readiness(actor,p,id){access(actor,p,'run');calls.push({name:'readiness',id});return{can_start:false,checks:[{code:'INSTALLED_PROOF_REQUIRED'}]};},
    start(actor,p,id,input){access(actor,p,'run');if(!actor.elevated||!actor.control_verified)throw new OperationsError(403,'Proof required');calls.push({name:'start',actor,id,input});return current();},
    consent(actor,p,id,input){const v=access(actor,p,'edit');if(v.own_role!=='owner'||!actor.elevated)throw new OperationsError(403,'Proof required');calls.push({name:'consent',actor,id,input});return{allowed:input.allow};},
    refresh(actor,p,rid){access(actor,p);calls.push({name:'refresh'});return current();},
    live(actor,p,rid,opts){access(actor,p);if(!actor.control_verified)throw new OperationsError(403,'Proof required');calls.push({name:'live',opts});return{available:false};},
    decision(actor,p,rid,approvalId,rev,body){return mutator('decision',true)(actor,p,rid,rev,body);},
    reconcile(actor,p,rid,uncertainty,rev,body){parse(selectedReconcileSchema,body);return mutator('reconcile',true)(actor,p,rid,rev,body);},
  };
  for(const name of ['step','pause','resume','cancel','takeover','release','retryCleanup','controlInput'])runService[name]=mutator(name,['step','resume','takeover','release','retryCleanup','controlInput'].includes(name));
  const conversion={readiness(actor,p){access(actor,p);return{available:false};},list(actor,p){access(actor,p);return{conversions:[]};},
    status(actor,p,id){access(actor,p);return{conversion:{id,state:'completed'}};},
    convert(actor,p,body){access(actor,p,'edit');calls.push({name:'convert',actor,body});return{conversion:{id:conversionId,state:'queued'}};},
    cancel(actor,p,id){access(actor,p,'edit');calls.push({name:'convert_cancel'});return{conversion:{id,state:'cancelled'}};}};
  const artifactStore={authorizeAssetStage(actor,p){access(actor,p,'edit');return true;},listAssets(actor,p,q){access(actor,p);calls.push({name:'list_assets',q});return{assets:[]};},asset(actor,p,id){access(actor,p);return{id};},
    reviewAsset(actor,p,id,body){access(actor,p,'review');calls.push({name:'asset_review',body});return{id};},
    reviewAssetModel(actor,p,id,body){access(actor,p,'review');if(!actor.elevated)throw new OperationsError(403,'Proof required');calls.push({name:'asset_model_review',actor});return{id};},
    listAttempt(actor,scope,page){access(actor,scope.project_id);calls.push({name:'list_artifacts',scope,page});return{artifacts:[]};},
    reviewRelease(actor,scope,id,body){access(actor,scope.project_id,'review');calls.push({name:'artifact_review',scope,id,body,actor});return{id};}};
  const artifactService={asset(actor,p,input,chunks){access(actor,p,'edit');calls.push({name:'asset',input,bytes:Buffer.concat(chunks)});return{id:assetId,available:true};},
    serve(actor,options,req,res){access(actor,options.project_id);calls.push({name:'content',options});res.set('Content-Disposition','attachment');return res.json({binary_fixture:true});},
    normalizeScreenshot(actor,scope,id,options){access(actor,scope.project_id,'run');calls.push({name:'normalize',scope,id,options});return{id:assetId};},
    clipboardImport(actor,scope,input){access(actor,scope.project_id,'run');if(!actor.elevated||!actor.control_verified)throw new OperationsError(403,'Proof required');calls.push({name:'clipboard_import',scope,input});return{id:assetId};},
    clipboardExport(actor,scope,id){access(actor,scope.project_id,'run');if(!actor.elevated||!actor.control_verified)throw new OperationsError(403,'Proof required');calls.push({name:'clipboard_export',scope,id});return{text:'explicit private text'};}};
  const runtime={runs:runService,conversion,artifacts:{store:artifactStore,service:artifactService}},router=fixtureRouter();
  router.use((req,res,next)=>{try{req.operationsActor={...req.user,requestId:randomUUID()};f.store.assertActor(req.operationsActor);next();}catch(err){res.status(err.status||500).json({error:'Account refused'});}});
  const agentsOnly=(_req,res,next)=>metadata?next():res.status(404).json({error:'Not found'}),runsOnly=(_req,res,next)=>runs?next():res.status(404).json({error:'Not found'});
  registerBrowserRoutes(router,{runtime:()=>runtime,store:f.store,agentsOnly,runsOnly,assetBodyParser,controlVerified:r=>r.verified===true,
    requireSudo:(r,res,next)=>r.sudo?next():res.status(401).json({error:'sudo_required',sudo_required:true})});
  return {...f,owner,viewer,outsider,project,config,runId,attempt,assetId,approval,calls,runtime,router,
    gate(v){metadata=v;},runGate(v){runs=v;},
    send(method,path,body={},extra={}) {const headers={'if-match':'"6"','x-csrf-token':'fixture-csrf',...extra.headers};
      return router.dispatch({method,path,originalUrl:`/api/operational-projects${path}`,url:path,user:owner,verified:true,sudo:true,
        body,headers,cookies:{pp_csrf:'fixture-csrf'},...extra},[csrfProtection]);},
    root:`/${project}/browser-agent-runs/${runId}`,base:`/${project}/browser-agent-configurations`,assets:`/${project}/browser-assets`,
  };
}

test('browser routes inherit CSRF/current accounts and metadata/run gates before any service effect',async()=> {
  const f=fixture();try{
    assert.equal((await f.send('POST',`${f.root}/resume`,{}, {headers:{'if-match':'"6"'}})).statusCode,403);
    assert.equal(f.calls.length,0);
    assert.equal((await f.send('POST',`${f.root}/resume`,{}, {sudo:false})).statusCode,401);assert.equal(f.calls.length,0);
    f.gate(false);assert.equal((await f.send('GET',f.assets)).statusCode,404);f.gate(true);
    f.runGate(false);assert.equal((await f.send('POST',`${f.base}/${f.config}/start`,{})).statusCode,404);
    assert.equal((await f.send('GET',f.assets)).statusCode,200);f.runGate(true);
    assert.equal((await f.send('GET',f.assets,{}, {user:{...f.owner,mcp:true}})).statusCode,403);
    f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(f.owner.id);
    assert.equal((await f.send('POST',`${f.root}/cancel`)).statusCode,403);
  }finally{f.close();}
});

test('start and consent require explicit current revision, body pins and current control/elevation proofs',async()=> {
  const f=fixture();try{
    const input={project_revision:2,configuration_revision:6,configuration_sha256:'a'.repeat(64),idempotency_key:randomUUID()};
    let result=await f.send('POST',`${f.base}/${f.config}/start`,input,{headers:{'x-csrf-token':'fixture-csrf'}});assert.equal(result.statusCode,428);
    result=await f.send('POST',`${f.base}/${f.config}/start`,{...input,configuration_revision:5});assert.equal(result.statusCode,412);
    result=await f.send('POST',`${f.base}/${f.config}/start`,input,{verified:false});assert.equal(result.statusCode,403);
    result=await f.send('POST',`${f.base}/${f.config}/start`,input);assert.equal(result.statusCode,202);assert.equal(result.headers.etag,'"6"');
    const starts=f.calls.filter(c=>c.name==='start');assert.equal(starts.length,1);assert.equal(starts[0].actor.elevated,true);assert.equal(starts[0].actor.control_verified,true);
    result=await f.send('PUT',`${f.base}/${f.config}/model-consent`,{configuration_revision:6,configuration_sha256:'a'.repeat(64),allow:true,reviewed_statement:SELECTED_BROWSER_CONSENT});
    assert.equal(result.statusCode,200);assert.equal(f.calls.filter(c=>c.name==='consent').length,1);
    result=await f.send('PUT',`${f.base}/${f.config}/model-consent`,{configuration_revision:6,configuration_sha256:'a'.repeat(64),allow:true,reviewed_statement:SELECTED_BROWSER_CONSENT,elevated:true});assert.equal(result.statusCode,400);
  }finally{f.close();}
});

test('a consequential command is dispatched once, stale revisions and unknown bodies cannot replay it',async()=> {
  const f=fixture();try{
    let result=await f.send('POST',`${f.root}/takeover`);assert.equal(result.statusCode,200);assert.equal(result.headers.etag,'"7"');
    result=await f.send('POST',`${f.root}/takeover`);assert.equal(result.statusCode,412);
    assert.equal(f.calls.filter(c=>c.name==='takeover').length,1);
    result=await f.send('POST',`${f.root}/cancel`,{command:'arbitrary'});assert.equal(result.statusCode,400);
    result=await f.send('POST',`${f.root}/pause`,{}, {user:f.viewer});assert.equal(result.statusCode,403);
    result=await f.send('GET',f.root,{}, {user:f.outsider});assert.equal(result.statusCode,404);
    result=await f.send('DELETE',f.root);assert.equal(result.statusCode,404);
    assert.equal(f.calls.filter(c=>c.name==='cancel').length,0);
  }finally{f.close();}
});

test('static conversion routes precede dynamic configuration IDs and never save or start a suggestion',async()=> {
  const f=fixture();try{
    f.router.get(`${f.base}/:configurationId`,(_req,res)=>res.status(400).json({error:'Dynamic collision'}));
    assert.equal((await f.send('GET',`${f.base}/convert/readiness`)).statusCode,200);
    const result=await f.send('POST',`${f.base}/convert`,{source_text:'reviewable task'});assert.equal(result.statusCode,202);
    assert.equal(f.calls.filter(c=>c.name==='convert').length,1);assert.equal(f.calls.filter(c=>c.name==='start').length,0);
    assert.equal((await f.send('GET',`${f.base}/conversions`)).statusCode,200);
    assert.equal((await f.send('POST',`${f.base}/conversions/${randomUUID()}/cancel`,{unexpected:true})).statusCode,400);
  }finally{f.close();}
});

test('source ledger is read-only, current-project gated and rejects arbitrary read-purpose queries',async()=>{
  const f=fixture();try{
    const result=await f.send('GET',`${f.root}/sources`,{}, {user:f.viewer});assert.equal(result.statusCode,200);
    assert.deepEqual(result.body.sources,[{id:f.assetId,state:'unavailable',code:'PRIVATE_SOURCE_UNAVAILABLE'}]);
    assert.deepEqual(f.calls.find(c=>c.name==='sources'),{name:'sources',p:f.project,rid:f.runId});
    assert.equal((await f.send('GET',`${f.root}/sources`,{}, {query:{purpose:'model'}})).statusCode,400);
    assert.equal((await f.send('GET',`${f.root}/sources`,{}, {user:f.outsider})).statusCode,404);
    f.runGate(false);assert.equal((await f.send('GET',`${f.root}/sources`)).statusCode,404);
    assert.equal((await f.send('POST',`${f.root}/sources`)).statusCode,404);
  }finally{f.close();}
});

test('private base64 file route accepts only canonical bounded bytes with exact MIME/hash metadata',async()=> {
  const f=fixture();try{
    const bytes=Buffer.from('private fixture'),body={idempotency_key:randomUUID(),byte_count:bytes.length,mime_type:'text/plain',sha256:'a'.repeat(64),bytes_base64:bytes.toString('base64')};
    for(const extra of [{path:'/etc/passwd'},{headers:{Authorization:'secret'}},{bytes_base64:'YQ==\n'},{byte_count:16*1024*1024+1}])
      assert.equal((await f.send('POST',f.assets,{...body,...extra})).statusCode,400);
    assert.equal((await f.send('POST',f.assets,body,{headers:{'x-csrf-token':'fixture-csrf','content-encoding':'gzip'}})).statusCode,415);
    assert.equal((await f.send('POST',f.assets,body)).statusCode,201);
    const call=f.calls.find(c=>c.name==='asset');assert.deepEqual(call.bytes,bytes);assert.ok(!Object.hasOwn(call.input,'bytes_base64'));
    assert.equal((await f.send('GET',f.assets,{}, {query:{limit:'51'}})).statusCode,400);
    assert.equal((await f.send('GET',`${f.assets}/${f.assetId}/content`,{}, {query:{purpose:'model'}})).statusCode,400);
    assert.equal((await f.send('GET',`${f.assets}/${f.assetId}/content`,{}, {query:{purpose:'review'}})).headers['content-disposition'],'attachment');
  }finally{f.close();}
});

test('large file parsing requires fresh project edit access and finite intake slots reclaimed on response failure',async()=>{
  const waiting=[];
  const f=fixture({assetBodyParser:(_req,_res,next)=>{waiting.push(next);}});
  const bytes=Buffer.from('bounded intake'),body={idempotency_key:randomUUID(),byte_count:bytes.length,mime_type:'text/plain',sha256:'a'.repeat(64),bytes_base64:bytes.toString('base64')};
  try{
    assert.equal((await f.send('POST',f.assets,body,{user:f.viewer})).statusCode,403);
    assert.equal((await f.send('POST',f.assets,body,{user:f.outsider})).statusCode,404);
    assert.equal(waiting.length,0);
    const first=f.send('POST',f.assets,body),second=f.send('POST',f.assets,body);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(waiting.length,2);
    assert.equal((await f.send('POST',f.assets,body)).statusCode,429);assert.equal(waiting.length,2);
    waiting.shift()();waiting.shift()();
    assert.equal((await first).statusCode,201);assert.equal((await second).statusCode,201);
    const wrong=f.send('POST',f.assets,{...body,path:'/etc/passwd'});
    await new Promise(resolve=>setImmediate(resolve));waiting.shift()();assert.equal((await wrong).statusCode,400);
    const recovered=f.send('POST',f.assets,body);await new Promise(resolve=>setImmediate(resolve));waiting.shift()();
    assert.equal((await recovered).statusCode,201);
    const parseError=f.send('POST',f.assets,body);await new Promise(resolve=>setImmediate(resolve));
    waiting.shift()(Object.assign(Error('raw private body value'),{status:413,body:'private caller bytes'}));
    const failure=await parseError;assert.equal(failure.statusCode,413);assert.deepEqual(failure.body,{error:'Invalid bounded private file body'});
    const again=f.send('POST',f.assets,body);await new Promise(resolve=>setImmediate(resolve));waiting.shift()();assert.equal((await again).statusCode,201);
    const before=f.calls.filter(c=>c.name==='asset').length,gateChanged=f.send('POST',f.assets,body);
    await new Promise(resolve=>setImmediate(resolve));f.gate(false);waiting.shift()();assert.equal((await gateChanged).statusCode,404);
    assert.equal(f.calls.filter(c=>c.name==='asset').length,before);f.gate(true);
    const revoked=f.send('POST',f.assets,body);await new Promise(resolve=>setImmediate(resolve));
    f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(f.owner.id);waiting.shift()();assert.equal((await revoked).statusCode,403);
    assert.equal(f.calls.filter(c=>c.name==='asset').length,before);
  }finally{for(const next of waiting)next();f.close();}
});

test('artifact and explicit clipboard routes preserve exact URL-derived run/project/attempt scope and revision',async()=> {
  const f=fixture();try{
    const attempt={attempt_id:f.attempt,fence:1};
    assert.equal((await f.send('GET',`${f.root}/artifacts`,{}, {query:{attempt_id:f.attempt,fence:'1',limit:'5'}})).statusCode,200);
    const list=f.calls.find(c=>c.name==='list_artifacts');assert.deepEqual(list.scope,{project_id:f.project,run_id:f.runId,...attempt});assert.deepEqual(list.page,{limit:5});
    assert.equal((await f.send('POST',`${f.root}/clipboard/import`,{...attempt,text:'private text',run_id:randomUUID()})).statusCode,400);
    assert.equal((await f.send('POST',`${f.root}/clipboard/import`,{...attempt,text:'private text'}, {headers:{'if-match':'"5"','x-csrf-token':'fixture-csrf'}})).statusCode,412);
    assert.equal((await f.send('POST',`${f.root}/clipboard/import`,{...attempt,text:'private text'})).statusCode,201);
    assert.equal((await f.send('POST',`${f.root}/clipboard/export`,{...attempt,artifact_id:f.assetId})).body.text,'explicit private text');
    const call=f.calls.find(c=>c.name==='clipboard_import');assert.deepEqual(call.scope,{project_id:f.project,run_id:f.runId,...attempt});assert.deepEqual(call.input,{text:'private text'});
    assert.equal((await f.send('POST',`${f.root}/artifacts/${f.assetId}/normalize`,{...attempt,redactions:[{x:0,y:0,width:1,height:1,path:'/tmp'}]})).statusCode,400);
    assert.equal((await f.send('GET',`${f.root}/artifacts/${f.assetId}/content`,{}, {query:{...attempt,fence:'1',purpose:'review',path:'/tmp'}})).statusCode,400);
  }finally{f.close();}
});

test('async gate changes suppress response without replay and unknown errors never expose private values',async()=> {
  const f=fixture();try{
    f.runtime.conversion.convert=async()=>{f.calls.push({name:'convert'});f.runGate(false);return{private:'not returned'};};
    assert.equal((await f.send('POST',`${f.base}/convert`,{})).statusCode,404);assert.equal(f.calls.length,1);
    f.runGate(true);f.runtime.conversion.convert=()=>{throw Error('raw credential private-value');};
    const result=await f.send('POST',`${f.base}/convert`,{});assert.equal(result.statusCode,500);assert.ok(!JSON.stringify(result.body).includes('private-value'));
    f.runtime.conversion=null;assert.equal((await f.send('POST',`${f.base}/convert`,{})).statusCode,503);
  }finally{f.close();}
});
