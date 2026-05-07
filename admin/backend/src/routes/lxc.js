import { Router } from 'express';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, readdir, readFile, unlink, mkdir, stat } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { getDb } from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { ensureCaddyStructure, regenerateDomainCaddyConfig } from './services.js';
import { reconcileServiceL4Forwards } from '../lib/l4-reconciler.js';
import { shellSingleQuote } from '../lib/shell-quote.js';
import {
  fanOutSnapshotExport, listSnapshotExports, deleteSnapshotExport,
  cancelSnapshotExport, sweepOrphanTempInstances, importSnapshotFromS3,
  getSnapshotExportQueueStatus, inspectSnapshotS3Object, getImportProgress,
} from '../lib/snapshot-s3-export.js';

const execAsync = promisify(exec);

// Container backups can be tens to hundreds of GB on disk-heavy LXCs
// (Docker-in-LXC, databases, large media). The previous memoryStorage
// multer config buffered the entire upload into RAM and capped at 2GB,
// which both bottlenecked the import and crashed the backend on
// realistic backups. Switch to disk-backed multer with a far larger
// cap and stream the temp file into `incus import -` stdin from the
// disk handler.
//
// Cap is generous (50 GiB) but bounded so a single bad upload can't
// fill the host disk indefinitely — operators with bigger backups can
// raise LXC_IMPORT_LIMIT_BYTES via the environment.
const LXC_IMPORT_TMP_DIR = process.env.LXC_IMPORT_TMP_DIR || join(tmpdir(), 'proxypilot-imports');
const LXC_IMPORT_LIMIT_BYTES = parseInt(process.env.LXC_IMPORT_LIMIT_BYTES || String(50 * 1024 * 1024 * 1024), 10);
try { await mkdir(LXC_IMPORT_TMP_DIR, { recursive: true }); } catch {}
const importStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LXC_IMPORT_TMP_DIR),
  filename: (_req, _file, cb) => cb(null, `import-${Date.now()}-${randomUUID()}.tar.gz`),
});
const upload = multer({ storage: importStorage, limits: { fileSize: LXC_IMPORT_LIMIT_BYTES } });

export const lxcRouter = Router();

const INSTANCE_PREFIX = 'pp-';
const CADDY_SITES_DIR = process.env.CADDY_SITES_DIR || '/etc/caddy/sites';
const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

// In-memory tracking of active container creation jobs
const activeCreations = new Map();

// In-memory tracking of active snapshot creation jobs.
// Key: jobId. Value: { name, snapshotName, startedAt, status, error?,
// estimateMs, finishedAt? }. Synchronous `incus snapshot create` runs
// for several minutes on Docker-in-LXC and database containers (Postgres
// data dir, overlayfs layers) — beyond any reasonable HTTP timeout.
// The frontend kicks off the job, then polls a status endpoint for
// elapsed time + ETA, so the request itself returns immediately.
const activeSnapshots = new Map();
const SNAPSHOT_JOB_TTL_MS = 30 * 60 * 1000; // keep finished jobs around for 30 min so the UI can settle

// Check if running in Docker container
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// Execute command on host (uses nsenter when in Docker, direct exec otherwise)
async function execOnHost(command, options = {}) {
  const timeout = options.timeout || 30000;

  if (isInDocker) {
    const hostCommand = `nsenter -t 1 -m -u -n -i sh -c ${JSON.stringify(command)}`;
    return execAsync(hostCommand, { timeout });
  } else {
    return execAsync(command, { timeout });
  }
}

// Spawn a command on host without timeout (for long-running operations)
function spawnOnHost(command) {
  if (isInDocker) {
    return spawn('nsenter', ['-t', '1', '-m', '-u', '-n', '-i', 'sh', '-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    return spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}

// Ensure container has public DNS configured
async function ensureDns(incusName) {
  try {
    await execOnHost(
      `incus exec ${incusName} -- sh -c 'if ! grep -q "9.9.9.9" /etc/resolv.conf 2>/dev/null; then rm -f /etc/resolv.conf; printf "nameserver 9.9.9.9\\nnameserver 1.1.1.1\\n" > /etc/resolv.conf; fi'`,
      { timeout: 10000 }
    );
  } catch {}
}

// Ensure NAT and IP forwarding are enabled so containers have internet
async function ensureNetworkNat() {
  // Step 1: Enable IP forwarding on the host
  try {
    await execOnHost('sysctl -w net.ipv4.ip_forward=1', { timeout: 5000 });
    console.log('[LXC] IP forwarding enabled');
  } catch (err) {
    console.error('[LXC] Failed to enable IP forwarding:', err.message);
  }

  // Step 2: Enable NAT on all managed Incus bridge networks
  try {
    const result = await execOnHost('incus network list --format json', { timeout: 10000 });
    const networks = JSON.parse(result.stdout || '[]');
    for (const net of networks) {
      if (net.type === 'bridge' && net.managed) {
        try {
          await execOnHost(`incus network set ${net.name} ipv4.nat true`, { timeout: 10000 });
          console.log(`[LXC] Enabled ipv4.nat on bridge '${net.name}'`);
        } catch {}

        // Step 3: Allow Incus bridge traffic through Docker's FORWARD chain
        // Docker sets FORWARD policy to DROP, blocking Incus container traffic
        try {
          await execOnHost(
            `iptables -C DOCKER-USER -i ${net.name} -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -i ${net.name} -j ACCEPT`,
            { timeout: 10000 }
          );
          await execOnHost(
            `iptables -C DOCKER-USER -o ${net.name} -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -o ${net.name} -j ACCEPT`,
            { timeout: 10000 }
          );
          console.log(`[LXC] Docker FORWARD rules added for bridge '${net.name}'`);
        } catch {}
      }
    }
  } catch (err) {
    console.error('[LXC] incus network NAT setup failed:', err.message);
  }

  // Step 4: Fallback — add iptables MASQUERADE directly for container subnets
  try {
    await execOnHost(
      'iptables -t nat -C POSTROUTING -s 10.0.0.0/8 ! -d 10.0.0.0/8 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.0.0.0/8 ! -d 10.0.0.0/8 -j MASQUERADE',
      { timeout: 10000 }
    );
    console.log('[LXC] iptables MASQUERADE rule ensured');
  } catch (err) {
    console.error('[LXC] iptables MASQUERADE failed:', err.message);
  }
}

// Validate instance name to prevent command injection
function validateName(name) {
  if (!name || typeof name !== 'string') {
    return false;
  }
  return NAME_REGEX.test(name);
}

// Interfaces created by Docker / container runtimes inside the LXC.
// These are bridges and veth peers that only exist within the LXC's
// network namespace — their addresses (172.17.0.1, 172.18.0.1, etc.)
// are unreachable from the host so Caddy reverse-proxying to them
// returns 502. Filter them out when picking the LXC's externally
// reachable IP.
const DOCKER_IFACE_PATTERNS = [
  /^docker\d+$/,        // docker0, docker1
  /^docker_gwbridge$/,  // swarm overlay
  /^br-[0-9a-f]+$/,     // compose-style user-defined networks
  /^veth/,              // veth peers attached to docker bridges
  /^cni\d*$/,           // CNI plugins
];

function isContainerRuntimeIface(name) {
  return DOCKER_IFACE_PATTERNS.some((re) => re.test(name));
}

// Pick a non-loopback, non-docker, non-link-scope IPv4 address from the
// Incus state. Tries the conventional `eth0` first so the LXC's primary
// interface wins even if Object.entries iteration order ever surprises
// us; falls back to any other interface that isn't a docker/veth bridge.
function pickIp(container, family) {
  if (!container.state?.network) return null;
  const ifaces = Object.entries(container.state.network);
  const matches = (name, addr) => {
    if (addr.family !== family) return false;
    if (addr.scope && addr.scope !== 'global') return false;
    if (family === 'inet' && addr.address.startsWith('127.')) return false;
    if (family === 'inet6' && (addr.address.startsWith('::1') || addr.address.startsWith('fe80'))) return false;
    return true;
  };
  for (const [name, iface] of ifaces) {
    if (name !== 'eth0') continue;
    for (const addr of iface.addresses || []) {
      if (matches(name, addr)) return addr.address;
    }
  }
  for (const [name, iface] of ifaces) {
    if (name === 'lo' || isContainerRuntimeIface(name)) continue;
    for (const addr of iface.addresses || []) {
      if (matches(name, addr)) return addr.address;
    }
  }
  return null;
}

// Extract IPv4 address from container state
function extractIPv4(container) {
  return pickIp(container, 'inet');
}

// Phase 2b E.1: extract the first non-loopback IPv6 address from container
// state, mirroring the `extractIPv4` helper. Returns null when no IPv6
// address is bound (common for default Incus profiles).
function extractIPv6(container) {
  return pickIp(container, 'inet6');
}

// Helper to sleep for polling
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Apply requireAdmin to all routes in this router
lxcRouter.use(requireAdmin);

// GET /status - Check if Incus is available on the host
lxcRouter.get('/status', async (req, res) => {
  try {
    const { stdout } = await execOnHost('incus version 2>/dev/null');
    const version = stdout.trim();

    // Check if Incus has been initialized (has a storage pool)
    let initialized = true;
    let initWarning = null;
    try {
      const { stdout: poolsJson } = await execOnHost('incus storage list --format json 2>/dev/null');
      const pools = JSON.parse(poolsJson || '[]');
      if (pools.length === 0) {
        initialized = false;
        initWarning = 'Incus has no storage pools configured. Run: incus admin init --minimal';
      }
    } catch {
      initialized = false;
      initWarning = 'Could not query Incus storage pools. Run: incus admin init --minimal';
    }

    res.json({ success: true, available: true, version, initialized, initWarning });
  } catch {
    res.json({ success: true, available: false });
  }
});

// GET /containers - List all pp-* containers with their state
lxcRouter.get('/containers', async (req, res) => {
  try {
    const result = await execOnHost('incus list --format json');
    const all = JSON.parse(result.stdout || '[]');
    const containers = all
      .filter(c => c.name.startsWith(INSTANCE_PREFIX))
      .map(c => ({
        name: c.name.replace(new RegExp(`^${INSTANCE_PREFIX}`), ''),
        incusName: c.name,
        status: c.status.toLowerCase(),
        type: c.type,
        architecture: c.architecture,
        created_at: c.created_at,
        image: c.config?.['image.description'] || c.config?.['image.os'] || '',
        ipv4: extractIPv4(c),
        profiles: c.profiles,
        config: {
          cpu: c.config?.['limits.cpu'] || 'unlimited',
          memory: c.config?.['limits.memory'] || 'unlimited',
        },
      }));
    res.json({ success: true, containers });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to list containers',
      details: error.stderr || error.message,
    });
  }
});

// Phase 2b E.1: GET /containers/with-ip — compact listing used by the
// Add Service wizard's LXC dropdown. Returns `{containers: [{name,
// status, type, ipv4, ipv6}]}` with the `pp-` instance prefix
// stripped so the caller sees the operator-facing name directly.
// `type` is one of `'container'` or `'virtual-machine'` per Incus's
// own taxonomy; surfacing it here lets the wizard hide CT-only knobs
// (docker-privileged, etc.) when the operator picks a VM target.
// Reuses the same `incus list --format json` call + extract helpers
// as GET /containers.
lxcRouter.get('/containers/with-ip', async (req, res) => {
  try {
    const result = await execOnHost('incus list --format json');
    const all = JSON.parse(result.stdout || '[]');
    const containers = all
      .filter((c) => c.name.startsWith(INSTANCE_PREFIX))
      .map((c) => ({
        name: c.name.replace(new RegExp(`^${INSTANCE_PREFIX}`), ''),
        status: c.status.toLowerCase(),
        type: c.type || 'container',
        ipv4: extractIPv4(c),
        ipv6: extractIPv6(c),
      }));
    res.json({ containers });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list containers',
      details: error.stderr || error.message,
    });
  }
});

// GET /images - List available images.
//
// We augment each row with a `supports` array — one of:
//   ['container']
//   ['virtual-machine']
//   ['container', 'virtual-machine']  (rare; older / multi-arch
//                                      distro images that incus
//                                      reports both for)
//
// The frontend's create wizard uses this to filter the image
// dropdown by the operator's selected instance type (Step 6). Modern
// Incus reports a single `type` value per image row; we also check
// `properties.type` since some remote registries put it there
// instead. If neither field is set we conservatively report
// container — that matches the historical behaviour where
// everything was a CT.
lxcRouter.get('/images', async (req, res) => {
  try {
    const result = await execOnHost('incus image list --format json 2>/dev/null');
    const raw = JSON.parse(result.stdout);
    const images = Array.isArray(raw) ? raw.map((img) => {
      const supports = deriveImageSupports(img);
      return { ...img, supports };
    }) : raw;
    res.json({ success: true, images });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to list images',
      details: error.stderr || error.message,
    });
  }
});

// Derive the `supports: string[]` array for one `incus image list`
// row. Reads `image.type` and `image.properties.type`; collapses
// 'virtual_machine' / 'vm' aliases to the canonical
// 'virtual-machine' string the rest of the codebase uses. Unknown
// values default to 'container' so the wizard never hides a row by
// mistake.
export function deriveImageSupports(img) {
  const claimed = new Set();
  const candidates = [img?.type, img?.properties?.type];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const v = c.toLowerCase().trim();
    if (v === 'virtual-machine' || v === 'virtual_machine' || v === 'vm') {
      claimed.add('virtual-machine');
    } else if (v === 'container' || v === 'ct' || v === 'lxc') {
      claimed.add('container');
    }
  }
  if (claimed.size === 0) return ['container'];
  return Array.from(claimed);
}

// GET /containers/snapshot-export-queue — global view of every
// snapshot export currently running OR queued.  Drives the
// admin-wide banner so an operator on any page sees the in-flight
// upload (with a progress percentage) instead of needing to
// navigate back to the LXC tab.  Registered BEFORE
// /containers/:name so Express's first-match-wins ordering
// doesn't route 'snapshot-export-queue' into the per-container
// info handler (which would 404 on incus info — the bug an
// operator reported in the May 2026 review pass).
lxcRouter.get('/containers/snapshot-export-queue', (req, res) => {
  try {
    res.json({ success: true, ...getSnapshotExportQueueStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || 'queue status failed' });
  }
});

// GET /containers/:name - Get detailed info for a container
lxcRouter.get('/containers/:name', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus info ${incusName} --format json 2>/dev/null`);
    const info = JSON.parse(result.stdout);
    res.json({ success: true, container: info });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: `Container '${name}' not found`,
      details: error.stderr || error.message,
    });
  }
});

// GET /containers/:name/state - Get live resource state
lxcRouter.get('/containers/:name/state', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`);
    const containers = JSON.parse(result.stdout);

    if (!containers.length) {
      return res.status(404).json({
        success: false,
        error: `Container '${name}' not found`,
      });
    }

    const container = containers[0];
    res.json({
      success: true,
      state: {
        cpu: container.state?.cpu,
        memory: container.state?.memory,
        disk: container.state?.disk,
        network: container.state?.network,
        processes: container.state?.processes,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get container state',
      details: error.stderr || error.message,
    });
  }
});

// GET /containers/:name/snapshots - List snapshots for a container.
//
// Merges incus's local snapshot list with `lxc_snapshot_s3_exports`
// rows so a snapshot whose local copy was deleted but still lives
// in S3 stays visible (operator can pull it back).  Each row
// carries `has_local` (true when incus reports it on the pool)
// plus an `s3_locations` array listing every destination the
// snapshot is currently stored on.
lxcRouter.get('/containers/:name/snapshots', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;
  let local = [];
  let localFetchFailed = false;
  let localFetchDetails = null;
  try {
    const result = await execOnHost(`incus snapshot list ${incusName} --format json 2>/dev/null`);
    local = JSON.parse(result.stdout || '[]');
  } catch (error) {
    if (error.stderr?.includes('No snapshots')) {
      local = [];
    } else {
      localFetchFailed = true;
      localFetchDetails = error.stderr || error.message;
    }
  }

  // Best-effort per-snapshot disk usage enrichment.
  if (local.length) {
    try {
      const infoResult = await execOnHost(`incus query /1.0/instances/${incusName}?recursion=1 2>/dev/null`, { timeout: 5000 });
      const instance = JSON.parse(infoResult.stdout || '{}');
      const pool = instance?.expanded_devices?.root?.pool || instance?.devices?.root?.pool;
      if (pool) {
        await Promise.all(local.map(async (snap) => {
          const used = await readVolumeUsedBytes(pool, `container/${incusName}/snapshots/${snap.name}`);
          if (used != null) snap.size = used;
        }));
      }
    } catch {
      // Couldn't even resolve the instance pool — skip enrichment.
    }
  }

  // Pull every export row for this container and group by snapshot name.
  let exportRows = [];
  try {
    exportRows = listSnapshotExports({ containerName: name });
  } catch {
    // Junction table missing or unreadable — UI degrades to local-only.
  }
  const exportsBySnap = new Map();
  for (const r of exportRows) {
    if (!exportsBySnap.has(r.snapshot_name)) exportsBySnap.set(r.snapshot_name, []);
    exportsBySnap.get(r.snapshot_name).push(r);
  }

  const toS3Locations = (rows) => rows
    // Hide rows that have no S3 presence (already deleted).  Pending
    // and failed rows stay so the chip + retry / dismiss UI keeps
    // working.
    .filter((r) => r.status !== 'deleted')
    .map((r) => ({
      export_id: r.id,
      destination_id: r.destination_id,
      destination_name: r.destination_name || null,
      destination_bucket: r.destination_bucket || null,
      s3_key: r.s3_key,
      status: r.status,
      error: r.error || null,
      bytes_uploaded: r.bytes_uploaded || 0,
      bytes_total: r.bytes_total || null,
      cancel_requested: !!r.cancel_requested,
      started_at: r.started_at,
      finished_at: r.finished_at || null,
      size_bytes: r.size_bytes || null,
    }));

  const merged = local.map((snap) => ({
    ...snap,
    has_local: true,
    s3_locations: toS3Locations(exportsBySnap.get(snap.name) || []),
  }));
  // Ghost snapshots: present in S3 but not on the local pool.
  const localNames = new Set(local.map((s) => s.name));
  for (const [snapName, rows] of exportsBySnap) {
    if (localNames.has(snapName)) continue;
    const s3 = toS3Locations(rows);
    if (s3.length === 0) continue;
    // Use the earliest export's started_at as a stand-in for
    // 'created_at' so the UI's date column renders something sane.
    const earliest = rows.reduce((acc, r) => (
      !acc || (r.started_at && r.started_at < acc) ? r.started_at : acc
    ), null);
    merged.push({
      name: snapName,
      has_local: false,
      created_at: earliest,
      s3_locations: s3,
    });
  }

  if (localFetchFailed && merged.length === 0) {
    return res.status(500).json({
      success: false,
      error: 'Failed to list snapshots',
      details: localFetchDetails,
    });
  }
  res.json({ success: true, snapshots: merged });
});

