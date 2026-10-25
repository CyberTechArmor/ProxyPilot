// A scripted LEGACY guest for the foundation adoption service tests
// (mock2/foundation-adopt-service.js). It answers the service's guest scripts
// and host commands from one in-memory machine:
//
//   * Incus: the instance (type, status, config, snapshots, custom volumes);
//     `snapshot create` keeps a full copy of the machine, `snapshot restore`
//     puts it back (config included, as Incus does); restart/stop/start start
//     the units that are enabled;
//   * the guest: the app unit, the native PostgreSQL (tables + row counts, the
//     data directory never touched), /etc/environment, the working copy and
//     the project's bare repository, Docker and the foundation stack's
//     PostgreSQL (tables + counts after the restore);
//   * the foundation adapters (master key, bring-up, superuser psql, the CLI),
//     the deploy (the REAL resolveDeployParams + validateDeployEnvironment, so
//     an adopted guest passes the real foundation deploy check), the restart
//     hook, the repository head/reset.
//
// `fail` injects one failure per step; `trace` records every call in order,
// with whether the adoption's lease held the checkout lock at that moment.

import crypto from 'node:crypto';
import {
  READ_ENVIRONMENT_SCRIPT, COUNT_SQL, OWNER_SQL, DUMP_ROOT,
} from '../../mock2/foundation-adopt-logic.js';

