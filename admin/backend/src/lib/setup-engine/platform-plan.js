// Saved intentions remain separate from G2 applied, immutable installation records.
import { z } from 'zod';
import { keycloakState } from './keycloak-store.js';
import { realmSchema } from './keycloak-logic.js';
import { validateConnectorInput } from '../../mock2/connector-logic.js';
import { validateOperatorEgressInput } from '../../mock2/egress-logic.js';
import { evaluateBaseDomain } from '../../mock2/domain-logic.js';
import { runnerAvailable } from './backend.js';
import { executorPolicy } from './logic.js';
import { agentCall } from '../agent.js';
import { readSystemStats } from '../system-stats.js';

export { PLATFORM_PLAN_SCHEMA } from './store.js';

export const SERVICES = [
  { id: 'keycloak', name: 'Keycloak', description: 'Identity provider for shared sign-in. Login activation requires the later identity and recovery adapters.' },
  { id: 'pomerium', name: 'Pomerium', description: 'Access gateway: Caddy → Pomerium → application. Requires a verified identity provider; selecting Keycloak only records that intention.' },
  { id: 'infisical', name: 'Infisical with Agent Proxy', description: 'Application secrets through Agent Proxy. Both endpoints are planned together; no credentials are collected.' },
  { id: 'openbao', name: 'OpenBao', description: 'Secrets and policy service. Initialization, unseal and recovery material are handled by a later adapter.' },
  { id: 'vaultwarden', name: 'Vaultwarden', description: 'Password vault. TLS, backup and recovery checks are required before a later installation can be activated.' },
];

const endpoint = z.string().trim().max(300).refine((value) => {
  if (!value) return true;
  if (validateConnectorInput({ provider: 'openai_compatible', base_url: value })) return false;
  try {
    const u = new URL(value);
    // Origin only: no userinfo, query tokens, fragments or secret-bearing paths.
    if (u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname) || /[\\\s?#]/.test(value)) return false;
    return validateOperatorEgressInput({ host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), protocol: u.protocol.slice(0, -1) }).ok;
  } catch { return false; }
}, 'Use an http(s) origin such as https://identity.example.com, without credentials, paths, query parameters or fragments.')
  .transform((value) => value ? new URL(value).origin.toLowerCase().replace(/\.(?=:\d+$|$)/, '') : '');
