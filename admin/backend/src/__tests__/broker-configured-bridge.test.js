// Actual configured service + real OIDC signatures + independently signed
// authority lease. Only vault/upstream are explicit disposable memory fixtures.
import {test} from 'node:test';import assert from 'node:assert/strict';import https from 'node:https';import net from 'node:net';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {randomUUID,generateKeyPairSync,sign,X509Certificate,createHash} from 'node:crypto';
import {createRemoteBrokerBridge} from '../lib/credential-broker-remote.js';
const root=process.env.BROKER_SERVICE_TEST_ROOT?pathToFileURL(process.env.BROKER_SERVICE_TEST_ROOT+'/'):new URL('../../../../services/credential-broker/',import.meta.url);
const {createConfiguredService}=await import(new URL('configured-service.mjs',root));const {startOidcFixture}=await import(new URL('fixtures/oidc.mjs',root));const {canonical}=await import(new URL('schema.mjs',root));
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const request=(url,ca,{method='GET',headers={},data,client={}}={})=>new Promise((resolve,reject)=>{const r=https.request(url,{ca,...client,method,headers:{...(data?{'Content-Type':'application/json'}:{}),...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,json:()=>JSON.parse(text)}));});r.on('error',reject);r.end(data?JSON.stringify(data):undefined);});
const cookie=(r,name)=>r.headers['set-cookie'].find(x=>x.startsWith(name+'=')).split(';')[0];
test('dashboard bridge consumes actual configured capabilities and delegated RPC while worker remains unavailable',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'configured-dashboard-')),idp=await startOidcFixture();let service;
 try {
 const file=(name,value)=>{const p=join(dir,name);writeFileSync(p,value,{mode:0o600});return p;};
 const keyFile=file('tls.key',idp.key),certFile=file('tls.cert',idp.cert),client={key:idp.key,cert:idp.cert};
 const fingerprint=createHash('sha256').update(new X509Certificate(idp.cert).raw).digest('hex');
 const keys=generateKeyPairSync('ed25519'),owner=randomUUID(),resource=randomUUID(),listeners={};
 for(const role of ['human','management','agent']){const p=await port();listeners[role]={origin:`https://127.0.0.1:${p}`,host:'127.0.0.1',port:p,tls:{key_file:keyFile,cert_file:certFile,ca_file:certFile}};}
 // Distinct cert pins are required; create publisher cert separately.
 const {execFileSync}=await import('node:child_process');const {readFileSync}=await import('node:fs');
 const pubKey=join(dir,'publisher.key'),pubCert=join(dir,'publisher.cert');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=publisher','-keyout',pubKey,'-out',pubCert],{stdio:'ignore'});
 const publisher={key:readFileSync(pubKey),cert:readFileSync(pubCert)},publisherPin=createHash('sha256').update(new X509Certificate(publisher.cert).raw).digest('hex');
 for(const l of Object.values(listeners))l.tls.ca_file=file('clients.ca',Buffer.concat([idp.cert,publisher.cert]));
 const config={schema_version:1,mode:'configured',state_dir:dir,listeners,clients:[{fingerprint,role:'dashboard',id:randomUUID()},{fingerprint:publisherPin,role:'publisher',id:'fixture-source'}],
 identity:{issuer:idp.issuer,authorization_endpoint:idp.issuer+'/authorize',token_endpoint:idp.issuer+'/token',jwks_endpoint:idp.issuer+'/jwks',client_id:'fixture-client',broker_origin:listeners.human.origin,dashboard_origin:'https://dashboard.example',subject_map:[{issuer:idp.issuer,subject:'fixture-user',user_id:owner}],required_acr:'fixture:mfa',max_age_seconds:300,ca_file:idp.ca_file},
 authority:{sources:[{id:'fixture-source',public_key:keys.publicKey.export({format:'pem',type:'spki'}),kinds:['users','projects','agents','tasks','ceilings','policies']}]},
 vault:{origin:'https://vault.fixture.test:8200',approved_address:'127.0.0.1',ca_file:certFile,mount:'fractionate-broker-kv',reader:{role_id_file:file('read.role','fixture'),secret_id_file:file('read.secret','fixture')},enroller:{role_id_file:file('write.role','fixture'),secret_id_file:file('write.secret','fixture')},slots:[{owner_id:owner,credential_id:randomUUID()}]},upstream:{origin:'https://ledger.fixture.test:8443',approved_address:'127.0.0.1',ca_file:certFile}};
 let probe=true;service=await createConfiguredService({config,dependencies:{testOnly:true,probeVault:async()=>probe,vault:{write:async()=>({version:1}),read:async()=>{throw Error();}},upstream:{execute:async()=>{throw Error();}}}});await service.start();
 const bridge=createRemoteBrokerBridge({version:1,management_origin:listeners.management.origin,human_origin:listeners.human.origin,ca_file:certFile,cert_file:certFile,key_file:keyFile});
 const unavailable=await bridge.capabilities({force:true});assert.equal(unavailable.mode,'configured');assert.equal(unavailable.ready,false);assert.equal(unavailable.intake_enabled,false);
 const challenge=(await request(listeners.management.origin+'/v1/authority/challenge',idp.cert,{client:publisher})).json().challenge;
 const envelope={version:'authority.v1',source_id:'fixture-source',sequence:1,challenge,issued_at:Date.now()-1,expires_at:Date.now()+55000,records:{users:[{id:owner,revision:1,disabled:false}],projects:[],agents:[],tasks:[],ceilings:[{id:randomUUID(),revision:1,user_id:owner,project_id:null,actions:['list'],connection_ids:[],adapter_ids:['synthetic-ledger-v1'],operations:['item.read'],resources:[resource],limits:{max_actions:2,max_seconds:60},expires_at:Date.now()+55000,revoked:false,grant_rights:['view','use'],manage_actions:[]}],policies:[]}};
 envelope.signature=sign(null,Buffer.from(canonical(envelope)),keys.privateKey).toString('base64url');assert.equal((await request(listeners.management.origin+'/v1/authority/snapshot',idp.cert,{client:publisher,method:'POST',data:envelope})).status,200);
 const caps=await bridge.capabilities({force:true});assert.equal(caps.mode,'configured');assert.equal(caps.ready,true);assert.equal(caps.reason,'WORKER_UNAVAILABLE');assert.equal(caps.intake_enabled,false);assert.equal(caps.execution_enabled,false);
 const human=listeners.human.origin,start=await request(human+'/auth/login',idp.cert),authorize=await request(start.headers.location,idp.cert),done=await request(authorize.headers.location,idp.cert,{headers:{Cookie:cookie(start,'__Host-fractionate-login')}});
 const humanCookie=cookie(done,'__Host-fractionate-human'),session=(await request(human+'/auth/session',idp.cert,{headers:{Cookie:humanCookie}})).json();
 const delegation=(await request(human+'/auth/delegations',idp.cert,{method:'POST',headers:{Cookie:humanCookie,Origin:human,'X-CSRF-Token':session.csrf_token},data:{actions:['list']}})).json().bearer;
 assert.deepEqual((await bridge.request({action:'list',actor:{id:owner},query:{},delegation})).connections,[]);
 await assert.rejects(()=>bridge.request({action:'list',actor:{id:randomUUID()},query:{},delegation}),e=>e.code==='NOT_PERMITTED');
 }finally{await service?.close();await idp.close();rmSync(dir,{recursive:true,force:true});}
});
