// Migration planning — the target spec, the phase machine, the command the
// operator pastes on the source, and the post-import checklist. Pure.
//
// Two modes, one agent:
//
//   whole-machine   the source IS the thing being moved. The agent wraps the
//                   official `incus-migrate` and streams the disk (VM) or the
//                   rootfs (container) into Incus. A Proxmox LXC, where
//                   incus-migrate cannot run inside the guest, takes the
//                   `rootfs-tar` path instead: tar → ProxyPilot → incus import.
//
//   application     the source keeps running. ProxyPilot creates a fresh
//                   guest; the agent streams the application directories to
//                   ProxyPilot as tarballs and ProxyPilot unpacks them into
//                   the guest through `incus exec`, then the database dump
//                   travels the same way and is restored inside the guest.
//                   Env VALUES are typed by the operator, never read.
//
//                   (The brief said rsync. rsync needs a reachable sshd and a
//                   key in the target guest — a package and an open port
//                   ProxyPilot would be adding to a guest that did not ask
//                   for either, when `incus exec` already reaches it. The
//                   final delta sync keeps its meaning: the second pass tars
//                   only what changed since the first, with --newer-mtime.)
//
// Nothing here executes anything: routes/migrations.js turns these
// structures into API responses and lib/migration/service.js persists them.

import { DEFAULT_RSYNC_EXCLUDES } from './manifest.js';

export const MODES = Object.freeze(['whole-machine', 'application']);
export const TRANSPORTS = Object.freeze(['incus-migrate', 'rootfs-tar', 'file-sync']);
export const GUEST_TYPES = Object.freeze(['container', 'virtual-machine']);

/** Ordered phases. `get_migration` reports the current one plus bytes/rate/ETA. */
export const PHASES = Object.freeze([
  { id: 'inventory', title: 'Inventory', detail: 'The agent reads the source and sends the manifest. Nothing is copied.' },
  { id: 'transfer', title: 'Transfer', detail: 'The disk, rootfs or application directories stream from the source.' },
  { id: 'import', title: 'Import', detail: 'ProxyPilot turns what arrived into an Incus guest (or finishes the incus-migrate handover).' },
  { id: 'post-import', title: 'Post-import', detail: 'The guest exists, stopped or fenced: no route, default-deny egress, nothing published.' },
  { id: 'cutover', title: 'Cutover', detail: 'The operator works the checklist: snapshot, route, egress, secrets, health, DNS, freeze the source, verify.' },
]);
export const PHASE_IDS = Object.freeze(PHASES.map((p) => p.id));

export const STATUSES = Object.freeze(['created', 'running', 'awaiting_review', 'ready', 'completed', 'failed', 'cancelled']);
export const TERMINAL = Object.freeze(['completed', 'failed', 'cancelled']);

const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const POOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const ABS_PATH_RE = /^\/[^\0\n]*$/;

const intIn = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };

/**
 * validateTarget(input) → { spec } | { error }
 *
 * `input` is what the operator (or an MCP caller) supplied. The result is the
 * whole plan: mode, transport, the guest ProxyPilot will end up with, and —
 * for application mode — what gets copied.
 */
