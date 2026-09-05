// Content-change events — the ONE seam through which core routes tell optional
// modules that something they may mirror has changed, without importing them
// (ADR-001: the core never imports mock2).
//
// Emitters: routes/services.js (static-site file save / revert / zip apply /
// import), routes/lxc.js and routes/mcp.js (LXC zip apply, file write, startup
// re-run) and the MCP static-site tools. Subscriber today: the mock2 module's
// git-push hooks, which push a target's mirror repo when its remote is in
// 'auto' mode. Listeners are best-effort: a throwing listener is logged, never
// propagated into the request that emitted.

const listeners = new Set();

// kind: 'static_site' | 'lxc'; id: the service id / container name (no pp- prefix);
// reason: a short label for the audit trail ('file_saved', 'zip_applied', …).
export function emitContentChanged({ kind, id, reason = 'changed', actor = null } = {}) {
  if (!kind || !id) return;
  const evt = { kind: String(kind), id: String(id), reason: String(reason), actor, at: new Date().toISOString() };
  for (const fn of listeners) {
    try {
      const r = fn(evt);
      if (r && typeof r.catch === 'function') r.catch((err) => console.warn('[change-events] listener failed:', err?.message || err));
    } catch (err) {
      console.warn('[change-events] listener failed:', err?.message || err);
    }
  }
}

export function onContentChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Test seam.
export function _resetContentListeners() {
  listeners.clear();
}
