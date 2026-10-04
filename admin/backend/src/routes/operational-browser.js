import { z } from 'zod';
import {publicNavigationInput} from '../lib/operational-public-navigation.js';
import { OperationsError, assertRevision, fail, parse, revision } from '../lib/operational-projects-logic.js';
import { selectedConsentSchema, selectedStartSchema } from '../lib/operational-selected-browser-contract.js';
import { selectedAuthConfirmationInputSchema } from '../lib/operational-selected-browser-auth-contract.js';

const denied = (_req,res) => res.status(404).json({error:'Not found'});
const noSudo = (_req,res) => res.status(401).json({error:'sudo_required',sudo_required:true,message:'This action requires sudo re-authentication.'});
const emptySchema=z.object({}).strict();
const id=z.string().uuid(),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pageQuery=z.object({after:id.optional(),limit:z.string().regex(/^\d{1,2}$/).transform(Number).refine(n=>n>=1&&n<=50).optional()}).strict();
const attemptBody=z.object({attempt_id:id,fence:positive}).strict();
const attemptQuery=z.object({attempt_id:id,fence:z.string().regex(/^[1-9]\d{0,14}$/).transform(Number).refine(Number.isSafeInteger)}).strict();
const maxFile=16777216,maxBase64=4*Math.ceil(maxFile/3);
const assetBody=z.object({idempotency_key:id,byte_count:z.number().int().min(1).max(maxFile),
  mime_type:z.enum(['application/pdf','text/plain','text/csv','image/png','image/jpeg']),sha256:z.string().regex(/^[a-f0-9]{64}$/),
  bytes_base64:z.string().min(4).max(maxBase64).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict();
const attemptPage=attemptQuery.extend(pageQuery.shape).strict();
const contentQuery=attemptQuery.extend({purpose:z.enum(['review','download']).default('download')}).strict();
const assetContentQuery=z.object({purpose:z.enum(['review','download']).default('review')}).strict();
const normalizeBody=attemptBody.extend({redactions:z.array(z.object({x:z.number().int().min(0).max(8191),y:z.number().int().min(0).max(8191),
  width:z.number().int().min(1).max(8192),height:z.number().int().min(1).max(8192)}).strict()).max(32).default([])}).strict();
const reviewBody=attemptBody.extend({purpose:z.enum(['human_download','model_input']),decision:z.enum(['approve','reject']),reviewed_statement:z.string().max(200)}).strict();
const clipboardImport=attemptBody.extend({text:z.string().min(1).refine(s=>Buffer.byteLength(s,'utf8')<=65536)}).strict();
const clipboardExport=attemptBody.extend({artifact_id:id}).strict();

// Register before the C0 /:configurationId route: "convert" and "conversions"
// are static paths, not configuration identifiers. Global auth/CSRF/no-store are
// inherited from Operations; gates and sudo remain injected and fail closed.
// No live DB, host path, executable, DNS/website fetch, or automatic retry here.
export function registerBrowserRoutes(router,{runtime=null,store,agentsOnly=denied,runsOnly=denied,
  expected=req=>revision(req.get('If-Match')),requireSudo=noSudo,controlVerified=()=>false,actorForRequest=null,assetBodyParser=null}={}) {
  const getRuntime=req=>typeof runtime==='function'?runtime(req):runtime;
  const assetIntakes=new Map();
  const actor=req=>{
    const value=actorForRequest?actorForRequest(req):({...req.operationsActor,
      elevated:req.browserSudoVerified===true,control_verified:controlVerified(req)===true});
    if(value?.mcp===true||value?.human===false)fail(403,'A current human session is required');
    return value;
  };
  const elevated=(req,res,next)=>requireSudo(req,res,()=>{req.browserSudoVerified=true;next();});
  function available(req,component) {
    const value=getRuntime(req)?.[component];
    if(!value)throw Object.assign(new OperationsError(503,'Browser service unavailable'),{code:'BROWSER_SERVICE_UNAVAILABLE'});
    return value;
  }
  function method(value,name) {
    if(typeof value?.[name]!=='function')throw Object.assign(new OperationsError(503,'Browser operation unavailable'),{code:'BROWSER_OPERATION_UNAVAILABLE'});
    return value[name].bind(value);
  }
  const empty=req=>parse(emptySchema,req.body??{});
  const scope=(req,v)=>({project_id:req.params.id,run_id:req.params.runId,attempt_id:v.attempt_id,fence:v.fence});
  function assertRunRevision(req,a) {
    const value=method(available(req,'runs'),'get')(a,req.params.id,req.params.runId);
    if(value?.then)throw new Error('Synchronous browser run revision check required');
    assertRevision(expected(req),value.run.revision);return value;
  }
  function query(req,schema=emptySchema) {return parse(schema,req.query??{});}
  const intake=async(req,res,next)=>{
    let release;
    try {
      res.set('Cache-Control','no-store');
      const a=actor(req);
      if(method(available(req,'artifacts').store,'authorizeAssetStage')(a,req.params.id)!==true)fail(503,'Private file intake authorization unavailable');
      if(req.headers?.['content-encoding']&&req.headers['content-encoding']!=='identity')fail(415,'Private file compression is not supported');
      const pending=[...assetIntakes.values()];
      if(pending.length>=8||pending.filter(v=>v.actor===a.id).length>=2||pending.filter(v=>v.project===req.params.id).length>=4)
        fail(429,'Private file intake concurrency limit');
      const key=Symbol(),record={actor:a.id,project:req.params.id};let timer;
      release=()=>{clearTimeout(timer);assetIntakes.delete(key);res.off?.('finish',release);res.off?.('close',release);req.off?.('aborted',release);};
      assetIntakes.set(key,record);req.browserAssetIntakeRelease=release;
      res.once?.('finish',release);res.once?.('close',release);req.once?.('aborted',release);
      timer=setTimeout(()=>{release();req.destroy?.();},30000);timer.unref?.();
      if(!assetBodyParser){next();return;}
      await new Promise((resolve,reject)=>assetBodyParser(req,res,err=>{
        try{
          if(!assetIntakes.has(key)){req.destroy?.();resolve();return;}
          if(err){release();if(!res.headersSent)res.status([400,413,415].includes(err.status)?err.status:400).json({error:'Invalid bounded private file body'});else res.destroy?.();resolve();return;}
          let allowed=false;agentsOnly(req,res,()=>{allowed=true;});
          if(!allowed){release();resolve();return;}
          if(method(available(req,'artifacts').store,'authorizeAssetStage')(actor(req),req.params.id)!==true)fail(503,'Private file intake authorization unavailable');
          next();resolve();
        }catch(error){reject(error);}
      }));
    }catch(err){
      release?.();const known=err instanceof OperationsError;
      if(known&&[401,403,404].includes(err.status))try{store?.auditDenied?.(req.operationsActor,req.params.id,'browser_private_asset_stage',err.status);}catch{/* preserve refusal */}
      if(!res.headersSent)res.status(known?err.status:500).json({error:known?err.message:'Unable to admit private file intake'});
      else res.destroy?.();
    }
  };
  const handle=(fn,{status=200,action='browser_request',binary=false,runGate=false}={})=>async(req,res)=> {
    try {
      res.set('Cache-Control','no-store');
      const data=await fn(req,actor(req),res);
      if(binary)return data;
      // Turning a gate off while an async model/worker response is pending must
      // suppress that response. This check never replays the service operation.
      let allowed=false;agentsOnly(req,res,()=>{allowed=true;});if(!allowed)return;
      if(runGate){allowed=false;runsOnly(req,res,()=>{allowed=true;});if(!allowed)return;}
      const rev=data?.run?.revision??data?.configuration?.revision;
      if(Number.isSafeInteger(rev)&&rev>0)res.set('ETag',`"${rev}"`);
      return res.status(status).json(data);
    } catch(err) {
      if(res.headersSent){res.destroy?.();return;}
      const known=err instanceof OperationsError;
      if(known&&[401,403,404].includes(err.status))try{store?.auditDenied?.(req.operationsActor,req.params?.id,action,err.status);}catch{/* preserve refusal */}
      return res.status(known?err.status:500).json({error:known?err.message:'Unable to complete browser request',
        ...(known&&typeof err.code==='string'&&/^[A-Za-z0-9_]{1,128}$/.test(err.code)?{code:err.code}:{})});
    }finally{req.browserAssetIntakeRelease?.();}
  };
  const agent=(fn,opts={})=>handle(fn,opts),run=(fn,opts={})=>handle(fn,{...opts,runGate:true});
  const base='/:id/browser-agent-configurations',runs='/:id/browser-agent-runs',assets='/:id/browser-assets';

  router.get('/:id/public-browser',agentsOnly,runsOnly,run(async(r,a)=>{const input=parse(z.object({url:z.string().min(8).max(2048)}).strict(),r.query);return {readiness:await method(available(r,'runs'),'publicReadiness')(a,r.params.id,input.url)};}));
  router.post('/:id/public-browser',agentsOnly,runsOnly,run((r,a)=>method(available(r,'runs'),'openPublic')(a,r.params.id,parse(publicNavigationInput,r.body)),{status:202,action:'public_browser_open'}));

  router.get(`${base}/convert/readiness`,agentsOnly,runsOnly,run((r,a)=>{query(r);return method(available(r,'conversion'),'readiness')(a,r.params.id);}));
  router.post(`${base}/convert`,agentsOnly,runsOnly,elevated,run((r,a)=>method(available(r,'conversion'),'convert')(a,r.params.id,r.body),{status:202,action:'browser_conversion'}));
  router.get(`${base}/conversions`,agentsOnly,agent((r,a)=>{query(r);return method(available(r,'conversion'),'list')(a,r.params.id);}));
  router.get(`${base}/conversions/:conversionId`,agentsOnly,agent((r,a)=>{query(r);return method(available(r,'conversion'),'status')(a,r.params.id,r.params.conversionId);}));
  router.post(`${base}/conversions/:conversionId/cancel`,agentsOnly,agent((r,a)=>{empty(r);return method(available(r,'conversion'),'cancel')(a,r.params.id,r.params.conversionId);},{action:'browser_conversion_cancel'}));
  router.get(`${base}/:configurationId/readiness`,agentsOnly,runsOnly,run(async(r,a)=>{query(r);return {readiness:await method(available(r,'runs'),'readiness')(a,r.params.id,r.params.configurationId)};}));
  router.put(`${base}/:configurationId/model-consent`,agentsOnly,runsOnly,elevated,run((r,a)=>{
    const input=parse(selectedConsentSchema,r.body);assertRevision(expected(r),input.configuration_revision);
    return method(available(r,'runs'),'consent')(a,r.params.id,r.params.configurationId,input);
  },{action:'browser_model_consent'}));
  router.post(`${base}/:configurationId/start`,agentsOnly,runsOnly,elevated,run((r,a)=>{
    const input=parse(selectedStartSchema,r.body);assertRevision(expected(r),input.configuration_revision);
    return method(available(r,'runs'),'start')(a,r.params.id,r.params.configurationId,input);
  },{status:202,action:'browser_run_start'}));

  router.get(runs,agentsOnly,runsOnly,run((r,a)=>{query(r);return method(available(r,'runs'),'list')(a,r.params.id);}));
  router.post(runs,agentsOnly,runsOnly,elevated,run((r,a)=>{
    const input=parse(selectedStartSchema.extend({configuration_id:id}).strict(),r.body),{configuration_id,...start}=input;
    assertRevision(expected(r),start.configuration_revision);return method(available(r,'runs'),'start')(a,r.params.id,configuration_id,start);
  },{status:202,action:'browser_run_start'}));
  router.get(`${runs}/:runId`,agentsOnly,runsOnly,run((r,a)=>{query(r);return method(available(r,'runs'),'get')(a,r.params.id,r.params.runId);}));
  router.get(`${runs}/:runId/public-frame`,agentsOnly,runsOnly,run((r,a)=>method(available(r,'runs'),'publicFrame')(a,r.params.id,r.params.runId,query(r,attemptQuery)),{action:'public_browser_view'}));
  router.get(`${runs}/:runId/sources`,agentsOnly,runsOnly,run((r,a)=>{query(r);return method(available(r,'runs'),'sources')(a,r.params.id,r.params.runId);}));
  router.get(`${runs}/:runId/authentication-readback`,agentsOnly,runsOnly,elevated,run((r,a)=>{
    query(r);return method(available(r,'runs'),'authenticationReadback')(a,r.params.id,r.params.runId);
  },{action:'browser_authentication_readback'}));
  router.post(`${runs}/:runId/authentication-readback`,agentsOnly,runsOnly,elevated,run((r,a)=>{
    const {revision:bodyRevision,...input}=parse(selectedAuthConfirmationInputSchema.extend({revision:positive}).strict(),r.body);
    assertRevision(expected(r),bodyRevision);
    return method(available(r,'runs'),'confirmAuthentication')(a,r.params.id,r.params.runId,bodyRevision,input);
  },
  {action:'browser_authentication_confirmation'}));
  for(const [suffix,name,sudo] of [['refresh','refresh',false],['step','step',true],['pause','pause',false],['resume','resume',true],
    ['cancel','cancel',false],['takeover','takeover',true],['release','release',true],['retry-cleanup','retryCleanup',true]]) {
    router.post(`${runs}/:runId/${suffix}`,agentsOnly,runsOnly,...(sudo?[elevated]:[]),run((r,a)=>{
      empty(r);if(name==='refresh')return method(available(r,'runs'),name)(a,r.params.id,r.params.runId);
      return method(available(r,'runs'),name)(a,r.params.id,r.params.runId,expected(r));
    },{action:`browser_run_${suffix.replaceAll('-','_')}`}));
  }
  router.post(`${runs}/:runId/approvals/:approvalId/decision`,agentsOnly,runsOnly,elevated,run((r,a)=>
    method(available(r,'runs'),'decision')(a,r.params.id,r.params.runId,r.params.approvalId,expected(r),r.body),{action:'browser_run_approval'}));
  router.post(`${runs}/:runId/uncertainties/:uncertaintyId/reconcile`,agentsOnly,runsOnly,elevated,run((r,a)=>
    method(available(r,'runs'),'reconcile')(a,r.params.id,r.params.runId,r.params.uncertaintyId,expected(r),r.body),{action:'browser_run_reconcile'}));
  router.post(`${runs}/:runId/control`,agentsOnly,runsOnly,elevated,run((r,a)=>
    method(available(r,'runs'),'controlInput')(a,r.params.id,r.params.runId,expected(r),r.body),{action:'browser_run_control'}));
  router.get(`${runs}/:runId/live`,agentsOnly,runsOnly,run((r,a)=>{query(r);return method(available(r,'runs'),'live')(a,r.params.id,r.params.runId,{session_id:a.jti??null});}));

  router.get(assets,agentsOnly,agent((r,a)=>method(available(r,'artifacts').store,'listAssets')(a,r.params.id,query(r,pageQuery))));
  router.post(assets,agentsOnly,intake,agent((r,a)=>{
    const input=parse(assetBody,r.body),{bytes_base64,...metadata}=input,bytes=Buffer.from(bytes_base64,'base64');
    if(bytes.length!==input.byte_count||bytes.toString('base64')!==bytes_base64)fail(400,'Private file body does not match its byte count');
    return method(available(r,'artifacts').service,'asset')(a,r.params.id,metadata,[bytes]);
  },{status:201,action:'browser_private_asset_stage'}));
  router.get(`${assets}/:assetId`,agentsOnly,agent((r,a)=>{query(r);return {artifact:method(available(r,'artifacts').store,'asset')(a,r.params.id,r.params.assetId)};}));
  router.patch(`${assets}/:assetId/review`,agentsOnly,agent((r,a)=>({artifact:method(available(r,'artifacts').store,'reviewAsset')(a,r.params.id,r.params.assetId,r.body)}),{action:'browser_private_asset_review'}));
  router.post(`${assets}/:assetId/model-review`,agentsOnly,elevated,agent((r,a)=>({artifact:method(available(r,'artifacts').store,'reviewAssetModel')(a,r.params.id,r.params.assetId,r.body)}),{action:'browser_private_source_disclosure'}));
  router.get(`${assets}/:assetId/content`,agentsOnly,agent((r,a,res)=>{
    const q=query(r,assetContentQuery);return method(available(r,'artifacts').service,'serve')(a,{project_id:r.params.id,id:r.params.assetId,purpose:q.purpose},r,res);
  },{binary:true,action:'browser_private_asset_read'}));
  router.get(`${runs}/:runId/artifacts`,agentsOnly,runsOnly,run((r,a)=>{
    const q=query(r,attemptPage),{attempt_id,fence,...page}=q;return method(available(r,'artifacts').store,'listAttempt')(a,scope(r,{attempt_id,fence}),page);
  }));
  router.get(`${runs}/:runId/artifacts/:artifactId/content`,agentsOnly,runsOnly,run((r,a,res)=>{
    const q=query(r,contentQuery);return method(available(r,'artifacts').service,'serve')(a,
      {project_id:r.params.id,scope:scope(r,q),id:r.params.artifactId,purpose:q.purpose},r,res);
  },{binary:true,action:'browser_private_artifact_read'}));
  router.post(`${runs}/:runId/artifacts/:artifactId/review`,agentsOnly,runsOnly,elevated,run((r,a)=>{
    const v=parse(reviewBody,r.body),{attempt_id,fence,...review}=v;assertRunRevision(r,a);
    return {artifact:method(available(r,'artifacts').store,'reviewRelease')(a,scope(r,{attempt_id,fence}),r.params.artifactId,review)};
  },{action:'browser_private_artifact_release'}));
  router.post(`${runs}/:runId/artifacts/:artifactId/normalize`,agentsOnly,runsOnly,run(async(r,a)=>{
    const v=parse(normalizeBody,r.body);assertRunRevision(r,a);
    return {artifact:await method(available(r,'artifacts').service,'normalizeScreenshot')(a,scope(r,v),r.params.artifactId,{redactions:v.redactions})};
  },{status:201,action:'browser_private_screenshot_normalize'}));
  router.post(`${runs}/:runId/clipboard/import`,agentsOnly,runsOnly,elevated,run(async(r,a)=>{
    const v=parse(clipboardImport,r.body);assertRunRevision(r,a);
    return {artifact:await method(available(r,'artifacts').service,'clipboardImport')(a,scope(r,v),{text:v.text})};
  },{status:201,action:'browser_clipboard_import'}));
  router.post(`${runs}/:runId/clipboard/export`,agentsOnly,runsOnly,elevated,run((r,a)=>{
    const v=parse(clipboardExport,r.body);assertRunRevision(r,a);
    return method(available(r,'artifacts').service,'clipboardExport')(a,scope(r,v),v.artifact_id);
  },{action:'browser_clipboard_export'}));
  return router;
}
