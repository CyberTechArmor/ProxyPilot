import { readdirSync, readFileSync } from 'node:fs';
import { POMERIUM_PORT, pomeriumError as fail } from './pomerium-logic.js';

export function verifyLoopbackSockets(output,intents) {
  const lines=output.trim().split('\n').filter(Boolean);
  for(const intent of intents.filter(x=>x.action!=='remove')) {
    const port=new URL(intent.upstream).port;
    const matches=lines.filter(line=>line.split(/\s+/)[3]?.endsWith(`:${port}`));
    if(!matches.length || matches.some(line=>line.split(/\s+/)[3]!==`127.0.0.1:${port}`)) throw fail(`Direct-upstream bypass: application port ${port} is absent or listens outside 127.0.0.1.`);
    const pids=[...matches.join(' ').matchAll(/pid=(\d+)/g)].map(m=>m[1]);
    if(!pids.length || matches.some(line=>/docker-proxy|rootlessport/.test(line))) throw fail(`Application port ${port} is not a verifiable native loopback listener; published container ports are unsupported in G4.`);
    if(lines.some(line=>pids.some(pid=>line.includes(`pid=${pid},`)) && !/^(127\.|\[?::1\]?:)/.test(line.split(/\s+/)[3]||''))) throw fail(`Direct-upstream bypass: the process serving ${port} also has a public listener.`);
  }
  return {loopbackOnly:true,processListenersChecked:true};
}
export async function verifyPrivateApplications(intents,{exec,job,sysRoot='/proc/sys/net/ipv4/conf'}={}) {
  if(!intents.some(i=>i.action!=='remove')) return {state:'not_applicable'};
  job.fence();
  const sockets=await exec.host(['ss','-H','-ltnp'],{timeoutMs:10000});
  if(sockets.code!==0) throw fail('Cannot inspect host listeners; direct-upstream bypass prevention is not established.');
  const evidence=verifyLoopbackSockets(sockets.stdout,intents);
  for(const name of readdirSync(sysRoot)) if(readFileSync(`${sysRoot}/${name}/route_localnet`,'utf8').trim()!=='0') throw fail(`Direct-upstream bypass: ${name}.route_localnet permits external routing to loopback; G4 will not rebuild host networking.`);
  job.fence(); return {...evidence,loopbackRoutingDisabled:true};
}
export function checkGatewayRedirect(response,origin,domain) {
  const status=Number(response.match(/^HTTP\/\S+\s+(\d+)/m)?.[1]);
  const location=response.match(/^location:\s*(.+)$/im)?.[1]?.trim();
  let target;try{target=new URL(location,`https://${domain}`);}catch{throw fail('Gateway did not return a valid authentication redirect.');}
  if(![302,303,307].includes(status) || ![origin,`https://${domain}`].includes(target.origin) || !/^\/(?:\.pomerium\/|oauth2\/)/.test(target.pathname)) throw fail('Gateway authentication redirect did not match the selected self-hosted service.');
  return {status,redirectOrigin:target.origin};
}
export async function verifyPomeriumGateway(config,intents,{exec,job}={}) {
  const must=async args=>{job.fence();const r=await exec.host(['curl','--silent','--show-error','--noproxy','*','--max-time','10','--dump-header','-','--output','/dev/null',...args],{timeoutMs:12000});job.fence();if(r.code!==0)throw fail('Gateway probe failed (TLS, connection or timeout). No route is certified.');return r.stdout;};
  const evidence=[];
  for(const i of intents.filter(i=>i.action!=='remove')) {
    const spoof=['--header','X-Pomerium-Jwt-Assertion: forged','--header','X-Forwarded-User: administrator','--header','X-Auth-Request-Email: administrator@example.com','--header','Authorization: Bearer forged'];
    const privateResponse=await must(['--header',`Host: ${i.domain}`,...spoof,`http://127.0.0.1:${POMERIUM_PORT}/`]);
    const privateRedirect=checkGatewayRedirect(privateResponse,config.origin,i.domain);
    const publicResponse=await must(['--resolve',`${i.domain}:443:127.0.0.1`,...spoof,`https://${i.domain}/`]);
    const restricted=Number(publicResponse.match(/^HTTP\/\S+\s+(\d+)/m)?.[1])===403 && !!i.restrictions.ipAllowlist;
    const publicRedirect=restricted?{status:403,restrictionPreserved:true}:checkGatewayRedirect(publicResponse,config.origin,i.domain);
    evidence.push({routeId:i.routeId,privateRedirect,publicRedirect,spoofRefused:true});
  }
  return {routes:evidence,checkedAt:new Date().toISOString()};
}
