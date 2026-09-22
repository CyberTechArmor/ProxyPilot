import { readConfig } from '../sso/store.js';
import { reader } from '../sso/oidc.js';
import { pomeriumError as fail } from './pomerium-logic.js';

export function validatePomeriumClient(config,client) {
  if(!client || client.clientId!==config.clientId || client.protocol!=='openid-connect' || !client.enabled || client.publicClient || client.bearerOnly || !client.standardFlowEnabled || client.implicitFlowEnabled || client.directAccessGrantsEnabled || client.serviceAccountsEnabled) throw fail('Pomerium needs a dedicated confidential Standard-flow client; disable implicit flow, direct grants and service accounts.');
  if(JSON.stringify(client.redirectUris)!==JSON.stringify([`${config.origin}/oauth2/callback`]) || JSON.stringify(client.webOrigins)!==JSON.stringify([config.origin])) throw fail('Pomerium client callbacks and web origins must exactly match the guided authentication origin; wildcards are refused.');
  if(client.attributes?.['pkce.code.challenge.method']!=='S256') throw fail('Require S256 PKCE on the dedicated Pomerium client (Core 0.33.3).');
  if(client.attributes?.['id.token.signed.response.alg'] && client.attributes['id.token.signed.response.alg']!=='RS256') throw fail('Use RS256 signed ID tokens for the Pomerium client.');
  return {clientId:config.clientId,callback:`${config.origin}/oauth2/callback`,pkce:'S256',readOnly:true};
}
export async function verifyPomeriumClient(db,r,{getReader=reader}={}) {
  const g3=readConfig(db);
  if(!g3 || g3.config.connectionId!==r.config.connectionId) throw fail('The G3 read-only observer for this verified realm is unavailable. Complete its connection before verifying the Pomerium client; no realm-admin credential is requested.');
  if([g3.config.clientId,g3.config.readerClientId].includes(r.config.clientId)) throw fail('The Pomerium client must be separate from both G3 clients.');
  try {
    const get=await getReader(db,g3);
    const matches=await get(`/clients?clientId=${encodeURIComponent(r.config.clientId)}`);
    return validatePomeriumClient(r.config,matches?.find(c=>c.clientId===r.config.clientId));
  } catch(e) {if(e.pomeriumSafe)throw e;throw fail('Read-only Pomerium client verification failed. Check G3 observer access and the dedicated client settings.');}
}
