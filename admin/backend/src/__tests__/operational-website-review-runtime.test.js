import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createReviewModelBridge,reviewRequestDigest} from '../lib/operational-website-review-runtime.js';
import {createSupervisorClient} from '../lib/operational-worker-supervisor.js';
import {digest} from '../lib/operational-public-web.js';
const keys=()=>generateKeyPairSync('ed25519');
const input=()=>({run_id:randomUUID(),call_id:randomUUID(),task_hash:'a'.repeat(64),guide_hash:'b'.repeat(64),limits:{max_usd:1e-7,max_tokens:20000},objective:'Summarize café and 🎨 public content'});
function signed(request,key) {
  const r={text:'{"summary":"A public review with provenance and cited evidence."}',usage:{prompt_tokens:800,completion_tokens:150},settled_usd:'0.001',price_table_revision:3};
  const p={kind:'public-website-review-model',run_id:request.run_id,call_id:request.call_id,task_hash:request.task_hash,
    guide_hash:request.guide_hash,request_hash:reviewRequestDigest(request),response_hash:digest(r.text),usage:r.usage,
    settled_usd:r.settled_usd,price_table_revision:r.price_table_revision};
  const body=Buffer.from(JSON.stringify(p));r.attestation=`ppr1.${body.toString('base64url')}.${sign(null,body,key).toString('base64url')}`;return r;
}
test('signed review receipt binds exact identity, guide, request, content, usage and cost',async()=>{
  const {privateKey,publicKey}=keys(),request=input();const pem=publicKey.export({type:'spki',format:'pem'});
  const response=signed(request,privateKey);let current=response;
  const bridge=createReviewModelBridge({publicKeyPem:pem,client:{request:async()=>current}});
  assert.equal((await bridge.review(request)).text,response.text);
  current={...response,usage:{completion_tokens:150,prompt_tokens:800}};
  assert.equal((await bridge.review(request)).text,response.text);
  current=response;
  for(const patch of [{run_id:randomUUID()},{call_id:randomUUID()},{task_hash:'c'.repeat(64)},{guide_hash:'c'.repeat(64)},
    {objective:'Different review'},{limits:{max_usd:0.05,max_tokens:20000}}])await assert.rejects(()=>bridge.review({...request,...patch}),e=>e.code==='PROVIDER_UNAVAILABLE');
  for(const patch of [{text:'Changed text'},{usage:{prompt_tokens:1,completion_tokens:1}},
    {usage:{prompt_tokens:800,completion_tokens:150,extra:1}},{usage:{prompt_tokens:-1,completion_tokens:150}},
    {settled_usd:'0'},{price_table_revision:4},
    {attestation:response.attestation.slice(0,-8)+'AAAAAAAA'}]){current={...response,...patch};await assert.rejects(()=>bridge.review(request),e=>e.code==='PROVIDER_UNAVAILABLE');}
  current=signed(request,keys().privateKey);await assert.rejects(()=>bridge.review(request),e=>e.code==='PROVIDER_UNAVAILABLE');
});
test('old supervisor/provider readiness is blocked and cancellation never starts a call',async()=>{
  const {publicKey}=keys(),calls=[];let result={};const bridge=createReviewModelBridge({publicKeyPem:publicKey.export({type:'spki',format:'pem'}),client:{request:async(method,params)=>{calls.push({method,params});return result;}}});
  assert.deepEqual(await bridge.readiness(),{available:false,code:'PROVIDER_UNAVAILABLE'});
  result={contract_version:'website-review.v1',available:false,code:'REVIEW_BRIDGE_UNAVAILABLE'};assert.equal((await bridge.readiness()).code,'REVIEW_BRIDGE_UNAVAILABLE');
  const abort=new AbortController();abort.abort();await assert.rejects(()=>bridge.review(input(),{signal:abort.signal}),e=>e.code==='CANCELLED');
  assert.equal(calls.some(c=>c.method==='public_review_model'),false);await bridge.cancel('fixture');assert.equal(calls.at(-1).method,'cancel_public_review');
});
test('real supervisor socket preserves Unicode, numeric budget and signed result through JSON transport',{skip:process.platform==='win32'},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'pp-review-socket-')),socket=path.join(dir,'bridge.sock'),pair=keys(),request=input();
  const server=net.createServer(client=>{let buffer='';client.on('data',chunk=>{buffer+=chunk;if(!buffer.includes('\n'))return;
    const envelope=JSON.parse(buffer);assert.equal(envelope.method,'public_review_model');assert.deepEqual(envelope.params,request);
    client.end(JSON.stringify({ok:true,result:signed(envelope.params,pair.privateKey)})+'\n');});});
  try{await new Promise(done=>server.listen(socket,done));const bridge=createReviewModelBridge({client:createSupervisorClient(socket),publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'})});
    assert.equal((await bridge.review(request)).settled_usd,'0.001');}
  finally{await new Promise(done=>server.close(done));rmSync(dir,{recursive:true,force:true});}
});

test('cancelling an in-flight review closes the real supervisor socket without waiting for its reply',{skip:process.platform==='win32'},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'pp-review-cancel-')),socket=path.join(dir,'bridge.sock'),pair=keys(),control=new AbortController();
  let entered;const received=new Promise(done=>entered=done);
  const server=net.createServer(client=>{client.on('data',()=>entered());});
  try{await new Promise(done=>server.listen(socket,done));const bridge=createReviewModelBridge({client:createSupervisorClient(socket),publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'})});
    const pending=bridge.review(input(),{signal:control.signal});await received;control.abort();await assert.rejects(()=>pending,e=>e.code==='CANCELLED');}
  finally{await new Promise(done=>server.close(done));rmSync(dir,{recursive:true,force:true});}
});
