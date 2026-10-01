import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {startOidcFixture} from '../fixtures/oidc.mjs';
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;};
test('worker CLI starts with private file config, heartbeats without a task and stops cleanly', {timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'worker-runtime-')),fixture=await startOidcFixture();let child,server;
 try{
  let heartbeats=0;server=https.createServer({key:fixture.key,cert:fixture.cert,ca:fixture.cert,requestCert:true,rejectUnauthorized:true},(req,res)=>{assert.equal(req.url,'/v1/workloads/ready');heartbeats++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({contract_version:'broker.v1',ready:true}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const file=(name,data)=>{const p=join(dir,name);writeFileSync(p,data,{mode:0o600});return p;};
  const key=file('key.pem',fixture.key),cert=file('cert.pem',fixture.cert),state=join(dir,'state');mkdirSync(state,{mode:0o700});
  const config=file('worker.json',JSON.stringify({schema_version:1,state_dir:state,listener:{host:'127.0.0.1',port:await port(),key_file:key,cert_file:cert,ca_file:cert},broker:{agent_origin:`https://127.0.0.1:${server.address().port}`,key_file:key,cert_file:cert,ca_file:cert},dashboard_fingerprints:[new X509Certificate(fixture.cert).fingerprint256.replaceAll(':','')]}));
  child=spawn(process.execPath,[new URL('../runner-main.mjs',import.meta.url).pathname,'--config',config],{stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stderr.on('data',b=>errors+=b);
  await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error('worker did not start')),10000);child.once('exit',()=>{clearTimeout(timer);rej(Error(errors))});child.stdout.on('data',b=>{output+=b;if(output.includes('worker_started')){clearTimeout(timer);res();}});});
  assert.equal(heartbeats,1);assert.equal(JSON.parse(output.trim()).contract_version,'runner.v1');assert.ok(existsSync(join(state,'worker.db.lock')));
  const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));child.kill('SIGTERM');assert.deepEqual(await exited,{code:0,signal:null});child=undefined;
  assert.equal(existsSync(join(state,'worker.db.lock')),false);assert.equal(readFileSync(join(state,'worker.db')).includes(Buffer.from('Bearer')),false);
 }finally{child?.kill('SIGKILL');if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await fixture.close();rmSync(dir,{recursive:true,force:true});}
});
