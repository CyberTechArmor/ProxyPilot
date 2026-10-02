import {test} from 'node:test';import assert from 'node:assert/strict';
import {operationsFixture} from './helpers/operations-fixture.js';
import {brokerTaskMigration1114} from '../lib/broker-task-dispatch.js';
import {readLocalFacts} from '../lib/broker-authority-facts.js';
test('authority facts project current eligibility and withdrawn guide without reading secret or narrative columns',()=>{
 const f=operationsFixture();try{
 const owner=f.addUser(),reviewer=f.addUser(),p=f.store.create(owner,{name:'Metadata'});f.store.grant(owner,p.id,reviewer.id,p.revision,{role:'reviewer'});
 f.db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT 'SECRET';");brokerTaskMigration1114(f.adapter);
 const v=f.store.saveDraft(owner,p.id,1,{title:'Private title',instructions:'PRIVATE_GUIDE'}).version;
 const {agent}=f.store.createConfiguration(owner,p.id,{workflow_type:'typed_api_v1',work:{name:'PRIVATE_NAME',task:'PRIVATE_TASK',guide_ref:{id:v.id,hash:v.content_hash}},controls:{}});
 let facts=readLocalFacts(f.db);assert.equal(facts.projects[0].current_guide.id,v.id);assert.equal(facts.agents[0].id,agent.id);assert.equal(facts.agents[0].work.guide_ref.hash,v.content_hash);
 assert.equal(/SECRET|PRIVATE_/.test(JSON.stringify(facts)),false);assert.equal(facts.projects[0].members[0].user_id,reviewer.id);
 f.store.withdraw(reviewer,p.id,v.id,f.store.get(owner,p.id).revision,{reason:'Current withdrawn'});assert.equal(readLocalFacts(f.db).projects[0].current_guide,null);
 f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(owner.id);assert.equal(readLocalFacts(f.db).users.find(u=>u.id===owner.id).role,'pending');
 const bad={...f.adapter,prepare(sql){if(sql.includes('password_hash')||sql.includes('SELECT *'))throw Error('Unsafe projection');return f.db.prepare(sql);}};assert.ok(readLocalFacts(bad));
 }finally{f.close();}
});
