import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalKey, approvalBlocker, submitReviewBatch } from '../src/components/operational-projects/browser-review-batch.js';

function fixture() {
  const run={id:'run-1',attempt_id:'attempt-1',fence:1,revision:1};
  const approvals=['one','two'].map(id=>({id,kind:'network_effect',state:'pending',action_sha256:(id==='one'?'a':'b').repeat(64),purpose:'Load this exact resource',no_contact:true,expires_at:new Date(Date.now()+60000).toISOString()}));
  const snapshot={run,pending_approvals:approvals,controls:{can_approve:true},uncertainties:[]};
  let data=structuredClone(snapshot);const writes=[],reads=[];
  const client={get:async()=>{reads.push(data.run.revision);return structuredClone(data);},write:async(path,body,revision)=>{assert.equal(revision,data.run.revision);writes.push({path,body,revision});data.run.revision++;data.pending_approvals=data.pending_approvals.filter(a=>!path.endsWith(`/${a.id}/decision`));}};
  const choices=Object.fromEntries(approvals.map(a=>[approvalKey(a,run),'approve']));
  return {snapshot,choices,client,writes,reads,get data(){return data;},set data(value){data=value;},submit(){return submitReviewBatch({snapshot,choices,client,root:'/runs/run-1',onData:()=>{}});}};
}
test('explicit decisions are individually pinned with fresh revisions',async()=>{
  const f=fixture();await f.submit();assert.deepEqual(f.writes.map(w=>w.revision),[1,2]);assert.deepEqual(f.writes.map(w=>w.body),[{decision:'approve',action_sha256:'a'.repeat(64)},{decision:'approve',action_sha256:'b'.repeat(64)}]);assert.equal(f.reads.length,4);
});
test('missing selection never writes a request',async()=>{const f=fixture();delete f.choices[approvalKey(f.snapshot.pending_approvals[1],f.snapshot.run)];await assert.rejects(f.submit(),/every request/);assert.equal(f.writes.length,0);});
test('changed attempt, fence or action must be reviewed again',async()=>{
  for(const mutate of [d=>d.run.attempt_id='other',d=>d.run.fence++,d=>d.pending_approvals[0].action_sha256='c'.repeat(64)]){const f=fixture();mutate(f.data);await assert.rejects(f.submit(),/changed/);assert.equal(f.writes.length,0);}
});
test('partial submission preserves earlier decisions and does not replay them',async()=>{
  const f=fixture(),write=f.client.write;f.client.write=async(...args)=>{await write(...args);f.data.pending_approvals[0].action_sha256='c'.repeat(64);};await assert.rejects(f.submit(),/Earlier decisions are saved/);assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.action_sha256,'a'.repeat(64));
});
test('new requests keep the review open after the chosen requests are saved',async()=>{
  const f=fixture(),write=f.client.write;f.client.write=async(...args)=>{await write(...args);if(f.writes.length===2)f.data.pending_approvals=[{...f.snapshot.pending_approvals[0],id:'new'}];};await assert.rejects(f.submit(),/New requests/);assert.equal(f.writes.length,2);
});
test('denial is submitted last and never resumes execution',async()=>{
  const f=fixture();f.choices[approvalKey(f.snapshot.pending_approvals[0],f.snapshot.run)]='deny';await f.submit();assert.deepEqual(f.writes.map(w=>w.body.decision),['approve','deny']);assert(f.writes.every(w=>w.path.endsWith('/decision')));
});
test('expired requests, missing purpose and missing before-contact proof block approval',async()=>{
  for(const mutate of [a=>a.expires_at='invalid',a=>a.expires_at=new Date(0).toISOString(),a=>a.purpose='',a=>a.no_contact=false]){const f=fixture();mutate(f.data.pending_approvals[0]);assert(approvalBlocker(f.data.pending_approvals[0]));await assert.rejects(f.submit());assert.equal(f.writes.length,0);}
});
test('authorization errors do not retry decisions',async()=>{const f=fixture();f.client.write=async()=>{throw new Error('verification required');};await assert.rejects(f.submit(),/verification/);assert.equal(f.reads.length,1);assert.equal(f.writes.length,0);});
