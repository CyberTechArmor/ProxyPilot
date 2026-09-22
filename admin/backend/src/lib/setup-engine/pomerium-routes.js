import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderDomains, isLeaseLost } from '../route-render.js';
import { POMERIUM_APP, POMERIUM_PORT, IDENTITY_HEADERS, digest, pomeriumError as fail } from './pomerium-logic.js';
import { readPomerium, pomeriumIntents, routeSnapshot } from './pomerium-store.js';

export function protectionForRoute(db,id) {
  // Old schemas are used by legacy unit fixtures. A present protection table
  // that cannot be read is never treated as an unprotected route.
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='setup_route_protection'").get()) return null;
  if(id==='pomerium-auth-route') return {state:'gateway',upstream:`127.0.0.1:${POMERIUM_PORT}`};
  const p=db.prepare('SELECT state FROM setup_route_protection WHERE route_id=?').get(id);
  if(!p || ['removed','removal_gateway'].includes(p.state)) return null;
  return {state:p.state,upstream:`127.0.0.1:${POMERIUM_PORT}`};
}
export function pomeriumHandlerLines(protection, indent='    ') {
  if(!protection) return null;
  if(!['gateway','protected'].includes(protection.state)) return [`${indent}respond "Application access is paused while gateway protection is verified." 503`];
  return [`${indent}reverse_proxy ${protection.upstream} {`,
    ...IDENTITY_HEADERS.map(h=>`${indent}    header_up -${h}`),
    `${indent}    header_up -Authorization`,
    `${indent}    header_up Host {host}`,`${indent}    header_up X-Forwarded-Proto https`,`${indent}}`];
}
export function assertPomeriumCaddyOwnership(db,r,render,intents) {
  const domain=new URL(r.config.origin).hostname;
  const own=render.caddyFilePath(domain), root=dirname(dirname(own));
  const routeId='pomerium-auth-route';
  if(db.prepare('SELECT id,domain FROM service_http_routes').all().some(x=>x.domain===domain && x.id!==routeId)) throw fail('Authentication hostname already belongs to another route.');
  const paths=[process.env.CADDY_CONFIG_FILE||join(root,'Caddyfile')].filter(existsSync);
  for(const dir of [dirname(own),join(root,'custom')]) if(existsSync(dir)) for(const name of readdirSync(dir)) if(name.endsWith('.caddy')) paths.push(join(dir,name));
  for(const path of paths) {
    const text=readFileSync(path,'utf8');
    const isAuth=path===own && db.prepare('SELECT id FROM service_http_routes WHERE id=?').get(routeId);
    if(!isAuth && (text.includes(domain) || new RegExp(`\\*\\.${domain.slice(domain.indexOf('.')+1).replaceAll('.','\\.')}(?=[\\s,:/{]|$)`).test(text))) throw fail('Pomerium authentication hostname conflicts with existing Caddy configuration.');
    for(const intent of intents.filter(x=>x.action!=='remove')) {
      if(path===render.caddyFilePath(intent.domain)) continue;
      if(text.includes(intent.domain) || text.includes(intent.upstream.replace('http://','')) || text.includes(`localhost:${new URL(intent.upstream).port}`)) throw fail(`Caddy file ${path} may bypass ${intent.domain}; resolve that specific alias before activation.`);
    }
  }
}
export async function configurePomeriumRoutes(db,{revision,stage,render,fence}) {
  let r=readPomerium(db);
  if(!r || r.revision!==revision || !['deny','gateway'].includes(stage)) throw fail('Saved Pomerium revision is missing or superseded.');
  const intents=pomeriumIntents(db).filter(i=>i.state!=='removed' || i.revision===r.revision);
  fence();assertPomeriumCaddyOwnership(db,r,render,intents);
  for(const intent of intents) if(digest(routeSnapshot(db,intent.routeId,r.config))!==intent.snapshot) throw fail('Selected route drifted since review; it will not be silently reconfigured.');
  const domain=new URL(r.config.origin).hostname,serviceId='pomerium-auth',routeId='pomerium-auth-route';
  const old=db.prepare('SELECT * FROM service_http_routes WHERE id=?').get(routeId);
  const service=db.prepare('SELECT * FROM services WHERE id=?').get(serviceId);
  if(service && (service.target_ip!=='127.0.0.1' || service.name!==POMERIUM_APP)) throw fail('Pomerium authentication service ownership changed.');
  if(old && (old.service_id!==serviceId || old.domain!==domain || old.path_prefix!=='/' || old.target_port!==POMERIUM_PORT || !old.ssl_enabled || !old.force_https)) throw fail('Pomerium authentication route ownership changed.');
  fence();
  if(!service) db.prepare("INSERT INTO services(id,name,kind,runtime,target_ip,type,status) VALUES (?,?,'container_service','docker','127.0.0.1','proxy','active')").run(serviceId,POMERIUM_APP);
  if(!old) db.prepare("INSERT INTO service_http_routes(id,service_id,domain,path_prefix,target_port,websocket_enabled,ssl_enabled,force_https,max_upload_size,strip_prefix) VALUES (?,?,?,'/',?,0,1,1,'1G',0)").run(routeId,serviceId,domain,POMERIUM_PORT);
  for(const intent of intents) {
    fence();
    db.prepare('UPDATE setup_route_protection SET state=? WHERE route_id=?').run(stage==='deny'?'pending':intent.action==='remove'?'removal_gateway':'gateway',intent.routeId);
  }
  const domains=[domain,...intents.map(i=>i.domain)];
  try {
    // Never restore a pre-protection direct file. On failure the saved deny /
    // gateway intent stays on disk for restart/retry, and no direct fallback is
    // emitted. The result stays unverified until a successful reload + probe.
    await renderDomains({db,domains,...render,fence,rollbackOnFailure:false});
    if(stage==='deny') {fence();for(const intent of intents) db.prepare("UPDATE setup_route_protection SET state='denied',verified_json=NULL WHERE route_id=?").run(intent.routeId);}
  } catch(e) {
    if(isLeaseLost(e) || e.code==='FENCED') throw e;
    fence();
    for(const intent of intents) db.prepare("UPDATE setup_route_protection SET state='pending',verified_json=NULL WHERE route_id=?").run(intent.routeId);
    // Best effort publish denial using the same renderer; if Caddy is unavailable
    // the job reports that fact and cannot certify protection.
    try {
      await renderDomains({db,domains,...render,fence,rollbackOnFailure:false});
      fence();for(const intent of intents) db.prepare("UPDATE setup_route_protection SET state='denied' WHERE route_id=?").run(intent.routeId);
    } catch(e) {
      if(isLeaseLost(e) || e.code==='FENCED') throw e;
      throw fail(`Caddy denial could not be applied for ${intents.map(i=>i.domain).join(', ') || domain}. Activation is blocked: its running configuration may still serve the previous upstream. Deny intent is saved, but runtime denial is NOT confirmed. Restore Caddy apply before retrying.`);
    }
    throw fail('Caddy validation/apply failed. Confirmed denial is retained for retry; no direct upstream fallback was rendered.');
  }
  return {created:old?[]:[domain],existing:old?[domain]:[],rendered:domains};
}
