// Host-side storage facts for one guest: its ZFS dataset (used, referenced,
// held by snapshots, logical, compression), the disk limit, the snapshots
// with what each one alone holds, the prepared exports, and host files the
// guest's releases leave behind (application transfer bundles) or keep
// (a Dev Studio project's bare repository). Everything goes through an
// injected argv executor `host(argv, { timeoutMs, maxCapture })` →
// { code, stdout, stderr }; nothing here runs a shell string.

import { runHostCapture } from '../lxc-zip.js';
import { incusInstanceDataset } from '../storage/parse.js';
import { scanArgv, scanScript, parseScanOutput, SCAN_MAX_CAPTURE } from './scan-program.js';

export const HOST_TRANSFER_ROOT = '/var/lib/proxypilot/application-release-transfers';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ZFS_PROPS = ['used', 'referenced', 'usedbysnapshots', 'usedbydataset', 'logicalused', 'logicalreferenced', 'compressratio', 'refquota', 'quota', 'available'];

const codeOf = (r) => (r ? (r.code ?? r.status ?? null) : null);

/** The backend's executor: host argv through runHostCapture (nsenter inside Docker), guest via `incus exec … -- sh`. */
export function backendExec({ capture = runHostCapture, maxCapture = SCAN_MAX_CAPTURE } = {}) {
  const wrap = (r) => ({ code: r.timedOut ? 124 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: !!r.timedOut, stdoutTruncated: !!r.stdoutTruncated });
  return {
    async host(argv, { timeoutMs = 120_000, maxCapture: cap = maxCapture } = {}) {
      if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) return { code: -1, stdout: '', stderr: 'host commands are argv arrays of strings' };
      return wrap(await capture(argv[0], argv.slice(1), { timeoutMs, maxCapture: cap }));
    },
    async guest(container, script, { timeoutMs = 90_000, maxCapture: cap = maxCapture } = {}) {
      if (!NAME_RE.test(String(container || ''))) return { code: -1, stdout: '', stderr: 'invalid guest name' };
      return wrap(await capture('incus', ['exec', String(container), '--', 'sh'], { input: script, timeoutMs, maxCapture: cap }));
    },
  };
}

const defaultHost = (() => { let e = null; return (argv, opts) => { e ||= backendExec(); return e.host(argv, opts); }; })();

// Read actual disk usage (bytes) for a storage volume. Used by the
// snapshot-list enrichment and the export-info endpoints in routes/lxc.js,
// and by the application storage check. The /state endpoint is the only API
// that returns true used bytes across storage backends (ZFS, btrfs,
// LVM-thin, dir, ceph) — the volume-show config returns *quotas*, not usage.
//
// `volumePath` is everything after `/volumes/` — for example
// `container/pp-dev` for the live container or
// `container/pp-dev/snapshots/Test2` for a snapshot.
//
// Returns the used bytes as an integer or null when the lookup failed
// (older incus, backend without per-volume accounting, etc).
export async function readVolumeUsedBytes(pool, volumePath, { host = defaultHost } = {}) {
  if (!pool || !volumePath) return null;
  try {
    const r = await host(['incus', 'query', `/1.0/storage-pools/${pool}/volumes/${volumePath}/state`], { timeoutMs: 5000 });
    if (codeOf(r) !== 0) return null;
    const state = JSON.parse(r.stdout || '{}');
    const used = state?.usage?.used ?? state?.used ?? null;
    // 0 is a real figure (a fresh snapshot holds nothing of its own yet).
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0) return used;
    if (typeof used === 'string' && /^\d+$/.test(used)) return parseInt(used, 10);
    return null;
  } catch {
    return null;
  }
}

async function queryJson(host, path, timeoutMs = 15_000) {
  const r = await host(['incus', 'query', path], { timeoutMs });
  if (codeOf(r) !== 0) return null;
  try { return JSON.parse(r.stdout || 'null'); } catch { return null; }
}

/** `incus query /1.0/instances/<guest>?recursion=1` (status, devices, state, snapshots) or null. */
export async function readInstance(host, guest) {
  if (!NAME_RE.test(String(guest || ''))) return null;
  return queryJson(host, `/1.0/instances/${guest}?recursion=1`);
}

