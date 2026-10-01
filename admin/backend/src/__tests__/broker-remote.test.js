import {test} from 'node:test';import assert from 'node:assert/strict';
import https from 'node:https';import {mkdtempSync,readFileSync,writeFileSync,chmodSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {createRemoteBrokerBridge,configuredBrokerBridge} from '../lib/credential-broker-remote.js';
test('configured bridge validates mutual TLS, independent delegation, exact version and response bounds',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'remote-broker-'));let server;
 try {
 const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});chmodSync(key,0o600);
 let received=0,mode='ready';const delegation='x'.repeat(43),actor='fixture-user';
 server=https.createServer({key:readFileSync(key),cert:readFileSync(cert),ca:readFileSync(cert),requestCert:true,rejectUnauthorized:true},async(req,res)=>{
 assert.equal(req.socket.authorized,true);res.setHeader('Content-Type','application/json');
 if(req.url==='/v1/capabilities'){const caps={contract_version:mode==='wrong-version'?'broker.v2':'broker.v1',mode:'configured',build:'credential-broker-configured.v1',compatible:true,ready:mode!=='expired',execution_ready:mode!=='expired',intake_origin:'https://human.example',intake_enabled:true,execution_enabled:true,reason:mode==='expired'?'AUTHORITY_UNAVAILABLE':'READY',adapters:[{id:'synthetic-ledger-v1',type:'static_api_token',supported:true}]};res.end(JSON.stringify(caps));return;}
 received++;let body='';for await(const b of req)body+=b;const input=JSON.parse(body);
 if(req.headers.authorization!==`Bearer ${delegation}`||input.actor.id!==actor){res.statusCode=403;res.end(JSON.stringify({error:{code:'NOT_PERMITTED',raw:'secret'}}));return;}
 if(mode==='redirect'){res.statusCode=302;res.setHeader('Location','https://other.example');res.end('{}');return;}
 if(mode==='oversized'){res.end(JSON.stringify({value:'x'.repeat(300000)}));return;}
 res.end(JSON.stringify({contract_version:'broker.v1',connections:[],next_cursor:null}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const config={version:1,management_origin:`https://127.0.0.1:${server.address().port}`,human_origin:'https://human.example',ca_file:cert,cert_file:cert,key_file:key};
 const bridge=createRemoteBrokerBridge(config);
 await assert.rejects(()=>bridge.request({action:'list',actor:{id:actor}}),e=>e.code==='AUTH_REQUIRED');assert.equal(received,0);
 assert.deepEqual((await bridge.request({action:'list',actor:{id:actor},delegation})).connections,[]);
 await assert.rejects(()=>bridge.request({action:'list',actor:{id:'wrong-user'},delegation}),e=>e.code==='NOT_PERMITTED');
 for(mode of ['wrong-version','expired','redirect','oversized'])await assert.rejects(()=>bridge.request({action:'list',actor:{id:actor},delegation}),e=>e.code==='BROKER_UNAVAILABLE');
 mode='ready';chmodSync(key,0o644);assert.throws(()=>createRemoteBrokerBridge(config));chmodSync(key,0o600);
 assert.equal(configuredBrokerBridge({}),null);
 const path=join(dir,'config.json');writeFileSync(path,JSON.stringify({...config,unexpected:true}),{mode:0o600});assert.equal((await configuredBrokerBridge({FRACTIONATE_BROKER_CONFIG_FILE:path}).capabilities()).intake_enabled,false);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}rmSync(dir,{recursive:true,force:true});}
});

test('configuration readiness requests only selected Operations project with unchanged human delegation',async()=>{
 const {configurationConnectionReader}=await import('../lib/credential-broker-remote.js');const {randomUUID}=await import('node:crypto');
 const project=randomUUID(),actor={id:randomUUID()},delegation='transient-independent-proof';let calls=0;
 const read=configurationConnectionReader({request:async request=>{calls++;assert.deepEqual(request,{action:'list',actor:{id:actor.id},query:{project_id:project},delegation});return {connections:[]};}});
 assert.deepEqual(await read(actor,{params:{id:project},get:name=>{assert.equal(name,'X-Broker-Delegation');return delegation;}}),{connections:[]});
 assert.throws(()=>read(actor,{params:{},get:()=>delegation}));assert.throws(()=>read(actor,{params:{id:'invalid'},get:()=>delegation}));assert.equal(calls,1);assert.equal(configurationConnectionReader(null),null);
});
