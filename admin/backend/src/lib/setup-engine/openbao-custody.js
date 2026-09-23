import { localEdge } from './local-edge.js';
import { readOpenBao,custody,putCustody } from './openbao-store.js';
import { autoCustody,fail } from './openbao-logic.js';
import { createClient,status,ok } from './openbao-api.js';
import { bootstrap } from './openbao-access.js';
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
