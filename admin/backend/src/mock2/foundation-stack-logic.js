// Mock2 application foundation — the GUEST STACK, pure half (2026-10).
//
// Everything that decides WHAT runs in a foundation guest lives here as pure
// functions: the Docker-ready launch config, the Compose model and its YAML,
// the Postgres pg_hba / pg_ident / init files, and the small guest-side shell
// scripts foundation-stack.js runs through `incus exec` (sh -c <script>, with
// any secret on STDIN — never in argv, never in a file the stack reads).
// foundation-stack.js is the exec half, like deploy-logic.js / deploy.js.
//
// The shared names (service names, paths, image tags, volumes, ports) come from
// foundation-contract.js; this module never redefines them. A `layout` object
// (DEFAULT_LAYOUT unless a test overrides it) carries the guest paths, the
// Compose project name, the volume names and the published ports, so the
// real-Docker test can run the SAME generated files under an `a3-…` project in
// a temp dir without touching anything named mock2-foundation.
//
// Design points, each verified against the pinned images (see the docker test):
//   * Postgres has no TCP at all: network_mode none + listen_addresses=''.
//     Its socket directory is bind-mounted at STACK.postgres.socketDir and the
//     only pg_hba line is `local all all peer map=mock2`. At RUNTIME the ident
//     map admits exactly one OS user, root (→ app or → postgres). The image's
//     own first-initialization scripts run as the container's postgres user
//     (uid 999); that one mapping is granted through an include file that the
//     wrapper entrypoint creates only while the data directory is empty and
//     the last init script deletes — so a guest process that happens to run as
//     uid 999 never gets the superuser after initialization.
//   * SeaweedFS runs as one `weed server` (master + volume + filer + S3); every
//     internal port binds 127.0.0.1 INSIDE the container, only S3 binds the
//     container address so Docker can publish it on the guest's 127.0.0.1.
//     Identities live in the filer (/etc/iam), configured after start through
//     `weed shell` with the keys on stdin; anonymous requests are refused once
//     an identity exists.
//   * The embedding server is TEI cpu with a model cache volume.
//
// PURE: no I/O. Terminology (risk R7): nothing here is named "agent".

import {
  STACK, FOUNDATION_SCHEMA_SQL, FOUNDATION_DATABASE_URL, FOUNDATION_VERSION,
  FOUNDATION_CLI, FOUNDATION_CLI_COMMANDS,
} from './foundation-contract.js';
import { mcpGuestCreateOptions } from '../lib/mcp-logic.js';

// ---------------------------------------------------------------------------
// Docker-ready guests
// ---------------------------------------------------------------------------

// The exact security.* keys create_lxc_container's docker_ready plan sets
// (lib/mcp-logic.js mcpGuestCreateOptions) — derived from it, not copied, so a
// change there reaches foundation guests too. Nesting plus the mknod/setxattr
// intercepts are what dockerd needs for overlay mounts in an unprivileged
// guest; the bpf intercepts are the docker_ready plan's BuildKit additions.
export const FOUNDATION_GUEST_CONFIG = Object.freeze(Object.fromEntries(
  Object.entries(mcpGuestCreateOptions({ docker_ready: true }).config)
    .filter(([key]) => key.startsWith('security.')),
));

// `-c key=value` flags for `incus launch`. Keys and values are fixed above
// (plain identifiers and true/false), so nothing here needs quoting.
export function foundationLaunchConfigArgs(config = FOUNDATION_GUEST_CONFIG) {
  const out = [];
  for (const [k, v] of Object.entries(config)) {
    if (!/^[a-z0-9.]+$/.test(k) || !/^[a-z0-9]+$/.test(String(v))) throw new Error(`unexpected guest config ${k}=${v}`);
    out.push('-c', `${k}=${v}`);
  }
  return out;
}

// A project is a foundation project when its row carries a foundation version
// (projects.foundation_version, set on projects created after the revision).
// Read defensively: an older row has no such column at all.
export function isFoundationProject(project) {
  const v = project && Object.prototype.hasOwnProperty.call(project, 'foundation_version') ? project.foundation_version : null;
  return typeof v === 'string' ? v.trim().length > 0 : v != null && v !== false && v !== 0;
}

// ---------------------------------------------------------------------------
// Image pins. The tag stays the human-readable version (the contract's);
// the digest is the multi-arch index digest the tag resolved to when pinned,
// so a re-pushed tag can never change what a guest runs.
// ---------------------------------------------------------------------------
export const FOUNDATION_IMAGE_DIGESTS = Object.freeze({
  postgres: 'sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11',
  storage: 'sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d',
  embeddings: 'sha256:2538ea1c9640d3763b15af668039d24172d063b42337b0c27796fc2be180c78d',
});
export const FOUNDATION_IMAGES = Object.freeze({
  postgres: `${STACK.postgres.image}@${FOUNDATION_IMAGE_DIGESTS.postgres}`,
  storage: `${STACK.storage.image}@${FOUNDATION_IMAGE_DIGESTS.storage}`,
  embeddings: `${STACK.embeddings.image}@${FOUNDATION_IMAGE_DIGESTS.embeddings}`,
});

export const FOUNDATION_SERVICES = Object.freeze([STACK.postgres.service, STACK.storage.service, STACK.embeddings.service]);

// Memory ceilings per service, sized for a small guest that also runs the app,
// npm builds and a headless browser: Postgres at its defaults (128 MB shared
// buffers) peaks well under 1 GiB; SeaweedFS all-in-one idles near 100 MB;
// TEI with bge-small (33 M parameters) stays under 1 GiB with a 2-thread pool.
export const FOUNDATION_LIMITS = Object.freeze({
  postgres: Object.freeze({ mem: '1g', shm: '256m' }),
  storage: Object.freeze({ mem: '512m', goMemLimit: '400MiB' }),
  embeddings: Object.freeze({ mem: '1g', threads: 2 }),
});

// The S3 identities the bundled storage carries.
export const STORAGE_APP_USER = 'app';
export const STORAGE_ADMIN_USER = 'mock2-admin';
export const STORAGE_APP_ACTIONS = 'Read,Write,List,Tagging';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export const DEFAULT_LAYOUT = Object.freeze({
  composeProject: STACK.composeProject,
  dir: STACK.dir,
  composeFile: STACK.composeFile,
  keyFile: STACK.keyFile,
  socketDir: STACK.postgres.socketDir,
  volumes: Object.freeze({ postgres: STACK.postgres.volume, storage: STACK.storage.volume, embeddings: STACK.embeddings.volume }),
  ports: Object.freeze({ storage: STACK.storage.port, embeddings: STACK.embeddings.port }),
});

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;

