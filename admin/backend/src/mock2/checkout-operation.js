// Cooperative project-write admission. The persistent checkout holder, not a
// timer, excludes the automatic task writer from existing project API writes.
// The context stores outcome flags only, never command text or file contents.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const context = new AsyncLocalStorage();
const acknowledged = Symbol('checkout remote completion');

export class CheckoutOperationError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 409; }
}

export async function trackCheckoutTransport(call) {
  const state = context.getStore();
  if (!state) return call();
  state.dispatched = true; state.pending += 1;
  try {
    const result = await call();
    const code = typeof result?.status === 'number' ? result.status : result?.code;
    if (result?.timedOut || result?.error || result?.stdoutComplete === false || result?.[acknowledged] === false
      || (result?.[acknowledged] !== true && (typeof code === 'number' ? code !== 0 : result?.ok !== true))) state.uncertain = true;
    return result;
  } catch (error) { state.uncertain = true; throw error; }
  finally { state.pending -= 1; }
}

export async function withCheckoutOperationLease({ projectId, kind, acquire, settle, markUncertain, untrackedErrorResult = false }, action) {
  const lease = acquire(projectId, kind);
  if (!lease.ok) throw new CheckoutOperationError('CHECKOUT_OPERATION_BUSY', lease.reason || 'Another writer holds this project.');
  const state = { dispatched: false, pending: 0, uncertain: false };
  try {
    const result = await context.run(state, action);
    if (state.pending || (untrackedErrorResult && (result?.isError === true || result?.statusCode >= 500))) state.uncertain = true;
    if (state.uncertain) {
      markUncertain(projectId, lease.token);
      throw new CheckoutOperationError('CHECKOUT_OPERATION_UNCERTAIN', 'A project write has an unconfirmed outcome. Inspect the project and confirm the remote operation has stopped before resolving its checkout holder.');
    }
    if (!settle(projectId, lease.token)) throw new CheckoutOperationError('CHECKOUT_OPERATION_UNCERTAIN', 'The project write checkout holder could not be settled. Inspect its current state before another write.');
    return result;
  } catch (error) {
    if (state.dispatched || untrackedErrorResult || state.uncertain) markUncertain(projectId, lease.token);
    else settle(projectId, lease.token); // validation failed before any remote dispatch
    throw error;
  }
}

const quoted = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function completionScript(nonce, command) {
  return `trap 'checkout_rc=$?; printf "\\nPP_CHECKOUT_COMPLETED:${nonce}:%s\\n" "$checkout_rc"' EXIT\n${command}\nexit $?`;
}
function completedResult(result, nonce) {
  const pattern = new RegExp('\\nPP_CHECKOUT_COMPLETED:' + nonce + ':([0-9]{1,3})\\n$');
  const text = typeof result?.stdout === 'string' ? result.stdout : '';
  const match = pattern.exec(text), code = typeof result?.status === 'number' ? result.status : result?.code;
  const complete = !!match && Number(match[1]) === code && !result?.timedOut && !result?.error && result?.stdoutComplete !== false;
  const clean = { ...result, stdout: match ? text.slice(0, match.index) : text };
  if (match && typeof clean.stdoutBytes === 'number') clean.stdoutBytes -= Buffer.byteLength(match[0]);
  Object.defineProperty(clean, acknowledged, { value: complete });
  return clean;
}

// Add an outer, fixed completion acknowledgment only while a persistent
// checkout operation owns the project. Original argv/stdin remain data.
export function captureCheckoutHost(capture, bin, args, options) {
  if (!context.getStore()) return capture(bin, args, options);
  const separator = Array.isArray(args) ? args.indexOf('--') : -1;
  if (bin !== 'incus' || args[0] !== 'exec' || separator < 2 || separator === args.length - 1) return trackCheckoutTransport(() => capture(bin, args, options));
  const nonce = randomUUID();
  const argv = [...args.slice(0, separator + 1), 'sh', '-c', completionScript(nonce, '"$@"'), 'sh', ...args.slice(separator + 1)];
  return trackCheckoutTransport(async () => completedResult(await capture(bin, argv, options), nonce));
}

export function captureCheckoutShell(script, run) {
  if (!context.getStore()) return run(script);
  const nonce = randomUUID(), wrapped = completionScript(nonce, `sh -c ${quoted(script)}`);
  return trackCheckoutTransport(async () => completedResult(await run(wrapped), nonce));
}
