import { createApplicationStore,processStart } from './application-store.js';
import { createApplicationGit } from './application-git.js';
import { failApplicationRelease,fullSha,normalizeApplicationProfile,validateCandidateRef } from './application-profile.js';

const stamp = () => new Date().toISOString();
const proofDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** No database, transport or runner singleton is imported on the disabled path. */
export function createApplicationReleaseService({db,host,transport,getConnector,git:injectedGit,repoRoot='/var/lib/proxypilot/application-repositories'}) {
  const store=createApplicationStore(db),git=injectedGit||createApplicationGit({host});
  const getApplication=id=>store.get(id);
  async function locked(id,kind,fn) {const token=store.acquire(id,kind);try{return await fn();}finally{store.release(id,token);}}
  function currentCandidate(id,sha,expected={}) {
    if(!fullSha(sha)) failApplicationRelease('INVALID_SHA','An exact 40-character commit SHA is required.',400);
    const app=store.get(id),candidate=store.candidate(id,sha);
    if(!candidate) failApplicationRelease('CANDIDATE_NOT_FOUND','Checkpoint this commit for the current profile first.',404);
    if(expected.profileRevision!==undefined&&expected.profileRevision!==app.profile.revision||expected.profileDigest!==undefined&&expected.profileDigest!==app.profile.digest) failApplicationRelease('STALE_PROFILE','Profile changed after this operation was prepared.');
    if(candidate.profileDigest!==app.profile.digest||candidate.profileRevision!==app.profile.revision) failApplicationRelease('STALE_CANDIDATE','Candidate evidence belongs to another profile revision.');
    return {app,candidate};
  }
  async function checkedCandidate(id,input,requireValidation=false) {
    const {app,candidate}=currentCandidate(id,input.sha,input);
    if(!candidate.hygiene?.passed) failApplicationRelease('HYGIENE_REQUIRED','Complete history hygiene inspection is required.');
    const actual=await git.inspect(app,input.sha);
    if(actual.sha!==candidate.sha||actual.treeSha!==candidate.treeSha||actual.hygiene.digest!==candidate.hygiene.digest) failApplicationRelease('SOURCE_CHANGED','Repository or history evidence changed. Checkpoint again.');
    if(requireValidation&&(!candidate.validation?.passed||!proofDigest(candidate.validation.artifactDigest)||candidate.validation.profileDigest!==app.profile.digest||candidate.validation.treeSha!==candidate.treeSha)) failApplicationRelease('VALIDATION_REQUIRED','Validate this exact candidate and profile before publishing or deploying.');
    // Profile can change during asynchronous host reads.
    currentCandidate(id,input.sha,{profileDigest:app.profile.digest});
    return {applicationId:app.id,appId:app.id,profile:app.profile,candidate,gitDir:app.repositoryPath};
  }
  function recordValidation(id,sha,evidence) {
    const {app,candidate}=currentCandidate(id,sha,{profileDigest:evidence.profileDigest});
    if(evidence.treeSha!==candidate.treeSha||typeof evidence.passed!=='boolean'||!proofDigest(evidence.evidenceDigest)||!String(evidence.jobId||'')) failApplicationRelease('INVALID_EVIDENCE','Validation needs exact source/profile identity and a durable job receipt.',400);
    if(evidence.passed&&(!proofDigest(evidence.artifactDigest)||typeof evidence.releasePath!=='string'||!evidence.releasePath.startsWith('/'))) failApplicationRelease('INVALID_EVIDENCE','Passed validation requires the sealed artifact digest and release path.',400);
    return store.record(id,sha,'validation',{passed:evidence.passed,profileDigest:app.profile.digest,treeSha:candidate.treeSha,evidenceDigest:evidence.evidenceDigest,artifactDigest:evidence.artifactDigest||null,jobId:String(evidence.jobId),releasePath:evidence.releasePath||null,validatedAt:stamp()},app.profile.digest);
  }
  function recordLive(id,evidence) {
    const app=store.get(id),candidate=store.candidate(id,evidence.sha);
    if(app.profile.digest!==evidence.profileDigest)failApplicationRelease('STALE_PROFILE','Profile changed.');
    if(!fullSha(evidence.sha)||(!candidate?.validation?.passed&&!evidence.restored)||!proofDigest(evidence.evidenceDigest)||!String(evidence.jobId||'')||typeof evidence.releasePath!=='string') failApplicationRelease('INVALID_EVIDENCE','Live state requires a passed candidate or verified restoration and a durable job receipt.',400);
    if(evidence.previousSha&&!fullSha(evidence.previousSha)) failApplicationRelease('INVALID_EVIDENCE','Invalid previous commit identity.',400);
    if(evidence.rollbackOf&&!fullSha(evidence.rollbackOf)) failApplicationRelease('INVALID_EVIDENCE','Invalid rolled-back commit identity.',400);
    // rollbackOf: the release this one replaced by rolling back (the deploy
    // history never counts that release as the one live before).
    // rolledBackFrom: every rollback so far, carried forward from live record
    // to live record (a candidate row's own live record is overwritten, so
    // this list is the append-only history; the newest 50 are kept).
    const at=stamp();
    const carried=(Array.isArray(app.live?.rolledBackFrom)?app.live.rolledBackFrom:[]).filter(x=>x&&fullSha(x.sha)&&typeof x.at==='string'&&Number.isFinite(Date.parse(x.at)));
    const rolledBackFrom=[...carried,...(evidence.rollbackOf?[{sha:evidence.rollbackOf,at}]:[])].slice(-50);
    const record={sha:evidence.sha,profileDigest:app.profile.digest,jobId:String(evidence.jobId),releasePath:evidence.releasePath,previousSha:evidence.previousSha||null,evidenceDigest:evidence.evidenceDigest,verifiedAt:at,restored:!!evidence.restored,...(evidence.rollbackOf?{rollbackOf:evidence.rollbackOf}:{}),...(rolledBackFrom.length?{rolledBackFrom}:{})};
    if(candidate)store.record(id,evidence.sha,'live',record,app.profile.digest);
    return store.recordObservedLive(id,record,app.profile.digest);
  }
  async function connectorFor(profile) {
    const conn=await getConnector(profile.connectorId);
    if(!conn) failApplicationRelease('CONNECTOR_MISSING','The selected existing Git connector is unavailable.',404);
    return conn;
  }
  async function remoteRead(id,{sha,branch},pushResult=null) {
    const {app,candidate}=currentCandidate(id,sha),p=app.profile;
    const selected=validateCandidateRef(branch||p.remoteBranch);
    let remote;
    try{remote=await transport.read({conn:await connectorFor(p),gitDir:app.repositoryPath,remoteRepo:p.remoteRepo,branch:selected});}
    catch {remote={ok:false,error:'Remote readback failed.'};}
    currentCandidate(id,sha,{profileDigest:p.digest});
    const verified=remote.ok===true&&remote.sha===sha;
    const old=candidate.publication||{};
    const result={branch:selected,pushAt:pushResult?.ok?stamp():old.pushAt||null,pushSucceeded:pushResult?pushResult.ok:old.pushSucceeded??null,verifiedAt:verified?stamp():null,remoteSha:fullSha(remote.sha)?remote.sha:null,defaultBranch:remote.defaultBranch||null,defaultHeadSha:fullSha(remote.defaultHeadSha)?remote.defaultHeadSha:null,error:verified?null:(remote.error||'Remote branch does not match the selected commit.'),profileDigest:p.digest};
    store.record(id,sha,'publication',result,p.digest);
    return {ok:verified,...result,application:store.get(id)};
  }
  return {
    listApplications:()=>store.list(),getApplication,
    listCandidates:id=>store.candidates(id),getCandidate:(id,sha)=>currentCandidate(id,sha).candidate,
    async inspectSource(id,{sha,path}={}) {
      const {app}=currentCandidate(id,sha);
      if(path!==undefined&&(typeof path!=='string'||path.length>500||!path||path.startsWith('/')||path.split('/').some(x=>!x||x==='.'||x==='..'||x==='.git')||/[\x00-\x1f]/.test(path)))failApplicationRelease('INVALID_SOURCE_PATH','Use a repository-relative source file path.',400);
      return git.source(app,sha,path);
    },
    async importApplication(raw) {
      const p=normalizeApplicationProfile(raw);await connectorFor(p);
      const app=store.create(p,repoRoot);
      return locked(app.id,'import',async()=>{const c=await git.import(app);if(!fullSha(c.sha)||!fullSha(c.treeSha)||!c.hygiene?.passed)failApplicationRelease('IMPORT_INCOMPLETE','Import did not return complete source evidence.');store.saveCandidate(app.id,app.profile,c);store.imported(app.id);return store.get(app.id);});
    },
    async updateProfile(id,raw,{expectedRevision}={}) {const p=normalizeApplicationProfile(raw);await connectorFor(p);if(!Number.isInteger(expectedRevision))failApplicationRelease('REVISION_REQUIRED','Current profile revision is required.',400);return store.update(id,p,expectedRevision);},
    async checkpoint(id,{ref}={}) {
      validateCandidateRef(ref);
      return locked(id,'checkpoint',async()=>{const app=store.get(id),c=await git.checkpoint(app,ref);if(!fullSha(c.sha)||!fullSha(c.treeSha)||!c.hygiene?.passed)failApplicationRelease('CHECKPOINT_INCOMPLETE','Source checkpoint was not fully inspected.');if(store.get(id).profile.digest!==app.profile.digest)failApplicationRelease('STALE_PROFILE','Profile changed during checkpoint.');store.saveCandidate(id,app.profile,c);store.imported(id);return {application:store.get(id),candidate:store.candidate(id,c.sha)};});
    },
    async commitChanges(id,{parentSha,branch,message,patch}={}) {
      if(!fullSha(parentSha))failApplicationRelease('INVALID_SHA','Exact parent SHA is required.',400);validateCandidateRef(branch);
      if(typeof message!=='string'||!message.trim()||message.length>1000||typeof patch!=='string'||!patch.trim()||Buffer.byteLength(patch)>1048576)failApplicationRelease('INVALID_PATCH','A commit message and a unified diff of at most 1 MiB are required.',400);
      return locked(id,'commit',async()=>{const app=store.get(id);if(branch===app.profile.remoteBranch)failApplicationRelease('REVIEW_BRANCH_REQUIRED','Commit changes on a review branch, then validate and deploy before merging.');await checkedCandidate(id,{sha:parentSha});const c=await git.commit(app,{parentSha,branch,message:message.trim(),patch});store.saveCandidate(id,app.profile,c);return {application:store.get(id),candidate:store.candidate(id,c.sha)};});
    },
    prepareCandidate:(id,input)=>checkedCandidate(id,input),
    async prepareDeployment(id,input) {const result=await checkedCandidate(id,input,true);if(!result.profile.releaseRoot)failApplicationRelease('RELEASE_LAYOUT_REQUIRED','Configure and verify an existing symlink release layout before deploying.');return result;},
    recordValidation,recordLive,
    getRollback:id=>{const app=store.get(id);return app.live?.previousSha?{sha:app.live.previousSha,current:app.live}:null;},
    async reconcileOperation(id,{token}={}) {const app=store.get(id),op=app.operation;if(!op||op.token!==token)failApplicationRelease('STALE_OPERATION','Operation changed; reload status.');if(processStart(op.ownerPid)===op.ownerStart)failApplicationRelease('APPLICATION_BUSY','The process that owns this operation is still alive.');const hostState=await git.probe(app);if(hostState.idle!==true)failApplicationRelease('APPLICATION_BUSY','A host repository operation is still running.');store.release(id,token);return store.get(id);},
    async publishCandidate(id,{sha,branch}={}) {
      return locked(id,'publish',async()=>{const prepared=await checkedCandidate(id,{sha},true),p=prepared.profile;
        const selected=validateCandidateRef(branch||p.remoteBranch);if(selected===p.remoteBranch)failApplicationRelease('MERGE_REQUIRED','Use the verified deployment merge action for the configured main branch.');
        let result;try{result=await transport.push({conn:await connectorFor(p),gitDir:prepared.gitDir,remoteRepo:p.remoteRepo,sha,branch:selected});}catch{result={ok:false,error:'Git push failed.'};}
        // Always read back. A timed-out push may have landed; exit zero alone is not proof.
        return remoteRead(id,{sha,branch:selected},result);
      });
    },
    async mergeCandidate(id,{sha,expectedRemoteSha}={}) {
      if(expectedRemoteSha!==null&&!fullSha(expectedRemoteSha))failApplicationRelease('REMOTE_SHA_REQUIRED','Exact observed remote SHA, or explicit null for a verified absent branch, is required.',400);
      return locked(id,'merge',async()=>{const prepared=await checkedCandidate(id,{sha},true),app=store.get(id),p=prepared.profile;
        if(app.live?.sha!==sha||app.live?.profileDigest!==p.digest)failApplicationRelease('LIVE_VERIFICATION_REQUIRED','Verify this exact candidate live before merging main.');
        const conn=await connectorFor(p),remote=await transport.read({conn,gitDir:prepared.gitDir,remoteRepo:p.remoteRepo,branch:p.remoteBranch});
        if(!remote.ok||remote.sha!==expectedRemoteSha)failApplicationRelease('REMOTE_CHANGED','Remote main changed; read it again before merging.');
        if(typeof transport.promote!=='function')failApplicationRelease('MERGE_UNAVAILABLE','The configured Git transport cannot perform a verified fast-forward merge.');
        const result=await transport.promote({conn,gitDir:prepared.gitDir,remoteRepo:p.remoteRepo,sha,branch:p.remoteBranch,expectedRemoteSha});
        const verified=await remoteRead(id,{sha,branch:p.remoteBranch},result);
        if(verified.ok)await git.advance(app,{sha,branch:p.remoteBranch});
        return verified;
      });
    },
    verifyRemote:(id,input)=>locked(id,'remote-readback',()=>remoteRead(id,input)),
  };
}

