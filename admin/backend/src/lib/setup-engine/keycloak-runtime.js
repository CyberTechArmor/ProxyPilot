import { mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, linkSync, unlinkSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { KEYCLOAK_ROOT, KEYCLOAK_IMAGE, KEYCLOAK_DB_IMAGE, KEYCLOAK_PORT, resourceNames } from './keycloak-logic.js';
const OWNER = 'io.proxypilot.keycloak';
const CONFIG = 'io.proxypilot.keycloak-config';
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== process.getuid()) throw new Error('Keycloak protected directory has unsafe ownership or permissions.');
}
function readProtected(path) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('Keycloak protected file has unsafe ownership or permissions.');
  return readFileSync(path, 'utf8');
}
// Atomic no-replace publication: interrupted writes never become reusable
// half-credentials. fsync before linking; only the winner's value is consumed.
function publish(path, content, mode = 0o600) {
  if (existsSync(path)) return;
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode });
  const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temp, path); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { unlinkSync(temp); }
  const dir = openSync(join(path, '..'), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function prepareKeycloakFiles(row, { root = KEYCLOAK_ROOT, resourcesExist = false } = {}) {
  privateDirectory(root);
  const dir = join(root, row.id); privateDirectory(dir);
  const identity = JSON.stringify({ id: row.id, origin: row.origin, realm: row.realm });
  const marker = join(dir, 'owner.json');
  if (existsSync(marker) && readProtected(marker) !== identity) throw new Error('Keycloak directory belongs to another installation.');
  if (!existsSync(marker) && readdirSync(dir).length) throw new Error('Keycloak directory contains unowned files; nothing was overwritten.');
  if (!existsSync(marker) && resourcesExist) throw new Error('Existing resources have no protected ownership marker; restore the protected recovery set.');
  const previouslyOwned = existsSync(marker);
  publish(marker, identity);
  const credentials = join(dir, 'credentials.json');
  if (!existsSync(credentials)) {
    if (resourcesExist || previouslyOwned || row.resources_json) throw new Error('Recorded resources exist but credentials are missing; restore the protected recovery set. No credentials were regenerated.');
    publish(credentials, JSON.stringify({ database: randomBytes(32).toString('base64url'), bootstrap: randomBytes(32).toString('base64url') }));
  }
  let values; try { values = JSON.parse(readProtected(credentials)); } catch { throw new Error('Protected credentials cannot be read; restore the recovery set.'); }
  if (!['database', 'bootstrap'].every(k => /^[A-Za-z0-9_-]{43}$/.test(values[k] || ''))) throw new Error('Protected credentials are invalid; restore them without rotating.');
  const dbEnv = `POSTGRES_DB=keycloak\nPOSTGRES_USER=keycloak\nPOSTGRES_PASSWORD=${values.database}\n`;
  const kcEnv = `KC_DB=postgres\nKC_DB_URL=jdbc:postgresql://${resourceNames(row.id).database}:5432/keycloak\nKC_DB_USERNAME=keycloak\nKC_DB_PASSWORD=${values.database}\nKC_BOOTSTRAP_ADMIN_USERNAME=bootstrap-admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=${values.bootstrap}\nKC_HOSTNAME=${row.origin}\nKC_HTTP_ENABLED=true\nKC_PROXY_HEADERS=xforwarded\nKC_HEALTH_ENABLED=true\nKC_METRICS_ENABLED=true\n`;
  for (const [name, content] of [['database.env', dbEnv], ['keycloak.env', kcEnv]]) {
    const path = join(dir, name); publish(path, content);
    if (readProtected(path) !== content) throw new Error('Protected environment file differs from the recorded credentials; restore the recovery set.');
  }
  const realm = JSON.stringify({ realm: row.realm, enabled: true, registrationAllowed: false, attributes: { 'proxypilot.installation': row.id } });
  const realmPath = join(dir, `${row.realm}-realm.json`); publish(realmPath, realm, 0o644);
  const st = lstatSync(realmPath);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || readFileSync(realmPath, 'utf8') !== realm) throw new Error('Realm import file differs from this installation.');
  return { dir, credentials, dbEnv: join(dir, 'database.env'), kcEnv: join(dir, 'keycloak.env'), realmPath };
}
export async function ensureKeycloakRuntime(row, { exec, job, root = KEYCLOAK_ROOT, sleep = ms => new Promise(r => setTimeout(r, ms)), attempts = 90 }) {
  const names = resourceNames(row.id);
  const fingerprint = createHash('sha256').update(JSON.stringify([row.id, row.origin, row.realm, KEYCLOAK_IMAGE, KEYCLOAK_DB_IMAGE, KEYCLOAK_PORT])).digest('hex');
  const labels = ['--label', `${OWNER}=${row.id}`, '--label', `${CONFIG}=${fingerprint}`];
  const call = async (args, timeoutMs = 120000) => { job.fence(); const r = await exec.host(['docker', ...args], { timeoutMs }); job.fence(); return r; };
  const must = async (args, step, timeoutMs) => { const r = await call(args, timeoutMs); if (r.code !== 0) throw new Error(`Keycloak ${step} failed. Inspect the owned Docker resource locally; raw runtime output is withheld.`); return r; };
  const phase = name => { job.fence(); job.checkpoint(name, { resumable: true, keycloak: true }); job.onStep(name, name.replaceAll('_', ' ')); };
  phase('runtime_preflight');
  await must(['version', '--format', '{{.Server.Version}}'], 'Docker availability');
  const inspect = async (kind, name) => {
    // A failed inspect is NOT evidence of absence. List names first and require
    // a successful read, so daemon/permission failures can never authorize create.
    const list = await must(kind === 'container' ? ['container', 'ls', '-a', '--format', '{{.Names}}'] : [kind, 'ls', '--format', '{{.Name}}'], `${kind} inventory`);
    if (!list.stdout.trim().split('\n').includes(name)) return null;
    const r = await must([kind, 'inspect', name, '--format', kind === 'container' ? '{{json .Config.Labels}}' : '{{json .Labels}}'], `${kind} ownership`);
    let found; try { found = JSON.parse(r.stdout); } catch { throw new Error('Cannot establish Docker resource ownership.'); }
    if (found?.[OWNER] !== row.id || found?.[CONFIG] !== fingerprint) throw new Error(`Resource collision: ${name} is not owned by this installation and configuration.`);
    return true;
  };
  const present = {};
  for (const [key, kind] of [['network','network'],['volume','volume'],['database','container'],['server','container']]) present[key] = await inspect(kind, names[key]);
  phase('protected_files');
  const files = prepareKeycloakFiles(row, { root, resourcesExist: Object.values(present).some(Boolean) });
  job.generated({ kind: 'keycloak_protected_files', name: row.id, where: files.dir });
  const verifyContainer = async (name, server) => {
    const r = await must(['container', 'inspect', name, '--format', '{"image":{{json .Config.Image}},"network":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},"restart":{{json .HostConfig.RestartPolicy.Name}},"command":{{json .Config.Cmd}}}'], 'container configuration');
    let actual; try { actual = JSON.parse(r.stdout); } catch { throw new Error('Owned container configuration cannot be verified.'); }
    const mount = actual.mounts?.find(m => m.Destination === (server ? `/opt/keycloak/data/import/${row.realm}-realm.json` : '/var/lib/postgresql/data'));
    const ports = actual.ports || {};
    const correctPorts = server ? Object.keys(ports).length === 1 && ports['8080/tcp']?.length === 1 && ports['8080/tcp'][0].HostIp === '127.0.0.1' && ports['8080/tcp'][0].HostPort === String(KEYCLOAK_PORT) : Object.keys(ports).length === 0;
    const correctMount = server ? mount?.Type === 'bind' && mount.Source === files.realmPath && mount.RW === false : mount?.Type === 'volume' && mount.Name === names.volume;
    if (actual.image !== (server ? KEYCLOAK_IMAGE : KEYCLOAK_DB_IMAGE) || actual.network !== names.network || actual.restart !== 'unless-stopped' || !correctMount || !correctPorts || (server && JSON.stringify(actual.command) !== JSON.stringify(['start','--import-realm']))) throw new Error('Owned container configuration changed; no takeover or automatic replacement is permitted.');
  };
  phase('database_service');
  if (!present.network) await must(['network', 'create', ...labels, names.network], 'network create');
  if (!present.volume) await must(['volume', 'create', ...labels, names.volume], 'volume create');
  if (!present.database) await must(['create', '--name', names.database, ...labels, '--restart', 'unless-stopped', '--network', names.network, '--env-file', files.dbEnv, '--mount', `type=volume,source=${names.volume},target=/var/lib/postgresql/data`, KEYCLOAK_DB_IMAGE], 'database create', 600000);
  await verifyContainer(names.database, false);
  await must(['start', names.database], 'database start');
  const wait = async (args, label) => {
    for (let i = 0; i < attempts; i++) { if ((await call(args, 10000)).code === 0) return; await sleep(2000); }
    throw new Error(`${label} readiness was not established; retry retains the same resources and credentials.`);
  };
  await wait(['exec', names.database, 'pg_isready', '-U', 'keycloak', '-d', 'keycloak'], 'Database');
  phase('keycloak_service');
  if (!present.server) await must(['create', '--name', names.server, ...labels, '--restart', 'unless-stopped', '--network', names.network, '--env-file', files.kcEnv, '--publish', `127.0.0.1:${KEYCLOAK_PORT}:8080`, '--mount', `type=bind,source=${files.realmPath},target=/opt/keycloak/data/import/${row.realm}-realm.json,readonly`, KEYCLOAK_IMAGE, 'start', '--import-realm'], 'server create', 600000);
  await verifyContainer(names.server, true);
  await must(['start', names.server], 'server start');
  // Keycloak's image intentionally has no curl. Its documented bash TCP probe
  // checks /health/ready on the unexposed management interface, including DB.
  await wait(['exec', names.server, 'bash', '-ec', 'exec 3<>/dev/tcp/127.0.0.1/9000; printf "GET /health/ready HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n" >&3; head -n 1 <&3 | grep -q " 200 "'], 'Keycloak/database');
  // Verify the realm ownership marker through the installation's own DB. No
  // admin API token, external mutation, or takeover of an imported realm.
  const realmOwner = await must(['exec', names.database, 'psql', '-U', 'keycloak', '-d', 'keycloak', '-Atc', `SELECT a.value FROM realm_attribute a JOIN realm r ON a.realm_id=r.id WHERE r.name='${row.realm}' AND a.name='proxypilot.installation'`], 'realm ownership read');
  if (realmOwner.stdout.trim() !== row.id) throw new Error('Realm ownership cannot be established; no existing realm is adopted.');
  return { ...names, directory: files.dir, credentialsRef: files.credentials, serverImage: KEYCLOAK_IMAGE, databaseImage: KEYCLOAK_DB_IMAGE, upstream: `127.0.0.1:${KEYCLOAK_PORT}`, databaseReady: true, serviceReady: true };
}