export function validateTarget(input = {}) {
  const mode = String(input.mode || '');
  if (!MODES.includes(mode)) return { error: `mode must be one of ${MODES.join(', ')}` };

  const name = String(input.name || '');
  if (!NAME_RE.test(name)) return { error: 'name: the guest name, letters/digits/hyphens (ProxyPilot adds the pp- prefix)' };

  const type = String(input.type || 'container');
  if (!GUEST_TYPES.includes(type)) return { error: `type must be ${GUEST_TYPES.join(' or ')}` };

  const sourceKind = String(input.source_kind || 'unknown');
  const transport = resolveTransport({ mode, type, sourceKind, requested: input.transport });
  if (!transport) return { error: `transport must be one of ${TRANSPORTS.join(', ')} (or omitted, and it is derived from the mode)` };
  if (mode === 'application' && transport !== 'file-sync') return { error: 'application mode always transports with file-sync (tarballs through ProxyPilot into the guest)' };
  if (mode === 'whole-machine' && transport === 'file-sync') return { error: 'whole-machine mode transports with incus-migrate, or rootfs-tar for a Proxmox LXC' };
  if (transport === 'rootfs-tar' && type !== 'container') return { error: 'rootfs-tar imports a container; a VM disk goes through incus-migrate' };

  const cpu = input.cpu == null ? 2 : intIn(input.cpu, 1, 128);
  if (cpu == null) return { error: 'cpu: a whole number of vCPUs, 1–128' };
  const memoryGb = input.memory_gb == null ? 4 : Number(input.memory_gb);
  if (!Number.isFinite(memoryGb) || memoryGb < 0.25 || memoryGb > 1024) return { error: 'memory_gb: 0.25–1024' };
  const diskGb = input.disk_gb == null ? null : intIn(input.disk_gb, 1, 8192);
  if (input.disk_gb != null && diskGb == null) return { error: 'disk_gb: a whole number of GB, 1–8192' };
  if (type === 'virtual-machine' && !diskGb) return { error: 'disk_gb is required for a virtual machine — the disk is created before the stream starts' };

  const pool = input.pool == null || input.pool === '' ? null : String(input.pool);
  if (pool && !POOL_RE.test(pool)) return { error: 'pool: an Incus storage pool name' };
  const network = input.network == null || input.network === '' ? null : String(input.network);
  if (network && !POOL_RE.test(network)) return { error: 'network: an Incus network (bridge) name' };

  const app = { dirs: [], excludes: [...DEFAULT_RSYNC_EXCLUDES], database: 'none', service_name: null, image: null };
  if (mode === 'application') {
    for (const d of Array.isArray(input.app_dirs) ? input.app_dirs : []) {
      const p = String(d);
      if (!ABS_PATH_RE.test(p)) return { error: `app_dirs: ${JSON.stringify(d)} is not an absolute path` };
      if (p === '/' || /(^|\/)\.\.(\/|$)/.test(p)) return { error: `app_dirs: ${p} is refused — name the application's own directories, not / or a parent traversal` };
      app.dirs.push(p.replace(/\/+$/, '') || '/');
    }
    for (const e of Array.isArray(input.excludes) ? input.excludes : []) {
      const s = String(e).trim();
      if (!s || s.length > 200 || s.includes('\n')) return { error: 'excludes: one tar/rsync-style pattern per entry' };
      if (!app.excludes.includes(s)) app.excludes.push(s);
    }
    const db = String(input.database || 'none');
    if (!['none', 'postgres', 'mysql', 'sqlite'].includes(db)) return { error: 'database must be none, postgres, mysql or sqlite' };
    app.database = db;
    if (input.service_name != null && input.service_name !== '') {
      const s = String(input.service_name);
      if (!/^[A-Za-z0-9@._-]{1,128}$/.test(s)) return { error: 'service_name: the systemd unit that runs the app on the source' };
      app.service_name = s;
    }
    const image = String(input.image || 'images:debian/13');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:+/-]{2,120}$/.test(image)) return { error: 'image: an Incus image alias, e.g. images:debian/13' };
    app.image = image;
  }

  return {
    spec: {
      mode, transport, name, type, cpu, memory_gb: memoryGb, disk_gb: diskGb, pool, network,
      nested: input.nested === true,
      source_kind: sourceKind,
      source_label: input.source_label == null ? null : String(input.source_label).slice(0, 200),
      app: mode === 'application' ? app : null,
      auto_transfer: input.auto_transfer === true,
      keep_agent: input.keep_agent === true,
      // The agent may install what the transfer needs on the source (zstd,
      // so a big rootfs compresses on every core). Default on; off is for a
      // source nobody may touch, and costs a gzip-speed transfer.
      install_tools: input.install_tools !== false,
      freeze: ['stop', 'read-only', 'none'].includes(String(input.freeze)) ? String(input.freeze) : 'stop',
    },
  };
}

