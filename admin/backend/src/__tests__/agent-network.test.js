// "Runs in container" for Infisical agents (agent-network.js + infisical-agents.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { agentSourcesForRoute, containerAddress, hostsScript, writeHosts, probe, probeScript, sweepAgentContainers, HOSTS_MARKER } from '../lib/setup-engine/agent-network.js';
import { INFISICAL_AGENTS_SCHEMA, addContainerColumns, linkContainer, unlinkContainer } from '../lib/setup-engine/infisical-agents.js';
import { routeEdgeOptionLines } from '../lib/caddy-site-file.js';

const r = { credential_ref: 'if-ref-0123456789ab', config: { basic: true, mode: 'install', origin: 'https://secure.example.com', proxyOrigin: 'http://192.0.2.10:17322' } };
const context = () => ({ r, s: null });
function host({ containers = { crawler: { ip: '10.0.3.20', uuid: 'u-1', status: 'Running' } }, fail = {} } = {}) {
  const calls = [];
  const inv = () => Object.entries(containers).map(([name, c]) => ({ name, status: c.status, config: { 'volatile.uuid': c.uuid }, expanded_devices: { eth0: { network: 'pp-br0', ...(c.ip ? { 'ipv4.address': c.ip } : {}) } } }));
  const run = (bin, args) => {
    calls.push([bin, ...args]);
    if (fail.list && args[0] === 'list') return { code: 1, stdout: '', stderr: 'down' };
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify(args[1] && !args[1].startsWith('--') ? inv().filter(c => c.name === args[1]) : inv()) };
    if (args[0] === 'network') return { code: 0, stdout: '10.0.3.1/24\n' };
    if (args[0] === 'exec') return { code: fail.exec ? 1 : 0, stdout: '' };
    throw Error('unexpected ' + args.join(' '));
  };
  return { run, calls, containers };
}
const database = () => { const db = new DatabaseSync(':memory:'); db.exec(INFISICAL_AGENTS_SCHEMA); const now = new Date().toISOString();
  db.prepare("INSERT INTO infisical_agents(name,project_id,identity_id,client_id,created_at,updated_at) VALUES ('crawler','p1','i1','c1',?,?)").run(now, now); return db; };

test('the container /32 is admitted on the Infisical route only, alongside the restricted networks', () => {
  const db = database();
  db.prepare("UPDATE infisical_agents SET container='crawler', container_ip='10.0.3.20' WHERE name='crawler'").run();
  assert.deepEqual(agentSourcesForRoute(db, 'infisical-route-abc'), ['10.0.3.20/32']);
  assert.deepEqual(agentSourcesForRoute(db, 'openbao-route-abc'), [], 'never on another route');
  const lines = routeEdgeOptionLines({ ip_allowlist: ['10.100.0.0/24'] }, '    ', { routeId: 'infisical-route-abc', selfCheck: { token: 'a'.repeat(48), extraAllow: agentSourcesForRoute(db, 'infisical-route-abc') } }).join('\n');
  assert.match(lines, /not remote_ip 10\.100\.0\.0\/24 10\.0\.3\.20\/32/);
  const bad = routeEdgeOptionLines({ ip_allowlist: ['10.100.0.0/24'] }, '    ', { selfCheck: { token: 'a'.repeat(48), extraAllow: ['0.0.0.0/0', '10.0.0.0/8'] } }).join('\n');
  assert.doesNotMatch(bad, /0\.0\.0\.0\/0|10\.0\.0\.0\/8/, 'only single addresses are ever added');
});

