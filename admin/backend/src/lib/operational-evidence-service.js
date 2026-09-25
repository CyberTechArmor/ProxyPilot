import { byteHash } from './operational-evidence-files.js';
import { fail } from './operational-projects-logic.js';

export function createEvidenceService({store,files,decode,bodyTimeoutMs=30000}) {
  async function receive(req,check,expected) {
    const encoding=req.headers['content-encoding'];
    if(encoding && encoding!=='identity') fail(415,'Request compression is not supported');
    if(req.headers['content-type']!==expected.expected_mime) fail(415,'PNG or JPEG body required');
    const length=req.headers['content-length'];
    if(length!==undefined && (!/^\d+$/.test(length)||Number(length)!==expected.expected_bytes)) fail(400,'Image size mismatch');
    let size=0;const chunks=[];
    const timer=setTimeout(()=>req.destroy(),bodyTimeoutMs);
    try {
      for await(const b of req) {
        check();size+=b.length;
        if(size>expected.expected_bytes || size>8388608) fail(413,'Image too large');
        chunks.push(b);
      }
      check();
      const bytes=Buffer.concat(chunks);
      if(size!==expected.expected_bytes||byteHash(bytes)!==expected.expected_sha256) fail(400,'Image digest or size mismatch');
      return bytes;
    } finally {clearTimeout(timer);}
  }
  function put(fileId,bytes,repair=false) {
    try {return files.write(fileId,bytes);}
    catch(e) {
      // An interrupted process may already have durably written these exact
      // bytes. Never overwrite; recover only with a full digest/length check.
      if(e.code!=='EEXIST') throw e;
      const proof={byte_count:bytes.length,sha256:byteHash(bytes)};
      try {files.read(fileId,proof);return proof;}
      catch(error) {
        if(!repair) throw error;
        files.remove(fileId);return files.write(fileId,bytes);
      }
    }
  }
  return {
    async bytes(actor,project,demo,id,req) {
      const u=store.claim(actor,project,demo,id,'bytes');
      if(u.receipt) {await receive(req,()=>store.checkRetry(actor,u),u);return u.receipt;}
      try {
        const bytes=await receive(req,()=>store.check(actor,u),u);
        store.check(actor,u);
        const proof=store.withLease(actor,u,()=>put(u.input.id,bytes,u.input.state==='allocated'));
        return store.received(actor,u,proof);
      } finally {store.release(u);}
    },
    async finalize(actor,project,demo,id) {
      const u=store.claim(actor,project,demo,id,'finalize');
      if(u.receipt) return u.receipt;
      try {
        const bytes=files.read(u.input.id,{byte_count:u.expected_bytes,sha256:u.expected_sha256});
        const result=await decode(bytes);
        store.check(actor,u);
        if(result.mime!==u.expected_mime) fail(415,'Image media type mismatch');
        const proof=u.kind==='raw'?{byte_count:bytes.length,sha256:byteHash(bytes)}:
          store.withLease(actor,u,()=>put(u.output.id,result.bytes,u.output.state==='allocated'));
        return store.finalize(actor,u,{...proof,width:result.width,height:result.height,mime:u.kind==='raw'?result.mime:'image/png'});
      } catch(e) { if(e.code==='ENOENT') store.missing(u.input.id); throw e; }
      finally {store.release(u);}
    },
    async serve(actor,project,demo,id,req,res) {
      let authorized=store.download(actor,project,demo,id);
      if(req.headers.range || req.headers['if-none-match'] || req.headers['if-modified-since'] || req.headers['if-range']) fail(416,'Conditional and range requests are not supported');
      const lease=store.openRead(actor,project,demo,id);
      try {
        let bytes;
        try {bytes=files.read(authorized.file.id,authorized.object);}
        catch(e) {if(e.code==='ENOENT') store.missing(authorized.file.id);fail(410,'Evidence unavailable');}
        store.download(actor,project,demo,id);
        res.set('Content-Type',authorized.object.mime);
        res.set('Content-Disposition',`attachment; filename="${id}.${authorized.object.mime==='image/png'?'png':'jpg'}"`);
        res.set('Content-Length',String(bytes.length));
        res.set('Accept-Ranges','none');
        if(req.method==='HEAD') return res.status(200).end();
        for(let offset=0;offset<bytes.length;offset+=65536) {
          if(res.destroyed) break;
          store.checkRead(actor,project,demo,id,lease);
          if(!res.write(bytes.subarray(offset,offset+65536))) await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{cleanup();reject(new Error('Download timeout'));},10000);
            const finish=()=>{cleanup();resolve();};
            const cleanup=()=>{clearTimeout(timer);res.off('drain',finish);res.off('close',finish);};
            res.once('drain',finish);res.once('close',finish);
          });
          await new Promise(resolve=>setImmediate(resolve));
        }
        res.end();
      } finally {store.closeRead(lease);}
    },
    // Explicit invocation only. Each bounded entry is rechecked; dry-run output
    // is not deletion authority. No timer, startup sweep or recursive removal.
    maintenance({apply=false,limit=25,after=''}={}) {
      const plan=store.maintenancePlan({limit,after});
      return apply ? {...plan,results:plan.items.map(item=>{
        try {return store.maintenanceApply(item.file_id,id=>files.remove(id));}
        catch {return {file_id:item.file_id,outcome:'retry'};}
      })} : plan;
    },
  };
}
