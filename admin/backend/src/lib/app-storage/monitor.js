// Per-application storage and growth alerts. Every 15 minutes
// (PROXYPILOT_APP_STORAGE_MONITOR_CRON; PROXYPILOT_DISABLE_CRONS=1 turns it
// off) one `incus list` gives each guest's root usage; a sample is recorded
// for every target whose alerts are on (30 days kept), and:
//   appstorage:usage:<targetKey>   warning at the warning level, error at 1.5×;
//                                  resolves below 95 % of it (hysteresis);
//   appstorage:growth:<targetKey>  grew by the growth threshold within the window;
//   appstorage:cleanup:<targetKey> posted by the cleanup job when items failed;
//                                  resolved by the next successful cleanup;
//   appstorage:health:<targetKey>  posted when the health check after a cleanup
//                                  failed; resolved by the next passing one.
// Bell rows dedupe on the key; the out-of-band channels (push, email, SMS,
// webhooks: events appstorage.usage|growth|cleanup|health) fire only when an
// alert is new. The active set is rebuilt at boot from the bell rows. The
// whole-pool storage-monitor is separate and unchanged.

import cron from 'node-cron';
import { formatBytes } from './accounting.js';

export const ALERT_PREFIX = 'appstorage:';
export const ALERT_KINDS = Object.freeze(['usage', 'growth', 'cleanup', 'health']);
export const DEFAULT_MONITOR_CRON = '*/15 * * * *';
export const RESOLVE_BELOW = 0.95;
export const ERROR_AT = 1.5;
const SOURCE = 'app-storage';

export const alertKey = (kind, targetKey) => `${ALERT_PREFIX}${kind}:${targetKey}`;
export function parseAlertKey(key) {
  const m = /^appstorage:(usage|growth|cleanup|health):((?:application|project):[0-9]+)$/.exec(String(key || ''));
  return m ? { kind: m[1], targetKey: m[2] } : null;
}
const linkFor = (targetKey) => `/storage/applications?target=${encodeURIComponent(targetKey)}`;

/** The usage decision: 'raise' (with level), 'keep' (in the hysteresis band), 'resolve' or 'none'. */
export function evaluateUsage({ usedBytes, warnBytes, active = false }) {
  const used = Number(usedBytes); const warn = Number(warnBytes);
  if (!Number.isFinite(used) || !Number.isFinite(warn) || warn <= 0) return { action: active ? 'resolve' : 'none' };
  if (used >= warn) return { action: 'raise', level: used >= ERROR_AT * warn ? 'error' : 'warning' };
  if (active && used >= RESOLVE_BELOW * warn) return { action: 'keep' };
  return { action: active ? 'resolve' : 'none' };
}

/** Growth within the window: now − the lowest sample in it. */
export function evaluateGrowth({ samples = [], usedBytes, growthBytes }) {
  const used = Number(usedBytes);
  const values = samples.map((s) => Number(s.usedBytes)).filter(Number.isFinite);
  if (!Number.isFinite(used) || !values.length) return { growth: 0, raise: false };
  const growth = Math.max(0, used - Math.min(used, ...values));
  return { growth, raise: Number(growthBytes) > 0 && growth >= Number(growthBytes) };
}

export function usageAlert({ name, guest, targetKey, usedBytes, warnBytes, level }) {
  return {
    key: alertKey('usage', targetKey), kind: 'usage', event: 'appstorage.usage', level,
    title: `${name} uses ${formatBytes(usedBytes)} of storage (warning level ${formatBytes(warnBytes)})`,
    body: `${name} (guest ${guest}) is above its storage warning level. Run a storage check to see what can be cleaned up; nothing is removed automatically by this alert.`,
  };
}

