// Optional real pinned Agent Proxy executable + real Python consumer/agent and
// HTTP destination. Infisical auth, CA signing, permissions and secrets are
// explicitly scripted upstream responses, not a real Infisical deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { verifyCredentialFlows,testDestination } from '../lib/setup-engine/infisical-flows.js';
import { desiredProxiedService,PROXY_KEY } from '../lib/setup-engine/infisical-logic.js';
import { hostGuestExec } from '../../../../cli/src/commands/setup-runner.js';

const binary=process.env.PP_G5_CLI;
function processRun(file,args,input,options={}) {
  return new Promise((resolve,reject)=>{
    const p=spawn(file,args,{stdio:['pipe','pipe','pipe'],...options});let stdout='',stderr='';
    p.on('error',reject);p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
    p.on('close',code=>resolve({code,stdout,stderr}));p.stdin.end(input);
  });
}
test('G5.3/.4 real pinned CLI: placeholder substitution, consumer and denied HTTP requests (scripted Infisical API)',{skip:!binary,timeout:60000},async()=>{
  assert.match((await processRun(binary,['--version'])).stdout,/0\.43\.133/);
  const values={application:'disposable-application-real-value',proxy:'disposable-proxy-real-value'};
  const jwt=id=>`header.${Buffer.from(JSON.stringify({identityId:id})).toString('base64url')}.fixture`;
  const tokens={agent:jwt('agent'),proxy:jwt('proxy')},upstreamCalls=[];let proxy,logs='';
  const r={config:{testHost:'127.0.0.1',agentVm:'local-process-fixture'},identities:{projectId:'g5-fixture-project'}};
  const sign=`import sys,datetime\nfrom cryptography import x509\nfrom cryptography.hazmat.primitives import serialization,hashes\nfrom cryptography.hazmat.primitives.asymmetric import ec\nk=ec.generate_private_key(ec.SECP256R1())\nn=x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME,'Disposable scripted CA')])\nnow=datetime.datetime.now(datetime.timezone.utc)\nc=x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(serialization.load_pem_public_key(sys.stdin.buffer.read())).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=1)).not_valid_after(now+datetime.timedelta(days=2)).add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True).sign(k,hashes.SHA256())\nprint(c.public_bytes(serialization.Encoding.PEM).decode())`;
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://fixture'),token=(req.headers.authorization||'').replace('Bearer ','');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
    upstreamCalls.push({path:u.pathname,actor:token===tokens.proxy?'proxy':token===tokens.agent?'agent':'none'});
    const send=(status,value)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(value));
    if(u.pathname.replace(/\/$/,'')==='/api/v1/auth/universal-auth/login')return send(200,{accessToken:tokens.proxy,expiresIn:300,accessTokenMaxTTL:300,tokenType:'Bearer'});
    if(u.pathname==='/api/v1/organization/agent-proxy-ca/sign'&&token===tokens.proxy){const signed=await processRun('python3',['-c',sign],body.publicKey);return send(200,{certificate:signed.stdout});}
    if(u.pathname==='/api/v1/proxied-services'){
      if(token!==tokens.agent||u.searchParams.get('secretPath')!=='/proxypilot-g5')return send(403,{message:'denied'});
      return send(200,{projectSlug:'g5',services:[{...desiredProxiedService(r.config,r.identities.projectId),id:'test-service',canProxy:true}]});
    }
    if(u.pathname===`/api/v4/secrets/${PROXY_KEY}`&&token===tokens.proxy)return send(200,{secret:{secretKey:PROXY_KEY,secretValue:values.proxy,type:'shared'}});
    if(u.pathname.endsWith('/report-usage')&&token===tokens.proxy)return send(200,{});
    send(403,{message:'denied'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  // Let the OS choose the test proxy port; production remains fixed at 17322.
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  r.config.proxyOrigin=`http://127.0.0.1:${port}`;
  try {
    proxy=spawn(binary,['secrets','agent-proxy','start','--unmatched-host=block','--poll-interval=30','--telemetry=false',`--port=${port}`],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,INFISICAL_DOMAIN:`http://127.0.0.1:${server.address().port}`,INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:'disposable-proxy',INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:'disposable-proxy-auth',INFISICAL_DISABLE_UPDATE_CHECK:'true'}});
    proxy.stdout.on('data',b=>logs+=b);proxy.stderr.on('data',b=>logs+=b);
    const scripts=[];let receipt;
    const delivery=hostGuestExec({spawnImpl:(bin,args,options)=>{
      assert.equal(bin,'incus');assert.deepEqual(args,['exec','local-process-fixture','--','sh']);
      return spawn('sh',[],options); // Only Incus dispatch is substituted.
    }});
    const evidence=await verifyCredentialFlows(r,values,tokens,{
      job:{fence(){}},vmProbe:async()=>({uuid:'scripted-isolation-only'}),api:async()=>({status:403,body:null}),
      destination:(...args)=>(receipt=testDestination(...args)),
      exec:{guest:async(vm,script,options)=>{scripts.push(script);return delivery.guest(vm,script,options);}}
    });
    assert.equal(evidence.agentProxy,'placeholder_substitution_and_denials_verified');
    assert.deepEqual(receipt.received,{consumer:1,agent:2,unauthorized:0});
    const agentPayload=Buffer.from(scripts[1].match(/b64decode\('([^']+)'\)/)[1],'base64').toString();
    assert(!agentPayload.includes(values.proxy));assert(!agentPayload.includes(tokens.proxy));assert(!agentPayload.includes(values.application));
    assert(upstreamCalls.some(x=>x.path===`/api/v4/secrets/${PROXY_KEY}`&&x.actor==='proxy'));
    assert(!upstreamCalls.some(x=>x.path===`/api/v4/secrets/${PROXY_KEY}`&&x.actor==='agent'));
    for(const value of Object.values(values))assert(!logs.includes(value));
  } catch(e) {
    // Deliberately do not expose process output, tokens or upstream bodies.
    throw new Error(`Real CLI flow did not verify: ${e.message}; proxy exit ${proxy?.exitCode}`);
  } finally {
    if(proxy&&proxy.exitCode===null){const exited=once(proxy,'exit');proxy.kill('SIGTERM');await exited;}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
