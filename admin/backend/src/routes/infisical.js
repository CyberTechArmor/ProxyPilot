import { Router } from 'express';
import { stageRefusal } from '../lib/setup-engine/full-platform-store.js';
import { getDb,logAudit } from '../db.js';
import { requireAdmin,requireSudo } from '../middleware/auth.js';
import { infisicalConfigSchema,infisicalIdentitiesSchema,infisicalApplySchema } from '../lib/setup-engine/infisical-logic.js';
import { infisicalState,reviewInfisical,saveInfisical,saveInfisicalIdentities,applyInfisical } from '../lib/setup-engine/infisical-store.js';
export const infisicalRouter=Router();
infisicalRouter.use(requireAdmin,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
const respond=(res,fn)=>{try{return fn();}catch(e){return res.status(e.infisicalSafe?e.status:500).json({error:e.infisicalSafe?e.message:'Infisical setup could not be completed. Upstream and credential details are withheld.'});}};
infisicalRouter.get('/',(_req,res)=>respond(res,()=>res.json({state:infisicalState(getDb()),review:reviewInfisical(getDb())})));
for(const [path,schema,handler,action] of [['/',infisicalConfigSchema,saveInfisical,'INFISICAL_SETTINGS_SAVED'],['/identities',infisicalIdentitiesSchema,saveInfisicalIdentities,'INFISICAL_IDENTITIES_SAVED']]){
  infisicalRouter.put(path,requireSudo,(req,res)=>{const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid reviewed Infisical settings. Check required fields and remove unsupported fields.'});
    return respond(res,()=>{const state=handler(getDb(),parsed.data);logAudit(req.user.id,action,'setup_infisical','1',{revision:state.revision},req.ip);res.json({state,review:reviewInfisical(getDb())});});});
}
infisicalRouter.post('/apply',requireSudo,(req,res)=>{{const why=stageRefusal(getDb(),'infisical');if(why)return res.status(409).json({code:'STAGE_LOCKED',error:why});}const parsed=infisicalApplySchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Review the current saved configuration before applying.'});
  return respond(res,()=>{const result=applyInfisical(getDb(),parsed.data,req.user.id);logAudit(req.user.id,'INFISICAL_PLAN_APPLIED','setup_job',result.job.id,{revision:parsed.data.revision,created:result.created},req.ip);res.status(result.created?202:200).json(result);});});
// Per-agent Infisical projects (lib/setup-engine/infisical-agents.js). Changes
// are made as the Infisical administrator: the password comes from OpenBao
// when kept there, or is typed for that one request (never stored or logged).
// Sudo and a fresh local sign-in, audited without values, no MCP tool.
import { localProofRefusal,requestOrigin } from '../lib/sso/sessions.js';
import { infisicalAgentsState,createAgent,setCredential,removeCredential,rotateAgent,removeAgent } from '../lib/setup-engine/infisical-agents.js';
const agentLocal=(req,res,what)=>{const refusal=localProofRefusal(getDb(),req.session.id,requestOrigin(req),what);if(refusal){res.status(refusal.status).json(refusal.body);return false;}return true;};
const agentRespond=async(res,fn)=>{try{await fn();}catch(e){if(e?.name==='ZodError')return res.status(400).json({error:e.issues.map(i=>i.message).join(' ')});res.status(e.infisicalSafe?e.status:e.openbaoSafe?e.status:500).json({error:e.infisicalSafe||e.openbaoSafe?e.message:'The Infisical agent change could not be completed. Upstream and credential details are withheld.'});}};
infisicalRouter.get('/agents',(_req,res)=>agentRespond(res,async()=>res.json(infisicalAgentsState(getDb()))));
infisicalRouter.post('/agents',requireSudo,(req,res)=>agentRespond(res,async()=>{if(!agentLocal(req,res,'Registering an agent'))return;
  const body=req.body;req.body={};const out=await createAgent(getDb(),body,req.user);logAudit(req.user.id,'INFISICAL_AGENT_CREATED','infisical_agent',out.agent.name,{projectId:out.agent.projectId},req.ip);res.status(201).json({...out,state:infisicalAgentsState(getDb())});}));
infisicalRouter.put('/agents/:name/credentials/:key',requireSudo,(req,res)=>agentRespond(res,async()=>{if(!agentLocal(req,res,'Entering an agent credential'))return;
  const body=req.body;req.body={};const agent=await setCredential(getDb(),req.params.name,req.params.key,body);logAudit(req.user.id,'INFISICAL_AGENT_CREDENTIAL_SET','infisical_agent',agent.name,{key:req.params.key,hostPattern:body.hostPattern},req.ip);res.json({agent,state:infisicalAgentsState(getDb())});}));
infisicalRouter.post('/agents/:name/credentials/:key/remove',requireSudo,(req,res)=>agentRespond(res,async()=>{if(!agentLocal(req,res,'Removing an agent credential'))return;
  const body=req.body||{};req.body={};const agent=await removeCredential(getDb(),req.params.name,req.params.key,body);logAudit(req.user.id,'INFISICAL_AGENT_CREDENTIAL_REMOVED','infisical_agent',agent.name,{key:req.params.key},req.ip);res.json({agent,state:infisicalAgentsState(getDb())});}));
infisicalRouter.post('/agents/:name/rotate',requireSudo,(req,res)=>agentRespond(res,async()=>{if(!agentLocal(req,res,'Issuing a new agent client secret'))return;
  const body=req.body||{};req.body={};const out=await rotateAgent(getDb(),req.params.name,body);logAudit(req.user.id,'INFISICAL_AGENT_ROTATED','infisical_agent',out.agent.name,{},req.ip);res.json({...out,state:infisicalAgentsState(getDb())});}));
infisicalRouter.post('/agents/:name/remove',requireSudo,(req,res)=>agentRespond(res,async()=>{if(!agentLocal(req,res,'Removing an agent'))return;
  const body=req.body||{};req.body={};const out=await removeAgent(getDb(),req.params.name,body);logAudit(req.user.id,'INFISICAL_AGENT_REMOVED','infisical_agent',out.removed,{},req.ip);res.json({...out,state:infisicalAgentsState(getDb())});}));
