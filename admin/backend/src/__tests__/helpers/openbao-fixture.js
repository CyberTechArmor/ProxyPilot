import { makeDb as baseDb,apiFixture } from './pomerium-fixture.js';
import { dockerFixture as g5Docker } from './infisical-fixture.js';
import { OPENBAO_SCHEMA,readOpenBao,secrets } from '../../lib/setup-engine/openbao-store.js';
import { OPENBAO_IMAGE,namesFor,machineRoleFor,humanRoleFor } from '../../lib/setup-engine/openbao-logic.js';
export {apiFixture};
export const configInput={expectedPlanRevision:1,expectedRevision:0,connectionId:'kc-aabbccddeeff',clientId:'proxypilot-openbao',clientSecret:'g6-disposable-client-secret',group:'/proxypilot-openbao',database:{host:'10.20.30.50',port:5432,name:'pp_g6_test',username:'bao_g6_admin',disposable:true},allowedIps:['192.0.2.10'],initialize:true,pgpKeys:['A'.repeat(100),'B'.repeat(100),'C'.repeat(100)],rootPgpKey:'D'.repeat(100),reviewed:true};
export function makeDb(path=':memory:',{mode='install'}={}){const db=baseDb(path);db.exec(OPENBAO_SCHEMA);const choices=JSON.parse(db.prepare('SELECT choices_json FROM setup_platform_plan').get().choices_json);choices.openbao={mode,url:'https://bao.example.com'};db.prepare('UPDATE setup_platform_plan SET choices_json=?').run(JSON.stringify(choices));return db;}
export function inputFor(mode){const input=structuredClone(configInput);if(mode==='connect'){input.initialize=false;delete input.pgpKeys;delete input.rootPgpKey;}return input;}
export function dockerFixture(){const d=g5Docker();d.images[OPENBAO_IMAGE]={Id:'sha256:g6-openbao',Config:{Env:['PATH=/bin'],Entrypoint:['docker-entrypoint.sh'],Cmd:['server','-dev']}};const host=d.host;d.host=async args=>{const result=await host(args);if(args[1]==='create'){const name=args[args.indexOf('--name')+1],a=d.objects.container.get(name);a.HostConfig.Memory=536870912;a.HostConfig.MemorySwap=536870912;}return result;};return d;}
// Automatic custody (no pgp_keys): distinct plaintext base64 shares and the fixture root token.
export const autoShares=['QXV0b1NoYXJlT25lMTIzNDU2','QXV0b1NoYXJlVHdvMTIzNDU2','QXV0b1NoYXJlVGhyZWUxMjM0'];
export const encrypted=Buffer.concat([Buffer.from([0xc1]),Buffer.alloc(255,1)]).toString('base64');
export function baoFixture(db,{initialized=false,sealed=true}={}){const resources=new Map(),policies=new Map(),mounts={},auth={},calls=[],tokens=new Set(),secretIds=new Map(),unsealKeys=[],initBodies=[];let gen=null,genStarts=0,genRevocations=0;const genRoots=new Set();let unavailable=false,progress=0,initCount=0,cluster='g6-cluster',broad=false,revocations=0;
  const send=async(_origin,path,{method='GET',token,body}={})=>{calls.push({path,method});if(unavailable)throw Error('SENSITIVE-UPSTREAM-DO-NOT-LOG');const yes=b=>({status:200,body:b}),no=(code=403)=>({status:code,body:null}),r=readOpenBao(db),n=namesFor(r);
    if(path==='/v1/sys/seal-status')return yes({initialized,sealed:!initialized||sealed,type:'shamir',n:3,t:2,progress,version:'2.6.2',cluster_id:initialized?cluster:null});
    if(path==='/v1/sys/init'){if(initialized)return no(400);initialized=true;sealed=true;initCount++;initBodies.push(body);return yes(body.pgp_keys?{keys_base64:[encrypted,encrypted,encrypted],root_token:encrypted}:{keys_base64:[...autoShares],root_token:'g6-bootstrap-token'});}
    if(path==='/v1/sys/unseal'){if(body.reset){progress=0;return yes({sealed,progress});}unsealKeys.push(body.key);if(body.key!=='validDisposableShare12345'&&!autoShares.includes(body.key))return no(400);if(++progress>=2)sealed=false;return yes({sealed,progress});}
    if(sealed||!initialized)return no(503);
    // generate-root with a one-time pad; the shares are the automatic-custody ones.
    if(path==='/v1/sys/generate-root/attempt'){if(method==='GET')return yes({started:!!gen,progress:gen?.progress||0,required:2});if(method==='DELETE'){gen=null;return {status:204,body:null};}if(gen)return no(400);const otp='O'.repeat(8)+Math.random().toString(36).slice(2,10).padEnd(8,'x')+'P'.repeat(10);gen={nonce:'gen-nonce',otp,progress:0};genStarts++;return yes({nonce:gen.nonce,started:true,progress:0,required:2,otp,otp_length:otp.length});}
    if(path==='/v1/sys/generate-root/update'){if(!gen||body.nonce!==gen.nonce||!autoShares.includes(body.key))return no(400);if(++gen.progress<2)return yes({progress:gen.progress,complete:false});const t=('g6-generated-root-'+genRoots.size).padEnd(gen.otp.length,'z');genRoots.add(t);const enc=Buffer.from([...Buffer.from(t)].map((x,i)=>x^gen.otp.charCodeAt(i))).toString('base64');gen=null;return yes({complete:true,encoded_token:enc});}
    if(path==='/v1/sys/health')return yes({initialized:true,sealed:false,standby:false});
    if(path===`/v1/auth/${n.approle}/login`){if(body.role_id!=='g6-role-id'||!secretIds.has(body.secret_id))return no();const token='g6-machine-'+tokens.size+'-'+Date.now();tokens.add(token);return yes({auth:{client_token:token,policies:broad?[n.machine,'default']:[n.machine],lease_duration:120}});}
    const generated=genRoots.has(token),root=token==='g6-bootstrap-token'&&revocations===0||generated,machine=tokens.has(token);if(!root&&!machine)return no();
    if(path==='/v1/auth/token/revoke-self'){if(generated){genRoots.delete(token);genRevocations++;}else if(root)revocations++;else tokens.delete(token);return {status:204,body:null};}
    if(path==='/v1/auth/token/lookup-self')return yes({data:{policies:root?['root']:[n.machine]}});
    if(path==='/v1/sys/capabilities-self')return yes({data:Object.fromEntries(body.paths.map(p=>[p,[`${n.database}/creds/reader`,`${n.prefix}-kv/data/health`].includes(p)?['read']:['deny']]))});
    if(machine&&[`${n.database}/creds/not-allowed`,'sys/mounts','sys/policies/acl/default','secret/data/unrelated'].some(p=>path==='/v1/'+p))return no();
    if(path===`/v1/${n.database}/creds/reader`)return yes({data:{username:'v-g6-reader',password:'g6-dynamic-password-DO-NOT-LOG'},lease_id:n.database+'/creds/reader/opaque',lease_duration:60});
    if(path==='/v1/sys/mounts')return yes({data:mounts});if(path==='/v1/sys/auth')return yes({data:auth});
    if(path.startsWith('/v1/sys/mounts/')||path.startsWith('/v1/sys/auth/')){if(!root||method!=='POST')return no();const map=path.includes('/mounts/')?mounts:auth;map[path.split('/').at(-1)+'/']=body;return {status:204,body:null};}
    if(path.startsWith('/v1/sys/policies/acl/')){const name=path.split('/').at(-1);if(method==='PUT'){if(!root)return no();policies.set(name,body.policy);return {status:204,body:null};}return policies.has(name)?yes({data:{policy:policies.get(name)}}):no(404);}
    if(path.endsWith('/role/workload/role-id'))return yes({data:{role_id:'g6-role-id'}});
    if(path.endsWith('/secret-id/lookup'))return secretIds.has(body.secret_id)?yes({data:{metadata:{owner:r.credential_ref}}}):no(204);
    if(path.endsWith('/custom-secret-id')){if(!root)return no();secretIds.set(body.secret_id,true);return yes({data:{secret_id:body.secret_id}});}
    if(method==='POST'){if(!root)return no();if(path.endsWith('/config/selected'))resources.set(path,{plugin_name:body.plugin_name,allowed_roles:body.allowed_roles,connection_details:{connection_url:body.connection_url,username:body.username,password_authentication:body.password_authentication}});else{const sanitized={...body};delete sanitized.oidc_client_secret;resources.set(path,sanitized);}return {status:204,body:null};}
    return resources.has(path)?yes({data:resources.get(path)}):no(404);
  };
  return {get genStarts(){return genStarts;},get genRevocations(){return genRevocations;},genRoots,send,calls,unsealKeys,initBodies,resources,policies,mounts,auth,tokens,secretIds,get initCount(){return initCount;},get revocations(){return revocations;},get sealed(){return sealed;},set sealed(v){sealed=v;progress=0;},set initialized(v){initialized=v;},set unavailable(v){unavailable=v;},set cluster(v){cluster=v;},set broad(v){broad=v;},resetBootstrap(){revocations=0;}};
}
