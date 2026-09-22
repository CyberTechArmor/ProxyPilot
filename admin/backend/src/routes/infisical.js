import { Router } from 'express';
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
infisicalRouter.post('/apply',requireSudo,(req,res)=>{const parsed=infisicalApplySchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Review the current saved configuration before applying.'});
  return respond(res,()=>{const result=applyInfisical(getDb(),parsed.data,req.user.id);logAudit(req.user.id,'INFISICAL_PLAN_APPLIED','setup_job',result.job.id,{revision:parsed.data.revision,created:result.created},req.ip);res.status(result.created?202:200).json(result);});});
