import { parseTokenScope } from '../../lib/mcp-ext/logic.js';

export function createApplicationReleaseHandlers(kit) {
  const { ctx, reader, mutation, ok, err, dry, confirmFlag, confirmToken } = kit;
  const service = async () => {
    if (!ctx.mock2Enabled()) throw new Error('Dev Studio is disabled; existing-application repository storage is unavailable');
    return ctx.applicationReleaseService || (await import('../../mock2/application-releases.js')).getApplicationReleaseService();
  };
  const appFor = async args => {
    const s = await service(), app = s.getApplication(args.application_id);
    if (app.targetId !== args.container) throw new Error('Application does not belong to the named container');
    return { s, app };
  };
  const next = (app, sha = null) => ({ application_id: app.id, container: app.targetId, ...(sha ? { sha } : {}), next_actions: [
    { tool: 'get_application', purpose: 'Read current profile, candidates, validation, publication and live evidence' },
    { tool: sha ? 'prepare_application_release' : 'checkpoint_application', purpose: sha ? 'Recheck this exact candidate' : 'Checkpoint the intended source commit' },
  ] });
  const write = (name, fn, flag = null) => mutation(name, { subjectType: 'application', ...(flag ? { flag } : {}) }, fn);
  const queue = (name, operation, disruptive = false) => write(name, async (args, auth, req, note) => {
    const { s, app } = await appFor(args); note.subject_id = app.id;
    const prepared = await (operation === 'deploy' ? s.prepareDeployment(app.id, { sha: args.sha }) : s.prepareCandidate(app.id, { sha: args.sha }));
    const plan = { ...next(app,args.sha), operation, profile_revision: prepared.profile.revision, profile_digest: prepared.profile.digest, modifies_live: ['deploy','rollback'].includes(operation) };
    const d = dry(args, plan); if (d) return d;
    const gate = disruptive ? confirmToken(args, auth, note, { tool: name, subject: `${app.id}:${args.sha}:${prepared.profile.digest}`, action: `${operation} application ${app.name}`, preview: plan }) : confirmFlag(args, note, `Queue ${operation} for ${app.name}.`);
    if (gate) return gate;
    const jobs = ctx.applicationReleaseJobs || await import('../../lib/setup-engine/backend.js');
    const db = ctx.applicationReleaseDb || ctx.getDb();
    const result = await jobs.submitApplicationReleaseJob(db, { applicationId: app.id, sha: args.sha, operation, requestedBy: `mcp:${auth.id}`, via: 'mcp', expectedProfileRevision: prepared.profile.revision, expectedProfileDigest: prepared.profile.digest, expectedTreeSha: prepared.candidate.treeSha });
    if (result.error) { note.refused = true; return err(result.error, { code: result.code }); }
    note.detail = { sha: args.sha, job_id: result.job?.id }; note.summary = `queued ${operation}`;
    return ok({ ...result, ...next(app,args.sha), next_actions: [{ tool: 'get_application_job', arguments: { container: app.targetId, application_id: app.id, job_id: result.job.id }, purpose: 'Poll durable completion and actual evidence' }] });
  }, operation === 'rollback' ? 'mcp.destructive' : null);
  const handlers = {
    list_applications: reader('list_applications', async (args, auth) => {
      const scope = parseTokenScope(auth.scope_json), apps = (await service()).listApplications();
      return ok({ applications: apps.filter(a => (!args.container || a.targetId === args.container) && (scope.lxc_containers === null || scope.lxc_containers.includes(a.targetId))) });
    }),
    get_application: reader('get_application', async args => { const { app } = await appFor(args); return ok({ application: app, ...next(app) }); }),
    inspect_application_source: reader('inspect_application_source',async args=>{const {s,app}=await appFor(args);return ok(await s.inspectSource(app.id,{sha:args.sha,path:args.path}));}),
    register_application: write('register_application', async (args, auth, req, note) => {
      if (!args.profile || args.profile.targetId !== args.container) return err('Profile targetId must match container');
      const d = dry(args, { container: args.container, profile: args.profile, installs_application: false }); if (d) return d;
      const gate = confirmFlag(args, note, 'Import existing application Git history without changing its live source.'); if (gate) return gate;
      const app = await (await service()).importApplication(args.profile); note.subject_id=app.id;note.summary='registered existing application';
      return ok({ application: app, ...next(app) });
    }),
    update_application_profile: write('update_application_profile',async(args,auth,req,note)=>{
      const {s,app}=await appFor(args);note.subject_id=app.id;
      if(args.profile?.targetId!==app.targetId)return err('Profile target cannot change');
      const d=dry(args,{...next(app),profile:args.profile,expected_revision:args.expected_revision});if(d)return d;
      const gate=confirmFlag(args,note,'Save a new immutable profile revision.');if(gate)return gate;
      const result=await s.updateProfile(app.id,args.profile,{expectedRevision:args.expected_revision});note.summary='updated application profile';return ok({application:result,...next(result)});
    }),
    checkpoint_application: write('checkpoint_application', async (args, auth, req, note) => {
      const { s, app } = await appFor(args);note.subject_id=app.id;
      const d=dry(args,{...next(app),ref:args.ref});if(d)return d;
      const gate=confirmFlag(args,note,'Import and preserve the selected guest commit.');if(gate)return gate;
      return ok({ ...await s.checkpoint(app.id,{ref:args.ref}),...next(app) });
    }),
    commit_application_changes: write('commit_application_changes', async (args,auth,req,note)=>{
      const {s,app}=await appFor(args);note.subject_id=app.id;
      const d=dry(args,{...next(app),parent_sha:args.parent_sha,branch:args.branch,message:args.message,patch_bytes:Buffer.byteLength(args.patch||'')});if(d)return d;
      const gate=confirmFlag(args,note,'Create a real source commit on the exact parent and branch.');if(gate)return gate;
      const result=await s.commitChanges(app.id,{parentSha:args.parent_sha,branch:args.branch,message:args.message,patch:args.patch});note.summary='committed application changes';return ok(result);
    }),
    prepare_application_release: reader('prepare_application_release',async args=>{const {s,app}=await appFor(args);const p=await s.prepareCandidate(app.id,{sha:args.sha});return ok({application_id:app.id,sha:p.candidate.sha,tree_sha:p.candidate.treeSha,profile_revision:p.profile.revision,profile_digest:p.profile.digest,...next(app,args.sha)});}),
    get_application_job: reader('get_application_job', async args=>{
      const {app}=await appFor(args);const jobs=ctx.applicationReleaseJobs||await import('../../lib/setup-engine/backend.js');const db=ctx.applicationReleaseDb||ctx.getDb();
      const detail=await jobs.jobDetail(db,args.job_id);
      if(!detail?.job || detail.job.plan?.params?.applicationId!==app.id)return err('Job not found for this application');
      const recovery=detail?.job?.status==='recovery_required' && detail.job.outcome==='application_recovery_required';
      return ok({...detail,next_actions: recovery ? [{tool:'rollback_application_release',arguments:{container:app.targetId,application_id:app.id,sha:detail.job.plan.params.sha},purpose:'Recover the recorded previous live target from this interrupted job; the original deployment will not be replayed.'}] : next(app).next_actions});
    }),
    reconcile_application_operation: write('reconcile_application_operation', async (args, auth, req, note) => {
      const {s,app}=await appFor(args);note.subject_id=app.id;
      const d=dry(args,{...next(app),token:args.token,operation:'reconcile stopped repository operation'});if(d)return d;
      const gate=confirmFlag(args,note,'Reconcile only the recorded stopped repository operation.');if(gate)return gate;
      return ok(await s.reconcileOperation(app.id,{token:args.token}));
    }),
    validate_application_release: queue('validate_application_release','validate'),
    deploy_application_release: queue('deploy_application_release','deploy',true),
    verify_application_release: queue('verify_application_release','verify'),
    rollback_application_release: queue('rollback_application_release','rollback',true),
  };
  for(const [name,method] of [['publish_application_release','publishCandidate'],['verify_application_remote','verifyRemote'],['merge_application_release','mergeCandidate']]) handlers[name]=write(name,async(args,auth,req,note)=>{
    const {s,app}=await appFor(args);note.subject_id=app.id;const d=dry(args,{...next(app,args.sha),operation:method,expected_remote_sha:args.expected_remote_sha});if(d)return d;
    const gate=confirmFlag(args,note,`${method} for the exact source commit.`);if(gate)return gate;
    const result=await s[method](app.id,{sha:args.sha,...(method==='mergeCandidate'?{expectedRemoteSha:args.expected_remote_sha}:{}),...(args.branch?{branch:args.branch}:{})});note.summary=method;return ok(result);
  });
  for(const name of ['get_git_remote','verify_git_remote']) handlers[name]=(name==='get_git_remote'?reader(name,async args=>readRemote(args,false)):mutation(name,{subjectType:'git_remote'},async(args,auth,req,note)=>{
    const d=dry(args,{kind:args.kind,target:args.target,operation:'independent remote readback'});if(d)return d;
    const gate=confirmFlag(args,note,'Read the configured remote branch.');if(gate)return gate;note.subject_id=`${args.kind}:${args.target}`;return readRemote(args,true);
  }));
  async function readRemote(args,verify){
    if(!ctx.mock2Enabled())return err('Dev Studio is disabled; Git remote storage is unavailable');
    if(!['lxc','static_site'].includes(args.kind))return err('Unsupported export kind');
    const m=ctx.applicationGitConnectors||await import('../../mock2/git-connectors.js');const row=m.getTargetRemote(args.kind,args.target);if(!row)return err('No directory-export remote is configured');
    const binding=m.shapeTargetRemote(row);if(!verify)return ok({mode:'directory_snapshot',binding,note:'This binding exports files; it does not preserve the native source repository or deploy it.'});
    const conn=m.getGitConnector(row.git_connector_id);if(!conn)return err('Configured Git connector is unavailable');
    const result=await m.applicationGitTransport.read({conn,gitDir:m.mirrorGitDirFor(args.kind,args.target),remoteRepo:row.remote_repo,branch:'main'});
    return ok({mode:'directory_snapshot',binding,remote:result,verified:result.ok===true&&!!row.last_pushed_commit&&result.sha===row.last_pushed_commit,expected_sha:row.last_pushed_commit||null,read_at:new Date().toISOString()});
  }
  return handlers;
}
