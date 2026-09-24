import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import multer from 'multer';
import http from 'node:http';
import net from 'node:net';
import {mkdtemp,readdir,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import cron from 'node-cron';
import {multipartLimits} from '../lib/multipart-limits.js';
import {setup} from './helpers/sso-fixture.js';
const {sendEmail}=await import('../lib/notification-dispatch.js');

test('real Multer disk uploads preserve limits and clean malformed/aborted requests',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pp-upload-dependency-'));
 const app=express();const upload=multer({dest:dir,limits:multipartLimits(1024)});
 app.post('/',upload.single('file'),async(req,res)=>{if(req.file){assert.equal((await readFile(req.file.path)).length,2);await rm(req.file.path);}res.json({ok:true});});
 app.use((e,req,res,next)=>res.status(e.code==='LIMIT_FILE_SIZE'?413:400).json({error:e.code||'invalid multipart'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}`;
 try{
 for(const [length,status] of [[2,200],[2048,413]]){const body=new FormData();body.set('file',new Blob(['x'.repeat(length)]),'a.bin');assert.equal((await fetch(url,{method:'POST',body})).status,status);}
 // Bounded adversarial field index, in the isolated node:test worker.
 const raw='--bound\r\nContent-Disposition: form-data; name="a[999999999]"\r\n\r\nx\r\n--bound--\r\n';
 const bounded=await fetch(url,{method:'POST',headers:{'content-type':'multipart/form-data; boundary=bound'},body:raw});assert.equal(bounded.status,400);assert.equal((await bounded.json()).error,'LIMIT_FIELD_ARRAY_INDEX');
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'multipart/form-data; boundary=bound'},body:raw.slice(0,-12)})).status,400);
 const req=http.request(url,{method:'POST',headers:{'content-type':'multipart/form-data; boundary=bound','content-length':100000}});req.on('error',()=>{});
 req.write('--bound\r\nContent-Disposition: form-data; name="file"; filename="abort.bin"\r\nContent-Type: application/octet-stream\r\n\r\nx');
 await pause(50);req.destroy();
 for(let i=0;i<100&&(await readdir(dir)).length;i++)await pause(10);
 assert.deepEqual(await readdir(dir),[]);
 const body=new FormData();body.set('file',new Blob(['ok']),'ok.bin');assert.equal((await fetch(url,{method:'POST',body})).status,200);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('real notification SMTP delivery preserves envelope and rejects header injection',{timeout:10000},async()=>{
 const f=await setup();const commands=[],messages=[];const sockets=new Set();
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('220 fixture ESMTP\r\n');let pending='',data=false,body=[];
 socket.on('data',chunk=>{pending+=chunk.toString();let end;while((end=pending.indexOf('\r\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+2);if(data){if(line==='.') {messages.push(body.join('\r\n'));body=[];data=false;socket.write('250 accepted\r\n');}else body.push(line);continue;}commands.push(line);if(line.startsWith('EHLO'))socket.write('250 fixture\r\n');else if(line==='DATA'){data=true;socket.write('354 send data\r\n');}else if(line==='QUIT'){socket.end('221 bye\r\n');}else socket.write('250 ok\r\n');}});});
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const r=await sendEmail({config:{host:'127.0.0.1',port:server.address().port,secure:false,from:'sender@example.com',to:['recipient@example.com']}},{subject:'Notice\r\nBcc: attacker@example.com',text:'Fixture notification'});assert.equal(r.ok,true,JSON.stringify(r));assert(commands.includes('RCPT TO:<recipient@example.com>'));assert(!commands.some(x=>x.includes('attacker')));assert.match(messages[0],/Fixture notification/);assert(!/^Bcc:/mi.test(messages[0]));}
 finally{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));await f.close();}
});

test('cron v4 schedules and fully destroys replacement tasks',()=>{const t=cron.schedule('0 0 1 1 *',()=>{throw new Error('Must not run immediately');},{timezone:'UTC'});assert.equal(t.getStatus(),'idle');assert(cron.getTasks().has(t.id));t.destroy();assert.equal(t.getStatus(),'destroyed');assert(!cron.getTasks().has(t.id));});
