import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fail} from '../lib/operational-projects-logic.js';
import {createBrowserRunComments,operationalBrowserRunCommentsMigration1125} from '../lib/operational-browser-run-comments.js';

function fixture({maxRunComments,maxInstallationComments,file=':memory:',existing=false}={}) {
  const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');
  const owner={id:randomUUID()},editor={id:randomUUID()},viewer={id:randomUUID()},outsider={id:randomUUID()},project=randomUUID(),otherProject=randomUUID(),runId=randomUUID(),otherRun=randomUUID(),attempt=randomUUID();
  if(!existing){db.exec(`CREATE TABLE ops_projects(id TEXT PRIMARY KEY);
    CREATE TABLE ops_selected_browser_runs(id TEXT PRIMARY KEY,project_id TEXT,attempt_id TEXT,fence INTEGER);
    CREATE TABLE events(actor_id TEXT,project_id TEXT,action TEXT,subject_id TEXT,metadata TEXT);`);
    operationalBrowserRunCommentsMigration1125(db);
    db.prepare('INSERT INTO ops_projects VALUES(?)').run(project);db.prepare('INSERT INTO ops_projects VALUES(?)').run(otherProject);
    db.prepare('INSERT INTO ops_selected_browser_runs VALUES(?,?,?,1)').run(runId,project,attempt);
    db.prepare('INSERT INTO ops_selected_browser_runs VALUES(?,?,?,1)').run(otherRun,otherProject,randomUUID());}
  let granted=true,eligible=true,archived=false,eventFailure=false;
  const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
  const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  const access=(actor,p,operation)=>{
    if(!eligible)fail(403,'Account unavailable');
    if(!granted||actor?.id===outsider.id||![project,otherProject].includes(p))fail(404,'Project not found');
    if(operation!=='read'&&actor.id===viewer.id)fail(403,'Insufficient permission');
    if(operation!=='read'&&archived)fail(409,'Project archived');
  };
  const service=createBrowserRunComments({one,all,run,tx,access,event:(actor,p,action,id,metadata)=>{
    if(eventFailure)throw Error('audit failure');run('INSERT INTO events VALUES(?,?,?,?,?)',actor.id,p,action,id,JSON.stringify(metadata));},
    now:()=>new Date().toISOString(),uuid:randomUUID},{...(maxRunComments?{maxRunComments}:{}),...(maxInstallationComments?{maxInstallationComments}: {})});
  return {db,service,owner,editor,viewer,outsider,project,otherProject,runId,otherRun,attempt,
    revoke(){granted=false;},ineligible(){eligible=false;},archive(){archived=true;},eventFail(){eventFailure=true;},close(){db.close();}};
}
const comment=(text='Human observation',extra={})=>({text,idempotency_key:randomUUID(),...extra});
const refused=(fn,status)=>assert.throws(fn,e=>e.status===status);

test('human comments preserve exact text/pins but never duplicate text in metadata or gain model/action authority',()=>{
  const f=fixture();try{
    const text='Observed <script>literal text</script>\nwith a correction to consider.';
    const result=f.service.append(f.owner,f.project,f.runId,comment(text));
    assert.equal(result.replayed,false);assert.equal(result.comment.text,text);assert.equal(result.comment.author_id,f.owner.id);
    assert.equal(result.comment.attempt_id,f.attempt);assert.equal(result.comment.observed_fence,1);
    assert.equal(result.comment.corrected_by,null);assert.equal(result.comment.supersedes_id,null);
    assert.deepEqual(f.service.list(f.viewer,f.project,f.runId).comments,[result.comment]);
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM events').all()).includes('literal text'));
    assert.equal(f.db.prepare('SELECT fence FROM ops_selected_browser_runs WHERE id=?').get(f.runId).fence,1);
    for(const extra of [{model_disclosure:true},{project_id:f.otherProject},{html:true},{artifacts:['secret']},{observed_fence:42}])
      refused(()=>f.service.append(f.owner,f.project,f.runId,comment(text,extra)),400);
  }finally{f.close();}
});

test('current project/account/member/archive checks apply to reads, appends and idempotent retries',()=>{
  const f=fixture();try{
    const v=comment(),created=f.service.append(f.owner,f.project,f.runId,v);
    refused(()=>f.service.append(f.viewer,f.project,f.runId,v),403);
    refused(()=>f.service.list(f.outsider,f.project,f.runId),404);
    refused(()=>f.service.list(f.owner,f.otherProject,f.runId),404);
    refused(()=>f.service.append({...f.owner,mcp:true},f.project,f.runId,v),403);
    refused(()=>f.service.append({...f.owner,human:false},f.project,f.runId,v),403);
    f.archive();refused(()=>f.service.append(f.owner,f.project,f.runId,v),409);
    assert.equal(f.service.list(f.owner,f.project,f.runId).comments[0].id,created.comment.id);
    f.revoke();refused(()=>f.service.list(f.owner,f.project,f.runId),404);
    refused(()=>f.service.append(f.owner,f.project,f.runId,v),404);
  }finally{f.close();}
  const f2=fixture();try{f2.ineligible();refused(()=>f2.service.list(f2.owner,f2.project,f2.runId),403);}finally{f2.close();}
});