// POST /containers - Start async container creation
// shellSingleQuote is imported from ../lib/shell-quote.js. New
// VM-specific argv additions go through it rather than the legacy
// JSON.stringify pattern in this file (see SECURITY.md
// "shell quoting"). Don't retrofit existing JSON.stringify call
// sites — it's out of scope for the VM session and the brief
// explicitly says so.
lxcRouter.post('/containers', async (req, res) => {
  const { name, image, profile, domain, port, cpu, memory, initScript, dockerSupport, dockerPrivileged, services: rawServices } = req.body;
  // Instance kind. Defaults to 'container' to keep existing callers
  // (older frontend builds, scripted creates) working without a
  // schema bump. Validated as a strict enum here so the value can
  // never reach the launchCmd assembly as anything other than one of
  // these two literals.
  const rawType = req.body?.type;
  const type = rawType === undefined || rawType === null ? 'container' : rawType;
  if (type !== 'container' && type !== 'virtual-machine') {
    return res.status(400).json({
      success: false,
      error: "Invalid type. Must be 'container' or 'virtual-machine'.",
    });
  }
  const isVm = type === 'virtual-machine';

  // Docker-in-LXC syscall intercepts apply to LXCs only. Letting an
  // operator submit dockerSupport=true with type=virtual-machine would
  // either crash incus (--config security.syscalls.intercept.* on a VM
  // is rejected by the daemon) or, worse, silently get ignored. Refuse
  // up front so the operator gets a clear error.
  if (isVm && (dockerSupport === true || dockerPrivileged === true)) {
    return res.status(400).json({
      success: false,
      error: 'Docker-in-LXC syscall intercepts cannot be applied to a virtual machine.',
    });
  }

  // Normalize services: support both new multi-service array and legacy single domain/port.
  // healthPath is optional; bad input is dropped silently here (the create
  // flow runs async and can't return a 400 from this branch) — the
  // dedicated POST /services endpoint validates strictly.
  const services = Array.isArray(rawServices) && rawServices.length > 0
    ? rawServices.filter(s => s.domain && typeof s.domain === 'string' && s.domain.trim()).map(s => {
        const hp = validateHealthPath(s.healthPath);
        return {
          domain: s.domain.trim(),
          port: parseInt(s.port, 10) || 80,
          obtainCert: s.obtainCert !== false,
          healthPath: hp.ok ? hp.value : null,
        };
      })
    : (domain && port ? [{ domain, port: parseInt(port, 10), obtainCert: true, healthPath: null }] : []);

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed, and it must start with an alphanumeric character.',
    });
  }

  if (!image) {
    return res.status(400).json({
      success: false,
      error: 'Image is required (e.g., "ubuntu:24.04", "images:debian/12").',
    });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;

  // Check if container already exists
  try {
    await execOnHost(`incus info ${incusName} 2>/dev/null`);
    return res.status(409).json({
      success: false,
      error: `Container '${name}' already exists.`,
    });
  } catch {
    // Container doesn't exist — good
  }

  // Pre-flight image-type check for VMs. `incus launch` against a
  // CT-only image with `--vm` errors with a wall of stderr ("Failed
  // to fetch image: image is not a virtual-machine image" or similar
  // depending on remote / version) which the operator never sees
  // until they poll create-status. Fail fast here with a clean 400
  // when we can establish the image's type up front. We tolerate
  // lookup failures (timeouts, missing remote, etc.) — they fall
  // through to the launch path and the operator gets the underlying
  // error via create-status as before.
  if (isVm) {
    try {
      const probe = await execOnHost(
        `incus image info ${image} --format json 2>/dev/null`,
        { timeout: 5000 }
      );
      const meta = JSON.parse(probe.stdout || '{}');
      const supports = deriveImageSupports(meta);
      if (!supports.includes('virtual-machine')) {
        return res.status(400).json({
          success: false,
          error: `Image '${image}' is not bootable as a virtual machine.`,
        });
      }
    } catch {
      // Image lookup failed — could be a private remote / typo / no
      // network. Don't block: the launch will surface the underlying
      // error in stderr.
    }
  }

  // Check if a creation is already in progress for this name
  if (activeCreations.has(incusName)) {
    const existing = activeCreations.get(incusName);
    if (existing.phase !== 'ready' && existing.phase !== 'failed') {
      return res.status(409).json({
        success: false,
        error: `Container '${name}' creation is already in progress.`,
      });
    }
  }

  // Initialize creation tracking
  const creation = {
    phase: 'downloading',
    message: 'Downloading image...',
    startTime: Date.now(),
    name,
    incusName,
    image,
    type,
    services,
    domain: services.length > 0 ? services[0].domain : null,
    port: services.length > 0 ? services[0].port : null,
    cpu: cpu || null,
    memory: memory || null,
    error: null,
    ip: null,
    stderr: '',
  };
  activeCreations.set(incusName, creation);

  // Start the launch process asynchronously (no timeout — runs until done)
  const profileArg = profile ? `--profile ${profile}` : '--profile default';
  // Docker-in-LXC support. Without these flags `dockerd` can't mount
  // overlayfs (kernel denies overlay mounts inside an unprivileged
  // user namespace) and image pulls fail with `permission denied` on
  // /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/.
  //
  // The base set covers `docker pull` and most plain `docker run`:
  //   security.nesting=true              — allow nested containers
  //   syscalls.intercept.mknod=true      — let package post-installs mknod
  //   syscalls.intercept.setxattr=true   — overlay metadata
  //
  // The bpf intercepts cover BuildKit (the default `docker build`
  // backend in modern Docker) and packages with native postinstalls
  // (bcrypt, node-pty, sharp, etc.). Without them, npm's spawn() of
  // a postinstall hook from the overlay upper layer is denied by the
  // outer kernel's seccomp/user-ns policy:
  //   syscalls.intercept.bpf=true
  //   syscalls.intercept.bpf.devices=true
  //
  // dockerPrivileged is the "I need full Docker compatibility" escape
  // hatch: bundles three host-trust-loosening knobs that operators
  // hit one after another otherwise.
  //
  //   security.privileged=true
  //     Drops the LXC user-namespace map so containers run with host
  //     root capabilities. Required for some BuildKit syscalls
  //     (e.g. `spawn sh` with bcrypt-style native postinstalls).
  //
  //   raw.lxc='lxc.apparmor.profile=unconfined'
  //     Removes the AppArmor profile from the LXC. Without this,
  //     runc inside the LXC can't write /proc/sys/* values during
  //     container init — Docker images that touch sysctls (e.g. n8n
  //     setting net.ipv4.ip_unprivileged_port_start) fail with
  //     `open sysctl ... reopen fd N: permission denied`. Syscall
  //     intercepts and security.privileged are orthogonal to
  //     AppArmor and don't fix this on their own.
  //
  // We always pair these because operators who reach for "Privileged
  // Docker" universally also need the AppArmor knob — splitting them
  // into two checkboxes was a footgun that made every Docker image
  // touching sysctls fail until the operator manually edited the
  // LXC's raw.lxc.
  let dockerConfigArgs = '';
  if (dockerSupport === true) {
    dockerConfigArgs = ' --config security.nesting=true' +
      ' --config security.syscalls.intercept.mknod=true' +
      ' --config security.syscalls.intercept.setxattr=true' +
      ' --config security.syscalls.intercept.bpf=true' +
      ' --config security.syscalls.intercept.bpf.devices=true';
    if (dockerPrivileged === true) {
      dockerConfigArgs += ' --config security.privileged=true' +
        ` --config raw.lxc=${JSON.stringify('lxc.apparmor.profile=unconfined')}`;
    }
  }
  // VM flag — appended via a static literal, not interpolated user
  // input, so no shell-escape needed here. The legacy `image`,
  // `incusName`, and `profileArg` interpolations above are
  // pre-existing and out of scope per the brief.
  const vmFlag = isVm ? ' --vm' : '';
  const launchCmd = `incus launch ${image} ${incusName} ${profileArg}${dockerConfigArgs}${vmFlag}`;
  console.log(`[LXC] Starting async launch: ${launchCmd}`);

  const child = spawnOnHost(launchCmd);

  child.stderr.on('data', (data) => {
    creation.stderr += data.toString();
    const output = data.toString().toLowerCase();
    // Detect download progress from Incus output
    if (output.includes('retrieving') || output.includes('download') || output.includes('unpack')) {
      creation.phase = 'downloading';
      creation.message = 'Downloading image...';
    }
  });

  child.stdout.on('data', (data) => {
    console.log(`[LXC] Launch stdout: ${data.toString().trim()}`);
  });

  child.on('close', async (code) => {
    console.log(`[LXC] Launch process exited with code ${code}`);

    if (code !== 0) {
      creation.phase = 'failed';
      creation.error = creation.stderr.trim() || `Launch exited with code ${code}`;
      creation.message = creation.error;
      console.error(`[LXC] Launch failed: ${creation.error}`);
      // Clean up partial container
      try { await execOnHost(`incus delete ${incusName} --force 2>/dev/null || true`); } catch {}
      // Keep the creation record for 2 minutes so the frontend can read the error
      setTimeout(() => activeCreations.delete(incusName), 120000);
      return;
    }

    // Launch succeeded — configure the container
    try {
      creation.phase = 'configuring';
      creation.message = 'Configuring container...';

      // Ensure NAT is enabled on the bridge so containers have internet
      await ensureNetworkNat();

      // Set resource limits. VMs need a memory floor — Incus rejects
      // booting a VM without a limits.memory value on most stock
      // profiles — so default to 2GiB if the operator didn't pick
      // one. Containers keep the legacy "no implicit memory cap"
      // behaviour. Disk size for VMs goes through `incus config
      // device set <name> root size=...` because the root device
      // lives on the profile, not on `limits.*`. The shellSingleQuote
      // wrappers around the operator-supplied size strings are the
      // new-VM-code convention; legacy CT-side calls above use plain
      // template interpolation per the file's pre-existing pattern.
      if (cpu) {
        await execOnHost(`incus config set ${incusName} limits.cpu=${cpu}`);
      }
      if (memory) {
        await execOnHost(`incus config set ${incusName} limits.memory=${memory}MB`);
      } else if (isVm) {
        await execOnHost(`incus config set ${incusName} limits.memory=${shellSingleQuote('2GiB')}`);
      }
      if (isVm) {
        // Default 20GiB root disk if unset. Idempotent: setting the
        // same size twice is a no-op for incus. We DON'T resize down
        // automatically — that would discard data on a re-create.
        try {
          await execOnHost(
            `incus config device set ${incusName} root size=${shellSingleQuote('20GiB')}`
          );
        } catch (e) {
          // Some profiles don't carry a `root` device by name; in
          // that case incus emits "device 'root' doesn't exist" and
          // the operator can size the disk by hand later. Don't fail
          // the whole launch over a default that's purely advisory.
          console.warn('[LXC] VM default root size: ', e?.message || e);
        }
      }

      // Wait for IP address
      creation.phase = 'network';
      creation.message = 'Waiting for network...';

      let ip = null;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        try {
          const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
          const containers = JSON.parse(result.stdout || '[]');
          if (containers.length > 0) {
            ip = extractIPv4(containers[0]);
            if (ip) break;
          }
        } catch {}
      }
      creation.ip = ip;

      // Configure DNS with public resolvers
      await ensureDns(incusName);

      // Run init script if provided. We don't fail the whole
      // creation on a non-zero exit — the operator can finish setup
      // by hand — but we capture the exit code + the tail of output
      // and surface it on `creation.initScriptWarning` so the UI can
      // show "container ready, init script exited 100" instead of
      // silently producing an empty container.
      if (initScript && typeof initScript === 'string' && initScript.trim()) {
        creation.phase = 'init-script';
        creation.message = 'Running init script...';
        try {
          const scriptContent = initScript.trim();
          // Encode as base64 before piping into the container. The
          // previous `printf '%s' ${JSON.stringify(...)}` round-trip
          // emitted JSON-style escapes — `\n` arrived as literal
          // backslash-n on the container side, so the entire script
          // collapsed to a single line that began with `#!/bin/sh\n…`
          // and bash treated the whole thing as one comment. The
          // script "ran" with exit code 0 and no packages were ever
          // installed. base64 is shell-safe (only [A-Za-z0-9+/=]),
          // and `base64 -d` is in coreutils on every distro we ship
          // images for.
          const b64 = Buffer.from(scriptContent, 'utf8').toString('base64');
          await execOnHost(
            `echo '${b64}' | base64 -d | incus exec ${incusName} -- tee /tmp/pp-init.sh > /dev/null`,
            { timeout: 15000 }
          );
          await execOnHost(`incus exec ${incusName} -- chmod +x /tmp/pp-init.sh`, { timeout: 5000 });
          const initChild = spawnOnHost(`incus exec ${incusName} -- sh /tmp/pp-init.sh`);
          let stdoutBuf = '';
          let stderrBuf = '';
          const TAIL_BYTES = 4096;
          initChild.stdout?.on('data', (d) => {
            stdoutBuf = (stdoutBuf + d.toString()).slice(-TAIL_BYTES);
          });
          initChild.stderr?.on('data', (d) => {
            stderrBuf = (stderrBuf + d.toString()).slice(-TAIL_BYTES);
          });
          const result = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              try { initChild.kill(); } catch {}
              resolve({ code: null, killed: true });
            }, 300000);
            initChild.on('close', (code) => { clearTimeout(timeout); resolve({ code, killed: false }); });
            initChild.on('error', (err) => { clearTimeout(timeout); resolve({ code: null, killed: false, err: err.message }); });
          });
          await execOnHost(`incus exec ${incusName} -- rm -f /tmp/pp-init.sh`, { timeout: 5000 }).catch(() => {});

          if (result.killed) {
            creation.initScriptWarning = 'Init script timed out after 5 minutes — finish setup manually inside the container.';
            console.error(`[LXC] Init script for ${incusName} timed out`);
          } else if (result.code !== 0) {
            const tail = stderrBuf || stdoutBuf || '(no output captured)';
            creation.initScriptWarning = `Init script exited with code ${result.code}. Last output:\n${tail}`;
            console.error(`[LXC] Init script for ${incusName} exited ${result.code}: ${tail}`);
          } else {
            console.log(`[LXC] Init script completed cleanly for ${incusName}`);
          }
        } catch (initErr) {
          creation.initScriptWarning = `Init script setup failed: ${initErr.message}`;
          console.error(`[LXC] Init script failed: ${initErr.message}`);
        }
      }

      // Configure Caddy reverse proxy for all services
      if (services.length > 0 && ip) {
        creation.phase = 'caddy';
        creation.message = `Configuring reverse proxy for ${services.length} service${services.length > 1 ? 's' : ''}...`;

        for (const svc of services) {
          const tlsDirective = svc.obtainCert ? '' : '\n    tls internal';
          const healthMarker = svc.healthPath ? `# proxypilot: healthpath=${svc.healthPath}\n` : '';
          const caddyConfig = `${healthMarker}${svc.domain} {${tlsDirective}\n    reverse_proxy ${ip}:${svc.port}\n    encode gzip zstd\n    log {\n        output file /var/log/caddy/${svc.domain}.log\n    }\n}\n`;
          const configPath = join(CADDY_SITES_DIR, svc.domain);
          await writeFile(configPath, caddyConfig);
          console.log(`[LXC] Wrote Caddy config for ${svc.domain} -> ${ip}:${svc.port} (cert: ${svc.obtainCert})`);
        }

        try {
          await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
        } catch (reloadError) {
          console.error('[LXC] Caddy reload failed:', reloadError.stderr || reloadError.message);
        }
      }

      creation.phase = 'ready';
      creation.message = 'Container is ready';
      console.log(`[LXC] Container ${incusName} is ready (IP: ${ip || 'none'})`);

    } catch (err) {
      creation.phase = 'failed';
      creation.error = err.stderr || err.message || 'Post-launch configuration failed';
      creation.message = creation.error;
      console.error(`[LXC] Post-launch config failed: ${creation.error}`);
    }

    // Clean up creation tracking after 2 minutes
    setTimeout(() => activeCreations.delete(incusName), 120000);
  });

  child.on('error', (err) => {
    creation.phase = 'failed';
    creation.error = err.message;
    creation.message = err.message;
    console.error(`[LXC] Launch spawn error: ${err.message}`);
    setTimeout(() => activeCreations.delete(incusName), 120000);
  });

  // Return immediately — frontend will poll for progress
  res.status(202).json({
    success: true,
    message: 'Container creation started',
    name,
    incusName,
  });
});