function resolveTransport({ mode, type, sourceKind, requested }) {
  if (requested) return TRANSPORTS.includes(String(requested)) ? String(requested) : null;
  if (mode === 'application') return 'file-sync';
  // A container source defaults to the tarball, not incus-migrate: tar is on
  // every machine, incus-migrate is a package a Proxmox host does not have
  // (and may not be able to install), and incus-migrate needs the source to
  // reach the Incus API directly while the tar goes through ProxyPilot, which
  // the source is already talking to. Asking for incus-migrate explicitly
  // still works for a container — it just asks more of the source.
  if (type === 'container' && ['proxmox-lxc', 'lxc'].includes(sourceKind)) return 'rootfs-tar';
  return 'incus-migrate';
}

/** The Incus guest ProxyPilot will end up with, as config keys. */
export function guestConfig(spec, { prefix = 'pp-' } = {}) {
  const cfg = {
    'limits.cpu': String(spec.cpu),
    'limits.memory': `${spec.memory_gb}GB`,
    'boot.autostart': 'false',
  };
  if (spec.nested) {
    cfg['security.nesting'] = 'true';
    cfg['security.syscalls.intercept.mknod'] = 'true';
    cfg['security.syscalls.intercept.setxattr'] = 'true';
    cfg['security.syscalls.intercept.bpf'] = 'true';
    cfg['security.syscalls.intercept.bpf.devices'] = 'true';
  }
  return { incus_name: `${prefix}${spec.name}`, type: spec.type, pool: spec.pool, network: spec.network, disk_gb: spec.disk_gb, config: cfg };
}

/* --------------------------- the pasted command -------------------------- */

/**
 * What the operator runs on the source, as one line. The bootstrap script is
 * served from the tokened URL, carries the TLS pin and the per-arch sha256,
 * verifies the binary it downloads before running it, and never touches a
 * disk on its own.
 */
export function installCommand({ baseUrl, token }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `curl -fsSL ${base}/api/migrations/agent/${token}/install.sh | sudo sh`;
}

/** The same thing without a pipe-to-shell, for operators who want to read it first. */
export function installCommandTwoStep({ baseUrl, token }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return [
    `curl -fsSL -o /tmp/proxypilot-migrate.sh ${base}/api/migrations/agent/${token}/install.sh`,
    'less /tmp/proxypilot-migrate.sh   # read it',
    'sudo sh /tmp/proxypilot-migrate.sh',
  ];
}

/* ------------------------------- checklist ------------------------------- */

/**
 * The post-import checklist. It is STATE, not prose: each step is stored with
 * who completed it and when, so a cutover survives a page reload, a shift
 * change and an audit. `required` steps gate `completed`.
 */
export const CHECKLIST = Object.freeze([
  { id: 'snapshot_pre_cutover', title: 'Snapshot the guest before cutover', required: true, modes: ['whole-machine', 'application'], tool: 'snapshot_lxc_container', detail: 'A restore point taken while nothing points at the new guest yet.' },
  { id: 'inventory_reviewed', title: 'Review the inventory', required: true, modes: ['whole-machine', 'application'], tool: 'get_migration', detail: 'Units, ports, vhosts, databases, cron, TLS material and env files as found on the source.' },
  { id: 'route_created', title: 'Create the route', required: true, modes: ['whole-machine', 'application'], tool: 'set_route', detail: 'Publish the guest behind Caddy. Until this step the guest answers nothing from outside.' },
  { id: 'egress_reviewed', title: 'Review outbound access', required: true, modes: ['whole-machine', 'application'], tool: 'set_lxc_egress', detail: 'The guest starts default-deny. Approve the observed hosts it actually needs, one at a time.' },
  { id: 'secrets_entered', title: 'Enter the secrets', required: true, modes: ['whole-machine', 'application'], tool: 'set_project_env', detail: 'ProxyPilot knows the KEY NAMES from the source .env files; you type the values. They were never read.' },
  { id: 'health_check', title: 'Health check green', required: true, modes: ['whole-machine', 'application'], tool: 'probe_lxc_port', detail: 'The app answers inside the guest on the port the manifest said it listens on.' },
  { id: 'final_delta_sync', title: 'Final delta sync', required: true, modes: ['application'], tool: 'migration_cutover', detail: 'One more pass with the source application stopped — only what changed since the first copy, plus a fresh dump — so nothing written in between is lost.' },
  { id: 'dns_switched', title: 'Switch DNS', required: true, modes: ['whole-machine', 'application'], tool: 'set_dns_record', detail: 'Point the name at this host. Lower the TTL well before this step.' },
  { id: 'source_frozen', title: 'Freeze the source', required: true, modes: ['whole-machine', 'application'], tool: 'migration_cutover', detail: 'Stop the source service (or set it read-only) so two copies never both take writes.' },
  { id: 'verified', title: 'Verify through the route', required: true, modes: ['whole-machine', 'application'], tool: 'test_route', detail: 'The published domain answers from outside, with the certificate ProxyPilot issued.' },
  { id: 'snapshot_post_cutover', title: 'Snapshot after cutover', required: true, modes: ['whole-machine', 'application'], tool: 'snapshot_lxc_container', detail: 'The first restore point of the guest carrying live traffic.' },
]);

