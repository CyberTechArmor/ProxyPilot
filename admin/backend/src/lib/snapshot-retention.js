import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export const SNAPSHOT_RETENTION = Object.freeze(JSON.parse(
  readFileSync(new URL('./mcp-policy/snapshot-retention.json', import.meta.url), 'utf8'),
).guests);

// Incus timestamps have nanosecond precision; Date.parse alone loses the
// ordering of snapshots taken within the same millisecond.
function creationTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('snapshot creation time is missing or invalid');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('snapshot creation time is invalid');
  const fraction = (value.match(/\.(\d+)/)?.[1] || '').padEnd(9, '0');
  return BigInt(ms) * 1_000_000n + BigInt(fraction.slice(3));
}

export function snapshotRetentionPlan(instance, keep) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new Error('snapshot retention must be an integer from 1 to 1000');
  if (!instance || !Array.isArray(instance.snapshots)) throw new Error('the instance snapshot inventory is unavailable');
  const seen = new Set();
  const snapshots = instance.snapshots.map(snapshot => {
    if (!snapshot || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(snapshot.name) || seen.has(snapshot.name)) throw new Error('the snapshot inventory contains an invalid or duplicate name');
    seen.add(snapshot.name);
    return { ...snapshot, time: creationTime(snapshot.created_at) };
  }).sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : a.name.localeCompare(b.name));
  // Fail closed at an ambiguous boundary rather than guessing which is newer.
  const excess = Math.max(0, snapshots.length - keep);
  if (excess && snapshots[excess - 1].time === snapshots[excess].time) throw new Error('snapshot creation times tie at the retention boundary');
  return snapshots.slice(0, excess).map(({ time, ...snapshot }) => snapshot);
}

export function retentionEventGuest(event, limits = SNAPSHOT_RETENTION) {
  if (event?.type !== 'lifecycle' || !['instance-snapshot-created', 'instance-snapshot-renamed', 'instance-restored'].includes(event.metadata?.action)) return null;
  let source;
  try { source = new URL(event.metadata.source, 'http://incus.local'); } catch { return null; }
  if (source.origin !== 'http://incus.local' || (event.project || source.searchParams.get('project') || 'default') !== 'default') return null;
  const match = /^\/1\.0\/instances\/([^/]+)(?:\/snapshots\/[^/]+)?$/.exec(source.pathname);
  if (!match) return null;
  let name;
  try { name = decodeURIComponent(match[1]); } catch { return null; }
  return Object.hasOwn(limits, name) ? name : null;
}