export function resolveLayout(over = null) {
  const o = over || {};
  const dir = o.dir || DEFAULT_LAYOUT.dir;
  const layout = {
    composeProject: o.composeProject || DEFAULT_LAYOUT.composeProject,
    dir,
    composeFile: o.composeFile || (o.dir ? `${dir}/compose.yaml` : DEFAULT_LAYOUT.composeFile),
    keyFile: o.keyFile || DEFAULT_LAYOUT.keyFile,
    socketDir: o.socketDir || DEFAULT_LAYOUT.socketDir,
    volumes: { ...DEFAULT_LAYOUT.volumes, ...(o.volumes || {}) },
    ports: { ...DEFAULT_LAYOUT.ports, ...(o.ports || {}) },
  };
  if (!NAME_RE.test(layout.composeProject)) throw new Error(`invalid compose project name: ${layout.composeProject}`);
  for (const p of [layout.dir, layout.composeFile, layout.keyFile, layout.socketDir]) {
    if (!PATH_RE.test(p) || p.includes('..')) throw new Error(`invalid foundation path: ${p}`);
  }
  for (const v of Object.values(layout.volumes)) if (!NAME_RE.test(String(v))) throw new Error(`invalid volume name: ${v}`);
  for (const v of Object.values(layout.ports)) if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`invalid port: ${v}`);
  // Postgres' socket path must fit sun_path (107 bytes) with ".s.PGSQL.5432".
  if (`${layout.socketDir}/.s.PGSQL.5432`.length > 100) throw new Error(`socket directory path too long for a Unix socket: ${layout.socketDir}`);
  return layout;
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The `docker compose -p … -f …` prefix as an argv array, and as shell text.
export function composeArgv(layout = DEFAULT_LAYOUT) {
  return ['docker', 'compose', '-p', layout.composeProject, '-f', layout.composeFile];
}
export function composeShellPrefix(layout = DEFAULT_LAYOUT) {
  return composeArgv(layout).map(sq).join(' ');
}

// For other modules (restore, probes, roster…) that still run a superuser
// psql/pg_dump: on a foundation guest this is the prefix that replaces
// `su - postgres -c` — the CLIENT runs inside the postgres service, so pg_dump
// always matches the server's major version (the guest's postgresql-client is
// Debian 13's 17; the server is 18).
export function foundationPgExecPrefix(layout = DEFAULT_LAYOUT) {
  return `${composeShellPrefix(layout)} exec -T ${STACK.postgres.service}`;
}

// Arguments the platform never sends to `docker compose` in a foundation guest:
// anything that deletes a volume. Turning a feature off is `stop`; the volume
// is kept so turning it back on brings the same data back.
export function composeArgsError(args) {
  if (!Array.isArray(args) || !args.length) return 'compose arguments must be a non-empty array';
  for (const a of args) {
    if (typeof a !== 'string' || !a.length || a.length > 4096 || a.includes('\0')) return 'every compose argument must be a non-empty string';
  }
  const sub = args.find((a) => !a.startsWith('-'));
  if (sub === 'volume' || sub === 'volumes') return 'docker compose volume commands are refused for the foundation stack';
  if (sub !== 'down' && sub !== 'rm') return null;
  // -v / --volumes, alone or inside a short-flag cluster such as -sfv.
  const removesVolumes = args.some((a) => a === '--volumes' || a.startsWith('--volumes=') || (/^-[A-Za-z]+$/.test(a) && a.includes('v')));
  if (removesVolumes) return `docker compose ${sub} with -v would delete the foundation's volumes — refused (turning a feature off stops it; data is never deleted)`;
  return null;
}

// ---------------------------------------------------------------------------
// Postgres files
// ---------------------------------------------------------------------------
export const PG_CONF_DIR = '/etc/mock2';            // inside the postgres container
export const PG_INIT_IDENT = '/run/mock2-init/pg_ident.conf'; // container-local, first initialization only

export function buildPgHbaConf() {
  return `# mock2-foundation — platform-owned (ProxyPilot). Edits are overwritten.
# Unix socket only (the server has no network and listen_addresses=''), peer
# authentication through the mock2 ident map. There is no host line and no
# password anywhere.
# TYPE  DATABASE  USER  METHOD
local   all       all   peer map=mock2
`;
}

export function buildPgIdentConf() {
  return `# mock2-foundation — platform-owned (ProxyPilot). Edits are overwritten.
# MAPNAME  SYSTEM-USERNAME  PG-USERNAME
# The guest's root (the app's service unit, the platform) may connect as the
# app role or as the superuser. No other OS user is mapped.
mock2      root             ${STACK.postgres.role}
mock2      root             postgres
# First initialization only: the image's init scripts connect as the
# container's postgres user. The wrapper entrypoint creates this file while the
# data directory is still empty; the last init script deletes it.
include_if_exists ${PG_INIT_IDENT}
`;
}

// The wrapper entrypoint (run with bash, so the file mode does not matter).
export function buildPgEntrypoint() {
  return `#!/bin/bash
# mock2-foundation — platform-owned wrapper around the image's entrypoint.
# Before the FIRST initialization (empty data directory) it grants the image's
# init scripts one ident mapping (container postgres -> postgres) through
# ${PG_INIT_IDENT}; 99-mock2-seal.sh deletes it when init is done. On every
# later start the file is removed, so only root is ever mapped at runtime.
set -euo pipefail
if [ ! -s "\${PGDATA}/PG_VERSION" ]; then
  install -d -m 0700 -o postgres -g postgres "$(dirname '${PG_INIT_IDENT}')"
  printf 'mock2 postgres postgres\\n' > '${PG_INIT_IDENT}'
  chown postgres:postgres '${PG_INIT_IDENT}'
else
  rm -rf "$(dirname '${PG_INIT_IDENT}')"
fi
exec docker-entrypoint.sh "$@"
`;
}

// The idempotent role/database/schema SQL. The SAME text runs as the image's
// init file (first start) and through foundationPsql at every bring-up, so a
// half-initialized volume converges. psql meta-commands: \gexec, \connect.
export function buildFoundationInitSql({ role = STACK.postgres.role, database = STACK.postgres.database } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role) || !/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error('invalid role or database name');
  return `-- mock2-foundation (${FOUNDATION_VERSION}) — platform-owned. Idempotent.
-- The app role logs in over the socket by peer authentication only: it has no
-- password. CREATEDB lets the app's test tooling create scratch databases.
SELECT 'CREATE ROLE ${role} LOGIN CREATEDB' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}')\\gexec
ALTER ROLE ${role} WITH LOGIN CREATEDB NOSUPERUSER PASSWORD NULL;
SELECT 'CREATE DATABASE ${database} OWNER ${role}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${database}')\\gexec
\\connect ${database}
${FOUNDATION_SCHEMA_SQL.trim()}
`;
}

