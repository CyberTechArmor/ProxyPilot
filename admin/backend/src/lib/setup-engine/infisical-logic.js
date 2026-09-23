import { restrictedNetwork } from './platform-networks.js';
// G5 release contract, checked against upstream tagged source (see operator guide).
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
export const INFISICAL_IMAGE = 'infisical/infisical:v0.165.15';
export const AGENT_PROXY_IMAGE = 'infisical/cli:0.43.133';
export const INFISICAL_DB_IMAGE = 'postgres:14.24-alpine';
export const INFISICAL_REDIS_IMAGE = 'redis:7.4.11-alpine';
export const INFISICAL_APP = 'pp-platform-infisical';
export const INFISICAL_ROOT = '/var/lib/proxypilot/infisical';
export const INFISICAL_PORT = 18085;
export const TEST_PORT = 18086;
export const TEST_KEY = 'PP_G5_TEST_CREDENTIAL';
export const PROXY_KEY = 'PP_G5_PROXY_CREDENTIAL';
export const TEST_PATH = '/proxypilot-g5';
export const TEST_ENV = 'g5';
export const PLACEHOLDER = 'pp-g5-placeholder-not-a-credential';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const infisicalError = message => Object.assign(new Error(message), { status:409, infisicalSafe:true });
export function privateIp(ip) { if(isIP(ip)!==4)return false; const [a,b]=ip.split('.').map(Number);return a===10 || (a===172&&b>=16&&b<=31) || (a===192&&b===168); }
const id=z.string().uuid();
const ip=z.string().refine(privateIp,'Use an RFC1918 IPv4 address on this host.');
export const infisicalJobSchema=z.object({revision:z.number().int().positive()}).strict();
export const infisicalConfigSchema=z.object({expectedPlanRevision:z.number().int().positive(),expectedRevision:z.number().int().nonnegative(),
  basic:z.boolean().optional(),agentMode:z.enum(['install','connect','skip']),testHost:ip,
  agentVm:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/).optional(),
  // A new installation must not expose an unclaimed first-administrator screen.
  allowedIps:z.array(restrictedNetwork).min(1).max(8),
  externalProxyContainer:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/).optional(),
  reviewed:z.literal(true)}).strict().refine(v=>v.basic||!!v.agentVm,'Advanced credential tests require an isolated VM.');
const credential=z.object({identityId:id,clientId:id,clientSecret:z.string().min(16).max(4096).regex(/^[^\r\n\0]+$/)}).strict();
export const infisicalIdentitiesSchema=z.object({expectedRevision:z.number().int().positive(),organizationId:id,projectId:id,
  workload:credential,proxy:credential.optional(),agent:credential.optional(),reviewed:z.literal(true)}).strict();
export const infisicalApplySchema=infisicalJobSchema.extend({reviewToken:z.string().regex(/^[a-f0-9]{64}$/),reviewed:z.literal(true)}).strict();
export function expectedPolicies(identities,agentMode) {
  const scope={environment:TEST_ENV,secretPath:TEST_PATH};
  const identityIds=['workload',...(agentMode==='skip'?[]:['proxy','agent'])].map(k=>identities[k].identityId).sort();
  const policies={
    workload:[{subject:'secrets',action:['create','describeSecret','readValue'],conditions:{...scope,secretName:agentMode==='skip'?TEST_KEY:{$in:[TEST_KEY,PROXY_KEY]}}},
      {subject:'identity',action:['read'],conditions:{identityId:{$in:identityIds}}}],
    proxy:[{subject:'secrets',action:['describeSecret','readValue'],conditions:{...scope,secretName:PROXY_KEY}},
      {subject:'proxied-services',action:['report-usage'],conditions:scope}],
    agent:[{subject:'proxied-services',action:['proxy'],conditions:scope}],
  };
  return agentMode==='skip'?{workload:policies.workload}:policies;
}
export function desiredProxiedService(config,projectId) { return {projectId,environment:TEST_ENV,secretPath:TEST_PATH,name:'proxypilot-g5-test',
  hostPattern:`${config.testHost}:${TEST_PORT}/g5/allowed`,isEnabled:true,credentials:[{secretKey:PROXY_KEY,role:'credential-substitution',placeholderKey:'PP_G5_CREDENTIAL',placeholderValue:PLACEHOLDER,substitutionSurfaces:['header']}]}; }
