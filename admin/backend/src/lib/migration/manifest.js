// Migration inventory manifest — the document the source-side agent sends
// before anything is copied, and everything ProxyPilot derives from it. Pure:
// no host access, no DB, no I/O.
//
// The manifest is the operator's one chance to see what is actually on the
// source before a byte moves: OS, disks and mounts, systemd units and the
// ports they listen on, web-server vhosts with their upstreams, docker and
// compose, databases, cron, where the TLS material lives, which .env files
// exist — and which outbound hosts the source was observed talking to.
//
// THE ONE HARD RULE: the manifest carries .env PATHS and KEY NAMES, never a
// value. `validateManifest` refuses a manifest that carries one, so a
// tampered or well-meaning agent cannot smuggle a secret into ProxyPilot's
// database. The operator types values into set_project_env themselves.

export const MANIFEST_SCHEMA = 'proxypilot-migration-manifest@1';

/** Keys that must never appear anywhere in a manifest — they can only hold secrets. */
const FORBIDDEN_KEYS = Object.freeze(['value', 'values', 'env_values', 'secret', 'secrets', 'password', 'passwords', 'contents', 'body']);
/** The only properties an env_files entry may carry. */
const ENV_FILE_PROPS = Object.freeze(['path', 'keys', 'size_bytes', 'modified_at', 'owner', 'mode']);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const str = (v, max = 512) => (v == null ? null : String(v).slice(0, max));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const arr = (v) => (Array.isArray(v) ? v : []);
const bool = (v) => v === true;

/**
 * Walk every object in the manifest looking for a forbidden key. Returns the
 * dotted path of the first offender, or null. A DEPTH and NODE budget keeps a
 * hostile payload from turning validation into the denial of service.
 */
function findForbidden(node, path = '', depth = 0, budget = { n: 20000 }) {
  if (depth > 12 || budget.n-- < 0 || node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const hit = findForbidden(node[i], `${path}[${i}]`, depth + 1, budget);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) return path ? `${path}.${k}` : k;
    const hit = findForbidden(v, path ? `${path}.${k}` : k, depth + 1, budget);
    if (hit) return hit;
  }
  return null;
}

/**
 * validateManifest(raw) → { manifest } | { error }
 *
 * Accepts the agent's JSON, refuses anything that could carry a secret, and
 * returns a normalized manifest with every field in a known shape (so the UI
 * and the derivations below never have to guard).
 */
export function validateManifest(raw) {
  let j = raw;
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch (e) { return { error: `manifest is not JSON: ${e.message}` }; }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'manifest must be a JSON object' };
  if (j.schema !== MANIFEST_SCHEMA) return { error: `manifest schema must be ${MANIFEST_SCHEMA} (got ${JSON.stringify(j.schema ?? null)})` };

  const forbidden = findForbidden(j);
  if (forbidden) return { error: `refused: the manifest carries "${forbidden}" — ProxyPilot never accepts secret VALUES from a source host, only paths and key names` };

  for (const [i, f] of arr(j.env_files).entries()) {
    if (!f || typeof f !== 'object') return { error: `env_files[${i}] must be an object` };
    const extra = Object.keys(f).filter((k) => !ENV_FILE_PROPS.includes(k));
    if (extra.length) return { error: `refused: env_files[${i}] carries ${extra.join(', ')} — only ${ENV_FILE_PROPS.join(', ')} are accepted (never values)` };
    if (!str(f.path)) return { error: `env_files[${i}].path is required` };
    for (const k of arr(f.keys)) {
      if (typeof k !== 'string' || !ENV_KEY_RE.test(k)) return { error: `refused: env_files[${i}] key ${JSON.stringify(k)} is not a bare KEY name — a "KEY=value" line is a value, and values are never sent` };
    }
  }

  return { manifest: normalizeManifest(j) };
}