export function buildPgSealScript() {
  return `# mock2-foundation — sourced by the image's entrypoint as the last init file.
# Removes the first-initialization ident mapping and leaves the data
# directory's own (unused) pg_hba/pg_ident equal to the platform's, so even a
# server started without the -c overrides would be socket + peer only.
cp '${PG_CONF_DIR}/pg_hba.conf' "\${PGDATA}/pg_hba.conf"
cp '${PG_CONF_DIR}/pg_ident.conf' "\${PGDATA}/pg_ident.conf"
rm -f '${PG_INIT_IDENT}'
`;
}

// ---------------------------------------------------------------------------
// Compose model → YAML
// ---------------------------------------------------------------------------
const LOGGING = Object.freeze({ driver: 'local', options: { 'max-size': '10m', 'max-file': '3' } });

// buildFoundationComposeModel({ portable, layout }) → the Compose document as a
// plain object (unit tests inspect it; buildFoundationComposeYaml renders it).
// portable: the copy shipped in the app repository (foundation/compose.yaml):
// the same services, files and socket/peer design, with the project name, the
// socket directory and the published ports overridable from the environment
// and project-scoped volumes, so it runs outside ProxyPilot next to other apps.
export function buildFoundationComposeModel({ portable = false, layout = DEFAULT_LAYOUT } = {}) {
  const L = resolveLayout(layout);
  const env = (name, dflt) => (portable ? `\${${name}:-${dflt}}` : String(dflt));
  const pg = STACK.postgres; const s3 = STACK.storage; const em = STACK.embeddings;
  const socketDir = env('MOCK2_FOUNDATION_SOCKET_DIR', L.socketDir);
  const volumeRef = (key) => (portable ? STACK[key].volume : L.volumes[key]);
  const services = {
    [pg.service]: {
      image: FOUNDATION_IMAGES.postgres,
      restart: 'unless-stopped',
      network_mode: 'none',
      entrypoint: ['bash', `${PG_CONF_DIR}/entrypoint.sh`],
      command: ['postgres', '-c', `hba_file=${PG_CONF_DIR}/pg_hba.conf`, '-c', `ident_file=${PG_CONF_DIR}/pg_ident.conf`, '-c', 'listen_addresses='],
      environment: {
        // Required by the image to initialize without a superuser password. It
        // only writes a `host … trust` line into the data directory's own
        // pg_hba.conf, which this server never reads (hba_file above; the seal
        // script overwrites it too) — and there is no TCP to reach it with.
        POSTGRES_HOST_AUTH_METHOD: 'trust',
        POSTGRES_INITDB_ARGS: '--auth-local=peer --auth-host=reject',
      },
      volumes: [
        `${volumeRef('postgres')}:/var/lib/postgresql`,
        `${socketDir}:/var/run/postgresql`,
        `./postgres:${PG_CONF_DIR}:ro`,
        './postgres/initdb:/docker-entrypoint-initdb.d:ro',
      ],
      shm_size: FOUNDATION_LIMITS.postgres.shm,
      mem_limit: FOUNDATION_LIMITS.postgres.mem,
      stop_grace_period: '60s',
      healthcheck: {
        // PID 1 owning postmaster.pid means the REAL server is up (the image's
        // first-start temporary server is a child process), then a real query.
        test: ['CMD-SHELL', 'test "$$(head -n1 "$$PGDATA/postmaster.pid" 2>/dev/null)" = 1 && psql -X -q -U postgres -d postgres -tAc "SELECT 1" >/dev/null'],
        interval: '5s', timeout: '5s', retries: 12, start_period: '120s',
      },
      logging: LOGGING,
    },
    [s3.service]: {
      image: FOUNDATION_IMAGES.storage,
      restart: 'unless-stopped',
      command: [
        'server', '-dir=/data', '-ip=127.0.0.1', '-ip.bind=127.0.0.1',
        '-filer', '-s3', `-s3.port=${s3.port}`, '-s3.ip.bind=0.0.0.0',
        '-s3.port.iceberg=0', '-s3.port.lance=0',
        '-master.volumeSizeLimitMB=1024', '-volume.max=0', '-volume.preStopSeconds=1',
      ],
      environment: { GOMEMLIMIT: FOUNDATION_LIMITS.storage.goMemLimit },
      ports: [`${s3.listen}:${env('MOCK2_FOUNDATION_S3_PORT', L.ports.storage)}:${s3.port}`],
      volumes: [`${volumeRef('storage')}:/data`],
      networks: ['storage'],
      mem_limit: FOUNDATION_LIMITS.storage.mem,
      stop_grace_period: '30s',
      healthcheck: {
        test: ['CMD-SHELL', `wget -q -O /dev/null http://127.0.0.1:${s3.port}/healthz`],
        interval: '5s', timeout: '5s', retries: 12, start_period: '60s',
      },
      logging: LOGGING,
    },
    [em.service]: {
      image: FOUNDATION_IMAGES.embeddings,
      restart: 'unless-stopped',
      // --auto-truncate: an input longer than the model's 512-token window is
      // cut to it instead of failing the whole request (TEI answers 413 without it).
      command: ['--model-id', em.model, '--hostname', '0.0.0.0', '--port', '80', '--auto-truncate', '--json-output'],
      environment: { HUGGINGFACE_HUB_CACHE: '/data', RAYON_NUM_THREADS: String(FOUNDATION_LIMITS.embeddings.threads) },
      ports: [`${em.listen}:${env('MOCK2_FOUNDATION_EMBEDDINGS_PORT', L.ports.embeddings)}:80`],
      volumes: [`${volumeRef('embeddings')}:/data`],
      networks: ['embeddings'],
      mem_limit: FOUNDATION_LIMITS.embeddings.mem,
      stop_grace_period: '20s',
      healthcheck: {
        // The first start downloads the model into the cache volume.
        test: ['CMD-SHELL', 'curl -fsS -o /dev/null http://127.0.0.1:80/health'],
        interval: '10s', timeout: '5s', retries: 6, start_period: '900s',
      },
      logging: LOGGING,
    },
  };
  const volumes = portable
    ? { [pg.volume]: {}, [s3.volume]: {}, [em.volume]: {} }
    : { [L.volumes.postgres]: { name: L.volumes.postgres }, [L.volumes.storage]: { name: L.volumes.storage }, [L.volumes.embeddings]: { name: L.volumes.embeddings } };
  return {
    name: portable ? '${MOCK2_FOUNDATION_PROJECT:-mock2-foundation}' : L.composeProject,
    services,
    // One network per service: neither can reach the other's internal ports.
    networks: { storage: {}, embeddings: {} },
    volumes,
  };
}

