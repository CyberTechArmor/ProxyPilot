// OpenBao automatic custody ("recovery kit + auto-unseal") for the basic managed install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb,inputFor,dockerFixture,baoFixture,autoShares } from './helpers/openbao-fixture.js';
import { save,apply,review,readOpenBao,state,acknowledge,custody,putCustody,hasCustody } from '../lib/setup-engine/openbao-store.js';
import { runOnce } from '../lib/setup-engine/executor.js';
import { runBackendSteps } from '../lib/setup-engine/backend-steps.js';
import { backendStepDeps } from '../mock2/ops.js';
import { sweepOpenBaoAutoUnseal,decodeRoot,withTransientRoot } from '../lib/setup-engine/openbao-custody.js';
import { digest,namesFor,policyFor,humanPolicyFor,priorHumanFor,HUMAN_TTL } from '../lib/setup-engine/openbao-logic.js';
import { getJob } from '../lib/setup-engine/store.js';
import { makeDb as fullDb,apiFixture,driveStages } from './helpers/full-platform-fixture.js';
import { readFullPlatform } from '../lib/setup-engine/full-platform-store.js';
import { resetReview } from '../lib/setup-engine/full-platform-reset.js';
const {buildDomainCaddyConfig}=await import('../routes/services.js');

const autoInput=()=>{const i={...inputFor('install'),basic:true,initialize:true,custody:'auto'};delete i.database;delete i.pgpKeys;delete i.rootPgpKey;return i;};
const approval=db=>{const v=review(db);return {revision:v.revision,reviewToken:v.reviewToken,reviewed:true};};
const ROOT='g6-bootstrap-token';
function renderer(dir){mkdirSync(join(dir,'sites'),{recursive:true});return {caddyFilePath:d=>join(dir,'sites',d+'.caddy'),regenerate:async(db,d)=>{const rows=db.prepare('SELECT r.*,s.target_ip,s.kind,s.type FROM service_http_routes r JOIN services s ON s.id=r.service_id WHERE r.domain=?').all(d);writeFileSync(join(dir,'sites',d+'.caddy'),buildDomainCaddyConfig(rows,d));},adapt:async()=>{},reload:async()=>{},writeConfig:async(p,s)=>writeFileSync(p,s),removeConfig:async p=>rmSync(p,{force:true})};}
function harness(db,dir){const api=baoFixture(db),render=renderer(join(dir,'caddy'));let now=Date.now();
  const deps={db,owner:'runner@g6#123:a',exec:dockerFixture(),nowMs:()=>now,openbaoDeps:{root:join(dir,'owned'),recoveryRoot:join(dir,'recovery'),send:api.send,clientProbe:async()=>({fixture:true}),providerProbe:async()=>({fixture:true}),flow:async()=>{throw Error('basic must not run the database flow');},sleep:async()=>{},attempts:1}};
  const tick=async()=>{now+=35000;await runOnce(deps,{max:1,reconcileFirst:false});await runBackendSteps({db,owner:'backend@g6#124:a',nowMs:()=>now,sleep:async()=>{},deps:backendStepDeps({getDb:()=>db,renderDeps:render})});};
  return {api,async finish(){for(let i=0;i<6;i++){await tick();const j=getJob(db,readOpenBao(db).last_job_id);if(!['queued','running'].includes(j.status))return j;}throw Error('job did not settle');}};}
const withDb=async fn=>{const dir=mkdtempSync(join(tmpdir(),'bao-auto-')),path=join(dir,'db.sqlite'),db=makeDb(path);try{save(db,autoInput());await fn(db,dir,path);}finally{db.close();rmSync(dir,{recursive:true,force:true});}};
// Every place a plaintext share or the root token must never appear.
function publicBytes(db,path){const files=[path,path+'-wal'].filter(existsSync).map(p=>readFileSync(p).toString('latin1')).join('\n');
  return files+JSON.stringify([db.prepare('SELECT * FROM setup_openbao').all(),db.prepare('SELECT * FROM setup_jobs').all(),db.prepare('SELECT * FROM setup_job_events').all(),state(db),review(db)]);}

