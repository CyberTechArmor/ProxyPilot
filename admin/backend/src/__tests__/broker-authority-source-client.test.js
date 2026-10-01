import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {mkdtempSync,chmodSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createAuthoritySourceClient} from '../lib/broker-authority-source-client.js';
test('authority Unix client requires a private socket, fixed paths and bounded metadata response',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-client-')),socketPath=join(dir,'source.sock'),seen=[];let response={readiness:{ready:true}};
 const server=http.createServer((req,res)=>{seen.push(req.url);let body='';req.on('data',c=>body+=c);req.on('end',()=>res.end(JSON.stringify(response)));});await new Promise(r=>server.listen(socketPath,r));chmodSync(socketPath,0o600);
 try{const client=createAuthoritySourceClient({socketPath});assert.equal((await client.previewTask({id:randomUUID()})).readiness.ready,true);assert.equal(seen[0],'/v1/task/preview');await client.authorizeTask({id:randomUUID()});assert.equal(seen[1],'/v1/task/authorize');response={environments:[],outputs:[],credential:'SECRET'};const regs=await client.registrations({user_id:randomUUID(),project_id:randomUUID()});assert.deepEqual(regs,{environments:[],outputs:[]});
 chmodSync(socketPath,0o660);assert.throws(()=>client.previewTask({}),e=>e.code==='AUTHORITY_SOURCE_UNAVAILABLE');chmodSync(socketPath,0o600);
 response={value:'x'.repeat(70000)};await assert.rejects(()=>client.previewTask({}),e=>e.code==='AUTHORITY_SOURCE_UNAVAILABLE');
 const file=join(dir,'file');writeFileSync(file,'',{mode:0o600});assert.throws(()=>createAuthoritySourceClient({socketPath:file}).previewTask({}));
 }finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
