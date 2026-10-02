import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { agentRunsConfiguration } from './operational-agent-runtime.js';
import { createSupervisorClient } from './operational-worker-supervisor.js';
import { createPublicFetcher, digest, webError } from './operational-public-web.js';
import { createWebsiteReviewService } from './operational-website-review.js';

export function createReviewModelBridge({client,publicKeyPem}) {
  const key=createPublicKey(publicKeyPem);
  if(key.asymmetricKeyType!=='ed25519')throw webError('PROVIDER_UNAVAILABLE');
  return {
    async readiness(){const r=await client.request('public_review_status',{});
      return r?.contract_version==='website-review.v1'&&r.available===true?{available:true}:
        {available:false,code:['PRICE_UNKNOWN','PROVIDER_UNAVAILABLE','REVIEW_BRIDGE_UNAVAILABLE'].includes(r?.code)?r.code:'PROVIDER_UNAVAILABLE'};},
    async review(request,{signal}={}) {
      if(signal?.aborted)throw webError('CANCELLED');
      const r=await client.request('public_review_model',request);
      const parts=String(r?.attestation).split('.');
      if(parts.length!==3||parts[0]!=='ppr1')throw webError('PROVIDER_UNAVAILABLE');
      const body=Buffer.from(parts[1],'base64url');let p;
      try{p=JSON.parse(body.toString('utf8'));}catch{throw webError('PROVIDER_UNAVAILABLE');}
      if(!verify(null,body,key,Buffer.from(parts[2],'base64url'))||p.kind!=='public-website-review-model'
        ||p.run_id!==request.run_id||p.call_id!==request.call_id||p.task_hash!==request.task_hash
        ||p.guide_hash!==request.guide_hash||p.request_hash!==digest(JSON.stringify(request))
        ||p.response_hash!==digest(r.text)||JSON.stringify(p.usage)!==JSON.stringify(r.usage)
        ||p.settled_usd!==r.settled_usd||p.price_table_revision!==r.price_table_revision)throw webError('PROVIDER_UNAVAILABLE');
      return r;
    },
    cancel:run_id=>client.request('cancel_public_review',{run_id}),
  };
}
export function createWebsiteReviewRuntime({db,store,env=process.env,readFile=readFileSync}={}) {
  const config=agentRunsConfiguration(env);let model=null;
  if(config.execution)try{model=createReviewModelBridge({client:createSupervisorClient(config.execution.socket),
    publicKeyPem:readFile(config.execution.publicKeyPath,'utf8')});}catch{ /* readiness names the absent bridge */ }
  const hosts=[];
  for(const value of [env.PROXYPILOT_PUBLIC_URL,env.APP_URL])try{if(value)hosts.push(new URL(value).hostname);}catch{ /* invalid deployment origin is not used */ }
  // Protect every installation-managed route, even if it has a public address.
  // Public website review never becomes a host-management transport.
  const currentProtectedHosts=()=>{
    const current=[...hosts];
    try {for(const r of db.prepare('SELECT domain FROM service_http_routes').all())if(r.domain)current.push(r.domain);}catch{ /* legacy schemas use services.domain */ }
    try {for(const r of db.prepare('SELECT domain FROM services').all())if(r.domain)current.push(r.domain);}catch{ /* route schema above */ }
    try {for(const r of db.prepare('SELECT domain FROM provisioned_domains').all())if(r.domain)current.push(r.domain);}catch{ /* legacy schema */ }
    return current;
  };
  const addresses=[env.MOCK2_PUBLIC_IP,env.PUBLIC_IP].filter(Boolean).flatMap(s=>s.split(',').map(x=>x.trim()));
  return createWebsiteReviewService({db,store,protectedHosts:currentProtectedHosts,fetchPage:createPublicFetcher({protectedHosts:currentProtectedHosts,protectedAddresses:addresses}),model});
}