function normalizeManifest(j) {
  return {
    schema: MANIFEST_SCHEMA,
    collected_at: str(j.collected_at) || new Date(0).toISOString(),
    agent_version: str(j.agent_version, 64),
    duration_ms: num(j.duration_ms),
    source: {
      hostname: str(j.source?.hostname, 255), kind: str(j.source?.kind, 32) || 'unknown', virt: str(j.source?.virt, 32),
      arch: str(j.source?.arch, 32), cpus: num(j.source?.cpus), memory_bytes: num(j.source?.memory_bytes),
      addresses: arr(j.source?.addresses).map((a) => str(a, 64)).filter(Boolean).slice(0, 64),
      root_fs_bytes: num(j.source?.root_fs_bytes), root_used_bytes: num(j.source?.root_used_bytes),
    },
    os: {
      id: str(j.os?.id, 64), version_id: str(j.os?.version_id, 64), pretty_name: str(j.os?.pretty_name, 200),
      kernel: str(j.os?.kernel, 128), init: str(j.os?.init, 32),
    },
    disks: arr(j.disks).slice(0, 128).map((d) => ({ name: str(d.name, 128), size_bytes: num(d.size_bytes), type: str(d.type, 32), model: str(d.model, 128) })),
    mounts: arr(j.mounts).slice(0, 256).map((m) => ({ source: str(m.source, 256), target: str(m.target, 256), fstype: str(m.fstype, 32), options: str(m.options, 256), size_bytes: num(m.size_bytes), used_bytes: num(m.used_bytes) })),
    units: arr(j.units).slice(0, 512).map((u) => ({
      name: str(u.name, 128), state: str(u.state, 32), enabled: str(u.enabled, 32), description: str(u.description, 256),
      exec: str(u.exec, 512), working_directory: str(u.working_directory, 256), user: str(u.user, 64),
      env_files: arr(u.env_files).map((p) => str(p, 256)).filter(Boolean).slice(0, 16),
      ports: arr(u.ports).slice(0, 32).map((p) => ({ proto: str(p.proto, 8), port: num(p.port), address: str(p.address, 64) })),
    })),
    listening: arr(j.listening).slice(0, 512).map((l) => ({ proto: str(l.proto, 8), address: str(l.address, 64), port: num(l.port), process: str(l.process, 128), pid: num(l.pid), unit: str(l.unit, 128) })),
    vhosts: arr(j.vhosts).slice(0, 256).map((v) => ({
      server: str(v.server, 16), file: str(v.file, 256), tls: bool(v.tls),
      server_names: arr(v.server_names).map((s) => str(s, 255)).filter(Boolean).slice(0, 64),
      listen: arr(v.listen).map((s) => str(s, 64)).filter(Boolean).slice(0, 32),
      roots: arr(v.roots).map((s) => str(s, 256)).filter(Boolean).slice(0, 16),
      upstreams: arr(v.upstreams).map((s) => str(s, 256)).filter(Boolean).slice(0, 32),
    })),
    docker: {
      present: bool(j.docker?.present), version: str(j.docker?.version, 64), compose_binary: str(j.docker?.compose_binary, 64),
      compose_files: arr(j.docker?.compose_files).slice(0, 64).map((c) => ({
        path: str(c.path, 256), size_bytes: num(c.size_bytes),
        services: arr(c.services).slice(0, 64).map((s) => ({ name: str(s.name, 128), image: str(s.image, 256), ports: arr(s.ports).map((p) => str(p, 64)).filter(Boolean).slice(0, 32), volumes: arr(s.volumes).map((p) => str(p, 256)).filter(Boolean).slice(0, 32), env_file: arr(s.env_file).map((p) => str(p, 256)).filter(Boolean).slice(0, 8) })),
      })),
      containers: arr(j.docker?.containers).slice(0, 128).map((c) => ({ name: str(c.name, 128), image: str(c.image, 256), status: str(c.status, 64), ports: arr(c.ports).map((p) => str(p, 64)).filter(Boolean).slice(0, 32) })),
    },
    databases: arr(j.databases).slice(0, 64).map((d) => ({
      engine: str(d.engine, 32), version: str(d.version, 64), port: num(d.port), socket: str(d.socket, 256),
      data_dir: str(d.data_dir, 256), running: bool(d.running),
      databases: arr(d.databases).slice(0, 256).map((x) => (typeof x === 'string' ? { name: str(x, 128), size_bytes: null } : { name: str(x.name, 128), size_bytes: num(x.size_bytes) })).filter((x) => x.name),
      paths: arr(d.paths).map((p) => str(p, 256)).filter(Boolean).slice(0, 64),
    })),
    cron: arr(j.cron).slice(0, 256).map((c) => ({ source: str(c.source, 256), user: str(c.user, 64), schedule: str(c.schedule, 128), command: str(c.command, 512) })),
    tls: arr(j.tls).slice(0, 128).map((t) => ({ path: str(t.path, 256), kind: str(t.kind, 32), names: arr(t.names).map((n) => str(n, 255)).filter(Boolean).slice(0, 64), not_after: str(t.not_after, 64) })),
    env_files: arr(j.env_files).slice(0, 128).map((f) => ({ path: str(f.path, 256), keys: arr(f.keys).filter((k) => typeof k === 'string' && ENV_KEY_RE.test(k)).slice(0, 256), size_bytes: num(f.size_bytes), owner: str(f.owner, 64), mode: str(f.mode, 8) })),
    outbound: arr(j.outbound).slice(0, 512).map((o) => ({ host: str(o.host, 255), port: num(o.port), proto: str(o.proto, 8) || 'tcp', evidence: str(o.evidence, 32), detail: str(o.detail, 256) })).filter((o) => o.host),
    app_dirs: arr(j.app_dirs).slice(0, 128).map((a) => ({ path: str(a.path, 256), size_bytes: num(a.size_bytes), files: num(a.files), kind: str(a.kind, 32), unit: str(a.unit, 128) })),
    warnings: arr(j.warnings).map((w) => str(w, 512)).filter(Boolean).slice(0, 128),
    notes: arr(j.notes).map((n) => str(n, 512)).filter(Boolean).slice(0, 128),
  };
}