const YAML_KEY_RE = /^[A-Za-z0-9_.-]+$/;
function yamlScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v)); // JSON strings are valid YAML double-quoted scalars
}
function yamlKey(k) { return YAML_KEY_RE.test(k) ? k : JSON.stringify(k); }
function emitYaml(value, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) {
      if (!v.length) { lines.push(`${pad}${yamlKey(k)}: []`); continue; }
      lines.push(`${pad}${yamlKey(k)}:`);
      for (const item of v) lines.push(`${pad}  - ${yamlScalar(item)}`);
    } else if (v && typeof v === 'object') {
      if (!Object.keys(v).length) { lines.push(`${pad}${yamlKey(k)}: {}`); continue; }
      lines.push(`${pad}${yamlKey(k)}:`);
      lines.push(...emitYaml(v, indent + 2));
    } else {
      lines.push(`${pad}${yamlKey(k)}: ${yamlScalar(v)}`);
    }
  }
  return lines;
}

function composeHeader(portable) {
  const common = [
    `# Mock2 application foundation (${FOUNDATION_VERSION}) — PostgreSQL + pgvector, S3 storage, embeddings.`,
    '# No secret lives in this file. Postgres listens on no TCP port: connect through the',
    `# socket directory with peer authentication (${FOUNDATION_DATABASE_URL}).`,
    '# S3 and the embedding server are published on 127.0.0.1 only.',
    '# Turning a feature off is `docker compose stop <service>`; never `down -v` (that deletes data).',
  ];
  if (!portable) {
    return [...common,
      '# Platform-owned: generated by ProxyPilot from the deployment\'s state. Edits are overwritten.'].join('\n');
  }
  return [...common,
    '# Portable copy shipped with the application: the same stack outside ProxyPilot.',
    '#   docker compose -f foundation/compose.yaml up -d            (as root; the app connects as root)',
    '#   env overrides: MOCK2_FOUNDATION_PROJECT, MOCK2_FOUNDATION_SOCKET_DIR,',
    '#                  MOCK2_FOUNDATION_S3_PORT, MOCK2_FOUNDATION_EMBEDDINGS_PORT',
    '# S3 identities are NOT in this repository. Create them once, keys on stdin:',
    `#   printf 's3.configure -user ${STORAGE_APP_USER} -access_key <id> -secret_key <secret> -buckets ${STACK.storage.bucket} -actions ${STORAGE_APP_ACTIONS} -apply\\n' \\`,
    '#     | docker compose -f foundation/compose.yaml exec -T storage weed shell >/dev/null',
    `#   printf 's3.bucket.create -name ${STACK.storage.bucket}\\n' | docker compose -f foundation/compose.yaml exec -T storage weed shell`,
    '# Until an identity exists the bundled S3 accepts anonymous requests (127.0.0.1 only).'].join('\n');
}

export function buildFoundationComposeYaml({ portable = false, layout = DEFAULT_LAYOUT } = {}) {
  const model = buildFoundationComposeModel({ portable, layout });
  return `${composeHeader(portable)}\n${emitYaml(model, 0).join('\n')}\n`;
}

// buildFoundationFiles({ portable, layout }) → [{ path, content, mode }] with
// paths RELATIVE to the stack directory (STACK.dir on the guest, foundation/
// in the app repository). The scaffold writes the portable set; the guest gets
// the platform set through writeFoundationFiles.
export function buildFoundationFiles({ portable = false, layout = DEFAULT_LAYOUT } = {}) {
  return [
    { path: 'compose.yaml', content: buildFoundationComposeYaml({ portable, layout }), mode: 0o644 },
    { path: 'postgres/pg_hba.conf', content: buildPgHbaConf(), mode: 0o644 },
    { path: 'postgres/pg_ident.conf', content: buildPgIdentConf(), mode: 0o644 },
    { path: 'postgres/entrypoint.sh', content: buildPgEntrypoint(), mode: 0o755 },
    { path: 'postgres/initdb/01-mock2-foundation.sql', content: buildFoundationInitSql(), mode: 0o644 },
    { path: 'postgres/initdb/99-mock2-seal.sh', content: buildPgSealScript(), mode: 0o644 },
  ];
}

// ---------------------------------------------------------------------------
// Which services a feature state wants running.
// ---------------------------------------------------------------------------
export function wantedServices(features) {
  const f = features || {};
  const st = f.storage || {}; const em = f.embeddings || {};
  return {
    [STACK.postgres.service]: true,
    [STACK.storage.service]: st.state === 'on' && st.provider === 'bundled',
    [STACK.embeddings.service]: em.state === 'on' && em.provider === 'local',
  };
}

// ---------------------------------------------------------------------------
// Credentials crossing into the guest (always on stdin). The charset keeps
// them literal inside a weed-shell command line and a curl config line.
// ---------------------------------------------------------------------------
const ACCESS_KEY_RE = /^[A-Za-z0-9]{12,128}$/;
const SECRET_KEY_RE = /^[A-Za-z0-9+/=._-]{16,128}$/;
export function storageCredentialError(c, label) {
  if (!c || typeof c !== 'object') return `${label} storage credentials are missing`;
  if (!ACCESS_KEY_RE.test(String(c.accessKeyId || ''))) return `${label} access key id must be 12–128 letters and digits`;
  if (!SECRET_KEY_RE.test(String(c.secretAccessKey || ''))) return `${label} secret access key must be 16–128 characters of [A-Za-z0-9+/=._-]`;
  return null;
}
export function masterKeyError(masterKeyB64) {
  const s = String(masterKeyB64 || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s)) return 'the foundation master key must be 32 bytes, base64';
  if (Buffer.from(s, 'base64').length !== 32) return 'the foundation master key must be 32 bytes, base64';
  return null;
}

// ---------------------------------------------------------------------------
// Guest-side scripts (sh -c <script>; inputs on stdin or as positional args)
// ---------------------------------------------------------------------------

