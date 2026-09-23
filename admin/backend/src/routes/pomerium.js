import { Router } from 'express';
import { stageRefusal } from '../lib/setup-engine/full-platform-store.js';
import { getDb,logAudit } from '../db.js';
import { requireSudo } from '../middleware/auth.js';
import { pomeriumState,readPomerium,savePomerium,applyPomerium,reviewPomeriumRoute,savePomeriumRoute,routeSnapshot,subjectChoices } from '../lib/setup-engine/pomerium-store.js';
import { pomeriumApplySchema,pomeriumRouteApplySchema,POMERIUM_IMAGE,POMERIUM_ROOT } from '../lib/setup-engine/pomerium-logic.js';

// Mounted under the existing admin-only, authenticated and CSRF-protected setup
// router. Every write uses the existing fresh-auth gate.
export const pomeriumRouter=Router();
pomeriumRouter.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
const handle=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){
  if(e.name==='ZodError') return res.status(400).json({error:'Invalid Pomerium input. Reopen and review the exact saved settings.'});
  if(e.pomeriumSafe) return res.status(e.status||409).json({error:e.message});
  next(e);
}};
pomeriumRouter.get('/',handle((_req,res)=>{
  const db=getDb(),r=readPomerium(db),routes=[];
  if(r) for(const route of db.prepare('SELECT id,domain FROM service_http_routes ORDER BY domain').all()) {
    try{const snapshot=routeSnapshot(db,route.id,r.config);routes.push({id:route.id,domain:route.domain,upstream:`http://${snapshot.target_ip}:${snapshot.target_port}`,supported:true});}
    catch(e){routes.push({id:route.id,domain:route.domain,supported:false,reason:e.pomeriumSafe?e.message:'Route configuration cannot be verified.'});}
  }
  res.json({state:pomeriumState(db),routes,identities:r?subjectChoices(db,r.config.issuer):[],image:POMERIUM_IMAGE,
    handoff:r?{configRef:`${POMERIUM_ROOT}/revision-${r.revision}.json`,callback:`${r.config.origin}/oauth2/callback`,webOrigins:[r.config.origin],clientId:r.config.clientId,issuer:r.config.issuer}:null});
}));
pomeriumRouter.put('/',requireSudo,handle((req,res)=>{
  const state=savePomerium(getDb(),req.body);
  logAudit(req.user.id,'POMERIUM_CONFIG_SAVED','setup_pomerium','1',{revision:state.revision,mode:state.config.mode},req.ip);
  res.json({state});
}));
pomeriumRouter.post('/apply',requireSudo,handle((req,res)=>{{const why=stageRefusal(getDb(),'pomerium');if(why)return res.status(409).json({code:'STAGE_LOCKED',error:why});}
  const input=pomeriumApplySchema.parse(req.body),result=applyPomerium(getDb(),input.expectedRevision,req.user.id);
  logAudit(req.user.id,'POMERIUM_APPLY','setup_job',result.job.id,{revision:input.expectedRevision},req.ip);
  res.status(result.created?202:200).json(result);
}));
pomeriumRouter.post('/routes/review',handle((req,res)=>res.json({review:reviewPomeriumRoute(getDb(),req.body)})));
pomeriumRouter.post('/routes/apply',requireSudo,handle((req,res)=>{
  const input=pomeriumRouteApplySchema.parse(req.body),result=savePomeriumRoute(getDb(),input,req.user.id);
  logAudit(req.user.id,'POMERIUM_ROUTE_REVIEWED','setup_job',result.job.id,{routeId:input.routeId,action:input.action},req.ip);
  res.status(202).json(result);
}));