export async function readRetentionInstance(host, name) {
  const result = await host(['incus', 'list', name, '--format', 'json'], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error('could not read the instance snapshot inventory');
  const instances = JSON.parse(result.stdout);
  if (!Array.isArray(instances)) throw new Error('the instance inventory is not a list');
  return instances.find(instance => instance.name === name) || null;
}

// Called inside the creating setup job, using its fenced host executor. A
// failed creation never reaches here, and every delete is read back as gone.
export async function enforceSnapshotRetention(host, name, { createdSnapshot = null, limits = SNAPSHOT_RETENTION } = {}) {
  if (!Object.hasOwn(limits, name)) return { ok: true, skipped: true, deleted: [] };
  const deleted = [];
  try {
    for (let attempts = 0; attempts < 1000; attempts += 1) {
      const instance = await readRetentionInstance(host, name);
      if (createdSnapshot && !instance?.snapshots?.some(snapshot => snapshot.name === createdSnapshot)) throw new Error('the newly created snapshot could not be verified');
      const oldest = snapshotRetentionPlan(instance, limits[name])[0];
      if (!oldest) return { ok: true, keep: limits[name], deleted };
      if (oldest.name === createdSnapshot) throw new Error('the newly created snapshot is outside the newest retained set');
      const result = await host(['incus', 'snapshot', 'delete', name, oldest.name], { timeoutMs: 5 * 60_000 });
      if (result.code !== 0) throw new Error(`could not prune snapshot ${oldest.name}`);
      const after = await readRetentionInstance(host, name);
      if (!after || after.snapshots.some(snapshot => snapshot.name === oldest.name)) throw new Error(`snapshot ${oldest.name} was not verified absent`);
      deleted.push(oldest.name);
    }
    throw new Error('snapshot inventory kept changing during retention');
  } catch (error) {
    return { ok: false, error: error.message, deleted };
  }
}

// Events cover direct Incus/API callers too. Deletes go through the ordinary
// setup engine, bound to the snapshot's timestamp. A busy guest is retried;
// its lease is never bypassed, including during a restore of an old snapshot.
export function startSnapshotRetention({ spawnMonitor, listInstance, deleteSnapshot, limits = SNAPSHOT_RETENTION, log = console.error, schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false;
  let monitor = null;
  let lines = null;
  let reconnect = null;
  const running = new Set();
  const pending = new Set();
  const retries = new Map();
  const retry = (name, delay) => {
    if (stopped || retries.has(name)) return;
    const timer = schedule(() => { retries.delete(name); enqueue(name); }, delay);
    timer?.unref?.();
    retries.set(name, timer);
  };
  const drain = async name => {
    running.add(name);
    pending.delete(name);
    try {
      for (let attempts = 0; !stopped && attempts < 1000; attempts += 1) {
        const instance = await listInstance(name);
        if (stopped || !instance) return;
        const oldest = snapshotRetentionPlan(instance, limits[name])[0];
        if (!oldest) return;
        const result = await deleteSnapshot(name, oldest);
        if (!result?.ok) {
          if (result?.code !== 'CONTAINER_BUSY') log('[snapshot-retention] cleanup will retry', { guest: name, code: result?.code || 'DELETE_NOT_VERIFIED' });
          retry(name, result?.code === 'CONTAINER_BUSY' ? 1000 : 30_000);
          return;
        }
        const after = await listInstance(name);
        if (!after || after.snapshots.some(snapshot => snapshot.name === oldest.name)) throw new Error('snapshot deletion was not verified');
        log('[snapshot-retention] pruned oldest snapshot', { guest: name, snapshot: oldest.name, keep: limits[name] });
      }
      if (!stopped) retry(name, 1000);
    } catch {
      log('[snapshot-retention] inventory or cleanup failed; retrying', { guest: name });
      retry(name, 30_000);
    } finally {
      running.delete(name);
      if (!stopped && pending.has(name) && !retries.has(name)) enqueue(name);
    }
  };
  const enqueue = name => {
    if (stopped || !Object.hasOwn(limits, name)) return;
    if (running.has(name)) { pending.add(name); return; }
    void drain(name);
  };
  const connect = () => {
    if (stopped) return;
    try {
      monitor = spawnMonitor();
      const child = monitor;
      const disconnected = () => {
        if (monitor !== child) return;
        monitor = null;
        lines?.close();
        lines = null;
        child.kill();
        if (!stopped && reconnect === null) {
          log('[snapshot-retention] event stream disconnected; reconnecting');
          reconnect = schedule(() => { reconnect = null; connect(); }, 3000);
          reconnect?.unref?.();
        }
      };
      child.once('error', disconnected);
      child.once('close', disconnected);
      child.stderr?.resume();
      lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (!line.trim() || line.length > 1024 * 1024) return;
        try { const name = retentionEventGuest(JSON.parse(line), limits); if (name) enqueue(name); } catch { /* Ignore non-event output; never interpret it as instructions. */ }
      });
      // Incus does not replay missed events. Reconcile on boot/reconnection.
      for (const name of Object.keys(limits)) enqueue(name);
      log('[snapshot-retention] event listener started', { guests: limits });
    } catch {
      log('[snapshot-retention] event listener unavailable; retrying');
      reconnect = schedule(() => { reconnect = null; connect(); }, 3000);
      reconnect?.unref?.();
    }
  };
  connect();
  return () => {
    stopped = true;
    if (reconnect !== null) cancel(reconnect);
    for (const timer of retries.values()) cancel(timer);
    retries.clear();
    lines?.close();
    monitor?.kill();
    monitor = null;
  };
}
