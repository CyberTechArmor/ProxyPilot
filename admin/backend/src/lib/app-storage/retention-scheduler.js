// Application storage — the RETENTION SCHEDULER (DESIGN §3.4, automation).
//
// Every six hours (PROXYPILOT_APP_STORAGE_RETENTION_CRON, default
// `23 */6 * * *`; nothing with PROXYPILOT_DISABLE_CRONS=1), for each target
// whose policy has a periodic rule turned ON: a policy storage check, then the
// eligible items those rules cover and that are old enough by the rule's own
// limit, through the same requestCleanup as a person's cleanup with
// origin 'policy'. A proposed rule (enabled: false) never runs.
//
// Which eligible items a rule takes, by its own age limit, is policy.js
// policySelection — one implementation, also behind the policy page's
// effects. This module adds only the never-list as a guard: never snapshots,
// exports or releases (they have their own retention or are a person's
// explicit choice), and never anything the check did not mark "Can be
// cleaned up". A busy application is skipped until the next round without an
// alert; a failure is alerted.

import { busyFrom } from './cleanup-rows.js';
import { policySelection as defaultPolicySelection } from './policy.js';

export const DEFAULT_CRON = '23 */6 * * *';
export const PERIODIC_RULES = Object.freeze(['workspaces', 'caches', 'tempFiles', 'testArtifacts', 'logs', 'history']);
const NEVER_CATEGORIES = new Set(['snapshots', 'exports', 'releases', 'running_app', 'dependencies', 'data', 'other']);
const NEVER_ACTIONS = new Set(['delete-snapshot', 'delete-export', 'remove-release']);
const NEVER_KINDS = new Set(['snapshot', 'export', 'release', 'pseudo']);

export function enabledPeriodicRules(policy) {
  const rules = policy?.rules || {};
  return PERIODIC_RULES.filter(key => rules[key]?.enabled === true);
}

// schedulerSelection(check, policy, { now, policySelection }) → item ids.
export function schedulerSelection(check, policy, { now, policySelection = defaultPolicySelection } = {}) {
  if (!enabledPeriodicRules(policy).length || !Array.isArray(check?.items)) return [];
  const picked = new Set((policySelection(check, policy, now)?.items || []).map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean));
  return check.items
    .filter(item => picked.has(item.id) && item.status === 'eligible' && !NEVER_CATEGORIES.has(item.category) && !NEVER_ACTIONS.has(item.action) && !NEVER_KINDS.has(item.kind))
    .map(item => item.id);
}

export function createRetentionScheduler({
  listTargets, resolveTarget = null, policyFor, runCheck, policySelection = defaultPolicySelection, activityFor, requestCleanup, monitor = null,
  now = () => Date.now(), log = () => {}, env = process.env, scheduleCron = null,
}) {
  let running = false;
  let task = null;
  const alert = async target => {
    try { await monitor?.postCleanupAlert?.(target.key, { ok: false, failedCount: 0 }, { name: target.name || target.key }); } catch { /* an alert never stops the round */ }
  };

  async function runTarget(entry) {
    const policy = await policyFor(entry.key);
    if (!enabledPeriodicRules(policy).length) return { key: entry.key, skipped: 'no periodic rule is turned on' };
    const target = resolveTarget ? await resolveTarget(entry.key) : entry;
    const busy = busyFrom(await activityFor(target));
    if (busy) return { key: entry.key, skipped: `busy: ${busy}` };
    const check = await runCheck(entry.key);
    if (!check || !['complete', 'partial'].includes(check.status)) return { key: entry.key, skipped: 'the policy storage check did not complete' };
    const items = schedulerSelection(check, policy, { now: now(), policySelection });
    if (!items.length) return { key: entry.key, selected: 0 };
    try {
      const r = await requestCleanup({ targetKey: entry.key, checkId: check.checkId, items, snapshots: [], exports: [], acknowledgeSnapshotLoss: false, scope: 'categories', origin: 'policy', userId: null });
      return { key: entry.key, selected: items.length, cleanupId: r.cleanupId || null, jobId: r.jobId || null };
    } catch (e) {
      if (['GUEST_BUSY', 'CHECK_STALE'].includes(e?.code)) return { key: entry.key, skipped: e.code === 'GUEST_BUSY' ? 'busy: a build or another change started' : 'a newer check appeared' };
      throw e;
    }
  }

  async function runOnce() {
    if (running) return { skipped: 'already running', targets: [] };
    running = true;
    const out = { targets: [] };
    try {
      let targets = [];
      try { targets = (await listTargets()) || []; } catch (e) { log('[app-storage-retention] could not list targets', e?.message || e); return { ...out, error: 'targets unavailable' }; }
      for (const entry of targets) {
        try { out.targets.push(await runTarget(entry)); }
        catch (e) {
          out.targets.push({ key: entry.key, error: e?.code || 'FAILED' });
          log('[app-storage-retention] round failed for a target', { target: entry.key, code: e?.code || null });
          await alert(entry);
        }
      }
      return out;
    } finally { running = false; }
  }

  async function start() {
    if (env.PROXYPILOT_DISABLE_CRONS === '1' || task) return false;
    const expr = env.PROXYPILOT_APP_STORAGE_RETENTION_CRON || DEFAULT_CRON;
    try {
      const schedule = scheduleCron || (await import('node-cron')).default.schedule;
      task = schedule(expr, () => { runOnce().catch(() => {}); }, { timezone: env.TZ || 'UTC' });
      log(`[app-storage-retention] registered (cron=${expr})`);
      return true;
    } catch (e) { log('[app-storage-retention] register failed', e?.message || e); return false; }
  }

  function stop() { if (task) { try { (task.destroy || task.stop)?.call(task); } catch { /* */ } task = null; } }

  return { runOnce, start, stop };
}