// Docker present + reachable, Compose v2, the storage driver.
export function dockerProbeScript() {
  return [
    'command -v docker >/dev/null 2>&1 || { echo "DOCKER:missing"; exit 0; }',
    'if command -v systemctl >/dev/null 2>&1; then systemctl is-active --quiet docker 2>/dev/null || systemctl start docker >/dev/null 2>&1 || true; fi',
    'v=$(docker version --format "{{.Server.Version}}" 2>/dev/null) || v=""',
    'echo "DOCKER:${v:-unreachable}"',
    'c=$(docker compose version --short 2>/dev/null) || c=""',
    'echo "COMPOSE:${c:-missing}"',
    'd=$(docker info --format "{{.Driver}}" 2>/dev/null) || d=""',
    'echo "DRIVER:${d:-unknown}"',
    '',
  ].join('\n');
}

export function parseDockerProbe(stdout) {
  const s = String(stdout || '');
  const get = (k) => ((s.match(new RegExp(`^${k}:(.*)$`, 'm')) || [])[1] || '').trim();
  const docker = get('DOCKER'); const compose = get('COMPOSE'); const driver = get('DRIVER');
  const composeMajor = Number((compose.match(/^v?(\d+)\./) || [])[1]);
  if (!docker || docker === 'missing') return { ok: false, docker: null, compose: null, driver: null, error: 'Docker is not installed in the guest — the foundation setup installs docker.io and docker-compose from Debian 13; re-run provisioning and read the setup step\'s output' };
  if (docker === 'unreachable') return { ok: false, docker: null, compose: compose || null, driver: null, error: 'the Docker daemon is not running in the guest (docker version could not reach it) — check `systemctl status docker` and that the guest is Docker-ready (security.nesting + syscall intercepts)' };
  if (!compose || compose === 'missing' || !(composeMajor >= 2)) return { ok: false, docker, compose: compose || null, driver, error: `Docker Compose v2 is not available in the guest (\`docker compose version\` → ${compose || 'missing'})` };
  return { ok: true, docker, compose, driver: driver || 'unknown', error: null, warning: driver === 'vfs' ? 'Docker fell back to the vfs storage driver (no overlay support on this guest\'s filesystem): images use much more disk' : null };
}

// Which pinned images are already in the guest ($@ = image references). The
// pins are digests, so a present image is exactly the one wanted: bring-up
// pulls only what is missing and never asks a registry again (a re-run would
// otherwise spend Docker Hub's anonymous pull budget for nothing).
export function imagePresenceScript() {
  return 'for ref in "$@"; do if docker image inspect "$ref" >/dev/null 2>&1; then echo "PRESENT:$ref"; else echo "MISSING:$ref"; fi; done\n';
}
export function parseImagePresence(stdout) {
  const s = String(stdout || '');
  return {
    present: [...s.matchAll(/^PRESENT:(.+)$/gm)].map((m) => m[1].trim()),
    missing: [...s.matchAll(/^MISSING:(.+)$/gm)].map((m) => m[1].trim()),
  };
}