export function growthAlert({ name, guest, targetKey, growth, windowHours }) {
  return {
    key: alertKey('growth', targetKey), kind: 'growth', event: 'appstorage.growth', level: 'warning',
    title: `${name} grew by ${formatBytes(growth)} in the last ${windowHours} hours`,
    body: `${name} (guest ${guest}) grew quickly. Run a storage check to see what grew; nothing is removed automatically by this alert.`,
  };
}

/** `incus list --all-projects --format json` → Map(name → { status ('Running', 'Stopped', … as Incus says), usedBytes, project }); the default project wins a name clash. */
export function parseGuestList(json) {
  let list; try { list = typeof json === 'string' ? JSON.parse(json) : json; } catch { return new Map(); }
  const out = new Map();
  for (const c of Array.isArray(list) ? list : []) {
    const name = String(c?.name || '');
    if (!name) continue;
    const project = c?.project || 'default';
    if (out.has(name) && out.get(name).project === 'default') continue;
    const usage = Number(c?.state?.disk?.root?.usage);
    out.set(name, { status: c?.status ? String(c.status) : null, usedBytes: Number.isFinite(usage) && usage > 0 ? usage : null, project });
  }
  return out;
}

/** A cached guest lister over an argv host executor (one `incus list` per minute at most). */
export function createGuestLister(exec, { ttlMs = 60_000, now = () => Date.now() } = {}) {
  let cache = null;
  return async function listGuests() {
    if (cache && now() - cache.at < ttlMs) return cache.map;
    let r = await exec.host(['incus', 'list', '--all-projects', '--format', 'json'], { timeoutMs: 60_000, maxCapture: 64 * 1024 * 1024 });
    if ((r?.code ?? r?.status) !== 0) r = await exec.host(['incus', 'list', '--format', 'json'], { timeoutMs: 60_000, maxCapture: 64 * 1024 * 1024 });
    if ((r?.code ?? r?.status) !== 0) throw new Error('could not list the guests');
    const map = parseGuestList(r.stdout);
    map.checkedAt = new Date(now()).toISOString();
    cache = { at: now(), map };
    return map;
  };
}

/**
 * Post or resolve the cleanup and health alerts for a finished cleanup.
 * Called by the cleanup job (any process): outcome = { ok, failedCount,
 * healthFailed } where healthFailed true/false posts/resolves the health
 * alert and undefined leaves it alone. deps: { name, notifications: { post,
 * resolve, list, dispatch } } — defaults are the backend's bell and dispatch.
 */
export async function postCleanupAlert(targetKey, { ok = true, failedCount = 0, healthFailed = undefined } = {}, { name = null, notifications = null } = {}) {
  const n = notifications || await defaultNotifications();
  const label = name || targetKey;
  const out = { posted: [], resolved: [] };
  const isActive = (key) => { try { return (n.list?.({ limit: 500 }) || []).some((row) => row.dedupe_key === key); } catch { return false; } };
  const raise = async (alert) => {
    const isNew = !isActive(alert.key);
    try { n.post({ level: alert.level, title: alert.title, body: alert.body, source: SOURCE, source_id: targetKey, dedupe_key: alert.key }); } catch { /* best effort */ }
    if (isNew) { try { await n.dispatch?.({ event: alert.event, level: alert.level, title: alert.title, body: alert.body, link: linkFor(targetKey), dedupe_key: alert.key }); } catch { /* best effort */ } }
    out.posted.push(alert.key);
  };
  const clear = (key, reason) => { try { if (n.resolve(key, { reason })) out.resolved.push(key); } catch { /* best effort */ } };
  const failed = Math.max(0, Number(failedCount) || 0);
  if (!ok || failed > 0) {
    await raise({ key: alertKey('cleanup', targetKey), event: 'appstorage.cleanup', level: 'error',
      title: `Storage cleanup for ${label} did not finish: ${failed ? `${failed} item${failed === 1 ? '' : 's'} failed` : 'it stopped with an error'}`,
      body: `The storage cleanup of ${label} did not finish cleanly. Nothing was rolled back; open its result to see what was removed, skipped and failed, then run a new storage check.` });
  } else clear(alertKey('cleanup', targetKey), 'a later cleanup succeeded');
  if (healthFailed === true) {
    await raise({ key: alertKey('health', targetKey), event: 'appstorage.health', level: 'error',
      title: `${label} failed its health check after a storage cleanup`,
      body: `After the storage cleanup, ${label} did not pass its health check. No snapshot was taken and nothing was rolled back automatically; check the application now.` });
  } else if (healthFailed === false) clear(alertKey('health', targetKey), 'the health check passed');
  return out;
}

