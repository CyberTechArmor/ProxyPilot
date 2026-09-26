// Host runner — the loop. The executor itself (claim, lease, steps, record)
// lives in the backend's pure setup-engine layer (lib/setup-engine/
// executor.js) so the runner and the backend's legacy in-process mode run
// the identical code; this module re-exports it and adds the long-running
// service loop with its heartbeat and clean goodbye.

import { runnerHeartbeat, runnerGoodbye } from '../../../admin/backend/src/lib/setup-engine/store.js';
import { parseOwner } from '../../../admin/backend/src/lib/setup-engine/logic.js';
import { executeJob, reconcile, runOnce, describeOwner, FencedError, CancelledError } from '../../../admin/backend/src/lib/setup-engine/executor.js';

export { executeJob, reconcile, runOnce, describeOwner, FencedError, CancelledError };

// serve(deps, { pollMs, reconcileEveryMs, shouldStop }) — the long-running
// loop the systemd unit runs. Reconciles on start and periodically, polls the
// queue between, heartbeats every tick. Never throws: a failed tick is logged
// and the next one runs.
export async function serve(deps, { pollMs = 2000, reconcileEveryMs = 60_000, heartbeatEveryMs = 10_000, shouldStop = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastReconcile = 0;
  deps.log?.('serve', `runner ${deps.owner} started`);
  // runOnce can await a long incus command. Keep the runner's own liveness
  // separate from that work so submissions do not mistake a busy runner for
  // a dead one after RUNNER_LIVE_MS (30 seconds).
  const who = parseOwner(deps.owner) || {};
  const heartbeat = () => {
    try {
      runnerHeartbeat(deps.db, { owner: deps.owner, host: who.host || null, pid: who.pid || null, nowMs: deps.nowMs ? deps.nowMs() : Date.now() });
    } catch (e) {
      deps.log?.('heartbeat failed', e?.message || e);
    }
  };
  const timer = setInterval(heartbeat, heartbeatEveryMs);
  timer.unref?.();
  try {
    while (!shouldStop()) {
      const now = deps.nowMs ? deps.nowMs() : Date.now();
      try {
        await runOnce(deps, { reconcileFirst: now - lastReconcile >= reconcileEveryMs });
        if (now - lastReconcile >= reconcileEveryMs) lastReconcile = now;
      } catch (e) {
        deps.log?.('tick failed', e?.message || e);
        heartbeat();
      }
      await sleep(pollMs);
    }
  } finally {
    clearInterval(timer);
    try { runnerGoodbye(deps.db, { owner: deps.owner }); } catch { /* */ }
    deps.log?.('serve', 'stopping');
  }
}
