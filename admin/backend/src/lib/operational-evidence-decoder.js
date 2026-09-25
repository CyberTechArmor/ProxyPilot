import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fail, OperationsError } from './operational-projects-logic.js';

const worker=fileURLToPath(new URL('./operational-evidence-decoder-worker.cjs',import.meta.url));
let busy=false;
// A reviewed executable wrapper must establish OS limits before exec'ing the
// supplied fixed Node argv. A test launcher is injectable, never HTTP-configured.
export function createEvidenceDecoder({runner,launch,timeoutMs=10000}={}) {
  if(!launch && (!runner||!path.isAbsolute(runner))) throw new Error('Reviewed decoder boundary required');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000) throw new Error('Invalid decoder deadline');
  return async bytes=>{
    if(busy) fail(429,'Decoder busy');
    if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>8388608) fail(400,'Invalid image');
    busy=true;
    return new Promise((resolve,reject)=>{
      let child,done=false,closed=false,total=0,timer;const chunks=[];
      const bad=()=>{
        if(done)return;
        done=true;clearTimeout(timer);
        try { child?.kill('SIGKILL'); } catch { /* keep the refusal; slot waits for close */ }
        reject(new OperationsError(400,'Image validation failed'));
      };
      try {
        const args=['--max-old-space-size=256',worker];
        child=launch ? launch(process.execPath,args) : spawn(runner,[process.execPath,...args],{shell:false,windowsHide:true,env:{},stdio:['pipe','pipe','ignore']});
        child.on('error',bad);child.stdin.on('error',bad);
        child.stdout.on('data',b=>{total+=b.length;if(total>8388864)bad();else if(!done)chunks.push(b);});
        child.on('close',code=>{
          closed=true;busy=false;clearTimeout(timer);
          if(done)return;
          if(code!==0) return bad();
          try {
            const output=Buffer.concat(chunks),end=output.indexOf(10);
            if(end<1||end>255) return bad();
            const info=JSON.parse(output.subarray(0,end));
            if(!info||Object.keys(info).sort().join(',')!=='height,mime,width'||
              !['image/png','image/jpeg'].includes(info.mime)||!Number.isInteger(info.width)||!Number.isInteger(info.height)||
              info.width<1||info.height<1||info.width>8192||info.height>8192||info.width*info.height>16000000) return bad();
            const clean=output.subarray(end+1);
            if(!clean.length||clean.length>8388608) return bad();
            done=true;resolve({...info,bytes:clean});
          } catch {bad();}
        });
        timer=setTimeout(bad,timeoutMs);
        child.stdin.end(bytes);
      } catch {if(!child||closed)busy=false;bad();}
    });
  };
}