// Write the stack files idempotently: each file is compared with what is
// there and replaced only when it differs (atomic rename). Prints
// WROTE:/SAME:<path>. The content is not secret, so it rides in the script.
export function writeFilesScript(files, layout = DEFAULT_LAYOUT) {
  const L = resolveLayout(layout);
  const lines = [
    'set -eu',
    'umask 022',
    `D=${sq(L.dir)}`,
    'mkdir -p "$D"',
    `mkdir -p ${sq(L.socketDir)}`,
  ];
  // /run is a tmpfs: a tmpfiles.d line recreates the socket's parent at every
  // boot (Docker creates the leaf for the bind mount itself). Only for a
  // socket under /run — a test layout elsewhere never touches /etc.
  if (L.socketDir.startsWith('/run/')) {
    const parent = L.socketDir.replace(/\/[^/]+$/, '');
    lines.push(
      'if [ -d /etc/tmpfiles.d ]; then',
      `  printf '%s\\n' ${sq(`d ${parent} 0755 root root -`)} > /etc/tmpfiles.d/mock2-foundation.conf.new`,
      '  if cmp -s /etc/tmpfiles.d/mock2-foundation.conf.new /etc/tmpfiles.d/mock2-foundation.conf; then rm -f /etc/tmpfiles.d/mock2-foundation.conf.new; else mv -f /etc/tmpfiles.d/mock2-foundation.conf.new /etc/tmpfiles.d/mock2-foundation.conf; fi',
      'fi',
    );
  }
  for (const f of files) {
    if (!/^[a-z0-9][a-z0-9._/-]{0,120}$/.test(f.path) || f.path.includes('..')) throw new Error(`invalid foundation file path: ${f.path}`);
    const mode = (f.mode || 0o644).toString(8);
    const target = `${L.dir}/${f.path}`;
    lines.push(
      `f=${sq(target)}; mkdir -p "$(dirname "$f")"`,
      `printf '%s' '${Buffer.from(String(f.content), 'utf8').toString('base64')}' | base64 -d > "$f.mock2-new"`,
      `if [ -f "$f" ] && cmp -s "$f.mock2-new" "$f"; then rm -f "$f.mock2-new"; echo "SAME:${f.path}"; else mv -f "$f.mock2-new" "$f"; echo "WROTE:${f.path}"; fi`,
      `chmod ${mode} "$f"`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function parseWriteFiles(stdout) {
  const s = String(stdout || '');
  const wrote = [...s.matchAll(/^WROTE:(.+)$/gm)].map((m) => m[1]);
  const same = [...s.matchAll(/^SAME:(.+)$/gm)].map((m) => m[1]);
  return { wrote, same, changed: wrote.length > 0 };
}

// The master key, base64 on stdin, into STACK.keyFile (0600 root, directory
// 0700). Never echoed; only whether it changed and the resulting mode.
export function masterKeyScript(layout = DEFAULT_LAYOUT) {
  const L = resolveLayout(layout);
  return [
    'set -eu',
    'umask 077',
    `K=${sq(L.keyFile)}`,
    'D=$(dirname "$K")',
    'mkdir -p "$D"; chmod 700 "$D"; chown root:root "$D" 2>/dev/null || true',
    'IFS= read -r KEY || [ -n "${KEY:-}" ]',
    '[ -n "${KEY:-}" ] || { echo "KEY:empty"; exit 3; }',
    'T="$K.tmp.$$"',
    'printf \'%s\\n\' "$KEY" > "$T"',
    'chown root:root "$T" 2>/dev/null || true; chmod 600 "$T"',
    'if [ -f "$K" ] && cmp -s "$T" "$K"; then rm -f "$T"; echo "KEY:unchanged"; else mv -f "$T" "$K"; echo "KEY:written"; fi',
    'echo "MODE:$(stat -c %a "$K"):$(stat -c %U "$K")"',
    '',
  ].join('\n');
}

export function parseMasterKey(stdout) {
  const s = String(stdout || '');
  const state = (s.match(/^KEY:(\w+)$/m) || [])[1] || null;
  const mode = (s.match(/^MODE:(\d+):(\S+)$/m) || []);
  return { state, changed: state === 'written', mode: mode[1] || null, owner: mode[2] || null };
}

// The superuser ensure SQL, run through psql in the postgres service (stdin).
export function foundationEnsureSql() {
  return buildFoundationInitSql();
}

// psql in the postgres service as the superuser, SQL on stdin.
export function foundationPsqlArgv(database = STACK.postgres.database, layout = DEFAULT_LAYOUT) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(String(database))) throw new Error(`invalid database name: ${database}`);
  return [...composeArgv(layout), 'exec', '-T', STACK.postgres.service,
    'psql', '-U', 'postgres', '-d', String(database), '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A'];
}

// A transient error while Postgres is (re)starting — worth one more try.
export function isTransientPgError(text) {
  return /the database system is (starting up|shutting down|in recovery mode)|connection to server on socket .* failed: (No such file|Connection refused)|is not running|container .* is (restarting|not running)|No such container|service "postgres" is not running/i.test(String(text || ''));
}

// Configure the bundled S3 identities and the bucket. Runs INSIDE the storage
// container (busybox sh): `weed shell` there talks to the local master and
// filer. stdin: app access key id, app secret, admin access key id, admin
// secret — one per line. Each identity is deleted and re-created with exactly
// the given key, so a rotated key never leaves the old one valid. weed shell
// echoes the configuration (keys included), so its output is never printed:
// failures print only lines that name no key. Then proves the result: an
// anonymous request is refused, the app key lists its bucket, the admin key
// works.
export function storageIdentityScript() {
  const s3 = STACK.storage;
  const url = `http://127.0.0.1:${s3.port}/${s3.bucket}`;
  return [
    'IFS= read -r APP_AK; IFS= read -r APP_SK; IFS= read -r ADM_AK; IFS= read -r ADM_SK',
    '[ -n "$APP_AK" ] && [ -n "$APP_SK" ] && [ -n "$ADM_AK" ] && [ -n "$ADM_SK" ] || { echo "FAIL:credentials-missing"; exit 2; }',
    'ws() { weed shell 2>&1; }',
    // Error lines only, and never a line that carries a key or names one.
    'clean() { while IFS= read -r l; do case "$l" in *"$APP_SK"*|*"$ADM_SK"*|*"$APP_AK"*|*"$ADM_AK"*|*[Aa]ccess?[Kk]ey*|*[Ss]ecret?[Kk]ey*|*[Ss]ecret[Kk]ey*|*[Aa]ccess[Kk]ey*) continue;; esac; case "$l" in *[Ee]rror*|*[Ff]ail*|*denied*|*invalid*|*"not found"*|*unknown*) printf \'%s\\n\' "$l";; esac; done | tail -n 6; }',
    'del() { out=$(printf \'s3.configure -user %s -delete -apply\\n\' "$1" | ws); rc=$?; if [ $rc -ne 0 ] && ! printf \'%s\\n\' "$out" | grep -q "not found"; then echo "FAIL:delete-$1"; printf \'%s\\n\' "$out" | clean; exit 1; fi; }',
    `del ${STORAGE_ADMIN_USER}`,
    `out=$(printf 's3.configure -user %s -access_key %s -secret_key %s -actions Admin -apply\\n' ${STORAGE_ADMIN_USER} "$ADM_AK" "$ADM_SK" | ws) || { echo "FAIL:configure-admin"; printf '%s\\n' "$out" | clean; exit 1; }`,
    'echo "OK:admin"',
    `del ${STORAGE_APP_USER}`,
    `out=$(printf 's3.configure -user %s -access_key %s -secret_key %s -buckets %s -actions %s -apply\\n' ${STORAGE_APP_USER} "$APP_AK" "$APP_SK" ${s3.bucket} ${STORAGE_APP_ACTIONS} | ws) || { echo "FAIL:configure-app"; printf '%s\\n' "$out" | clean; exit 1; }`,
    'echo "OK:app"',
    'list=$(printf \'s3.bucket.list\\n\' | ws) || { echo "FAIL:bucket-list"; printf \'%s\\n\' "$list" | clean; exit 1; }',
    `if printf '%s\\n' "$list" | grep -qE '^[[:space:]]*${s3.bucket}[[:space:]]'; then echo "OK:bucket-exists"; else out=$(printf 's3.bucket.create -name ${s3.bucket}\\n' | ws) || { echo "FAIL:bucket-create"; printf '%s\\n' "$out" | clean; exit 1; }; echo "OK:bucket-created"; fi`,
    // The gateway picks identity changes up from the filer asynchronously.
    'i=0; while :; do',
    `  anon=$(curl -s -o /dev/null -w '%{http_code}' '${url}' 2>/dev/null || echo 000)`,
    `  appk=$(printf 'user = "%s:%s"\\n' "$APP_AK" "$APP_SK" | curl -s -o /dev/null -w '%{http_code}' -K - --aws-sigv4 'aws:amz:${s3.region}:s3' '${url}?list-type=2&max-keys=1' 2>/dev/null || echo 000)`,
    `  admk=$(printf 'user = "%s:%s"\\n' "$ADM_AK" "$ADM_SK" | curl -s -o /dev/null -w '%{http_code}' -K - --aws-sigv4 'aws:amz:${s3.region}:s3' '${url}?list-type=2&max-keys=1' 2>/dev/null || echo 000)`,
    '  if [ "$anon" = 403 ] && [ "$appk" = 200 ] && [ "$admk" = 200 ]; then break; fi',
    '  i=$((i + 1)); [ $i -ge 20 ] && break; sleep 1',
    'done',
    'echo "ANON:$anon"; echo "APPKEY:$appk"; echo "ADMINKEY:$admk"',
    '',
  ].join('\n');
}

export function parseStorageIdentity(stdout, code) {
  const s = String(stdout || '');
  const get = (k) => ((s.match(new RegExp(`^${k}:(.*)$`, 'm')) || [])[1] || '').trim();
  const fail = get('FAIL');
  const result = {
    admin: /^OK:admin$/m.test(s), app: /^OK:app$/m.test(s),
    bucket: /^OK:bucket-created$/m.test(s) ? 'created' : /^OK:bucket-exists$/m.test(s) ? 'exists' : null,
    anonymous: get('ANON') || null, appKey: get('APPKEY') || null, adminKey: get('ADMINKEY') || null,
  };
  if (fail || code !== 0) {
    const detail = s.split('\n').filter((l) => l && !/^(OK|ANON|APPKEY|ADMINKEY):/.test(l)).join(' ').slice(0, 400);
    return { ...result, ok: false, error: `configuring the bundled S3 identities failed (${fail || `exit ${code}`})${detail ? `: ${detail}` : ''}` };
  }
  if (result.anonymous !== '403') return { ...result, ok: false, error: `the bundled S3 still answers anonymous requests (HTTP ${result.anonymous || 'none'} instead of 403) — refusing to continue with open storage` };
  if (result.appKey !== '200') return { ...result, ok: false, error: `the app S3 key could not list bucket ${STACK.storage.bucket} (HTTP ${result.appKey || 'none'})` };
  if (result.adminKey !== '200') return { ...result, ok: false, error: `the admin S3 key could not list bucket ${STACK.storage.bucket} (HTTP ${result.adminKey || 'none'})` };
  return { ...result, ok: true, error: null };
}

// Count the objects in bucket app with the admin key (S3 ListObjectsV2, every
// page). Runs inside the storage container; stdin: access key id, secret.
export function objectCountScript() {
  const s3 = STACK.storage;
  const url = `http://127.0.0.1:${s3.port}/${s3.bucket}`;
  return [
    'IFS= read -r AK; IFS= read -r SK',
    '[ -n "$AK" ] && [ -n "$SK" ] || { echo "COUNT:error:credentials-missing"; exit 0; }',
    'n=0; tok=""; pages=0',
    'while :; do',
    '  if [ -n "$tok" ]; then set -- --data-urlencode "continuation-token=$tok"; else set --; fi',
    `  body=$(printf 'user = "%s:%s"\\n' "$AK" "$SK" | curl -sS -G -K - --aws-sigv4 'aws:amz:${s3.region}:s3' --data-urlencode 'list-type=2' --data-urlencode 'max-keys=1000' "$@" -w '\\nHTTP:%{http_code}' '${url}' 2>/dev/null) || { echo "COUNT:error:curl"; exit 0; }`,
    '  code=${body##*HTTP:}',
    '  [ "$code" = 200 ] || { echo "COUNT:error:http-$code"; exit 0; }',
    '  k=$(printf \'%s\' "$body" | sed -n \'s:.*<KeyCount>\\([0-9]*\\)</KeyCount>.*:\\1:p\' | head -n1)',
    '  n=$((n + ${k:-0}))',
    '  printf \'%s\' "$body" | grep -q \'<IsTruncated>true</IsTruncated>\' || break',
    '  tok=$(printf \'%s\' "$body" | sed -n \'s:.*<NextContinuationToken>\\([^<]*\\)</NextContinuationToken>.*:\\1:p\' | head -n1 | sed -e \'s/&lt;/</g\' -e \'s/&gt;/>/g\' -e \'s/&#34;/"/g\' -e \'s/&quot;/"/g\' -e "s/&#39;/\'/g" -e "s/&apos;/\'/g" -e \'s/&amp;/\\&/g\')',
    '  [ -n "$tok" ] || { echo "COUNT:error:no-continuation-token"; exit 0; }',
    '  pages=$((pages + 1)); [ $pages -lt 100000 ] || { echo "COUNT:error:too-many-pages"; exit 0; }',
    'done',
    'echo "COUNT:$n"',
    '',
  ].join('\n');
}

export function parseObjectCount(stdout) {
  const m = String(stdout || '').match(/^COUNT:(\d+)$/m);
  return m ? Number(m[1]) : null;
}

// `docker compose ps --all --format json` → [{ service, state, health }] for
// the three STACK services. Compose prints one JSON object per line (2.21+)
// or one array (older); both are accepted. A service with no container is
// `absent` (never created: its feature has been off since provisioning).
export function interpretServiceStatus(psOutput) {
  const text = String(psOutput || '').trim();
  let rows = [];
  if (text.startsWith('[')) {
    try { rows = JSON.parse(text); } catch { rows = []; }
  } else {
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try { rows.push(JSON.parse(l)); } catch { /* skip a malformed line */ }
    }
  }
  const byService = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const service = String(r?.Service || '');
    if (service) byService.set(service, r);
  }
  return FOUNDATION_SERVICES.map((service) => {
    const r = byService.get(service);
    if (!r) return { service, state: 'absent', health: 'none' };
    const state = String(r.State || '').toLowerCase() || 'unknown';
    const health = String(r.Health || '').toLowerCase() || 'none';
    return { service, state, health, ...(r.ExitCode != null && state !== 'running' ? { exitCode: Number(r.ExitCode) } : {}) };
  });
}