/* ----------------------------- derivations ------------------------------ */

const FQDN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** Is this a name we could actually route to (not `_`, localhost, or an IP)? */
export function routableName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/^\*\./, '');
  if (!n || n === '_' || n === 'localhost' || n.endsWith('.local') || n.endsWith('.localdomain')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(n) || n.includes(':')) return null;
  return FQDN_RE.test(n) ? n : null;
}

/** The upstream port a vhost proxies to, from its first http(s)://host:port upstream. */
export function upstreamPort(vhost) {
  for (const u of vhost.upstreams || []) {
    const m = String(u).match(/:(\d{2,5})(?:\D|$)/);
    if (m) { const p = Number(m[1]); if (p > 0 && p < 65536) return p; }
  }
  return null;
}

/**
 * Routes worth offering the operator, one per (domain, path). A vhost that
 * only serves files gets its listen port; a reverse proxy gets the port it
 * proxies to, because that is the port the app will listen on in the guest.
 */
export function suggestedRoutes(manifest) {
  const out = [];
  const seen = new Set();
  for (const v of manifest.vhosts || []) {
    const port = upstreamPort(v) || listenPort(v) || null;
    for (const name of v.server_names || []) {
      const domain = routableName(name);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      out.push({ domain, upstream_port: port, tls: !!v.tls, server: v.server, source_file: v.file, static_root: (v.roots || [])[0] || null, proxied: (v.upstreams || []).length > 0 });
    }
  }
  return out;
}

function listenPort(vhost) {
  for (const l of vhost.listen || []) {
    const m = String(l).match(/(\d{2,5})/);
    if (m) { const p = Number(m[1]); if (p > 0 && p < 65536 && p !== 80 && p !== 443) return p; }
  }
  // 80/443 belong to the source's web server; in the guest the app itself is
  // what ProxyPilot's Caddy proxies to, so fall back to nothing rather than
  // suggesting a port the guest will not have.
  return null;
}

/**
 * A HINT at the firewall's named service for a well-known port. The
 * firewall's real vocabulary is installation-specific, so the service layer
 * checks this name against `firewall egress list` and falls back to
 * proto:port; nothing here may be handed to the CLI unchecked.
 */
export const EGRESS_SERVICES = Object.freeze({ 53: 'dns', 80: 'http', 443: 'https', 25: 'smtp', 587: 'submission', 465: 'smtps', 993: 'imaps', 22: 'ssh', 123: 'ntp', 5432: 'postgres', 3306: 'mysql', 6379: 'redis', 11211: 'memcached', 27017: 'mongodb' });

/**
 * Outbound hosts worth an egress grant, deduped and ranked. Loopback, the
 * source's own addresses and RFC1918 peers are dropped: they are traffic
 * inside the old machine, and the imported guest's fence is about the
 * internet. `internal` keeps them visible without proposing a grant.
 */