/** The checklist for one mode, with the stored state folded in. */
export function checklistFor(mode, state = {}) {
  return CHECKLIST.filter((s) => s.modes.includes(mode)).map((s) => {
    const done = state[s.id] || null;
    return { ...s, modes: undefined, done: !!done, done_at: done?.at || null, done_by: done?.by || null, note: done?.note || null };
  });
}

/** Are all the required steps done? (What `completed` means.) */
export function checklistComplete(mode, state = {}) {
  return checklistFor(mode, state).filter((s) => s.required).every((s) => s.done);
}

export function checklistProgress(mode, state = {}) {
  const rows = checklistFor(mode, state);
  return { total: rows.length, done: rows.filter((r) => r.done).length, remaining: rows.filter((r) => !r.done).map((r) => r.id) };
}

/* ------------------------------- progress -------------------------------- */

/**
 * bytes → rate → ETA from the agent's progress events. `samples` are
 * { at (ms), bytes } in arrival order; the rate is measured over the last
 * window rather than the whole run, so a stall shows up as a stall instead of
 * being averaged away by a fast start.
 */
export function transferProgress({ samples = [], total_bytes = null, windowMs = 60000, now = Date.now() } = {}) {
  const pts = samples.filter((s) => Number.isFinite(s.at) && Number.isFinite(s.bytes)).sort((a, b) => a.at - b.at);
  const last = pts[pts.length - 1] || null;
  if (!last) return { bytes: 0, total_bytes, percent: null, rate_bps: null, eta_seconds: null, stalled: false, samples: 0 };
  const first = pts.find((p) => p.at >= last.at - windowMs) || pts[0];
  const dt = (last.at - first.at) / 1000;
  const db = last.bytes - first.bytes;
  const rate = dt > 0 && db > 0 ? db / dt : null;
  const remaining = total_bytes != null && total_bytes > last.bytes ? total_bytes - last.bytes : null;
  return {
    bytes: last.bytes, total_bytes,
    percent: total_bytes ? Math.min(100, Math.round((last.bytes / total_bytes) * 1000) / 10) : null,
    rate_bps: rate ? Math.round(rate) : null,
    eta_seconds: rate && remaining ? Math.round(remaining / rate) : null,
    // No new bytes for two windows while the phase is still transfer: the
    // operator should hear that from us, not from a progress bar that simply
    // stopped moving.
    stalled: now - last.at > windowMs * 2,
    last_at: new Date(last.at).toISOString(), samples: pts.length,
  };
}

/** Which status a phase transition lands in (the machine, in one place). */
export function nextStatus({ status, phase, manifestReceived = false, approved = false }) {
  if (TERMINAL.includes(status)) return status;
  if (phase === 'inventory') return manifestReceived && !approved ? 'awaiting_review' : 'running';
  if (phase === 'cutover') return 'ready';
  if (phase === 'post-import') return 'ready';
  return 'running';
}

/** Is this transition allowed? Keeps a replayed or out-of-order event from rewinding a run. */
export function canAdvance(fromPhase, toPhase) {
  const a = PHASE_IDS.indexOf(String(fromPhase));
  const b = PHASE_IDS.indexOf(String(toPhase));
  return a >= 0 && b >= 0 && b >= a;
}