/** The storage pool a root device lives on: { name, driver, source } or null. */
export async function readPool(host, pool) {
  if (!NAME_RE.test(String(pool || ''))) return null;
  const j = await queryJson(host, `/1.0/storage-pools/${pool}`);
  if (!j || typeof j !== 'object') return null;
  return { name: j.name || pool, driver: j.driver || null, source: j.config?.source || j.config?.['zfs.pool_name'] || null };
}

const num = (v) => (v == null || v === '' || v === '-' || v === 'none' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** `zfs get -Hp -o property,value …` → named byte figures. */
export function parseZfsGet(text) {
  const raw = {};
  for (const line of String(text || '').split('\n')) {
    const [prop, value] = line.split('\t');
    if (prop && value !== undefined) raw[prop.trim()] = value.trim();
  }
  if (!Object.keys(raw).length) return null;
  const ratio = raw.compressratio ? Number(String(raw.compressratio).replace(/x$/i, '')) : null;
  const quota = num(raw.quota);
  const refquota = num(raw.refquota);
  return {
    usedBytes: num(raw.used),
    referencedBytes: num(raw.referenced),
    snapshotsBytes: num(raw.usedbysnapshots),
    datasetBytes: num(raw.usedbydataset),
    logicalUsedBytes: num(raw.logicalused),
    logicalReferencedBytes: num(raw.logicalreferenced),
    compressRatio: Number.isFinite(ratio) ? ratio : null,
    refquotaBytes: refquota && refquota > 0 ? refquota : null,
    quotaBytes: quota && quota > 0 ? quota : null,
    availableBytes: num(raw.available),
  };
}

export function zfsGetArgv(dataset) {
  return ['zfs', 'get', '-Hp', '-o', 'property,value', ZFS_PROPS.join(','), dataset];
}

export async function readZfsDataset(host, dataset) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,250}$/.test(String(dataset || '')) || dataset.includes('..')) return null;
  const r = await host(zfsGetArgv(dataset), { timeoutMs: 20_000 });
  if (codeOf(r) !== 0) return null;
  return parseZfsGet(r.stdout);
}

const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, eb: 1e18, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5, eib: 1024 ** 6 };

/** Incus sizes ("220GiB", "10GB", "1234") → bytes, or null. */
export function parseSizeString(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]*)\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  const unit = m[2].toLowerCase() || 'b';
  const mult = UNITS[unit] ?? UNITS[`${unit}b`] ?? null;
  if (!mult) return null;
  const bytes = Math.round(Number(m[1]) * mult);
  return bytes > 0 ? bytes : null;
}

function rootDevice(instance) {
  for (const devices of [instance?.expanded_devices, instance?.devices]) {
    const hit = Object.values(devices || {}).find((d) => d && d.type === 'disk' && d.path === '/');
    if (hit) return hit;
  }
  return null;
}

/** The guest's disk limit: its root device size, else the dataset's refquota (else quota), else none. */
export function diskLimitOf({ instance, dataset }) {
  const size = parseSizeString(rootDevice(instance)?.size);
  if (size) return { bytes: size, source: 'root-device' };
  if (dataset?.refquotaBytes) return { bytes: dataset.refquotaBytes, source: 'refquota' };
  if (dataset?.quotaBytes) return { bytes: dataset.quotaBytes, source: 'quota' };
  return { bytes: null, source: null };
}

