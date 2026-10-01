import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {createIdentity} from '../identity.mjs';
import {startOidcFixture} from '../fixtures/oidc.mjs';
const request=(url,ca,{headers={},body,method='GET'}={})=>new Promise((resolve,reject)=>{const req=https.request(url,{ca,method,headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body);});
const getCookie=(r,name)=>r.headers['set-cookie'].find(x=>x.startsWith(name+'=')).split(';')[0];
test('real signed HTTPS OIDC code+PKCE login, session, bounded delegation, CSRF and logout',async()=>{
 const idp=await startOidcFixture();let identity;const server=https.createServer({key:idp.key,cert:idp.cert},async(req,res)=>{if(!await identity.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='https://127.0.0.1:'+server.address().port,user=randomUUID();
 const config={issuer:idp.issuer,authorization_endpoint:idp.issuer+'/authorize',token_endpoint:idp.issuer+'/token',jwks_endpoint:idp.issuer+'/jwks',client_id:'fixture-client',broker_origin:origin,dashboard_origin:'https://dashboard.example',subject_map:[{issuer:idp.issuer,subject:'fixture-user',user_id:user}],required_acr:'fixture:mfa',max_age_seconds:300,ca_file:idp.ca_file};identity=createIdentity({config});
 async function login(wrongBinding=false){const start=await request(origin+'/auth/login?popup_state=abcdefghijklmnop',idp.cert);assert.equal(start.status,302);const flow=getCookie(start,'__Host-fractionate-login');const authorize=await request(start.headers.location,idp.cert);const done=await request(authorize.headers.location,idp.cert,{headers:{Cookie:wrongBinding?'__Host-fractionate-login=wrong':flow}});return{done,callback:authorize.headers.location,flow};}
 try{
 const count=idp.tokenRequests;assert.equal((await login(true)).done.status,401);assert.equal(idp.tokenRequests,count);
 const{done,callback,flow}=await login();assert.equal(done.status,303);assert.match(done.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Lax/);const cookie=getCookie(done,'__Host-fractionate-human'),proof=cookie.split('=')[1];const session=await request(origin+'/auth/session',idp.cert,{headers:{Cookie:cookie}});const p=JSON.parse(session.body);assert.equal(p.user_id,user);assert.ok(!session.body.includes(proof));assert.equal((await identity.authenticate(proof)).proof_type,'human');assert.equal((await request(callback,idp.cert,{headers:{Cookie:flow}})).status,401);
 const consent=await request(origin+'/auth/delegations?state=abcdefghijklmnop',idp.cert,{headers:{Cookie:cookie}});assert.equal(consent.status,200);assert.match(consent.body,/fractionate\.broker\.delegation/);assert.match(consent.body,/https:\/\/dashboard.example/);
 const send=async(path,body,originHeader=origin)=>request(origin+path,idp.cert,{method:'POST',headers:{Cookie:cookie,Origin:originHeader,'X-CSRF-Token':p.csrf_token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await send('/auth/delegations',{actions:['list']},'https://evil.example')).status,401);assert.equal((await send('/auth/delegations',{actions:['approve']})).status,401);
 const delegation=JSON.parse((await send('/auth/delegations',{actions:['list','assign']})).body);assert.equal((await identity.authenticate(delegation.bearer)).proof_type,'delegation');await assert.rejects(identity.createDelegation(delegation.bearer,['list']));assert.ok(delegation.expires_at<=p.fresh_until);await send('/auth/logout',{});await assert.rejects(identity.authenticate(delegation.bearer));await assert.rejects(identity.authenticate(proof));
 for(const claims of [{iss:'https://wrong.example'},{aud:'wrong'},{auth_time:Math.floor(Date.now()/1000)-600},{acr:'weak'},{nonce:'wrong'},{sub:'unknown'},{exp:1},{aud:['fixture-client','other'],azp:'other'}]){idp.setClaims(claims);assert.equal((await login()).done.status,401);}
 idp.setClaims({});idp.setBadSignature(true);assert.equal((await login()).done.status,401);idp.setBadSignature(false);
 const fresh=(await login()).done;const freshProof=getCookie(fresh,'__Host-fractionate-human').split('=')[1];identity.close();identity=createIdentity({config});await assert.rejects(identity.authenticate(freshProof));
 }finally{identity.close();await new Promise(r=>server.close(r));await idp.close();}
});
