// ZFS storage management — the PURE planner.
//
// Every mutating storage verb (REST and MCP alike) is a plan first: a list
// of argv steps computed from the current inventory and the caller's
// parameters. The plan is what the operator sees in the confirm dialog, and
// its sha256 is the token the real call must carry — so a plan that would
// differ from the one the operator approved (a device that moved, a dataset
// that appeared, a parameter that changed) invalidates the token by
// construction. Nothing here touches the host: it takes parsed inventory in,
// gives { plan } or { error } out, and is unit-tested against fixtures.
//
// Placeholders: a step may carry `{{stamp}}` in an argv element; the executor
// substitutes one timestamp per run so snapshot names are unique while the
// plan (and its token) stays byte-identical between dry_run and apply.

import { createHash } from 'node:crypto';

/* -------------------------------- names ---------------------------------- */

export const POOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,254}$/;
export const DATASET_RE = /^[A-Za-z][A-Za-z0-9_.:-]*(\/[A-Za-z0-9_.:-]+)*$/;
export const SNAPSHOT_NAME_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
export const INCUS_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
export const REPLICATION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const RESERVED_POOL_NAMES = /^(mirror|raidz[123]?|draid[123]?|spare|log|cache|special|dedup|c\d)$/;
export const BY_ID_PREFIX = '/dev/disk/by-id/';

export function validPoolName(s) {
  const n = String(s || '');
  return POOL_NAME_RE.test(n) && !RESERVED_POOL_NAMES.test(n) ? n : null;
}
export function validDataset(s) {
  const n = String(s || '');
  return DATASET_RE.test(n) && n.length <= 255 && !n.includes('//') ? n : null;
}
export function validSnapshotName(s) {
  const n = String(s || '');
  return SNAPSHOT_NAME_RE.test(n) ? n : null;
}
export function splitSnapshot(full) {
  const s = String(full || '');
  const i = s.indexOf('@');
  if (i <= 0) return null;
  const dataset = validDataset(s.slice(0, i)); const snap = validSnapshotName(s.slice(i + 1));
  return dataset && snap ? { dataset, snapshot: snap, name: `${dataset}@${snap}` } : null;
}

