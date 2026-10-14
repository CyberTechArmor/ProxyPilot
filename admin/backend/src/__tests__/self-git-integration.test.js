import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSelfGitHandlers } from '../routes/mcp-tools/self-git.js';

test('identical-tree remote identity adoption uses exact checked commit, preserves rollback and requests only a pinned rebuild',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pp-self-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),remote=join(root,'remote.git'),live=join(root,'live'),candidate=join(root,'candidate'),stateFile=join(root,'state.json');
  const run=(...args)=>{const r=spawnSync('git',args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  run('init',source);run('-C',source,'config','user.name','test');run('-C',source,'config','user.email','test@example.test');
  await writeFile(join(source,'source.txt'),'one\n');run('-C',source,'add','.');run('-C',source,'commit','-m','base');run('clone','--bare',source,remote);run('clone',remote,live);
  run('-C',live,'config','user.name','test');run('-C',live,'config','user.email','test@example.test');
  await writeFile(join(source,'source.txt'),'two\n');run('-C',source,'commit','-am','reviewed remote');const target=run('-C',source,'rev-parse','HEAD');run('-C',source,'push',remote,'HEAD:refs/heads/master');
  await writeFile(join(live,'source.txt'),'two\n');run('-C',live,'commit','-am','bootstrap local');const base=run('-C',live,'rev-parse','HEAD');
  run('-C',live,'remote','set-url','origin','https://example.test/repo.git');run('clone',live,candidate);
  await writeFile(stateFile,JSON.stringify({candidate:{base_sha:base,head_sha:base},promotions:[],rollback_points:[]}));
  const requested=[];const kit={
    mutation:(name,opts,fn)=>args=>fn(args,{id:1,created_by:'owner'},null,{}),ok:x=>x,err:error=>({error}),dry:(args,plan)=>args.dry_run?{dry_run:true,plan}:null,
    confirmToken:(args)=>args.confirmation_token==='test-confirmation'?null:{needs_confirmation:true},
    policy:{self_edit:{candidate_dir:candidate,state_file:stateFile,candidate_branch:'pp-candidate',required_checks_for_promote:['backend-tests']}},
    ctx:{SELF_UPDATE_POLICY:{enabled:true},selfUpdateInstalled:async()=>({reachable:true,configured:true,source_dir:live}),selfUpdateStatus:async()=>({status:'idle'}),selfUpdateStart:async args=>{requested.push(args);return{id:'update1'};},
      runHostCapture:async(bin,args)=>{const r=spawnSync(bin,args.map(x=>x==='https://example.test/repo.git'?remote:x),{encoding:'utf8'});return{status:r.status,stdout:r.stdout,stderr:r.stderr};}},
  };
  const h=createSelfGitHandlers(kit);
  const prepared=await h.prepare_self_from_git({sha:target,expected_live_sha:base,confirm:true});
  assert.equal(prepared.same_tree_alignment,true);assert.equal(run('-C',live,'rev-parse','HEAD'),base);
  const args={sha:target,expected_live_sha:base,confirmation_token:'test-confirmation'};
  assert.match((await h.adopt_self_git_commit(args)).error,/Required checks/);
  const state=JSON.parse(await readFile(stateFile));state.checks={sha:target,ok:true,results:{'backend-tests':{ok:true}}};await writeFile(stateFile,JSON.stringify(state));
  const adopted=await h.adopt_self_git_commit(args);assert.equal(adopted.adopted,true);
  assert.equal(run('-C',live,'rev-parse','HEAD'),target);assert.equal(await readFile(join(live,'source.txt'),'utf8'),'two\n');assert.equal(run('-C',live,'status','--porcelain'),'');
  assert.deepEqual(requested,[{requestedBy:'mcp-self:owner',buildCurrentSha:target}]);
  assert.equal(run('-C',live,'rev-parse',adopted.rollback_tag),base);
});
