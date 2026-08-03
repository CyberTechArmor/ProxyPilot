// probe-logic.js — pure decision layer for the runner's two observation tools
// (run-taxonomy fix #1/B1): http_probe and browser_probe. Native-free by
// construction (no container, no Playwright, no DB) — everything decidable
// about a probe request lives here; runner.js and browser-probe.js do only the
// I/O this module tells them to.
//
// The problem this closes: the runner cannot see the app it is debugging. Every
// long repeat-fix saga in the run-taxonomy report ended the moment someone
// READ something (a computed style, an HTTP status) instead of reasoning about
// behaviour. Both tools require an explicit `target` ("deployed" = what the
// operator sees, "working" = this cycle's edits, restarted first) so a probe
// can never be silently stale — the caller always knows which build it saw.

export const PROBE_TARGETS = Object.freeze(['deployed', 'working']);
export const PROBE_MAX_PER_CYCLE = 10; // combined across both tools
export const PROBE_BODY_CAP = 8000;
export const PROBE_DOM_CAP = 4000;
export const PROBE_MAX_SELECTORS = 10;
export const PROBE_MAX_HEADERS = 20;

const HTTP_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

function isPlainPath(path) {
  if (typeof path !== 'string' || !path.trim()) return false;
  if (!path.startsWith('/')) return false;
  if (path.startsWith('//')) return false; // protocol-relative
  if (/:\/\//.test(path)) return false; // an absolute URL smuggled as a "path"
  return true;
}

// httpProbeCommand — the exact `curl -i` command to run inside the container.
// Every interpolated value (path, headers, body) goes through shellQuote —
// this is the one place a probe's model-supplied strings reach a shell.
// The URL is built here, in JS, from a JS-constructed loopback base plus the
// validated path — the model never supplies a host, so it cannot be smuggled.
export function httpProbeCommand({ webPort, method, path, headers = [], body = null }) {
  const url = `http://127.0.0.1:${Number(webPort) || 3000}${path}`;
  const headerFlags = headers.map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`).join(' ');
  const dataFlag = body != null ? `--data-raw ${shellQuote(body)}` : '';
  return ['curl', '-sS', '-i', '--max-time', '10', '-X', method, headerFlags, dataFlag, shellQuote(url)]
    .filter(Boolean)
    .join(' ');
}

// parseCurlDashI — split `curl -i` output into { status, headers, body }.
// -i interleaves the status line, response headers, a blank line, then the
// body. httpProbeCommand doesn't pass -L, so in practice there is exactly one
// HTTP/ block — but this peels off consecutive HTTP/-prefixed blocks anyway
// (tolerating a future -L) and keeps the LAST one, the response that actually
// answered, rather than an intermediate redirect hop. Never throws.
export function parseCurlDashI(text = '') {
  const s = String(text || '');
  let rest = s;
  let headerBlock = '';
  while (/^HTTP\/[\d.]+\s+\d+/.test(rest)) {
    const idx = rest.search(/\r?\n\r?\n/);
    if (idx === -1) { headerBlock = rest; rest = ''; break; }
    headerBlock = rest.slice(0, idx);
    rest = rest.slice(idx).replace(/^(\r?\n)+/, '');
  }
  if (!headerBlock) return { status: null, headers: '', body: s };
  const statusMatch = headerBlock.match(/^HTTP\/[\d.]+\s+(\d+)/m);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  return { status, headers: headerBlock, body: rest };
}

// httpProbePlan — validate + normalise http_probe input. Never trusts the
// model's string: the caller builds the actual request URL by concatenating
// this validated path onto a JS-constructed loopback base, so nothing here
// can smuggle a host.
export function httpProbePlan(input = {}) {
  const target = input?.target;
  if (!PROBE_TARGETS.includes(target)) {
    return { error: `target must be one of: ${PROBE_TARGETS.join(', ')}` };
  }
  const path = input?.path;
  if (!isPlainPath(path)) {
    return { error: 'path must be a string starting with "/" (not an absolute URL or protocol-relative path)' };
  }
  let method = typeof input?.method === 'string' ? input.method.trim().toUpperCase() : 'GET';
  if (!method) method = 'GET';
  if (!HTTP_METHODS.includes(method)) {
    return { error: `method must be one of: ${HTTP_METHODS.join(', ')}` };
  }
  const headers = [];
  if (input?.headers != null) {
    if (typeof input.headers !== 'object' || Array.isArray(input.headers)) {
      return { error: 'headers must be a flat object of string keys to string values' };
    }
    const entries = Object.entries(input.headers);
    if (entries.length > PROBE_MAX_HEADERS) {
      return { error: `too many headers (max ${PROBE_MAX_HEADERS})` };
    }
    for (const [k, v] of entries) {
      if (typeof v !== 'string') return { error: `header "${k}" must be a string` };
      if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) return { error: `header "${k}" contains a newline (not allowed)` };
      headers.push([k, v]);
    }
  }
  const body = typeof input?.body === 'string' ? input.body : null;
  return { target, path, method, headers, body };
}

// browserProbePlan — validate + normalise browser_probe input.
export function browserProbePlan(input = {}) {
  const target = input?.target;
  if (!PROBE_TARGETS.includes(target)) {
    return { error: `target must be one of: ${PROBE_TARGETS.join(', ')}` };
  }
  const path = input?.path;
  if (!isPlainPath(path)) {
    return { error: 'path must be a string starting with "/" (not an absolute URL or protocol-relative path)' };
  }
  const role = typeof input?.role === 'string' && input.role.trim() ? input.role.trim() : null;
  let selectors = [];
  if (input?.selectors != null) {
    if (!Array.isArray(input.selectors)) return { error: 'selectors must be an array of strings' };
    if (input.selectors.length > PROBE_MAX_SELECTORS) return { error: `too many selectors (max ${PROBE_MAX_SELECTORS})` };
    for (const s of input.selectors) {
      if (typeof s !== 'string' || !s.trim() || s.length > 200) return { error: 'each selector must be a non-empty string of 200 chars or fewer' };
    }
    selectors = input.selectors;
  }
  const domSelector = typeof input?.dom_selector === 'string' && input.dom_selector.trim() ? input.dom_selector.trim() : null;
  return { target, path, role, selectors, domSelector };
}

// shellQuote — wrap a value in single quotes for safe embedding in a POSIX sh
// command, escaping any embedded single quote. Every model-supplied value that
// reaches a shell command in the probe tools goes through this.
export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

// probeBudget — the per-cycle cap shared by both probe tools. Returns a
// plain-language redirect (not a bare error) when spent, so the model is told
// what to do next rather than just refused.
export function probeBudget(used, max = PROBE_MAX_PER_CYCLE) {
  const n = Number(used) || 0;
  if (n >= max) {
    return {
      allowed: false,
      message: `error: probe budget spent (${max} probes this cycle). You have observed enough to act — make the change, or halt with what you found. If you still cannot see the cause, halt and say exactly what evidence you need.`,
    };
  }
  return { allowed: true, message: null };
}

function targetLine(target) {
  return target === 'working'
    ? 'target: working (this cycle\'s edits, restarted before probing)'
    : 'target: deployed (the app currently live — what the operator sees)';
}

// formatHttpProbeResult — the text the model sees. Always opens with which
// target was probed, so a stale observation can never be silently reasoned
// over as if it were the other one.
export function formatHttpProbeResult({ target, method, path, raw }) {
  const lines = [targetLine(target), `${method} ${path}`];
  if (raw?.error) {
    lines.push(`error: ${raw.error}`);
    return lines.join('\n');
  }
  lines.push(`status: ${raw?.status ?? 'unknown'}`);
  if (raw?.headers) lines.push('headers:', raw.headers.trim());
  const body = String(raw?.body ?? '');
  if (body.length > PROBE_BODY_CAP) {
    lines.push('body:', `${body.slice(0, PROBE_BODY_CAP)}\n…[body truncated, ${body.length} chars total]`);
  } else {
    lines.push('body:', body);
  }
  return lines.join('\n');
}

// formatBrowserProbeResult — same target-first contract as above.
export function formatBrowserProbeResult(result) {
  const lines = [targetLine(result?.target), `page: ${result?.path ?? result?.url ?? ''}`];
  if (result?.unavailable) {
    lines.push(`error: ${result.detail || 'the browser connector is not available'}`);
    return lines.join('\n');
  }
  if (result?.error) {
    lines.push(`error: ${result.error}`);
    return lines.join('\n');
  }
  const consoleErrors = result?.consoleErrors || [];
  lines.push(consoleErrors.length ? `console errors:\n${consoleErrors.map((e) => `- ${e}`).join('\n')}` : 'console errors: none');
  const netFailures = result?.networkFailures || [];
  lines.push(netFailures.length ? `network failures:\n${netFailures.map((e) => `- ${e}`).join('\n')}` : 'network failures: none');
  for (const sel of result?.selectors || []) {
    if (sel.error) {
      lines.push(`selector "${sel.selector}": error — ${sel.error}`);
      continue;
    }
    lines.push(
      `selector "${sel.selector}": found=${sel.found} visible=${sel.visible}`
      + (sel.computed ? ` computed={${Object.entries(sel.computed).map(([k, v]) => `${k}: ${v}`).join(', ')}}` : ''),
    );
  }
  if (result?.dom) {
    const dom = String(result.dom);
    lines.push('dom:', dom.length > PROBE_DOM_CAP ? `${dom.slice(0, PROBE_DOM_CAP)}\n…[dom truncated, ${dom.length} chars total]` : dom);
  }
  return lines.join('\n');
}
