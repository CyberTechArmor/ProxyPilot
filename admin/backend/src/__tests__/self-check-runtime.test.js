import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureSelfCheckRuntime } from '../../../../scripts/self-check-runtime.mjs';

test('ready runtimes need no package mutation; omissions install only declared packages inside Alpine',()=>{
  const calls=[];let ready=false;
  const run=(program,args)=>{calls.push([program,args]);if(program==='/sbin/apk'){ready=true;return{status:0};}return{status:ready?0:1};};
  const result=ensureSelfCheckRuntime({run,exists:()=>true,uid:0,log:()=>{}});
  assert.deepEqual(result.installed,['py3-cryptography','poppler-utils']);
  assert.deepEqual(calls.find(([p])=>p==='/sbin/apk'),['/sbin/apk',['add','--no-cache','py3-cryptography','poppler-utils']]);
  calls.length=0;assert.deepEqual(ensureSelfCheckRuntime({run,exists:()=>true,uid:0}),{installed:[]});
  assert.ok(!calls.some(([p])=>p==='/sbin/apk'));
});
test('unprivileged or non-Alpine check environment gives a specific blocker without touching host packages',()=>{
  let installs=0;const run=(p)=>{if(p==='/sbin/apk')installs++;return{status:1};};
  for(const opts of [{uid:1000,exists:()=>true},{uid:0,exists:()=>false}]) assert.throws(()=>ensureSelfCheckRuntime({run,...opts,log:()=>{}}),/SELF_CHECK_RUNTIME_MISSING/);
  assert.equal(installs,0);
});
