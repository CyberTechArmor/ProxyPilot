import { Router } from 'express';
import { stageRefusal } from '../lib/setup-engine/full-platform-store.js';
import { getDb,logAudit } from '../db.js';
import { requireAdmin,requireSudo } from '../middleware/auth.js';
import { configSchema,applySchema,ackSchema,unsealSchema,bootstrapSchema,digest,namesFor } from '../lib/setup-engine/openbao-logic.js';
import { state,readOpenBao,review,save,apply,acknowledge,currentPlan } from '../lib/setup-engine/openbao-store.js';
import { createClient,status,requireReady } from '../lib/setup-engine/openbao-api.js';
import { operatorAction } from '../lib/setup-engine/openbao-operator.js';
import { reachableStatus } from '../lib/setup-engine/openbao-custody.js';
import { agentsState,createAgent,setCredential,removeCredential,rotateAgent,removeAgent } from '../lib/setup-engine/openbao-agents.js';
import { localProofRefusal,requestOrigin } from '../lib/sso/sessions.js';
export const openbaoRouter=Router();
// How a person signs in through the OpenBao web UI: the OIDC method is mounted at
// an owned path, not the UI's default "oidc", so a blank mount gives "Invalid role".
const signInFor=r=>{const n=namesFor(r);return {url:`${r.config.origin}/ui/`,method:'OIDC',mountPath:n.oidc,role:'mapped',group:r.config.group,tokenMinutes:r.config.basic?480:2,
  workspace:r.config.basic?{engine:`${n.prefix}-kv`,path:'team/'}:null,
  scope:r.config.basic?`Members of ${r.config.group} are OpenBao administrators: full access to every engine, policy and sign-in method. Shared secrets go under ${n.prefix}-kv → team/. Sessions last 8 hours.`:`Read-only proof access: ${n.database}/creds/reader and the owned auth/policy settings; the token lasts 2 minutes.`};};
openbaoRouter.use(requireAdmin,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
const respond=async(res,fn)=>{try{await fn();}catch(e){if(e?.name==='ZodError')return res.status(400).json({error:e.issues.map(i=>i.message).join(' ')});res.status(e.openbaoSafe?e.status:500).json({error:e.openbaoSafe?e.message:'OpenBao setup could not be completed. Credentials and upstream details withheld.'});}};
openbaoRouter.get('/',(_req,res)=>respond(res,async()=>{const db=getDb(),r=readOpenBao(db),s=state(db);let {api,health}=r?await reachableStatus(db,r):{health:{state:'not_configured'}},matches=true;try{if(r)currentPlan(db,r);}catch{matches=false;}
  if(r&&health.state==='unsealed'){try{await requireReady(api,r);}catch{health={...health,state:'unavailable'};}}
  const verified=matches&&health.state==='unsealed'&&health.version==='2.6.2'&&health.clusterId===r?.resources?.clusterId&&s?.lastVerification?.fingerprint===digest(r.config);
  res.json({state:s,review:review(db),health,signIn:r?signInFor(r):null,verification:verified?s.lastVerification:{state:'not_verified',label:matches?`Current state: ${health.state}. Reapply after restoring service.`:'Saved platform choices are skipped or changed.'}});}));
for(const [path,schema,handler,action] of [['/',configSchema,save,'OPENBAO_SETTINGS_SAVED'],['/handoff',ackSchema,acknowledge,'OPENBAO_HANDOFF_ACKNOWLEDGED']])openbaoRouter.put(path,requireSudo,(req,res)=>respond(res,async()=>{const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid reviewed OpenBao settings; unknown fields are refused.'});const s=handler(getDb(),parsed.data);logAudit(req.user.id,action,'setup_openbao','1',{revision:s.revision},req.ip);res.json({state:s,review:review(getDb())});}));
openbaoRouter.post('/apply',requireSudo,(req,res)=>respond(res,async()=>{{const why=stageRefusal(getDb(),'openbao');if(why)return res.status(409).json({code:'STAGE_LOCKED',error:why});}const parsed=applySchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Review the current saved OpenBao configuration.'});const result=apply(getDb(),parsed.data,req.user.id);logAudit(req.user.id,'OPENBAO_PLAN_APPLIED','setup_job',result.job.id,{created:result.created},req.ip);res.status(result.created?202:200).json(result);}));
for(const [action,schema] of [['unseal',unsealSchema],['bootstrap',bootstrapSchema]])openbaoRouter.post('/'+action,requireSudo,(req,res)=>respond(res,async()=>{
  const parsed=schema.safeParse(req.body);req.body={};if(!parsed.success)return res.status(400).json({error:'Invalid reviewed operator action. Submitted material was not recorded.'});
  const result=await operatorAction(getDb(),action,parsed.data,req.user.id);logAudit(req.user.id,'OPENBAO_OPERATOR_ACTION','setup_job',result.job.id,{action},req.ip);res.json(result);
}));
// Connect an agent (lib/setup-engine/openbao-agents.js). Reading the list is
// harmless; every change needs sudo and a fresh local sign-in, is audited
// without values, and has no MCP tool (credential values and secret IDs are
// secret input/output). A secret ID is returned once, in this response only.
const local=(req,res,what)=>{const refusal=localProofRefusal(getDb(),req.session.id,requestOrigin(req),what);if(refusal){res.status(refusal.status).json(refusal.body);return false;}return true;};
openbaoRouter.get('/agents',(_req,res)=>respond(res,async()=>res.json(agentsState(getDb()))));
openbaoRouter.post('/agents',requireSudo,(req,res)=>respond(res,async()=>{if(!local(req,res,'Registering an agent'))return;
  const out=await createAgent(getDb(),req.body,req.user);req.body={};logAudit(req.user.id,'OPENBAO_AGENT_CREATED','openbao_agent',out.agent.name,{cidrs:out.agent.cidrs},req.ip);res.status(201).json({...out,state:agentsState(getDb())});}));
openbaoRouter.put('/agents/:name/credentials/:key',requireSudo,(req,res)=>respond(res,async()=>{if(!local(req,res,'Entering an agent credential'))return;
  const agent=await setCredential(getDb(),req.params.name,req.params.key,req.body);req.body={};logAudit(req.user.id,'OPENBAO_AGENT_CREDENTIAL_SET','openbao_agent',agent.name,{key:req.params.key},req.ip);res.json({agent,state:agentsState(getDb())});}));
openbaoRouter.delete('/agents/:name/credentials/:key',requireSudo,(req,res)=>respond(res,async()=>{if(!local(req,res,'Removing an agent credential'))return;
  const agent=await removeCredential(getDb(),req.params.name,req.params.key);logAudit(req.user.id,'OPENBAO_AGENT_CREDENTIAL_REMOVED','openbao_agent',agent.name,{key:req.params.key},req.ip);res.json({agent,state:agentsState(getDb())});}));
openbaoRouter.post('/agents/:name/rotate',requireSudo,(req,res)=>respond(res,async()=>{if(!local(req,res,'Issuing a new agent secret ID'))return;
  const out=await rotateAgent(getDb(),req.params.name);logAudit(req.user.id,'OPENBAO_AGENT_ROTATED','openbao_agent',out.agent.name,{},req.ip);res.json({...out,state:agentsState(getDb())});}));
openbaoRouter.delete('/agents/:name',requireSudo,(req,res)=>respond(res,async()=>{if(!local(req,res,'Removing an agent'))return;
  const out=await removeAgent(getDb(),req.params.name);logAudit(req.user.id,'OPENBAO_AGENT_REMOVED','openbao_agent',out.removed,{},req.ip);res.json({...out,state:agentsState(getDb())});}));
