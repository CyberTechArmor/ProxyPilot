import { Router } from 'express';
import { stageRefusal } from '../lib/setup-engine/full-platform-store.js';
import { getDb,logAudit } from '../db.js';
import { requireAdmin,requireSudo } from '../middleware/auth.js';
import { configSchema,applySchema,ackSchema,unsealSchema,bootstrapSchema,digest } from '../lib/setup-engine/openbao-logic.js';
import { state,readOpenBao,review,save,apply,acknowledge,currentPlan } from '../lib/setup-engine/openbao-store.js';
import { createClient,status,requireReady } from '../lib/setup-engine/openbao-api.js';
import { operatorAction } from '../lib/setup-engine/openbao-operator.js';
export const openbaoRouter=Router();
openbaoRouter.use(requireAdmin,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
const respond=async(res,fn)=>{try{await fn();}catch(e){res.status(e.openbaoSafe?e.status:500).json({error:e.openbaoSafe?e.message:'OpenBao setup could not be completed. Credentials and upstream details withheld.'});}};
openbaoRouter.get('/',(_req,res)=>respond(res,async()=>{const db=getDb(),r=readOpenBao(db),s=state(db);let health=r?await status(createClient(r.config.origin)):{state:'not_configured'},matches=true;try{if(r)currentPlan(db,r);}catch{matches=false;}
  if(r&&health.state==='unsealed'){try{await requireReady(createClient(r.config.origin),r);}catch{health={...health,state:'unavailable'};}}
  const verified=matches&&health.state==='unsealed'&&health.version==='2.6.2'&&health.clusterId===r?.resources?.clusterId&&s?.lastVerification?.fingerprint===digest(r.config);
  res.json({state:s,review:review(db),health,verification:verified?s.lastVerification:{state:'not_verified',label:matches?`Current state: ${health.state}. Reapply after restoring service.`:'Saved platform choices are skipped or changed.'}});}));
for(const [path,schema,handler,action] of [['/',configSchema,save,'OPENBAO_SETTINGS_SAVED'],['/handoff',ackSchema,acknowledge,'OPENBAO_HANDOFF_ACKNOWLEDGED']])openbaoRouter.put(path,requireSudo,(req,res)=>respond(res,async()=>{const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid reviewed OpenBao settings; unknown fields are refused.'});const s=handler(getDb(),parsed.data);logAudit(req.user.id,action,'setup_openbao','1',{revision:s.revision},req.ip);res.json({state:s,review:review(getDb())});}));
openbaoRouter.post('/apply',requireSudo,(req,res)=>respond(res,async()=>{{const why=stageRefusal(getDb(),'openbao');if(why)return res.status(409).json({code:'STAGE_LOCKED',error:why});}const parsed=applySchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Review the current saved OpenBao configuration.'});const result=apply(getDb(),parsed.data,req.user.id);logAudit(req.user.id,'OPENBAO_PLAN_APPLIED','setup_job',result.job.id,{created:result.created},req.ip);res.status(result.created?202:200).json(result);}));
for(const [action,schema] of [['unseal',unsealSchema],['bootstrap',bootstrapSchema]])openbaoRouter.post('/'+action,requireSudo,(req,res)=>respond(res,async()=>{
  const parsed=schema.safeParse(req.body);req.body={};if(!parsed.success)return res.status(400).json({error:'Invalid reviewed operator action. Submitted material was not recorded.'});
  const result=await operatorAction(getDb(),action,parsed.data,req.user.id);logAudit(req.user.id,'OPENBAO_OPERATOR_ACTION','setup_job',result.job.id,{action},req.ip);res.json(result);
}));
