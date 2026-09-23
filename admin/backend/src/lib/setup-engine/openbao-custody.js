import { localEdge } from './local-edge.js';
import { readOpenBao,custody,putCustody,secrets } from './openbao-store.js';
import { autoCustody,fail,namesFor,humanPolicyFor,humanRoleFor,priorHumanFor } from './openbao-logic.js';
import { createClient,status,ok } from './openbao-api.js';
import { bootstrap,applyHumanAccess,verifyMachine,fieldsMatch } from './openbao-access.js';
import { verifiedProvider } from './pomerium-store.js';
import { getJob } from './store.js';
// Automatic custody (basic managed install, custody 'auto'). Shares and the
// root token are read from their encrypted records only for the request that
// needs them; they are never logged, returned, or written to a job/plan.
export async function autoUnseal(db,r,api){if(!autoCustody(r))throw fail('Automatic unseal applies only to the managed automatic-custody install.');
  const s=await status(api);if(s.state==='unsealed')return s;
  // Same guard as the operator 'unseal' action: only an initialized Shamir-sealed instance.
  if(s.state!=='sealed'||s.seal!=='shamir')throw fail('Automatic unseal requires an initialized Shamir-sealed instance. Nothing was submitted.');
  const shares=custody(db,r,'unseal')?.shares;if(shares?.length!==2)throw fail('The protected automatic-unseal record is missing. Unseal manually with 2 shares from the recovery kit.');
  if(s.progress>0)ok(await api('/v1/sys/unseal',{method:'POST',body:{reset:true}}),'Unseal progress reset');
  for(const key of shares){const res=ok(await api('/v1/sys/unseal',{method:'POST',body:{key}}),'Automatic unseal');if(res?.sealed===false)break;}
  const after=await status(api);if(after.state!=='unsealed')throw fail('Automatic unseal did not complete. Check the recovery kit shares and the service; nothing was reset.');return after;}
// Automatic bootstrap with the initial root token held in the one-time kit
// record. bootstrap() revokes the token and verifies the revocation; ProxyPilot's
// copy is then deleted, so the kit keeps only the shares.
export async function autoBootstrap(db,r,api,{job,providerProbe,clientProbe}){
  const kit=custody(db,r,'kit');if(!kit?.root)return null;
  let k;try{k=verifiedProvider(db,r.config.connectionId);await providerProbe({mode:'connect',url:k.origin,realm:k.realm});}catch{throw fail('The saved Keycloak provider could not be verified.');}job.fence();await clientProbe(db,r);job.fence();
  const result=await bootstrap(db,r,{bootstrapToken:kit.root},api,{job,verifyDatabase(){throw fail('The basic profile configures no database.');}});
  const current=custody(db,r,'kit');if(current)putCustody(db,r,'kit',{...current,root:null,rootRevoked:true});return result;}
// The route admits only the restricted networks, so ProxyPilot's own requests to
// the public name are refused. Go through this host's Caddy first (restricted
// route + self-check header), then the public origin. Used by the sweep and the page.
export async function reachableStatus(db,r,{send}={}){
  let api=createClient(r.config.origin,{...(send?{send}:{}),edge:localEdge(db)}),health=await status(api);
  if(health.state==='unavailable'){api=createClient(r.config.origin,send?{send}:{});health=await status(api);}
  return {api,health};}
// Periodic sweep (index.js): unseal a sealed automatic-custody instance after a
// restart, but only once its recovery kit was acknowledged and no operation is pending.
export async function sweepOpenBaoAutoUnseal({db,send}={}){const r=readOpenBao(db);
  if(!autoCustody(r)||!r.handoff_ack)return {skipped:'not_applicable'};
  if(r.last_job_id&&['queued','running'].includes(getJob(db,r.last_job_id)?.status))return {skipped:'operation_pending'};
  const {api,health:s}=await reachableStatus(db,r,{send});
  if(s.state!=='sealed')return {skipped:s.state};
  const after=await autoUnseal(db,r,api);return {unsealed:after.state==='unsealed'};}

