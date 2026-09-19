// ZFS storage management — the PURE parsing layer.
//
// Turns the raw output of the host tools (lsblk -J, smartctl -j, findmnt,
// zpool list/status/import, zfs list) into the one inventory shape the
// planner, the REST API, the MCP tools and the Storage page consume. The Go
// agent (cmd/agent/methods/storage.go) produces the same shape from the same
// commands; this module is what the backend uses when the agent is not
// reachable (or lacks the privilege for smartctl / zpool import scanning),
// through the existing nsenter path. Native-free, no host exec: every
// function here takes text or parsed JSON and returns plain objects, so it
// tests in a fresh checkout against fixtures.

/* ------------------------------- helpers -------------------------------- */

function num(v) {
  if (v == null || v === '' || v === '-') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Split `-H` (tab-separated, no header) output into rows of cells. */
export function tsvRows(text) {
  return String(text || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '').map((l) => l.split('\t'));
}

/* ------------------------------- lsblk -J -------------------------------- */

// Columns the host layer asks lsblk for (kept in one place so the Node
// fallback and the Go agent request the same set):
export const LSBLK_COLUMNS = [
  'NAME', 'KNAME', 'PATH', 'TYPE', 'SIZE', 'MODEL', 'SERIAL', 'WWN', 'VENDOR', 'TRAN', 'ROTA', 'RM', 'HOTPLUG', 'RO',
  'FSTYPE', 'LABEL', 'UUID', 'MOUNTPOINT', 'MOUNTPOINTS', 'PKNAME', 'PARTTYPE', 'PARTLABEL', 'PARTUUID', 'PTTYPE',
];

// Signatures libblkid reports as FSTYPE that mean "this device belongs to
// something": a pool, an md array, an LVM volume group, an encrypted volume.
export const MEMBER_SIGNATURES = Object.freeze({
  zfs_member: 'zfs',
  linux_raid_member: 'mdadm',
  LVM2_member: 'lvm',
  crypto_LUKS: 'luks',
  ceph_bluestore: 'ceph',
  swap: 'swap',
});

function mountpointsOf(node) {
  const out = [];
  if (Array.isArray(node.mountpoints)) for (const m of node.mountpoints) if (m) out.push(String(m));
  if (node.mountpoint && !out.includes(String(node.mountpoint))) out.push(String(node.mountpoint));
  return out;
}

function walkNode(node, fn, parent = null) {
  fn(node, parent);
  for (const c of node.children || []) walkNode(c, fn, node);
}

/**
 * lsblk -J -b -o <LSBLK_COLUMNS> → the whole-disk list. Children of type
 * `part` are partitions; any other child (md, dm, lvm, crypt, loop-backed…)
 * is a holder of its parent. Sizes are bytes (lsblk -b; strings in older
 * util-linux, numbers in newer — both accepted).
 */
export function parseLsblk(json, { includeLoop = false } = {}) {
  const root = typeof json === 'string' ? JSON.parse(json) : json;
  const devices = [];
  for (const node of root?.blockdevices || []) {
    // md/dm/loop/rom top-level nodes are not physical disks — except that the
    // loop-device integration test (and a dev VM) treats loops as disks.
    if (node.type !== 'disk' && !(includeLoop && node.type === 'loop')) continue;
    const disk = {
      name: str(node.kname) || str(node.name),
      path: str(node.path) || `/dev/${str(node.kname) || str(node.name)}`,
      model: str(node.model), serial: str(node.serial), wwn: str(node.wwn), vendor: str(node.vendor),
      size_bytes: num(node.size), transport: str(node.tran), rotational: bool(node.rota), removable: bool(node.rm) || bool(node.hotplug),
      read_only: bool(node.ro), fstype: str(node.fstype), label: str(node.label), pttype: str(node.pttype),
      mountpoints: mountpointsOf(node), partitions: [], holders: [], contains: [],
    };
    for (const child of node.children || []) {
      if (child.type === 'part') {
        const part = {
          name: str(child.kname) || str(child.name), path: str(child.path) || `/dev/${str(child.kname) || str(child.name)}`,
          size_bytes: num(child.size), fstype: str(child.fstype), label: str(child.label), uuid: str(child.uuid),
          parttype: str(child.parttype), partlabel: str(child.partlabel), mountpoints: mountpointsOf(child), holders: [],
        };
        for (const h of child.children || []) {
          part.holders.push({ name: str(h.kname) || str(h.name), type: str(h.type), fstype: str(h.fstype), mountpoints: mountpointsOf(h) });
        }
        disk.partitions.push(part);
      } else {
        disk.holders.push({ name: str(child.kname) || str(child.name), type: str(child.type), fstype: str(child.fstype), mountpoints: mountpointsOf(child) });
      }
    }
    // Every kernel name that lives anywhere below this disk (partitions,
    // md/dm holders, their children). Used to resolve "which disk backs /".
    walkNode(node, (n) => { for (const k of [str(n.kname), str(n.name)]) if (k && k !== disk.name && !disk.contains.includes(k)) disk.contains.push(k); });
    devices.push(disk);
  }
  return devices;
}

/* ------------------------------- smartctl -j ------------------------------ */

const ATA_ATTR = { 5: 'reallocated_sectors', 196: 'reallocated_events', 197: 'pending_sectors', 198: 'offline_uncorrectable', 187: 'reported_uncorrectable', 199: 'udma_crc_errors' };

/**
 * smartctl -j -a /dev/X → the compact health record the badges show.
 * `healthy` is smartctl's own overall verdict; the counters are the ones an
 * operator actually reads (reallocated / pending sectors on ATA, percentage
 * used + media errors on NVMe), plus temperature and power-on hours.
 */
export function parseSmartctl(json) {
  let j;
  try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return { available: false, error: 'smartctl output was not JSON' }; }
  if (!j || typeof j !== 'object') return { available: false, error: 'smartctl output was not JSON' };
  const exit = j.smartctl?.exit_status ?? 0;
  const messages = (j.smartctl?.messages || []).map((m) => m.string).filter(Boolean);
  const out = {
    available: true, healthy: null, device_type: str(j.device?.type), model: str(j.model_name), serial: str(j.serial_number),
    firmware: str(j.firmware_version), temperature_c: num(j.temperature?.current), power_on_hours: num(j.power_on_time?.hours),
    power_cycles: num(j.power_cycle_count), reallocated_sectors: null, pending_sectors: null, offline_uncorrectable: null,
    reported_uncorrectable: null, udma_crc_errors: null, percentage_used: null, media_errors: null, available_spare: null,
    critical_warning: null, exit_status: exit, messages, error: null,
  };
  // Bit 1 of the exit status: device open failed; bit 2: a command failed.
  if ((exit & 0b10) && j.smart_status == null) {
    out.available = false;
    out.error = messages[0] || 'smartctl could not open the device';
    if (/permission denied|operation not permitted/i.test(out.error)) out.error = 'permission_denied';
    return out;
  }
  if (j.smart_status && typeof j.smart_status.passed === 'boolean') out.healthy = j.smart_status.passed;
  for (const row of j.ata_smart_attributes?.table || []) {
    const key = ATA_ATTR[row.id];
    if (key) out[key] = num(row.raw?.value);
  }
  const nv = j.nvme_smart_health_information_log;
  if (nv) {
    out.percentage_used = num(nv.percentage_used);
    out.media_errors = num(nv.media_errors);
    out.available_spare = num(nv.available_spare);
    out.critical_warning = num(nv.critical_warning);
    if (out.temperature_c == null) out.temperature_c = num(nv.temperature);
    if (out.power_on_hours == null) out.power_on_hours = num(nv.power_on_hours);
    if (out.healthy == null) out.healthy = (num(nv.critical_warning) || 0) === 0;
  }
  if (out.healthy == null && j.smart_support && j.smart_support.available === false) { out.available = false; out.error = 'SMART not supported'; }
  return out;
}

