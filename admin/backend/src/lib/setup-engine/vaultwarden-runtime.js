import { mkdirSync, lstatSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readPrivate, atomicPrivate } from './pomerium-runtime.js';
import { LOG_ARGS, dockerFailure, startOwnedContainer, sameArgv, sameUser } from './owned-runtime.js';
import { VAULTWARDEN_ROOT, VAULTWARDEN_IMAGE, VAULTWARDEN_PORT, fail, namesFor, expectedSettings, digest } from './vaultwarden-logic.js';
const OWNER = 'io.proxypilot.vaultwarden';
const privateDir = path => { mkdirSync(path, { recursive: true, mode: 0o700 }); const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077) throw fail('Vaultwarden directory ownership or permissions are unsafe.'); };
export function prepareFiles(r, credentials, { root = VAULTWARDEN_ROOT, resourcesExist = false } = {}) {
  privateDir(root); const marker = join(root, 'owner.json');
  if (!existsSync(marker)) {
    if (resourcesExist || r.resources || readdirSync(root).length) throw fail('Owned Vaultwarden files are missing or unowned. Restore the matching set; data will not be reset.');
    atomicPrivate(marker, JSON.stringify({ ref: r.credential_ref, origin: r.config.origin, attempted: [] }));
  }
  const identity = JSON.parse(readPrivate(marker));
  if (identity.ref !== r.credential_ref || identity.origin !== r.config.origin || !Array.isArray(identity.attempted)) throw fail('Vaultwarden directory belongs to another installation.');
  const data = join(root, 'data');
  if (!existsSync(data) && (identity.attempted.length || r.resources)) throw fail('Vaultwarden data directory is missing. Restore it; retry never initializes an empty replacement.');
  privateDir(data);
  const config = join(root, 'config.json'), handoff = join(root, 'credentials.json');
  const expected = { ...expectedSettings(r), admin_token: credentials.admin, sso_client_secret: credentials.client, signups_allowed: false, sso_signups_allowed: true,
    invitations_allowed: false, log_level: 'off',
    // Every apply/verify logs in to /admin once. Vaultwarden's default (burst 3,
    // then one per 300 s) refused a retry three minutes after a verified run.
    // The token is a long random value, so a looser limit costs nothing real.
    admin_ratelimit_seconds: 60, admin_ratelimit_max_burst: 20 };
  // CONFIG_FILE is this owned read-only file. A /data/config.json cannot silently
  // override it. Actual effective settings are still verified through the service.
  for (const [path, value] of [[config, expected], [handoff, { adminToken: credentials.admin }]]) {
    const content = JSON.stringify(value, null, 2) + '\n';
    if (existsSync(path)) { if (readPrivate(path) !== content) throw fail('Vaultwarden protected configuration drifted. Resolve it with its owner; no overwrite or credential rotation was attempted.'); }
    else { if (identity.attempted.length || r.resources) throw fail('Vaultwarden protected configuration is missing. Restore the matching files before retry.'); atomicPrivate(path, content); }
  }
  return { root, data, config, marker, identity };
}
export function keyEvidence(data, prior) {
  const names = readdirSync(data).filter(n => /^rsa_key(?:\.[a-z]+)+$/.test(n)).sort();
  if (!names.includes('rsa_key.pem')) throw fail('Vaultwarden server signing key is not available; readiness is unverified.');
  const fingerprints = Object.fromEntries(names.map(n => { const p = join(data, n), s = lstatSync(p); if (!s.isFile() || s.isSymbolicLink() || s.size > 32768) throw fail('Vaultwarden server-key file is unsafe.'); return [n, createHash('sha256').update(readFileSync(p)).digest('hex')]; }));
  if (prior && digest(prior) !== digest(fingerprints)) throw fail('Vaultwarden server keys changed. Restore the original data/key set; retry will not accept replacement keys.');
  return fingerprints;
}
export async function ensureRuntime(r, credentials, { exec, job, root = VAULTWARDEN_ROOT, sleep, startTimeoutMs, healthTimeoutMs } = {}) {
  const n = namesFor(r), owner = r.credential_ref;
  const call = async args => { job.fence(); const v = await exec.host(['docker', ...args], { timeoutMs: 120000 }); job.fence(); if (v.code !== 0) throw dockerFailure(fail, `Vaultwarden docker ${args[0]}`, v); return v.stdout; };
  const inspect = async (kind, name) => { const list = await call(kind === 'container' ? ['container', 'ls', '-a', '--format', '{{.Names}}'] : [kind, 'ls', '--format', '{{.Name}}']);
    if (!list.trim().split('\n').includes(name)) return null; try { return JSON.parse(await call([kind, 'inspect', name]))[0]; } catch { throw fail('Vaultwarden Docker identity could not be read.'); } };
  await call(['version', '--format', '{{.Server.Version}}']);
  const network = await inspect('network', n.network), server = await inspect('container', n.server);
  if (network && network.Labels?.[OWNER] !== owner || server && server.Config?.Labels?.[OWNER] !== owner) throw fail('Vaultwarden resource name collision. Unrelated resources were preserved.');
  const files = prepareFiles(r, credentials, { root, resourcesExist: !!network || !!server });
  if ((r.resources || files.identity.started) && !existsSync(join(files.data, 'db.sqlite3'))) throw fail('Vaultwarden SQLite database is missing. Restore the data set; retry never creates an empty vault.');
  if (r.resources?.serverKeys) keyEvidence(files.data, r.resources.serverKeys);
  const createOnce = async (kind, present, args) => {
    if (present) return;
    if ((files.identity.attempted.includes(kind) || r.resources) && !(kind === 'server' && files.identity.reinstall && files.identity.reinstall === r.resources?.retainedReinstall)) throw fail('A previously attempted Vaultwarden resource is missing. Restore it; retry never reinstalls or resets the vault.');
    job.fence(); files.identity.attempted.push(kind); atomicPrivate(files.marker, JSON.stringify(files.identity)); await call(args);
  };
  const labels = ['--label', `${OWNER}=${owner}`];
  if (network && (network.Driver !== 'bridge' || network.Internal || Object.keys(network.Options || {}).length || Object.values(network.Containers || {}).some(c => c.Name !== n.server))) throw fail('Vaultwarden dedicated network drifted.');
  await createOnce('network', network, ['network', 'create', ...labels, n.network]);
  const env = [`CONFIG_FILE=/etc/vaultwarden/setup.json`, 'ROCKET_ADDRESS=0.0.0.0', 'ROCKET_PORT=80', 'DATA_FOLDER=/data'];
  await createOnce('server', server, ['create', '--name', n.server, ...labels, '--restart', 'unless-stopped', '--network', n.network, ...LOG_ARGS,
    '--publish', `127.0.0.1:${VAULTWARDEN_PORT}:80`, '--mount', `type=bind,source=${files.data},target=/data`,
    '--mount', `type=bind,source=${files.config},target=/etc/vaultwarden/setup.json,readonly`, ...env.flatMap(e => ['--env', e]), VAULTWARDEN_IMAGE]);
  const a = await inspect('container', n.server), c = a?.Config || {}, h = a?.HostConfig || {}, m = a?.Mounts || [];
  let image; try { image = JSON.parse(await call(['image', 'inspect', VAULTWARDEN_IMAGE]))[0]; } catch (e) { if (e.vaultwardenSafe) throw e; throw fail('Vaultwarden pinned image metadata could not be read.'); }
  if (!image?.Id) throw fail('Vaultwarden pinned image metadata could not be read.');
  const actualEnv = Object.fromEntries((c.Env || []).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  const expectedEnv = Object.fromEntries([...(image.Config?.Env || []), ...env].map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  const sameEnv = Object.keys(actualEnv).length === Object.keys(expectedEnv).length && Object.entries(expectedEnv).every(([k, v]) => actualEnv[k] === v);
  if (c.Image !== VAULTWARDEN_IMAGE || a.Image !== image.Id || c.Labels?.[OWNER] !== owner || !sameArgv(c.Cmd, image.Config?.Cmd) || !sameArgv(c.Entrypoint, image.Config?.Entrypoint) || !sameUser(c.User, image.Config?.User) || !sameEnv ||
    h.NetworkMode !== n.network || h.RestartPolicy?.Name !== 'unless-stopped' || h.Privileged || h.CapAdd?.length || h.Devices?.length || h.PidMode || h.IpcMode === 'host' ||
    digest(h.PortBindings || {}) !== digest({ '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(VAULTWARDEN_PORT) }] }) || m.length !== 2 ||
    !m.some(x => x.Type === 'bind' && x.Source === files.data && x.Destination === '/data' && x.RW === true) ||
    !m.some(x => x.Type === 'bind' && x.Source === files.config && x.Destination === '/etc/vaultwarden/setup.json' && x.RW === false) ||
    Object.keys(a.NetworkSettings?.Networks || {}).some(x => x !== n.network)) throw fail('Vaultwarden runtime differs from the reviewed private persistent profile. No replacement was attempted.');
  // Start by inspected ID and wait for running, then the image's HEALTHCHECK;
  // an already running and healthy server is left as it is (3b).
  if (!a.State?.Running) { job.fence(); files.identity.started = true; atomicPrivate(files.marker, JSON.stringify(files.identity)); }
  await startOwnedContainer({ run: argv => exec.host(argv, { timeoutMs: 120000 }), name: n.server, fail, job, label: 'Vaultwarden server', sleep, startTimeoutMs, healthTimeoutMs });
  if (files.identity.reinstall) { delete files.identity.reinstall; job.fence(); atomicPrivate(files.marker, JSON.stringify(files.identity)); }
  job.generated({ kind: 'vaultwarden_data_configuration', name: owner, where: root });
  return { ...n, directory: root, data: files.data, config: files.config, image: VAULTWARDEN_IMAGE, ...(r.resources?.serverKeys ? { serverKeys: r.resources.serverKeys } : {}) };
}
