// Opt-in disposable real OpenBao. OIDC provider responses are explicitly scripted;
// this does not claim a real Keycloak, PostgreSQL, Docker or Caddy deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { generateKeyPairSync,sign } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb,inputFor } from './helpers/openbao-fixture.js';
import { save,readOpenBao,acknowledge,review,secrets,putSecrets } from '../lib/setup-engine/openbao-store.js';
import { initialize } from '../lib/setup-engine/openbao-handoff.js';
import { createClient,status,ok } from '../lib/setup-engine/openbao-api.js';
import { namesFor,policyFor,humanRoleFor,machineRoleFor,callbackFor,roleFor,databaseDetails } from '../lib/setup-engine/openbao-logic.js';
import { verifyMachine,assertFields } from '../lib/setup-engine/openbao-access.js';
const enabled=process.env.G6_BAO_BINARY&&process.env.G6_OPENPGP_MODULE;
const job={fence(){},checkpoint(){}};
test('G6 real OpenBao 2.6.2: PGP init/handoff, restart/seal/unseal, AppRole allow/deny and OIDC mapped/unmapped', {skip:!enabled,timeout:120000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'g6-bao-real-')),db=makeDb(),origin='http://127.0.0.1:18200',api=createClient(origin,{local:true});let bao,provider,phase='starting';
  const start=async()=>{bao=spawn(process.env.G6_BAO_BINARY,['server','-config='+join(dir,'bao.json')],{stdio:['ignore','ignore','ignore']});for(let i=0;i<80;i++){if(bao.exitCode!==null)throw Error('Disposable OpenBao exited before readiness');if((await status(api)).state!=='unavailable')return;await new Promise(r=>setTimeout(r,100));}throw Error('Disposable OpenBao never became available');};
  const stop=async()=>{if(bao&&bao.exitCode===null){const ended=once(bao,'exit');bao.kill('SIGTERM');await ended;}bao=null;};
  try{
    mkdirSync(join(dir,'data'));mkdirSync(join(dir,'pgp'),{mode:0o700});
    const pgp=await import(process.env.G6_OPENPGP_MODULE),privateKeys=[],keys=[];
    for(let i=0;i<3;i++){const generated=await pgp.generateKey({type:'rsa',rsaBits:2048,userIDs:[{name:'G6 '+i,email:`g6-${i}@invalid.test`}],format:'object'});privateKeys.push(generated.privateKey);keys.push(Buffer.from(generated.publicKey.write()).toString('base64'));}
    const input={...inputFor('install'),pgpKeys:keys,rootPgpKey:keys[0]};save(db,input);
    writeFileSync(join(dir,'bao.json'),JSON.stringify({disable_mlock:true,api_addr:origin,cluster_addr:'https://127.0.0.1:18201',storage:{raft:{path:join(dir,'data'),node_id:'g6-test'}},listener:{tcp:{address:'127.0.0.1:18200',cluster_address:'127.0.0.1:18201',tls_disable:true}},log_level:'error'}));
    await start();assert.equal((await status(api)).state,'uninitialized');
    phase='handoff';await initialize(db,readOpenBao(db),api,{job,recoveryRoot:join(dir,'recovery')});
    const r=readOpenBao(db),handoff=JSON.parse(readFileSync(join(dir,'recovery',r.credential_ref+'.json')));
    const decrypt=async(value,i)=>{const message=await pgp.readMessage({binaryMessage:Buffer.from(value,'base64')});return (await pgp.decrypt({message,decryptionKeys:privateKeys[i]})).data.trim();};
    const shares=await Promise.all(handoff.shares.map(decrypt)),root=await decrypt(handoff.root,0);
    // Values are never written to test evidence, job rows or browser storage.
    assert.equal((await status(api)).state,'sealed');for(const key of shares.slice(0,2))ok(await api('/v1/sys/unseal',{method:'POST',body:{key}}));
    for(let i=0;i<50;i++){if((await api('/v1/sys/health')).status===200)break;await new Promise(r=>setTimeout(r,100));}
    assert.equal((await status(api)).state,'unsealed');acknowledge(db,{revision:1,reviewToken:review(db).reviewToken,reviewed:true,receipt:handoff.receipt});
    await stop();await start();assert.equal((await status(api)).state,'sealed');await initialize(db,readOpenBao(db),api,{job,recoveryRoot:join(dir,'recovery')});for(const key of shares.slice(0,2))ok(await api('/v1/sys/unseal',{method:'POST',body:{key}}));
    for(let i=0;i<50;i++){if((await api('/v1/sys/health')).status===200)break;await new Promise(r=>setTimeout(r,100));}
    phase='machine-access';const n=namesFor(r),v=secrets(db,r),rootApi=(p,o={})=>api('/v1/'+p,{...o,token:root});
    ok(await rootApi('sys/auth/'+n.approle,{method:'POST',body:{type:'approle',description:r.credential_ref}}));ok(await rootApi('sys/auth/'+n.oidc,{method:'POST',body:{type:'oidc',description:r.credential_ref}}));
    for(const name of [n.machine,n.human])ok(await rootApi('sys/policies/acl/'+name,{method:'PUT',body:{policy:policyFor(r)}}));
    ok(await rootApi(`auth/${n.approle}/role/workload`,{method:'POST',body:machineRoleFor(r)}));const roleId=ok(await rootApi(`auth/${n.approle}/role/workload/role-id`)).data.role_id;assert.equal((await rootApi(`auth/${n.approle}/role/workload/secret-id/lookup`,{method:'POST',body:{secret_id:v.machine}})).status,204);ok(await rootApi(`auth/${n.approle}/role/workload/custom-secret-id`,{method:'POST',body:{secret_id:v.machine,metadata:JSON.stringify({owner:r.credential_ref})}}));putSecrets(db,r,{...v,roleId});
    const mt=await verifyMachine(r,secrets(db,r),api);ok(await api('/v1/auth/token/revoke-self',{method:'POST',token:mt}));assert.equal((await api('/v1/auth/token/lookup-self',{token:mt})).status,403);
    phase='oidc';const pair=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...pair.publicKey.export({format:'jwk'}),kid:'g6',use:'sig',alg:'RS256'};let claims={},issuer;
    provider=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/.well-known/openid-configuration')return res.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post']}));if(req.url==='/jwks')return res.end(JSON.stringify({keys:[jwk]}));if(req.url==='/token'){const now=Math.floor(Date.now()/1000),head=Buffer.from(JSON.stringify({alg:'RS256',kid:'g6'})).toString('base64url'),payload=Buffer.from(JSON.stringify({iss:issuer,aud:r.config.clientId,sub:'g6-disposable-user',iat:now,exp:now+120,...claims})).toString('base64url'),text=head+'.'+payload;return res.end(JSON.stringify({access_token:'disposable-provider-token',token_type:'Bearer',expires_in:120,id_token:text+'.'+sign('RSA-SHA256',Buffer.from(text),pair.privateKey).toString('base64url')}));}res.statusCode=404;res.end('{}');});provider.listen(0,'127.0.0.1');await once(provider,'listening');issuer=`http://127.0.0.1:${provider.address().port}`;
    const testR={...r,config:{...r.config,issuer}};
    ok(await rootApi(`auth/${n.oidc}/config`,{method:'POST',body:{oidc_discovery_url:issuer,oidc_client_id:r.config.clientId,oidc_client_secret:v.client,bound_issuer:issuer,default_role:'mapped'}}));ok(await rootApi(`auth/${n.oidc}/role/mapped`,{method:'POST',body:humanRoleFor(testR)}));
    assertFields(ok(await rootApi(`auth/${n.oidc}/role/mapped`)).data,humanRoleFor(testR),'Live human role');
    for(const mapped of [true,false]){const u=ok(await api(`/v1/auth/${n.oidc}/oidc/auth_url`,{method:'POST',body:{role:'mapped',redirect_uri:callbackFor(testR)}}))?.data?.auth_url;assert(u,'Real OpenBao did not supply an authorization URL');const url=new URL(u);claims={nonce:url.searchParams.get('nonce'),groups:[mapped?r.config.group:'/unmapped']};const result=await api(`/v1/auth/${n.oidc}/oidc/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'disposable-code'})}`);if(mapped){assert.equal(result.status,200);assert.deepEqual(result.body.auth.policies,[n.human]);ok(await api('/v1/auth/token/revoke-self',{method:'POST',token:result.body.auth.client_token}));}else assert([400,403].includes(result.status));}
    // Real database engine API schema/readback only; PostgreSQL is unavailable.
    ok(await rootApi('sys/mounts/'+n.database,{method:'POST',body:{type:'database',description:r.credential_ref}}));
    ok(await rootApi(`${n.database}/config/selected`,{method:'POST',body:{plugin_name:'postgresql-database-plugin',allowed_roles:['reader'],...databaseDetails(r),password:'disposable-not-connected',verify_connection:false}}));
    assertFields(ok(await rootApi(`${n.database}/config/selected`)).data.connection_details,databaseDetails(r),'Live database TLS and SCRAM configuration');
    ok(await rootApi(`${n.database}/roles/reader`,{method:'POST',body:roleFor(r)}));
    assertFields(ok(await rootApi(`${n.database}/roles/reader`)).data,roleFor(r),'Live database role schema');
    ok(await rootApi('auth/token/revoke-self',{method:'POST'}));assert.equal((await rootApi('auth/token/lookup-self')).status,403);
    const evidence=JSON.stringify([db.prepare('SELECT * FROM setup_openbao').all(),db.prepare('SELECT * FROM setup_jobs').all(),db.prepare('SELECT * FROM setup_job_events').all()]);for(const value of [root,...shares,v.machine])assert(!evidence.includes(value));
  }catch(e){throw Object.assign(e,{g6Phase:phase});}finally{if(provider)await new Promise(r=>provider.close(r));await stop();db.close();rmSync(dir,{recursive:true,force:true});}
});