// GET /containers/:name/create-status - Poll creation progress
lxcRouter.get('/containers/:name/create-status', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;
  const creation = activeCreations.get(incusName);

  // If we have an active creation record, use it
  if (creation) {
    return res.json({
      success: true,
      phase: creation.phase,
      message: creation.message,
      error: creation.error,
      ip: creation.ip,
      initScriptWarning: creation.initScriptWarning || null,
      elapsed: Math.round((Date.now() - creation.startTime) / 1000),
    });
  }

  // No active creation — check if container exists already (maybe from a previous creation)
  try {
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(result.stdout || '[]');
    if (containers.length > 0) {
      const ip = extractIPv4(containers[0]);
      return res.json({
        success: true,
        phase: 'ready',
        message: 'Container is ready',
        ip,
        elapsed: 0,
      });
    }
  } catch {}

  // Check if Incus has an active operation (e.g. image download in progress)
  try {
    const opsResult = await execOnHost('incus operation list --format json 2>/dev/null', { timeout: 5000 });
    const ops = JSON.parse(opsResult.stdout || '[]');
    const relevantOp = ops.find(op =>
      op.status === 'Running' &&
      (op.description?.toLowerCase().includes('download') ||
       op.description?.toLowerCase().includes('creating') ||
       op.description?.toLowerCase().includes('image'))
    );
    if (relevantOp) {
      return res.json({
        success: true,
        phase: 'downloading',
        message: relevantOp.description || 'Downloading image...',
        elapsed: 0,
      });
    }
  } catch {}

  res.json({
    success: true,
    phase: 'unknown',
    message: 'No active creation found for this container.',
    elapsed: 0,
  });
});

// Probe a `<ip>:<port>` pair from the host's network namespace using
// bash's /dev/tcp magic file. Resolves to true on a successful TCP
// handshake within `timeoutMs`, false otherwise (connection refused,
// timeout, host unreachable). Used to give the operator a signal in
// the Services UI when Caddy is configured correctly but the upstream
// isn't actually listening — the most common 502 cause once IP
// detection is fixed.
// Format the JSON body for a failed `incus snapshot {create|restore|delete}`
// call. execAsync's behavior on timeout is the failure mode that bites
// here: it sends SIGTERM, returns an Error with `killed=true` and
// usually-empty stderr/stdout (incus may not have flushed anything
// before SIGTERM). The previous templating fell through stderr →
// stdout → message and surfaced Node's generic "Command failed:
// nsenter ..." string with no actionable signal. Detect timeout
// explicitly and explain so the operator knows whether to bump the
// budget or look at incus.
function formatSnapshotError(prefix, error, timeoutMs) {
  // execAsync timeout: error.killed=true, error.signal='SIGTERM'.
  // error.code is the spawn-side numeric on timeout; for an actual
  // non-zero exit it's the exit code (a number). The combination of
  // killed + signal is reliable.
  const isTimeout = error && (error.killed === true || error.signal === 'SIGTERM' || error.signal === 'SIGKILL');
  const stderr = (error.stderr || '').trim();
  const stdout = (error.stdout || '').trim();
  const incusOutput = stderr || stdout;
  let message;
  if (isTimeout && !incusOutput) {
    const seconds = Math.round((timeoutMs || 0) / 1000);
    message = `${prefix}: timed out after ${seconds}s. Snapshots of running Docker-in-LXC containers can take several minutes; check 'incus operation list' on the host to see if it's still in progress, or try again with the container stopped.`;
  } else if (incusOutput) {
    message = `${prefix}: ${incusOutput}`;
  } else {
    message = `${prefix}: ${error.message || 'unknown error'} (exit code: ${error.code ?? 'n/a'})`;
  }
  return {
    success: false,
    error: message,
    details: incusOutput || error.message,
    timedOut: !!isTimeout,
  };
}

// Read actual disk usage (bytes) for a storage volume. Used by the
// snapshot-list enrichment and the export-info endpoints. The
// /state endpoint is the only API that returns true used bytes
// across storage backends (ZFS, btrfs, LVM-thin, dir, ceph) — the
// volume-show config returns *quotas*, not usage.
//
// `volumePath` is everything after `/volumes/` — for example
// `container/pp-dev` for the live container or
// `container/pp-dev/snapshots/Test2` for a snapshot.
//
// Returns the used bytes as an integer or null when the lookup
// failed (older incus, backend without per-volume accounting, etc).
async function readVolumeUsedBytes(pool, volumePath) {
  if (!pool || !volumePath) return null;
  try {
    const r = await execOnHost(
      `incus query /1.0/storage-pools/${pool}/volumes/${volumePath}/state 2>/dev/null`,
      { timeout: 5000 }
    );
    const state = JSON.parse(r.stdout || '{}');
    const used = state?.usage?.used ?? state?.used ?? null;
    if (typeof used === 'number' && used > 0) return used;
    if (typeof used === 'string' && /^\d+$/.test(used)) return parseInt(used, 10);
    return null;
  } catch {
    return null;
  }
}

// Resolve the storage pool a container's root device lives on.
// Returns the pool name or null on any failure. Cached at the call
// site for the duration of a request.
async function resolveContainerPool(incusName) {
  try {
    const r = await execOnHost(`incus query /1.0/instances/${incusName}?recursion=1 2>/dev/null`, { timeout: 5000 });
    const instance = JSON.parse(r.stdout || '{}');
    return instance?.expanded_devices?.root?.pool || instance?.devices?.root?.pool || null;
  } catch {
    return null;
  }
}

async function probeTcp(ip, port, timeoutMs = 2000) {
  if (!ip || !port) return false;
  // Bash's /dev/tcp uses a non-blocking connect under the hood; wrap
  // in `timeout` so a black-holed host doesn't pin the request. exit
  // 0 on success, non-zero on any failure mode.
  const cmd = `timeout ${Math.max(1, Math.ceil(timeoutMs / 1000))} bash -c 'exec 3<>/dev/tcp/${ip}/${port}' 2>/dev/null && echo OK || echo FAIL`;
  try {
    const r = await execOnHost(cmd, { timeout: timeoutMs + 1000 });
    return (r.stdout || '').trim() === 'OK';
  } catch {
    return false;
  }
}

// healthPath validation: must start with `/`, length-capped, restricted
// to URL-safe path/query characters. Same set used by the schema check
// in POST/PUT and by the GET parser when it recovers the value from
// the persisted comment line.
const HEALTH_PATH_REGEX = /^\/[A-Za-z0-9._~\-/?=&%]*$/;
const HEALTH_PATH_MAX = 256;
function validateHealthPath(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'healthPath must be a string.' };
  if (value.length > HEALTH_PATH_MAX) return { ok: false, error: `healthPath exceeds ${HEALTH_PATH_MAX} characters.` };
  if (!HEALTH_PATH_REGEX.test(value)) {
    return { ok: false, error: 'healthPath must start with / and contain only URL-safe characters.' };
  }
  return { ok: true, value };
}

// HTTP-level upstream health probe. Layered on top of the TCP probe so
// the UI can distinguish "TCP accepts but the app errors out" (the
// nginx-fronts-broken-Express case operators have hit) from "TCP
// refused / timed out" (kernel-level reachability failure).
//
// HEAD with explicit Host so name-based vhosts route correctly. Up to
// one redirect followed inside the timeout budget — past that we report
// the redirect status and let the operator fix the loop. Any 2xx is
// healthy. Implementation uses Node's built-in `http`; no extra deps
// per the PR scope.
function probeHttp(ip, port, host, path, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!ip || !port || !path) {
      resolve({ healthy: false, status: null, error: 'missing target' });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const doRequest = (target, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch (e) {
        finish({ healthy: false, status: null, error: 'invalid url' });
        return;
      }
      const req = http.request({
        host: parsed.hostname,
        port: parsed.port || 80,
        method: 'HEAD',
        path: (parsed.pathname || '/') + (parsed.search || ''),
        headers: { Host: host, 'User-Agent': 'ProxyPilot-HealthCheck/1.0', Accept: '*/*' },
        timeout: timeoutMs,
      }, (resp) => {
        const status = resp.statusCode || 0;
        // Redirect: follow once, but only to plaintext http on the same
        // host:port — anything else is the operator's TLS/host setup,
        // not a health signal we can usefully chase.
        const isRedirect = [301, 302, 303, 307, 308].includes(status);
        if (isRedirect && redirectsLeft > 0 && resp.headers.location) {
          resp.resume();
          let next;
          try { next = new URL(resp.headers.location, target).toString(); }
          catch { return finish({ healthy: false, status, error: 'bad redirect target' }); }
          return doRequest(next, redirectsLeft - 1);
        }
        resp.resume();
        finish({
          healthy: status >= 200 && status < 300,
          status,
          error: null,
        });
      });
      req.on('error', (err) => finish({ healthy: false, status: null, error: err.code || err.message || 'request error' }));
      req.on('timeout', () => { req.destroy(); finish({ healthy: false, status: null, error: 'timeout' }); });
      req.end();
    };
    doRequest(`http://${ip}:${port}${path}`, 1);
  });
}

// Enumerate TCP ports that are actually in LISTEN state inside the
// container. Reads /proc/net/tcp{,6} directly rather than shelling
// out to `ss` — minimal LXC images sometimes lack iproute2, and the
// procfs entries are always present and have a stable format.
//
// /proc/net/tcp row:
//   sl  local_address rem_address   st  ...
//    0: 0100007F:1538 00000000:0000 0A  ...
//
// local_address is `<ip-hex>:<port-hex>`. The IPv4 hex is little-
// endian per byte (0100007F → 7F.00.00.01 → 127.0.0.1). The port
// hex is big-endian. State 0A = TCP_LISTEN.
async function listListeningPorts(incusName) {
  const inner = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null';
  const cmd = `incus exec ${incusName} -- sh -c ${JSON.stringify(inner)}`;
  let stdout = '';
  let stderr = '';
  try {
    const r = await execOnHost(cmd, { timeout: 5000 });
    stdout = r.stdout || '';
    stderr = r.stderr || '';
  } catch (e) {
    return { reachable: [], loopbackOnly: [], error: (e.stderr || e.message || '').trim() || 'introspect failed' };
  }
  const anyHost = new Set();
  const loopbackOnly = new Set();
  const lines = stdout.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('sl')) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1];
    const state = cols[3];
    if (state !== '0A') continue;
    const colonIdx = local.lastIndexOf(':');
    if (colonIdx < 0) continue;
    const ipHex = local.slice(0, colonIdx);
    const portHex = local.slice(colonIdx + 1);
    const port = parseInt(portHex, 16);
    if (!port) continue;

    let isLoopback = false;
    let isAnyAddr = false;
    if (ipHex.length === 8) {
      // IPv4: little-endian per byte.
      const b0 = parseInt(ipHex.slice(0, 2), 16);
      const b1 = parseInt(ipHex.slice(2, 4), 16);
      const b2 = parseInt(ipHex.slice(4, 6), 16);
      const b3 = parseInt(ipHex.slice(6, 8), 16);
      const ip = `${b3}.${b2}.${b1}.${b0}`;
      if (ip === '0.0.0.0') isAnyAddr = true;
      else if (b3 === 127) isLoopback = true;
    } else if (ipHex.length === 32) {
      // IPv6 in /proc/net/tcp6 is little-endian per 4-byte word.
      // Easiest reliable signals: all zeros = `::`, the `::1` pattern
      // when normalized, and IPv4-mapped (last 32 bits is the v4 address
      // and the preceding 16 bits are 0xFFFF).
      const upper = ipHex.toUpperCase();
      if (upper === '00000000000000000000000000000000') {
        isAnyAddr = true;
      } else if (upper === '00000000000000000000000001000000') {
        isLoopback = true;
      } else if (upper.slice(16, 24) === '0000FFFF') {
        // IPv4-mapped: last 8 hex chars are the v4 address (same
        // little-endian-per-byte encoding as the v4 table).
        const v4hex = upper.slice(24, 32);
        const b0 = parseInt(v4hex.slice(0, 2), 16);
        const b3 = parseInt(v4hex.slice(6, 8), 16);
        if (b0 === 0 && b3 === 0) isAnyAddr = true;
        else if (b3 === 127) isLoopback = true;
      }
      // Other v6 binds (link-local, ULA, GUA) — treat as reachable.
    }
    if (isLoopback) loopbackOnly.add(port);
    else anyHost.add(port); // 0.0.0.0/:: or any specific interface
  }
  for (const p of anyHost) loopbackOnly.delete(p);
  return {
    reachable: [...anyHost].sort((a, b) => a - b),
    loopbackOnly: [...loopbackOnly].sort((a, b) => a - b),
    error: stderr && !stdout ? stderr.trim() : null,
  };
}

// GET /containers/:name/listening-ports — TCP + UDP listeners
// inside the LXC. Backs the LXC detail panel's "exposed ports"
// chip row + the port-input datalist so an operator picking a
// service port can see what's actually listening rather than
// guessing.
//
// Reuses the Phase 2c port-detector library (range collapse +
// proc/net parser) so the data shape matches the service-detail
// panel's chip row. Always-call: cheap enough to run on every
// dialog open since /proc/net is a few KB and there's no
// docker-compose health gate at this layer (this endpoint is
// container-scoped, not service-scoped).
lxcRouter.get('/containers/:name/listening-ports', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const { detectServicePorts } = await import('../lib/port-detector.js');
    // No db / serviceId — we don't want to write into
    // service_detected_ports from a container-scoped probe; the
    // service-detail panel owns that cache. composeOpts is empty
    // so the compose health gate stays opt-in.
    const result = await detectServicePorts({
      incusName,
      execHost: execOnHost,
    });
    const tcp = result.ports
      .filter((p) => p.proto === 'tcp')
      .map((p) => ({ port: p.port, portEnd: p.port_end ?? null }));
    const udp = result.ports
      .filter((p) => p.proto === 'udp')
      .map((p) => ({ port: p.port, portEnd: p.port_end ?? null }));
    res.json({
      success: true,
      tcp,
      udp,
      loopbackOnly: result.loopbackOnly,
      scanError: result.scanError,
      scannedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: `Failed to read listening ports: ${(e.stderr || e.message || '').trim()}`,
    });
  }
});

