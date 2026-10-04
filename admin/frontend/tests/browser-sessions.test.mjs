import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {SESSION_PROJECT_BATCH,canPrepareSession,isActiveSession,loadSessionBatch,sessionCounts,sessionGroup,sessionRunUrl} from '../src/components/operational-projects/browser-sessions.js';

test('observed state groups distinguish stopped records, reconciliation and active singleton records',()=>{
  const rows=['preparing','running','paused','awaiting_approval','human_control','stopping','completed','cancelled','failed','uncertain'].map(state=>({run:{state}}));
  assert.deepEqual(sessionCounts(rows),{all:10,help:3,running:3,paused:1,ended:3,active:6});
  assert.equal(sessionGroup({state:'cancelled',uncertain:true}),'help');
  assert.equal(isActiveSession({state:'uncertain'}),false);
  assert.equal(sessionGroup({state:'new_unsupported_state'}),'ended');
});
test('preparation links to settings and run links are inert explicit identities',()=>{
  assert.equal(canPrepareSession({own_role:'viewer'}),false);
  assert.equal(canPrepareSession({own_role:'owner',archived_at:'yesterday'}),false);
  for(const own_role of ['owner','editor','reviewer','operator'])assert.equal(canPrepareSession({own_role}),true);
  assert.equal(sessionRunUrl('project/a','run?b'),'/operational-projects/project%2Fa?section=Agents&browser_run=run%3Fb');
  const page=readFileSync(new URL('../src/pages/BrowserSessions.jsx',import.meta.url),'utf8');
  assert(!page.includes('api.write'));
  assert(!page.includes('LiveBrowser'));
  assert(!page.includes('PublicBrowserFrames'));
});
test('one requested project page causes at most six metadata GETs, preserves cursor and truthfully caps run results',async()=>{
  const calls=[],signal=new AbortController().signal;
  const result=await loadSessionBatch({get:async(path,received)=>{
    assert.equal(received,signal);calls.push(path);
    if(path.startsWith('?'))return {projects:Array.from({length:20},(_,i)=>({id:String(i)})),next_cursor:'after-6'};
    return {runs:Array.from({length:51},(_,i)=>({id:String(i),state:'cancelled'}))};
  }},'cursor &',signal);
  assert.equal(calls.length,1+SESSION_PROJECT_BATCH);
  assert.equal(calls[0],'?state=all&limit=6&after=cursor%20%26');
  assert.equal(result.cursor,'after-6');assert.equal(result.projects.length,6);assert.equal(result.rows.length,300);
});
test('per-project loss never leaks stale run rows and session loss clears the batch',async()=>{
  const denied={get:async path=>{if(path.startsWith('?'))return {projects:[{id:'allowed'},{id:'denied'}]};if(path.includes('denied'))throw Object.assign(new Error('private exception'),{status:403});return {runs:[{id:'known'}]};}};
  const result=await loadSessionBatch(denied);
  assert.deepEqual(result.rows.map(row=>row.run.id),['known']);assert.deepEqual(result.projects.map(project=>project.id),['allowed']);assert.equal(result.failures.length,1);assert(!JSON.stringify(result).includes('private exception'));
  await assert.rejects(loadSessionBatch({get:async path=>{if(path.startsWith('?'))return {projects:[{id:'member'}]};throw Object.assign(new Error('Session ended'),{status:401});}}),/Session ended/);
});
