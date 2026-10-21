// One storage check, start to finish: host facts, the guest scan, the
// context, the classification and the accounting. Pure orchestration over an
// injected executor, so the backend (lib/app-storage/check-service.js) and the
// host runner (the cleanup job's rescan) run exactly the same code:
//   exec.guest(container, script, { timeoutMs }) → { code, stdout, stderr }
//   exec.host(argv, { timeoutMs })               → { code, stdout, stderr }
// Never throws: a failure becomes status 'failed' with a plain error.

import { randomUUID } from 'node:crypto';
import { measureHost, scanGuest } from './host-measures.js';
import { scanPlanFor, buildContext, classify } from './classify.js';

export const CHECK_RESULT_VERSION = 1;
export const CHECK_ORIGINS = Object.freeze(['user', 'cleanup', 'policy', 'mcp']);
export const newCheckId = () => `chk_${randomUUID()}`;
const nowOf = (now) => (typeof now === 'function' ? now() : now == null ? Date.now() : Number(now));
const iso = (ms) => new Date(ms).toISOString();

export function publicTarget(target) {
  return { key: target.key, kind: target.kind, id: target.id, name: target.name, guest: target.guest };
}

/**
 * performCheck({ target, activity, exec, policy, now, origin, checkId?,
 *   mainDb?, listExports?, budget? }) → check result (DESIGN §2.6).
 */
export async function performCheck({ target, activity = {}, exec, policy = null, now = Date.now, origin = 'user', checkId = newCheckId(), mainDb = null, listExports = null, budget = { ms: 60_000, entries: 2_000_000 } } = {}) {
  const startedAt = nowOf(now);
  const base = { version: CHECK_RESULT_VERSION, checkId, target: publicTarget(target), origin: CHECK_ORIGINS.includes(origin) ? origin : 'user', startedAt: iso(startedAt) };
  try {
    if (!exec || typeof exec.host !== 'function' || typeof exec.guest !== 'function') throw Object.assign(new Error('No executor is available to measure this container.'), { code: 'NO_EXECUTOR' });
    const host = await measureHost({ target, exec, mainDb, listExports });
    let facts = null;
    const unmeasured = [];
    if (host.running) {
      const scan = await scanGuest({ target, exec, input: scanPlanFor(target, { budget }), timeoutMs: (budget.ms || 60_000) + 60_000 });
      if (scan.ok) facts = scan.facts;
      else unmeasured.push({ area: 'container files', reason: scan.reason });
    } else if (host.status) {
      unmeasured.push({ area: 'container files', reason: `The container is ${String(host.status).toLowerCase()}, so its files could not be measured` });
    }
    const context = buildContext({ target, activity, facts });
    const classified = classify({ target, context, facts, host, policy, now: nowOf(now), checkId });
    const allUnmeasured = [...unmeasured, ...classified.unmeasured];
    const guestKnown = !!host.status;
    const status = !guestKnown ? 'failed'
      : (!facts || facts.budgetExceeded || allUnmeasured.length) ? 'partial' : 'complete';
    const result = {
      ...base,
      status,
      finishedAt: iso(nowOf(now)),
      ...(status === 'failed' ? { error: { code: 'GUEST_NOT_FOUND', message: 'The container could not be found or read on this host, so nothing was measured.' } } : {}),
      totals: classified.totals,
      categories: classified.categories,
      items: classified.items,
      context: {
        liveRelease: context.liveRelease, rollbackRelease: context.rollbackRelease, waitingCandidate: context.waitingCandidate,
        rollbackUnknown: !!context.rollbackUnknown, releasesUnknown: context.releasesUnknown || null,
        backingRoots: context.backingRoots, activeAttempts: context.activeAttempts, recoveryAttempts: context.recoveryAttempts || [], buildActive: context.buildActive,
        openRestoreJob: context.openRestoreJob, reasons: [...(activity.reasons || [])],
      },
      guest: { status: host.status, running: host.running, node: facts?.node || null, elapsedMs: facts?.elapsedMs ?? null, entries: facts?.entries ?? null, budgetExceeded: !!facts?.budgetExceeded, service: facts?.service || null },
      unmeasured: allUnmeasured,
      notes: classified.notes,
    };
    return result;
  } catch (e) {
    return {
      ...base,
      status: 'failed',
      finishedAt: iso(nowOf(now)),
      error: { code: e?.code && /^[A-Z_]+$/.test(e.code) ? e.code : 'CHECK_FAILED', message: e?.code === 'NO_EXECUTOR' ? e.message : 'The storage check failed before it could finish; nothing was changed.', detail: String(e?.message || e || '').slice(0, 300) },
      totals: null, categories: [], items: [], context: null, unmeasured: [], notes: [],
    };
  }
}