test('link: pinned address required; name set inside; route re-rendered; Infisical and the proxy probed; unlink removes all of it', async () => {
  const db = database(), h = host(); let renders = 0;
  const out = await linkContainer(db, 'crawler', { container: 'crawler' }, { run: h.run, render: async () => { renders++; }, context });
  assert.deepEqual({ ip: out.ip, gateway: out.gateway, hostname: out.hostname }, { ip: '10.0.3.20', gateway: '10.0.3.1', hostname: 'secure.example.com' });
  assert.deepEqual(out.checks.map(c => [c.label, c.host, c.port, c.reachable]), [['Infisical', '10.0.3.1', 443, true], ['Agent Proxy', '192.0.2.10', 17322, true]]);
  assert.equal(renders, 1);
  assert.deepEqual(agentSourcesForRoute(db, 'infisical-route-x'), ['10.0.3.20/32']);
  const script = h.calls.find(c => c[1] === 'exec' && c.at(-1).includes('/etc/hosts')).at(-1);
  assert.match(script, /10\.0\.3\.1' 'secure\.example\.com/);
  await unlinkContainer(db, 'crawler', { run: h.run, render: async () => { renders++; }, context });
  assert.equal(renders, 2); assert.deepEqual(agentSourcesForRoute(db, 'infisical-route-x'), []);
  const removal = h.calls.filter(c => c[1] === 'exec' && c.at(-1).includes('/etc/hosts')).at(-1).at(-1);
  assert.doesNotMatch(removal, /printf/, 'unlink only removes the marked line');
  const noIp = host({ containers: { crawler: { ip: null, uuid: 'u', status: 'Running' } } });
  await assert.rejects(linkContainer(db, 'crawler', { container: 'crawler' }, { run: noIp.run, render: async () => {}, context }), /no fixed address/);
  const stopped = host({ containers: { crawler: { ip: '10.0.3.20', uuid: 'u', status: 'Stopped' } } });
  await assert.rejects(linkContainer(db, 'crawler', { container: 'crawler' }, { run: stopped.run, render: async () => {}, context }), /Start crawler first/);
});

test('a failed route update admits nothing and takes the name back out', async () => {
  const db = database(), h = host();
  await assert.rejects(linkContainer(db, 'crawler', { container: 'crawler' }, { run: h.run, render: async () => { throw Error('caddy adapt failed'); }, context }), /registry was restored/);
  assert.deepEqual(agentSourcesForRoute(db, 'infisical-route-x'), []);
  assert.doesNotMatch(h.calls.filter(c => c[1] === 'exec').at(-1).at(-1), /printf/);
});

test('sweep: a deleted, re-addressed or replaced container loses its link; an unreadable inventory changes nothing', async () => {
  const db = database(), link = () => db.prepare("UPDATE infisical_agents SET container='crawler', container_ip='10.0.3.20', container_uuid='u-1' WHERE name='crawler'").run();
  let renders = 0; const render = async () => { renders++; };
  link(); assert.deepEqual((await sweepAgentContainers(db, { run: host().run, render })).dropped, []);
  assert.deepEqual((await sweepAgentContainers(db, { run: host({ fail: { list: true } }).run, render })).dropped, []);
  assert.deepEqual((await sweepAgentContainers(db, { run: host({ containers: {} }).run, render })).dropped, ['crawler']);
  link(); assert.deepEqual((await sweepAgentContainers(db, { run: host({ containers: { crawler: { ip: '10.0.3.99', uuid: 'u-1', status: 'Running' } } }).run, render })).dropped, ['crawler']);
  link(); assert.deepEqual((await sweepAgentContainers(db, { run: host({ containers: { crawler: { ip: '10.0.3.20', uuid: 'u-2', status: 'Running' } } }).run, render })).dropped, ['crawler'], 'same name, different container');
  link(); db.prepare("UPDATE infisical_agents SET container_uuid=NULL WHERE name='crawler'").run();
  assert.deepEqual((await sweepAgentContainers(db, { run: host().run, render })).dropped, ['crawler'], 'unidentified legacy link is removed');
  assert.equal(renders, 4);
});

