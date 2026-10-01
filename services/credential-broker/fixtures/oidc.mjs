/** Disposable HTTPS OIDC issuer for integration tests. Never a production identity source. */
import https from 'node:https';
import {generateKeyPairSync,randomBytes,createHash,sign} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
export async function startOidcFixture({realm=null,users=new Map(),serviceSecret=null}={}){
 const dir=mkdtempSync(join(tmpdir(),'broker-oidc-'));execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 const key=readFileSync(join(dir,'key.pem')),cert=readFileSync(join(dir,'cert.pem'));const jwt=generateKeyPairSync('rsa',{modulusLength:2048}),wrong=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...jwt.publicKey.export({format:'jwk'}),kid:'fixture-rsa',alg:'RS256',use:'sig'};const prefix=realm?'/realms/'+realm:'';const serviceToken=randomBytes(32).toString('base64url');const codes=new Map();let issuer,overrides={},badSignature=false;let tokenRequests=0;
 const server=https.createServer({key,cert},async(req,res)=>{const url=new URL(req.url,issuer);
 if(realm&&url.pathname===prefix+'/protocol/openid-connect/token'&&req.method==='POST'){const chunks=[];for await(const b of req)chunks.push(b);const body=new URLSearchParams(Buffer.concat(chunks).toString());if(body.get('grant_type')!=='client_credentials'||body.get('client_secret')!==serviceSecret){res.writeHead(403);res.end();return;}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({access_token:serviceToken,token_type:'Bearer'}));return;}
 if(realm&&url.pathname.startsWith('/admin/realms/'+realm+'/users/')){const id=url.pathname.split('/').at(-1);if(req.headers.authorization!=='Bearer '+serviceToken){res.writeHead(403);res.end();return;}res.writeHead(users.has(id)?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(users.has(id)?{id,enabled:users.get(id)}:{}));return;}
 if(url.pathname===prefix+'/authorize'){
   const q=Object.fromEntries(url.searchParams);if(q.response_type!=='code'||q.code_challenge_method!=='S256'||q.scope!=='openid'){res.writeHead(400);res.end();return;}
   const code=randomBytes(32).toString('base64url');codes.set(code,q);const callback=new URL(q.redirect_uri);callback.searchParams.set('code',code);callback.searchParams.set('state',q.state);callback.searchParams.set('iss',issuer);res.writeHead(302,{Location:callback.href});res.end();return;
 }if(url.pathname===prefix+'/jwks'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({keys:[jwk]}));return;}
 if(url.pathname===prefix+'/token'&&req.method==='POST'){tokenRequests++;const chunks=[];for await(const b of req)chunks.push(b);const body=new URLSearchParams(Buffer.concat(chunks).toString());const flow=codes.get(body.get('code'));codes.delete(body.get('code'));if(!flow||flow.code_challenge!==createHash('sha256').update(body.get('code_verifier')||'').digest('base64url')||flow.client_id!==body.get('client_id')||flow.redirect_uri!==body.get('redirect_uri')){res.writeHead(400);res.end();return;}
 const now=Math.floor(Date.now()/1000),claims={iss:issuer,sub:'fixture-user',aud:flow.client_id,exp:now+300,iat:now,auth_time:now,acr:'fixture:mfa',nonce:flow.nonce,...overrides};const encoded=[{alg:'RS256',kid:'fixture-rsa',typ:'JWT'},claims].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');const id_token=encoded+'.'+sign('RSA-SHA256',Buffer.from(encoded),badSignature?wrong.privateKey:jwt.privateKey).toString('base64url');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id_token,token_type:'Bearer',access_token:randomBytes(32).toString('base64url')}));return;
 }res.writeHead(404);res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));issuer='https://127.0.0.1:'+server.address().port+prefix;
 return {issuer,key,cert,ca_file:join(dir,'cert.pem'),setClaims:v=>{overrides=v;},setBadSignature:v=>{badSignature=v;},get tokenRequests(){return tokenRequests;},close:async()=>{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}};
}
