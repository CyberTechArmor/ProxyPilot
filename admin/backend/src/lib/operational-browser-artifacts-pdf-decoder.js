import { spawn } from 'node:child_process';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fail, OperationsError } from './operational-projects-logic.js';
import { verifyBrowserArtifactMedia } from './operational-browser-artifacts-service.js';

// The reviewed executable must establish CPU/memory/process/filesystem/network
// limits before executing the fixed parser argv. No capability autodetection or
// fallback into the backend process. An injected test launcher is not release
// evidence for this production boundary.
export function createBrowserArtifactPdfDecoder({runner,launch,capability,timeoutMs=5000,maxOutputBytes=16000}={}) {
  const ready = capability==='browser-artifact-pdf-v1' && (typeof launch==='function' ||
    typeof runner==='string' && path.isAbsolute(runner)) && Number.isInteger(timeoutMs) && timeoutMs>0 && timeoutMs<=5000 &&
    Number.isInteger(maxOutputBytes) && maxOutputBytes>0 && maxOutputBytes<=16000;
  let busy = false;
  const decode = async bytes => {
    if (!ready) fail(503,'Reviewed bounded PDF decoder is unavailable');
    verifyBrowserArtifactMedia(bytes,'application/pdf');
    if (busy) fail(429,'Private PDF decoder busy');
    busy = true;
    return new Promise((resolve,reject)=> {
      let child,done=false,total=0,timer; const chunks=[];
      const bad = () => {
        if (done) return;
        done=true; clearTimeout(timer);
        try { if (child?.pid) process.kill(-child.pid,'SIGKILL'); } catch { try {child?.kill('SIGKILL');} catch { /* refuse */ } }
        reject(new OperationsError(415,'Private PDF text extraction failed or exceeded its bound'));
      };
      try {
        const args=['-enc','UTF-8','-nopgbrk','-','-'];
        child = launch?launch('/usr/bin/pdftotext',args):spawn(runner,['/usr/bin/pdftotext',...args],
          {shell:false,detached:true,env:{},stdio:['pipe','pipe','ignore']});
        child.once('error',()=> { busy=false; bad(); }); child.stdin.once('error',bad);
        child.stdout.on('data',b=> { total+=b.length; if(total>maxOutputBytes) bad(); else if(!done) chunks.push(b); });
        child.once('close',code=> {
          busy=false; clearTimeout(timer); if(done) return;
          if(code!==0) return bad();
          try {
            const value = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total));
            if (!value.trim() || value.includes('\0')) return bad();
            done=true; resolve(value);
          } catch {bad();}
        });
        timer=setTimeout(bad,timeoutMs); child.stdin.end(bytes);
      } catch { busy=false; bad(); }
    });
  };
  Object.defineProperty(decode,'ready',{value:ready});
  return decode;
}