const sha40 = () => crypto.randomBytes(20).toString('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));

// Minimal reader for the ustar payload of seed-tar.js.
export function untar(base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = str(0, 100); const prefix = str(345, 500);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const p = prefix ? `${prefix}/${name}` : name;
    out.push({ path: p, content: buf.subarray(off + 512, off + 512 + size).toString('utf8'), mode: parseInt(str(100, 108).trim() || '644', 8) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export const PLANTED = Object.freeze({
  auth: 'planted-auth-0123456789abcdefXYZ',
  session: 'planted-session-abcdefghijklmnop',
  dbPassword: 'app-planted-pw',
});

export function legacyGuest({ pkg, components = true } = {}) {
  const head = sha40();
  return {
    type: 'container', running: true, config: { 'limits.cpu': '2' }, customVolumes: 0,
    appUnit: { enabled: 'enabled', active: true },
    native: { enabled: 'enabled', running: true, size: 9 * 1024 * 1024, tables: { 'public.health_checks': 1, 'public.users': 3, 'public.sessions': 7 }, dataDir: 'untouched' },
    env: `PATH="/usr/local/bin:/usr/bin"\nAUTH_MASTER_SECRET=${PLANTED.auth}\nexport SESSION_SECRET="${PLANTED.session}"\nDATABASE_URL=postgres://app:${PLANTED.dbPassword}@127.0.0.1:5432/app\nOPERATOR_SETTING=keep\n`,
    pkg,
    manifest: true, foundationDir: false, stackDir: false,
    head, bareMain: head, dirty: [], files: {},
    docker: false, stack: { up: false, features: null, tables: null, masterKeyWritten: false },
    diskFree: 30 * 1024 ** 3,
    dumps: {},
    unitFoundation: false,
    components,
  };
}

// createAdoptWorld({ guest, getLeaseHeld }) → { deps, g, trace, fail, notes }
export function createAdoptWorld({ guest, leaseHeld = () => null, resolveDeployParams, validateDeployEnvironment, buildDevServiceUnit }) {
  const g = guest;
  const snapshots = new Map();          // name → { created_at, state }
  const trace = [];
  const fail = {};                      // step marker → message (one shot unless sticky)
  const notes = [];
  const shot = (k) => { if (!fail[k]) return null; const m = fail[k]; if (!String(m).startsWith('sticky:')) delete fail[k]; return String(m).replace(/^sticky:/, ''); };
  const res = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });
  const record = (kind, what) => trace.push({ kind, what, lease: leaseHeld() });
  let snapClock = Date.parse('2026-10-25T10:00:00Z');

  const machine = () => {
    const m = clone({ ...g });
    delete m.dumps; delete m.bareMain; delete m.stackDump;
    return m;
  };
  const bootUnits = () => {
    g.appUnit.active = g.appUnit.enabled === 'enabled';
    g.native.running = g.native.enabled === 'enabled';
  };

  function probe() {
    const lines = ['PROBE:v1'];
    lines.push(g.pkg == null ? 'PKG:missing' : `PKG:${Buffer.from(g.pkg).toString('base64')}`);
    lines.push(`MANIFEST:${g.manifest ? 'yes' : 'no'}`);
    lines.push(`FOUNDATION_DIR:${g.foundationDir ? 'yes' : 'no'}`);
    lines.push(`GIT_HEAD:${g.head}`, `GIT_REMOTE:${g.bareMain}`);
    lines.push(`GIT_REMOTE_IN_HEAD:${g.bareMain === g.head || g.history?.includes(g.bareMain) ? 'yes' : 'no'}`, 'GIT_AHEAD:0');
    for (const d of g.dirty) lines.push(`GIT_DIRTY:${d}`);
    for (const line of g.env.split('\n')) { const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/); if (m) lines.push(`ENV_KEY:${m[1]}`); }
    lines.push(`DISK_FREE:${g.diskFree}`, `STACK_PRESENT:${g.stackDir ? 'yes' : 'no'}`);
    if (!g.native.running) lines.push('NATIVE:unreachable');
    else {
      lines.push(`DB_SIZE:${g.native.size}`);
      for (const t of Object.keys(g.native.tables).sort()) lines.push(`TABLE:${t}`);
      lines.push('NATIVE:ok');
    }
    lines.push('PROBE:end');
    return `${lines.join('\n')}\n`;
  }
  const countsOut = (tables) => `${Object.keys(tables).sort().map((t) => `ADOPT_COUNT:${t}\t${tables[t]}`).join('\n')}${Object.keys(tables).length ? '\n' : ''}ADOPT_COUNT_DONE\n`;

  async function guestExec(container, script, { args = [], input = null } = {}) {
    if (!g.running) return res(1, '', `Error: Instance is not running`);
    const s = String(script);
    if (s.includes('PROBE:v1')) { record('guest', 'probe'); return res(0, probe()); }
    if (s.includes('APP_STOPPED')) {
      record('guest', 'stop_app');
      const m = shot('stop_app'); if (m) return res(1, `WAS_ENABLED:${g.appUnit.enabled}\nAPP_STOPPED:no\n`, m);
      const was = g.appUnit.enabled; g.appUnit = { enabled: 'disabled', active: false };
      return res(0, `WAS_ENABLED:${was}\nAPP_STOPPED:yes\n`);
    }
    if (s.includes('DUMP_SHA256')) {
      record('guest', 'dump');
      const m = shot('dump_database'); if (m) return res(1, '', m);
      if (!g.native.running) return res(2, '', 'psql: error: connection to server on socket failed');
      const id = (s.match(/D='([^']+)'/) || [])[1];
      const path = `${id}/app.dump`;
      g.dumps[path] = { tables: { ...g.native.tables } };
      return res(0, `DUMP_PATH:${path}\nDUMP_SIZE:${4 * 1024 * 1024}\nDUMP_SHA256:${'d'.repeat(64)}\n${countsOut(g.native.tables)}`);
    }
    if (s.includes('NATIVE_STOPPED')) {
      record('guest', 'stop_native');
      const m = shot('stop_native_database'); if (m) return res(1, 'NATIVE_STOPPED:no\n', m);
      const was = g.native.enabled; g.native.enabled = 'disabled'; g.native.running = false;
      const busy = shot('port_busy');
      return res(busy ? 1 : 0, `WAS_ENABLED:${was}\nNATIVE_STOPPED:yes\nPORT_FREE:${busy ? 'no' : 'yes'}:5432\n`);
    }
    if (s.includes('NATIVE_ONLINE')) {
      record('guest', 'port_check');
      const busy = g.native.running || g.stack.up || !!g.portSquatter;
      const owner = g.stack.up ? 'mock2-foundation' : 'none';
      return res(0, `NATIVE_ONLINE:${g.native.running ? 1 : 0}\nPORT_FREE:${busy ? 'no' : 'yes'}:5432\n${g.docker ? `PORT_OWNER:${owner}\n` : ''}`);
    }
    if (s.trim() === 'echo ADOPT_GUEST_UP') return res(0, 'ADOPT_GUEST_UP\n');
    if (s.includes('FOUNDATION SETUP FAILED')) {
      record('guest', 'install_runtime');
      const m = shot('install_runtime'); if (m) return res(41, '', `[mock2] FOUNDATION SETUP FAILED: ${m}`);
      if (!g.config['security.nesting']) return res(43, '', '[mock2] FOUNDATION SETUP FAILED: the Docker daemon did not start in this guest');
      g.docker = true;
      return res(0, '[mock2] foundation runtime ready\n');
    }
    if (s.includes('echo "DOCKER:')) return res(0, g.docker ? 'DOCKER:26.1.5\nCOMPOSE:2.26.1\nDRIVER:overlay2\n' : 'DOCKER:missing\n');
    if (s.includes('RESTORE:done')) {
      record('guest', 'restore');
      const m = shot('restore_database'); if (m) return res(1, 'RESTORE_EXTENSIONS:done\n', `pg_restore: error: ${m}`);
      const dump = g.dumps[args[0]];
      if (!dump || !g.stack.up) return res(3, '', 'RESTORE:missing');
      g.stack.tables = { ...dump.tables };
      if (g.restoreDropsRow) { const t = Object.keys(g.stack.tables)[0]; g.stack.tables[t] -= 1; }
      return res(0, 'RESTORE_EXTENSIONS:done\nRESTORE:done\n');
    }
    if (s === READ_ENVIRONMENT_SCRIPT) { record('guest', 'read_env'); return res(0, g.env); }
    if (s.includes('ENV_REMAINING')) {
      record('guest', 'rewrite_env');
      const m = shot('move_secrets'); if (m) return res(1, '', m);
      const keys = new Set(args);
      g.env = g.env.split('\n').filter((l) => { const k = (l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/) || [])[1]; return !k || !keys.has(k); }).join('\n');
      return res(0, 'ENV_REMAINING:0\n');
    }
    if (s.startsWith("cat '/srv/app/package.json'")) return g.pkg == null ? res(1, '', 'No such file') : res(0, g.pkg);
    if (s.includes('PUSH:ok')) {
      record('guest', 'module_commit');
      const files = untar(input);
      const m = shot('install_foundation_module'); if (m) return res(1, '', `error: failed to push some refs: ${m}`);
      const pkg = files.find((f) => f.path === 'package.json')?.content;
      const changed = pkg !== g.pkg || !files.every((f) => g.files[f.path] === f.content);
      for (const f of files) g.files[f.path] = f.content;
      g.pkg = pkg;
      if (changed) { g.history = [...(g.history || []), g.head]; g.head = sha40(); g.lastCommitFiles = files.map((f) => f.path); }
      g.bareMain = g.head;
      return res(0, `${changed ? 'COMMIT:made' : 'COMMIT:none'}\nHEAD:${g.head}\nPUSH:ok\n`);
    }
    return res(1, '', `scripted guest: unexpected script: ${s.slice(0, 80)}`);
  }

  async function host(argv) {
    const [bin, ...a] = argv;
    if (bin === 'incus' && a[0] === 'list') {
      record('host', 'incus list');
      const inst = {
        name: a[1], type: g.type, status: g.running ? 'Running' : 'Stopped', config: { ...g.config },
        snapshots: [...snapshots.entries()].map(([name, v]) => ({ name, created_at: v.created_at })),
        expanded_devices: { root: { type: 'disk', path: '/' }, reporepo: { type: 'disk', source: '/var/lib/proxypilot/mock2/repos/1.git', path: '/srv/repo.git' }, ...(g.customVolumes ? { data: { type: 'disk', pool: 'default', source: 'vol', path: '/data' } } : {}) },
      };
      return res(0, JSON.stringify([inst]));
    }
    if (bin === 'incus' && a[0] === 'snapshot' && a[1] === 'create') {
      record('host', `snapshot create ${a[3]}`);
      const m = shot('snapshot'); if (m) return res(1, '', `Error: ${m}`);
      snapClock += 60_000;
      snapshots.set(a[3], { created_at: new Date(snapClock).toISOString(), state: machine() });
      return res(0);
    }
    if (bin === 'incus' && a[0] === 'snapshot' && a[1] === 'restore') {
      record('host', `snapshot restore ${a[3]}`);
      const m = shot('rollback_restore'); if (m) return res(1, '', `Error: ${m}`);
      const snap = snapshots.get(a[3]);
      if (!snap) return res(1, '', 'Error: snapshot not found');
      const keep = { dumps: g.dumps, bareMain: g.bareMain };
      for (const k of Object.keys(g)) delete g[k];
      Object.assign(g, clone(snap.state), keep);
      bootUnits();
      return res(0);
    }
    if (bin === 'incus' && a[0] === 'config' && a[1] === 'set') {
      record('host', `config set ${a.slice(3).join(' ')}`);
      for (const kv of a.slice(3)) { const i = kv.indexOf('='); g.config[kv.slice(0, i)] = kv.slice(i + 1); }
      return res(0);
    }
    if (bin === 'incus' && a[0] === 'config' && a[1] === 'unset') { record('host', `config unset ${a[3]}`); delete g.config[a[3]]; return res(0); }
    if (bin === 'incus' && a[0] === 'restart') {
      record('host', 'restart');
      const m = shot('docker_ready'); if (m) return res(1, '', `Error: ${m}`);
      g.running = true; g.restarts = (g.restarts || 0) + 1; bootUnits();
      return res(0);
    }
    if (bin === 'incus' && a[0] === 'stop') { record('host', 'stop'); g.running = false; g.appUnit.active = false; g.native.running = false; return res(0); }
    if (bin === 'incus' && a[0] === 'start') { record('host', 'start'); g.running = true; bootUnits(); return res(0); }
    return res(1, '', `scripted host: unexpected ${argv.join(' ')}`);
  }

  const deps = {
    native: { port: null },
    guest: guestExec,
    host,
    ensureMasterKey: async (container, key) => { record('stack', 'master-key'); g.stack.masterKeyWritten = !!key; return { ok: true, changed: true }; },
    bringUpFoundation: async ({ features }) => {
      record('stack', 'bring-up');
      const m = shot('start_foundation'); if (m) return { ok: false, steps: [{ name: 'pull', ok: false, detail: m }], error: m };
      // A bring-up that started PostgreSQL and then failed (its port is now
      // published by the stack itself).
      const late = shot('start_foundation_late');
      if (late) { g.stack.up = true; g.stackDir = true; g.stack.tables = g.stack.tables || {}; return { ok: false, steps: [{ name: 'up', ok: true }, { name: 'storage-identities', ok: false }], error: late }; }
      if (!g.docker) return { ok: false, steps: [{ name: 'docker', ok: false }], error: 'Docker is not installed in the guest' };
      if (g.native.running) return { ok: false, steps: [{ name: 'up', ok: false }], error: 'Bind for 127.0.0.1:5432 failed: port is already allocated' };
      g.stack.up = true; g.stack.features = clone(features); g.stackDir = true;
      if (!g.stack.tables) g.stack.tables = g.preexistingTables ? { ...g.preexistingTables } : {};
      return { ok: true, steps: [{ name: 'docker', ok: true }, { name: 'up', ok: true }, { name: 'schema', ok: true }] };
    },
    foundationPsql: async (container, sql) => {
      if (!g.stack.up) return res(2, '', 'service "postgres" is not running');
      if (sql === COUNT_SQL) { record('stack', 'count'); return res(0, countsOut(g.stack.tables || {})); }
      if (/CREATE EXTENSION IF NOT EXISTS vector/.test(sql)) return res(0, 'CREATE EXTENSION\n');
      if (sql === OWNER_SQL) return res(0, 'ADOPT_NOT_APP_OWNED:0\n');
      return res(1, '', 'scripted psql: unexpected SQL');
    },
    foundationCli: async (container, args) => {
      record('stack', `cli ${args[0]}`);
      if (args[0] !== 'health') return res(1, '', 'unexpected');
      const db = g.stack.up && g.appUnit.active ? 'ready' : 'unavailable';
      return res(0, JSON.stringify({ ok: true, components: [{ component: 'database', status: db, detail: {} }, { component: 'storage', status: g.stack.features?.storage?.state === 'off' ? 'off' : 'ready', detail: {} }, { component: 'embeddings', status: 'ready', detail: {} }] }));
    },
    deploy: async (project) => {
      record('deploy', 'deploy');
      const m = shot('deploy'); if (m) return { ok: false, step: 'health', error: m };
      const params = await resolveDeployParams({ containerName: project.container_name, deliverFoundationSecrets: true });
      if (!params.foundation) return { ok: false, step: 'plan', error: 'not a foundation deploy' };
      const unit = buildDevServiceUnit({ appDir: '/srv/app', webPort: 3000, execStart: "/bin/sh -lc 'exec npm run start'", foundation: true });
      const v = validateDeployEnvironment({ unitText: unit, environmentText: g.env, requiredKeys: params.foundation.required, foundation: true, storeKeys: params.foundation.delivered });
      notes.push({ deployParams: params.foundation, validation: v });
      if (!v.ok) return { ok: false, step: 'start', error: v.error };
      if (!g.stack.up) return { ok: false, step: 'migrate', error: 'database unreachable' };
      g.appUnit = { enabled: 'enabled', active: true };
      g.unitFoundation = true;
      return { ok: true };
    },
    stampDeployedCommit: async () => {},
    probeServing: async () => ({ serving: g.appUnit.active, reason: g.appUnit.active ? 'http 200' : 'connection refused' }),
    afterGuestRestart: async () => { record('host', 'after-restart'); return g.running ? { ok: true, ip: '10.140.1.20' } : { ok: false, error: 'no address' }; },
    busy: async () => ({ ...(g.busy || {}) }),
    repoHead: async () => g.bareMain,
    repoReset: async (project, { from, to }) => { record('host', 'repo reset'); if (g.bareMain !== from) return res(1, '', 'cannot lock ref'); g.bareMain = to; return res(0); },
    notify: async (projectId, body) => { notes.push({ chat: body }); },
  };
  return { deps, g, trace, fail, notes, snapshots, untar };
}

export { DUMP_ROOT };
