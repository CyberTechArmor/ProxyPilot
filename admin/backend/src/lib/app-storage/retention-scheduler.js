// Application storage — the RETENTION SCHEDULER (DESIGN §3.4, automation).
//
// Every six hours (PROXYPILOT_APP_STORAGE_RETENTION_CRON, default
// `23 */6 * * *`; nothing with PROXYPILOT_DISABLE_CRONS=1), for each target
// whose policy has a periodic rule turned ON: a policy storage check, then the
// eligible items those rules cover and that are old enough by the rule's own
// limit, through the same requestCleanup as a person's cleanup with
// origin 'policy'. A proposed rule (enabled: false) never runs.
//
// Never: snapshots, exports or releases (those have their own retention or
// are a person's explicit choice), and never anything the check did not mark
// "Can be cleaned up". A busy application is skipped until the next round
// without an alert; a failure is alerted. Ages are applied here as well as by
// the policy's own selection (when given, the two must agree): an item whose
// age is unknown is not selected.

import { busyFrom } from './cleanup-service.js';

export const DEFAULT_CRON = '23 */6 * * *';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const positive = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

// rule → the categories it covers and the minimum age of an item it may take.
export const PERIODIC_RULES = Object.freeze({
  caches: { categories: ['caches'], minAgeMs: r => (positive(r.maxAgeDays) ? r.maxAgeDays * DAY : null) },
  tempFiles: { categories: ['temp'], minAgeMs: r => (positive(r.maxAgeDays) ? r.maxAgeDays * DAY : null) },
  testArtifacts: { categories: ['test_reports'], minAgeMs: r => (positive(r.maxAgeDays) ? r.maxAgeDays * DAY : null) },
  logs: { categories: ['logs'], minAgeMs: (r, item) => (item.action === 'vacuum-journal' ? 0 : positive(r.rotatedMaxAgeDays) ? r.rotatedMaxAgeDays * DAY : null) },
  history: { categories: ['history'], minAgeMs: r => (positive(r.maxAgeDays) ? r.maxAgeDays * DAY : null) },
  workspaces: { categories: ['workspaces', 'archives'], minAgeMs: r => (positive(r.abandonedAfterHours) ? r.abandonedAfterHours * HOUR : null) },
});
const NEVER_CATEGORIES = new Set(['snapshots', 'exports', 'releases', 'running_app', 'dependencies', 'data', 'other']);
const NEVER_ACTIONS = new Set(['delete-snapshot', 'delete-export', 'remove-release']);

export function enabledPeriodicRules(policy) {
  const rules = policy?.rules || {};
  return Object.keys(PERIODIC_RULES).filter(key => rules[key]?.enabled === true);
}

// schedulerSelection(check, policy, { now, policySelection }) → item ids.
export function schedulerSelection(check, policy, { now, policySelection = null } = {}) {
  const enabled = enabledPeriodicRules(policy);
  if (!enabled.length || !Array.isArray(check?.items)) return [];
  const ruleFor = category => enabled.find(key => PERIODIC_RULES[key].categories.includes(category));
  let ids = check.items.filter(item => {
    if (item.status !== 'eligible' || NEVER_CATEGORIES.has(item.category) || NEVER_ACTIONS.has(item.action) || item.kind === 'snapshot' || item.kind === 'export' || item.kind === 'release') return false;
    const key = ruleFor(item.category);
    if (!key) return false;
    const minAge = PERIODIC_RULES[key].minAgeMs(policy.rules[key], item);
    if (minAge == null) return false;
    if (minAge === 0) return true;
    const newest = Number(item.newestMtimeMs ?? item.identity?.mtimeMs);
    return Number.isFinite(newest) && now - newest >= minAge;
  }).map(item => item.id);
  if (typeof policySelection === 'function') {
    const theirs = new Set((policySelection(check, policy) || []).map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean));
    ids = ids.filter(id => theirs.has(id));
  }
  return ids;
}

export function createRetentionScheduler({
  listTargets, resolveTarget = null, policyFor, runCheck, policySelection = null, activityFor, requestCleanup, monitor = null,
  now = () => Date.now(), log = () => {}, env = process.env, scheduleCron = null,
}) {
  let running = false;
  let task = null;
  const alert = async (target, title, body) => {
    try { await monitor?.postCleanupAlert?.({ targetKey: target.key, targetName: target.name || target.key, kind: 'cleanup', ok: false, level: 'error', origin: 'policy', title, body }); } catch { /* an alert never stops the round */ }
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
          await alert(entry, `Automatic storage cleanup for ${entry.name || entry.key} could not run`, `The retention policy could not clean up storage this round (${e?.code || 'error'}). It tries again in six hours.`);
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
