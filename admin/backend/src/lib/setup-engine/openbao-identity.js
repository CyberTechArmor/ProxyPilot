import { readConfig } from '../sso/store.js';
import { reader } from '../sso/oidc.js';
import { fail,callbackFor } from './openbao-logic.js';
export async function verifyClient(db,r,{getReader=reader}={}){const g3=readConfig(db);if(!g3||g3.config.connectionId!==r.config.connectionId)throw fail('The existing read-only Keycloak observer for this provider is required to verify the dedicated OpenBao client.');
  try{const get=await getReader(db,g3),clients=await get(`/clients?clientId=${encodeURIComponent(r.config.clientId)}`),c=clients?.find(c=>c.clientId===r.config.clientId);
    if(!c||c.protocol!=='openid-connect'||!c.enabled||c.publicClient||c.bearerOnly||!c.standardFlowEnabled||c.implicitFlowEnabled||c.directAccessGrantsEnabled||c.serviceAccountsEnabled)throw fail('OpenBao requires a dedicated confidential authorization-code client, with implicit/direct grants/service accounts disabled.');
    if(JSON.stringify(c.redirectUris)!==JSON.stringify([callbackFor(r)])||JSON.stringify(c.webOrigins)!==JSON.stringify([r.config.origin]))throw fail('Keycloak callbacks and web origins must exactly match the OpenBao review; no wildcards or other callbacks.');
    if(c.attributes?.['id.token.signed.response.alg']&&c.attributes['id.token.signed.response.alg']!=='RS256')throw fail('Use RS256 ID tokens on the OpenBao client.');
    const mappers=await get(`/clients/${encodeURIComponent(c.id)}/protocol-mappers/models`);
    if(!mappers?.some(m=>m.protocolMapper==='oidc-group-membership-mapper'&&m.config?.['claim.name']==='groups'&&m.config?.['id.token.claim']==='true'&&m.config?.['full.path']==='true'))throw fail('The dedicated Keycloak client needs full-path groups in its ID token. Add only the explicit reviewed group policy.');
    return {clientId:c.clientId,callback:callbackFor(r),mapping:r.config.group,readOnly:true};
  }catch(e){if(e.openbaoSafe)throw e;throw fail('Read-only Keycloak client verification failed; existing clients and realm settings were not changed.');}}