const choice = z.object({ mode: z.enum(['install', 'connect', 'skip']), url: endpoint }).strict();
const keycloakChoice = choice.extend({ realm: realmSchema.optional() }).strict();
const infisicalChoice = choice.extend({ agentProxyUrl: endpoint }).strict();
export const choicesSchema = z.object(Object.fromEntries(SERVICES.map(({ id }) => [id, id === 'keycloak' ? keycloakChoice : id === 'infisical' ? infisicalChoice : choice]))).strict().superRefine((choices, ctx) => {
  for (const { id } of SERVICES) {
    const c = choices[id];
    for (const field of id === 'infisical' ? ['url', 'agentProxyUrl'] : ['url']) {
      if (c.mode !== 'skip' && !c[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [id, field], message: 'An endpoint is required for an install or connection plan.' });
      if (c.mode === 'skip' && c[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [id, field], message: 'Skipped services must not retain endpoints.' });
    }
  }
});
export const planInputSchema = z.object({ schemaVersion: z.literal(1), choices: choicesSchema }).strict();
export const savePlanSchema = planInputSchema.extend({ expectedRevision: z.number().int().nonnegative(), reviewed: z.literal(true) }).strict();
export function emptyChoices() {
  return Object.fromEntries(SERVICES.map(({ id }) => [id, { mode: 'skip', url: '', ...(id === 'infisical' ? { agentProxyUrl: '' } : {}) }]));
}
export function planDependencies(choices) {
  const issues = [];
  if (choices.pomerium.mode !== 'skip' && choices.keycloak.mode === 'skip') issues.push('Pomerium needs a verified identity provider. Keycloak is skipped; an existing provider must be verified by the later Pomerium adapter.');
  const hosts = new Map();
  for (const { id, name } of SERVICES) {
    const c = choices[id];
    if (c.mode === 'skip') continue;
    for (const url of [c.url, c.agentProxyUrl].filter(Boolean)) {
      const host = new URL(url).hostname;
      if (hosts.has(host)) issues.push(`${name} shares ${host} with ${hosts.get(host)}. Resolve the endpoint overlap before installation or connection.`);
      else hosts.set(host, name);
    }
  }
  return issues;
}
export function readPlatformPlan(db) {
  const row = db.prepare('SELECT * FROM setup_platform_plan WHERE id = 1').get();
  return row ? { schemaVersion: row.schema_version, revision: row.revision, status: 'saved_plan', choices: JSON.parse(row.choices_json), checks: JSON.parse(row.checks_json), reviewedAt: row.reviewed_at, reviewedBy: row.reviewed_by } :
    { schemaVersion: 1, revision: 0, status: 'not_saved', choices: emptyChoices(), checks: null, reviewedAt: null, reviewedBy: null };
}
export function platformInventory(db) {
  // Migration D.14 removed services.domain; legacy checkouts still have it.
  const legacyDomain = db.prepare('PRAGMA table_info(services)').all().some(c => c.name === 'domain');
  const services = db.prepare(`SELECT id, name${legacyDomain ? ', domain' : ''} FROM services`).all();
  const routes = db.prepare('SELECT id, domain FROM service_http_routes').all();
  const adminDomain = db.prepare("SELECT value FROM app_settings WHERE key = 'admin_domain'").get()?.value || null;
  return { services, routes, adminDomain };
}
export function platformState(db) {
  const { services, routes, adminDomain } = platformInventory(db);
  const verified = keycloakState(db).filter(r => r.verification).sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
  return {
    classification: services.length || routes.length || adminDomain ? 'existing_configuration' : 'unknown',
    reason: services.length || routes.length || adminDomain ? 'Existing ProxyPilot configuration is recorded. Service installation and health are not inferred from it.' : 'No managed routes are recorded. This does not establish a fresh installation; unmanaged or external services may exist.',
    verifiedServices: SERVICES.map(({ id, name }) => id === 'keycloak' && verified ? { id, name, state: verified.verification.state, connectionRef: verified.id, verifiedAt: verified.verifiedAt, reason: verified.verification.label } : { id, name, state: 'not_checked', reason: id === 'keycloak' ? 'No verified Keycloak connection is recorded.' : 'A service-specific verification adapter is not available.' }),
    installationAvailable: true, installableServices: ['keycloak'], loginActivationAvailable: false,
  };
}