test('the /etc/hosts edit keeps other lines and is idempotent (run in a real shell)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosts-')), file = join(dir, 'hosts');
  try {
    writeFileSync(file, '127.0.0.1 localhost\n10.0.3.5 db\n');
    const run = script => execFileSync('sh', ['-c', script.replaceAll('/etc/hosts', file)]);
    run(hostsScript('secure.example.com', '10.0.3.1')); run(hostsScript('secure.example.com', '10.0.3.1'));
    assert.equal(readFileSync(file, 'utf8'), `127.0.0.1 localhost\n10.0.3.5 db\n10.0.3.1 secure.example.com # ${HOSTS_MARKER}\n`);
    run(hostsScript('secure.example.com', null));
    assert.equal(readFileSync(file, 'utf8'), '127.0.0.1 localhost\n10.0.3.5 db\n');
    assert.throws(() => hostsScript("x'; rm -rf /; '", '10.0.3.1'), /Invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration 1019 adds the container columns to an existing table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE infisical_agents(name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL, identity_id TEXT NOT NULL, client_id TEXT NOT NULL, client_secret_id TEXT, credentials_json TEXT NOT NULL DEFAULT '[]', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  addContainerColumns(db); addContainerColumns(db);
  assert.deepEqual(db.prepare('PRAGMA table_info(infisical_agents)').all().map(c => c.name).slice(-3), ['container', 'container_ip', 'container_uuid']);
  assert.throws(() => containerAddress('bad name!'), /by its name/);
});

test('relink removes a stale guest marker and failed unlink restores the stored admission', async () => {
  const db = database(), h = host({ containers: { crawler: { ip: '10.0.3.20', uuid: 'u-1', status: 'Running' }, next: { ip: '10.0.3.21', uuid: 'u-2', status: 'Running' } } });
  await linkContainer(db, 'crawler', { container: 'crawler' }, { run: h.run, render: async () => {}, context });
  await linkContainer(db, 'crawler', { container: 'next' }, { run: h.run, render: async () => {}, context });
  assert.deepEqual(agentSourcesForRoute(db, 'infisical-route-x'), ['10.0.3.21/32']);
  assert.ok(h.calls.some(c => c[1] === 'exec' && c[2] === 'crawler' && !c.at(-1).includes('printf')));
  await assert.rejects(unlinkContainer(db, 'crawler', { run: h.run, render: async () => { throw Error('reload failed'); }, context }), /registry was restored/);
  assert.deepEqual(agentSourcesForRoute(db, 'infisical-route-x'), ['10.0.3.21/32']);
});

test('invalid stored probe configuration is refused before hosts and route changes', async () => {
  const db = database(), h = host(); let renders = 0;
  const badContext = () => ({ r: { config: { origin: 'https://secure.example.com', proxyOrigin: 'http://bad.example.com:0' } }, s: null });
  await assert.rejects(linkContainer(db, 'crawler', { container: 'crawler' }, { run: h.run, render: async () => { renders++; }, context: badContext }), /Invalid probe/);
  assert.equal(renders, 0);
  assert.equal(h.calls.filter(c => c[1] === 'exec').length, 0);
  assert.deepEqual(agentSourcesForRoute(db, 'infisical-route-x'), []);
});

test('privileged network helpers refuse hostile stored names and probe targets before execution', () => {
  const h = host();
  const badNetwork = (bin, args) => {
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify([{ name: 'crawler', status: 'Running', expanded_devices: { eth0: { network: '-bad', 'ipv4.address': '10.0.3.20' } } }]) };
    throw Error('network command must not run');
  };
  assert.throws(() => containerAddress('crawler', { run: badNetwork }), /no fixed address/);
  assert.throws(() => writeHosts('-bad', 'secure.example.com', '10.0.3.1', { run: h.run }), /by its name/);
  assert.throws(() => writeHosts('crawler', 'a'.repeat(64) + '.example.com', '10.0.3.1', { run: h.run }), /Invalid host/);
  assert.throws(() => probeScript("x'; touch /tmp/injected; '", 443), /Invalid probe/);
  assert.throws(() => probeScript('secure.example.com', 0), /Invalid probe/);
  assert.throws(() => probeScript('secure.example.com', 65536), /Invalid probe/);
  assert.throws(() => probe('crawler', [['bad', 'secure.example.com', '443']], { run: h.run }), /Invalid probe/);
  assert.deepEqual(h.calls, [], 'refused helpers never execute incus');
});
