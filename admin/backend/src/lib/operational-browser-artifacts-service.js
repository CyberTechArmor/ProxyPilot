import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { fail, parse } from './operational-projects-logic.js';
import { browserArtifactByteHash, MAX_BROWSER_ARTIFACT_BYTES } from './operational-browser-artifacts-files.js';

const MAX_TEXT_INPUT = 12000, MAX_MODEL_IMAGE_BYTES=2097152;
const text = bytes => {
  try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { fail(415,'Private text file must use UTF-8'); }
};
// Container/media recognition is not a safety claim. Private bytes are never
// rendered inline, unpacked, executed, or disclosed to a model by this check.
export function verifyBrowserArtifactMedia(bytes,mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length>MAX_BROWSER_ARTIFACT_BYTES) fail(413,'Private browser file too large');
  if (mime==='text/plain' || mime==='text/csv') {
    const value = text(bytes);
    if (value.includes('\0') || /[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(415,'Private text file contains binary data');
  } else if (mime==='application/pdf') {
    if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(bytes.subarray(0,12).toString('ascii')) ||
      !/%%EOF[\t\r\n ]*$/.test(bytes.subarray(-1024).toString('ascii'))) fail(415,'Private file media type mismatch');
  } else if (mime==='image/png') {
    if (bytes.length<45 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      bytes.readUInt32BE(8)!==13 || bytes.toString('ascii',12,16)!=='IHDR' ||
      bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND' || bytes.readUInt32BE(bytes.length-12)!==0)
      fail(415,'Private file media type mismatch');
  } else if (mime==='image/jpeg') {
    if (bytes.length<4 || bytes[0]!==255 || bytes[1]!==216 || bytes.at(-2)!==255 || bytes.at(-1)!==217)
      fail(415,'Private file media type mismatch');
  } else fail(415,'Private file media type unsupported');
  return mime;
}
const redactionsSchema = z.array(z.object({x:z.number().int().min(0).max(8191),y:z.number().int().min(0).max(8191),
  width:z.number().int().min(1).max(8192),height:z.number().int().min(1).max(8192)}).strict()).max(32);

export function createBrowserArtifactsService({store,files,decodeImage,redactImage,decodePdf,bodyTimeoutMs=30000}) {
  if (!store || !files || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs<1 || bodyTimeoutMs>30000)
    throw new Error('Private browser artifact service unavailable');
  async function receive(iterable,check,expected) {
    let size = 0, ended = false, timer; const chunks = [];
    const iterator = iterable?.[Symbol.asyncIterator]?.() || iterable?.[Symbol.iterator]?.();
    if (!iterator) fail(400,'Bounded private file bytes required');
    const timeout = new Promise((resolve,reject)=> { timer=setTimeout(()=>reject(new Error('Private file intake timed out')),bodyTimeoutMs); });
    try {
      for (;;) {
        check();
        const next = await Promise.race([iterator.next(),timeout]);
        if (next.done) { ended = true; break; }
        if (!(next.value instanceof Uint8Array)) fail(400,'Invalid private file bytes');
        size += next.value.byteLength;
        if (size>expected.byte_count || size>MAX_BROWSER_ARTIFACT_BYTES) fail(413,'Private file size limit exceeded');
        chunks.push(Buffer.from(next.value));
      }
      check();
      const bytes = Buffer.concat(chunks,size);
      if (size!==expected.byte_count || browserArtifactByteHash(bytes)!==expected.sha256) fail(400,'Private file digest or size mismatch');
      verifyBrowserArtifactMedia(bytes,expected.mime_type);
      return bytes;
    } finally {
      clearTimeout(timer);
      if (!ended) { iterable.destroy?.(); if (iterator.return) Promise.resolve(iterator.return()).catch(()=>{}); }
    }
  }
  function put(id,bytes,expected) {
    try { return files.write(id,bytes); }
    catch (e) {
      // Exact existing bytes may be an interrupted durable write. Never overwrite
      // or repair a different object under a reused immutable identity.
      if (e.code!=='EEXIST') throw e;
      files.read(id,expected); return {sha256:expected.sha256,byte_count:expected.byte_count};
    }
  }
  async function stageBytes(actor,project,scope,metadata,iterable,{asset=false,humanClipboard=false,inputDraft=false,observation=false,derivative=false}={}) {
    const reserved = asset?store.reserveAsset(actor,project,metadata):humanClipboard?store.reserveClipboardImport(actor,scope,metadata):inputDraft?store.reserveInputDraft(actor,scope,metadata):observation?store.reserveObservation(actor,scope,metadata):derivative?store.reserveScreenshotDerivative(actor,scope,metadata):store.reserveAttempt(actor,scope,metadata);
    const l = store.claim(actor,project,reserved.id,scope);
    if (l.receipt) {
      // A retry still proves the submitted bytes; idempotency is not permission
      // to silently accept a different or incomplete multipart body.
      await receive(iterable,()=>store.checkRetry(actor,project,reserved.id,scope),
        {byte_count:reserved.byte_count,sha256:reserved.sha256,mime_type:reserved.mime_type});
      return store.checkRetry(actor,project,reserved.id,scope);
    }
    try {
      const expected = {sha256:l.sha256,byte_count:l.byte_count,mime_type:l.mime};
      const bytes = await receive(iterable,()=>store.checkWrite(actor,l),expected);
      const proof = store.withWrite(actor,l,()=>put(l.id,bytes,expected));
      return store.seal(actor,l,{...proof,mime_type:expected.mime_type});
    } catch (e) {
      // Keep the reservation/physical charge so explicit maintenance can safely
      // recover after intake/auth failures. No cleanup under stale authorization.
      throw e;
    } finally { store.releaseWrite(l); }
  }
  function bytesUnderLease(actor,l) {
    store.checkRead(actor,l);
    const bytes = files.read(l.artifact_id,{sha256:l.sha256,byte_count:l.byte_count});
    store.checkRead(actor,l); verifyBrowserArtifactMedia(bytes,l.mime_type);
    return bytes;
  }
  function verifyRetainedFile(actor,l,verify) {
    // Verification rereads private bytes but exposes only immutable pins. The
    // active attempt and approval are checked again after the physical read;
    // this cannot stage, release, execute or disclose content to a model.
    let bytes;
    try {
      store.checkRead(actor,l);
      bytes=files.read(l.artifact_id,{sha256:l.sha256,byte_count:l.byte_count});
      store.checkRead(actor,l);verifyBrowserArtifactMedia(bytes,l.mime_type);
      return verify();
    }finally{bytes?.fill(0);store.closeRead(l);}
  }
  async function decodedImage(bytes) {
    if (typeof decodeImage!=='function') fail(503,'Reviewed image decoder is unavailable');
    const result = await decodeImage(bytes);
    if (!result || !Buffer.isBuffer(result.bytes) || !Number.isInteger(result.width) || !Number.isInteger(result.height) ||
      result.width<1 || result.height<1 || result.width>8192 || result.height>8192 || result.width*result.height>16000000)
      fail(415,'Private image validation failed');
    verifyBrowserArtifactMedia(result.bytes,'image/png');
    return result;
  }
  async function sourceContent(bytes,mime_type) {
    if (mime_type==='text/plain' || mime_type==='text/csv') {
      if (bytes.length>MAX_TEXT_INPUT) fail(413,'Private source text exceeds the model input bound');
      return {kind:'text',text:text(bytes)};
    }
    if (mime_type.startsWith('image/')) return {kind:'image',mime_type:'image/png',bytes:(await decodedImage(bytes)).bytes};
    if (mime_type==='application/pdf') {
      if (typeof decodePdf!=='function' || decodePdf.ready!==true) fail(503,'Reviewed bounded PDF decoder is unavailable');
      const value=await decodePdf(bytes);
      if (typeof value!=='string' || !value.trim() || Buffer.byteLength(value,'utf8')>MAX_TEXT_INPUT) fail(413,'Private PDF text exceeds the model input bound');
      return {kind:'text',text:value};
    }
    fail(415,'Private source media type unsupported');
  }
  return {
    asset(actor,project,input,iterable) { return stageBytes(actor,project,null,input,iterable,{asset:true}); },
    stage(actor,scope,input,iterable) { return stageBytes(actor,scope.project_id,scope,input,iterable); },
    cancelAttempt(scope,options) {return store.cancelAttempt(scope,options);},
    sourceCapabilities() {
      const image_ready=typeof decodeImage==='function',pdf_ready=typeof decodePdf==='function' && decodePdf.ready===true;
      return {mime_types:['text/plain','text/csv',...(image_ready?['image/png','image/jpeg']:[]),...(pdf_ready?['application/pdf']:[])],
        image_ready,pdf_ready,screenshot_redaction_ready:typeof redactImage==='function' && redactImage.ready===true,
        max_file_bytes:MAX_BROWSER_ARTIFACT_BYTES,max_image_decode_bytes:8388608,max_model_image_bytes:MAX_MODEL_IMAGE_BYTES,max_model_text_bytes:MAX_TEXT_INPUT};
    },
    validateInputs(actor,input) {
      store.validateInputs(actor,input);
      const capabilities=this.sourceCapabilities(),refs=[...input.configuration.work.source_inputs,...input.configuration.artifacts.upload_asset_refs];
      for (const ref of refs) {
        if (input.configuration.work.source_inputs.some(r=>r.id===ref.id) && !capabilities.mime_types.includes(ref.mime_type))
          fail(503,'Reviewed browser source decoder is unavailable');
        if (input.configuration.work.source_inputs.some(r=>r.id===ref.id) &&
          ((ref.mime_type.startsWith('image/') && ref.byte_count>capabilities.max_image_decode_bytes) ||
          (['text/plain','text/csv'].includes(ref.mime_type) && ref.byte_count>capabilities.max_model_text_bytes)))
          fail(413,'Private source exceeds its decoder or model input bound');
        const l=store.openAssetRead(actor,input.project_id,ref.id,'review');
        try {bytesUnderLease(actor,l);store.validateInputs(actor,input);}
        finally {store.closeRead(l);}
      }
      return true;
    },
    async normalizeScreenshot(actor,scope,id,{redactions=[]}={}) {
      const rectangles = parse(redactionsSchema,redactions);
      const l = store.openRead(actor,scope,id,'review');
      try {
        const raw = store.artifact(actor,scope,id);
        if (raw.kind!=='screenshot') fail(400,'Current screenshot original required');
        let result = await decodedImage(bytesUnderLease(actor,l));
        store.checkRead(actor,l);
        for (const r of rectangles) if (r.x+r.width>result.width || r.y+r.height>result.height) fail(400,'Screenshot redaction lies outside its pixels');
        if (rectangles.length) {
          if (typeof redactImage!=='function') fail(503,'Reviewed screenshot redaction decoder unavailable');
          const dimensions={width:result.width,height:result.height};
          result = await redactImage(result.bytes,rectangles);
          store.checkRead(actor,l);
          if (!Buffer.isBuffer(result?.bytes) || result.width!==dimensions.width || result.height!==dimensions.height) fail(415,'Screenshot redaction failed');
          verifyBrowserArtifactMedia(result.bytes,'image/png');
        }
        // Normalization strips encoded metadata; rectangles mask only the pixels
        // selected by the human. Neither is automatic credential detection.
        const bytes = result.bytes;
        store.checkRead(actor,l);
        const derivative=await stageBytes(actor,scope.project_id,scope,{kind:'screenshot_derivative',parent_id:id,idempotency_key:randomUUID(),
          sha256:browserArtifactByteHash(bytes),byte_count:bytes.length,mime_type:'image/png'},[bytes],{derivative:true});
        store.checkRead(actor,l);return derivative;
      } finally { store.closeRead(l); }
    },
    async resolveUpload(actor,scope,ref) {
      store.resolveUpload(actor,scope,ref);
      const l = store.openAssetRead(actor,scope.project_id,ref.id,'upload');
      try {
        const bytes = bytesUnderLease(actor,l);
        store.resolveUpload(actor,scope,ref);
        return {ref,bytes};
      } finally { store.closeRead(l); }
    },
    verifyRetainedUpload(actor,scope,ref) {
      store.verifyRetainedUpload(actor,scope,ref);
      const l=store.openAssetRead(actor,scope.project_id,ref.id,'upload');
      return verifyRetainedFile(actor,l,()=>store.verifyRetainedUpload(actor,scope,ref));
    },
    async resolveSourceAsset(actor,project,ref,{approved_for_model=false}={}) {
      const resolved = store.sourceAsset(actor,project,ref,{approved_for_model});
      const l = store.openAssetRead(actor,project,ref.id,'model');
      try {
        const bytes = bytesUnderLease(actor,l);
        const content=await sourceContent(bytes,ref.mime_type);
        store.checkRead(actor,l); store.sourceAsset(actor,project,ref,{approved_for_model});
        return {...resolved,content};
      } finally { store.closeRead(l); }
    },
    async modelInputs(actor,scope,refs) {
      const resolved=store.modelSources(actor,scope,refs),inputs=[];let size=0,imageBytes=0;
      for (const ref of resolved.refs) {
        const l=store.openAssetRead(actor,scope.project_id,ref.id,'model');
        try {
          store.modelSources(actor,scope,refs);
          const content=await sourceContent(bytesUnderLease(actor,l),ref.mime_type);
          store.checkRead(actor,l);store.modelSources(actor,scope,refs);
          const data=content.kind==='image'?content.bytes.toString('base64'):content.text;
          if(content.kind==='image') imageBytes+=content.bytes.length;else size+=Buffer.byteLength(data,'utf8');
          if (size>resolved.max_prompt_bytes || size>MAX_TEXT_INPUT || imageBytes>MAX_MODEL_IMAGE_BYTES)
            fail(413,'Private model sources exceed the aggregate input bound');
          inputs.push({ref,content_kind:content.kind,content_sha256:browserArtifactByteHash(content.kind==='image'?content.bytes:Buffer.from(content.text,'utf8')),
            image_mime_type:content.kind==='image'?content.mime_type:null,image_base64:content.kind==='image'?data:null,
            text:content.kind==='text'?data:null});
        } finally {store.closeRead(l);}
      }
      store.modelSources(actor,scope,refs);return inputs;
    },
    async clipboardImport(actor,scope,input) {
      const v = parse(z.object({text:z.string().min(1).refine(s=>Buffer.byteLength(s,'utf8')<=65536)}).strict(),input);
      const bytes = Buffer.from(v.text,'utf8');
      return stageBytes(actor,scope.project_id,scope,{idempotency_key:randomUUID(),mime_type:'text/plain',
        byte_count:bytes.length,sha256:browserArtifactByteHash(bytes)},[bytes],{humanClipboard:true});
    },
    clipboardExport(actor,scope,id) {
      const l = store.openRead(actor,scope,id,'clipboard');
      try { return {text:text(bytesUnderLease(actor,l))}; }
      finally { store.closeRead(l); }
    },
    resolveClipboard(actor,scope,id) {
      const l=store.openRead(actor,scope,id,'clipboard_worker');
      try {return {id,sha256:l.sha256,bytes:bytesUnderLease(actor,l)};}
      finally {store.closeRead(l);}
    },
    verifyRetainedClipboard(actor,scope,ref) {
      store.verifyRetainedClipboard(actor,scope,ref);
      const l=store.openRead(actor,scope,ref.id,'review');
      return verifyRetainedFile(actor,l,()=>store.verifyRetainedClipboard(actor,scope,ref));
    },
    async stageInputDraft(actor,scope,input) {
      const v=parse(z.object({target_ref:z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
        snapshot_ref:z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
        text:z.string().min(1).refine(s=>s.isWellFormed()&&Buffer.byteLength(s,'utf8')<=12000),purpose:z.string().trim().min(1).max(500)}).strict(),input);
      const bytes=Buffer.from(v.text,'utf8'),artifact=await stageBytes(actor,scope.project_id,scope,{idempotency_key:randomUUID(),
        mime_type:'text/plain',byte_count:bytes.length,sha256:browserArtifactByteHash(bytes),target_ref:v.target_ref,snapshot_ref:v.snapshot_ref,purpose:v.purpose},[bytes],{inputDraft:true});
      return {artifact_ref:{id:artifact.id,sha256:artifact.sha256,mime_type:artifact.mime_type,byte_count:artifact.byte_count},
        target_ref:v.target_ref,snapshot_ref:v.snapshot_ref,purpose_sha256:browserArtifactByteHash(Buffer.from(v.purpose,'utf8')),requires_review:true};
    },
    async stageObservation(actor,scope,input) {
      const v=parse(z.object({snapshot_ref:z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
        text:z.string().min(1).refine(s=>s.isWellFormed()&&!!s.trim()&&Buffer.byteLength(s,'utf8')<=4000),
        origin:z.string().nullable(),url_sha256:z.string().nullable(),chunker_version:z.literal('browser-text.v1')}).strict(),input);
      const bytes=Buffer.from(v.text,'utf8'),artifact=await stageBytes(actor,scope.project_id,scope,{idempotency_key:randomUUID(),
        mime_type:'text/plain',byte_count:bytes.length,sha256:browserArtifactByteHash(bytes),snapshot_ref:v.snapshot_ref,
        origin:v.origin,url_sha256:v.url_sha256,chunker_version:v.chunker_version},[bytes],{observation:true});
      return {artifact_ref:{id:artifact.id,sha256:artifact.sha256,mime_type:artifact.mime_type,byte_count:artifact.byte_count}};
    },
    observationInputs(actor,scope,refs) {
      const resolved=store.observationSources(actor,scope,refs),inputs=[];let size=0;
      for(const ref of resolved.refs){
        const l=store.openRead(actor,scope,ref.id,'model');
        try {
          store.observationSources(actor,scope,refs);
          const bytes=bytesUnderLease(actor,l),value=text(bytes);size+=bytes.length;
          if(size>16000||size>resolved.max_prompt_bytes)fail(413,'Page sources exceed the aggregate model input bound');
          store.checkRead(actor,l);store.observationSources(actor,scope,refs);
          inputs.push({ref,content_kind:'text',content_sha256:browserArtifactByteHash(bytes),text:value,image_base64:null,image_mime_type:null});
        }finally{store.closeRead(l);}
      }
      store.observationSources(actor,scope,refs);return inputs;
    },
    observationStatus(actor,scope,refs) {
      // The whole request first checks current access. Individual retained
      // sources can be absent/expired without hiding that from the source ledger.
      store.observationSources(actor,scope,[],{model:false});
      const pinned=parse(z.array(z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),
        mime_type:z.literal('text/plain'),byte_count:z.number().int().min(1).max(4000)}).strict()).max(100)
        .refine(v=>new Set(v.map(r=>r.id)).size===v.length),refs);
      const status=pinned.map(ref=>{
        let l;
        try {store.observationSources(actor,scope,[ref],{model:false});l=store.openRead(actor,scope,ref.id,'review');
          bytesUnderLease(actor,l);return {id:ref.id,state:'available',code:null};}
        catch {return {id:ref.id,state:'unavailable',code:'PRIVATE_SOURCE_UNAVAILABLE'};}
        finally {if(l)store.closeRead(l);}
      });
      store.observationSources(actor,scope,[],{model:false});return status;
    },
    approveInputDraft(actor,scope,input) {return store.approveInputDraft(actor,scope,input);},
    resolveInputDraft(actor,scope,input,bindings={}) {
      const proof=store.resolveInputDraft(actor,scope,input,bindings),l=store.openRead(actor,scope,input.artifact_ref.id,'input');
      try {const bytes=bytesUnderLease(actor,l);store.resolveInputDraft(actor,scope,input,bindings);return {...proof,bytes};}
      finally {store.closeRead(l);}
    },
    verifyRetainedInputDraft(actor,scope,input,bindings={}) {
      store.verifyRetainedInputDraft(actor,scope,input,bindings);
      const l=store.openRead(actor,scope,input.artifact_ref.id,'review');
      return verifyRetainedFile(actor,l,()=>store.verifyRetainedInputDraft(actor,scope,input,bindings));
    },
    async serve(actor,{project_id,scope=null,id,purpose='download'},req,res) {
      if (req.headers?.range || req.headers?.['if-none-match'] || req.headers?.['if-modified-since'] || req.headers?.['if-range'])
        fail(416,'Conditional and range requests are not supported');
      const l = scope?store.openRead(actor,scope,id,purpose):store.openAssetRead(actor,project_id,id,purpose);
      try {
        const bytes = bytesUnderLease(actor,l);
        const ext = ({'application/pdf':'pdf','text/plain':'txt','text/csv':'csv','image/png':'png','image/jpeg':'jpg'})[l.mime_type];
        res.set('Content-Type',l.mime_type); res.set('Content-Disposition',`attachment; filename="${id}.${ext}"`);
        res.set('X-Content-Type-Options','nosniff'); res.set('Content-Security-Policy',"default-src 'none'; sandbox");
        res.set('Cache-Control','no-store, private'); res.set('Pragma','no-cache');
        res.set('Content-Length',String(bytes.length)); res.set('Accept-Ranges','none');
        if (req.method==='HEAD') return res.status(200).end();
        for (let p=0;p<bytes.length;p+=65536) {
          if (res.destroyed) break;
          store.checkRead(actor,l);
          if (!res.write(bytes.subarray(p,p+65536))) await new Promise((resolve,reject)=> {
            const cleanup=()=> { clearTimeout(timer); res.off('drain',done); res.off('close',done); res.off('error',bad); };
            const done=()=> { cleanup(); resolve(); },bad=()=> { cleanup(); reject(new Error('Private file transfer failed')); };
            const timer=setTimeout(bad,10000); res.once('drain',done); res.once('close',done); res.once('error',bad);
          });
          await new Promise(resolve=>setImmediate(resolve));
        }
        store.checkRead(actor,l); res.end();
      } catch (e) { if (res.headersSent) res.destroy?.(); throw e; }
      finally { store.closeRead(l); }
    },
    maintenance({apply=false,...input}={}) {
      const plan = store.maintenancePlan(input);
      return apply?{...plan,results:plan.items.map(item=> {
        try { return store.maintenanceApply(item.artifact_id,id=>files.remove(id)); }
        catch { return {artifact_id:item.artifact_id,outcome:'retry'}; }
      })}:plan;
    },
  };
}
