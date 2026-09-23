import { restrictedNetwork } from './platform-networks.js';
import { z } from 'zod';
import { createHash, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
// Reviewed against official v2.6.2 source/docs, dd9c19c37a878cf4a81b18efb8d6f0599c7da923.
export const OPENBAO_IMAGE='openbao/openbao:2.6.2';
export const OPENBAO_APP='pp-platform-openbao';
export const OPENBAO_ROOT='/var/lib/proxypilot/openbao';
// Deliberately outside the ordinary ProxyPilot application/config backup tree.
export const RECOVERY_ROOT='/var/lib/proxypilot-openbao-recovery';
export const OPENBAO_PORT=18200;
export const POSTGRES_CA_PATH='/openbao/config/postgres-ca.pem';
export const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const fail=message=>Object.assign(new Error(message),{status:409,openbaoSafe:true});
const name=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,99}$/);
const value=z.string().min(16).max(8192).regex(/^[^\r\n\0]+$/);
const publicKey=z.string().min(80).max(16000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
// Only public CA certificates belong in saved configuration, never private keys.
export function publicCa(pem){try{const certs=pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);return !!certs?.length&&certs.length<=8&&!pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,'').trim()&&certs.every(c=>new X509Certificate(c).ca);}catch{return false;}}
export function privateIp(v){if(isIP(v)!==4)return false;const [a,b]=v.split('.').map(Number);return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168);}
export const configSchema=z.object({expectedPlanRevision:z.number().int().positive(),expectedRevision:z.number().int().nonnegative(),connectionId:name,clientId:name,clientSecret:value.optional(),group:z.string().min(1).max(150).regex(/^\/[a-zA-Z0-9_/-]+$/),
  basic:z.boolean().optional(),database:z.object({host:z.string().refine(privateIp),port:z.number().int().min(1024).max(65535).default(5432),name:z.string().regex(/^pp_g6_[a-z0-9_]{1,48}$/),username:z.string().regex(/^[a-z][a-z0-9_]{2,62}$/),caPem:z.string().max(32000).refine(publicCa).optional(),disposable:z.literal(true)}).strict().optional(),
  pgpKeys:z.array(publicKey).length(3).optional(),rootPgpKey:publicKey.optional(),initialize:z.boolean().default(false),allowedIps:z.array(restrictedNetwork).min(1).max(16),reviewed:z.literal(true)}).strict().refine(v=>v.basic||!!v.database,'Select a disposable database for the advanced flow.');
export const jobSchema=z.object({revision:z.number().int().positive()}).strict();
export const applySchema=jobSchema.extend({reviewToken:z.string().regex(/^[a-f0-9]{64}$/),reviewed:z.literal(true)}).strict();
export const ackSchema=applySchema.extend({receipt:value}).strict();
export const unsealSchema=applySchema.extend({share:z.string().min(16).max(1024).regex(/^[A-Za-z0-9+/=]+$/)}).strict();
export const bootstrapSchema=applySchema.extend({bootstrapToken:value,databasePassword:value.optional(),revokeBootstrap:z.literal(true)}).strict();
export const namesFor=r=>{const p=`pp-g6-${r.credential_ref.slice(-12)}`;return {prefix:p,server:p,network:p+'-net',volume:p+'-raft',logs:p+'-logs',oidc:p+'-oidc',approle:p+'-machine',database:p+'-database',human:p+'-human',machine:p+'-workload'};};
export const callbackFor=r=>`${r.config.origin}/ui/vault/auth/${namesFor(r).oidc}/oidc/callback`;
export const databaseUrl=r=>`postgresql://{{username}}:{{password}}@${r.config.database.host}:${r.config.database.port}/${r.config.database.name}?sslmode=verify-full${r.config.database.caPem?'&sslrootcert='+POSTGRES_CA_PATH:''}`;
export const databaseDetails=r=>({connection_url:databaseUrl(r),username:r.config.database.username,password_authentication:'scram-sha-256'});
export const policyFor=r=>{const n=namesFor(r);if(r.config.basic)return `path "${n.prefix}-kv/data/health" { capabilities = ["read"] }\npath "sys/capabilities-self" { capabilities = ["update"] }\npath "auth/token/lookup-self" { capabilities = ["read"] }\npath "auth/token/revoke-self" { capabilities = ["update"] }\n` + [`auth/${n.oidc}/config`,`auth/${n.oidc}/role/mapped`,`auth/${n.approle}/role/workload`,`sys/policies/acl/${n.machine}`,`sys/policies/acl/${n.human}`].map(p=>`path "${p}" { capabilities = ["read"] }\n`).join('');return `path "${n.database}/creds/reader" { capabilities = ["read"] }\npath "sys/capabilities-self" { capabilities = ["update"] }\npath "auth/token/lookup-self" { capabilities = ["read"] }\npath "auth/token/revoke-self" { capabilities = ["update"] }\n` + [`auth/${n.oidc}/config`,`auth/${n.oidc}/role/mapped`,`auth/${n.approle}/role/workload`,`${n.database}/roles/reader`,`${n.database}/config/selected`,`sys/policies/acl/${n.machine}`,`sys/policies/acl/${n.human}`].map(p=>`path "${p}" { capabilities = ["read"] }\n`).join('');};
export const roleFor=r=>({db_name:'selected',creation_statements:[`CREATE ROLE "{{name}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT CONNECT ON DATABASE "${r.config.database.name}" TO "{{name}}"; GRANT USAGE ON SCHEMA public TO "{{name}}"; GRANT SELECT ON TABLE public.g6_probe TO "{{name}}";`],revocation_statements:[`REVOKE ALL ON TABLE public.g6_probe FROM "{{name}}"; REVOKE USAGE ON SCHEMA public FROM "{{name}}"; REVOKE CONNECT ON DATABASE "${r.config.database.name}" FROM "{{name}}"; DROP ROLE "{{name}}";`],default_ttl:60,max_ttl:120});
export const machineRoleFor=r=>({bind_secret_id:true,secret_id_num_uses:0,secret_id_ttl:0,token_policies:[namesFor(r).machine],token_no_default_policy:true,token_ttl:120,token_max_ttl:120,token_type:'service'});
export const humanRoleFor=r=>({role_type:'oidc',user_claim:'sub',bound_audiences:[r.config.clientId],bound_claims:{groups:[r.config.group]},bound_claims_type:'string',allowed_redirect_uris:[callbackFor(r)],oidc_scopes:['profile'],token_policies:[namesFor(r).human],token_no_default_policy:true,token_ttl:120,token_max_ttl:120});
