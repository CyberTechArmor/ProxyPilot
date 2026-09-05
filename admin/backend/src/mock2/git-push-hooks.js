// Auto-push hooks: when ProxyPilot itself changes a static site's files or an
// LXC guest's app directory (UI editor, zip apply, MCP write, startup re-run),
// push the target's mirror to its git remote — if the remote is in 'auto' mode.
//
// Subscribes to the core's content-change seam (lib/change-events.js) at
// enabled boot; the core never imports this module (ADR-001). Pushes are
// debounced per target so a burst of edits (an import of forty files) becomes
// one commit, and they are best-effort: a failure lands in the remote row's
// last_push_error, never in the request that made the change.

import { onContentChanged } from '../lib/change-events.js';

// git-connectors.js reaches the native DB; it is imported lazily by
// registerGitPushHooks so this module (and its tests) stay native-free.
let deps = { lookup: null, push: null };

export const AUTO_PUSH_DEBOUNCE_MS = 5000;

const pending = new Map(); // `${kind}:${id}` → { timer, reasons: Set, actor }

// Pure-ish: decide whether an event should schedule a push. Exported for tests.
export function shouldAutoPush(remoteRow) {
  return !!remoteRow && String(remoteRow.push_mode || 'manual') === 'auto';
}

export function scheduleAutoPush(evt, { debounceMs = AUTO_PUSH_DEBOUNCE_MS, push = deps.push, lookup = deps.lookup, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!lookup || !push) return false;
  const remote = lookup(evt.kind, evt.id);
  if (!shouldAutoPush(remote)) return false;
  const key = `${evt.kind}:${evt.id}`;
  const cur = pending.get(key);
  if (cur) {
    clearTimer(cur.timer);
    cur.reasons.add(evt.reason);
  }
  const entry = cur || { reasons: new Set([evt.reason]), actor: evt.actor };
  entry.timer = setTimer(async () => {
    pending.delete(key);
    const reason = [...entry.reasons].join(', ');
    try {
      const r = await push(evt.kind, evt.id, { reason, actor: entry.actor });
      if (!r.ok) console.warn(`[mock2] auto-push ${key} failed: ${r.error}`);
    } catch (err) {
      console.warn(`[mock2] auto-push ${key} threw: ${err?.message || err}`);
    }
  }, debounceMs);
  pending.set(key, entry);
  return true;
}

let unsubscribe = null;

export async function registerGitPushHooks() {
  if (unsubscribe) return unsubscribe;
  const gc = await import('./git-connectors.js');
  deps = { lookup: gc.getTargetRemote, push: gc.pushTargetRemote };
  unsubscribe = onContentChanged((evt) => { scheduleAutoPush(evt); });
  return unsubscribe;
}

// Test seam.
export function _resetAutoPush() {
  for (const e of pending.values()) clearTimeout(e.timer);
  pending.clear();
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  deps = { lookup: null, push: null };
}