test('auto custody: config validation — no PGP keys needed, refused with keys, outside install or outside basic',()=>withDb(db=>{
  const r=readOpenBao(db);assert.equal(r.config.custody,'auto');assert.equal(r.config.pgpKeys,undefined);assert.equal(state(db).custody,'auto');
  const dir=mkdtempSync(join(tmpdir(),'bao-auto-v-'));try{
    const a=makeDb(join(dir,'a.sqlite'));assert.throws(()=>save(a,{...autoInput(),pgpKeys:inputFor('install').pgpKeys,rootPgpKey:inputFor('install').rootPgpKey}),/no PGP keys/);a.close();
    const b=makeDb(join(dir,'b.sqlite'));const nb={...inputFor('install'),custody:'auto'};delete nb.pgpKeys;delete nb.rootPgpKey;assert.throws(()=>save(b,nb),/basic managed install/);b.close();
    const c=makeDb(join(dir,'c.sqlite'),{mode:'connect'});assert.throws(()=>save(c,{...inputFor('connect'),custody:'auto'}),/basic managed install|refused/);c.close();
    // PGP path unchanged: custody 'pgp' is the default and is not stored, so existing fingerprints do not move.
    const d=makeDb(join(dir,'d.sqlite'));save(d,{...inputFor('install'),custody:'pgp'});assert.equal(readOpenBao(d).config.custody,undefined);assert.equal(state(d).custody,'pgp');assert.equal(state(d).kitAvailable,false);d.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
}));

test('auto custody: init without PGP, shares/root persisted only encrypted, auto-unseal with exactly 2 shares, auto bootstrap revokes and forgets the root token',()=>withDb(async(db,dir,path)=>{
  const h=harness(db,dir);apply(db,approval(db),'admin');const j=await h.finish();
  assert.equal(j.status,'succeeded',j.reason);assert.equal(h.api.initCount,1);
  assert.deepEqual(h.api.initBodies,[{secret_shares:3,secret_threshold:2}],'no pgp_keys / root_token_pgp_key');
  assert.deepEqual(h.api.unsealKeys,autoShares.slice(0,2),'exactly the 2 stored shares');
  assert.equal(h.api.revocations,1,'the initial root token was revoked');
  let r=readOpenBao(db);assert(r.bootstrap_complete);assert.equal(r.init_attempted,1);assert.equal(r.handoff_ack,0);
  assert.equal(JSON.parse(r.verified_json).state,'scoped_access_verified');
  assert(!existsSync(join(dir,'recovery',r.credential_ref+'.json')),'no plaintext host package');
  for(const row of db.prepare('SELECT value FROM setup_openbao_credentials').all())assert(row.value.startsWith('enc:v1:'));
  const kit=custody(db,r,'kit');assert.deepEqual(kit.shares,autoShares);assert.equal(kit.root,null);assert.equal(kit.rootRevoked,true);assert.equal(r.handoff_digest,digest(kit.receipt));
  assert.deepEqual(custody(db,r,'unseal').shares,autoShares.slice(0,2));
  const s=state(db);assert.equal(s.kitAvailable,true);assert.equal(s.autoUnseal,true);assert.equal(s.bootstrapTokenHeld,false);
  const pub=publicBytes(db,path);for(const secret of [...autoShares,ROOT,kit.receipt])assert(!pub.includes(secret),'plaintext leaked');
  // A restart seals it again: the next apply unseals by itself with 2 shares and never initializes twice.
  h.api.sealed=true;h.api.unsealKeys.length=0;apply(db,approval(db),'admin');const again=await h.finish();
  assert.equal(again.status,'succeeded',again.reason);assert.deepEqual(h.api.unsealKeys,autoShares.slice(0,2));assert.equal(h.api.initCount,1);assert.equal(h.api.revocations,1);
}));

test('auto custody: acknowledgement deletes the one-time kit and keeps the 2-share auto-unseal record',()=>withDb(async(db,dir)=>{
  const h=harness(db,dir);apply(db,approval(db),'admin');await h.finish();const r=readOpenBao(db),kit=custody(db,r,'kit');
  assert.throws(()=>acknowledge(db,{...approval(db),receipt:'x'.repeat(32)}),/receipt does not match/);assert(hasCustody(db,r,'kit'));
  const s=acknowledge(db,{...approval(db),receipt:kit.receipt});
  assert.equal(s.handoffAcknowledged,true);assert.equal(s.kitAvailable,false);assert.equal(s.autoUnseal,true);
  assert(!hasCustody(db,r,'kit'));assert.deepEqual(custody(db,r,'unseal').shares,autoShares.slice(0,2));
}));

test('auto custody: before acknowledgement a failed bootstrap keeps the root token; after acknowledgement the manual bootstrap form is the fallback',()=>withDb(async(db,dir)=>{
  const h=harness(db,dir);h.api.broad=true;apply(db,approval(db),'admin');const j=await h.finish();
  assert.notEqual(j.status,'succeeded');let r=readOpenBao(db);assert(!r.bootstrap_complete);
  assert.equal(state(db).bootstrapTokenHeld,true,'root token kept (unrevoked) for a retry');
  acknowledge(db,{...approval(db),receipt:custody(db,r,'kit').receipt});r=readOpenBao(db);assert(!hasCustody(db,r,'kit'));assert.equal(state(db).bootstrapTokenHeld,false);
  h.api.broad=false;apply(db,approval(db),'admin');const k=await h.finish();
  assert.equal(k.status,'succeeded');const v=JSON.parse(k.verification_json);assert.equal(v.state,'awaiting_user_action');assert.match(v.label,/no longer holds the initial root token/);
}));

test('auto-unseal sweep does nothing unless custody auto + acknowledged + sealed',()=>withDb(async(db,dir)=>{
  const h=harness(db,dir);apply(db,approval(db),'admin');await h.finish();let r=readOpenBao(db);
  h.api.sealed=true;h.api.unsealKeys.length=0;
  assert.equal((await sweepOpenBaoAutoUnseal({db,send:h.api.send})).skipped,'not_applicable','not acknowledged');assert.equal(h.api.unsealKeys.length,0);
  acknowledge(db,{...approval(db),receipt:custody(db,r,'kit').receipt});
  assert.deepEqual(await sweepOpenBaoAutoUnseal({db,send:h.api.send}),{unsealed:true});assert.deepEqual(h.api.unsealKeys,autoShares.slice(0,2));assert.equal(h.api.sealed,false);
  h.api.unsealKeys.length=0;assert.equal((await sweepOpenBaoAutoUnseal({db,send:h.api.send})).skipped,'unsealed');assert.equal(h.api.unsealKeys.length,0);
  // PGP custody: never touched.
  r=readOpenBao(db);db.prepare('UPDATE setup_openbao SET config_json=?').run(JSON.stringify({...r.config,custody:undefined}));h.api.sealed=true;
  assert.equal((await sweepOpenBaoAutoUnseal({db,send:h.api.send})).skipped,'not_applicable');assert.equal(h.api.unsealKeys.length,0);
  // Unavailable service: fails safe without throwing.
  db.prepare('UPDATE setup_openbao SET config_json=?').run(JSON.stringify(r.config));h.api.unavailable=true;
  assert.equal((await sweepOpenBaoAutoUnseal({db,send:h.api.send})).skipped,'unavailable');
}));

test('PGP custody path unchanged: encrypted host package, no custody records, manual unseal message',()=>{const dir=mkdtempSync(join(tmpdir(),'bao-pgp-')),db=makeDb(join(dir,'db.sqlite'));
  return (async()=>{try{save(db,inputFor('install'));const h=harness(db,dir);apply(db,approval(db),'admin');const j=await h.finish();
    assert.equal(j.status,'recovery_required');assert.match(j.reason,/acknowledgement/);assert(h.api.initBodies[0].pgp_keys?.length===3&&h.api.initBodies[0].root_token_pgp_key);
    const r=readOpenBao(db);assert(existsSync(join(dir,'recovery',r.credential_ref+'.json')));assert(!hasCustody(db,r,'unseal')&&!hasCustody(db,r,'kit'));
    assert.equal(await sweepOpenBaoAutoUnseal({db,send:h.api.send}).then(x=>x.skipped),'not_applicable');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}})();});

test('Full Platform: recovery route accepts custody auto without keys; kit route needs sudo + local proof, is audited without contents, and is gone after acknowledgement; purge lists the custody records',async()=>{const db=fullDb();try{
  await driveStages(db,{owner:'runner@full-test#1:a',through:'D'});const f=await apiFixture(db);try{
    const full=readFullPlatform(db);let r=readOpenBao(db);assert(r.config.basic&&!r.config.initialize);
    assert.equal((await f.request('/full/openbao/recovery',{method:'POST',body:{revision:full.revision,custody:'auto',pgpKeys:['a','b','c'],rootPgpKey:'d',reviewed:true}})).status,400);
    const q=await f.request('/full/openbao/recovery',{method:'POST',body:{revision:full.revision,custody:'auto',reviewed:true}});assert.equal(q.status,202,JSON.stringify(q.body));
    r=readOpenBao(db);assert.equal(r.config.custody,'auto');assert.equal(r.config.initialize,true);assert.equal(r.config.pgpKeys,undefined);
    assert(db.prepare("SELECT 1 FROM audit WHERE action='OPENBAO_AUTO_CUSTODY_CHOSEN'").get());
    // Before initialization: nothing to download.
    const session=db.prepare("SELECT id FROM sessions WHERE user_id='admin' AND sudo_until IS NOT NULL").get();
    assert.equal((await f.request('/full/openbao/recovery-kit')).status,403,'no local proof');
    db.prepare("INSERT INTO sso_session_context(session_id,user_id,origin,method,authenticated_at,local_proof_at) VALUES (?,'admin',?,'local',?,?)").run(session.id,f.url.replace('http:','https:'),Date.now(),Date.now());
    assert.equal((await f.request('/full/openbao/recovery-kit')).status,410);
    // Simulate the recorded initialization.
    const receipt='fixture-receipt-0123456789abcdef';putCustody(db,r,'unseal',{shares:autoShares.slice(0,2),receiptDigest:digest(receipt)});putCustody(db,r,'kit',{receipt,shares:autoShares,root:ROOT});db.prepare('UPDATE setup_openbao SET init_attempted=1,handoff_digest=? WHERE id=1').run(digest(receipt));
    for(const who of [null,'user','cold'])assert([401,403].includes((await f.request('/full/openbao/recovery-kit',{who})).status));
    db.prepare('UPDATE sso_session_context SET local_proof_at=?').run(Date.now()-301000);assert.equal((await f.request('/full/openbao/recovery-kit')).status,403,'stale local proof');
    db.prepare('UPDATE sso_session_context SET local_proof_at=?').run(Date.now());
    const k=await f.request('/full/openbao/recovery-kit');assert.equal(k.status,200,JSON.stringify(k.body));
    assert.match(k.headers.get('content-disposition'),/^attachment; filename="openbao-recovery-kit-/);assert.equal(k.headers.get('cache-control'),'no-store');
    assert.deepEqual(k.body.shares,autoShares);assert.equal(k.body.rootToken,ROOT);assert.equal(k.body.receipt,receipt);assert.equal(k.body.threshold,2);assert(k.body.instructions.length);
    assert(db.prepare("SELECT 1 FROM audit WHERE action='OPENBAO_RECOVERY_KIT_DOWNLOADED'").get());
    const pub=JSON.stringify([db.prepare('SELECT * FROM audit').all(),db.prepare('SELECT * FROM setup_jobs').all(),db.prepare('SELECT * FROM setup_job_events').all(),(await f.request('/full')).body,(await f.request('/openbao')).body]);
    for(const secret of [...autoShares,ROOT,receipt])assert(!pub.includes(secret));
    const st=(await f.request('/openbao')).body.state;assert.equal(st.custody,'auto');assert.equal(st.kitAvailable,true);assert.equal(st.autoUnseal,true);
    // Stage D waits on the kit.
    assert.equal((await f.request('/full')).body.services.find(s=>s.id==='openbao').state,'awaiting_user_action');
    // Purge lists (and would remove) the custody records; a data-kept reset keeps them like the other protected credentials.
    db.prepare("UPDATE setup_jobs SET status='succeeded' WHERE status IN ('queued','running')").run();
    const purge=resetReview(db,{purgeData:true}).remove.records.find(x=>/automatic-unseal/.test(x.what));assert.equal(purge.rows,2);
    assert(!resetReview(db,{purgeData:false}).remove.records.some(x=>/automatic-unseal/.test(x.what)));
    const v=review(db),ack=await f.request('/openbao/handoff',{method:'PUT',body:{revision:v.revision,reviewToken:v.reviewToken,reviewed:true,receipt}});assert.equal(ack.status,200,JSON.stringify(ack.body));
    assert(!hasCustody(db,r,'kit'));assert(hasCustody(db,r,'unseal'));
    assert.equal((await f.request('/full/openbao/recovery-kit')).status,410,'one time: gone after acknowledgement');
  }finally{await f.close();}
}finally{db.close();}});

test('team workspace: a fresh install writes the workspace policy and the 8 h role with no root generation',()=>withDb(async(db,dir)=>{
  const h=harness(db,dir);apply(db,approval(db),'admin');const j=await h.finish();assert.equal(j.status,'succeeded',j.reason);
  const r=readOpenBao(db),n=namesFor(r);
  assert.equal(h.api.policies.get(n.human),humanPolicyFor(r));assert.equal(h.api.policies.get(n.machine),policyFor(r),'machine scope unchanged');
  assert.match(h.api.policies.get(n.human),/-kv\/data\/team\/\*" \{ capabilities = \["create", "read", "update", "delete", "list"\]/);
  assert.equal(h.api.resources.get(`/v1/auth/${n.oidc}/role/mapped`).token_ttl,HUMAN_TTL);assert.equal(h.api.genStarts,0);
}));

test('team workspace: an install carrying the earlier rendering is upgraded with a transient root that is revoked; drift and a foreign generation are refused',()=>withDb(async(db,dir)=>{
  const h=harness(db,dir);apply(db,approval(db),'admin');assert.equal((await h.finish()).status,'succeeded');
  const r=readOpenBao(db),n=namesFor(r),rolePath=`/v1/auth/${n.oidc}/role/mapped`,prior=priorHumanFor(r);
  // What ProxyPilot wrote before the workspace existed.
  h.api.policies.set(n.human,prior.policy);h.api.resources.set(rolePath,{...h.api.resources.get(rolePath),token_ttl:120,token_max_ttl:120});
  apply(db,approval(db),'admin');const up=await h.finish();assert.equal(up.status,'succeeded',up.reason);
  assert.equal(h.api.policies.get(n.human),humanPolicyFor(r));assert.equal(h.api.resources.get(rolePath).token_ttl,HUMAN_TTL);
  assert.equal(h.api.genStarts,1);assert.equal(h.api.genRevocations,1);assert.equal(h.api.genRoots.size,0,'no root token left valid');
  // Current → nothing privileged happens on the next apply.
  apply(db,approval(db),'admin');assert.equal((await h.finish()).status,'succeeded');assert.equal(h.api.genStarts,1);
  // Someone else's policy text is never overwritten, and no root is generated for it.
  h.api.policies.set(n.human,'path "secret/*" { capabilities = ["read"] }\n');
  apply(db,approval(db),'admin');const drift=await h.finish();assert.match(drift.reason,/differs from what ProxyPilot wrote/);assert.equal(h.api.genStarts,1);
  assert.equal(h.api.policies.get(n.human),'path "secret/*" { capabilities = ["read"] }\n');
}));

test('transient root: refuses an in-progress generation, cancels its own failed attempt, decodes the one-time pad',async()=>{
  const otp='abcdefghijklmnopqrstuvwxyz',tok='s.0123456789ABCDEFGHIJKLMN';
  assert.equal(decodeRoot(Buffer.from([...Buffer.from(tok)].map((x,i)=>x^otp.charCodeAt(i))).toString('base64'),otp),tok);
  assert.throws(()=>decodeRoot('YWJj',otp),/one-time pad/);
  const r={config:{basic:true,mode:'install',custody:'auto'},credential_ref:'x'};
  const db={prepare:()=>({get:()=>null})};
  await assert.rejects(withTransientRoot(db,{...r,config:{...r.config,custody:undefined}},async()=>({}),async()=>{}),/PGP custody/);
});

test('transient root: a generation somebody else started is refused, not cancelled',()=>withDb(async(db,dir)=>{
  const h=harness(db,dir);apply(db,approval(db),'admin');assert.equal((await h.finish()).status,'succeeded');
  const r=readOpenBao(db),n=namesFor(r),rolePath=`/v1/auth/${n.oidc}/role/mapped`,prior=priorHumanFor(r);
  h.api.policies.set(n.human,prior.policy);h.api.resources.set(rolePath,{...h.api.resources.get(rolePath),token_ttl:120,token_max_ttl:120});
  await h.api.send(r.config.origin,'/v1/sys/generate-root/attempt',{method:'PUT',body:{}});const starts=h.api.genStarts;
  apply(db,approval(db),'admin');const j=await h.finish();assert.match(j.reason,/already in progress/);
  assert.equal(h.api.genStarts,starts);assert.equal(h.api.policies.get(n.human),prior.policy,'nothing written');
  assert.equal((await h.api.send(r.config.origin,'/v1/sys/generate-root/attempt',{method:'GET'})).body.started,true,'their attempt was left alone');
}));
