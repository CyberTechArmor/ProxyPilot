// Real loopback OpenBao basic profile; the discovery-only IdP is scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb,inputFor } from './helpers/openbao-fixture.js';
import { save,readOpenBao,secrets } from '../lib/setup-engine/openbao-store.js';
import { createClient,status,ok } from '../lib/setup-engine/openbao-api.js';
import { bootstrap,verifyMachine,verifyAccess } from '../lib/setup-engine/openbao-access.js';
import { namesFor } from '../lib/setup-engine/openbao-logic.js';
test('FP real OpenBao basic bootstrap: scoped KV read/denial, root retirement and preserved machine credential after restart',{skip:!process.env.G6_BAO_BINARY,timeout:60000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'fp-bao-')),db=makeDb(),origin='http://127.0.0.1:18200',api=createClient(origin,{local:true});let child,provider;
 const start=async()=>{child=spawn(process.env.G6_BAO_BINARY,['server','-config='+join(root,'bao.json')],{stdio:'ignore'});for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('OpenBao exited');if((await status(api)).state!=='unavailable')return;await new Promise(r=>setTimeout(r,100));}throw Error('OpenBao startup timeout');};
 const stop=async()=>{if(child?.exitCode===null){const end=once(child,'exit');child.kill('SIGTERM');await end;}child=null;};
 try{
  mkdirSync(join(root,'data'));writeFileSync(join(root,'bao.json'),JSON.stringify({disable_mlock:true,api_addr:origin,cluster_addr:'https://127.0.0.1:18201',storage:{raft:{path:join(root,'data'),node_id:'fp-basic'}},listener:{tcp:{address:'127.0.0.1:18200',cluster_address:'127.0.0.1:18201',tls_disable:true}},log_level:'error'}));
  await start();const init=ok(await api('/v1/sys/init',{method:'POST',body:{secret_shares:3,secret_threshold:2}}));const shares=init.keys_base64,rootToken=init.root_token;
  const unseal=async()=>{for(const key of shares.slice(0,2))ok(await api('/v1/sys/unseal',{method:'POST',body:{key}}));for(let i=0;i<50;i++){if((await api('/v1/sys/health')).status===200)return;await new Promise(r=>setTimeout(r,100));}};await unseal();
  let issuer;const pair=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...pair.publicKey.export({format:'jwk'}),kid:'fp-basic',alg:'RS256',use:'sig'};
  provider=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/jwks'?{keys:[jwk]}:{issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']}));});provider.listen(0,'127.0.0.1');await once(provider,'listening');issuer=`http://127.0.0.1:${provider.address().port}`;
  const input={...inputFor('install'),basic:true,database:undefined,initialize:false,pgpKeys:undefined,rootPgpKey:undefined};save(db,input);let r=readOpenBao(db);db.prepare('UPDATE setup_openbao SET config_json=?').run(JSON.stringify({...r.config,issuer}));r=readOpenBao(db);
  const before=secrets(db,r).machine;await bootstrap(db,r,{bootstrapToken:rootToken},api,{job:{fence(){},checkpoint(){}},verifyDatabase(){throw Error('Basic setup must not require a database fixture');}});r=readOpenBao(db);assert(r.bootstrap_complete);assert.equal((await api('/v1/auth/token/lookup-self',{token:rootToken})).status,403);
  const verify=async()=>{const token=await verifyMachine(r,secrets(db,r),api);const access=await verifyAccess(r,token,api);assert(access.machinePolicy);const n=namesFor(r);assert.equal(ok(await api(`/v1/${n.prefix}-kv/data/health`,{token})).data.data.owner,r.credential_ref);assert.equal((await api(`/v1/${n.prefix}-kv/data/unrelated`,{token})).status,403);ok(await api('/v1/auth/token/revoke-self',{method:'POST',token}));};await verify();
  await stop();await start();assert.equal((await status(api)).state,'sealed');await unseal();await verify();assert.equal(secrets(db,r).machine,before);
  const publicData=JSON.stringify([db.prepare('SELECT * FROM setup_openbao').all(),db.prepare('SELECT * FROM setup_jobs').all()]);for(const secret of [rootToken,...shares,before])assert(!publicData.includes(secret));
 }finally{if(provider)await new Promise(r=>provider.close(r));await stop();db.close();rmSync(root,{recursive:true,force:true});}
});