export function observedEgress(manifest) {
  const own = new Set([...(manifest.source?.addresses || []), 'localhost', '127.0.0.1', '::1', manifest.source?.hostname].filter(Boolean));
  const byKey = new Map();
  for (const o of manifest.outbound || []) {
    const host = String(o.host).trim().toLowerCase();
    if (!host) continue;
    const port = o.port || null;
    const key = `${host}:${port || '*'}:${o.proto}`;
    const internal = own.has(host) || PRIVATE_V4.test(host) || host === '::1' || host.startsWith('fe80:');
    const cur = byKey.get(key) || { host, port, proto: o.proto, evidence: [], internal, service: port ? EGRESS_SERVICES[port] || null : null, count: 0 };
    if (o.evidence && !cur.evidence.includes(o.evidence)) cur.evidence.push(o.evidence);
    cur.count += 1;
    byKey.set(key, cur);
  }
  const rows = [...byKey.values()];
  // Most-corroborated first: a host seen in a unit file AND in the connection
  // table is likelier to matter than one seen once in conntrack.
  rows.sort((a, b) => (b.evidence.length - a.evidence.length) || (b.count - a.count) || a.host.localeCompare(b.host));
  return rows;
}

/** What has to be dumped and restored, in the order a restore needs. */
export function databasePlan(manifest) {
  const out = [];
  for (const d of manifest.databases || []) {
    const engine = String(d.engine || '').toLowerCase();
    if (engine === 'sqlite') {
      out.push({ engine, kind: 'file', paths: d.paths || [], note: 'SQLite travels with the application directory — the file copy IS the dump; the app must be stopped for the final sync.' });
      continue;
    }
    if (engine !== 'postgres' && engine !== 'mysql') continue;
    const names = (d.databases || []).map((x) => x.name).filter((n) => n && !SYSTEM_DBS[engine].includes(n));
    out.push({
      engine, kind: 'logical', version: d.version, port: d.port, databases: names,
      total_bytes: (d.databases || []).reduce((n, x) => n + (x.size_bytes || 0), 0) || null,
      dump: engine === 'postgres' ? `pg_dump --format=custom --no-owner --no-acl <db>` : `mysqldump --single-transaction --routines --triggers <db>`,
      restore: engine === 'postgres' ? `createdb <db> && pg_restore --no-owner --no-acl -d <db>` : `mysql <db> <`,
    });
  }
  return out;
}

const SYSTEM_DBS = Object.freeze({
  postgres: ['template0', 'template1', 'postgres'],
  mysql: ['mysql', 'information_schema', 'performance_schema', 'sys'],
});

/** Directories the application lives in, biggest first — what the copy will carry. */
export function appDirectories(manifest) {
  return [...(manifest.app_dirs || [])].sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0));
}

/** The exclude set every adopt run starts from (the operator can add more). */
export const DEFAULT_RSYNC_EXCLUDES = Object.freeze([
  '.git/', 'node_modules/', 'vendor/', '.venv/', 'venv/', '__pycache__/', '*.pyc',
  '.next/cache/', '.nuxt/', 'dist/cache/', '.cache/', '.parcel-cache/',
  'tmp/', 'temp/', '*.log', 'logs/', '*.sock', '*.pid', '*.swp', '.DS_Store',
  'storage/framework/cache/', 'storage/logs/',
]);

/** A short, human-first read of the manifest for the page and the MCP tool. */
export function manifestSummary(manifest) {
  const listening = (manifest.listening || []).filter((l) => l.port && l.proto === 'tcp');
  const routes = suggestedRoutes(manifest);
  const egress = observedEgress(manifest).filter((e) => !e.internal);
  const dbs = databasePlan(manifest);
  const dirs = appDirectories(manifest);
  return {
    hostname: manifest.source?.hostname || null,
    os: manifest.os?.pretty_name || [manifest.os?.id, manifest.os?.version_id].filter(Boolean).join(' ') || null,
    kind: manifest.source?.kind || 'unknown', arch: manifest.source?.arch || null,
    cpus: manifest.source?.cpus ?? null, memory_bytes: manifest.source?.memory_bytes ?? null,
    used_bytes: manifest.source?.root_used_bytes ?? null,
    counts: {
      units: (manifest.units || []).length, listening: listening.length, vhosts: (manifest.vhosts || []).length,
      routes: routes.length, databases: dbs.length, cron: (manifest.cron || []).length,
      env_files: (manifest.env_files || []).length, env_keys: (manifest.env_files || []).reduce((n, f) => n + f.keys.length, 0),
      tls: (manifest.tls || []).length, egress: egress.length, app_dirs: dirs.length,
      compose_files: (manifest.docker?.compose_files || []).length, docker_containers: (manifest.docker?.containers || []).length,
    },
    dockerized: !!manifest.docker?.present && ((manifest.docker.containers || []).length > 0 || (manifest.docker.compose_files || []).length > 0),
    top_ports: listening.slice(0, 12).map((l) => ({ port: l.port, process: l.process, unit: l.unit })),
    suggested_routes: routes, databases: dbs, egress, app_dirs: dirs.slice(0, 12),
    warnings: manifest.warnings || [],
  };
}

