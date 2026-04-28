// Sudo-mode prompt bridge. Pure JS so api.js (which is also pure JS)
// can use it without pulling React into the request layer.
//
// Flow:
//   1. api.request() sees a 401 envelope with sudo_required = true
//   2. Calls requestSudo() — returns a Promise. The first call also
//      fires an 'open' event; subsequent calls during the same prompt
//      reuse the existing promise so multiple in-flight requests
//      hitting a sudo gate don't spawn duplicate modals.
//   3. SudoProvider listens for 'open', renders <SudoModal />, calls
//      resolveSudo() on success or rejectSudo() on cancel.
//   4. api.request() then retries the original call once with the
//      now-valid sudo grant.

const target = new EventTarget();
let pending = null;

export function requestSudo() {
  if (pending) return pending.promise;
  pending = {};
  pending.promise = new Promise((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
    target.dispatchEvent(new Event('open'));
  }).finally(() => { pending = null; });
  return pending.promise;
}

export function resolveSudo() {
  pending?.resolve?.();
}

export function rejectSudo() {
  pending?.reject?.(new Error('Sudo cancelled'));
}

export function onSudoOpen(handler) {
  target.addEventListener('open', handler);
  return () => target.removeEventListener('open', handler);
}