// Readiness of the services that must be up: running AND healthy.
export function servicesReady(statuses, required) {
  const want = new Set(required);
  const rows = (statuses || []).filter((s) => want.has(s.service));
  const notReady = rows.filter((s) => !(s.state === 'running' && s.health === 'healthy'));
  const failed = rows.filter((s) => s.health === 'unhealthy' || ['exited', 'dead'].includes(s.state));
  return { ready: notReady.length === 0 && rows.length === want.size, notReady: notReady.map((s) => s.service), failed: failed.map((s) => s.service) };
}

// ---------------------------------------------------------------------------
// MCP database tools on a foundation guest (sh -c <script> sh <args…>)
// ---------------------------------------------------------------------------

// run_project_sql: $1 = row limit, the statement on stdin. Same output format
// as the native path (header + rows, `|`-separated, no footer), READ ONLY
// transaction with a 30 s statement timeout, as the superuser on "app".
export function foundationReadOnlySqlScript(layout = DEFAULT_LAYOUT) {
  return 'n="$1"; command -v docker >/dev/null 2>&1 || { echo NODOCKER >&2; exit 66; }; '
    + `out=$(${foundationPgExecPrefix(layout)} psql -X -v ON_ERROR_STOP=1 -U postgres -d ${STACK.postgres.database} -A -F '|' --pset footer=off -c 'SET statement_timeout = 30000' -c 'BEGIN READ ONLY' -f - -c ROLLBACK 2>&1); ec=$?; `
    + 'printf "%s\\n" "$out" | head -n "$((n + 8))"; exit $ec';
}