/** The badge the page shows: ok | warn | fail | unknown, with the reason. */
export function smartVerdict(smart) {
  if (!smart || !smart.available) return { level: 'unknown', reason: smart?.error || 'no SMART data' };
  if (smart.healthy === false) return { level: 'fail', reason: 'SMART overall health FAILED' };
  const reasons = [];
  if ((smart.reallocated_sectors || 0) > 0) reasons.push(`${smart.reallocated_sectors} reallocated sectors`);
  if ((smart.pending_sectors || 0) > 0) reasons.push(`${smart.pending_sectors} pending sectors`);
  if ((smart.offline_uncorrectable || 0) > 0) reasons.push(`${smart.offline_uncorrectable} offline uncorrectable`);
  if ((smart.media_errors || 0) > 0) reasons.push(`${smart.media_errors} NVMe media errors`);
  if ((smart.critical_warning || 0) > 0) reasons.push(`NVMe critical warning 0x${Number(smart.critical_warning).toString(16)}`);
  if (smart.percentage_used != null && smart.percentage_used >= 90) reasons.push(`${smart.percentage_used}% of rated endurance used`);
  if (smart.available_spare != null && smart.available_spare < 10) reasons.push(`available spare ${smart.available_spare}%`);
  if (smart.temperature_c != null && smart.temperature_c >= 60) reasons.push(`${smart.temperature_c}°C`);
  if (reasons.length) return { level: 'warn', reason: reasons.join(', ') };
  if (smart.healthy === true) return { level: 'ok', reason: 'SMART passed' };
  return { level: 'unknown', reason: 'no overall verdict' };
}

