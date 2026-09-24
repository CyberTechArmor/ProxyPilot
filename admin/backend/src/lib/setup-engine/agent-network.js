// "Runs in container" for Infisical agents (docs/features/agents.md § Agents in
// containers on this host). An agent in an LXC guest reaches Infisical and the
// Agent Proxy without the VPN:
//  1. its container's pinned address (/32) is admitted on the Infisical route
//     ONLY, added when the route is rendered (agentSourcesForRoute); the stored
//     restricted networks and every other route are untouched;
//  2. inside the container the Infisical hostname resolves to the host's bridge
//     address (one marked /etc/hosts line), so requests reach Caddy directly
//     with the container's own address instead of looping out through the
//     router and back as the router's address;
//  3. reachability of Infisical (443) and the Agent Proxy is probed from inside.
// A sweep drops the link when the container is gone or its address changed.
import { spawnHostSync } from '../host-exec.js';
import { infisicalError as fail } from './infisical-logic.js';

export const HOSTS_MARKER = 'proxypilot-infisical-agent';
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
export const hostRunner = (bin, args, opts = {}) => { const r = spawnHostSync(bin, args, { encoding: 'utf8', timeout: 30000, ...opts }); return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }; };

const has = (db, t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasColumn = (db, c) => has(db, 'infisical_agents') && db.prepare('PRAGMA table_info(infisical_agents)').all().some(x => x.name === c);

/** The /32s admitted on the Infisical route for linked agent containers. */
export function agentSourcesForRoute(db, routeId) {
  if (!db || !/^infisical-route-/.test(String(routeId || '')) || !hasColumn(db, 'container_ip')) return [];
  return [...new Set(db.prepare("SELECT container_ip FROM infisical_agents WHERE container_ip IS NOT NULL AND container_ip<>''").all().map(r => r.container_ip).filter(ip => IPV4.test(ip)).map(ip => `${ip}/32`))].sort();
}

/** The container's pinned eth0 address, its bridge, the bridge gateway and its identity. */
export function containerAddress(container, { run = hostRunner } = {}) {
  if (!NAME.test(container || '')) throw fail('Choose a container by its name.');
  const listed = run('incus', ['list', container, '--format', 'json']);
  let item = null; try { item = JSON.parse(listed.stdout || '[]').find(c => c.name === container); } catch { item = null; }
  if (listed.code !== 0 || !item) throw fail(`Container ${container} was not found.`);
  const eth0 = item.expanded_devices?.eth0 || {}, ip = eth0['ipv4.address'], network = eth0.network;
  if (!IPV4.test(ip || '') || !network) throw fail(`Container ${container} has no fixed address on its network. Give it a fixed IPv4 address (eth0 ipv4.address) first, so the allowed address cannot move to another container.`);
  const gw = run('incus', ['network', 'get', network, 'ipv4.address']), gateway = String(gw.stdout || '').trim().split('/')[0];
  if (gw.code !== 0 || !IPV4.test(gateway)) throw fail(`The address of network ${network} could not be read.`);
  return { container, ip, network, gateway, uuid: item.config?.['volatile.uuid'] || null, running: item.status === 'Running' };
}

// One marked line: "<gateway> <hostname> # proxypilot-infisical-agent". Other lines are kept.
export const hostsScript = (hostname, gateway) => {
  if (!HOST.test(hostname) || (gateway && !IPV4.test(gateway))) throw fail('Invalid host name or address.');
  const keep = `grep -v '# ${HOSTS_MARKER}$' /etc/hosts > /etc/hosts.pp-tmp || true`;
  const add = gateway ? `; printf '%s %s # ${HOSTS_MARKER}\\n' '${gateway}' '${hostname}' >> /etc/hosts.pp-tmp` : '';
  return `set -e; ${keep}${add}; cat /etc/hosts.pp-tmp > /etc/hosts; rm -f /etc/hosts.pp-tmp`;
};
export function writeHosts(container, hostname, gateway, { run = hostRunner } = {}) {
  const r = run('incus', ['exec', container, '--', 'sh', '-c', hostsScript(hostname, gateway)]);
  if (r.code !== 0) throw fail(`The Infisical name could not be set inside ${container} (is it running?). Nothing else was changed.`);
}

// TCP reachability from inside the container, with whatever the image has.
export const probeScript = (host, port) => `h='${host}'; p='${port}'; if command -v nc >/dev/null 2>&1; then nc -z -w 5 "$h" "$p"; elif command -v bash >/dev/null 2>&1; then timeout 5 bash -c "</dev/tcp/$h/$p"; elif command -v python3 >/dev/null 2>&1; then python3 -c "import socket,sys;socket.create_connection((sys.argv[1],int(sys.argv[2])),5)" "$h" "$p"; else exit 3; fi`;
export function probe(container, targets, { run = hostRunner } = {}) {
  return targets.map(([label, host, port]) => {
    const r = run('incus', ['exec', container, '--', 'sh', '-c', probeScript(host, port)]);
    return { label, host, port, reachable: r.code === 0 ? true : r.code === 3 ? null : false };
  });
}

/** Periodic: a link whose container is gone, or whose address or identity
 * changed, is dropped. An unreadable inventory changes nothing. */
export async function sweepAgentContainers(db, { run = hostRunner, render } = {}) {
  if (!hasColumn(db, 'container')) return { dropped: [] };
  const rows = db.prepare("SELECT name, container, container_ip, container_uuid FROM infisical_agents WHERE container IS NOT NULL AND container<>''").all();
  if (!rows.length) return { dropped: [] };
  const listed = run('incus', ['list', '--format', 'json']);
  let all; try { all = listed.code === 0 ? JSON.parse(listed.stdout || 'null') : null; } catch { all = null; }
  if (!Array.isArray(all)) return { dropped: [], skipped: 'inventory_unreadable' };
  const byName = new Map(all.map(c => [c.name, c])), dropped = [];
  for (const row of rows) {
    const c = byName.get(row.container), ip = c?.expanded_devices?.eth0?.['ipv4.address'], uuid = c?.config?.['volatile.uuid'] || null;
    if (c && ip === row.container_ip && (!row.container_uuid || uuid === row.container_uuid)) continue;
    db.prepare('UPDATE infisical_agents SET container=NULL, container_ip=NULL, container_uuid=NULL, updated_at=? WHERE name=?').run(new Date().toISOString(), row.name);
    dropped.push(row.name);
  }
  if (dropped.length && render) await render();
  return { dropped };
}