/* ------------------------------- capacity -------------------------------- */

/** Rootfs tarballs of an ordinary Linux install land around half the size. */
export const TAR_COMPRESSION_ESTIMATE = 0.5;
/** Leave this much of the target pool free after the guest lands. */
export const POOL_HEADROOM = 0.1;

/**
 * How many bytes this migration will actually put where.
 *
 * Two different places, and they are not the same number:
 *
 *   pool     the guest itself, on the Incus storage pool it lands in.
 *   staging  the artifact on ProxyPilot's own disk while it is in flight —
 *            rootfs-tar and file-sync stream THROUGH `/var/lib/proxypilot`,
 *            so a host with a small root filesystem can fail a migration
 *            that the target pool had ample room for. incus-migrate streams
 *            straight into Incus and stages nothing.
 *
 * Whole-machine carries the source's used bytes (the pseudo-filesystems are
 * excluded from the tar and are not counted). Application mode carries the
 * app directories plus the database dumps it will restore.
 */
export function capacityNeeds(manifest, { mode, transport } = {}) {
  const man = manifest || {};
  const parts = [];
  let bytes = 0;
  if (mode === 'application') {
    for (const d of appDirectories(man)) {
      bytes += Number(d.size_bytes) || 0;
      parts.push({ what: d.path, bytes: Number(d.size_bytes) || 0 });
    }
    for (const db of databasePlan(man)) {
      // A logical dump is smaller than the live database, but it is restored
      // INTO the guest, so the guest pays for both for a while.
      const b = Number(db.total_bytes) || 0;
      bytes += b * 2;
      parts.push({ what: `${db.engine} dump + restore`, bytes: b * 2 });
    }
  } else {
    const root = Number(man.source?.root_used_bytes) || 0;
    bytes += root;
    parts.push({ what: 'the source root filesystem', bytes: root });
    for (const m of man.mounts || []) {
      // A separate data mount travels only when it is inside the rootfs tar;
      // --one-file-system means it is not. Name it either way.
      if (!m || m.target === '/' || !Number(m.used_bytes)) continue;
      if (/^\/(proc|sys|dev|run|tmp)(\/|$)/.test(m.target)) continue;
      parts.push({ what: `${m.target} (a separate mount — NOT carried by the tarball)`, bytes: 0, note: 'copy it separately' });
    }
  }
  const staging = transport === 'incus-migrate' ? 0 : Math.round(bytes * TAR_COMPRESSION_ESTIMATE);
  return {
    pool_bytes: bytes,
    staging_bytes: staging,
    parts,
    staging_note: transport === 'incus-migrate'
      ? 'incus-migrate streams straight into Incus — nothing is staged on this host.'
      : `The artifact passes through ProxyPilot's own disk; the estimate is ${Math.round(TAR_COMPRESSION_ESTIMATE * 100)}% of the source, which is typical for a compressed rootfs and can be wrong in either direction.`,
  };
}

/**
 * Will it fit? One verdict per place, plus the concerns to put in front of
 * the operator BEFORE they approve the transfer.
 *
 *   block   the free space is less than what is coming
 *   warn    it fits, but leaves less than POOL_HEADROOM of the pool free
 *
 * `free` values of null mean "could not be read" — which is a warning of its
 * own, never a silent pass.
 */