async function defaultNotifications() {
  const [b, d] = await Promise.all([import('../notifications.js'), import('../notification-dispatch.js')]);
  return { post: b.postNotification, resolve: b.resolveNotification, list: b.listNotifications, dispatch: d.dispatchToChannels };
}

/**
 * The monitor: createAppStorageMonitor({ store, listTargets, listGuests,
 * policyFor, notifications, now, logger }) → { runOnce, hydrate, alertsFor,
 * active, postCleanupAlert }.
 */
export function createAppStorageMonitor({ store, listTargets, listGuests, policyFor, notifications = null, now = () => Date.now(), logger = console } = {}) {
  const active = new Set();
  let running = false;
  let notes = notifications;
  const n = async () => (notes ||= await defaultNotifications());

  async function raise(alert, targetKey) {
    const bell = await n();
    const isNew = !active.has(alert.key);
    try { bell.post({ level: alert.level, title: alert.title, body: alert.body, source: SOURCE, source_id: targetKey, dedupe_key: alert.key }); } catch (e) { logger?.error?.('[app-storage-monitor] post failed', e?.message); }
    active.add(alert.key);
    if (!isNew) return false;
    try { await bell.dispatch?.({ event: alert.event, level: alert.level, title: alert.title, body: alert.body, link: linkFor(targetKey), dedupe_key: alert.key }); } catch (e) { logger?.error?.('[app-storage-monitor] dispatch failed', e?.message); }
    return true;
  }
  async function clear(key, reason) {
    if (!active.has(key)) return false;
    const bell = await n();
    try { bell.resolve(key, { reason }); } catch { /* ignore */ }
    active.delete(key);
    return true;
  }

  async function runOnce() {
    if (running) return { skipped: 'already running' };
    running = true;
    const summary = { sampled: 0, raised: [], resolved: [] };
    try {
      const guests = await listGuests();
      const nowMs = now();
      const at = new Date(nowMs).toISOString();
      for (const t of listTargets()) {
        let pol;
        try { pol = policyFor(t)?.policy; } catch { pol = null; }
        const alerts = pol?.alerts;
        const usageKey = alertKey('usage', t.key); const growthKey = alertKey('growth', t.key);
        if (!alerts?.enabled) {
          for (const k of [usageKey, growthKey]) if (await clear(k, 'alerts turned off')) summary.resolved.push(k);
          continue;
        }
        const g = guests?.get?.(t.guest);
        if (!g || g.usedBytes == null) continue;
        store.addSample(t.key, g.usedBytes, at);
        summary.sampled += 1;
        const u = evaluateUsage({ usedBytes: g.usedBytes, warnBytes: alerts.warnBytes, active: active.has(usageKey) });
        if (u.action === 'raise') { await raise(usageAlert({ name: t.name, guest: t.guest, targetKey: t.key, usedBytes: g.usedBytes, warnBytes: alerts.warnBytes, level: u.level }), t.key); summary.raised.push(usageKey); }
        else if (u.action === 'resolve' && await clear(usageKey, 'usage is below the warning level')) summary.resolved.push(usageKey);
        const windowHours = Number(alerts.growthWindowHours) || 24;
        const samples = store.samplesSince(t.key, nowMs - windowHours * 3_600_000);
        const gr = evaluateGrowth({ samples, usedBytes: g.usedBytes, growthBytes: alerts.growthBytes });
        if (gr.raise) { await raise(growthAlert({ name: t.name, guest: t.guest, targetKey: t.key, growth: gr.growth, windowHours }), t.key); summary.raised.push(growthKey); }
        else if (await clear(growthKey, 'growth fell below the threshold')) summary.resolved.push(growthKey);
      }
      await relayRunnerAlerts(summary);
      return summary;
    } catch (e) {
      logger?.error?.('[app-storage-monitor] runOnce failed', e?.message || e);
      return { ...summary, error: e?.message || String(e) };
    } finally { running = false; }
  }

  // The cleanup job runs in the host runner, which writes the bell row but
  // cannot reach the delivery channels (they need the backend's database
  // connection and keys). A cleanup or health alert in the bell that this
  // monitor did not raise is delivered once here; one the runner resolved
  // leaves the active set.
  async function relayRunnerAlerts(summary) {
    const bell = await n();
    let rows = [];
    try { rows = bell.list?.({ limit: 1000 }) || []; } catch { return; }
    const open = new Set();
    for (const row of rows) {
      const k = parseAlertKey(row?.dedupe_key);
      if (!k || !['cleanup', 'health'].includes(k.kind)) continue;
      open.add(row.dedupe_key);
      if (active.has(row.dedupe_key)) continue;
      active.add(row.dedupe_key);
      try { await bell.dispatch?.({ event: `appstorage.${k.kind}`, level: row.level, title: row.title, body: row.body, link: linkFor(k.targetKey), dedupe_key: row.dedupe_key }); } catch (e) { logger?.error?.('[app-storage-monitor] dispatch failed', e?.message); }
      summary.relayed = [...(summary.relayed || []), row.dedupe_key];
    }
    for (const key of [...active]) { const k = parseAlertKey(key); if (k && ['cleanup', 'health'].includes(k.kind) && !open.has(key)) active.delete(key); }
  }

  /** Rebuild the active set from the bell rows (non-dismissed, appstorage: keys). */
  async function hydrate() {
    try {
      const bell = await n();
      for (const row of bell.list?.({ limit: 1000 }) || []) if (row?.dedupe_key && String(row.dedupe_key).startsWith(ALERT_PREFIX)) active.add(row.dedupe_key);
    } catch { /* fresh install */ }
    return active.size;
  }

  /** Open alerts of one target (for the overview), from the bell rows. */
  function alertsFor(targetKey) {
    const rows = [];
    try {
      const list = notes?.list?.({ limit: 1000 }) || [];
      for (const row of list) {
        const k = parseAlertKey(row?.dedupe_key);
        if (k && k.targetKey === targetKey) rows.push({ key: row.dedupe_key, kind: k.kind, level: row.level, title: row.title });
      }
    } catch { /* none */ }
    return rows;
  }

  return {
    runOnce, hydrate, alertsFor, active,
    postCleanupAlert: async (targetKey, outcome, opts = {}) => {
      const r = await postCleanupAlert(targetKey, outcome, { ...opts, notifications: opts.notifications || await n() });
      for (const k of r.posted) active.add(k);
      for (const k of r.resolved) active.delete(k);
      return r;
    },
  };
}

/* ------------------------------ scheduling ------------------------------ */

let task = null;
export function registerMonitor(monitor, { expr = process.env.PROXYPILOT_APP_STORAGE_MONITOR_CRON || DEFAULT_MONITOR_CRON, logger = console } = {}) {
  unregisterMonitor();
  try {
    task = cron.schedule(expr, () => { monitor.runOnce().catch(() => {}); }, { timezone: process.env.TZ || 'UTC' });
    logger?.log?.(`[app-storage-monitor] registered (cron=${expr})`);
  } catch (e) { logger?.error?.('[app-storage-monitor] register failed', e?.message); }
  return task;
}
export function unregisterMonitor() { if (task) { try { task.destroy(); } catch { /* ignore */ } task = null; } }