// dump_project_db: $1 = the dump file in the guest. pg_dump runs inside the
// postgres service (its version matches the server).
export function foundationDumpScript(layout = DEFAULT_LAYOUT) {
  return 'f="$1"; mkdir -p "$(dirname "$f")"; command -v docker >/dev/null 2>&1 || { echo NODOCKER >&2; exit 66; }; umask 077; '
    + `${foundationPgExecPrefix(layout)} pg_dump -U postgres --clean --if-exists ${STACK.postgres.database} > "$f.tmp" || { rm -f "$f.tmp"; exit 1; }; `
    + 'mv "$f.tmp" "$f"; chmod 600 "$f"; wc -c < "$f"; sha256sum "$f" | cut -d" " -f1';
}

// Clone: the platform-held rows of the SOURCE deployment (its sealed secrets,
// its feature switches, its jobs and probes) are not data of the clone — the
// clone's own are re-synced after the restore. The vector indexes and their
// tables ARE data and are copied.
export const CLONE_EXCLUDED_TABLE_DATA = Object.freeze([
  'mock2_foundation.secrets', 'mock2_foundation.features', 'mock2_foundation.jobs',
  'mock2_foundation.storage_migration_items', 'mock2_foundation.health',
]);
// A build checkpoint's database snapshot (state/db/snapshot.sql) is COMMITTED
// into the app repository, which may be pushed to a remote: the platform-held
// tables (sealed secrets, switches, jobs, probes, the generation counter) are
// left out entirely — definition and data — so a snapshot never carries a
// sealed secret and replaying one never rolls those rows back. The vector
// indexes are app data and ride along.
export const CHECKPOINT_EXCLUDED_TABLES = Object.freeze([...CLONE_EXCLUDED_TABLE_DATA, 'mock2_foundation.meta']);
export function foundationCheckpointDumpCommand(layout = DEFAULT_LAYOUT) {
  return `${foundationPgExecPrefix(layout)} pg_dump -U postgres --clean --if-exists ${CHECKPOINT_EXCLUDED_TABLES.map((t) => `--exclude-table=${t}`).join(' ')} ${STACK.postgres.database}`;
}
export function foundationSuperuserPsqlCommand(layout = DEFAULT_LAYOUT) {
  return `${foundationPgExecPrefix(layout)} psql -U postgres -X`;
}
export function foundationCloneDumpArgv(layout = DEFAULT_LAYOUT) {
  return [...composeArgv(layout), 'exec', '-T', STACK.postgres.service, 'pg_dump', '-U', 'postgres', '--clean', '--if-exists',
    ...CLONE_EXCLUDED_TABLE_DATA.map((t) => `--exclude-table-data=${t}`), STACK.postgres.database];
}
export function foundationCloneRestoreArgv(layout = DEFAULT_LAYOUT) {
  return [...composeArgv(layout), 'exec', '-T', STACK.postgres.service, 'psql', '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=0', '-d', STACK.postgres.database];
}

// The host-side clone pipe (bash): dump in the source guest | restore in the
// target guest, either side foundation or native. pipefail, so a failed DUMP
// fails the copy too (the native one-liner reports only its last stage).
// The restore's tail goes to stdout, the dump's errors to stderr.
export function clonePipeScript({ source, target, sourceFoundation, targetFoundation, layout = DEFAULT_LAYOUT }) {
  for (const c of [source, target]) if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(String(c || ''))) throw new Error(`invalid container name: ${c}`);
  const dump = sourceFoundation
    ? `incus exec ${source} -- ${foundationCloneDumpArgv(layout).map(sq).join(' ')}`
    : `incus exec ${source} -- su - postgres -c 'pg_dump --clean --if-exists app'`;
  const restore = targetFoundation
    ? `incus exec ${target} -- ${foundationCloneRestoreArgv(layout).map(sq).join(' ')}`
    : `incus exec ${target} -- su - postgres -c 'psql -q -v ON_ERROR_STOP=0 app'`;
  return [
    'set -o pipefail',
    `out=$(${dump} | ${restore} 2>&1); rc=$?`,
    'printf \'%s\\n\' "$out" | tail -n 3',
    'exit $rc',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The generated app's foundation CLI
// ---------------------------------------------------------------------------
export const FOUNDATION_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function foundationJobUnit(jobId) {
  if (!FOUNDATION_JOB_ID_RE.test(String(jobId || ''))) throw new Error(`invalid foundation job id: ${jobId}`);
  return `mock2-foundation-job-${jobId}`;
}

export function foundationCliArgsError(args) {
  if (!Array.isArray(args) || !args.length) return 'foundation CLI arguments must be a non-empty array';
  if (!FOUNDATION_CLI_COMMANDS.includes(args[0])) return `unknown foundation CLI command: ${args[0]}`;
  for (const a of args) if (typeof a !== 'string' || a.length > 512 || /[\0\n\r]/.test(a)) return 'foundation CLI arguments must be single-line strings';
  return null;
}

const APP_DIR_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
// $1 = app dir, the rest = CLI args. The app's environment file is sourced
// (operator-set env), DATABASE_URL defaults to the socket URL.
export function foundationCliScript() {
  return 'cd "$1" || exit 97; shift; set -a; . /etc/environment 2>/dev/null || true; set +a; '
    + `[ -n "\${DATABASE_URL:-}" ] || DATABASE_URL=${sq(FOUNDATION_DATABASE_URL)}; export DATABASE_URL; `
    + `exec node ${FOUNDATION_CLI} "$@"`;
}

// $1 = app dir, $2 = job id. One transient unit per job; --collect drops it
// when it finishes (successful or not), the job row holds the outcome.
export function foundationJobScript() {
  return 'NODE=$(command -v node) || { echo "NONODE" >&2; exit 69; }; '
    + 'cd "$1" || exit 97; '
    + 'exec systemd-run --quiet --unit="mock2-foundation-job-$2" --collect --working-directory="$1" '
    + `${sq(`--setenv=DATABASE_URL=${FOUNDATION_DATABASE_URL}`)} -p EnvironmentFile=-/etc/environment -p After=docker.service `
    + `"$NODE" ${FOUNDATION_CLI} job-run "$2"`;
}

export function validAppDir(appDir) {
  return APP_DIR_RE.test(String(appDir || '')) && !String(appDir).includes('..');
}
