// Per-service-class health-check dispatcher.
//
// Restore Mode A's sandbox spins up restored instances on a
// private bridge with no public ports; per-service health checks
// then poke each restored copy to confirm it's structurally sound
// before declaring the dry-run successful.  This module is the
// declarative table that maps a service class → check function.
//
// Operators with unusual stacks fall through to the
// 'generic_web' class and can override per-service via a check
// command stored in the service config (PR 2 wires the lookup
// path; the generic_web fallback is enough for most installs to
// get a meaningful pass/fail signal in dry-run).
//
// Each check returns { ok, latency_ms, detail? } — never throws.
// Detail strings are operator-facing; truncate before persisting.

import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15_000;

// Tiny HTTP probe — issues a GET against the URL and resolves
// when we have a status code.  Resolves rather than rejects on
// network errors so the dispatcher never has to wrap in try/catch.
function httpProbe(url, { timeout = DEFAULT_TIMEOUT_MS, expect = 200 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.get(url, { timeout }, (res) => {
      // Drain so the socket can be reused / closed cleanly even
      // when we don't read the body.
      res.resume();
      const ok = res.statusCode === expect;
      resolve({
        ok,
        latency_ms: Date.now() - t0,
        detail: `HTTP ${res.statusCode}`,
      });
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch { /* ignore */ }
      resolve({ ok: false, latency_ms: Date.now() - t0, detail: `timeout after ${timeout}ms` });
    });
    req.on('error', (err) => {
      resolve({ ok: false, latency_ms: Date.now() - t0, detail: err?.message || 'network error' });
    });
  });
}

// JSON probe — like httpProbe but parses the response body and
// checks a caller-supplied predicate.  Used by n8n's workflow-
// count comparison.
function jsonProbe(url, predicate, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.get(url, { timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode !== 200) {
          resolve({
            ok: false, latency_ms: Date.now() - t0,
            detail: `HTTP ${res.statusCode}`,
          });
          return;
        }
        let parsed;
        try { parsed = JSON.parse(body); } catch (err) {
          resolve({
            ok: false, latency_ms: Date.now() - t0,
            detail: `not JSON: ${err?.message || err}`,
          });
          return;
        }
        try {
          const verdict = predicate(parsed);
          resolve({
            ok: !!verdict.ok,
            latency_ms: Date.now() - t0,
            detail: verdict.detail,
          });
        } catch (err) {
          resolve({
            ok: false, latency_ms: Date.now() - t0,
            detail: `predicate threw: ${err?.message || err}`,
          });
        }
      });
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch { /* ignore */ }
      resolve({ ok: false, latency_ms: Date.now() - t0, detail: `timeout after ${timeout}ms` });
    });
    req.on('error', (err) => {
      resolve({ ok: false, latency_ms: Date.now() - t0, detail: err?.message || 'network error' });
    });
  });
}

// Postgres probe — `psql -c 'SELECT 1'` against a connection
// string; an exit status of 0 means the listener is up + auth
// works.  PR 2 ships the listener-up check; the per-table COUNT
// drift report is a follow-up that needs a configured table list.
function pgProbe(connStr, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const r = spawnSync('psql', [connStr, '-c', 'SELECT 1', '-t', '--no-psqlrc'], {
    encoding: 'utf-8', timeout,
  });
  if (r.status === 0) {
    return Promise.resolve({
      ok: true, latency_ms: Date.now() - t0, detail: 'SELECT 1 ok',
    });
  }
  return Promise.resolve({
    ok: false,
    latency_ms: Date.now() - t0,
    detail: (r.stderr || r.error?.message || 'psql failed').slice(0, 200),
  });
}

// ── service-class table ────────────────────────────────────────────

export const HEALTH_CHECK_CLASSES = Object.freeze({
  static_site: {
    label: 'Static site',
    description: 'Caddy-served file root.  Pass = HTTP 200 on /.',
    async run({ url }) {
      if (!url) return { ok: false, latency_ms: 0, detail: 'no demo URL configured' };
      return httpProbe(url, { expect: 200 });
    },
  },

  generic_web: {
    label: 'Generic web container',
    description: 'HTTP 200 on / (configurable path).',
    async run({ url, path = '/', expect = 200 }) {
      if (!url) return { ok: false, latency_ms: 0, detail: 'no demo URL configured' };
      const target = url.endsWith('/') ? url + path.replace(/^\//, '') : url + path;
      return httpProbe(target, { expect });
    },
  },

  postgres: {
    label: 'Postgres',
    description: '`psql SELECT 1`; per-table COUNT drift in PR 2 follow-up.',
    async run({ conn_str }) {
      if (!conn_str) return { ok: false, latency_ms: 0, detail: 'no conn_str configured' };
      return pgProbe(conn_str);
    },
  },

  n8n: {
    label: 'n8n',
    description: 'HTTP 200 on /healthz + workflow count parity if api_key supplied.',
    async run({ url, api_key, expected_workflow_count }) {
      if (!url) return { ok: false, latency_ms: 0, detail: 'no demo URL configured' };
      const healthz = await httpProbe(`${url.replace(/\/$/, '')}/healthz`);
      if (!healthz.ok) return healthz;
      if (!api_key || expected_workflow_count == null) return healthz;
      return jsonProbe(
        `${url.replace(/\/$/, '')}/api/v1/workflows`,
        (body) => {
          const got = Array.isArray(body?.data) ? body.data.length : null;
          return {
            ok: got === expected_workflow_count,
            detail: `expected ${expected_workflow_count} workflows, got ${got}`,
          };
        },
      );
    },
  },

  meet: {
    label: 'MEET (Jitsi)',
    description: 'Container start-only — stateless, no data check.',
    async run({ instance_up }) {
      // Caller passes a precomputed boolean from `incus list` so
      // we don't shell out twice.
      return {
        ok: !!instance_up,
        latency_ms: 0,
        detail: instance_up ? 'instance running' : 'instance not running',
      };
    },
  },

  generic_stateful: {
    label: 'Generic stateful',
    description: 'HTTP 200 + per-asset drift on a configurable list of files / tables.',
    async run({ url, drift_paths }) {
      if (!url) return { ok: false, latency_ms: 0, detail: 'no demo URL configured' };
      const head = await httpProbe(url, { expect: 200 });
      if (!head.ok) return head;
      // PR 2 ships the HTTP gate; the drift list comparison is
      // the operator-supplied bit and a follow-up wires it.  For
      // now we surface the configured drift_paths in the detail
      // string so the operator sees what would be checked.
      return {
        ok: true,
        latency_ms: head.latency_ms,
        detail: `HTTP 200; drift list (${drift_paths?.length || 0} entries) reserved for PR 2 follow-up`,
      };
    },
  },
});

// dispatch — run the check for a given class.  Unknown class
// falls through to generic_web (matches the spec: 'Operators with
// unusual stacks fall through to "generic web"').
export async function runHealthCheck(serviceClass, args = {}) {
  const cls = HEALTH_CHECK_CLASSES[serviceClass] || HEALTH_CHECK_CLASSES.generic_web;
  try {
    const verdict = await cls.run(args || {});
    return { class: serviceClass || 'generic_web', ...verdict };
  } catch (err) {
    return {
      class: serviceClass || 'generic_web',
      ok: false,
      latency_ms: 0,
      detail: `health-check threw: ${err?.message || err}`,
    };
  }
}

export function listHealthClasses() {
  return Object.entries(HEALTH_CHECK_CLASSES).map(([key, def]) => ({
    key, label: def.label, description: def.description,
  }));
}