export async function checkPlatformPlan(db, choices, { callAgent = agentCall, systemStats = readSystemStats, nowMs = Date.now() } = {}) {
  const checks = [];
  const add = (id, label, status, reason, facts = undefined) => checks.push({ id, label, status, reason, ...(facts ? { facts } : {}) });
  const inventory = platformInventory(db);
  const dependencies = planDependencies(choices);
  add('dependencies', 'Dependencies and endpoint choices', dependencies.length ? 'fail' : 'pass', dependencies.length ? dependencies.join(' ') : 'No conflicting choices recorded. Service-specific prerequisites still require their adapters.');
  const runner = runnerAvailable(db, { nowMs });
  add('runner', 'Setup runner', runner ? 'pass' : 'fail', runner ? 'A recent runner heartbeat is recorded; this does not provide service installation adapters.' : 'No recent setup-runner heartbeat. Restore runner availability before future installation.', { policy: executorPolicy(), lastHeartbeat: runner?.heartbeat_at || null });
  await Promise.all([
    (async () => {
      try {
        const pong = await callAgent('agent.ping', {}, { timeoutMs: 2500 });
        if (pong !== 'pong') throw new Error('Invalid ping response');
        add('agent', 'Host agent', 'pass', 'The existing read-only agent.ping interface responded.');
      } catch { add('agent', 'Host agent', 'not_checked', 'The host agent did not respond through its configured socket. No host-shell fallback was attempted.'); }
    })(),
    (async () => {
      try {
        const result = await callAgent('caddy.version', {}, { timeoutMs: 2500 });
        if (typeof result?.version !== 'string' || !/^v?[0-9]+\.[0-9]+/.test(result.version)) throw new Error('Invalid version response');
        add('caddy', 'Caddy runtime', 'pass', 'The existing host-agent version probe responded. This does not verify routes or service adapters.', { version: result.version.slice(0, 160) });
      } catch { add('caddy', 'Caddy runtime', 'not_checked', 'The existing caddy.version agent capability is unavailable or did not answer. No host-shell fallback was attempted.'); }
    })(),
    (async () => {
      try {
        const stats = await systemStats();
        add('capacity', 'Available capacity facts', 'pass', 'API-visible CPU, memory and filesystem facts collected using the existing system-stats reader. Container limits and target-host suitability are not established.', { cpuCores: stats.cpu.cores, memoryTotalBytes: stats.memory.total, memoryFreeBytes: stats.memory.free, diskFreeBytes: stats.disk.total ? stats.disk.free : null });
      } catch { add('capacity', 'Available capacity facts', 'not_checked', 'The existing system-stats reader could not collect capacity facts.'); }
    })(),
  ]);
  add('runtime', 'Target runtime and installation capacity', 'not_checked', 'No service adapter exposes target runtime/version or sizing requirements. API-visible capacity and a runner heartbeat do not prove host readiness.');
  for (const { id, name } of SERVICES) {
    const c = choices[id];
    if (c.mode === 'skip') continue;
    for (const [field, url] of Object.entries(c).filter(([key, value]) => ['url', 'agentProxyUrl'].includes(key) && value)) {
      const verdict = evaluateBaseDomain({ domain: new URL(url).hostname, ...inventory });
      add(`${id}-${field}-route`, `${name}${field === 'agentProxyUrl' ? ' Agent Proxy' : ''}: recorded routes`, verdict.available ? 'pass' : c.mode === 'install' ? 'fail' : 'not_checked', verdict.available ? 'No conflict in ProxyPilot’s recorded services, routes or admin domain. Unmanaged Caddy configuration is not checked.' : c.mode === 'install' ? verdict.reason : `${verdict.reason}. A connect plan preserves it; ownership and service identity need verification.`);
      add(`${id}-${field}-network`, `${name}${field === 'agentProxyUrl' ? ' Agent Proxy' : ''}: endpoint verification`, 'not_checked', 'URL syntax and the existing egress host/port validator passed. No service-specific probe with an approved network-access policy exists; DNS, TLS, reachability and identity were not checked. No egress grant was created.');
    }
  }
  return { checkedAt: new Date(nowMs).toISOString(), dependencies, checks: checks.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function savePlatformPlan(db, input, checks, by) {
  // Compare-and-swap prevents a stale browser overwriting another administrator.
  const values = [input.schemaVersion, JSON.stringify(input.choices), JSON.stringify(checks), new Date().toISOString(), String(by)];
  const result = input.expectedRevision === 0 ?
    db.prepare('INSERT OR IGNORE INTO setup_platform_plan (id, revision, schema_version, choices_json, checks_json, reviewed_at, reviewed_by) VALUES (1, 1, ?, ?, ?, ?, ?)').run(...values) :
    db.prepare('UPDATE setup_platform_plan SET revision = revision + 1, schema_version = ?, choices_json = ?, checks_json = ?, reviewed_at = ?, reviewed_by = ? WHERE id = 1 AND revision = ?').run(...values, input.expectedRevision);
  if (!result.changes) return null;
  return readPlatformPlan(db);
}
