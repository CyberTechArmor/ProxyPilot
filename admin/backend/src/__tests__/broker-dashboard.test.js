import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {operationsFixture,fixtureRouter} from './helpers/operations-fixture.js';
import {createConnectionsRouter} from '../routes/connections.js';
import {createOperationsRouter} from '../routes/operational-projects.js';
const denied=(status,fn)=>assert.throws(fn,e=>e.status===status);
test('draft configuration persistence, revision, permissions and no execution',()=>{
 const f=operationsFixture();try {
 const a=f.addUser(),b=f.addUser(),admin=f.addUser('admin');
 const p=f.store.create(a,{name:'Project',members:[{user_id:b.id,role:'viewer'}]});
 const {agent,readiness}=f.store.createConfiguration(a,p.id,{workflow_type:'typed_api_v1',work:{name:'Draft'}});
 assert.equal(agent.lifecycle,'draft');assert.equal(readiness.can_start,false);assert.equal(agent.execution_enabled,false);
 assert.equal(f.store.configuration(b,p.id,agent.id).agent.id,agent.id);
 denied(403,()=>f.store.updateConfiguration(b,p.id,agent.id,1,{work:{name:'No'}}));
 denied(404,()=>f.store.configuration(admin,p.id,agent.id));
 denied(400,()=>f.store.createConfiguration(a,p.id,{workflow_type:'typed_api_v1',work:{name:'No',secret:'canary'}}));
 denied(400,()=>f.store.createConfiguration(a,p.id,{workflow_type:'typed_api_v1',work:{name:'No',guide_ref:{id:randomUUID(),hash:'a'.repeat(64)}}}));
 const changed=f.store.updateConfiguration(a,p.id,agent.id,1,{work:{name:'Saved'}});assert.equal(changed.agent.revision,2);
 denied(409,()=>f.store.updateConfiguration(a,p.id,agent.id,1,{work:{name:'Stale'}}));
 assert.equal(f.db.prepare('SELECT count(*) n FROM ops_agent_profiles').get().n,0);
 f.store.archive(a,p.id,p.revision,{reason:'done'});
 denied(409,()=>f.store.updateConfiguration(a,p.id,agent.id,2,{work:{name:'Archived'}}));
 assert.equal(f.store.configuration(a,p.id,agent.id).readiness.checks.find(c=>c.kind==='project').code,'PROJECT_ARCHIVED');
 }finally{f.close();}
});
test('initial people grant is atomic and never implies private connection rights',()=>{
 const f=operationsFixture();try{const a=f.addUser(),b=f.addUser();
 denied(400,()=>f.store.create(a,{name:'Rollback',members:[{user_id:b.id,role:'editor'},{user_id:randomUUID(),role:'viewer'}]}));
 assert.equal(f.store.list(a).projects.length,0);
 denied(400,()=>f.store.create(a,{name:'No',members:[{user_id:a.id,role:'editor'}]}));
 }finally{f.close();}
});
test('connection boundary denies secret intake, requires freshness/revision and fails closed',async()=>{
 const f=operationsFixture();try {const a=f.addUser();const router=createConnectionsRouter({Router:fixtureRouter,store:f.store,requireSudo:(q,r,n)=>q.fresh?n():r.status(401).json({sudo_required:true})});
 const send=(method,path,body={},extra={})=>router.dispatch({method,path,body,user:a,...extra});
 assert.equal((await send('GET','/capabilities')).body.intake_enabled,false);
 assert.deepEqual((await send('GET','/')).body.connections,[]);
 assert.equal((await send('GET',`/${randomUUID()}`)).statusCode,404);
 assert.equal((await send('POST','/enrollment-intents')).statusCode,401);
 assert.equal((await send('POST','/enrollment-intents',{name:'x',project_id:null,adapter_id:'synthetic-ledger-v1',value:'canary'},{fresh:true})).statusCode,400);
 assert.equal((await send('POST','/enrollment-intents',{name:'x',project_id:null,adapter_id:'synthetic-ledger-v1'},{fresh:true})).statusCode,503);
 assert.equal((await send('POST',`/${randomUUID()}/revoke`,{},{fresh:true})).statusCode,428);
 }finally{f.close();}
});
test('configuration routes use existing access and expose ETag',async()=>{
 const f=operationsFixture();try{const a=f.addUser(),p=f.store.create(a,{name:'Project'});
 const router=createOperationsRouter({Router:fixtureRouter,store:f.store,enabled:true,agentsEnabled:true});
 const r=await router.dispatch({method:'POST',path:`/${p.id}/agent-configurations`,user:a,body:{workflow_type:'typed_api_v1',work:{name:'Draft'}}});
 assert.equal(r.statusCode,201);assert.equal(r.headers.etag,'"1"');
 const list=await router.dispatch({method:'GET',path:`/${p.id}/agent-configurations`,user:a});assert.equal(list.body.agents.length,1);
 }finally{f.close();}
});
test('existing approved guide reused and withdrawal immediately invalidates readiness',()=>{
 const f=operationsFixture();try{const a=f.addUser(),reviewer=f.addUser();const p=f.store.create(a,{name:'Project',members:[{user_id:reviewer.id,role:'reviewer'}]});
 const version=f.store.saveDraft(a,p.id,1,{title:'Guide',instructions:'Use only approved API resources'}).version;
 const {agent,readiness}=f.store.createConfiguration(a,p.id,{workflow_type:'typed_api_v1',work:{name:'Reusable',guide_ref:{id:version.id,hash:version.content_hash}}});
 assert.equal(readiness.checks.find(c=>c.kind==='guide').state,'ready');
 f.store.withdraw(reviewer,p.id,version.id,f.store.get(a,p.id).revision,{reason:'Changed'});
 assert.equal(f.store.configuration(a,p.id,agent.id).readiness.checks.find(c=>c.kind==='guide').state,'stale');
 }finally{f.close();}
});
test('hostile bridge fields never cross public response projection',async()=>{
 const f=operationsFixture();try{const a=f.addUser();const bridge={request:async()=>({connections:[],next_cursor:null,credential:'canary',token:'canary'})};
 const router=createConnectionsRouter({Router:fixtureRouter,store:f.store,bridge});
 const response=await router.dispatch({method:'GET',path:'/',user:a});assert.equal(response.statusCode,200);assert.equal(JSON.stringify(response.body).includes('canary'),false);
 bridge.request=async()=>({connections:[{value:'canary'}]});
 const invalid=await router.dispatch({method:'GET',path:'/',user:a});assert.equal(invalid.statusCode,503);assert.equal(JSON.stringify(invalid.body).includes('canary'),false);
 }finally{f.close();}
});
test('real HTTP routes enforce authentication/CSRF and persist configurations',async()=>{
 const {default:express}=await import('express');const {csrfProtection}=await import('../middleware/csrf.js');
 const f=operationsFixture();let server;
 try{const a=f.addUser(),p=f.store.create(a,{name:'HTTP'}),app=express();app.use(express.json());
 app.use((req,res,next)=>{req.cookies={pp_csrf:'fixture'};if(req.get('X-Fixture-User')===a.id)req.user=a;next();});
 app.use(csrfProtection);app.use((req,res,next)=>req.user?next():res.status(401).end());
 app.use('/api/connections',createConnectionsRouter({Router:express.Router,store:f.store}));
 app.use('/api/operational-projects',createOperationsRouter({Router:express.Router,store:f.store,enabled:true,agentsEnabled:true,lookupLimiter:(_q,_r,n)=>n()}));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/api/connections')).status,401);
 const path=base+`/api/operational-projects/${p.id}/agent-configurations`,body=JSON.stringify({workflow_type:'typed_api_v1',work:{name:'HTTP draft'}});
 const headers={'Content-Type':'application/json','X-Fixture-User':a.id};
 assert.equal((await fetch(path,{method:'POST',headers,body})).status,403);
 const response=await fetch(path,{method:'POST',headers:{...headers,'X-CSRF-Token':'fixture'},body});
 assert.equal(response.status,201);assert.equal((await response.json()).agent.execution_enabled,false);
 assert.equal(f.store.configurations(a,p.id).agents.length,1);
 }finally{if(server)await new Promise(r=>server.close(r));f.close();}
});