// A root token decoded from generate-root: base64(token XOR otp).
export function decodeRoot(encoded,otp){const a=Buffer.from(String(encoded),'base64'),b=Buffer.from(String(otp),'utf8');if(!a.length||a.length!==b.length)throw fail('OpenBao returned a root token that does not match its one-time pad. Nothing was changed.');return Buffer.from(a.map((x,i)=>x^b[i])).toString('utf8');}
// One owned change that needs root, without keeping root: generate a transient
// root token from the 2 automatic-custody shares ProxyPilot already holds (the
// same shares that unseal it), run fn, revoke the token and prove the revocation.
// Refuses to disturb a generation somebody else started.
export async function withTransientRoot(db,r,api,fn){if(!autoCustody(r))throw fail('ProxyPilot holds no recovery shares for this OpenBao (PGP custody). Generate a root token from 2 recovery shares and submit it with the bootstrap action.');
  const shares=custody(db,r,'unseal')?.shares;if(shares?.length!==2)throw fail('The protected automatic-unseal record is missing; ProxyPilot cannot generate a transient root token.');
  const current=ok(await api('/v1/sys/generate-root/attempt'),'Root generation status');
  if(current?.started)throw fail('A root-token generation is already in progress on OpenBao. ProxyPilot will not cancel it: finish it, or cancel it on the host (bao operator generate-root -cancel), then retry.');
  const start=ok(await api('/v1/sys/generate-root/attempt',{method:'PUT',body:{}}),'Root generation start');
  let done;
  try{if(!start?.nonce||!start?.otp)throw fail('OpenBao did not start a one-time-pad root generation. Nothing was changed.');
    for(const key of shares){done=ok(await api('/v1/sys/generate-root/update',{method:'PUT',body:{key,nonce:start.nonce}}),'Root generation');if(done?.complete)break;}
    if(!done?.complete||!(done.encoded_token||done.encoded_root_token))throw fail('Root generation did not complete with the stored shares. Nothing was changed.');
  }catch(e){await api('/v1/sys/generate-root/attempt',{method:'DELETE'}).catch(()=>{});throw e;}
  const token=decodeRoot(done.encoded_token||done.encoded_root_token,start.otp);let result,failure;
  try{result=await fn(token);}catch(e){failure=e;}
  const revoked=await api('/v1/auth/token/revoke-self',{method:'POST',token}).catch(()=>null);
  if(!revoked||![200,204].includes(revoked.status)||(await api('/v1/auth/token/lookup-self',{token})).status!==403)throw fail('The transient OpenBao root token could not be proved revoked. Revoke it on the host (bao token revoke -self) before retrying.');
  if(failure)throw failure;return result;}
// The live human side read with the machine identity (its policy may read both):
// 'current' | 'prior' (exactly ProxyPilot's earlier rendering) | 'drift'.
export async function humanAccessState(db,r,api){const n=namesFor(r),machine=await verifyMachine(r,secrets(db,r),api);let live;
  try{const pr=await api(`/v1/sys/policies/acl/${n.human}`,{token:machine}),rr=await api(`/v1/auth/${n.oidc}/role/mapped`,{token:machine});live={policy:pr.body?.data?.policy,role:rr.body?.data};}
  finally{await api('/v1/auth/token/revoke-self',{method:'POST',token:machine}).catch(()=>{});}
  const prior=priorHumanFor(r),policy=live.policy===humanPolicyFor(r)?'current':live.policy===prior.policy?'prior':'drift',role=fieldsMatch(live.role,humanRoleFor(r))?'current':fieldsMatch(live.role,prior.role)?'prior':'drift';
  return policy==='drift'||role==='drift'?'drift':policy==='current'&&role==='current'?'current':'prior';}
// Bring the human side (team workspace policy + 8 h role) up to the current
// rendering. Nothing privileged is generated unless the live values are exactly
// ProxyPilot's earlier rendering.
export async function upgradeHumanAccess(db,r,api){const now=await humanAccessState(db,r,api);
  if(now==='current')return {upgraded:false};
  if(now==='drift')throw fail('The OpenBao human policy or sign-in role differs from what ProxyPilot wrote. Nothing was overwritten; review it with its owner.');
  return await withTransientRoot(db,r,api,token=>applyHumanAccess(r,api,token));}