/* ------------------------------- sizes ---------------------------------- */

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([kmgtpKMGTP]?)(?:i?[bB])?$/;
/** "10G" / "512M" / "1.5T" / "none" → bytes (null for none), or undefined when malformed. */
export function parseSize(v) {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (s === 'none' || s === '0') return null;
  const m = s.match(SIZE_RE);
  if (!m) return undefined;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/* ---------------------------- dataset properties ------------------------- */

const SIZE_OR_NONE = (v) => parseSize(v) !== undefined;
const ONOFF = (v) => /^(on|off)$/.test(v);
export const DATASET_PROP_RULES = Object.freeze({
  compression: (v) => /^(on|off|lz4|lzjb|zle|gzip(-[1-9])?|zstd(-(fast(-\d+)?|\d+))?)$/.test(v),
  atime: ONOFF, relatime: ONOFF, readonly: ONOFF, exec: ONOFF, setuid: ONOFF, devices: ONOFF, nbmand: ONOFF, overlay: ONOFF,
  quota: SIZE_OR_NONE, refquota: SIZE_OR_NONE, reservation: SIZE_OR_NONE, refreservation: SIZE_OR_NONE,
  recordsize: (v) => /^(512|1K|2K|4K|8K|16K|32K|64K|128K|256K|512K|1M|2M|4M|8M|16M)$/i.test(v),
  mountpoint: (v) => v === 'none' || v === 'legacy' || (/^\/[^\0]*$/.test(v) && !v.includes('..')),
  canmount: (v) => /^(on|off|noauto)$/.test(v),
  snapdir: (v) => /^(hidden|visible)$/.test(v),
  sync: (v) => /^(standard|always|disabled)$/.test(v),
  logbias: (v) => /^(latency|throughput)$/.test(v),
  primarycache: (v) => /^(all|none|metadata)$/.test(v),
  secondarycache: (v) => /^(all|none|metadata)$/.test(v),
  xattr: (v) => /^(on|off|sa)$/.test(v),
  acltype: (v) => /^(off|noacl|nfsv4|posix|posixacl)$/.test(v),
  dnodesize: (v) => /^(legacy|auto|1k|2k|4k|8k|16k)$/.test(v),
  copies: (v) => /^[123]$/.test(v),
  dedup: (v) => /^(on|off|verify|sha256|sha256,verify|sha512|sha512,verify|skein|skein,verify|edonr,verify|blake3|blake3,verify)$/.test(v),
  checksum: (v) => /^(on|off|fletcher2|fletcher4|sha256|sha512|skein|edonr|blake3)$/.test(v),
  'com.sun:auto-snapshot': (v) => /^(true|false)$/.test(v),
});

/** Validate a { prop: value } map. Returns { props } (stringified) or { error }. */
export function validateDatasetProps(input, { allowMountpoint = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'props must be an object of { property: value }' };
  const props = {};
  for (const [k, raw] of Object.entries(input)) {
    const rule = DATASET_PROP_RULES[k];
    if (!rule) return { error: `property ${k} is not settable here (allowed: ${Object.keys(DATASET_PROP_RULES).join(', ')})` };
    if (k === 'mountpoint' && !allowMountpoint) return { error: 'mountpoint cannot be changed on this dataset' };
    const v = String(raw).trim();
    if (!v || !rule(v)) return { error: `property ${k}: value ${JSON.stringify(raw)} is not valid` };
    props[k] = v;
  }
  if (!Object.keys(props).length) return { error: 'props is empty' };
  return { props };
}

/* ------------------------------- eligibility ----------------------------- */

/**
 * May this whole disk become a pool member? `hard` reasons have no override
 * at all; `soft` reasons are cleared by wipe: true (plus the plan token).
 */
export function deviceEligibility(device, { wipe = false } = {}) {
  const hard = []; const soft = []; const warnings = [];
  if (!device) return { eligible: false, hard: ['device not found'], soft: [], warnings: [] };
  if (device.os) hard.push(`OS device (${device.os_reason || 'backs the root filesystem'})`);
  if (device.mounted) hard.push(`has a mounted filesystem (${device.mounted_at.join(', ')}) — unmount it first`);
  if (device.in_pool) hard.push(`is a member of the imported ZFS pool ${device.in_pool}`);
  if (device.has_holders) hard.push('is in use by an md array, LVM volume group or device-mapper target — stop that first');
  if (device.read_only) hard.push('is read-only');
  if (device.importable_pool) soft.push(`holds the importable ZFS pool ${device.importable_pool.name} (${device.importable_pool.state || 'state unknown'})`);
  for (const s of device.signatures || []) {
    if (s === 'zfs_member' && device.importable_pool) continue;
    soft.push(`carries a ${s} signature`);
  }
  if (device.removable) warnings.push('is removable / hot-pluggable');
  if (device.smart_verdict?.level === 'fail') warnings.push(`SMART reports failure: ${device.smart_verdict.reason}`);
  else if (device.smart_verdict?.level === 'warn') warnings.push(`SMART warning: ${device.smart_verdict.reason}`);
  const blocked = hard.length ? hard : (!wipe && soft.length ? soft : []);
  return { eligible: blocked.length === 0, hard, soft, warnings, needs_wipe: hard.length === 0 && soft.length > 0 };
}

/** Resolve a /dev/disk/by-id path to a whole disk from the inventory, or an error string. */
export function resolveByIdDevice(devices, byIdPath) {
  const p = String(byIdPath || '');
  if (!p.startsWith(BY_ID_PREFIX) || p.includes('..') || /\s/.test(p)) return { error: `${p || '(empty)'}: devices must be given as ${BY_ID_PREFIX}… paths (list_disks shows them)` };
  for (const d of devices) {
    if ((d.by_id || []).includes(p)) return { device: d };
    if (d.partitions.some((pt) => (pt.by_id || []).includes(p))) return { error: `${p} is a partition of ${d.path}; pools are built from whole disks` };
  }
  return { error: `${p} is not a known whole disk on this host` };
}

/* --------------------------------- layouts ------------------------------- */

export const LAYOUTS = Object.freeze({
  single: { min: 1, redundancy: 0, note: 'no redundancy — one device failure loses the pool' },
  mirror: { min: 2, redundancy: 1, note: 'n-way mirror per vdev' },
  raidz1: { min: 3, redundancy: 1, note: 'single parity per vdev' },
  raidz2: { min: 4, redundancy: 2, note: 'double parity per vdev' },
  raidz3: { min: 5, redundancy: 3, note: 'triple parity per vdev' },
});

/**
 * Normalize layout + devices into vdev groups. `vdevs` is an array of arrays
 * (one per vdev); a flat `devices` list is one vdev (or, for `single`, one
 * vdev per device = a stripe). Returns { layout, groups, warnings } or { error }.
 */
export function validateLayout({ layout = 'single', vdevs = null, devices = null } = {}) {
  const l = String(layout || 'single');
  const spec = LAYOUTS[l];
  if (!spec) return { error: `layout must be one of ${Object.keys(LAYOUTS).join(', ')}` };
  let groups;
  if (Array.isArray(vdevs) && vdevs.length) {
    if (!vdevs.every((g) => Array.isArray(g) && g.length)) return { error: 'vdevs must be an array of non-empty device arrays' };
    groups = vdevs.map((g) => g.map(String));
  } else if (Array.isArray(devices) && devices.length) {
    groups = l === 'single' ? devices.map((d) => [String(d)]) : [devices.map(String)];
  } else return { error: 'devices (or vdevs) is required' };
  const warnings = [];
  const all = groups.flat();
  if (new Set(all).size !== all.length) return { error: 'a device is listed more than once' };
  for (const [i, g] of groups.entries()) {
    if (l === 'single' && g.length !== 1) return { error: `layout single takes one device per vdev (vdev ${i + 1} has ${g.length})` };
    if (g.length < spec.min) return { error: `${l} needs at least ${spec.min} devices per vdev (vdev ${i + 1} has ${g.length})` };
  }
  if (l === 'single') warnings.push(all.length > 1 ? `stripe of ${all.length} devices: ${spec.note}` : spec.note);
  if (groups.length > 1 && new Set(groups.map((g) => g.length)).size > 1) warnings.push('vdevs are of different widths');
  return { layout: l, groups, warnings };
}

/* ------------------------------ plan mechanics --------------------------- */

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/** The token is the sha256 of the canonical plan: same plan → same token; any change → a different one. */
export function planToken(plan) {
  return createHash('sha256').update(canonical(plan)).digest('hex');
}

/** Compare a presented token against the freshly computed plan. */
export function verifyPlanToken(plan, token) {
  const want = planToken(plan);
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return { ok: false, error: 'plan_token is missing or malformed — call with dry_run: true to get the plan and its token', token: want };
  if (token !== want) return { ok: false, error: 'plan_token does not match the current plan: the host state or the parameters changed since the dry run. Re-run dry_run, review the new plan, and confirm again.', token: want };
  return { ok: true, token: want };
}

let seq = 0;
function step(argv, description, extra = {}) {
  seq += 1;
  return { id: `s${seq}`, argv: argv.map(String), description, stdin: null, timeout_ms: 120000, ignore_failure: false, kind: 'exec', ...extra };
}
function newPlan(op, subject, summary, extra = {}) {
  seq = 0;
  return { op, subject, summary, steps: [], warnings: [], reversal: null, touches: [], ...extra };
}
function shellArgv(script, args, descr, extra = {}) {
  return step(['sh', '-c', script, 'sh', ...args], descr, extra);
}
export function renderPlanCommands(plan) {
  return plan.steps.map((s) => (s.stdin ? `${shellQuote(s.argv)}  # stdin: ${s.stdin}` : shellQuote(s.argv)));
}
export function shellQuote(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./{}-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`)).join(' ');
}

/* ---------------------------- pool: create ------------------------------- */

export const POOL_DEFAULTS = Object.freeze({ ashift: 12, compression: 'zstd', atime: 'off', xattr: 'sa', acltype: 'posixacl', dnodesize: 'auto' });
export const MANAGED_DATASETS = Object.freeze({ incus: 'incus', backups: 'backups', exports: 'exports' });

/**
 * planCreateZpool(inventory, params)
 *   inventory: { devices (buildDeviceInventory), pools (zpool list), datasets }
 *   params: { name, layout, devices | vdevs, ashift, compression, atime, xattr, mountpoint, encryption, wipe, managed }
 *   encryption: { keyformat: 'passphrase' } (the passphrase arrives on stdin at apply time, never in the plan)
 *            or { keyformat: 'raw'|'hex'|'passphrase', keylocation: 'file:///abs/path' }
 */
export function planCreateZpool(inv, params = {}) {
  const name = validPoolName(params.name);
  if (!name) return { error: 'name: 1–255 chars, letter first, [A-Za-z0-9_.:-], not a reserved vdev word' };
  if ((inv.pools || []).some((p) => p.name === name)) return { error: `pool ${name} already exists` };
  if ((inv.importable || []).some((p) => p.name === name)) return { error: `an exported pool named ${name} is importable — import_pool it or pick another name` };
  const lay = validateLayout(params);
  if (lay.error) return lay;
  const wipe = params.wipe === true;
  const resolved = []; const problems = []; const warnings = [...lay.warnings];
  for (const g of lay.groups) {
    const grp = [];
    for (const id of g) {
      const r = resolveByIdDevice(inv.devices || [], id);
      if (r.error) { problems.push(r.error); continue; }
      const e = deviceEligibility(r.device, { wipe });
      if (!e.eligible) problems.push(`${id} (${r.device.path}): ${(e.hard.length ? e.hard : e.soft).join('; ')}${!e.hard.length && e.soft.length ? ' — pass wipe: true to clear it' : ''}`);
      for (const w of e.warnings) warnings.push(`${r.device.path} ${w}`);
      grp.push({ id, device: r.device, wipe: e.needs_wipe && wipe });
    }
    resolved.push(grp);
  }
  if (problems.length) return { error: `refused: ${problems.join(' | ')}` };
  const sizes = resolved.flat().map((d) => d.device.size_bytes).filter((n) => n);
  if (sizes.length > 1 && Math.max(...sizes) / Math.min(...sizes) > 1.05 && lay.layout !== 'single') warnings.push(`devices differ in size (${fmtBytes(Math.min(...sizes))}–${fmtBytes(Math.max(...sizes))}); ZFS uses the smallest per vdev`);
  const ashift = params.ashift == null ? POOL_DEFAULTS.ashift : Number(params.ashift);
  if (!Number.isInteger(ashift) || ashift < 9 || ashift > 16) return { error: 'ashift must be an integer 9–16 (12 = 4 KiB sectors, the default)' };
  const propsIn = { compression: params.compression ?? POOL_DEFAULTS.compression, atime: params.atime ?? POOL_DEFAULTS.atime, xattr: params.xattr ?? POOL_DEFAULTS.xattr, acltype: POOL_DEFAULTS.acltype, dnodesize: POOL_DEFAULTS.dnodesize };
  if (params.mountpoint != null) propsIn.mountpoint = params.mountpoint;
  const vp = validateDatasetProps(propsIn);
  if (vp.error) return vp;
  const props = vp.props;
  let stdin = null; const enc = params.encryption;
  if (enc && typeof enc === 'object') {
    const kf = String(enc.keyformat || 'passphrase');
    if (!['passphrase', 'raw', 'hex'].includes(kf)) return { error: 'encryption.keyformat must be passphrase, raw or hex' };
    props.encryption = 'on'; props.keyformat = kf;
    if (enc.keylocation) {
      const kl = String(enc.keylocation);
      if (!/^file:\/\/\/[^\s]+$/.test(kl) || kl.includes('..')) return { error: 'encryption.keylocation must be file:///absolute/path (the key file is never read or stored by ProxyPilot)' };
      props.keylocation = kl;
    } else {
      if (kf !== 'passphrase') return { error: 'raw / hex keys need encryption.keylocation = file:///path' };
      props.keylocation = 'prompt';
      stdin = 'passphrase';
    }
  } else if (enc != null && enc !== false) return { error: 'encryption must be an object ({ keyformat, keylocation }) or omitted' };
  const plan = newPlan('create_zpool', name, `Create ZFS pool ${name}: ${lay.layout} × ${lay.groups.length} vdev(s), ${resolved.flat().length} device(s), ashift=${ashift}, ${props.compression}${props.encryption ? ', encrypted' : ''}`);
  plan.warnings = warnings;
  plan.layout = { layout: lay.layout, vdevs: resolved.map((g) => g.map((d) => ({ id: d.id, path: d.device.path, size_bytes: d.device.size_bytes, model: d.device.model, serial: d.device.serial, wipe: d.wipe }))) };
  for (const d of resolved.flat()) {
    if (!d.wipe) continue;
    if ((d.device.signatures || []).includes('zfs_member')) plan.steps.push(step(['zpool', 'labelclear', '-f', d.id], `Clear ZFS labels on ${d.device.path}`, { ignore_failure: true }));
    plan.steps.push(step(['wipefs', '-a', d.id], `Wipe every signature on ${d.device.path} (${(d.device.signatures || []).join(', ') || 'partition table'})`));
  }
  const argv = ['zpool', 'create', '-o', `ashift=${ashift}`];
  for (const [k, v] of Object.entries(props)) argv.push('-O', `${k}=${v}`);
  argv.push(name);
  for (const g of resolved) {
    if (lay.layout !== 'single') argv.push(lay.layout);
    for (const d of g) argv.push(d.id);
  }
  plan.steps.push(step(argv, `Create the pool${stdin ? ' (passphrase on stdin)' : ''}`, { stdin, timeout_ms: 600000 }));
  if (params.managed !== false) {
    for (const [key, ds] of Object.entries(MANAGED_DATASETS)) plan.steps.push(step(['zfs', 'create', `${name}/${ds}`], `Create the managed ${key} dataset ${name}/${ds}`));
    plan.managed_datasets = Object.fromEntries(Object.entries(MANAGED_DATASETS).map(([k, ds]) => [k, `${name}/${ds}`]));
  }
  plan.steps.push(step(['zpool', 'status', '-P', name], 'Verify the pool came up', { kind: 'verify' }));
  plan.reversal = `zpool destroy ${name}`;
  plan.touches = resolved.flat().map((d) => d.device.path);
  return { plan };
}

/* ---------------------------- datasets ----------------------------------- */

export function planCreateDataset(inv, params = {}) {
  const name = validDataset(params.name);
  if (!name || !name.includes('/')) return { error: 'name must be pool/child[/...]' };
  const parent = name.slice(0, name.lastIndexOf('/'));
  if (!(inv.datasets || []).some((d) => d.name === parent)) return { error: `parent dataset ${parent} does not exist` };
  if ((inv.datasets || []).some((d) => d.name === name)) return { error: `dataset ${name} already exists` };
  let props = {};
  if (params.props) { const vp = validateDatasetProps(params.props); if (vp.error) return vp; props = vp.props; }
  const plan = newPlan('create_dataset', name, `Create dataset ${name}${Object.keys(props).length ? ` (${Object.entries(props).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`);
  const argv = ['zfs', 'create'];
  if (params.volume_size) { const b = parseSize(params.volume_size); if (!b) return { error: 'volume_size must be a size like 10G' }; argv.push('-V', String(params.volume_size)); if (params.sparse === true) argv.push('-s'); }
  for (const [k, v] of Object.entries(props)) argv.push('-o', `${k}=${v}`);
  argv.push(name);
  plan.steps.push(step(argv, params.volume_size ? 'Create the zvol' : 'Create the dataset'));
  plan.reversal = `zfs destroy ${name}`;
  return { plan };
}

export function planSetDatasetProps(inv, params = {}) {
  const name = validDataset(params.dataset);
  if (!name) return { error: 'dataset is required' };
  const ds = (inv.datasets || []).find((d) => d.name === name);
  if (!ds) return { error: `dataset ${name} does not exist` };
  const vp = validateDatasetProps(params.props, { allowMountpoint: !inv.incusSources?.includes(name) });
  if (vp.error) return vp;
  const plan = newPlan('set_dataset_props', name, `Set ${Object.entries(vp.props).map(([k, v]) => `${k}=${v}`).join(', ')} on ${name}`);
  plan.steps.push(step(['zfs', 'set', ...Object.entries(vp.props).map(([k, v]) => `${k}=${v}`), name], 'Apply the properties'));
  plan.previous = Object.fromEntries(Object.keys(vp.props).map((k) => [k, ds[k] ?? ds[`${k}_bytes`] ?? null]));
  plan.reversal = `zfs set ${Object.entries(plan.previous).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(' ') || '<previous values>'} ${name}`;
  return { plan };
}

/**
 * destroy_dataset: a fresh snapshot is taken AND streamed (zfs send -R) into
 * the backups location before `zfs destroy -r`, because the snapshot itself
 * dies with the dataset. The stream file is the way back (zfs receive).
 */
export function planDestroyDataset(inv, params = {}) {
  const name = validDataset(params.dataset);
  if (!name) return { error: 'dataset is required' };
  if (!name.includes('/')) return { error: `${name} is a pool, not a dataset — export_pool / zpool destroy are separate, deliberate operations` };
  const ds = (inv.datasets || []).find((d) => d.name === name);
  if (!ds) return { error: `dataset ${name} does not exist` };
  const guests = (inv.instances || []).filter((i) => i.dataset && (i.dataset === name || i.dataset.startsWith(`${name}/`)));
  if (guests.length) return { error: `refused: ${name} holds Incus guest storage (${guests.map((g) => g.name).join(', ')}) — delete guests through Incus (delete_lxc_container)` };
  if ((inv.incusSources || []).includes(name)) return { error: `refused: ${name} is the source dataset of an Incus storage pool` };
  const children = (inv.datasets || []).filter((d) => d.name.startsWith(`${name}/`));
  const backupsDir = inv.backupsDir || '/var/lib/proxypilot/storage/destroyed';
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_');
  const streamFile = `${backupsDir.replace(/\/+$/, '')}/destroyed/${safe}@pp-predestroy-{{stamp}}.zfs`;
  const plan = newPlan('destroy_dataset', name, `Destroy dataset ${name}${children.length ? ` and ${children.length} child dataset(s)` : ''} after a fresh snapshot is taken and streamed to ${streamFile}`);
  plan.warnings = children.length ? [`children destroyed with it: ${children.map((c) => c.name).join(', ')}`] : [];
  plan.steps.push(step(['zfs', 'snapshot', '-r', `${name}@pp-predestroy-{{stamp}}`], 'Take the pre-destroy snapshot'));
  plan.steps.push(shellArgv('mkdir -p "$(dirname "$2")" && zfs send -R "$1" > "$2"', [`${name}@pp-predestroy-{{stamp}}`, streamFile], 'Stream the snapshot (with its history) into the backups location', { timeout_ms: 6 * 3600 * 1000 }));
  plan.steps.push(step(['zfs', 'destroy', '-r', name], 'Destroy the dataset and everything below it', { timeout_ms: 600000 }));
  plan.reversal = `zfs receive ${name} < ${streamFile}`;
  plan.stream_file = streamFile;
  return { plan };
}

export function planSnapshot(inv, params = {}) {
  const name = validDataset(params.dataset);
  if (!name) return { error: 'dataset is required' };
  if (!(inv.datasets || []).some((d) => d.name === name)) return { error: `dataset ${name} does not exist` };
  const snap = params.name != null ? validSnapshotName(params.name) : 'pp-manual-{{stamp}}';
  if (!snap) return { error: 'name: [A-Za-z0-9_.:-]' };
  if ((inv.snapshots || []).some((s) => s.name === `${name}@${snap}`)) return { error: `snapshot ${name}@${snap} already exists` };
  const recursive = params.recursive === true;
  const plan = newPlan('zfs_snapshot', `${name}@${snap}`, `Snapshot ${name}@${snap}${recursive ? ' recursively' : ''}`);
  plan.steps.push(step(['zfs', 'snapshot', ...(recursive ? ['-r'] : []), `${name}@${snap}`], 'Take the snapshot'));
  plan.reversal = `zfs destroy ${recursive ? '-r ' : ''}${name}@${snap}`;
  return { plan };
}

function newerSnapshots(inv, target) {
  const s = (inv.snapshots || []).find((x) => x.name === target.name);
  if (!s) return { error: `snapshot ${target.name} does not exist` };
  const t = s.created_at ? Date.parse(s.created_at) : 0;
  const newer = (inv.snapshots || []).filter((x) => x.dataset === target.dataset && x.name !== target.name && (x.created_at ? Date.parse(x.created_at) : 0) > t);
  return { snapshot: s, newer };
}

export function planRollback(inv, params = {}) {
  const target = splitSnapshot(params.snapshot);
  if (!target) return { error: 'snapshot must be dataset@name' };
  const n = newerSnapshots(inv, target);
  if (n.error) return n;
  if (n.newer.length && params.destroy_newer !== true) return { error: `refused: ${n.newer.length} newer snapshot(s) would be destroyed (${n.newer.map((x) => x.snapshot).join(', ')}) — pass destroy_newer: true to accept that` };
  const guests = (inv.instances || []).filter((i) => i.dataset === target.dataset);
  if (guests.length) return { error: `refused: ${target.dataset} is guest storage for ${guests.map((g) => g.name).join(', ')} — use rollback_guest_dataset (it stops the guest first)` };
  const plan = newPlan('zfs_rollback', target.name, `Roll ${target.dataset} back to @${target.snapshot}${n.newer.length ? `, destroying ${n.newer.length} newer snapshot(s)` : ''}`);
  plan.warnings = n.newer.length ? [`destroys: ${n.newer.map((x) => x.snapshot).join(', ')}`] : [];
  plan.steps.push(step(['zfs', 'rollback', ...(n.newer.length ? ['-r'] : []), target.name], 'Roll back'));
  plan.reversal = 'none — data written after the snapshot is gone';
  return { plan };
}

export function planDestroySnapshot(inv, params = {}) {
  const target = splitSnapshot(params.snapshot);
  if (!target) return { error: 'snapshot must be dataset@name' };
  const s = (inv.snapshots || []).find((x) => x.name === target.name);
  if (!s) return { error: `snapshot ${target.name} does not exist` };
  if (s.clones?.length) return { error: `refused: ${target.name} has clones (${s.clones.join(', ')})` };
  if (s.kind === 'incus') return { error: `refused: ${target.name} is an Incus snapshot — delete it with delete_snapshot so Incus stays consistent` };
  const plan = newPlan('destroy_snapshot', target.name, `Destroy snapshot ${target.name}`);
  plan.steps.push(step(['zfs', 'destroy', target.name], 'Destroy the snapshot'));
  plan.reversal = 'none';
  return { plan };
}

/* --------------------------- pool: replace / scrub ----------------------- */

function findLeaf(pool, ref) {
  const r = String(ref || '');
  for (const g of pool.vdevs || []) for (const d of g.devices || []) {
    if (d.name === r || d.path === r || (d.path && d.path.endsWith(`/${r}`)) || r.endsWith(`/${d.name}`)) return { group: g, leaf: d };
  }
  return null;
}

export function planReplaceDisk(inv, params = {}) {
  const poolName = validPoolName(params.pool);
  const pool = (inv.poolStatus || []).find((p) => p.name === poolName);
  if (!pool) return { error: `pool ${params.pool || '(none)'} is not imported` };
  const old = findLeaf(pool, params.old_device);
  if (!old) return { error: `old_device ${params.old_device || '(none)'} is not a member of ${poolName} (zpool_status lists members by path or guid)` };
  const r = resolveByIdDevice(inv.devices || [], params.new_device);
  if (r.error) return { error: r.error };
  const wipe = params.wipe === true;
  const e = deviceEligibility(r.device, { wipe });
  if (!e.eligible) return { error: `refused: ${params.new_device}: ${(e.hard.length ? e.hard : e.soft).join('; ')}${!e.hard.length ? ' — pass wipe: true to clear it' : ''}` };
  const plan = newPlan('replace_disk', poolName, `Replace ${old.leaf.name} in ${poolName} (${old.group.type} ${old.group.name}, state ${old.leaf.state}) with ${params.new_device}`);
  plan.warnings = e.warnings.map((w) => `${r.device.path} ${w}`);
  if (e.needs_wipe && wipe) {
    if ((r.device.signatures || []).includes('zfs_member')) plan.steps.push(step(['zpool', 'labelclear', '-f', params.new_device], `Clear ZFS labels on ${r.device.path}`, { ignore_failure: true }));
    plan.steps.push(step(['wipefs', '-a', params.new_device], `Wipe every signature on ${r.device.path}`));
  }
  plan.steps.push(step(['zpool', 'replace', poolName, old.leaf.name, params.new_device], 'Start the replacement (resilver runs in the background)', { timeout_ms: 600000 }));
  plan.steps.push(step(['zpool', 'status', '-P', poolName], 'Show resilver progress', { kind: 'verify' }));
  plan.reversal = `zpool detach ${poolName} ${params.new_device} (while resilvering)`;
  plan.touches = [r.device.path];
  return { plan };
}

export function planScrub(inv, params = {}) {
  const poolName = validPoolName(params.pool);
  const pool = (inv.poolStatus || []).find((p) => p.name === poolName);
  if (!pool) return { error: `pool ${params.pool || '(none)'} is not imported` };
  const action = String(params.action || 'start');
  if (!['start', 'stop', 'pause'].includes(action)) return { error: 'action must be start, stop or pause (status is zpool_status)' };
  const plan = newPlan('zpool_scrub', poolName, `${action === 'start' ? 'Start' : action === 'stop' ? 'Stop' : 'Pause'} a scrub of ${poolName}`);
  if (action === 'start' && pool.scan?.state === 'in_progress') plan.warnings.push(`a ${pool.scan.function} is already in progress (${pool.scan.percent ?? '?'}% done)`);
  plan.steps.push(step(['zpool', 'scrub', ...(action === 'stop' ? ['-s'] : action === 'pause' ? ['-p'] : []), poolName], `zpool scrub ${action}`));
  if (params.timer != null) {
    const unit = `proxypilot-zfs-scrub@${poolName}.timer`;
    const on = params.timer === true || params.timer === 'enable' || (typeof params.timer === 'object' && params.timer.enable !== false);
    plan.steps.push(step(['systemctl', on ? 'enable' : 'disable', '--now', unit], `${on ? 'Enable' : 'Disable'} the monthly scrub timer ${unit}`));
    plan.timer = { unit, enabled: on };
  }
  plan.reversal = action === 'start' ? `zpool scrub -s ${poolName}` : `zpool scrub ${poolName}`;
  return { plan };
}

/* --------------------------- pool: import / export ----------------------- */

export function planImportPool(inv, params = {}) {
  const ref = String(params.pool || params.name || '');
  const cand = (inv.importable || []).find((p) => p.name === ref || p.id === ref);
  if (!cand) return { error: `${ref || '(none)'} is not importable here — list_disks reports importable pools; a pool that is already imported needs nothing` };
  if ((inv.pools || []).some((p) => p.name === cand.name)) return { error: `a pool named ${cand.name} is already imported` };
  if (cand.state && cand.state !== 'ONLINE' && params.force !== true) return { error: `refused: ${cand.name} is ${cand.state} (${cand.status || 'see zpool import'}) — pass force: true to import anyway` };
  const plan = newPlan('import_pool', cand.name, `Import pool ${cand.name} (id ${cand.id}, ${cand.state}) from /dev/disk/by-id${params.readonly ? ', read-only' : ''}`);
  const argv = ['zpool', 'import', '-d', '/dev/disk/by-id'];
  if (params.force === true) argv.push('-f');
  if (params.readonly === true) argv.push('-o', 'readonly=on');
  if (params.load_key === true) argv.push('-l');
  argv.push(cand.id || cand.name);
  plan.steps.push(step(argv, 'Import', { timeout_ms: 600000, stdin: params.load_key === true ? 'passphrase' : null }));
  plan.steps.push(step(['zpool', 'status', '-P', cand.name], 'Verify', { kind: 'verify' }));
  plan.reversal = `zpool export ${cand.name}`;
  return { plan };
}

export function planExportPool(inv, params = {}) {
  const poolName = validPoolName(params.pool);
  if (!poolName || !(inv.pools || []).some((p) => p.name === poolName)) return { error: `pool ${params.pool || '(none)'} is not imported` };
  const usedBy = (inv.incusPools || []).filter((p) => p.driver === 'zfs' && p.source && p.source.split('/')[0] === poolName);
  const running = (inv.instances || []).filter((i) => usedBy.some((p) => p.name === i.pool) && i.status === 'Running');
  if (running.length) return { error: `refused: Incus guests are running on ${poolName} (${running.map((i) => i.name).join(', ')}) — stop them first` };
  if (usedBy.length && params.force !== true) return { error: `refused: Incus storage pool(s) ${usedBy.map((p) => p.name).join(', ')} use ${poolName}; Incus will lose them until re-import — pass force: true to accept that` };
  const plan = newPlan('export_pool', poolName, `Export pool ${poolName}${usedBy.length ? ` (Incus pools ${usedBy.map((p) => p.name).join(', ')} go offline)` : ''}`);
  plan.steps.push(step(['zpool', 'export', ...(params.force === true ? ['-f'] : []), poolName], 'Export', { timeout_ms: 600000 }));
  plan.reversal = `zpool import -d /dev/disk/by-id ${poolName}`;
  return { plan };
}

/* ------------------------------- incus ----------------------------------- */

export function planSetIncusStoragePool(inv, params = {}) {
  const name = String(params.name || 'zfs');
  if (!INCUS_NAME_RE.test(name)) return { error: 'name: Incus storage pool name (letters, digits, hyphens)' };
  const dataset = validDataset(params.dataset);
  if (!dataset) return { error: 'dataset is required (pool/incus by convention)' };
  if (!(inv.datasets || []).some((d) => d.name === dataset)) return { error: `dataset ${dataset} does not exist — create_dataset it first` };
  const existing = (inv.incusPools || []).find((p) => p.name === name);
  if (existing && (existing.driver !== 'zfs' || existing.source !== dataset)) return { error: `Incus already has a storage pool ${name} (${existing.driver}, source ${existing.source || '—'}) — pick another name` };
  const other = (inv.incusPools || []).find((p) => p.source === dataset && p.name !== name);
  if (other) return { error: `dataset ${dataset} already backs the Incus pool ${other.name}` };
  const children = (inv.datasets || []).filter((d) => d.name.startsWith(`${dataset}/`));
  if (!existing && children.length) return { error: `refused: ${dataset} already has child datasets (${children.slice(0, 5).map((c) => c.name).join(', ')}) — Incus needs an empty dataset` };
  const plan = newPlan('set_incus_storage_pool', name, `${existing ? 'Keep' : 'Create'} Incus storage pool ${name} on ${dataset} and make it the default profile's root pool`);
  if (!existing) plan.steps.push(step(['incus', 'storage', 'create', name, 'zfs', `source=${dataset}`], 'Create the Incus storage pool', { timeout_ms: 300000 }));
  if (params.set_default !== false) {
    if (inv.defaultProfileRoot) plan.steps.push(step(['incus', 'profile', 'device', 'set', 'default', 'root', `pool=${name}`], `Point the default profile's root disk at ${name} (was ${inv.defaultProfileRoot.pool || '—'})`));
    else plan.steps.push(step(['incus', 'profile', 'device', 'add', 'default', 'root', 'disk', 'path=/', `pool=${name}`], 'Add a root disk on the pool to the default profile'));
  }
  plan.steps.push(step(['incus', 'storage', 'show', name], 'Verify', { kind: 'verify' }));
  plan.existing_pools = (inv.incusPools || []).map((p) => ({ name: p.name, driver: p.driver, source: p.source, used_by: p.used_by_count }));
  plan.reversal = inv.defaultProfileRoot ? `incus profile device set default root pool=${inv.defaultProfileRoot.pool}; incus storage delete ${name}` : `incus profile device remove default root; incus storage delete ${name}`;
  return { plan };
}

const incusSnapshotArgv = (form, guest, snap) => (form === 'legacy' ? ['incus', 'snapshot', guest, snap] : ['incus', 'snapshot', 'create', guest, snap]);

export function planMoveGuestStorage(inv, params = {}) {
  const names = Array.isArray(params.guests) ? params.guests.map(String) : params.guest ? [String(params.guest)] : [];
  if (!names.length) return { error: 'guest (or guests: [...]) is required' };
  const pool = (inv.incusPools || []).find((p) => p.name === String(params.pool || ''));
  if (!pool) return { error: `Incus storage pool ${params.pool || '(none)'} does not exist (set_incus_storage_pool creates one)` };
  const plan = newPlan('move_guest_storage', names.join(','), `Move ${names.length} guest(s) to storage pool ${pool.name}: ${names.join(', ')}`);
  const moves = [];
  for (const n of names) {
    if (!INCUS_NAME_RE.test(n)) return { error: `${n}: invalid guest name` };
    const inst = (inv.instances || []).find((i) => i.name === n);
    if (!inst) return { error: `guest ${n} not found` };
    if (inst.pool === pool.name) { plan.warnings.push(`${n} is already on ${pool.name} — skipped`); continue; }
    const running = inst.status === 'Running';
    if (running && params.stop !== true) return { error: `refused: ${n} is running — pass stop: true to stop it for the move (it is started again afterwards)` };
    moves.push({ name: n, from: inst.pool, running });
    if (running) plan.steps.push(step(['incus', 'stop', n], `Stop ${n}`, { timeout_ms: 300000 }));
    plan.steps.push(step(incusSnapshotArgv(inv.incusSnapshotForm, n, 'pp-premove-{{stamp}}'), `Snapshot ${n} before the move`, { timeout_ms: 300000 }));
    plan.steps.push(step(['incus', 'move', n, '--storage', pool.name], `Move ${n} from ${inst.pool || '?'} to ${pool.name}`, { timeout_ms: 4 * 3600 * 1000 }));
    if (running || params.start_after === true) {
      plan.steps.push(step(['incus', 'start', n], `Start ${n}`, { timeout_ms: 300000 }));
      plan.steps.push(step(['incus', 'list', `^${n}$`, '--format', 'json'], `Verify ${n} is running`, { kind: 'verify', expect: 'Running' }));
    }
  }
  if (!moves.length) return { error: `nothing to do: ${plan.warnings.join('; ')}` };
  plan.moves = moves;
  plan.reversal = moves.map((m) => `incus move ${m.name} --storage ${m.from || '<previous pool>'}`).join('; ');
  return { plan };
}

export function planRestoreGuestFromSnapshot(inv, params = {}) {
  const guest = String(params.guest || '');
  const newName = String(params.new_name || '');
  if (!INCUS_NAME_RE.test(guest)) return { error: 'guest is required' };
  if (!INCUS_NAME_RE.test(newName)) return { error: 'new_name: letters, digits, hyphens' };
  if (newName === guest) return { error: 'new_name must differ from guest — rollback_guest_dataset rolls the guest itself back' };
  const inst = (inv.instances || []).find((i) => i.name === guest);
  if (!inst) return { error: `guest ${guest} not found` };
  if ((inv.instances || []).some((i) => i.name === newName)) return { error: `a guest named ${newName} already exists` };
  const target = splitSnapshot(params.snapshot);
  if (!target) return { error: 'snapshot must be dataset@name (list_zfs_snapshots for the guest)' };
  if (!inst.dataset || target.dataset !== inst.dataset) return { error: `${target.name} is not a snapshot of ${guest}'s dataset (${inst.dataset || 'unknown — is the guest on a managed ZFS pool?'})` };
  const snap = (inv.snapshots || []).find((s) => s.name === target.name);
  if (!snap) return { error: `snapshot ${target.name} does not exist` };
  const plan = newPlan('restore_guest_from_snapshot', newName, `Create guest ${newName} from ${guest}'s snapshot @${target.snapshot} (${snap.kind}, ${snap.created_at || 'unknown time'})`);
  if (snap.kind === 'incus') {
    plan.steps.push(step(['incus', 'copy', `${guest}/${target.snapshot.replace(/^snapshot-/, '')}`, newName], 'Copy the Incus snapshot into a new guest', { timeout_ms: 3600 * 1000 }));
  } else {
    plan.steps.push(step([inv.restoreHelper || '/usr/local/sbin/proxypilot-storage-restore-guest', target.name, newName, inst.pool || ''], 'Clone the ZFS snapshot, package it as an Incus backup and import it as the new guest', { timeout_ms: 3600 * 1000 }));
  }
  if (params.start === true) {
    plan.steps.push(step(['incus', 'start', newName], `Start ${newName}`, { timeout_ms: 300000 }));
    plan.steps.push(step(['incus', 'list', `^${newName}$`, '--format', 'json'], `Verify ${newName} is running`, { kind: 'verify', expect: 'Running' }));
  }
  plan.warnings.push('The new guest keeps the source config, including any static IP and proxy devices — adjust them before routing to it.');
  plan.reversal = `incus delete ${newName}`;
  return { plan };
}

export function planRollbackGuestDataset(inv, params = {}) {
  const guest = String(params.guest || '');
  if (!INCUS_NAME_RE.test(guest)) return { error: 'guest is required' };
  const inst = (inv.instances || []).find((i) => i.name === guest);
  if (!inst) return { error: `guest ${guest} not found` };
  const target = splitSnapshot(params.snapshot);
  if (!target) return { error: 'snapshot must be dataset@name' };
  if (!inst.dataset || target.dataset !== inst.dataset) return { error: `${target.name} is not a snapshot of ${guest}'s dataset (${inst.dataset || 'unknown'})` };
  const n = newerSnapshots(inv, target);
  if (n.error) return n;
  const newerIncus = n.newer.filter((s) => s.kind === 'incus');
  if (newerIncus.length) return { error: `refused: Incus snapshots newer than @${target.snapshot} exist (${newerIncus.map((s) => s.snapshot.replace(/^snapshot-/, '')).join(', ')}) and a rollback would destroy them behind Incus's back — delete them with delete_snapshot first` };
  if (n.newer.length && params.destroy_newer !== true) return { error: `refused: ${n.newer.length} newer snapshot(s) would be destroyed (${n.newer.map((x) => x.snapshot).join(', ')}) — pass destroy_newer: true` };
  const running = inst.status === 'Running';
  if (running && params.stop !== true) return { error: `refused: ${guest} is running — pass stop: true to stop it for the rollback (it is started again afterwards)` };
  const plan = newPlan('rollback_guest_dataset', guest, `Roll guest ${guest} back to @${target.snapshot} (${n.snapshot.kind}, ${n.snapshot.created_at || '?'})`);
  plan.warnings = n.newer.length ? [`destroys newer snapshots: ${n.newer.map((x) => x.snapshot).join(', ')}`] : [];
  if (running) plan.steps.push(step(['incus', 'stop', guest], `Stop ${guest}`, { timeout_ms: 300000 }));
  plan.steps.push(step(['zfs', 'rollback', ...(n.newer.length ? ['-r'] : []), target.name], 'Roll the dataset back'));
  if (running || params.start_after === true) {
    plan.steps.push(step(['incus', 'start', guest], `Start ${guest}`, { timeout_ms: 300000 }));
    plan.steps.push(step(['incus', 'list', `^${guest}$`, '--format', 'json'], `Verify ${guest} is running`, { kind: 'verify', expect: 'Running' }));
  }
  plan.reversal = 'none — data written after the snapshot is gone (restore_guest_from_snapshot on a later snapshot is the non-destructive alternative)';
  return { plan };
}

/* --------------------------- host config writers ------------------------- */

/** Write a file on the host from stdin (content is part of the plan, so the token covers it). */
export function planWriteHostFile(op, subject, summary, { path, content, mode = '0644', after = [] }) {
  const plan = newPlan(op, subject, summary);
  plan.steps.push(shellArgv('umask 022 && mkdir -p "$(dirname "$1")" && cat > "$1.tmp" && chmod "$2" "$1.tmp" && mv -f "$1.tmp" "$1"', [path, mode], `Write ${path}`, { stdin: 'content', content }));
  for (const a of after) plan.steps.push(step(a.argv, a.description, a.extra || {}));
  plan.file = path;
  return plan;
}

export const OPS = Object.freeze([
  'create_zpool', 'create_dataset', 'set_dataset_props', 'destroy_dataset', 'zfs_snapshot', 'zfs_rollback', 'destroy_zfs_snapshot',
  'replace_disk', 'zpool_scrub', 'import_pool', 'export_pool', 'set_incus_storage_pool', 'move_guest_storage',
  'restore_guest_from_snapshot', 'rollback_guest_dataset', 'set_backup_policy', 'set_replication_target', 'run_replication',
]);