test('corrections append immutable author-only causal chains and cannot branch or cross runs/projects',()=>{
  const f=fixture();try{
    const first=f.service.append(f.owner,f.project,f.runId,comment('Original')).comment;
    refused(()=>f.service.append(f.editor,f.project,f.runId,comment('Editor rewrite',{supersedes_id:first.id})),403);
    refused(()=>f.service.append(f.owner,f.otherProject,f.otherRun,comment('Wrong run',{supersedes_id:first.id})),404);
    const second=f.service.append(f.owner,f.project,f.runId,comment('Correction',{supersedes_id:first.id})).comment;
    refused(()=>f.service.append(f.owner,f.project,f.runId,comment('Branch',{supersedes_id:first.id})),409);
    f.db.prepare('UPDATE ops_selected_browser_runs SET fence=2 WHERE id=?').run(f.runId);
    const third=f.service.append(f.owner,f.project,f.runId,comment('Latest',{supersedes_id:second.id})).comment;
    assert.equal(third.observed_fence,2);
    const rows=f.service.list(f.viewer,f.project,f.runId).comments;
    assert.equal(rows[0].text,'Original');assert.equal(rows[0].corrected_by,second.id);
    assert.equal(rows[1].corrected_by,third.id);assert.equal(rows[2].supersedes_id,second.id);
    assert.throws(()=>f.db.prepare('UPDATE ops_browser_run_comments SET text=? WHERE id=?').run('Rewrite',first.id),/immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM ops_browser_run_comments WHERE id=?').run(first.id),/immutable/);
  }finally{f.close();}
});

test('idempotent admission and corrections return original records and audit failure rolls back all history',()=>{
  const f=fixture();try{
    const v=comment(),first=f.service.append(f.owner,f.project,f.runId,v);
    assert.equal(f.service.append(f.owner,f.project,f.runId,v).replayed,true);
    refused(()=>f.service.append(f.owner,f.project,f.runId,{...v,text:'Different'}),409);
    const correction=comment('Correction',{supersedes_id:first.comment.id}),second=f.service.append(f.owner,f.project,f.runId,correction);
    assert.equal(f.service.append(f.owner,f.project,f.runId,correction).comment.id,second.comment.id);
    assert.equal(f.db.prepare('SELECT count(*) n FROM events').get().n,2);
    f.eventFail();assert.throws(()=>f.service.append(f.owner,f.project,f.runId,comment('Rolled back')),/audit failure/);
    assert.equal(f.service.list(f.owner,f.project,f.runId).comments.length,2);
  }finally{f.close();}
});

test('finite comment text/capacity and monotonic pagination preserve history across concurrent additions',()=>{
  const f=fixture({maxRunComments:5,maxInstallationComments:6});try{
    for(const text of ['','  ','x'.repeat(4001),'😀'.repeat(1001),'\ud800','\0'])
      refused(()=>f.service.append(f.owner,f.project,f.runId,comment(text)),400);
    f.service.append(f.owner,f.project,f.runId,comment('😀'.repeat(1000)));
    for(let n=1;n<4;n++)f.service.append(f.owner,f.project,f.runId,comment(`Comment ${n}`));
    const first=f.service.list(f.owner,f.project,f.runId,{limit:2});assert.equal(first.comments.length,2);assert.equal(first.next_cursor,first.comments[1].sequence);
    f.service.append(f.owner,f.project,f.runId,comment('Added during pagination'));
    const second=f.service.list(f.owner,f.project,f.runId,{limit:2,after:first.next_cursor});
    const last=f.service.list(f.owner,f.project,f.runId,{limit:2,after:second.next_cursor});
    assert.equal(new Set([...first.comments,...second.comments,...last.comments].map(c=>c.id)).size,5);assert.equal(last.next_cursor,null);
    refused(()=>f.service.append(f.owner,f.project,f.runId,comment()),429);
    f.service.append(f.owner,f.otherProject,f.otherRun,comment());
    refused(()=>f.service.append(f.owner,f.otherProject,f.otherRun,comment()),429);
    refused(()=>f.service.list(f.owner,f.project,f.runId,{after:-1}),400);
    refused(()=>f.service.list(f.owner,f.project,f.runId,{limit:51}),400);
  }finally{f.close();}
});

test('durable restart reads verify content integrity and migration enforces run/correction scope',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-comments-')),file=path.join(root,'state.sqlite');
  const f=fixture({file});const saved=f.service.append(f.owner,f.project,f.runId,comment('Restart survives')).comment;
  try{
    f.db.close();const db=new DatabaseSync(file);
    const row=db.prepare('SELECT * FROM ops_browser_run_comments WHERE id=?').get(saved.id);assert.equal(row.text,saved.text);
    const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args);
    const service=createBrowserRunComments({one,all,access:()=>{},run:()=>{},tx:fn=>fn(),event:()=>{},now:()=>new Date().toISOString(),uuid:randomUUID});
    assert.equal(service.list(f.owner,f.project,f.runId).comments[0].sha256,saved.sha256);
    const values=[randomUUID(),f.otherProject,f.runId,f.attempt,1,f.owner.id,'Wrong project','a'.repeat(64),new Date().toISOString(),randomUUID(),'b'.repeat(64),null];
    assert.throws(()=>db.prepare('INSERT INTO ops_browser_run_comments(id,project_id,run_id,attempt_id,observed_fence,author_id,text,sha256,created_at,idempotency_key,payload_sha256,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...values),/scope mismatch/);
    db.exec('DROP TRIGGER ops_browser_run_comment_no_update');db.prepare('UPDATE ops_browser_run_comments SET text=? WHERE id=?').run('Corrupted',saved.id);
    refused(()=>service.list(f.owner,f.project,f.runId),409);db.close();
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