/* ------------------------------- findmnt --------------------------------- */

/**
 * `findmnt -rno TARGET,SOURCE,FSTYPE / /boot /boot/efi` → [{target, source, fstype}].
 * btrfs subvolume sources look like `/dev/sda2[/@]`; the bracket part is dropped.
 */
export function parseFindmnt(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [target, source, fstype] = t.split(/\s+/);
    if (!target || !source) continue;
    out.push({ target, source: source.replace(/\[.*\]$/, ''), fstype: fstype || null });
  }
  return out;
}

/* ---------------------------- /dev/disk/by-id ----------------------------- */

/** Lines of `<by-id path> <resolved /dev path>` → { '/dev/sda': ['/dev/disk/by-id/...'] }. */
export function parseByIdMap(text) {
  const map = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [link, target] = t.split(/\s+/);
    if (!link || !target || !link.startsWith('/dev/disk/by-id/')) continue;
    (map[target] ||= []).push(link);
  }
  for (const k of Object.keys(map)) map[k].sort(byIdPreference);
  return map;
}

// Stable, human-meaningful ids first: wwn-, then bus ids, then -partN and
// nvme-eui last. What create_zpool records in the pool is the first one.
function byIdPreference(a, b) {
  const rank = (s) => {
    const n = s.slice('/dev/disk/by-id/'.length);
    if (/-part\d+$/.test(n)) return 9;
    if (n.startsWith('wwn-')) return 0;
    if (n.startsWith('nvme-eui.')) return 5;
    if (n.startsWith('ata-') || n.startsWith('scsi-') || n.startsWith('nvme-') || n.startsWith('usb-') || n.startsWith('virtio-')) return 1;
    return 4;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/* ------------------------------- zpool list ------------------------------- */

export const ZPOOL_LIST_COLUMNS = ['name', 'size', 'allocated', 'free', 'fragmentation', 'capacity', 'health', 'dedupratio', 'guid', 'altroot', 'readonly', 'ashift'];

/** `zpool list -H -p -o <ZPOOL_LIST_COLUMNS>` → [{ name, size_bytes, … }]. */
export function parseZpoolList(text) {
  return tsvRows(text).map((c) => ({
    name: c[0], size_bytes: num(c[1]), allocated_bytes: num(c[2]), free_bytes: num(c[3]),
    fragmentation_pct: num(c[4]), capacity_pct: num(c[5]), health: c[6] || null, dedup_ratio: num(String(c[7] || '').replace(/x$/, '')),
    guid: str(c[8]), altroot: c[9] && c[9] !== '-' ? c[9] : null, readonly: bool(c[10]), ashift: num(c[11]),
  }));
}

/* ------------------------------ zpool status ------------------------------ */

const SCAN_DONE_RE = /^(scrub|resilver)(?:ed| repaired)\s+(\S+)\s+in\s+(\S+(?: days? \S+)?)(?:\s+with\s+(\d+)\s+errors)?\s+on\s+(.+)$/;
const SCAN_PROGRESS_RE = /^(scrub|resilver) in progress since (.+)$/;
const SCAN_CANCELED_RE = /^(scrub|resilver) canceled on (.+)$/;

function parseScan(lines) {
  const first = (lines[0] || '').trim();
  if (!first || /^none requested/.test(first)) return { function: null, state: 'none', last_end: null, errors: null, percent: null, to_go: null, repaired: null, text: first || null };
  let m = first.match(SCAN_DONE_RE);
  if (m) {
    const when = new Date(m[5]);
    return { function: m[1], state: 'finished', repaired: m[2], duration: m[3], errors: m[4] != null ? Number(m[4]) : 0, last_end: Number.isNaN(when.getTime()) ? m[5] : when.toISOString(), percent: 100, to_go: null, text: lines.join(' ').trim() };
  }
  m = first.match(SCAN_PROGRESS_RE);
  if (m) {
    const rest = lines.slice(1).join(' ');
    const pct = rest.match(/([\d.]+)% done/);
    const togo = rest.match(/,\s*([^,]+?) to go/);
    const rep = rest.match(/(\S+) repaired/);
    const since = new Date(m[2]);
    return { function: m[1], state: 'in_progress', started: Number.isNaN(since.getTime()) ? m[2] : since.toISOString(), percent: pct ? Number(pct[1]) : null, to_go: togo ? togo[1].trim() : null, repaired: rep ? rep[1] : null, errors: null, last_end: null, text: lines.join(' ').trim() };
  }
  m = first.match(SCAN_CANCELED_RE);
  if (m) return { function: m[1], state: 'canceled', last_end: m[2], errors: null, percent: null, to_go: null, repaired: null, text: first };
  return { function: null, state: 'unknown', text: lines.join(' ').trim(), last_end: null, errors: null, percent: null, to_go: null, repaired: null };
}

const VDEV_GROUP_RE = /^(mirror|raidz1|raidz2|raidz3|draid\d?|spare|replacing|indirect)-?\d*$/;

/**
 * `zpool status -P -p [-v]` (text) → [{ name, state, status, action, see, scan, errors, vdevs: [...], config_text }].
 * The config tree is reconstructed from indentation: pool → vdev group →
 * leaf device (a leaf directly under the pool is a single-device vdev).
 * Sections `logs`, `cache`, `spares`, `special`, `dedup` become classes.
 */
export function parseZpoolStatus(text) {
  const pools = [];
  const chunks = String(text || '').split(/\n(?=\s*pool:)/);
  for (const chunk of chunks) {
    if (!/^\s*pool:/.test(chunk)) continue;
    const pool = { name: null, state: null, status: null, action: null, see: null, scan: null, errors: null, vdevs: [], config_text: null, checkpoint: null };
    const lines = chunk.split('\n');
    let section = null; const sec = {};
    for (const raw of lines) {
      const m = raw.match(/^\s*(pool|state|status|action|see|scan|scrub|config|errors|checkpoint|remove):\s?(.*)$/);
      if (m) { section = m[1]; sec[section] = [m[2]]; continue; }
      if (section) sec[section].push(raw);
    }
    pool.name = (sec.pool?.[0] || '').trim();
    pool.state = (sec.state?.[0] || '').trim() || null;
    for (const k of ['status', 'action', 'see', 'checkpoint']) if (sec[k]) pool[k] = sec[k].map((l) => l.trim()).filter(Boolean).join(' ');
    pool.scan = parseScan(sec.scan || sec.scrub || []);
    pool.errors = sec.errors ? sec.errors.map((l) => l.trim()).filter(Boolean).join(' ') : null;
    const cfg = (sec.config || []).filter((l) => l.trim() !== '');
    pool.config_text = cfg.join('\n');
    pool.vdevs = parseConfigTree(cfg, pool.name);
    pools.push(pool);
  }
  return pools;
}

function parseConfigTree(lines, poolName) {
  // Drop the header ("NAME STATE READ WRITE CKSUM") and blank lines; compute
  // indentation relative to the pool row.
  const rows = [];
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '        ');
    if (/^\s*NAME\s+STATE/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const parts = line.trim().split(/\s+/);
    if (!parts[0]) continue;
    rows.push({ indent, name: parts[0], state: parts[1] || null, read: num(parts[2]), write: num(parts[3]), cksum: num(parts[4]), note: parts.slice(5).join(' ') || null });
  }
  const out = [];
  let cls = 'data';
  let base = null; let group = null;
  for (const r of rows) {
    if (r.name === poolName && base == null) { base = r.indent; continue; }
    if (['logs', 'cache', 'spares', 'special', 'dedup'].includes(r.name) && r.state == null) { cls = r.name; group = null; continue; }
    const rel = base == null ? 0 : r.indent - base;
    const leaf = { name: r.name, path: r.name.startsWith('/') ? r.name : null, state: r.state, read_errors: r.read, write_errors: r.write, cksum_errors: r.cksum, note: r.note, class: cls };
    if (VDEV_GROUP_RE.test(r.name)) {
      group = { name: r.name, type: r.name.replace(/-\d+$/, ''), state: r.state, read_errors: r.read, write_errors: r.write, cksum_errors: r.cksum, class: cls, devices: [], indent: rel };
      out.push(group);
      continue;
    }
    if (group && rel > group.indent) { group.devices.push(leaf); continue; }
    group = null;
    out.push({ name: r.name, type: 'single', state: r.state, read_errors: r.read, write_errors: r.write, cksum_errors: r.cksum, class: cls, devices: [leaf], indent: rel });
  }
  for (const g of out) delete g.indent;
  return out;
}

/** `zpool status -j` (OpenZFS ≥ 2.3) → the same shape parseZpoolStatus returns. */
export function parseZpoolStatusJson(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const pools = [];
  for (const p of Object.values(j?.pools || {})) {
    const scan = p.scan_stats ? {
      function: p.scan_stats.function ? String(p.scan_stats.function).toLowerCase() : null,
      state: p.scan_stats.state === 'FINISHED' ? 'finished' : p.scan_stats.state === 'SCANNING' ? 'in_progress' : p.scan_stats.state === 'CANCELED' ? 'canceled' : 'none',
      last_end: p.scan_stats.end_time ? isoFromEpochOrText(p.scan_stats.end_time) : null,
      started: p.scan_stats.start_time ? isoFromEpochOrText(p.scan_stats.start_time) : null,
      errors: num(p.scan_stats.errors), percent: p.scan_stats.pct_done != null ? num(p.scan_stats.pct_done) : null, to_go: null, repaired: p.scan_stats.repaired ?? null, text: null,
    } : { function: null, state: 'none', last_end: null, errors: null, percent: null, to_go: null, repaired: null, text: null };
    const vdevs = [];
    const top = p.vdevs?.[p.name]?.vdevs || p.vdevs || {};
    for (const v of Object.values(top)) {
      const leafOf = (d, cls) => ({ name: d.name, path: d.path || (String(d.name).startsWith('/') ? d.name : null), state: d.state, read_errors: num(d.read_errors), write_errors: num(d.write_errors), cksum_errors: num(d.checksum_errors), note: null, class: cls });
      const cls = v.class || 'data';
      if (v.vdevs && Object.keys(v.vdevs).length) {
        vdevs.push({ name: v.name, type: String(v.vdev_type || v.name).replace(/-\d+$/, ''), state: v.state, read_errors: num(v.read_errors), write_errors: num(v.write_errors), cksum_errors: num(v.checksum_errors), class: cls === 'normal' ? 'data' : cls, devices: Object.values(v.vdevs).map((d) => leafOf(d, cls)) });
      } else {
        vdevs.push({ name: v.name, type: 'single', state: v.state, read_errors: num(v.read_errors), write_errors: num(v.write_errors), cksum_errors: num(v.checksum_errors), class: cls === 'normal' ? 'data' : cls, devices: [leafOf(v, cls)] });
      }
    }
    pools.push({ name: p.name, state: p.state, status: p.status || null, action: p.action || null, see: null, scan, errors: p.error_count != null ? `${p.error_count} data errors` : null, vdevs, config_text: null, checkpoint: null });
  }
  return pools;
}

function isoFromEpochOrText(v) {
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e9) return new Date(n * 1000).toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/* ------------------------------ zpool import ------------------------------ */

/**
 * `zpool import [-d /dev/disk/by-id]` (scan, no pool name) → importable pools:
 * [{ name, id, state, status, action, devices: [names] }]. "no pools available
 * to import" → [].
 */
export function parseZpoolImport(text) {
  const out = [];
  const chunks = String(text || '').split(/\n(?=\s*pool:)/);
  for (const chunk of chunks) {
    if (!/^\s*pool:/.test(chunk)) continue;
    const pool = { name: null, id: null, state: null, status: null, action: null, devices: [] };
    let inConfig = false;
    for (const raw of chunk.split('\n')) {
      const m = raw.match(/^\s*(pool|id|state|status|action|config):\s?(.*)$/);
      if (m) {
        inConfig = m[1] === 'config';
        if (m[1] === 'pool') pool.name = m[2].trim();
        else if (m[1] === 'id') pool.id = m[2].trim();
        else if (m[1] === 'state') pool.state = m[2].trim();
        else if (m[1] === 'status') pool.status = m[2].trim();
        else if (m[1] === 'action') pool.action = m[2].trim();
        continue;
      }
      if (inConfig) {
        const parts = raw.trim().split(/\s+/);
        if (parts.length >= 2 && parts[0] !== pool.name && !VDEV_GROUP_RE.test(parts[0]) && !['logs', 'cache', 'spares'].includes(parts[0])) pool.devices.push(parts[0]);
      }
    }
    if (pool.name) out.push(pool);
  }
  return out;
}

/* --------------------------------- zfs list ------------------------------- */

export const ZFS_LIST_COLUMNS = [
  'name', 'type', 'used', 'available', 'referenced', 'quota', 'refquota', 'reservation', 'compression', 'compressratio',
  'encryption', 'keystatus', 'keylocation', 'mountpoint', 'mounted', 'canmount', 'recordsize', 'atime', 'xattr', 'origin', 'creation', 'readonly', 'volsize',
];

/** `zfs list -H -p -t filesystem,volume -o <ZFS_LIST_COLUMNS>` → datasets. */
export function parseZfsList(text) {
  return tsvRows(text).map((c) => ({
    name: c[0], type: c[1] || 'filesystem', pool: String(c[0] || '').split('/')[0], used_bytes: num(c[2]), available_bytes: num(c[3]), referenced_bytes: num(c[4]),
    quota_bytes: num(c[5]) || null, refquota_bytes: num(c[6]) || null, reservation_bytes: num(c[7]) || null,
    compression: c[8] || null, compress_ratio: num(String(c[9] || '').replace(/x$/, '')), encryption: c[10] && c[10] !== 'off' ? c[10] : null,
    keystatus: c[11] && c[11] !== '-' ? c[11] : null, keylocation: c[12] && c[12] !== '-' && c[12] !== 'none' ? c[12] : null,
    mountpoint: c[13] || null, mounted: bool(c[14]), canmount: c[15] || null, recordsize_bytes: num(c[16]), atime: c[17] || null, xattr: c[18] || null,
    origin: c[19] && c[19] !== '-' ? c[19] : null, creation: c[20] ? new Date(Number(c[20]) * 1000).toISOString() : null, readonly: bool(c[21]),
    volsize_bytes: num(c[22]) || null,
  }));
}

export const ZFS_SNAPSHOT_COLUMNS = ['name', 'creation', 'used', 'referenced', 'clones', 'defer_destroy', 'userrefs'];

/** `zfs list -H -p -t snapshot -o <ZFS_SNAPSHOT_COLUMNS>` → snapshots, newest last. */
export function parseZfsSnapshots(text) {
  return tsvRows(text).map((c) => {
    const [dataset, snap] = String(c[0] || '').split('@');
    return {
      name: c[0], dataset, snapshot: snap || null, pool: String(dataset || '').split('/')[0],
      created_at: c[1] ? new Date(Number(c[1]) * 1000).toISOString() : null, used_bytes: num(c[2]), referenced_bytes: num(c[3]),
      clones: c[4] && c[4] !== '-' ? c[4].split(',') : [], holds: num(c[6]) || 0,
      kind: classifySnapshotName(snap || ''),
    };
  });
}

/** Who made a snapshot, from its name: sanoid (autosnap_…), syncoid, incus (snapshot-…), proxypilot (pp-…), manual. */
export function classifySnapshotName(name) {
  if (/^autosnap_/.test(name)) return 'sanoid';
  if (/^syncoid_/.test(name)) return 'syncoid';
  if (/^snapshot-/.test(name)) return 'incus';
  if (/^pp-/.test(name)) return 'proxypilot';
  return 'manual';
}

/* ---------------------------- OS device resolution ------------------------ */

/**
 * Which whole disks back the operating system. `mounts` come from parseFindmnt
 * (/, /boot, /boot/efi, plus swap sources if given); `devices` from parseLsblk;
 * `pools` from parseZpoolStatus (for a ZFS root, every member of the root pool
 * is an OS disk). Returns { [diskName]: reason }.
 */
export function resolveOsDisks({ mounts = [], devices = [], pools = [] } = {}) {
  const os = {};
  const byKname = new Map();
  for (const d of devices) { byKname.set(d.name, d); for (const k of d.contains) byKname.set(k, byKname.get(k) || d); }
  const mark = (disk, reason) => { if (disk && !os[disk.name]) os[disk.name] = reason; };
  const diskForPath = (p) => {
    const base = String(p).replace(/^\/dev\//, '').replace(/^mapper\//, '');
    if (byKname.has(base)) return byKname.get(base);
    // /dev/mapper/<name> and /dev/<vg>/<lv> resolve through dm names lsblk reports as kname dm-N with name <vg>-<lv>;
    // lsblk children carry `name` = mapper name, so search the tree by that too.
    for (const d of devices) {
      if (d.holders.some((h) => h.name === base) || d.partitions.some((pt) => pt.holders.some((h) => h.name === base))) return d;
    }
    return null;
  };
  for (const m of mounts) {
    const reason = `backs ${m.target}`;
    if (m.fstype === 'zfs' || (!m.source.startsWith('/') && m.source.includes('/')) || (!m.source.startsWith('/') && pools.some((p) => p.name === m.source.split('/')[0]))) {
      const poolName = m.source.split('/')[0];
      const pool = pools.find((p) => p.name === poolName);
      if (pool) for (const g of pool.vdevs) for (const dev of g.devices) mark(diskForPath(dev.path || dev.name) || diskByIdLeaf(devices, dev.name), `${reason} (zfs pool ${poolName})`);
      continue;
    }
    if (m.source.startsWith('/dev/')) mark(diskForPath(m.source), reason);
  }
  return os;
}

function diskByIdLeaf(devices, leafName) {
  const n = String(leafName || '');
  for (const d of devices) {
    if ((d.by_id || []).some((l) => l.endsWith(`/${n}`) || l === n)) return d;
    if (d.partitions.some((p) => (p.by_id || []).some((l) => l.endsWith(`/${n}`) || l === n))) return d;
  }
  // last resort: the leaf is a by-id name whose base matches a kernel name
  const base = n.replace(/^.*\//, '').replace(/-part\d+$/, '');
  return devices.find((d) => d.name === base || d.wwn && base === `wwn-${d.wwn}`) || null;
}

/* ------------------------------- inventory -------------------------------- */

/**
 * Assemble the device inventory the planner and the page consume.
 *   lsblk         parsed by parseLsblk
 *   byId          parseByIdMap
 *   smart         { '/dev/sda': parseSmartctl(...) }
 *   mounts        parseFindmnt
 *   importable    parseZpoolImport (pools not currently imported)
 *   pools         parseZpoolStatus (imported pools; members are tagged in_pool)
 */
export function buildDeviceInventory({ lsblk = [], byId = {}, smart = {}, mounts = [], importable = [], pools = [] } = {}) {
  const devices = lsblk.map((d) => ({ ...d, by_id: byId[d.path] || [], partitions: d.partitions.map((p) => ({ ...p, by_id: byId[p.path] || [] })) }));
  const osMap = resolveOsDisks({ mounts, devices, pools });
  // Which imported pool owns which leaf (by path or by-id name).
  const memberOf = new Map();
  for (const p of pools) for (const g of p.vdevs) for (const dev of g.devices) memberOf.set(dev.path || dev.name, p.name);
  const importableOf = new Map();
  for (const p of importable) for (const dev of p.devices) importableOf.set(dev, p);
  for (const d of devices) {
    d.os = !!osMap[d.name];
    d.os_reason = osMap[d.name] || null;
    d.smart = smart[d.path] || smart[d.name] || { available: false, error: 'not collected' };
    d.smart_verdict = smartVerdict(d.smart);
    const sigs = new Set();
    const addSig = (fs) => { if (fs) sigs.add(fs); };
    addSig(d.fstype); if (d.pttype) sigs.add(`${d.pttype}-partition-table`);
    for (const p of d.partitions) addSig(p.fstype);
    d.signatures = [...sigs];
    d.member_of = [...sigs].map((s) => MEMBER_SIGNATURES[s]).filter(Boolean);
    d.mounted = d.mountpoints.length > 0 || d.partitions.some((p) => p.mountpoints.length > 0 || p.holders.some((h) => h.mountpoints.length)) || d.holders.some((h) => h.mountpoints.length);
    d.mounted_at = [...d.mountpoints, ...d.partitions.flatMap((p) => [...p.mountpoints, ...p.holders.flatMap((h) => h.mountpoints)]), ...d.holders.flatMap((h) => h.mountpoints)];
    const paths = [d.path, ...d.by_id, ...d.partitions.flatMap((p) => [p.path, ...p.by_id])];
    d.in_pool = paths.map((p) => memberOf.get(p) || memberOf.get(p.replace(/^\/dev\/disk\/by-id\//, ''))).find(Boolean) || null;
    const imp = paths.map((p) => importableOf.get(p) || importableOf.get(p.replace(/^\/dev\/disk\/by-id\//, '')) || importableOf.get(p.replace(/^\/dev\//, ''))).find(Boolean) || null;
    d.importable_pool = imp ? { name: imp.name, id: imp.id, state: imp.state } : null;
    d.has_holders = d.holders.length > 0 || d.partitions.some((p) => p.holders.length > 0);
  }
  return devices;
}

/* ------------------------------- incus JSON ------------------------------- */

/** `incus storage list --format json` → [{ name, driver, source, used_by_count, status }]. */
export function parseIncusStoragePools(json) {
  let j; try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  if (!Array.isArray(j)) return [];
  return j.map((p) => ({ name: p.name, driver: p.driver, source: p.config?.source || null, status: p.status || null, used_by: Array.isArray(p.used_by) ? p.used_by : [], used_by_count: Array.isArray(p.used_by) ? p.used_by.length : 0, config: p.config || {} }));
}

/** `incus list --format json` → [{ name, type, status, pool, project }] where pool comes from the root disk device. */
export function parseIncusInstances(json) {
  let j; try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  if (!Array.isArray(j)) return [];
  return j.map((i) => {
    const devices = i.expanded_devices || i.devices || {};
    const root = Object.values(devices).find((d) => d && d.type === 'disk' && d.path === '/');
    return { name: i.name, type: i.type || 'container', status: i.status || null, pool: root?.pool || null, project: i.project || 'default', snapshots: Array.isArray(i.snapshots) ? i.snapshots.map((s) => s.name) : [] };
  });
}

/** The ZFS dataset an Incus instance lives on, for a pool whose source is <dataset>. */
export function incusInstanceDataset(source, instance) {
  const kind = instance.type === 'virtual-machine' ? 'virtual-machines' : 'containers';
  return `${source}/${kind}/${instance.name}`;
}
