import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderDomains } from '../route-render.js';
import { readKeycloak } from './keycloak-store.js';
import { KEYCLOAK_PORT, KEYCLOAK_APP, keycloakJobSchema, keycloakTargetSchema } from './keycloak-logic.js';
export function keycloakRouteParams(db, params) {
  keycloakJobSchema.parse(params);
  const row = readKeycloak(db, params.installationId);
  if (!row || row.ownership !== 'managed' || !row.resources_json) throw new Error('No ready owned runtime is recorded for this route.');
  keycloakTargetSchema.parse({ mode: 'install', url: row.origin, realm: row.realm });
  return { container: KEYCLOAK_APP, ip: '127.0.0.1', serviceName: KEYCLOAK_APP, services: [{ domain: new URL(row.origin).hostname, port: KEYCLOAK_PORT, obtainCert: true }], installationId: row.id };
}
export function assertKeycloakRouteAvailable(db, row) {
  const domain = new URL(row.origin).hostname;
  const serviceId = `keycloak-${row.id}`;
  const matches = name => name && (name.toLowerCase() === domain || (name.startsWith('*.') && domain.endsWith(name.slice(1))));
  if (matches(db.prepare("SELECT value FROM app_settings WHERE key = 'admin_domain'").get()?.value)) throw new Error('Keycloak hostname conflicts with ProxyPilot administration.');
  const legacyDomain = db.prepare('PRAGMA table_info(services)').all().some(c => c.name === 'domain');
  if (db.prepare(`SELECT id${legacyDomain ? ', domain' : ''} FROM services`).all().some(r => r.id !== serviceId && matches(r.domain))) throw new Error('Keycloak hostname belongs to another service.');
  if (db.prepare('SELECT id, service_id, domain FROM service_http_routes').all().some(r => matches(r.domain) && r.id !== `keycloak-route-${row.id}`)) throw new Error('Keycloak hostname belongs to another managed route.');
}
export async function configureKeycloakRoute(db, { installationId, render, fence }) {
  const row = readKeycloak(db, installationId);
  const p = keycloakRouteParams(db, { installationId, revision: row.created_revision });
  const domain = p.services[0].domain, serviceId = `keycloak-${row.id}`, routeId = `keycloak-route-${row.id}`;
  fence(); assertKeycloakRouteAvailable(db, row);
  const old = db.prepare('SELECT * FROM service_http_routes WHERE id = ?').get(routeId);
  if (old && (old.service_id !== serviceId || old.domain !== domain || old.path_prefix !== '/' || old.target_port !== KEYCLOAK_PORT || !old.ssl_enabled || !old.force_https)) throw new Error('Owned Keycloak route has changed; it will not be overwritten.');
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
  if (service && (service.runtime !== 'docker' || service.target_ip !== '127.0.0.1' || service.name !== KEYCLOAK_APP)) throw new Error('Owned Keycloak service has changed; it will not be overwritten.');
  const ownPath = render.caddyFilePath(domain);
  // Check the managed sites and operator custom files, including multiple site
  // blocks per file and wildcard hosts. The existing render validates all Caddy
  // config before reload; no custom file is ever changed by this operation.
  const caddyRoot = dirname(dirname(ownPath));
  const sourcePaths = [process.env.CADDY_CONFIG_FILE || join(caddyRoot, 'Caddyfile')].filter(existsSync);
  for (const dir of [dirname(ownPath), join(caddyRoot, 'custom')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith('.caddy')) sourcePaths.push(path);
    }
  }
  for (const path of sourcePaths) {
      if (path === ownPath && old) continue;
      const source = readFileSync(path, 'utf8');
      const host = domain.replaceAll('.', '\\.');
      const wildcard = domain.slice(domain.indexOf('.') + 1).replaceAll('.', '\\.');
      if (path === ownPath || new RegExp(`(^|[\\s,/:])(?:${host}|\\*\\.${wildcard})(?=[\\s,:/{]|$)`, 'im').test(source)) throw new Error('Keycloak hostname collides with an unmanaged Caddy site.');
  }
  fence();
  if (!service) db.prepare("INSERT INTO services (id, name, kind, runtime, target_ip, type, status) VALUES (?, ?, 'container_service', 'docker', '127.0.0.1', 'proxy', 'active')").run(serviceId, KEYCLOAK_APP);
  fence();
  if (!old) db.prepare("INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size, strip_prefix) VALUES (?, ?, ?, '/', ?, 1, 1, 1, '1G', 0)").run(routeId, serviceId, domain, KEYCLOAK_PORT);
  await renderDomains({ db, domains: [domain], ...render, fence });
  return { created: old ? [] : [domain], existing: old ? [domain] : [], conflicts: [], rendered: [domain] };
}
