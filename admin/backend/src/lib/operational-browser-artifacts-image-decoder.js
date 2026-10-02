import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { fail, parse, OperationsError } from './operational-projects-logic.js';
import { verifyBrowserArtifactMedia } from './operational-browser-artifacts-service.js';

const worker=fileURLToPath(new URL('./operational-browser-artifacts-image-worker.cjs',import.meta.url));
const rectanglesSchema=z.array(z.object({x:z.number().int().min(0).max(8191),y:z.number().int().min(0).max(8191),
  width:z.number().int().min(1).max(8192),height:z.number().int().min(1).max(8192)}).strict()).max(32);
export function createBrowserArtifactImageRedactor({runner,launch,capability,timeoutMs=5000}={}) {
  const ready=capability==='browser-artifact-image-redact-v1' && (typeof launch==='function' ||
    typeof runner==='string' && path.isAbsolute(runner)) && Number.isInteger(timeoutMs) && timeoutMs>0 && timeoutMs<=5000;
  let busy=false;
  const redact=async(bytes,rectangles)=> {
    if(!ready)fail(503,'Reviewed screenshot redaction decoder unavailable');
    verifyBrowserArtifactMedia(bytes,'image/png');if(bytes.length>8388608)fail(413,'Screenshot decoder size bound');
    const reviewed=parse(rectanglesSchema,rectangles);if(busy)fail(429,'Screenshot decoder busy');busy=true;
    return new Promise((resolve,reject)=> {
      let child,done=false,total=0,timer;const chunks=[];
      const bad=()=> {
        if(done)return;done=true;clearTimeout(timer);
        try{if(child?.pid)process.kill(-child.pid,'SIGKILL');}catch{try{child?.kill('SIGKILL');}catch{/* refuse */}}
        reject(new OperationsError(415,'Private screenshot redaction failed'));
      };
      try {
        const args=['--max-old-space-size=256',worker];
        child=launch?launch(process.execPath,args):spawn(runner,[process.execPath,...args],
          {shell:false,detached:true,env:{},stdio:['pipe','pipe','ignore']});
        child.once('error',()=>{busy=false;bad();});child.stdin.once('error',bad);
        child.stdout.on('data',b=>{total+=b.length;if(total>8388864)bad();else if(!done)chunks.push(b);});
        child.once('close',code=> {
          busy=false;clearTimeout(timer);if(done)return;if(code!==0)return bad();
          try {
            const output=Buffer.concat(chunks,total),p=output.indexOf(10);if(p<1||p>255)return bad();
            const info=JSON.parse(output.subarray(0,p)),clean=output.subarray(p+1);
            if(Object.keys(info).sort().join(',')!=='height,width' || !Number.isInteger(info.width)||!Number.isInteger(info.height)||
              info.width<1||info.height<1||info.width>8192||info.height>8192||info.width*info.height>16000000||clean.length>8388608)return bad();
            verifyBrowserArtifactMedia(clean,'image/png');done=true;resolve({...info,bytes:clean});
          }catch{bad();}
        });
        timer=setTimeout(bad,timeoutMs);
        child.stdin.write(JSON.stringify({rectangles:reviewed})+'\n');child.stdin.end(bytes);
      }catch{busy=false;bad();}
    });
  };
  Object.defineProperty(redact,'ready',{value:ready});return redact;
}