// GET /containers/:name/services - List Caddy services for this container (by IP)
lxcRouter.get('/containers/:name/services', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    // Get container IP
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(result.stdout || '[]');
    if (containers.length === 0) {
      return res.status(404).json({ success: false, error: 'Container not found.' });
    }
    const ip = extractIPv4(containers[0]);
    if (!ip) {
      return res.json({ success: true, services: [], ip: null });
    }

    // Two sources to merge:
    //   1. Legacy single-domain Caddy site files in CADDY_SITES_DIR.
    //      One file = one service entry. No path-prefix support.
    //   2. Phase 2c routes table — each route is a (domain, path,
    //      port) tuple owned by the LXC's per-LXC service row.
    //      Same domain can repeat with different paths (the MEET
    //      fan-out case).
    //
    // We tag each entry with `source: 'file' | 'db'` so the
    // frontend can route edits / deletes back to the right pipeline.
    const services = [];

    // Pull routes from the DB FIRST so the file-scan can dedupe
    // against the set of domains already managed by the routes
    // pipeline. We key on lxc_container_name (the LXC quick-add
    // owns one service per LXC) so a different dashboard-managed
    // service that happens to point at the same IP doesn't bleed
    // into this list.
    const dbDomains = new Set();
    try {
      const db = getDb();
      const dbRoutes = db
        .prepare(
          `SELECT r.id AS route_id, r.domain, r.path_prefix, r.target_port,
                  r.ssl_enabled, r.websocket_enabled, r.strip_prefix,
                  r.allow_framing, r.frame_ancestors,
                  s.id AS service_id, s.target_ip
             FROM service_http_routes r
             JOIN services s ON r.service_id = s.id
            WHERE s.lxc_container_name = ?
            ORDER BY r.domain, length(r.path_prefix) DESC`
        )
        .all(name);
      for (const r of dbRoutes) {
        dbDomains.add(r.domain);
        services.push({
          id: r.route_id,
          serviceId: r.service_id,
          domain: r.domain,
          pathPrefix: r.path_prefix,
          port: r.target_port,
          upstreamIp: r.target_ip || ip,
          obtainCert: !!r.ssl_enabled,
          websocketEnabled: !!r.websocket_enabled,
          stripPrefix: !!r.strip_prefix,
          allowFraming: !!r.allow_framing,
          frameAncestors: r.frame_ancestors ?? null,
          healthPath: null,
          source: 'db',
        });
      }
    } catch (e) {
      console.warn('[LXC] DB routes fetch failed:', e?.message || e);
    }

    // Now scan the per-domain Caddy files. Skip any file whose
    // domain is already covered by the routes table — a merged
    // multi-route Caddyfile (written by the routes pipeline)
    // contains multiple `reverse_proxy` lines, and the regex below
    // grabs only the FIRST, which would surface a phantom legacy
    // entry pointing at whichever upstream happens to sort first.
    // The routes-table view is authoritative for any domain it
    // owns; only legacy single-route domains belong in the file
    // scan.
    try {
      const files = await readdir(CADDY_SITES_DIR);
      for (const file of files) {
        const filePath = join(CADDY_SITES_DIR, file);
        const content = await readFile(filePath, 'utf-8');
        if (!content.includes(ip)) continue;
        const domainMatch = content.match(/^(\S+)\s*\{/m);
        if (!domainMatch) continue;
        // Strip optional `http://` / `https://` prefix from the site
        // address so the dedupe set lookup matches the bare domain
        // the routes table stores.
        const fileDomain = domainMatch[1].replace(/^https?:\/\//, '');
        if (dbDomains.has(fileDomain)) continue;
        const upstreamMatch = content.match(/reverse_proxy\s+([\d.]+):(\d+)/);
        const hasTlsInternal = content.includes('tls internal');
        const healthMatch = content.match(/^#\s*proxypilot:\s*healthpath=(\S+)/m);
        const healthPath = healthMatch
          ? (validateHealthPath(healthMatch[1]).ok ? healthMatch[1] : null)
          : null;
        services.push({
          domain: fileDomain,
          pathPrefix: '/',
          port: upstreamMatch ? parseInt(upstreamMatch[2], 10) : null,
          upstreamIp: upstreamMatch ? upstreamMatch[1] : null,
          obtainCert: !hasTlsInternal,
          healthPath,
          source: 'file',
        });
      }
    } catch {
      // CADDY_SITES_DIR may not exist yet
    }

    // Probe each upstream in parallel so a slow/unreachable host doesn't
    // block the whole list. 2s is enough to distinguish "refused" from
    // "no route" for typical LXC deployments. When the operator
    // configured a healthPath, layer an HTTP HEAD probe on top so the
    // UI can flag "TCP up, app errors" — the case the d519580 TCP
    // probe is blind to.
    await Promise.all(
      services.map(async (svc) => {
        if (!svc.port) {
          svc.reachable = null;
          svc.httpHealthy = null;
          svc.httpStatus = null;
          svc.httpError = null;
          return;
        }
        svc.reachable = await probeTcp(ip, svc.port, 2000);
        svc.staleIp = svc.upstreamIp && svc.upstreamIp !== ip;
        if (svc.reachable && svc.healthPath) {
          const result = await probeHttp(ip, svc.port, svc.domain, svc.healthPath, 2000);
          svc.httpHealthy = result.healthy;
          svc.httpStatus = result.status;
          svc.httpError = result.error;
        } else {
          svc.httpHealthy = null;
          svc.httpStatus = null;
          svc.httpError = null;
        }
      }),
    );

    // If any service failed the probe, ask the container what is
    // actually listening so the UI can render an actionable tooltip
    // ("nothing on :3000 — these ports are open: 22, 80") instead of
    // a generic 502. One ss call per refresh is cheap; skip it when
    // every probe succeeded.
    const anyUnreachable = services.some((s) => s.reachable === false);
    let listening = null;
    if (anyUnreachable) {
      listening = await listListeningPorts(incusName);
      for (const svc of services) {
        if (svc.reachable !== false || !svc.port) continue;
        svc.boundLoopbackOnly = listening.loopbackOnly.includes(svc.port);
      }
    }

    res.json({ success: true, services, ip, listening });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to get services: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// Normalize an operator-supplied path prefix into the bare form
// the merged-config renderer expects. The renderer appends `*`
// itself when emitting `handle ${pathPrefix}*`, so any operator
// who types `/api/*` (the conventional Caddy glob) needs to get
// silently rewritten to `/api` — otherwise we end up with
// `handle /api/**`, which is a literal-string matcher that never
// matches a real request, and the catch-all wins.
//
// Returns null when the input contains characters our path scheme
// can't represent (anything outside [A-Za-z0-9._-/]). Wildcards
// (`*`) only valid as a trailing `/*` suffix, which we strip here.
function normalizeLxcPathPrefix(value) {
  if (value === undefined || value === null) return '/';
  let p = String(value).trim();
  if (p === '') return '/';
  if (!p.startsWith('/')) p = '/' + p;
  // Strip a trailing /* (the conventional Caddy glob) and any
  // bare trailing slashes, in either order: `/api/`, `/api/*`,
  // `/api/*/`, all collapse to `/api`.
  p = p.replace(/\/+\*+\/*$/, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (p === '') p = '/';
  if (!/^\/[A-Za-z0-9._\-/]*$/.test(p)) return null;
  return p;
}

// Find-or-create the per-LXC `services` row that owns every route
// the LXC quick-add form inserts. One service per LXC is the right
// granularity here: the LXC is the workload boundary, and a fan-out
// app (MEET-style) wants every path under one logical service so the
// service-detail panel can configure WS / strip-prefix / L4 forwards
// for the whole stack at once.
//
// `name` is the operator-facing LXC name (no `pp-` prefix); we store
// it verbatim in `lxc_container_name` to match the convention every
// other endpoint uses.
function findOrCreateLxcService(db, name, ip) {
  const existing = db
    .prepare(`SELECT * FROM services WHERE lxc_container_name = ? AND is_admin = 0 LIMIT 1`)
    .get(name);
  if (existing) {
    // Update the cached IP if it has drifted — same logic the
    // refresh-ip endpoint applies, but inline so the operator
    // doesn't have to click a separate button after a container
    // restart. Only writes when actually changed so updated_at
    // doesn't churn on every quick-add.
    if (ip && existing.target_ip !== ip) {
      db.prepare(
        `UPDATE services SET target_ip = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(ip, existing.id);
      existing.target_ip = ip;
    }
    return existing;
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO services
       (id, name, kind, runtime, target_ip, lxc_container_name, type, status)
     VALUES (?, ?, 'container_service', 'lxc', ?, ?, 'docker', 'active')`
  ).run(id, name, ip, name);
  return db.prepare(`SELECT * FROM services WHERE id = ?`).get(id);
}

// MEET reference layout. Source: deploy/external-proxy/caddy/single-domain.Caddyfile
// in the MEET repo. The fan-out is canonical — frontend on 3000,
// API on 8080 (also serves /ws), LiveKit signaling on 7880, plus
// L4 forwards for the LiveKit RTC TCP fallback (7881) and the
// WebRTC media UDP range (50000-60000). Operators occasionally
// invent variations; this preset only handles the canonical one.
const MEET_PRESET = {
  // Path prefixes are stored bare (no trailing /*). The merged-config
  // renderer in services.js's buildDomainCaddyConfig() appends `*`
  // when it emits `handle ${pathPrefix}*`, so storing `/api/*` here
  // would produce `handle /api/**` — a literal match for a URL that
  // never occurs, which makes /api requests fall through to the
  // catch-all root route.
  // allowFraming on the root catch-all flips the whole site's
  // header block to emit `-X-Frame-Options` + a frame-ancestors CSP
  // (default '*'). The renderer reads "any route on the domain has
  // allow_framing=1" and applies it site-wide, so flagging just the
  // root is enough — putting the flag on every row would be
  // redundant. MEET's meeting page is iframe-embeddable by design,
  // and the default X-Frame-Options: SAMEORIGIN breaks any embed.
  routes: [
    { pathPrefix: '/livekit', port: 7880, stripPrefix: true,  websocketEnabled: true,  allowFraming: false },
    { pathPrefix: '/api',     port: 8080, stripPrefix: false, websocketEnabled: false, allowFraming: false },
    { pathPrefix: '/ws',      port: 8080, stripPrefix: false, websocketEnabled: true,  allowFraming: false },
    { pathPrefix: '/',        port: 3000, stripPrefix: false, websocketEnabled: false, allowFraming: true  },
  ],
  l4Forwards: [
    { proto: 'tcp', listenPort: 7881, listenPortEnd: null,  connectPort: 7881, connectPortEnd: null,  description: 'LiveKit RTC TCP fallback' },
    { proto: 'udp', listenPort: 50000, listenPortEnd: 60000, connectPort: 50000, connectPortEnd: 60000, description: 'WebRTC media' },
  ],
  // The TCP ports we expect to see listening before we'll accept
  // the preset. UDP isn't checked — LiveKit allocates the WebRTC
  // range on-demand when a call starts, so it's normal for the
  // 50000-60000 sockets to be absent at install time.
  requiredTcpPorts: [3000, 7880, 7881, 8080],
};

// POST /containers/:name/quick-add/meet - One-shot MEET single-domain
// install. Operator supplies a domain; we add 4 HTTP routes and 2 L4
// forwards in one transaction with one Caddy reload at the end.
//
// Refuses to overwrite — if any of the (domain, path) tuples already
// exist or any L4 listen port is taken, the whole call rolls back so
// the operator doesn't end up half-configured.
lxcRouter.post('/containers/:name/quick-add/meet', async (req, res) => {
  const { name } = req.params;
  const { domain } = req.body || {};

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  if (!domain || typeof domain !== 'string' || !domain.trim()) {
    return res.status(400).json({ success: false, error: 'Domain is required.' });
  }
  const cleanDomain = domain.trim();

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(result.stdout || '[]');
    if (containers.length === 0) {
      return res.status(404).json({ success: false, error: 'Container not found.' });
    }
    const ip = extractIPv4(containers[0]);
    if (!ip) {
      return res.status(400).json({ success: false, error: 'Container has no IP address. Is it running?' });
    }

    try { await ensureCaddyStructure(); } catch (e) {
      console.error('[LXC] ensureCaddyStructure failed:', e?.message || e);
    }

    const db = getDb();

    // Pre-flight: build a per-route / per-forward plan so re-running
    // Quick Add MEET against a partially-installed LXC is idempotent.
    //
    //   action: 'insert' — row absent, will be created
    //   action: 'skip'   — row exists and matches the preset exactly
    //   action: 'reject' — row exists but disagrees with the preset
    //
    // The reject branch surfaces the specific mismatch so the operator
    // knows which manual edit will let the re-install through.
    //
    // The route check tolerates an existing row whose path_prefix has
    // a trailing /* — that's the broken shape the v1 Quick Add wrote
    // and migration 103 normalizes on next boot. Treat both forms as
    // matching the canonical bare prefix so an operator on an
    // un-migrated DB can still re-install.
    const stripGlob = (s) => String(s || '').replace(/\/+\*+\/*$/, '') || '/';
    const routePlan = MEET_PRESET.routes.map((r) => {
      const exact = db
        .prepare(`SELECT * FROM service_http_routes WHERE domain = ? AND path_prefix = ? LIMIT 1`)
        .get(cleanDomain, r.pathPrefix);
      const globbed = exact || db
        .prepare(`SELECT * FROM service_http_routes WHERE domain = ? AND path_prefix = ? LIMIT 1`)
        .get(cleanDomain, `${r.pathPrefix}/*`);
      const existing = exact || globbed;
      if (!existing) return { route: r, action: 'insert' };
      const expectFraming = !!r.allowFraming;
      const haveFraming = !!existing.allow_framing;
      const matches =
        existing.target_port === r.port &&
        !!existing.strip_prefix === r.stripPrefix &&
        !!existing.websocket_enabled === r.websocketEnabled &&
        haveFraming === expectFraming;
      if (matches) return { route: r, action: 'skip', existingId: existing.id, normalize: !exact };
      return {
        route: r,
        action: 'reject',
        reason: `${cleanDomain}${r.pathPrefix} already exists with port=${existing.target_port} strip=${!!existing.strip_prefix} ws=${!!existing.websocket_enabled} framing=${haveFraming}; expected port=${r.port} strip=${r.stripPrefix} ws=${r.websocketEnabled} framing=${expectFraming}`,
      };
    });
    const routeReject = routePlan.find((p) => p.action === 'reject');
    if (routeReject) {
      return res.status(409).json({ success: false, error: routeReject.reason });
    }

    const forwardPlan = MEET_PRESET.l4Forwards.map((f) => {
      const existing = db
        .prepare(
          `SELECT * FROM service_l4_forwards
            WHERE proto = ? AND listen_port = ?
              AND (listen_port_end IS ? OR listen_port_end = ?)
            LIMIT 1`
        )
        .get(f.proto, f.listenPort, f.listenPortEnd, f.listenPortEnd);
      if (!existing) return { forward: f, action: 'insert' };
      const matches =
        existing.connect_port === f.connectPort &&
        (existing.connect_port_end ?? null) === (f.connectPortEnd ?? null);
      if (matches) return { forward: f, action: 'skip', existingId: existing.id };
      const range = f.listenPortEnd ? `${f.listenPort}-${f.listenPortEnd}` : `${f.listenPort}`;
      return {
        forward: f,
        action: 'reject',
        reason: `${f.proto}/${range} is taken by another forward (connect=${existing.connect_port}${existing.connect_port_end ? '-' + existing.connect_port_end : ''}); expected connect=${f.connectPort}${f.connectPortEnd ? '-' + f.connectPortEnd : ''}`,
      };
    });
    const forwardReject = forwardPlan.find((p) => p.action === 'reject');
    if (forwardReject) {
      return res.status(409).json({ success: false, error: forwardReject.reason });
    }

    // If a legacy single-domain Caddyfile exists for this domain,
    // remove it before we lay down the merged version. The migration
    // logic in POST /services would otherwise insert a phantom root
    // route that conflicts with our preset's `/`.
    const legacyConfigPath = join(CADDY_SITES_DIR, cleanDomain);
    if (existsSync(legacyConfigPath)) {
      await unlink(legacyConfigPath).catch(() => {});
    }

    const svc = findOrCreateLxcService(db, name, ip);
    const insertedRouteIds = [];
    const insertedForwardIds = [];

    // Atomic-ish at the row level: any single insert failure rolls
    // back the rows already inserted in this batch + reverts to a
    // clean state. We intentionally do NOT wrap in a SQLite
    // transaction because the L4 reconciler does host-side work
    // (Incus device + firewall row) that can't participate in a
    // DB transaction; the rollback path matches that asymmetry.
    const rollback = async () => {
      for (const id of insertedRouteIds) {
        try { db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(id); } catch {}
      }
      for (const id of insertedForwardIds) {
        try { db.prepare(`DELETE FROM service_l4_forwards WHERE id = ?`).run(id); } catch {}
      }
      try { await regenerateDomainCaddyConfig(db, cleanDomain); } catch {}
      // Reconciler will sweep up any orphan ppl4-* devices on the
      // next service-detail panel open, so we don't fan out a
      // second Incus call here.
    };

    try {
      // 1. HTTP routes — only insert/normalize what the plan says.
      let routesAdded = 0;
      let routesNormalized = 0;
      for (const p of routePlan) {
        const r = p.route;
        if (p.action === 'skip') {
          // Existing row matches the preset; if its path_prefix is
          // the broken /* form, normalize it in place so the merged
          // Caddyfile renders correctly without waiting for the next
          // admin-backend restart to run migration 103.
          if (p.normalize) {
            db.prepare(`UPDATE service_http_routes SET path_prefix = ? WHERE id = ?`)
              .run(r.pathPrefix, p.existingId);
            routesNormalized++;
          }
          continue;
        }
        const id = uuidv4();
        db.prepare(
          `INSERT INTO service_http_routes
             (id, service_id, domain, path_prefix, target_port,
              websocket_enabled, ssl_enabled, force_https, max_upload_size,
              strip_prefix, allow_framing, frame_ancestors)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`
        ).run(
          id,
          svc.id,
          cleanDomain,
          r.pathPrefix,
          r.port,
          r.websocketEnabled ? 1 : 0,
          // MEET's reference Caddyfile sets a 50 MiB body cap on the
          // /api route; bake that in here so the operator doesn't have
          // to remember it post-install. Other routes inherit the
          // standard 1G default.
          r.pathPrefix === '/api' ? '50M' : '1G',
          r.stripPrefix ? 1 : 0,
          r.allowFraming ? 1 : 0,
          // null frameAncestors → renderer falls back to '*'
          null
        );
        insertedRouteIds.push(id);
        routesAdded++;
      }

      // 2. Regenerate the merged Caddyfile + reload BEFORE touching L4
      // forwards. If the Caddy half fails, we can roll back without
      // having created any host-side Incus devices.
      try {
        await regenerateDomainCaddyConfig(db, cleanDomain);
      } catch (genErr) {
        await rollback();
        return res.status(400).json({
          success: false,
          error: `Caddy render failed: ${genErr.message}`,
        });
      }
      let reloadWarning = null;
      try {
        await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
      } catch (reloadError) {
        const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
        // Reload failure isn't fatal to the preset (the rules are
        // saved, and a manual reload will pick them up); surface it
        // as a warning so the operator knows.
        reloadWarning = `Routes saved but Caddy reload failed: ${detail || 'unknown error'}`;
      }

      // 3. L4 forward rows — only insert what the plan says.
      let forwardsAdded = 0;
      for (const p of forwardPlan) {
        if (p.action === 'skip') continue;
        const f = p.forward;
        const id = uuidv4();
        db.prepare(
          `INSERT INTO service_l4_forwards
             (id, service_id, proto, listen_port, listen_port_end,
              connect_port, connect_port_end, description, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(
          id,
          svc.id,
          f.proto,
          f.listenPort,
          f.listenPortEnd,
          f.connectPort,
          f.connectPortEnd,
          f.description
        );
        insertedForwardIds.push(id);
        forwardsAdded++;
      }

      // 4. Reconcile L4 forwards: emits Incus proxy devices and
      // pairs each with a service-l4 firewall row. Per-row outcomes
      // come back so the response can call out which side of which
      // forward failed without aborting the whole batch.
      let l4Result = null;
      try {
        l4Result = await reconcileServiceL4Forwards({
          db,
          serviceId: svc.id,
          lxcName: name,
          bridgeIp: ip,
          serviceTag: name,
        });
      } catch (e) {
        // Roll back the L4 inserts only — HTTP routes stay since
        // they reloaded successfully; the operator can retry the
        // L4 reconcile from the service-detail panel.
        for (const id of insertedForwardIds) {
          try { db.prepare(`DELETE FROM service_l4_forwards WHERE id = ?`).run(id); } catch {}
        }
        return res.status(500).json({
          success: false,
          error: `HTTP routes installed but L4 reconcile failed: ${e.message}. Open the service-detail panel and re-add the L4 forwards.`,
          partial: { routes: insertedRouteIds.length, forwards: 0 },
          ...(reloadWarning && { warning: reloadWarning }),
        });
      }

      const routesSkipped = MEET_PRESET.routes.length - routesAdded;
      const forwardsSkipped = MEET_PRESET.l4Forwards.length - forwardsAdded;
      console.log(
        `[LXC] Quick-add MEET on ${name}: routes added=${routesAdded} skipped=${routesSkipped} normalized=${routesNormalized}; forwards added=${forwardsAdded} skipped=${forwardsSkipped}`
      );
      res.json({
        success: true,
        domain: cleanDomain,
        routes: { added: routesAdded, skipped: routesSkipped, normalized: routesNormalized },
        forwards: { added: forwardsAdded, skipped: forwardsSkipped },
        l4: l4Result,
        ...(reloadWarning && { warning: reloadWarning }),
      });
    } catch (e) {
      await rollback();
      throw e;
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Quick-add MEET failed: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// POST /containers/:name/services - Add a route to the LXC's service.
//
// Phase 2c: this endpoint now writes through the unified
// service_http_routes pipeline so adding a second path on the same
// domain (MEET-style /api + /livekit + catch-all) just works
// instead of bouncing off the per-domain-file uniqueness check.
//
// The legacy single-domain-file fast path is retained ONLY for the
// rare case of a brand-new domain at path '/' with no advanced
// flags — for everything else we take the routes pipeline because
// the merged-Caddyfile builder already handles strip_prefix /
// websocket / per-route timeouts cleanly.
// POST /containers/:name/services/regenerate - Force-rebuild every
// merged Caddyfile owned by this LXC and reload Caddy. Used when
// the on-disk Caddyfile drifts from the routes table (the most
// common trigger: a previous edit didn't trip a regen, or the
// regen happened but the reload was racing). Operator action of
// last resort that doesn't require a host shell — equivalent to
// the host-side `caddy reload --config /etc/caddy/Caddyfile`
// pattern but driven from the routes-table state we already own.
lxcRouter.post('/containers/:name/services/regenerate', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  try {
    const db = getDb();
    const domains = db
      .prepare(
        `SELECT DISTINCT r.domain
           FROM service_http_routes r
           JOIN services s ON s.id = r.service_id
          WHERE s.lxc_container_name = ?
          ORDER BY r.domain`
      )
      .all(name)
      .map((r) => r.domain);
    const errors = [];
    for (const d of domains) {
      try { await regenerateDomainCaddyConfig(db, d); }
      catch (e) { errors.push({ domain: d, error: e.message }); }
    }
    let reloadWarning = null;
    try {
      await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
    } catch (e) {
      const detail = (e.stderr || e.stdout || e.message || '').trim();
      reloadWarning = `Files regenerated but Caddy reload failed: ${detail || 'unknown error'}`;
    }
    res.json({
      success: errors.length === 0,
      domains,
      errors,
      ...(reloadWarning && { warning: reloadWarning }),
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: `Regenerate failed: ${(e.stderr || e.message || '').trim()}`,
    });
  }
});

lxcRouter.post('/containers/:name/services', async (req, res) => {
  const { name } = req.params;
  const {
    domain,
    port,
    obtainCert,
    healthPath,
    pathPrefix,
    stripPrefix,
    websocketEnabled,
  } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  if (!domain || typeof domain !== 'string' || !domain.trim()) {
    return res.status(400).json({ success: false, error: 'Domain is required.' });
  }

  const cleanDomain = domain.trim();
  const svcPort = parseInt(port, 10) || 80;
  const cert = obtainCert !== false;
  const cleanPath = normalizeLxcPathPrefix(pathPrefix);
  if (cleanPath === null) {
    return res.status(400).json({ success: false, error: 'Invalid path prefix.' });
  }
  const wsEnabled = !!websocketEnabled;
  // strip_prefix default: caller-provided value when given,
  // otherwise true when there's a non-root path (the MEET case),
  // false at root (no-op).
  const wantStrip =
    stripPrefix !== undefined ? !!stripPrefix : cleanPath !== '/';
  const hp = validateHealthPath(healthPath);
  if (!hp.ok) {
    return res.status(400).json({ success: false, error: hp.error });
  }
  const cleanHealthPath = hp.value;

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(result.stdout || '[]');
    if (containers.length === 0) {
      return res.status(404).json({ success: false, error: 'Container not found.' });
    }
    const ip = extractIPv4(containers[0]);
    if (!ip) {
      return res.status(400).json({ success: false, error: 'Container has no IP address. Is it running?' });
    }

    try { await ensureCaddyStructure(); } catch (e) {
      console.error('[LXC] ensureCaddyStructure failed:', e?.message || e);
    }

    const db = getDb();
    const configPath = join(CADDY_SITES_DIR, cleanDomain);
    const fileExists = existsSync(configPath);

    // Discover whether this domain already has any route in the
    // unified table. If so we MUST go through the routes pipeline —
    // the merged Caddyfile builder is the only thing that won't
    // clobber siblings.
    let dbSibling = null;
    try {
      dbSibling = db
        .prepare(`SELECT id, service_id FROM service_http_routes WHERE domain = ? LIMIT 1`)
        .get(cleanDomain);
    } catch (e) {
      console.warn('[LXC] sibling lookup failed:', e?.message || e);
    }

    // Decide write path. Legacy fast path only when:
    //   - root path (/), and
    //   - no existing per-domain Caddy site file, and
    //   - no existing routes-table sibling, and
    //   - no advanced flags (strip_prefix override, websocket).
    const useRoutesPipeline =
      cleanPath !== '/' ||
      fileExists ||
      dbSibling ||
      stripPrefix !== undefined ||
      wsEnabled;

    if (!useRoutesPipeline) {
      // ---- Legacy fast path: single-domain Caddyfile ------------------
      const tlsDirective = cert ? '' : '\n    tls internal';
      const healthMarker = cleanHealthPath ? `# proxypilot: healthpath=${cleanHealthPath}\n` : '';
      const caddyConfig = `${healthMarker}${cleanDomain} {${tlsDirective}\n    reverse_proxy ${ip}:${svcPort}\n    encode gzip zstd\n    log {\n        output file /var/log/caddy/${cleanDomain}.log\n    }\n}\n`;
      await writeFile(configPath, caddyConfig);

      let reloadWarning = null;
      try {
        await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
      } catch (reloadError) {
        const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
        console.error('[LXC] Caddy reload failed:', detail);
        reloadWarning = `Config saved but Caddy reload failed: ${detail || 'unknown error'}`;
      }

      console.log(`[LXC] Added service ${cleanDomain} -> ${ip}:${svcPort} (file path)`);
      return res.json({
        success: true,
        service: { domain: cleanDomain, port: svcPort, obtainCert: cert, healthPath: cleanHealthPath, pathPrefix: '/', source: 'file' },
        ...(reloadWarning && { warning: reloadWarning }),
      });
    }

    // ---- Routes pipeline: write into service_http_routes -------------
    //
    // If there's a legacy file for this domain, migrate it into the
    // routes table FIRST so the merged regenerator can rebuild a
    // single Caddyfile that contains both the existing root route
    // and the new path-prefixed route. Without this step the merged
    // file would be missing the legacy entry's port and the original
    // service would 404.
    let migrationWarning = null;
    if (fileExists) {
      try {
        const existing = await readFile(configPath, 'utf-8');
        const m = existing.match(/reverse_proxy\s+([\d.]+):(\d+)/);
        const tlsInternal = existing.includes('tls internal');
        if (m) {
          const legacyPort = parseInt(m[2], 10);
          const svc = findOrCreateLxcService(db, name, m[1]);
          // Legacy entries are always at path '/'. Insert only if
          // the routes table doesn't already cover it (defensive
          // double-check; the dbSibling lookup above is per-domain
          // not per-(domain, path)).
          const rootExists = db
            .prepare(`SELECT id FROM service_http_routes WHERE domain = ? AND path_prefix = '/' LIMIT 1`)
            .get(cleanDomain);
          if (!rootExists) {
            db.prepare(
              `INSERT INTO service_http_routes
                 (id, service_id, domain, path_prefix, target_port,
                  websocket_enabled, ssl_enabled, force_https, max_upload_size,
                  strip_prefix)
               VALUES (?, ?, ?, '/', ?, 0, ?, ?, '1G', 0)`
            ).run(
              uuidv4(),
              svc.id,
              cleanDomain,
              legacyPort,
              tlsInternal ? 0 : 1,
              tlsInternal ? 0 : 1
            );
            // Surface the migration so the operator can spot the
            // auto-created root row in the list and decide whether
            // it still matches their intent (common case: the old
            // single-port setup pointed at the API; for a fan-out
            // app the root usually wants to point at the frontend
            // instead, so the user has to edit the migrated row).
            migrationWarning = `${cleanDomain} previously had a single-route config pointing at :${legacyPort}; migrated to / → :${legacyPort}. Edit or delete that row if it should now point at a different port.`;
          }
        }
        // Drop the file — the merged regenerator will rewrite it.
        await unlink(configPath).catch(() => {});
      } catch (e) {
        console.warn('[LXC] legacy migration on add failed:', e?.message || e);
      }
    }

    // Find or create the per-LXC service row, then insert the new
    // route. UNIQUE(domain, path_prefix) on service_http_routes
    // gives us a clean 409 when the operator tries to add the
    // exact same tuple twice.
    const svc = findOrCreateLxcService(db, name, ip);
    const routeId = uuidv4();
    try {
      db.prepare(
        `INSERT INTO service_http_routes
           (id, service_id, domain, path_prefix, target_port,
            websocket_enabled, ssl_enabled, force_https, max_upload_size,
            strip_prefix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1G', ?)`
      ).run(
        routeId,
        svc.id,
        cleanDomain,
        cleanPath,
        svcPort,
        wsEnabled ? 1 : 0,
        cert ? 1 : 0,
        cert ? 1 : 0,
        wantStrip ? 1 : 0
      );
    } catch (e) {
      if (/UNIQUE constraint/i.test(e.message || '')) {
        return res.status(409).json({
          success: false,
          error: `${cleanDomain}${cleanPath} already exists. Edit it from the Service Settings dialog or pick a different path.`,
        });
      }
      throw e;
    }

    // Regenerate the merged Caddyfile + reload.
    try {
      await regenerateDomainCaddyConfig(db, cleanDomain);
    } catch (genErr) {
      // Roll the route insert back so the next reconcile attempt
      // doesn't pick up an unrenderable row.
      db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(routeId);
      return res.status(400).json({
        success: false,
        error: `Failed to render Caddy config: ${genErr.message}`,
      });
    }
    let reloadWarning = null;
    try {
      await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
    } catch (reloadError) {
      const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
      console.error('[LXC] Caddy reload failed:', detail);
      reloadWarning = `Route saved but Caddy reload failed: ${detail || 'unknown error'}`;
    }

    console.log(`[LXC] Added route ${cleanDomain}${cleanPath} -> ${ip}:${svcPort} (routes path)`);
    res.json({
      success: true,
      service: {
        id: routeId,
        serviceId: svc.id,
        domain: cleanDomain,
        port: svcPort,
        pathPrefix: cleanPath,
        stripPrefix: wantStrip,
        websocketEnabled: wsEnabled,
        obtainCert: cert,
        healthPath: cleanHealthPath,
        source: 'db',
      },
      // Two warning channels: a Caddy reload failure is more
      // urgent (the live ruleset may be stale) so it wins; the
      // migration warning is informational so it ships only when
      // there's no reload error to crowd it out.
      ...(reloadWarning
        ? { warning: reloadWarning }
        : migrationWarning
        ? { warning: migrationWarning }
        : {}),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to add service: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// PUT /containers/:name/services/:domain - Update an existing service
//
// Phase 2c: takes an optional ?routeId= to target a routes-table row.
// Without routeId we fall back to the legacy domain-keyed file path.
// Request body now also carries pathPrefix / stripPrefix / websocketEnabled
// so the inline edit form can change the new per-route knobs without
// having to delete and re-add the row.
lxcRouter.put('/containers/:name/services/:domain', async (req, res) => {
  const { name, domain: oldDomain } = req.params;
  const { routeId } = req.query;
  const {
    domain: newDomain,
    port,
    obtainCert,
    healthPath,
    pathPrefix,
    stripPrefix,
    websocketEnabled,
    allowFraming,
    frameAncestors,
  } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  const hp = validateHealthPath(healthPath);
  if (!hp.ok) {
    return res.status(400).json({ success: false, error: hp.error });
  }
  const cleanHealthPath = hp.value;

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(result.stdout || '[]');
    if (containers.length === 0) {
      return res.status(404).json({ success: false, error: 'Container not found.' });
    }
    const ip = extractIPv4(containers[0]);
    if (!ip) {
      return res.status(400).json({ success: false, error: 'Container has no IP address.' });
    }

    try { await ensureCaddyStructure(); } catch (e) {
      console.error('[LXC] ensureCaddyStructure failed:', e?.message || e);
    }

    // Routes-table update path. Targeted via ?routeId so we never
    // accidentally hit a different (domain, path) row when multiple
    // routes share a domain.
    if (routeId) {
      const db = getDb();
      const row = db
        .prepare(
          `SELECT r.id, r.domain, r.path_prefix, s.id AS service_id
             FROM service_http_routes r
             JOIN services s ON s.id = r.service_id
            WHERE r.id = ? AND s.lxc_container_name = ?`
        )
        .get(routeId, name);
      if (!row) {
        return res.status(404).json({ success: false, error: 'Route not found.' });
      }
      const cleanDomain = (newDomain || row.domain).trim();
      const cleanPath =
        typeof pathPrefix === 'string' && pathPrefix.trim()
          ? normalizeLxcPathPrefix(pathPrefix)
          : row.path_prefix;
      if (cleanPath === null) {
        return res.status(400).json({ success: false, error: 'Invalid path prefix.' });
      }
      const svcPort = parseInt(port, 10) || 80;
      const cert = obtainCert !== false;
      const wsEnabled = !!websocketEnabled;
      const wantStrip =
        stripPrefix !== undefined ? !!stripPrefix : cleanPath !== '/';

      // (domain, path_prefix) UNIQUE → check for collisions before
      // updating, excluding the row we're updating.
      const existing = db
        .prepare(
          `SELECT id FROM service_http_routes
            WHERE domain = ? AND path_prefix = ? AND id != ?`
        )
        .get(cleanDomain, cleanPath, routeId);
      if (existing) {
        return res.status(409).json({
          success: false,
          error: `${cleanDomain}${cleanPath} already has another route.`,
        });
      }

      // allow_framing / frame_ancestors are only forwarded when the
      // PUT body sets them — undefined leaves the existing DB value
      // alone so toggling other knobs doesn't silently reset framing.
      const setFraming = allowFraming !== undefined;
      const framingValue = allowFraming ? 1 : 0;
      const setAncestors = frameAncestors !== undefined;
      const ancestorsValue = frameAncestors ?? null;
      db.prepare(
        `UPDATE service_http_routes SET
           domain = ?, path_prefix = ?, target_port = ?,
           websocket_enabled = ?, ssl_enabled = ?, force_https = ?,
           strip_prefix = ?,
           allow_framing = COALESCE(?, allow_framing),
           frame_ancestors = CASE WHEN ? THEN ? ELSE frame_ancestors END
         WHERE id = ?`
      ).run(
        cleanDomain,
        cleanPath,
        svcPort,
        wsEnabled ? 1 : 0,
        cert ? 1 : 0,
        cert ? 1 : 0,
        wantStrip ? 1 : 0,
        setFraming ? framingValue : null,
        setAncestors ? 1 : 0,
        ancestorsValue,
        routeId
      );

      // Regenerate both the new domain (always) and the old domain
      // when the rename actually changed it — the old merged file
      // either shrinks or unlinks depending on remaining siblings.
      try {
        await regenerateDomainCaddyConfig(db, cleanDomain);
        if (cleanDomain !== row.domain) {
          await regenerateDomainCaddyConfig(db, row.domain);
        }
      } catch (genErr) {
        console.warn('[LXC] regenerate after route update failed:', genErr.message);
      }

      let reloadWarning = null;
      try {
        await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
      } catch (reloadError) {
        const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
        reloadWarning = `Saved but Caddy reload failed: ${detail || 'unknown error'}`;
      }
      return res.json({
        success: true,
        service: {
          id: routeId,
          serviceId: row.service_id,
          domain: cleanDomain,
          pathPrefix: cleanPath,
          port: svcPort,
          stripPrefix: wantStrip,
          websocketEnabled: wsEnabled,
          obtainCert: cert,
          healthPath: cleanHealthPath,
          source: 'db',
        },
        ...(reloadWarning && { warning: reloadWarning }),
      });
    }

    // Legacy file path (no routeId). Same conflict guard as before so
    // a rename target that's owned by the routes pipeline doesn't
    // get clobbered.
    const targetDomain = (newDomain || oldDomain).trim();
    if (targetDomain !== oldDomain) {
      try {
        const db = getDb();
        const otherRoute = db
          .prepare('SELECT id FROM service_http_routes WHERE domain = ? LIMIT 1')
          .get(targetDomain);
        if (otherRoute) {
          return res.status(409).json({
            success: false,
            error: `Domain '${targetDomain}' is already managed in the Service Settings dialog. Remove it there first or edit it there instead.`,
          });
        }
      } catch (e) {
        console.warn('[LXC] conflict-guard DB check failed:', e?.message || e);
      }
    }

    // Remove old config
    const oldConfigPath = join(CADDY_SITES_DIR, oldDomain);
    if (existsSync(oldConfigPath)) {
      await unlink(oldConfigPath);
    }

    // Write new config. healthPath persists as a leading comment line
    // (Caddy ignores it; the GET parser recovers it). Empty/missing
    // healthPath in the request → no marker line, TCP-only behavior.
    const cleanDomain = (newDomain || oldDomain).trim();
    const svcPort = parseInt(port, 10) || 80;
    const cert = obtainCert !== false;
    const tlsDirective = cert ? '' : '\n    tls internal';
    const healthMarker = cleanHealthPath ? `# proxypilot: healthpath=${cleanHealthPath}\n` : '';
    const caddyConfig = `${healthMarker}${cleanDomain} {${tlsDirective}\n    reverse_proxy ${ip}:${svcPort}\n    encode gzip zstd\n    log {\n        output file /var/log/caddy/${cleanDomain}.log\n    }\n}\n`;
    const newConfigPath = join(CADDY_SITES_DIR, cleanDomain);
    await writeFile(newConfigPath, caddyConfig);

    let reloadWarning = null;
    try {
      await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
    } catch (reloadError) {
      const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
      console.error('[LXC] Caddy reload failed:', detail);
      reloadWarning = `Config saved but Caddy reload failed: ${detail || 'unknown error'}`;
    }

    console.log(`[LXC] Updated service ${oldDomain} -> ${cleanDomain}:${svcPort} for container ${name}`);
    res.json({
      success: true,
      service: { domain: cleanDomain, port: svcPort, obtainCert: cert, healthPath: cleanHealthPath, source: 'file' },
      ...(reloadWarning && { warning: reloadWarning }),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to update service: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// DELETE /containers/:name/services/:domain - Remove a service/domain mapping
//
// Phase 2c: the GET endpoint now merges legacy single-domain Caddy
// files with rows from service_http_routes. The frontend tags each
// entry with its source so the DELETE call can target the right
// pipeline:
//   - source='db' → ?routeId=<id>: drop the route row + regenerate
//     the merged Caddyfile for the domain (or unlink it when the
//     last sibling goes away).
//   - source='file' (no routeId): unlink the per-domain Caddyfile.
lxcRouter.delete('/containers/:name/services/:domain', async (req, res) => {
  const { name, domain } = req.params;
  const { routeId } = req.query;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    if (routeId) {
      // Routes-table delete. The merged regenerator handles both the
      // shrink case (siblings remain → rewrite file with the
      // remaining handle blocks) and the empty case (last route on
      // the domain → unlink the file).
      const db = getDb();
      const row = db
        .prepare(
          `SELECT r.id, r.domain
             FROM service_http_routes r
             JOIN services s ON s.id = r.service_id
            WHERE r.id = ? AND s.lxc_container_name = ?`
        )
        .get(routeId, name);
      if (!row) {
        return res.status(404).json({ success: false, error: 'Route not found.' });
      }
      db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(routeId);
      try {
        await regenerateDomainCaddyConfig(db, row.domain);
      } catch (genErr) {
        // If regenerate fails the row is already gone — the next
        // reconcile will rebuild. Log and proceed.
        console.warn('[LXC] regenerate after route delete failed:', genErr.message);
      }
      let reloadWarning = null;
      try {
        await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
      } catch (reloadError) {
        const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
        reloadWarning = `Route removed but Caddy reload failed: ${detail || 'unknown error'}`;
      }
      return res.json({
        success: true,
        message: `Route ${row.domain} removed.`,
        ...(reloadWarning && { warning: reloadWarning }),
      });
    }

    // Legacy fast-path: domain-only delete unlinks the per-domain
    // Caddyfile. Only valid when no routes-table sibling claims the
    // same domain — that case should always go through the routeId
    // path so we don't half-clear it.
    const configPath = join(CADDY_SITES_DIR, domain);
    if (!existsSync(configPath)) {
      return res.status(404).json({ success: false, error: `No Caddy config found for '${domain}'.` });
    }
    await unlink(configPath);

    let reloadWarning = null;
    try {
      await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
    } catch (reloadError) {
      const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
      console.error('[LXC] Caddy reload failed:', detail);
      reloadWarning = `Config removed but Caddy reload failed: ${detail || 'unknown error'}`;
    }

    console.log(`[LXC] Removed service ${domain} for container ${name}`);
    res.json({
      success: true,
      message: `Service '${domain}' removed.`,
      ...(reloadWarning && { warning: reloadWarning }),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to remove service: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// POST /containers/:name/exec - Execute a command and return JSON result
lxcRouter.post('/containers/:name/exec', async (req, res) => {
  const { name } = req.params;
  const { command, cwd } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  if (!command || typeof command !== 'string') {
    return res.status(400).json({ success: false, error: 'Command is required.' });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;
  const envSetup = 'export TERM=xterm DEBIAN_FRONTEND=noninteractive;';
  const fullCmd = cwd ? `${envSetup} cd ${JSON.stringify(cwd)} 2>/dev/null; ${command}` : `${envSetup} ${command}`;
  const execCmd = `incus exec ${incusName} -- sh -c ${JSON.stringify(fullCmd)}`;

  // Timeout is required: incus exec hangs after command finishes.
  // 60s is enough for quick commands; use BG mode for longer operations.
  try {
    const result = await execOnHost(execCmd, { timeout: 60000 });
    res.json({ success: true, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: 0 });
  } catch (error) {
    // exec throws on non-zero exit OR timeout - both return collected output
    if (res.headersSent) return;
    res.json({
      success: true,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.killed ? 124 : (error.code || 1),
      timedOut: !!error.killed,
    });
  }
});

// POST /containers/:name/tab-complete - Tab completion for paths
lxcRouter.post('/containers/:name/tab-complete', async (req, res) => {
  const { name } = req.params;
  const { partial, cwd } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const dir = partial.includes('/') ? partial.substring(0, partial.lastIndexOf('/') + 1) : (cwd || '.');
    const prefix = partial.includes('/') ? partial.substring(partial.lastIndexOf('/') + 1) : partial;
    const lsCmd = `cd ${JSON.stringify(cwd || '/root')} 2>/dev/null; ls -1a ${JSON.stringify(dir)} 2>/dev/null`;
    const result = await execOnHost(`incus exec ${incusName} -- bash -c ${JSON.stringify(lsCmd)}`, { timeout: 5000 });
    const entries = (result.stdout || '').split('\n').filter(e => e && e !== '.' && e !== '..' && e.startsWith(prefix));
    res.json({ success: true, completions: entries });
  } catch {
    res.json({ success: true, completions: [] });
  }
});

// POST /containers/import - Import a container from a backup tarball.
//
// Multer writes the upload to LXC_IMPORT_TMP_DIR on disk (memoryStorage
// previously buffered the whole file in RAM, which OOMed the backend on
// realistic backups). We then stream the temp file into `incus import -`
// stdin and unlink it in a finally regardless of success/failure.
lxcRouter.post('/import', upload.single('backup'), async (req, res) => {
  const { name } = req.body;

  // Helper to clean up the temp upload regardless of outcome.
  const cleanupTempFile = async () => {
    if (req.file?.path) {
      try { await unlink(req.file.path); } catch {}
    }
  };

  if (!name || !validateName(name)) {
    await cleanupTempFile();
    return res.status(400).json({ success: false, error: 'Valid container name is required.' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Backup file is required.' });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;

  // Check if container already exists
  try {
    await execOnHost(`incus info ${incusName} 2>/dev/null`);
    await cleanupTempFile();
    return res.status(409).json({ success: false, error: `Container '${name}' already exists.` });
  } catch {
    // Good — doesn't exist
  }

  try {
    const importCmd = `incus import - ${incusName}`;
    await new Promise((resolve, reject) => {
      const child = spawnOnHost(importCmd);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Import exited with code ${code}`));
      });
      child.on('error', reject);
      // Stream the temp file into incus stdin instead of buffering the
      // whole tarball into memory. createReadStream uses a 64 KiB
      // highWaterMark by default, which is fine here — the bottleneck
      // is incus, not Node.
      const fileStream = createReadStream(req.file.path);
      fileStream.on('error', reject);
      fileStream.pipe(child.stdin);
    });

    // Start the container
    try {
      await execOnHost(`incus start ${incusName}`, { timeout: 30000 });
    } catch {}

    res.status(201).json({ success: true, message: `Container '${name}' imported successfully.` });
  } catch (error) {
    // Cleanup on failure
    try { await execOnHost(`incus delete ${incusName} --force 2>/dev/null || true`); } catch {}
    res.status(500).json({ success: false, error: `Import failed: ${error.message}` });
  } finally {
    await cleanupTempFile();
  }
});

// GET /containers/:name/files - List files in a directory
lxcRouter.get('/containers/:name/files', async (req, res) => {
  const { name } = req.params;
  const dirPath = req.query.path || '/root';

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    // Use ls with machine-parseable output
    const cmd = `incus exec ${incusName} -- ls -la --time-style=long-iso ${JSON.stringify(dirPath)}`;
    const result = await execOnHost(cmd, { timeout: 10000 });
    const lines = result.stdout.split('\n').filter(l => l.trim() && !l.startsWith('total'));
    const files = lines.map(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 8) return null;
      const permissions = parts[0];
      const isDir = permissions.startsWith('d');
      const isLink = permissions.startsWith('l');
      const owner = parts[2];
      const group = parts[3];
      const size = parseInt(parts[4], 10);
      const date = parts[5];
      const time = parts[6];
      const fileName = parts.slice(7).join(' ').replace(/ -> .*$/, ''); // Remove symlink target
      if (fileName === '.' || fileName === '..') return null;
      return {
        name: fileName,
        permissions,
        owner,
        group,
        size,
        modified: `${date} ${time}`,
        isDir,
        isLink,
        path: dirPath === '/' ? `/${fileName}` : `${dirPath}/${fileName}`,
      };
    }).filter(Boolean);
    res.json({ success: true, path: dirPath, files });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to list files: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// GET /containers/:name/files/download - Download a file from the container
lxcRouter.get('/containers/:name/files/download', async (req, res) => {
  const { name } = req.params;
  const filePath = req.query.path;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  if (!filePath) {
    return res.status(400).json({ success: false, error: 'File path is required.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const fileName = filePath.split('/').pop();
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const pullCmd = `incus file pull ${incusName}${filePath} -`;
    const child = spawnOnHost(pullCmd);

    child.stdout.pipe(res);

    child.stderr.on('data', (data) => {
      console.error(`[LXC] File download stderr: ${data.toString()}`);
    });

    child.on('close', (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to download file' });
      }
    });

    child.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      }
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// POST /containers/:name/files/upload - Upload a file to the container
lxcRouter.post('/containers/:name/files/upload', upload.single('file'), async (req, res) => {
  const { name } = req.params;
  const destPath = req.query.path || '/root/';

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file provided.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const fullDest = destPath.endsWith('/') ? `${destPath}${req.file.originalname}` : destPath;
    const pushCmd = `incus file push - ${incusName}${fullDest}`;

    await new Promise((resolve, reject) => {
      const child = spawnOnHost(pushCmd);
      let stderr = '';

      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Push exited with code ${code}`));
      });

      child.on('error', reject);

      child.stdin.write(req.file.buffer);
      child.stdin.end();
    });

    res.json({
      success: true,
      message: `File uploaded to ${fullDest}`,
      path: fullDest,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to upload file: ${error.message}`,
    });
  }
});

// POST /containers/:name/start - Start a container
lxcRouter.post('/containers/:name/start', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus start ${incusName} 2>&1`);
    // Ensure NAT and DNS after start (non-blocking)
    ensureNetworkNat().catch(() => {});
    ensureDns(incusName).catch(() => {});
    res.json({ success: true, message: `Container '${name}' started.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to start container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// POST /containers/:name/stop - Stop a container
lxcRouter.post('/containers/:name/stop', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus stop ${incusName} --force 2>&1`);
    res.json({ success: true, message: `Container '${name}' stopped.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to stop container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// POST /containers/:name/restart - Restart a container
lxcRouter.post('/containers/:name/restart', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus restart ${incusName} --force 2>&1`);
    // Ensure NAT and DNS after restart (non-blocking)
    ensureNetworkNat().catch(() => {});
    ensureDns(incusName).catch(() => {});
    res.json({ success: true, message: `Container '${name}' restarted.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to restart container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// POST /containers/:name/reboot - Graceful reboot (VMs use ACPI shutdown)
//
// `incus restart` without --force sends a graceful shutdown signal:
//   - VMs: ACPI shutdown so the guest flushes dirty buffers, runs init
//     shutdown scripts, and exits cleanly before the VM is started again.
//     A naive Stop+Start power-cycles the VM (ungraceful), which can
//     corrupt the guest filesystem on dirty caches.
//   - Containers: SIGPWR/SIGTERM into the init process; functionally
//     equivalent to the existing /restart endpoint without --force, but
//     containers stay on the existing button for now.
lxcRouter.post('/containers/:name/reboot', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    console.log(`[LXC] Reboot (graceful) requested for ${incusName}`);
    await execOnHost(`incus restart ${incusName} 2>&1`);
    ensureNetworkNat().catch(() => {});
    ensureDns(incusName).catch(() => {});
    res.json({ success: true, message: `Instance '${name}' is rebooting.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to reboot instance '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// POST /containers/:name/resize - Resize container resource limits
lxcRouter.post('/containers/:name/resize', async (req, res) => {
  const { name } = req.params;
  const { cpu, memory } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  if (!cpu && !memory) {
    return res.status(400).json({
      success: false,
      error: 'At least one of cpu or memory must be provided.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;

    if (cpu) {
      await execOnHost(`incus config set ${incusName} limits.cpu=${cpu}`);
    }
    if (memory) {
      await execOnHost(`incus config set ${incusName} limits.memory=${memory}MB`);
    }

    res.json({
      success: true,
      message: `Container '${name}' resource limits updated.`,
      config: {
        cpu: cpu || 'unchanged',
        memory: memory ? `${memory}MB` : 'unchanged',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to resize container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// DELETE /containers/:name - Delete a container
lxcRouter.delete('/containers/:name', requireSudo, async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;

    // Get container IP before deletion for Caddy cleanup
    let containerIp = null;
    try {
      const listResult = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`);
      const containers = JSON.parse(listResult.stdout);
      if (containers.length > 0) {
        containerIp = extractIPv4(containers[0]);
      }
    } catch {
      // Ignore - container may not exist or be stopped
    }

    // Stop container if running
    await execOnHost(`incus stop ${incusName} --force 2>/dev/null || true`);

    // Delete container
    await execOnHost(`incus delete ${incusName} --force 2>&1`);

    // Remove ALL associated Caddy configs if the container had an IP (supports multi-service)
    if (containerIp) {
      try {
        const files = await readdir(CADDY_SITES_DIR);
        let removedAny = false;
        for (const file of files) {
          const filePath = join(CADDY_SITES_DIR, file);
          const content = await readFile(filePath, 'utf-8');
          if (content.includes(containerIp)) {
            await unlink(filePath);
            console.log(`[LXC] Removed Caddy config: ${file} (contained IP ${containerIp})`);
            removedAny = true;
          }
        }
        if (removedAny) {
          try {
            await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
          } catch {
            // Ignore reload errors
          }
        }
      } catch {
        // Ignore Caddy cleanup errors
      }
    }

    res.json({ success: true, message: `Container '${name}' deleted.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to delete container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// GET /containers/:name/export-info - Pre-flight estimate for an export.
//
// The frontend uses this to render a size-aware progress bar before
// kicking off the export proper. Estimate is the rootfs disk usage
// reported by the storage backend; the actual tarball will be smaller
// (gzip) but same order of magnitude. When the backend can't report
// usage (e.g. dir storage), bytes is null and the UI falls back to an
// indeterminate spinner.
lxcRouter.get('/containers/:name/export-info', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  const incusName = `${INSTANCE_PREFIX}${name}`;
  let estimatedBytes = null;
  let isRunning = false;
  try {
    const stateResult = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(stateResult.stdout || '[]');
    if (containers.length === 0) {
      return res.status(404).json({ success: false, error: 'Container not found.' });
    }
    isRunning = containers[0]?.status === 'Running';
  } catch {}

  // Best-effort rootfs usage from the storage volume /state endpoint.
  // Wrapped — null on any failure and the UI degrades to an
  // indeterminate progress bar.
  const pool = await resolveContainerPool(incusName);
  if (pool) {
    estimatedBytes = await readVolumeUsedBytes(pool, `container/${incusName}`);
  }

  res.json({ success: true, estimatedBytes, isRunning });
});

// GET /containers/:name/export - Export container as tarball backup
lxcRouter.get('/containers/:name/export', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const fileName = `${name}-backup.tar.gz`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/gzip');

    // Stream the export. The container can stay running — modern incus
    // takes a brief storage-level snapshot internally for a consistent
    // tarball without operator-visible downtime. The previous code
    // force-stopped the container, which yanked the bridge IP and made
    // the inline services list flicker to empty in the UI for the
    // duration of the export. Dropping that gives operators a true
    // online backup.
    const exportCmd = `incus export ${incusName} -`;
    const child = spawnOnHost(exportCmd);

    child.stdout.pipe(res);

    child.stderr.on('data', (data) => {
      console.log(`[LXC] Export stderr: ${data.toString().trim()}`);
    });

    child.on('close', async (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ success: false, error: 'Export failed' });
      }
    });

    child.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Client cancelled (browser closed, AbortController.abort() in
    // the dashboard, network drop). Kill the export child so incus
    // stops compressing — otherwise it keeps running on the host
    // until done, wasting CPU + disk for a download nobody is
    // receiving anymore.
    req.on('close', () => {
      if (child && !child.killed) {
        try { child.kill('SIGTERM'); } catch {}
      }
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// GET /containers/:name/snapshot/:snapshotName/export-info
//
// Pre-flight size estimate for downloading an existing snapshot.
// Mirrors /containers/:name/export-info but reads from the snapshot's
// storage volume instead of the live container's root volume.
lxcRouter.get('/containers/:name/snapshot/:snapshotName/export-info', async (req, res) => {
  const { name, snapshotName } = req.params;
  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }
  const incusName = `${INSTANCE_PREFIX}${name}`;
  let estimatedBytes = null;
  const pool = await resolveContainerPool(incusName);
  if (pool) {
    estimatedBytes = await readVolumeUsedBytes(pool, `container/${incusName}/snapshots/${snapshotName}`);
  }
  res.json({ success: true, estimatedBytes });
});

// GET /containers/:name/snapshot/:snapshotName/export
//
// Download a previously-taken snapshot as a tarball.
//
// `incus export` accepts only an instance name — passing
// `<container>/<snapshot>` fails silently and produces an empty
// file. The reliable path is:
//   1. incus copy <container>/<snapshot> <temp-instance>
//      (cheap on COW backends; full filesystem copy on dir)
//   2. incus export <temp-instance> -   → stdout pipe
//   3. incus delete <temp-instance> --force
// We always delete the temp instance on every termination path —
// successful close, error, and client disconnect — so a cancelled
// download doesn't leak a stopped container.
lxcRouter.get('/containers/:name/snapshot/:snapshotName/export', async (req, res) => {
  const { name, snapshotName } = req.params;
  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }
  const incusName = `${INSTANCE_PREFIX}${name}`;
  // Temp instance name: prefixed so it's recognizable in `incus list`
  // if anything ever leaks, suffixed with timestamp + random so two
  // concurrent downloads of the same snapshot can't collide.
  const tempName = `pp-snap-export-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Confirm the snapshot exists before kicking off the copy so the
  // failure path returns JSON instead of an empty tarball.
  try {
    const r = await execOnHost(`incus snapshot list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const snaps = JSON.parse(r.stdout || '[]');
    if (!snaps.some((s) => s.name === snapshotName)) {
      return res.status(404).json({ success: false, error: `Snapshot '${snapshotName}' not found on '${name}'.` });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: `Failed to verify snapshot: ${(e.stderr || e.message || '').trim()}` });
  }

  // Idempotent cleanup. Called from every termination path.
  let cleanupRan = false;
  const cleanup = async () => {
    if (cleanupRan) return;
    cleanupRan = true;
    try {
      await execOnHost(`incus delete ${tempName} --force`, { timeout: 60000 });
    } catch (e) {
      console.error(`[LXC] Failed to delete temp export instance ${tempName}: ${(e.stderr || e.message || '').trim()}`);
    }
  };

  // Materialize the snapshot as a stopped temp instance. On COW
  // backends this is near-instant; on dir backends it's a full
  // filesystem copy and can take minutes. 30 min covers realistic
  // upper bound; raise if needed via a future env knob.
  try {
    await execOnHost(`incus copy ${incusName}/${snapshotName} ${tempName}`, { timeout: 30 * 60 * 1000 });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `Failed to prepare snapshot for export: ${(e.stderr || e.stdout || e.message || '').trim()}`,
    });
  }

  const fileName = `${name}-${snapshotName}-backup.tar.gz`;
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/gzip');

  let child;
  try {
    child = spawnOnHost(`incus export ${tempName} -`);
  } catch (e) {
    await cleanup();
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: e.message });
    }
    return;
  }

  child.stdout.pipe(res);

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    console.log(`[LXC] Snapshot export stderr: ${d.toString().trim()}`);
  });

  child.on('close', async (code) => {
    await cleanup();
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ success: false, error: `Export failed: ${stderr.trim() || `incus exited ${code}`}` });
    }
  });

  child.on('error', async (err) => {
    await cleanup();
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // If the client (browser) cancels mid-download, kill the export
  // child and clean up the temp instance. Otherwise the temp
  // container leaks and `incus list` accumulates pp-snap-export-*
  // entries.
  req.on('close', async () => {
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch {}
    }
    await cleanup();
  });
});

// Estimate how long the next snapshot of `name` will take, in ms.
// Strategy: average the most recent durations recorded for this
// container, then fall back to a size-based heuristic, then a fixed
// default. Returns null when nothing is available.
async function estimateSnapshotMs(name, incusName) {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT duration_ms FROM snapshot_durations WHERE container_name = ? ORDER BY created_at DESC LIMIT 5'
    ).all(name);
    if (rows.length) {
      const avg = rows.reduce((s, r) => s + r.duration_ms, 0) / rows.length;
      return Math.max(5_000, Math.round(avg));
    }
  } catch {}
  // Size-based fallback: read the live container's disk usage and
  // assume ~50 MB/s — a conservative rate that covers dir-backed pools
  // (the slowest realistic case). ZFS/btrfs snapshots are basically
  // instant, so over-estimating here is harmless.
  try {
    const r = await execOnHost(`incus query /1.0/instances/${incusName}?recursion=1 2>/dev/null`, { timeout: 5000 });
    const instance = JSON.parse(r.stdout || '{}');
    const pool = instance?.expanded_devices?.root?.pool || instance?.devices?.root?.pool;
    if (pool) {
      const used = await readVolumeUsedBytes(pool, `container/${incusName}`);
      if (used) {
        const ms = Math.round((used / (50 * 1024 * 1024)) * 1000);
        return Math.max(15_000, Math.min(30 * 60 * 1000, ms));
      }
    }
  } catch {}
  return null;
}

// Sweep finished snapshot jobs older than the TTL so activeSnapshots
// doesn't grow unbounded across long-lived backend processes.
function pruneSnapshotJobs() {
  const now = Date.now();
  for (const [id, job] of activeSnapshots.entries()) {
    if (job.finishedAt && now - job.finishedAt > SNAPSHOT_JOB_TTL_MS) {
      activeSnapshots.delete(id);
    }
  }
}

// POST /containers/:name/snapshot - Kick off snapshot creation in the
// background. Returns a jobId immediately so the client can poll
// /containers/:name/snapshot-jobs/:jobId for elapsed time + ETA.
// The previous synchronous version SIGTERMed at 5 min, which is too
// short for snapshots of large or busy containers (Postgres LXC
// reproduced the failure shown in the bug report).
lxcRouter.post('/containers/:name/snapshot', async (req, res) => {
  const { name } = req.params;
  const { snapshotName, note } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  if (!validateName(snapshotName)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid snapshot name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  pruneSnapshotJobs();

  const incusName = `${INSTANCE_PREFIX}${name}`;
  const jobId = randomUUID();
  const estimateMs = await estimateSnapshotMs(name, incusName);
  const job = {
    id: jobId,
    name,
    snapshotName,
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    error: null,
    estimateMs,
  };
  activeSnapshots.set(jobId, job);

  // spawnOnHost has no built-in timeout; we let incus take as long as
  // it needs and report progress via the status endpoint instead.
  const child = spawnOnHost(`incus snapshot create ${incusName} ${snapshotName}`);
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.on('error', (err) => {
    job.status = 'error';
    job.error = `Failed to start incus snapshot create: ${err.message}`;
    job.finishedAt = Date.now();
  });
  child.on('close', async (code) => {
    if (code === 0) {
      // Set description if note provided. Best-effort; failure here
      // shouldn't fail the snapshot itself.
      if (note) {
        await execOnHost(
          `incus config set ${incusName}/snapshots/${snapshotName} user.note=${JSON.stringify(note)} 2>&1`,
          { timeout: 10000 }
        ).catch(() => {});
      }
      job.status = 'done';
      job.finishedAt = Date.now();
      // Record duration for ETA on subsequent snapshots of this container.
      try {
        const db = getDb();
        const duration = job.finishedAt - job.startedAt;
        let sizeBytes = null;
        try {
          const r = await execOnHost(`incus query /1.0/instances/${incusName}?recursion=1 2>/dev/null`, { timeout: 5000 });
          const instance = JSON.parse(r.stdout || '{}');
          const pool = instance?.expanded_devices?.root?.pool || instance?.devices?.root?.pool;
          if (pool) sizeBytes = await readVolumeUsedBytes(pool, `container/${incusName}`);
        } catch {}
        db.prepare(
          'INSERT INTO snapshot_durations (container_name, duration_ms, size_bytes) VALUES (?, ?, ?)'
        ).run(name, duration, sizeBytes);
        // Keep at most the 20 most recent rows per container.
        db.prepare(`
          DELETE FROM snapshot_durations
          WHERE container_name = ?
            AND id NOT IN (
              SELECT id FROM snapshot_durations
              WHERE container_name = ?
              ORDER BY created_at DESC
              LIMIT 20
            )
        `).run(name, name);
      } catch (err) {
        console.error('[LXC] failed to record snapshot duration:', err.message);
      }
    } else {
      job.status = 'error';
      const out = (stderr || stdout || '').trim();
      job.error = out
        ? `Failed to create snapshot for container '${name}': ${out}`
        : `Failed to create snapshot for container '${name}': incus exited with code ${code}.`;
      job.finishedAt = Date.now();
    }
  });

  res.json({
    success: true,
    jobId,
    estimateMs,
    message: `Snapshot '${snapshotName}' creation started for container '${name}'.`,
  });
});

// GET /containers/:name/snapshot-exports — list every S3 export
// row for this container.  Used by the snapshots panel to render
// 'on-site ✓ · off-site ✗' chips next to each snapshot row.
lxcRouter.get('/containers/:name/snapshot-exports', (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  const rows = listSnapshotExports({ containerName: name });
  res.json({
    success: true,
    exports: rows.map((r) => ({
      id: r.id,
      snapshot_name: r.snapshot_name,
      destination_id: r.destination_id,
      destination_name: r.destination_name || null,
      destination_bucket: r.destination_bucket || null,
      s3_key: r.s3_key,
      size_bytes: r.size_bytes,
      status: r.status,
      error: r.error || null,
      started_at: r.started_at,
      finished_at: r.finished_at || null,
      // Live progress (post-206).  bytes_total is set from the
      // tarball size at the start of the upload; bytes_uploaded
      // is updated every ~500ms by the Upload's progress event.
      // cancel_requested = 1 means the operator clicked Cancel
      // and the worker is mid-abort.
      bytes_uploaded: r.bytes_uploaded || 0,
      bytes_total: r.bytes_total || null,
      cancel_requested: !!r.cancel_requested,
    })),
  });
});

// POST /containers/:name/snapshot/:snapshotName/s3-export — kick
// off an S3 export for an existing local snapshot.  Lets the
// operator export a snapshot that was originally created
// without S3 fan-out (or push it to additional destinations
// after the fact).  Returns immediately; per-destination state
// lands in the exports table.
lxcRouter.post('/containers/:name/snapshot/:snapshotName/s3-export', async (req, res) => {
  const { name, snapshotName } = req.params;
  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid container or snapshot name.' });
  }
  const ids = Array.isArray(req.body?.destination_ids)
    ? req.body.destination_ids.filter((s) => typeof s === 'string')
    : [];
  if (ids.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'destination_ids array is required (at least one destination).',
    });
  }
  const destinations = [];
  for (const did of ids) {
    const dest = getDb().prepare(`SELECT * FROM backup_destinations WHERE id = ?`).get(did);
    if (!dest) {
      return res.status(404).json({ success: false, error: `destination not found: ${did}` });
    }
    destinations.push(dest);
  }
  const incusName = `${INSTANCE_PREFIX}${name}`;
  // Detached: respond immediately, the fan-out runs in the
  // background and updates lxc_snapshot_s3_exports as it goes.
  fanOutSnapshotExport({
    containerName: name, incusName, snapshotName, destinations,
    audit: { user_id: req.user?.id || null, ip: req.ip },
  }).catch((err) => {
    console.error('[LXC] retroactive snapshot S3 fan-out threw:', err?.message || err);
  });
  res.json({
    success: true,
    queued: destinations.length,
    destination_ids: destinations.map((d) => d.id),
  });
});

// POST /containers/snapshot-exports/sweep — manually trigger the
// orphan-temp-instance sweeper.  Same code path as the
// every-30-minute cron in lib/backup-scheduler; exposed here so
// an operator who just cancelled a stuck push doesn't have to
// wait the full interval to clear the dangling pp-snapxp-* temp.
lxcRouter.post('/containers/snapshot-exports/sweep', async (req, res) => {
  const r = sweepOrphanTempInstances();
  if (!r.ok) {
    return res.status(502).json({ success: false, error: r.error });
  }
  res.json({ success: true, deleted: r.deleted, failed: r.failed });
});

// GET /containers/:name/snapshot/:snapshotName/s3-export/:exportId/info
// Surfaces object-lock + retention metadata for a single S3 copy
// so the delete-confirm dialog can display 'retained until ...' /
// 'legal hold' before the operator clicks confirm.  Implemented as
// a HEAD round-trip to the bucket; cheap, no body transfer.
lxcRouter.get('/containers/:name/snapshot/:snapshotName/s3-export/:exportId/info', async (req, res) => {
  const { exportId } = req.params;
  const out = await inspectSnapshotS3Object({ exportId });
  if (!out.ok) {
    return res.status(out.error === 'export not found' ? 404 : 502).json({
      success: false, error: out.error,
    });
  }
  res.json({ success: true, ...out });
});

// DELETE /containers/:name/snapshot/:snapshotName/s3-export/:exportId
// Removes a single S3 copy of a snapshot export.  The local
// snapshot itself stays — the dashboard's standard
// `incus snapshot delete` flow handles that.  Returns 423 (Locked)
// when the object has active retention or legal hold so the
// caller can render the lock state instead of a generic 502.
lxcRouter.delete('/containers/:name/snapshot/:snapshotName/s3-export/:exportId', async (req, res) => {
  const { exportId } = req.params;
  const out = await deleteSnapshotExport({
    exportId,
    audit: { user_id: req.user?.id || null, ip: req.ip },
  });
  if (!out.ok) {
    if (out.locked) {
      return res.status(423).json({
        success: false,
        error: out.error,
        locked: true,
        retention_until: out.retention_until || null,
        retention_mode: out.retention_mode || null,
        legal_hold: !!out.legal_hold,
      });
    }
    return res.status(out.error === 'export not found' ? 404 : 502).json({
      success: false, error: out.error,
    });
  }
  res.json({ success: true, alreadyDeleted: !!out.alreadyDeleted });
});

// POST /containers/:name/snapshot/:snapshotName/s3-export/:exportId/cancel
// Aborts an in-flight upload.  Idempotent: cancelling a row
// that's already terminal returns alreadyFinished=true.
// The export row's status flips to 'failed' with
// error='canceled by operator' once the upload's done()
// promise rejects on the next event-loop tick.
lxcRouter.post('/containers/:name/snapshot/:snapshotName/s3-export/:exportId/cancel', async (req, res) => {
  const { exportId } = req.params;
  const out = await cancelSnapshotExport({
    exportId,
    audit: { user_id: req.user?.id || null, ip: req.ip },
  });
  if (!out.ok) {
    return res.status(out.error === 'export not found' ? 404 : 500).json({
      success: false, error: out.error,
    });
  }
  res.json({
    success: true,
    alreadyFinished: !!out.alreadyFinished,
    status: out.status || 'pending',
  });
});

// GET /containers/:name/snapshot-jobs/:jobId - Poll snapshot progress.
// Returns elapsedMs (always) and estimateMs (when an estimate exists).
// Once status is 'done' or 'error' the job stays around for a while so
// the UI can render a final state on the next poll.
lxcRouter.get('/containers/:name/snapshot-jobs/:jobId', (req, res) => {
  const { name, jobId } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  const job = activeSnapshots.get(jobId);
  if (!job || job.name !== name) {
    return res.status(404).json({ success: false, error: 'Snapshot job not found.' });
  }
  const now = job.finishedAt || Date.now();
  res.json({
    success: true,
    jobId: job.id,
    snapshotName: job.snapshotName,
    status: job.status,
    elapsedMs: now - job.startedAt,
    estimateMs: job.estimateMs,
    error: job.error,
  });
});

// POST /containers/:name/snapshot/:snapshotName/restore - Restore a snapshot
lxcRouter.post('/containers/:name/snapshot/:snapshotName/restore', async (req, res) => {
  const { name, snapshotName } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  if (!validateName(snapshotName)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid snapshot name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  // Restore touches the same storage as create; same timeout reasoning.
  const SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000;

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus snapshot restore ${incusName} ${snapshotName}`, { timeout: SNAPSHOT_TIMEOUT_MS });
    res.json({
      success: true,
      message: `Snapshot '${snapshotName}' restored for container '${name}'.`,
    });
  } catch (error) {
    res.status(500).json(formatSnapshotError(`Failed to restore snapshot for container '${name}'`, error, SNAPSHOT_TIMEOUT_MS));
  }
});

// DELETE /containers/:name/snapshot/:snapshotName/local - Drop the
// local copy only; any S3-stored copies stay.  Used when an
// operator wants to reclaim pool space but keep the S3 backups.
lxcRouter.delete('/containers/:name/snapshot/:snapshotName/local', async (req, res) => {
  const { name, snapshotName } = req.params;

  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }

  const SNAPSHOT_TIMEOUT_MS = 2 * 60 * 1000;
  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus snapshot delete ${incusName} ${snapshotName}`, { timeout: SNAPSHOT_TIMEOUT_MS });
    res.json({
      success: true,
      message: `Local copy of '${snapshotName}' deleted; S3 copies untouched.`,
    });
  } catch (error) {
    res.status(500).json(formatSnapshotError(
      `Failed to delete local snapshot from container '${name}'`,
      error, SNAPSHOT_TIMEOUT_MS,
    ));
  }
});

// DELETE /containers/:name/snapshot/:snapshotName - Delete a
// snapshot from EVERY location: the local Incus pool plus every
// S3 destination it was exported to.  The frontend's whole-snapshot
// trash button drives this; per-location deletes use the
// scoped /local and /s3-export/:exportId endpoints.
lxcRouter.delete('/containers/:name/snapshot/:snapshotName', async (req, res) => {
  const { name, snapshotName } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  if (!validateName(snapshotName)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid snapshot name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  // Delete reclaims storage; on copy-on-write backends with many
  // overlapping snapshots this can take a while.
  const SNAPSHOT_TIMEOUT_MS = 2 * 60 * 1000;
  const incusName = `${INSTANCE_PREFIX}${name}`;
  const errors = [];

  // 1. Drop the local snapshot.  Tolerated if it's already gone
  // (operator may have dropped the local copy first via the
  // /local endpoint).
  try {
    await execOnHost(`incus snapshot delete ${incusName} ${snapshotName}`, { timeout: SNAPSHOT_TIMEOUT_MS });
  } catch (error) {
    const msg = (error.stderr || error.message || '').toLowerCase();
    if (!msg.includes('not found') && !msg.includes("doesn't exist") && !msg.includes('no such')) {
      errors.push({ scope: 'local', error: (error.stderr || error.message || 'unknown').trim().slice(0, 512) });
    }
  }

  // 2. Drop every S3 copy (exported rows).  Pending uploads get
  // cancel_requested set so the queue worker aborts them; failed
  // / dismissed rows are removed outright.  All best-effort; we
  // collect failures and keep going so a single dead bucket
  // doesn't block the other deletions.
  let exportRows = [];
  try {
    exportRows = listSnapshotExports({ containerName: name, snapshotName });
  } catch { /* tolerated */ }

  for (const row of exportRows) {
    if (row.status === 'pending') {
      try {
        await cancelSnapshotExport({
          exportId: row.id,
          audit: { user_id: req.user?.id || null, ip: req.ip },
        });
      } catch (err) {
        errors.push({
          scope: row.destination_name || row.destination_id,
          error: (err?.message || String(err)).slice(0, 512),
        });
      }
      continue;
    }
    if (row.status === 'deleted') continue;
    try {
      const out = await deleteSnapshotExport({
        exportId: row.id,
        audit: { user_id: req.user?.id || null, ip: req.ip },
      });
      if (!out.ok) {
        errors.push({
          scope: row.destination_name || row.destination_id,
          error: out.error || 'unknown',
        });
      }
    } catch (err) {
      errors.push({
        scope: row.destination_name || row.destination_id,
        error: (err?.message || String(err)).slice(0, 512),
      });
    }
  }

  // 3. Drop notes for the snapshot regardless of where it lived.
  try {
    const db = getDb();
    db.prepare('DELETE FROM snapshot_notes WHERE container_name = ? AND snapshot_name = ?').run(name, snapshotName);
  } catch {}

  if (errors.length > 0) {
    return res.status(502).json({
      success: false,
      error: `Snapshot deletion partially failed for '${snapshotName}'.`,
      details: errors,
    });
  }
  res.json({
    success: true,
    message: `Snapshot '${snapshotName}' deleted from container '${name}'.`,
  });
});

// POST /containers/:name/snapshot/:snapshotName/s3-export/:exportId/restore
// Pulls a previously-exported tarball from S3 back into the host's
// Incus pool as a snapshot of `name` named `snapshotName`.  Use
// case: operator dropped the local snapshot, kept the S3 copy,
// and now needs the snapshot back without restoring the whole
// container.
//
// Fails fast with 409 if a local snapshot of the same name
// already exists — the caller is expected to drop it first.
lxcRouter.post('/containers/:name/snapshot/:snapshotName/s3-export/:exportId/restore', async (req, res) => {
  const { name, snapshotName, exportId } = req.params;
  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }
  const incusName = `${INSTANCE_PREFIX}${name}`;
  const db = getDb();
  const row = db.prepare(`
    SELECT e.*, d.bucket AS destination_bucket
    FROM lxc_snapshot_s3_exports e
    LEFT JOIN backup_destinations d ON d.id = e.destination_id
    WHERE e.id = ? AND e.container_name = ? AND e.snapshot_name = ?
  `).get(exportId, name, snapshotName);
  if (!row) {
    return res.status(404).json({ success: false, error: 'export not found' });
  }
  if (row.status !== 'exported') {
    return res.status(409).json({
      success: false,
      error: `export is in status '${row.status}' — only 'exported' rows can be pulled to local.`,
    });
  }
  const destination = db.prepare(`SELECT * FROM backup_destinations WHERE id = ?`).get(row.destination_id);
  if (!destination) {
    return res.status(404).json({ success: false, error: 'destination missing' });
  }

  // Pull lands the snapshot as a NEW container (incus has no
  // snapshot-to-snapshot graft on an existing instance).  The
  // helper picks a unique <orig>-r-<8chars> name; collision is
  // extremely unlikely but the import call would surface it
  // loudly if it ever happens.
  const out = await importSnapshotFromS3({
    destination, s3Key: row.s3_key, incusName, snapshotName,
    exportId,
    audit: { user_id: req.user?.id || null, ip: req.ip },
  });
  if (!out.ok) {
    return res.status(500).json({ success: false, error: out.error });
  }
  res.json({
    success: true,
    restored_as: out.restoredAs,
    message: `Snapshot '${snapshotName}' restored from ${destination.name} as new container '${out.restoredAs}'.`,
    size_bytes: out.sizeBytes || null,
  });
});

// GET /containers/:name/snapshot/:snapshotName/s3-export/:exportId/import-progress
// Polled by the Pull-from-S3 dialog while the long-running
// download/import dance runs.  Returns the current phase + bytes
// counters so the UI can render a meaningful progress bar instead
// of a bare spinner.  Cleared 30s after the import finishes.
lxcRouter.get('/containers/:name/snapshot/:snapshotName/s3-export/:exportId/import-progress', (req, res) => {
  const { exportId } = req.params;
  const p = getImportProgress({ exportId });
  if (!p) {
    return res.json({ success: true, found: false });
  }
  res.json({ success: true, found: true, ...p });
});

// GET /containers/:name/snapshot/:snapshotName/notes - Get notes for a snapshot
lxcRouter.get('/containers/:name/snapshot/:snapshotName/notes', (req, res) => {
  const { name, snapshotName } = req.params;

  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }

  try {
    const db = getDb();
    const notes = db.prepare(
      'SELECT id, note, created_at FROM snapshot_notes WHERE container_name = ? AND snapshot_name = ? ORDER BY created_at DESC'
    ).all(name, snapshotName);
    res.json({ success: true, notes });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get notes.' });
  }
});

// POST /containers/:name/snapshot/:snapshotName/notes - Add a note to a snapshot
lxcRouter.post('/containers/:name/snapshot/:snapshotName/notes', (req, res) => {
  const { name, snapshotName } = req.params;
  const { note } = req.body;

  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }

  if (!note || typeof note !== 'string' || !note.trim()) {
    return res.status(400).json({ success: false, error: 'Note text is required.' });
  }

  try {
    const db = getDb();
    const id = uuidv4();
    db.prepare(
      'INSERT INTO snapshot_notes (id, container_name, snapshot_name, note) VALUES (?, ?, ?, ?)'
    ).run(id, name, snapshotName, note.trim());
    res.json({ success: true, id, message: 'Note added.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to add note.' });
  }
});

