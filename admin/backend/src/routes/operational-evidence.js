import { OperationsError, revision, parse, schemas } from '../lib/operational-projects-logic.js';

export function evidenceHeaders(_req,res,next) {
  res.set('Cache-Control','no-store');res.set('Pragma','no-cache');
  res.set('X-Content-Type-Options','nosniff');res.set('Content-Security-Policy',"default-src 'none'; sandbox");
  res.set('Cross-Origin-Resource-Policy','same-origin');res.set('Referrer-Policy','no-referrer');
  next();
}

// Mounted behind Operations authentication and current-actor middleware. CSRF
// is injected and required again here, including for the binary route.
export function createEvidenceRouter({Router,store,service,csrf,enabled=false}) {
  const router=Router({mergeParams:true});
  router.use(evidenceHeaders);
  router.use((_req,res,next)=>enabled ? next() : res.status(404).json({error:'Not found'}));
  if(!enabled) return router;
  if(!store||!service||!csrf) throw new Error('Evidence policy boundary required');
  router.use(csrf);
  const route=(fn,status=200)=>async(req,res)=>{
    try {const result=await fn(req,req.operationsActor);if(!res.headersSent && !res.writableEnded) res.status(status).json(result);}
    catch(e) {
      if(res.headersSent) res.destroy();
      else {
        // An invalid/incomplete binary framing must not poison a keepalive
        // connection or be interpreted as the next request.
        if(req.method==='PUT') res.set('Connection','close');
        res.status(e instanceof OperationsError?e.status:500).json({error:e instanceof OperationsError?e.message:'Unable to complete evidence request'});
      }
    }
  };
  const rev=r=>revision(r.get('If-Match'));
  const empty=r=>parse(schemas.empty,r.body??{});
  router.get('/',route((r,a)=>store.list(a,r.params.id,{...r.query,...(r.query.limit?{limit:Number(r.query.limit)}:{})})));
  router.post('/',route((r,a)=>store.create(a,r.params.id,r.body),201));
  router.get('/:d',route((r,a)=>store.get(a,r.params.id,r.params.d)));
  router.get('/:d/workspace',route((r,a)=>store.workspace(a,r.params.id,r.params.d,r.query)));
  router.get('/:d/revisions/:revision',route((r,a)=>store.publication(a,r.params.id,r.params.d,r.params.revision)));
  router.patch('/:d',route((r,a)=>store.update(a,r.params.id,r.params.d,rev(r),r.body)));
  router.post('/:d/uploads',route((r,a)=>store.reserve(a,r.params.id,r.params.d,r.body),201));
  router.get('/:d/uploads/:u',route((r,a)=>store.uploadStatus(a,r.params.id,r.params.d,r.params.u)));
  router.put('/:d/uploads/:u/bytes',route((r,a)=>service.bytes(a,r.params.id,r.params.d,r.params.u,r)));
  router.post('/:d/uploads/:u/finalize',route((r,a)=>{empty(r);return service.finalize(a,r.params.id,r.params.d,r.params.u);}));
  router.post('/:d/uploads/:u/cancel',route((r,a)=>{empty(r);return store.cancelUpload(a,r.params.id,r.params.d,r.params.u);}));
  // Explicit HEAD: Express otherwise silently dispatches HEAD to GET.
  router.head('/:d/evidence/:e/download',route((r,a)=>service.serve(a,r.params.id,r.params.d,r.params.e,r,r.res)));
  router.get('/:d/evidence/:e/download',route((r,a)=>service.serve(a,r.params.id,r.params.d,r.params.e,r,r.res)));
  router.post('/:d/annotations',route((r,a)=>store.annotate(a,r.params.id,r.params.d,rev(r),r.body),201));
  router.post('/:d/share',route((r,a)=>store.share(a,r.params.id,r.params.d,rev(r),r.body)));
  router.post('/:d/archive',route((r,a)=>{parse(schemas.reason,r.body);return store.archive(a,r.params.id,r.params.d,rev(r));}));
  for(const [path,action] of [['restrict','restrict'],['deletion-request','delete_requested']]) {
    router.post(`/:d/evidence/:e/${path}`,route((r,a)=>store.disposition(a,r.params.id,r.params.d,rev(r),{...r.body,object_id:r.params.e,action})));
  }
  router.post('/:d/evidence/:e/hold',route((r,a)=>store.hold(a,r.params.id,r.params.d,rev(r),{...r.body,object_id:r.params.e})));
  return router;
}