export function capacityVerdict({ needs, pool, poolFreeBytes = null, poolTotalBytes = null, stagingFreeBytes = null, stagingPath = null } = {}) {
  const out = { fits: true, checks: [], concerns: [] };
  const gib = (b) => `${(Number(b) / 1024 ** 3).toFixed(1)} GiB`;
  const add = (id, status, text, remedy = null) => {
    out.checks.push({ id, status, text, remedy });
    if (status === 'block') { out.fits = false; out.concerns.push({ level: 'block', id, text, remedy }); }
    else if (status === 'warn') out.concerns.push({ level: 'warn', id, text, remedy });
  };

  const need = Number(needs?.pool_bytes) || 0;
  const poolName = pool || 'the default profile\'s pool';
  if (poolFreeBytes == null) {
    add('capacity-pool-unknown', 'warn', `Could not read how much space ${poolName} has left, so nothing checked that ${gib(need)} will fit.`,
      'Storage → pools, or zpool_status, shows the free space.');
  } else if (need > poolFreeBytes) {
    add('capacity-pool', 'block', `${gib(need)} is coming and ${poolName} has ${gib(poolFreeBytes)} free — it will not fit.`,
      'Pick a pool with room (pool: "<name>"), free space on this one, or migrate less (application mode carries only the app).');
  } else if (need > poolFreeBytes * (1 - POOL_HEADROOM)) {
    add('capacity-pool', 'warn', `${gib(need)} is coming and ${poolName} has ${gib(poolFreeBytes)} free — it fits, with under ${Math.round(POOL_HEADROOM * 100)}% of the free space left over.`,
      'A pool close to full performs badly, and ZFS especially so past ~90%.');
  } else {
    add('capacity-pool', 'pass', `${gib(need)} into ${poolName}, which has ${gib(poolFreeBytes)} free${poolTotalBytes ? ` of ${gib(poolTotalBytes)}` : ''}.`);
  }

  const stage = Number(needs?.staging_bytes) || 0;
  if (stage > 0) {
    if (stagingFreeBytes == null) {
      add('capacity-staging-unknown', 'warn', `Could not read the free space on ${stagingPath || "ProxyPilot's own disk"}, where the transfer is staged.`);
    } else if (stage > stagingFreeBytes) {
      add('capacity-staging', 'block', `The transfer stages about ${gib(stage)} on ${stagingPath || "ProxyPilot's disk"}, which has ${gib(stagingFreeBytes)} free.`,
        'Free space there, or use the incus-migrate transport, which streams straight into Incus and stages nothing.');
    } else if (stage > stagingFreeBytes * 0.8) {
      add('capacity-staging', 'warn', `The transfer stages about ${gib(stage)} on ${stagingPath || "ProxyPilot's disk"}, which has ${gib(stagingFreeBytes)} free — close.`,
        'The estimate assumes a rootfs compresses by about half; an incompressible source needs more.');
    } else {
      add('capacity-staging', 'pass', `About ${gib(stage)} staged on ${stagingPath || "ProxyPilot's disk"} (${gib(stagingFreeBytes)} free), deleted after the import.`);
    }
  }
  return out;
}

/**
 * Did the source look like something this migration can actually carry?
 * Returns blocking problems first — the operator sees them before approving
 * the transfer, not after it.
 */
export function manifestConcerns(manifest, { mode, capacity = null } = {}) {
  const out = [];
  // Capacity first: "it will not fit" is the one concern that makes every
  // other question moot, and it blocks the approval.
  for (const c of capacity?.concerns || []) out.push({ ...c, remedy: c.remedy ?? null });
  const push = (level, id, text, remedy = null) => out.push({ level, id, text, remedy });
  if (!manifest.os?.id) push('warn', 'os-unknown', 'The source OS could not be identified (no /etc/os-release).');
  if (manifest.os?.init && manifest.os.init !== 'systemd') push('warn', 'init', `The source runs ${manifest.os.init}, not systemd — units and their ports were not collected.`);
  if (mode === 'application' && !(manifest.app_dirs || []).length) push('block', 'no-app-dirs', 'Application mode found no application directory to copy.', 'Name the directories explicitly in the migration target spec (app_dirs), or use whole-machine mode.');
  if (mode === 'application' && (manifest.docker?.containers || []).length) push('warn', 'dockerized', `The application runs in ${manifest.docker.containers.length} docker container(s). Application mode copies the compose files and the volumes it can see; whole-machine mode into a nested guest is the faster path.`, 'Switch to whole-machine mode with nested: true, or adopt the compose stack afterwards.');
  if ((manifest.databases || []).some((d) => d.engine === 'postgres' && !d.running)) push('warn', 'db-stopped', 'PostgreSQL is installed on the source but not running — no logical dump can be taken from it.');
  const bigMounts = (manifest.mounts || []).filter((m) => (m.used_bytes || 0) > 200 * 1024 ** 3);
  for (const m of bigMounts) push('warn', `big-mount:${m.target}`, `${m.target} holds ${Math.round((m.used_bytes || 0) / 1024 ** 3)} GiB — the transfer will take a while and the guest's disk must be at least that big.`);
  if (!(manifest.vhosts || []).length) push('warn', 'no-vhost', 'No nginx/apache/caddy vhost was found, so no route can be suggested — you will name the domain and port yourself.');
  return out;
}