// DELETE /containers/:name/snapshot/:snapshotName/notes/:noteId - Delete a note
lxcRouter.delete('/containers/:name/snapshot/:snapshotName/notes/:noteId', (req, res) => {
  const { name, snapshotName, noteId } = req.params;

  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }

  try {
    const db = getDb();
    db.prepare('DELETE FROM snapshot_notes WHERE id = ? AND container_name = ? AND snapshot_name = ?').run(noteId, name, snapshotName);
    res.json({ success: true, message: 'Note deleted.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete note.' });
  }
});

// ─── Incus Infrastructure Management ─────────────────────────────────────────

// GET /networks - List all Incus networks
lxcRouter.get('/networks', async (req, res) => {
  try {
    const result = await execOnHost('incus network list --format json', { timeout: 10000 });
    const networks = JSON.parse(result.stdout || '[]');
    res.json({ success: true, networks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /networks/:name - Get network details
lxcRouter.get('/networks/:name', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid network name.' });
  }
  try {
    const result = await execOnHost(`incus network show ${name} --format json`, { timeout: 10000 });
    const network = JSON.parse(result.stdout || '{}');
    res.json({ success: true, network });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// PUT /networks/:name - Update network config
lxcRouter.put('/networks/:name', async (req, res) => {
  const { name } = req.params;
  const { config } = req.body;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid network name.' });
  }
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ success: false, error: 'Config object required.' });
  }
  try {
    for (const [key, value] of Object.entries(config)) {
      // Validate key format (only alphanumeric, dots, dashes)
      if (!/^[a-zA-Z0-9._-]+$/.test(key)) continue;
      const safeValue = String(value).replace(/['"\\]/g, '');
      await execOnHost(`incus network set ${name} ${key} ${safeValue}`, { timeout: 10000 });
    }
    res.json({ success: true, message: `Network '${name}' updated.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// POST /networks/:name/unset - Unset a network config key
lxcRouter.post('/networks/:name/unset', async (req, res) => {
  const { name } = req.params;
  const { key } = req.body;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid network name.' });
  }
  if (!key || !/^[a-zA-Z0-9._-]+$/.test(key)) {
    return res.status(400).json({ success: false, error: 'Invalid config key.' });
  }
  try {
    await execOnHost(`incus network unset ${name} ${key}`, { timeout: 10000 });
    res.json({ success: true, message: `Key '${key}' unset on network '${name}'.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /storage-pools - List storage pools
lxcRouter.get('/storage-pools', async (req, res) => {
  try {
    const result = await execOnHost('incus storage list --format json', { timeout: 10000 });
    const pools = JSON.parse(result.stdout || '[]');
    // Get usage info for each pool
    const poolsWithUsage = [];
    for (const pool of pools) {
      try {
        const infoResult = await execOnHost(`incus storage info ${pool.name} --format json`, { timeout: 10000 });
        const info = JSON.parse(infoResult.stdout || '{}');
        poolsWithUsage.push({ ...pool, info });
      } catch {
        poolsWithUsage.push(pool);
      }
    }
    res.json({ success: true, pools: poolsWithUsage });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /profiles - List profiles
lxcRouter.get('/profiles', async (req, res) => {
  try {
    const result = await execOnHost('incus profile list --format json', { timeout: 10000 });
    const profiles = JSON.parse(result.stdout || '[]');
    res.json({ success: true, profiles });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /profiles/:name - Get profile details
lxcRouter.get('/profiles/:name', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid profile name.' });
  }
  try {
    const result = await execOnHost(`incus query /1.0/profiles/${name}`, { timeout: 10000 });
    const profile = JSON.parse(result.stdout || '{}');
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /cached-images - List locally cached images
lxcRouter.get('/cached-images', async (req, res) => {
  try {
    const result = await execOnHost('incus image list --format json', { timeout: 15000 });
    const images = JSON.parse(result.stdout || '[]');
    res.json({ success: true, images });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// DELETE /cached-images/:fingerprint - Delete a cached image
lxcRouter.delete('/cached-images/:fingerprint', async (req, res) => {
  const { fingerprint } = req.params;
  if (!fingerprint || !/^[a-f0-9]+$/.test(fingerprint)) {
    return res.status(400).json({ success: false, error: 'Invalid image fingerprint.' });
  }
  try {
    await execOnHost(`incus image delete ${fingerprint}`, { timeout: 15000 });
    res.json({ success: true, message: 'Image deleted.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// ----------------------------------------------------------------------------
// Host Cleanup
// ----------------------------------------------------------------------------
//
// Surfaces three categories of safely-removable artifacts that
// accumulate on a ProxyPilot host over time. Two-step UX: GET
// /preview enumerates everything with sizes; POST /execute deletes
// only the categories the operator explicitly opts into.
//
// Excluded by design:
//   - The host's Docker daemon — ProxyPilot itself runs in Docker,
//     so a generic `docker system prune` from the dashboard could
//     wipe the dashboard. Per-LXC Docker prune is a separate
//     feature and belongs inside each container's own management
//     surface.
//   - LXC snapshots and storage volumes attached to instances —
//     operator data, never auto-prune.
//   - Caddy site files — already cleaned up by the container
//     delete handler.

const PP_SNAP_EXPORT_PREFIX = 'pp-snap-export-';
// Stale-cutoff for upload temp files. 24h is comfortably longer than
// any realistic import (50 GiB at 100 Mbit ≈ 70 min) so we never
// race a still-running upload, while still reclaiming disk from
// failed/cancelled uploads.
const IMPORT_TEMP_STALE_MS = 24 * 60 * 60 * 1000;

// GET /cleanup/preview - Enumerate cleanable artifacts.
lxcRouter.get('/cleanup/preview', async (req, res) => {
  const categories = [];

  // 1. Unused Incus images. `used_by` is empty when no instance is
  //    currently using the image. Auto-downloaded images
  //    accumulate every time an operator picks a different distro
  //    template — they're cheap to re-download and safe to remove.
  try {
    const r = await execOnHost('incus image list --format json 2>/dev/null', { timeout: 15000 });
    const images = JSON.parse(r.stdout || '[]');
    const unused = images.filter((img) => !Array.isArray(img.used_by) || img.used_by.length === 0);
    categories.push({
      key: 'images',
      label: 'Unused Incus images',
      description: 'Image cache entries not currently used by any container. Re-downloaded automatically when needed.',
      count: unused.length,
      bytes: unused.reduce((s, i) => s + (typeof i.size === 'number' ? i.size : 0), 0),
      items: unused.map((img) => ({
        id: img.fingerprint,
        label: (Array.isArray(img.aliases) && img.aliases[0]?.name) || (img.fingerprint || '').slice(0, 12),
        sublabel: img.update_source?.alias || img.properties?.description || null,
        size: typeof img.size === 'number' ? img.size : 0,
      })),
    });
  } catch (e) {
    categories.push({ key: 'images', label: 'Unused Incus images', count: 0, bytes: 0, items: [], error: (e.stderr || e.message || '').trim() });
  }

  // 2. Orphaned snapshot-export temp containers. The snapshot
  //    download endpoint creates pp-snap-export-<ts>-<rand> via
  //    `incus copy` and deletes it on every termination path,
  //    including client disconnect. If the backend itself crashes
  //    mid-export, the temp instance leaks — surface those here.
  try {
    const r = await execOnHost('incus list --format json 2>/dev/null', { timeout: 15000 });
    const containers = JSON.parse(r.stdout || '[]');
    const orphans = containers.filter((c) => typeof c.name === 'string' && c.name.startsWith(PP_SNAP_EXPORT_PREFIX));
    categories.push({
      key: 'exportTemps',
      label: 'Orphaned snapshot-export temp containers',
      description: 'Created by snapshot downloads; normally auto-cleaned on download finish or cancel. Leftovers usually mean the backend crashed mid-export.',
      count: orphans.length,
      bytes: 0,
      items: orphans.map((c) => ({
        id: c.name,
        label: c.name,
        sublabel: c.status || null,
        size: 0,
      })),
    });
  } catch (e) {
    categories.push({ key: 'exportTemps', label: 'Orphaned snapshot-export temp containers', count: 0, bytes: 0, items: [], error: (e.stderr || e.message || '').trim() });
  }

  // 3. Stale upload temp files. Multer disk-storage writes uploaded
  //    backups here before piping into incus import. The /import
  //    handler unlinks on every termination path, but a backend
  //    crash during the import phase leaves the tarball behind.
  try {
    let names = [];
    try { names = await readdir(LXC_IMPORT_TMP_DIR); } catch { names = []; }
    const cutoff = Date.now() - IMPORT_TEMP_STALE_MS;
    const stale = [];
    for (const name of names) {
      try {
        const s = await stat(join(LXC_IMPORT_TMP_DIR, name));
        if (s.isFile() && s.mtimeMs < cutoff) {
          stale.push({ id: name, label: name, sublabel: `modified ${new Date(s.mtimeMs).toISOString()}`, size: s.size });
        }
      } catch {}
    }
    categories.push({
      key: 'importTemps',
      label: 'Stale upload temp files (>24h)',
      description: `Buffered backup uploads in ${LXC_IMPORT_TMP_DIR}. Normally auto-deleted after import; older than 24h means a failed upload.`,
      count: stale.length,
      bytes: stale.reduce((s, i) => s + i.size, 0),
      items: stale,
    });
  } catch (e) {
    categories.push({ key: 'importTemps', label: 'Stale upload temp files (>24h)', count: 0, bytes: 0, items: [], error: e.message });
  }

  res.json({ success: true, categories });
});

// POST /cleanup/execute - Run the requested cleanup categories.
//
// Body: { categories: ['images', 'exportTemps', 'importTemps'] }
//
// Re-enumerates everything fresh (the preview snapshot may be stale
// by the time the operator clicks Clean Up — a download could have
// completed and reclaimed its temp instance, etc.) so we never
// delete something that just transitioned out of "orphaned" state.
// Each category is best-effort: a per-item failure is logged and
// reported but doesn't abort the rest of the run.
lxcRouter.post('/cleanup/execute', requireSudo, async (req, res) => {
  const { categories } = req.body || {};
  const allowed = new Set(['images', 'exportTemps', 'importTemps']);
  if (!Array.isArray(categories) || categories.length === 0 || categories.some((c) => !allowed.has(c))) {
    return res.status(400).json({ success: false, error: 'Invalid categories.' });
  }
  const selected = new Set(categories);
  const results = {};

  // 1. Unused Incus images.
  if (selected.has('images')) {
    const result = { removed: 0, freedBytes: 0, errors: [] };
    try {
      const r = await execOnHost('incus image list --format json 2>/dev/null', { timeout: 15000 });
      const images = JSON.parse(r.stdout || '[]');
      const unused = images.filter((img) => !Array.isArray(img.used_by) || img.used_by.length === 0);
      for (const img of unused) {
        try {
          await execOnHost(`incus image delete ${img.fingerprint}`, { timeout: 30000 });
          result.removed++;
          if (typeof img.size === 'number') result.freedBytes += img.size;
        } catch (e) {
          result.errors.push(`${img.fingerprint.slice(0, 12)}: ${(e.stderr || e.message || '').trim()}`);
        }
      }
    } catch (e) {
      result.errors.push(`enumerate failed: ${(e.stderr || e.message || '').trim()}`);
    }
    results.images = result;
  }

  // 2. Orphaned snapshot-export temp containers. Force-delete since
  //    they may be in a stopped/created state from a crashed export.
  if (selected.has('exportTemps')) {
    const result = { removed: 0, freedBytes: 0, errors: [] };
    try {
      const r = await execOnHost('incus list --format json 2>/dev/null', { timeout: 15000 });
      const containers = JSON.parse(r.stdout || '[]');
      const orphans = containers.filter((c) => typeof c.name === 'string' && c.name.startsWith(PP_SNAP_EXPORT_PREFIX));
      for (const c of orphans) {
        try {
          await execOnHost(`incus delete ${c.name} --force`, { timeout: 60000 });
          result.removed++;
        } catch (e) {
          result.errors.push(`${c.name}: ${(e.stderr || e.message || '').trim()}`);
        }
      }
    } catch (e) {
      result.errors.push(`enumerate failed: ${(e.stderr || e.message || '').trim()}`);
    }
    results.exportTemps = result;
  }

  // 3. Stale upload temp files. Re-stat each before unlink so a
  //    file that was just modified by an in-flight upload is left
  //    alone even if it was in the preview list.
  if (selected.has('importTemps')) {
    const result = { removed: 0, freedBytes: 0, errors: [] };
    try {
      let names = [];
      try { names = await readdir(LXC_IMPORT_TMP_DIR); } catch { names = []; }
      const cutoff = Date.now() - IMPORT_TEMP_STALE_MS;
      for (const name of names) {
        const path = join(LXC_IMPORT_TMP_DIR, name);
        try {
          const s = await stat(path);
          if (!s.isFile() || s.mtimeMs >= cutoff) continue;
          await unlink(path);
          result.removed++;
          result.freedBytes += s.size;
        } catch (e) {
          result.errors.push(`${name}: ${e.message}`);
        }
      }
    } catch (e) {
      result.errors.push(`enumerate failed: ${e.message}`);
    }
    results.importTemps = result;
  }

  res.json({ success: true, results });
});
