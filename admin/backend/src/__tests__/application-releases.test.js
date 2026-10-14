import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,writeFile,mkdir,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APPLICATION_RELEASE_SCHEMA,normalizeApplicationProfile } from '../mock2/application-profile.js';
import { createApplicationReleaseService } from '../mock2/application-releases.js';
import { processStart } from '../mock2/application-store.js';
import { createApplicationGit } from '../mock2/application-git.js';
const exec=promisify(execFile),proof='b'.repeat(64);
const git=async(cwd,...args)=>(await exec('git',['-C',cwd,...args])).stdout.trim();
const profile=source=>({name:'Fixture',targetId:'fixture',sourceDir:source,serviceName:'fixture.service',healthUrl:'http://127.0.0.1:3000/health',validationScripts:['test'],preservePaths:['/var/lib/fixture'],envFiles:['/etc/fixture.env'],connectorId:1,remoteRepo:'team/fixture',releaseRoot:'/var/lib/fixture-releases'});
function sqlite(file=':memory:') {
 const db=new DatabaseSync(file);db.exec(APPLICATION_RELEASE_SCHEMA);
 db.transaction=fn=>(...args)=>{db.exec('BEGIN IMMEDIATE');try{const v=fn(...args);db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};return db;
}
async function world(t,{secret=false}={}) {
 const root=await mkdtemp(join(tmpdir(),'pp-application-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source'),bin=join(root,'bin'),remote=join(root,'remote.git');await mkdir(source);await mkdir(bin);
 await exec('git',['init','-b','main',source]);await git(source,'config','user.name','Fixture');await git(source,'config','user.email','fixture@localhost');
 await writeFile(join(source,'package.json'),JSON.stringify({scripts:{test:'node --test',build:'true'}}));await writeFile(join(source,'hello.txt'),'one\n');
 if(secret)await writeFile(join(source,'.env'),'PASSWORD=private-value\n');
 await git(source,'add','.');await git(source,'commit','-m','initial');const first=await git(source,'rev-parse','HEAD');
 await writeFile(join(source,'hello.txt'),'two\n');await git(source,'commit','-am','second');const second=await git(source,'rev-parse','HEAD');
 await exec('git',['clone','--bare',source,remote]);
 await writeFile(join(bin,'incus'),'#!/bin/sh\n[ "$1" = exec ] || exit 50\nshift\n[ "$1" = pp-fixture ] || exit 51\nshift\n[ "$1" = -- ] || exit 52\nshift\nexec "$@"\n',{mode:0o755});
 // execFile has no input option: use an explicit stdin pipe, just as production.
 const hostPipe=(cmd,args,options={})=>new Promise(resolve=>{const child=execFile(cmd,args,{env:{...process.env,PATH:bin+':'+process.env.PATH},maxBuffer:16*1024*1024,timeout:options.timeoutMs},(error,stdout,stderr)=>resolve({code:error?.code||0,stdout,stderr}));if(options.input!=null)child.stdin.end(options.input);else child.stdin.end();});
 const transport={
  async read({branch}){try{const r=await exec('git',['ls-remote','--symref',remote,'HEAD','refs/heads/'+branch]);const rows=r.stdout.trim().split('\n');return {ok:true,sha:rows.find(l=>l.endsWith('\trefs/heads/'+branch))?.split('\t')[0]||null,defaultBranch:'main',defaultHeadSha:rows.find(l=>l.endsWith('\tHEAD')&&!l.startsWith('ref:'))?.split('\t')[0]};}catch{return {ok:false,error:'unavailable'};}},
  async push({gitDir,sha,branch}){try{await exec('git',['--git-dir='+gitDir,'push',remote,sha+':refs/heads/'+branch]);return {ok:true};}catch{return {ok:false,error:'push failed'};}},
  async promote(args){const current=await this.read(args);if(current.sha!==args.expectedRemoteSha)return {ok:false};if(args.expectedRemoteSha!==null){await exec('git',['--git-dir='+args.gitDir,'fetch',remote,'refs/heads/'+args.branch]);try{await exec('git',['--git-dir='+args.gitDir,'merge-base','--is-ancestor',args.expectedRemoteSha,args.sha]);}catch{return {ok:false};}}await exec('git',['--git-dir='+args.gitDir,'push','--force-with-lease=refs/heads/'+args.branch+':'+(args.expectedRemoteSha||''),remote,args.sha+':refs/heads/'+args.branch]);return {ok:true};},
 };
 const db=sqlite(join(root,'app.db'));t.after(()=>db.close());
 const service=createApplicationReleaseService({db,host:hostPipe,transport,getConnector:()=>({id:1}),repoRoot:join(root,'canonical')});
 return {root,source,remote,first,second,db,service,transport,bin};
}
function validate(service,app,candidate){return service.recordValidation(app.id,candidate.sha,{profileDigest:app.profile.digest,treeSha:candidate.treeSha,passed:true,evidenceDigest:proof,artifactDigest:proof,jobId:'validate-1',releasePath:'/releases/'+candidate.sha});}

test('profile accepts references only and rejects shell, traversal, URLs with credentials',()=>{
 const p=profile('/opt/fixture');assert.equal(normalizeApplicationProfile(p).remoteBranch,'main');
 for(const change of [{sourceDir:'/opt/../etc'},{healthUrl:'http://token@127.0.0.1/health'},{buildScript:'build;reboot'},{remoteRepo:'https://other/private'},{envFiles:['/']},{unknown:'value'}])assert.throws(()=>normalizeApplicationProfile({...p,...change}));
});
test('failed Git command diagnostics identify the primitive without exposing stderr secrets or paths',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pp-git-diagnostic-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'git'),'#!/bin/sh\nprintf "%s\\n" "fatal: cannot lock ref /private/path https://secret-token@example.test" >&2\nexit 128\n',{mode:0o755});
 const host=(cmd,args,options)=>new Promise(resolve=>{const p=execFile(cmd,args,{env:{...process.env,PATH:root+':'+process.env.PATH}},(e,stdout,stderr)=>resolve({code:e?.code||0,stdout,stderr}));p.stdin.end(options.input);});
 const adapter=createApplicationGit({host});
 await assert.rejects(adapter.inspect({repositoryPath:join(root,'repo.git'),profile:{sourceDir:'/source'},targetId:'fixture'},'a'.repeat(40)),e=>{
  assert.equal(e.message,'Git or guest read failed (host rev-parse, exit 128, ref_lock).');
  assert.deepEqual(e.diagnostic,{scope:'host',command:'rev-parse',exitCode:128,category:'ref_lock'});
  assert.equal(JSON.stringify(e).includes('secret-token'),false);assert.equal(JSON.stringify(e).includes('/private/path'),false);return true;
 });
});
test('imports real full history without flattening it and persists across SQLite reopen',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source));assert.equal(app.candidates[0].sha,w.second);
 assert.equal(await git(app.repositoryPath,'rev-list','--count',w.second),'2');assert.equal(await git(app.repositoryPath,'rev-parse',w.first),w.first);
 assert.equal(w.service.getApplication(app.id).profile.revision,1);assert.equal(app.live,null);
 const reopened=sqlite(join(w.root,'app.db'));t.after(()=>reopened.close());const again=createApplicationReleaseService({db:reopened});assert.equal(again.getApplication(app.id).candidates[0].sha,w.second);
});
test('checkpoint resolves newly committed guest branch to exact SHA without moving canonical main',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source));await writeFile(join(w.source,'hello.txt'),'three\n');await git(w.source,'commit','-am','third');
 const next=await git(w.source,'rev-parse','HEAD'),result=await w.service.checkpoint(app.id,{ref:'main'});assert.equal(result.candidate.sha,next);assert.equal(await git(app.repositoryPath,'rev-parse','main'),w.second);
});
test('checkpoint uses bundle HEAD when guest commits after the snapshot',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source));
 await writeFile(join(w.bin,'incus'),`#!/bin/sh\nshift\nshift\nshift\ncase "$*" in\n *"bundle create - --all"*)\n  "$@" || exit $?\n  printf 'racing\\n' > '${w.source}/hello.txt'\n  git -C '${w.source}' commit -am racing >&2\n  ;;\n *) exec "$@";;\nesac\n`,{mode:0o755});
 const result=await w.service.checkpoint(app.id,{ref:'main'});
 assert.equal(result.candidate.sha,w.second);
 assert.notEqual(await git(w.source,'rev-parse','HEAD'),w.second);
 assert.equal(await git(app.repositoryPath,'rev-parse','refs/guest/source-head'),w.second);
});
test('checkpoint does not launch automatic repository maintenance alongside its integrity checks',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source)),marker=join(w.root,'auto-gc-ran');
 await git(app.repositoryPath,'config','gc.autoPackLimit','1');await git(app.repositoryPath,'config','gc.auto','1');
 await writeFile(join(app.repositoryPath,'hooks/pre-auto-gc'),`#!/bin/sh\ntouch '${marker}'\nexit 1\n`,{mode:0o755});
 await writeFile(join(w.source,'hello.txt'),'new checkpoint\n');await git(w.source,'commit','-am','new checkpoint');
 await w.service.checkpoint(app.id,{ref:'main'});
 await assert.rejects(readFile(marker),{code:'ENOENT'});
});
test('source inspection reads the canonical candidate rather than a changed live guest and rejects traversal',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source));
 await writeFile(join(w.source,'hello.txt'),'different live bytes');
 assert.ok((await w.service.inspectSource(app.id,{sha:w.second})).paths.includes('hello.txt'));
 assert.equal((await w.service.inspectSource(app.id,{sha:w.second,path:'hello.txt'})).content,'two\n');
 await assert.rejects(w.service.inspectSource(app.id,{sha:w.second,path:'../outside'}),/relative/);
 await assert.rejects(w.service.inspectSource(app.id,{sha:'f'.repeat(40),path:'hello.txt'}),/Checkpoint/);
});
test('rejects dirty or secret-bearing history instead of publishing it',async t=>{
 const w=await world(t,{secret:true});await assert.rejects(w.service.importApplication(profile(w.source)),/Protected file/);
 const clean=await world(t);await writeFile(join(clean.source,'hello.txt'),'uncommitted');await assert.rejects(clean.service.importApplication(profile(clean.source)),/Tracked guest changes/);
});
test('typed diff commit retains parent, leaves guest untouched and refuses branch races',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source));
 const patch='diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-two\n+reviewed\n';
 const result=await w.service.commitChanges(app.id,{parentSha:w.second,branch:'work/change',message:'reviewed change',patch});
 assert.equal(await git(app.repositoryPath,'rev-parse',result.candidate.sha+'^'),w.second);assert.equal(await readFile(join(w.source,'hello.txt'),'utf8'),'two\n');
 await assert.rejects(w.service.commitChanges(app.id,{parentSha:w.second,branch:'work/change',message:'stale',patch}),/Branch moved/);
 await assert.rejects(w.service.commitChanges(app.id,{parentSha:w.second,branch:'main',message:'bad',patch}),/review branch/);
});
test('validation is source/profile bound; profile revisions invalidate old evidence',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source)),c=app.candidates[0];
 await assert.rejects(w.service.prepareDeployment(app.id,{sha:c.sha}),/Validate this exact/);validate(w.service,app,c);
 assert.equal((await w.service.prepareDeployment(app.id,{sha:c.sha})).candidate.validation.passed,true);
 assert.throws(()=>w.service.recordValidation(app.id,c.sha,{profileDigest:'wrong',treeSha:c.treeSha,passed:true,evidenceDigest:proof,jobId:'1'}),/Profile changed/);
 await w.service.updateProfile(app.id,{...profile(w.source),buildScript:'build'},{expectedRevision:1});assert.equal(w.service.getApplication(app.id).profile.revision,2);
 await assert.rejects(w.service.prepareDeployment(app.id,{sha:c.sha}),/Checkpoint/);
 await assert.rejects(w.service.updateProfile(app.id,profile(w.source),{expectedRevision:1}),/Profile changed/);
});
test('main merge requires live proof, expected remote SHA, fast-forward ancestry and real readback',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source));
 const patch='diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-two\n+release\n';
 const {candidate:c}=await w.service.commitChanges(app.id,{parentSha:w.second,branch:'work/release',message:'release',patch});validate(w.service,app,c);
 await assert.rejects(w.service.publishCandidate(app.id,{sha:c.sha}),/verified deployment merge/);
 await assert.rejects(w.service.mergeCandidate(app.id,{sha:c.sha,expectedRemoteSha:w.second}),/Verify this exact/);
 w.service.recordLive(app.id,{sha:c.sha,profileDigest:app.profile.digest,jobId:'deploy-1',releasePath:'/releases/'+c.sha,evidenceDigest:proof,previousSha:w.second});
 await assert.rejects(w.service.mergeCandidate(app.id,{sha:c.sha,expectedRemoteSha:w.first}),/Remote main changed/);
 const result=await w.service.mergeCandidate(app.id,{sha:c.sha,expectedRemoteSha:w.second});assert.equal(result.ok,true);assert.equal(result.defaultBranch,'main');assert.equal(await git(w.remote,'rev-parse','main'),c.sha);assert.equal(await git(app.repositoryPath,'rev-parse','main'),c.sha);
});
test('review branch publication and remote verification remain separate from live state',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source)),c=app.candidates[0];validate(w.service,app,c);
 const published=await w.service.publishCandidate(app.id,{sha:c.sha,branch:'review/one'});assert.equal(published.ok,true);assert.equal(published.application.live,null);
 w.transport.read=async()=>({ok:false,error:'unavailable'});const again=await w.service.verifyRemote(app.id,{sha:c.sha,branch:'review/one'});assert.equal(again.ok,false);assert.equal(again.verifiedAt,null);
});
test('durable operation lock prevents concurrent work and only dead owner reconciliation releases it',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source));
 w.db.prepare('INSERT INTO mock2_application_operations VALUES(?,?,?,?,?,?)').run(app.id,'token','checkpoint','2026-01-01',process.pid,processStart(process.pid));
 await assert.rejects(w.service.checkpoint(app.id,{ref:'main'}),/previous application operation/);await assert.rejects(w.service.reconcileOperation(app.id,{token:'token'}),/still alive/);
 w.db.prepare('UPDATE mock2_application_operations SET owner_start=?').run('previous-boot:previous-pid1');assert.equal((await w.service.reconcileOperation(app.id,{token:'token'})).operation,null);
});
test('detached source HEAD and custom refs survive full-history import',async t=>{
 const w=await world(t);await git(w.source,'update-ref','refs/notes/review',w.first);await git(w.source,'checkout','--detach',w.first);
 const app=await w.service.importApplication(profile(w.source));assert.equal(app.candidates[0].sha,w.first);assert.equal(await git(app.repositoryPath,'rev-parse','refs/guest/notes/review'),w.first);
});
test('failed revalidation clears passed evidence; rollback to a prior untracked SHA is truthfully separate',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source)),c=app.candidates[0];validate(w.service,app,c);
 w.service.recordValidation(app.id,c.sha,{profileDigest:app.profile.digest,treeSha:c.treeSha,passed:false,evidenceDigest:proof,jobId:'failed-validation'});
 await assert.rejects(w.service.prepareDeployment(app.id,{sha:c.sha}),/Validate this exact/);
 const restored=w.service.recordLive(app.id,{sha:w.first,profileDigest:app.profile.digest,jobId:'restore',releasePath:'/previous',evidenceDigest:proof,restored:true});
 assert.equal(restored.live.sha,w.first);assert.equal(restored.candidates.find(x=>x.sha===w.first),undefined);
});
test('explicit absent remote branch can be initialized only after live validation and exact readback',async t=>{
 const w=await world(t),app=await w.service.importApplication(profile(w.source)),c=app.candidates[0];await git(w.remote,'update-ref','-d','refs/heads/main');
 validate(w.service,app,c);w.service.recordLive(app.id,{sha:c.sha,profileDigest:app.profile.digest,jobId:'deploy',releasePath:'/release',evidenceDigest:proof});
 await assert.rejects(w.service.mergeCandidate(app.id,{sha:c.sha}),/explicit null/);
 const result=await w.service.mergeCandidate(app.id,{sha:c.sha,expectedRemoteSha:null});assert.equal(result.ok,true);assert.equal(await git(w.remote,'rev-parse','main'),c.sha);
});