/** lxc_exports rows of this guest (the store keys them by the name without the pp- prefix). */
export function exportsFor(mainDb, guest) {
  if (!mainDb) return null;
  try {
    const short = String(guest).replace(/^pp-/, '');
    return mainDb.prepare('SELECT id, container_name, snapshot_name, filename, state, bytes_done, bytes_total, created_at FROM lxc_exports WHERE container_name IN (?, ?) ORDER BY id DESC').all(short, String(guest))
      .map((r) => ({ id: Number(r.id), state: r.state, bytes: Number(r.bytes_total || r.bytes_done || 0), createdAt: r.created_at, filename: r.filename, snapshot: r.snapshot_name || null }));
  } catch {
    return null;
  }
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

/** The host-side roots to measure for a target (fixed by kind, never caller input). */
export function hostScanPlan(target) {
  if (target.kind === 'application') return { roots: [{ path: HOST_TRANSFER_ROOT, depth: 1, role: 'host-transfers' }] };
  if (target.kind === 'project' && typeof target.repoPath === 'string' && /^\/[A-Za-z0-9_./-]+\.git$/.test(target.repoPath) && !target.repoPath.includes('..')) {
    return { roots: [{ path: target.repoPath, depth: 0, role: 'host-repo' }] };
  }
  return { roots: [] };
}

/**
 * Every host-side fact for the target. Never throws: what could not be read
 * becomes an `unmeasured` entry.
 */
export async function measureHost({ target, exec, mainDb = null, listExports = null, budget = { ms: 30_000, entries: 1_000_000 } }) {
  const host = (argv, opts) => exec.host(argv, opts);
  const unmeasured = [];
  const out = { guest: target.guest, running: false, status: null, instanceType: null, pool: null, poolDriver: null, datasetName: null, dataset: null, limit: { bytes: null, source: null }, usageBytes: null, snapshots: [], exports: [], hostFiles: null, unmeasured };
  const instance = await readInstance(host, target.guest).catch(() => null);
  if (!instance) {
    unmeasured.push({ area: 'container', reason: 'The container could not be found or read on this host' });
  } else {
    out.status = instance.status || null;
    out.running = String(instance.status || '').toLowerCase() === 'running';
    out.instanceType = instance.type || 'container';
    const root = rootDevice(instance);
    out.pool = root?.pool || null;
    const usage = Number(instance.state?.disk?.root?.usage);
    out.usageBytes = Number.isFinite(usage) && usage > 0 ? usage : null;
    const pool = out.pool ? await readPool(host, out.pool).catch(() => null) : null;
    out.poolDriver = pool?.driver || null;
    if (pool?.driver === 'zfs' && pool.source) {
      out.datasetName = incusInstanceDataset(pool.source, { type: out.instanceType, name: target.guest });
      out.dataset = await readZfsDataset(host, out.datasetName).catch(() => null);
      if (!out.dataset) unmeasured.push({ area: 'disk figures', reason: 'The ZFS figures for this container could not be read' });
    } else {
      unmeasured.push({ area: 'disk figures', reason: pool ? `The container's storage pool uses ${pool.driver || 'an unknown driver'}, not ZFS, so disk and snapshot figures are not available` : 'The storage pool of this container could not be read' });
    }
    out.limit = diskLimitOf({ instance, dataset: out.dataset });
    const volumeKind = out.instanceType === 'virtual-machine' ? 'virtual-machine' : 'container';
    const snaps = Array.isArray(instance.snapshots) ? instance.snapshots : [];
    out.snapshots = await mapLimit(snaps.filter((s) => s && typeof s.name === 'string'), 4, async (s) => {
      const name = String(s.name).split('/').pop();
      const used = out.pool ? await readVolumeUsedBytes(out.pool, `${volumeKind}/${target.guest}/snapshots/${name}`, { host }).catch(() => null) : null;
      return { name, createdAt: s.created_at || null, stateful: !!s.stateful, usedBytes: used };
    });
  }
  const exports = typeof listExports === 'function' ? await Promise.resolve(listExports(target.guest)).catch(() => null) : exportsFor(mainDb, target.guest);
  if (exports == null) unmeasured.push({ area: 'exports', reason: 'The list of prepared exports could not be read' });
  out.exports = exports || [];
  const plan = hostScanPlan(target);
  if (plan.roots.length) {
    const r = await exec.host(scanArgv({ ...plan, budget, maxChildren: 2000 }), { timeoutMs: (budget.ms || 30_000) + 30_000 }).catch((e) => ({ code: -1, stdout: '', stderr: String(e?.message || e) }));
    const parsed = parseScanOutput(r);
    if (parsed.ok) out.hostFiles = parsed.facts;
    else unmeasured.push({ area: 'host files', reason: parsed.code === 'NO_NODE' ? 'Node.js is not available on the host, so host-side leftovers could not be measured' : parsed.reason });
  }
  return out;
}

/** Run the guest collector through exec.guest. */
export async function scanGuest({ target, exec, input, timeoutMs }) {
  const r = await exec.guest(target.guest, scanScript(input), { timeoutMs, maxCapture: SCAN_MAX_CAPTURE }).catch((e) => ({ code: -1, stdout: '', stderr: String(e?.message || e) }));
  return parseScanOutput(r);
}
