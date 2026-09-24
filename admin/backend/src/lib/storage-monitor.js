// Storage alert monitor — every 15 minutes (PROXYPILOT_STORAGE_MONITOR_CRON)
// evaluate the storage alert conditions (pool DEGRADED/FAULTED, SMART
// failure or warning, scrub errors, scrub overdue, capacity, snapshot or
// replication older than policy) and post them as notifications: the bell
// row (deduped per subject, auto-resolved when the condition clears) and the
// out-of-band channels — email, SMS, push and the signed webhooks — through
// the same dispatch every other alert source uses (events storage.*).
//
// Same register/unregister/hydrate shape as cert-expiry-scheduler.js, same
// PROXYPILOT_DISABLE_CRONS guard. Skips quietly when zfs is not installed.

import cron from 'node-cron';
import { postNotification, resolveNotification, listNotifications } from './notifications.js';
import { dispatchToChannels } from './notification-dispatch.js';
import { storageService } from './storage/index.js';
import { ALERT_KEY_PREFIXES } from './storage/freshness.js';

const DEFAULT_CRON = '*/15 * * * *';
let task = null;
let running = false;
let logger = (msg, ctx) => console.log(`[storage-monitor] ${msg}`, ctx ?? '');
export function setLogger(fn) { if (typeof fn === 'function') logger = fn; }

// Which alert keys we raised last time, so a cleared condition resolves its row
// (the bell store keeps dedupe keys; we also scan it on boot).
const active = new Set();

export async function runOnce({ svc = null, notify = null } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    const service = svc || storageService();
    const tc = await service.toolchain();
    if (!tc.zpool) return { skipped: 'zfs not installed' };
    const { alerts } = await service.alerts();
    const post = notify || defaultNotify;
    const seen = new Set();
    let raised = 0;
    for (const a of alerts) {
      seen.add(a.key);
      const isNew = !active.has(a.key);
      await post(a, { isNew });
      active.add(a.key);
      raised += 1;
    }
    // Resolve everything storage-shaped that is no longer alerting.
    for (const key of [...active]) if (!seen.has(key)) { try { resolveNotification(key, { reason: 'recovered' }); } catch { /* ignore */ } active.delete(key); }
    return { checked: true, alerts: raised };
  } catch (err) {
    logger('runOnce failed', { error: err?.message });
    return { error: err?.message };
  } finally { running = false; }
}

async function defaultNotify(a, { isNew }) {
  try { postNotification({ level: a.level, title: a.title, body: a.body, source: 'storage', source_id: String(a.subject || ''), dedupe_key: a.key }); } catch (e) { logger('postNotification failed', { error: e?.message }); }
  if (!isNew) return; // out-of-band channels fire once per condition, not every 15 minutes
  try { await dispatchToChannels({ event: a.event, level: a.level, title: a.title, body: a.body, link: '/storage', dedupe_key: a.key }); } catch (e) { logger('dispatch failed', { error: e?.message }); }
}

function hydrateActiveFromBell() {
  try {
    for (const n of listNotifications({ limit: 500 })) if (n.dedupe_key && ALERT_KEY_PREFIXES.some((p) => n.dedupe_key.startsWith(p))) active.add(n.dedupe_key);
  } catch { /* fresh install */ }
}

export function register() {
  unregister();
  const expr = process.env.PROXYPILOT_STORAGE_MONITOR_CRON || DEFAULT_CRON;
  try {
    task = cron.schedule(expr, () => { runOnce().catch(() => {}); }, {  timezone: process.env.TZ || 'UTC' });
    logger(`registered (cron=${expr})`);
  } catch (err) { logger('register failed', { error: err?.message }); }
}

export function unregister() { if (task) { try { task.destroy(); } catch { /* ignore */ } task = null; } }

export function hydrate() {
  if (process.env.PROXYPILOT_DISABLE_CRONS === '1') return;
  hydrateActiveFromBell();
  register();
  setTimeout(() => { runOnce().catch(() => {}); }, 20000).unref?.();
}
