// A7 agent-control prompt bridge, the same shape as lib/sudo.js and kept
// separate from it: taking over an agent run or deciding one needs this
// session's own verification (password + TOTP, or a passkey), once per session.
// It never opens or extends sudo.
//
//   1. api.request() sees a 401 envelope with control_verification_required
//   2. calls requestAgentControl(); concurrent callers share one prompt
//   3. AgentControlProvider renders the prompt and resolves or rejects it
//   4. api.request() retries the original call once
const target = new EventTarget();
let pending = null;

export function requestAgentControl() {
  if (pending) return pending.promise;
  pending = {};
  pending.promise = new Promise((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
    target.dispatchEvent(new CustomEvent('open'));
  }).finally(() => { pending = null; });
  return pending.promise;
}

export function resolveAgentControl() { pending?.resolve?.(); }
export function rejectAgentControl() { pending?.reject?.(new Error('Verification cancelled')); }
export function onAgentControlOpen(handler) {
  target.addEventListener('open', handler);
  return () => target.removeEventListener('open', handler);
}
