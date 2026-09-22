import http from 'node:http';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { TEST_PORT,PROXY_KEY,TEST_ENV,TEST_PATH,PLACEHOLDER,infisicalError as fail } from './infisical-logic.js';
import { secretPath } from './infisical-api.js';
import { assertIsolatedAgentVm } from './infisical-runtime.js';

// Scripts use the existing runner's stdin guest channel. No secret on argv,
// persistent guest files, command output or process environment inherited from
// ProxyPilot. The agent script receives only its short-lived token/placeholder.
export function testConsumerScript({host,nonce,value}) {
  const input=Buffer.from(JSON.stringify({host,nonce,value,port:TEST_PORT})).toString('base64');
  return `set +x\npython3 - <<'PP_G5_CONSUMER'\nimport base64,json,http.client,sys\np=json.loads(base64.b64decode('${input}'))\ntry:\n c=http.client.HTTPConnection(p['host'],p['port'],timeout=8)\n c.request('POST','/g5/consumer?nonce='+p['nonce'],headers={'Authorization':'Bearer '+p['value']})\n r=c.getresponse();r.read(1024);c.close()\n print('consumer_verified' if r.status==204 else 'consumer_failed')\n sys.exit(0 if r.status==204 else 1)\nexcept Exception:\n print('consumer_unavailable');sys.exit(1)\nPP_G5_CONSUMER\n`;
}
export function testAgentScript({host,nonce,proxyOrigin,projectId,token}) {
  const input=Buffer.from(JSON.stringify({host,nonce,proxyOrigin,projectId,token,port:TEST_PORT,environment:TEST_ENV,path:TEST_PATH,placeholder:PLACEHOLDER})).toString('base64');
  return `set +x\npython3 - <<'PP_G5_AGENT'\nimport base64,json,http.client,sys,urllib.parse,time\np=json.loads(base64.b64decode('${input}'));proxy=urllib.parse.urlsplit(p['proxyOrigin'])\ndef request(suffix,token=None,path=None):\n c=http.client.HTTPConnection(proxy.hostname,proxy.port,timeout=10)\n headers={'Authorization':'Bearer '+p['placeholder']}\n if token is not None:\n  wire=p['projectId']+':'+p['environment']+(path or p['path'])+':'+token\n  headers['Proxy-Authorization']='Basic '+base64.b64encode(wire.encode()).decode()\n c.request('GET','http://'+p['host']+':'+str(p['port'])+'/g5/'+suffix+'?nonce='+p['nonce'],headers=headers)\n r=c.getresponse();body=r.read(1024);c.close()\n return r.status,body\ntry:\n # Service startup may take a moment; only an explicit success counts.\n for attempt in range(15):\n  try:\n   permitted=request('allowed',p['token'])\n   if permitted[0]==204:break\n  except Exception:pass\n  time.sleep(1)\n checks=[permitted[0]==204,request('allowed')[0]==407,request('allowed','invalid-g5-token')[0]==502,request('denied',p['token'])[0]==403,request('allowed',p['token'],'/ungranted-g5')[0]==502,request('allowed',p['token'])[0]==204]\n print('agent_proxy_verified' if all(checks) else 'agent_proxy_failed')\n sys.exit(0 if all(checks) else 1)\nexcept Exception:\n print('agent_proxy_unavailable');sys.exit(1)\nPP_G5_AGENT\n`;
}
export function testDestination(values,nonce,{host,port=TEST_PORT}={}) {
  const received={consumer:0,agent:0,unauthorized:0};
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://test.invalid'),actual=Buffer.from(req.headers.authorization||'');
    const expected=Buffer.from(`Bearer ${u.pathname==='/g5/consumer'?values.application:values.proxy}`);
    const match=actual.length===expected.length&&timingSafeEqual(actual,expected);
    const allowed=u.searchParams.get('nonce')===nonce && ((u.pathname==='/g5/consumer'&&req.method==='POST')||(u.pathname==='/g5/allowed'&&req.method==='GET'));
    if(match&&!allowed)received.unauthorized++;
    if(match&&allowed){received[u.pathname==='/g5/consumer'?'consumer':'agent']++;res.writeHead(204).end();}else res.writeHead(403).end();
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=8;
  return {received,server,open:()=>new Promise((resolve,reject)=>{server.once('error',()=>reject(fail('The private disposable test destination could not bind. Nothing already listening was changed.')));server.listen(port,host,resolve);}),close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
export async function verifyCredentialFlows(r,values,tokens,{exec,job,api,vmProbe=assertIsolatedAgentVm,destination=testDestination}={}) {
  const nonce=randomBytes(20).toString('hex'),vm=await vmProbe(r.config,{exec,job});
  const denied=await api(secretPath(r.identities.projectId));
  if(![401,403].includes(denied.status))throw fail('Unauthenticated secret access did not produce an explicit denial.');
  if(tokens.agent){const deniedAgent=await api(secretPath(r.identities.projectId,PROXY_KEY),{token:tokens.agent});if(deniedAgent.status!==403)throw fail('Agent secret-value access was not explicitly refused. Do not run this identity behind the proxy.');}
  const receipt=destination(values,nonce,{host:r.config.testHost});await receipt.open();
  try{
    job.fence();const consumer=await exec.guest(r.config.agentVm,testConsumerScript({host:r.config.testHost,nonce,value:values.application}),{timeoutMs:20000});job.fence();
    if(consumer.code!==0||consumer.stdout.trim()!=='consumer_verified'||receipt.received.consumer!==1)throw fail('The test application did not receive the scoped disposable secret. Guest output is withheld.');
    if(tokens.agent){await vmProbe(r.config,{exec,job});job.fence();const agent=await exec.guest(r.config.agentVm,testAgentScript({host:r.config.testHost,nonce,proxyOrigin:r.config.proxyOrigin,projectId:r.identities.projectId,token:tokens.agent}),{timeoutMs:60000});job.fence();
      if(agent.code!==0||agent.stdout.trim()!=='agent_proxy_verified'||receipt.received.agent!==2||receipt.received.unauthorized)throw fail('Agent Proxy permitted/denied flow verification failed. No credential evidence is exposed.');}
    return {consumer:'verified',unauthenticatedRead:'denied',agentValueRead:tokens.agent?'denied':'not_selected',agentProxy:tokens.agent?'placeholder_substitution_and_denials_verified':'skipped',destinationReceipt:tokens.agent?'real_credential_received':'not_selected',vmRef:vm.uuid};
  }finally{await receipt.close();}
}