let singleton;
const hostSingletons=new Map();
export async function getApplicationReleaseService(options={}) {
  if(options.dbPath) {
    if(!hostSingletons.has(options.dbPath)) hostSingletons.set(options.dbPath,(async()=>{const {default:Database}=await import('better-sqlite3');const db=new Database(options.dbPath,{fileMustExist:true});db.pragma('busy_timeout = 5000');return getApplicationReleaseService({...options,db,dbPath:undefined});})());
    return hostSingletons.get(options.dbPath);
  }
  // The independent host runner already resolves its real DB path. It must
  // pass the sibling mock2 DB rather than inherit a backend-container path.
  if(options.db) {
    const [host,connectors]=await Promise.all([import('./host.js'),import('./git-connectors.js')]);
    return createApplicationReleaseService({db:options.db,host:options.host||host.runHost,getConnector:id=>options.db.prepare('SELECT * FROM mock2_git_connectors WHERE id=?').get(id),transport:options.transport||connectors.applicationGitTransport,...(options.repoRoot?{repoRoot:options.repoRoot}:{})});
  }
  if(!singleton) singleton=Promise.all([import('./db.js'),import('./host.js'),import('./git-connectors.js')]).then(([db,host,connectors])=>createApplicationReleaseService({db:db.getMock2Db(),host:host.runHost,getConnector:connectors.getGitConnector,transport:connectors.applicationGitTransport}));
  return singleton;
}
