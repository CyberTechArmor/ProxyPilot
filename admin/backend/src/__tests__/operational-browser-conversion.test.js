import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {operationsFixture} from './helpers/operations-fixture.js';
import {BROWSER_CONVERSION_DISCLOSURE,createBrowserConversionService,operationalBrowserConversionMigration1120} from '../lib/operational-browser-conversion.js';
import {browserDraftHash} from '../lib/operational-browser-agent-proposal.js';
const rejects=code=>e=>e.code===code;
function world(){
  const f=operationsFixture();if(!f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ops_browser_conversions'").get())operationalBrowserConversionMigration1120(f.adapter);
  const owner=f.addUser(),editor=f.addUser(),viewer=f.addUser(),outsider=f.addUser(),admin=f.addUser('admin');
  const p=f.store.create(owner,{name:'Private browser task',members:[{user_id:editor.id,role:'editor'},{user_id:viewer.id,role:'viewer'}]});
  f.store.saveDraft(owner,p.id,1,{title:'Approved browser instructions',instructions:'Use only selected websites with supervised approval.'});
  const project=()=>f.store.get(owner,p.id),guide=project().current_version,queued=[],calls=[],cancellations=[],scenario={};
  const template=JSON.parse(readFileSync(new URL('../../../../contracts/browser-agent/fixtures/general-agent.draft.json',import.meta.url)));
  const model={readiness:async()=>{await scenario.beforeReadiness?.();return scenario.provider??{available:true,price_table_revision:1};},quote:async()=>{await scenario.beforeQuote?.();return{tokens:22048,usd:0.005,price_table_revision:1};},cancel:async id=>{cancellations.push(id);},convert:async r=>{
    calls.push(r);if(scenario.beforeOutput)await scenario.beforeOutput(r);
    const configuration=structuredClone(template);configuration.work.instructions=r.input.instructions;configuration.work.guide_ref={id:r.guide_version_id,sha256:r.guide_hash};configuration.work.source_inputs=r.input.source_inputs.map(s=>s.ref);
    if(scenario.mutate)scenario.mutate(configuration);
    return{text:JSON.stringify({configuration,assumptions:['Exact destinations remain subject to owner review.'],warnings:['This draft has not run.'],ambiguities:[]}),usage:{prompt_tokens:100,completion_tokens:100},settled_usd:'0.001',price_table_revision:1,attestation:'injected-fixture',...scenario.output};}};
  const resolveAsset=async(actor,pid,ref)=>scenario.resolve?scenario.resolve(actor,pid,ref):({project_id:pid,ref,approved_for_model:true,content:{kind:'text',text:'Reviewed private text'}});
  const service=createBrowserConversionService({db:f.adapter,store:f.store,model,resolveAsset,verifyAsset:(actor,pid,ref,options)=>{if(scenario.verify)scenario.verify(actor,pid,ref,options);return {project_id:pid,ref,approved_for_model:true};},clock:()=>Date.now(),schedule:fn=>queued.push(fn),isEnabled:()=>!scenario.disabled});
  const body=()=>({source_text:'Read the user-selected website and report its content.',source_asset_refs:[],project_revision:project().revision,guide_ref:{id:guide.id,sha256:guide.content_hash},
    disclosure:{enabled:true,reviewed_statement:BROWSER_CONVERSION_DISCLOSURE},limits:{max_seconds:120,max_tokens:30000,max_usd:0.1}});
  const start=(v=body(),actor=owner)=>service.convert(actor,p.id,v),status=async id=>(await service.status(owner,p.id,id)).conversion;
  return{...f,owner,editor,viewer,outsider,admin,p,guide,project,queued,calls,cancellations,scenario,service,body,start,status};
}
test('owner disclosure and exact project/guide pins are required before private model work or persistent records',async()=>{
  const w=world();try{
    for(const actor of [w.editor,w.viewer,w.admin,w.outsider])await assert.rejects(()=>w.start(w.body(),actor),e=>[403,404].includes(e.status));
    await assert.rejects(()=>w.start(w.body(),{...w.owner,mcp:true}),rejects('OWNER_MODEL_DISCLOSURE_REQUIRED'));
    for(const mutate of [v=>delete v.disclosure,v=>v.disclosure.reviewed_statement='yes',v=>v.source_text='😀'.repeat(2000),v=>v.credentials='secret']){
      const v=w.body();mutate(v);await assert.rejects(()=>w.start(v),e=>e.status===400);
    }
    const stale=w.body();stale.project_revision++;await assert.rejects(()=>w.start(stale),e=>e.status===412);
    const guide=w.body();guide.guide_ref.sha256='a'.repeat(64);await assert.rejects(()=>w.start(guide),rejects('STALE_CONFIGURATION'));
    assert.equal(w.calls.length,0);assert.equal(w.db.prepare('SELECT count(*) n FROM ops_browser_conversions').get().n,0);
  }finally{w.close();}
});
test('explicit conversion preserves original bytes/provenance and returns an editable inert draft without saving configuration or run',async()=>{
  const w=world();try{
    const input=w.body();input.source_text+='\nExact original whitespace.\n';const {conversion}=await w.start(input);assert.equal(conversion.state,'queued');assert.equal(w.calls.length,0);
    await w.queued.shift()();const out=await w.status(conversion.id);assert.equal(out.state,'completed');assert.equal(out.source_text,input.source_text);assert.equal(out.source_sha256,browserDraftHash(input.source_text));
    assert.equal(out.result.configuration.work.instructions,input.source_text);assert.equal(out.result.requires_review,true);assert.equal(out.result.persisted,false);assert.equal(out.result.execution_enabled,false);
    assert.equal(out.result.provenance.original_source_sha256,out.source_sha256);assert.deepEqual(out.result.provenance.guide_ref,input.guide_ref);
    assert.equal(w.db.prepare('SELECT count(*) n FROM ops_browser_agent_configurations').get().n,0);assert.equal(w.db.prepare('SELECT count(*) n FROM ops_agent_runs').get().n,0);
    const audits=w.db.prepare("SELECT metadata_json FROM ops_project_events WHERE action LIKE 'browser_conversion_%'").all().map(r=>r.metadata_json).join('');assert(!audits.includes(input.source_text));
    assert.throws(()=>w.db.prepare("UPDATE ops_browser_conversions SET source_text='replacement' WHERE id=?").run(conversion.id),/immutable/);
    assert.throws(()=>w.db.prepare("UPDATE ops_browser_conversions SET result_json='{}' WHERE id=?").run(conversion.id),/immutable/);
  }finally{w.close();}
});
test('source images/files require immutable same-project exact model-input review and bounded content hashes',async()=>{
  const w=world();try{
    const v=w.body(),ref={id:randomUUID(),sha256:'a'.repeat(64),mime_type:'text/plain',byte_count:30};v.source_asset_refs=[ref];
    for(const asset of [{project_id:randomUUID(),ref,approved_for_model:true,content:{kind:'text',text:'data'}},{project_id:w.p.id,ref,approved_for_model:false,content:{kind:'text',text:'data'}},{project_id:w.p.id,ref:{...ref,sha256:'b'.repeat(64)},approved_for_model:true,content:{kind:'text',text:'data'}}]){
      w.scenario.resolve=async()=>asset;await assert.rejects(()=>w.start(v),rejects('SOURCE_DISCLOSURE_REQUIRED'));
    }
    const image=Buffer.from([137,80,78,71,13,10,26,10]);const imageRef={...ref,mime_type:'image/png',byte_count:image.length,sha256:browserDraftHash(image)};v.source_asset_refs=[imageRef];
    w.scenario.resolve=async()=>({project_id:w.p.id,ref:imageRef,approved_for_model:true,content:{kind:'image',mime_type:'image/png',bytes:image}});
    const {conversion}=await w.start(v);await w.queued.shift()();const r=await w.status(conversion.id);assert.equal(r.state,'completed');assert.equal(w.calls[0].input.source_inputs[0].content_sha256,browserDraftHash(image));
    assert.deepEqual(r.result.configuration.work.source_inputs,[imageRef]);assert(!JSON.stringify(r.pins).includes(image.toString('base64')));
  }finally{w.close();}
});
test('changed project, guide, access or reviewed source during the model await suppresses draft publication',async()=>{
  for(const change of ['project','guide','account','source','source_review']){
    const w=world();try{
      const v=w.body();if(['source','source_review'].includes(change))v.source_asset_refs=[{id:randomUUID(),sha256:'a'.repeat(64),mime_type:'text/plain',byte_count:30}];
      w.scenario.beforeOutput=async()=>{
        if(change==='project')w.store.update(w.owner,w.p.id,w.project().revision,{name:'Changed project'});
        if(change==='guide')w.store.withdraw(w.owner,w.p.id,w.guide.id,w.project().revision,{reason:'Withdraw source guide'});
        if(change==='account')w.db.prepare("UPDATE users SET role='disabled' WHERE id=?").run(w.owner.id);
        if(change==='source')w.scenario.resolve=async(actor,pid,ref)=>({project_id:pid,ref,approved_for_model:true,content:{kind:'text',text:'Changed reviewed contents'}});
        if(change==='source_review')w.scenario.resolve=async(actor,pid,ref)=>({project_id:pid,ref,approved_for_model:false,content:{kind:'text',text:'Reviewed private text'}});
      };
      const {conversion}=await w.start(v);await w.queued.shift()();const row=w.db.prepare('SELECT state,result_json FROM ops_browser_conversions WHERE id=?').get(conversion.id);
      assert.equal(row.state,'blocked',change);assert.equal(JSON.parse(row.result_json).configuration,undefined);assert.equal(w.db.prepare('SELECT count(*) n FROM ops_browser_agent_configurations').get().n,0);
    }finally{w.close();}
  }
});
test('completed drafts are withheld after source loss or guide withdrawal without changing immutable history or recalling the provider',async()=>{
  for(const change of ['review','content','deleted','guide','archive']){
    const w=world();try{
      const v=w.body();v.source_asset_refs=[{id:randomUUID(),sha256:'a'.repeat(64),mime_type:'text/plain',byte_count:30}];
      const {conversion}=await w.start(v);await w.queued.shift()();assert.equal((await w.status(conversion.id)).result.requires_review,true);
      const historical=w.db.prepare('SELECT * FROM ops_browser_conversions WHERE id=?').get(conversion.id);
      if(change==='review')w.scenario.resolve=async(actor,pid,ref)=>({project_id:pid,ref,approved_for_model:false,content:{kind:'text',text:'Reviewed private text'}});
      if(change==='content')w.scenario.resolve=async(actor,pid,ref)=>({project_id:pid,ref,approved_for_model:true,content:{kind:'text',text:'Different contents'}});
      if(change==='deleted')w.scenario.resolve=async()=>{throw Error('deleted private source');};
      if(change==='guide')w.store.withdraw(w.owner,w.p.id,w.guide.id,w.project().revision,{reason:'Withdraw guide'});
      if(change==='archive')w.store.archive(w.owner,w.p.id,w.project().revision,{reason:'Archive conversion project'});
      const current=await w.status(conversion.id);
      assert.equal(current.state,'completed');assert.equal(current.result.withheld,true,change);assert.equal(current.result.code,'CONVERSION_SOURCE_UNAVAILABLE');
      for(const field of ['configuration','assumptions','warnings','ambiguities','provenance','receipt'])assert.equal(current.result[field],undefined,field);
      assert.equal(current.source_text,v.source_text);assert.deepEqual(w.db.prepare('SELECT * FROM ops_browser_conversions WHERE id=?').get(conversion.id),historical);
      assert.equal(w.calls.length,1);
      if(!['archive','guide'].includes(change))assert.equal((await w.service.cancel(w.owner,w.p.id,conversion.id)).conversion.result.withheld,true,'Cancel cannot bypass completed-result checks.');
    }finally{w.close();}
  }
});
test('completed draft reads recheck project access after source decoding awaits',async()=>{
  const w=world();try{
    const v=w.body();v.source_asset_refs=[{id:randomUUID(),sha256:'a'.repeat(64),mime_type:'text/plain',byte_count:30}];
    const {conversion}=await w.start(v);await w.queued.shift()();
    w.scenario.resolve=async(actor,pid,ref)=>{
      w.db.prepare("UPDATE users SET role='disabled' WHERE id=?").run(w.owner.id);
      return{project_id:pid,ref,approved_for_model:true,content:{kind:'text',text:'Reviewed private text'}};
    };
    await assert.rejects(()=>w.status(conversion.id),e=>[403,404].includes(e.status));
    assert.equal(w.calls.length,1);
  }finally{w.close();}
});
test('all source reviews are checked after the final decoder await before provider admission and completed-result disclosure',async()=>{
  const w=world();try{
    const v=w.body();v.source_asset_refs=Array.from({length:2},()=>({id:randomUUID(),sha256:'a'.repeat(64),mime_type:'text/plain',byte_count:30}));
    let lost=false,phase='preflight';
    w.scenario.resolve=async(actor,pid,ref)=>{
      if(ref.id===v.source_asset_refs[1].id&&phase!=='safe')lost=true;
      return{project_id:pid,ref,approved_for_model:true,content:{kind:'text',text:'Reviewed private text'}};
    };
    w.scenario.verify=(actor,pid,ref,options)=>{
      assert.equal(options.approved_for_model,true);
      if(ref.id===v.source_asset_refs[0].id&&lost)throw Object.assign(Error('revoked'),{code:'SOURCE_DISCLOSURE_REQUIRED'});
    };
    await assert.rejects(()=>w.start(v),rejects('SOURCE_DISCLOSURE_REQUIRED'));assert.equal(w.calls.length,0);
    phase='safe';lost=false;const {conversion}=await w.start(v);await w.queued.shift()();assert.equal((await w.status(conversion.id)).result.requires_review,true);
    phase='read';assert.equal((await w.status(conversion.id)).result.withheld,true);assert.equal(w.calls.length,1);
  }finally{w.close();}
});
test('source revocation during readiness or quote prevents any private provider disclosure',async()=>{
  for(const stage of ['beforeReadiness','beforeQuote']){
    const w=world();try{
      const v=w.body();v.source_asset_refs=Array.from({length:2},()=>({id:randomUUID(),sha256:'a'.repeat(64),mime_type:'text/plain',byte_count:30}));
      const {conversion}=await w.start(v);let release,entered,lost=false;
      const waiting=new Promise(r=>{entered=r;});w.scenario[stage]=()=>{entered();return new Promise(r=>{release=r;});};
      w.scenario.verify=(actor,pid,ref)=>{if(ref.id===v.source_asset_refs[0].id&&lost)throw Object.assign(Error('review revoked'),{code:'SOURCE_DISCLOSURE_REQUIRED'});};
      const executing=w.queued.shift()();await waiting;lost=true;release();await executing;
      assert.equal(w.calls.length,0,stage);
      const current=await w.status(conversion.id);assert.equal(current.state,'blocked');assert.equal(current.result.code,'SOURCE_DISCLOSURE_REQUIRED');
      assert.equal(current.result.configuration,undefined);assert.equal(current.result.model_spend,'not_requested');
    }finally{w.close();}
  }
});
test('cancel before admission or while provider is outstanding prevents publication and never retries',async()=>{
  const w=world();try{
    const a=(await w.start()).conversion;await w.service.cancel(w.owner,w.p.id,a.id);await w.queued.shift()();assert.equal(w.calls.length,0);assert.equal((await w.status(a.id)).state,'cancelled');
    let release,started;const ready=new Promise(r=>{started=r;});w.scenario.beforeOutput=()=>{started();return new Promise(r=>{release=r;});};
    const b=(await w.start()).conversion,job=w.queued.shift()();await ready;await w.service.cancel(w.owner,w.p.id,b.id);release();await job;
    assert.equal((await w.status(b.id)).state,'cancelled');assert.equal((await w.status(b.id)).result.configuration,undefined);assert.equal(w.calls.length,1);assert(w.cancellations.includes(b.id));
  }finally{w.close();}
});
test('missing provider capability, usage or over-budget output fails closed and leaves no executable draft',async()=>{
  const w=world();try{
    w.scenario.provider={available:false,code:'BROWSER_MODEL_BRIDGE_UNAVAILABLE'};await assert.rejects(()=>w.start(),rejects('BROWSER_MODEL_BRIDGE_UNAVAILABLE'));assert.equal((await w.service.readiness(w.owner,w.p.id)).available,false);
    w.scenario.provider={available:true};
    for(const output of [{usage:null},{settled_usd:'1'},{usage:{prompt_tokens:10000,completion_tokens:15000}}]){
      w.scenario.output=output;const r=(await w.start()).conversion;await w.queued.shift()();assert.equal((await w.status(r.id)).state,'blocked');assert.equal((await w.status(r.id)).result.configuration,undefined);
    }
  }finally{w.close();}
});
