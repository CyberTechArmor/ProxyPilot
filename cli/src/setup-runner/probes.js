// Host runner — the guest probes. Pure: every function here builds a shell
// script for `incus exec <guest> -- sh` or parses its output; nothing runs.
// The scripts print marker lines only, so silence is never read as success,
// and none of them prints a secret: the one value the credential check needs
// (the active master key, to classify the stored rows) is read into memory by
// its own script and never lands in a job row, an event or a log.
//
// The classifier and the master-key rules are the gate-one modules the deploy
// uses (admin/backend/src/mock2/auth-data-logic.js, readiness-logic.js),
// imported from the checkout the runner ships in — so the runner and the
// deploy agree, by construction, on what "the credential reads back" means.

import { authDataProbeScript, parseAuthDataProbe, normalizeDataGuard } from '../../../admin/backend/src/mock2/auth-data-logic.js';
import { masterKeyRowsCode, DEV_MASTER_SECRET_LITERAL } from '../../../admin/backend/src/mock2/readiness-logic.js';
import { verificationState } from '../../../admin/backend/src/lib/setup-engine/logic.js';

export const DEFAULT_UNIT = 'mock2-dev.service';
export const UNIT_RE = /^[A-Za-z0-9@._-]+\.service$/;

function unitOrThrow(unit) {
  const u = String(unit || DEFAULT_UNIT);
  if (!UNIT_RE.test(u)) throw new Error(`unit '${u}' is not a .service name`);
  return u;
}

function portOrThrow(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`port '${port}' is not a port`);
  return p;
}

// ── unit ────────────────────────────────────────────────────────────────

export function unitStatusScript(unit) {
  const u = unitOrThrow(unit);
  return [
    `if systemctl cat '${u}' >/dev/null 2>&1; then echo UNIT_LOADED:yes; else echo UNIT_LOADED:no; fi`,
    `echo "UNIT_ENABLED:$(systemctl is-enabled '${u}' 2>/dev/null || echo unknown)"`,
    `echo "UNIT_ACTIVE:$(systemctl is-active '${u}' 2>/dev/null || echo unknown)"`,
    '',
  ].join('\n');
}

export function parseUnitStatus(stdout) {
  const get = (k) => (String(stdout || '').match(new RegExp(`^${k}:(\\S+)`, 'm')) || [])[1] || null;
  const loaded = get('UNIT_LOADED');
  return {
    observed: loaded != null,
    loaded: loaded === 'yes' ? true : loaded === 'no' ? false : null,
    enabled: get('UNIT_ENABLED'),
    active: get('UNIT_ACTIVE'),
    isActive: get('UNIT_ACTIVE') === 'active',
  };
}

export function startUnitScript(unit) {
  const u = unitOrThrow(unit);
  return [
    'systemctl daemon-reload >/dev/null 2>&1 || true',
    `systemctl start '${u}' 2>&1; echo START_RC:$?`,
    `echo "UNIT_ACTIVE:$(systemctl is-active '${u}' 2>/dev/null || echo unknown)"`,
    '',
  ].join('\n');
}

export function parseStartUnit(stdout) {
  const m = String(stdout || '').match(/^START_RC:(\d+)/m);
  return { observed: !!m, rc: m ? Number(m[1]) : null, active: (String(stdout || '').match(/^UNIT_ACTIVE:(\S+)/m) || [])[1] || null };
}

// ── port ────────────────────────────────────────────────────────────────

// Same rule as the deploy's serving probe (deploy-logic servingProbeScript):
// the root answers with anything but 000 or a 5xx.
export function portProbeScript(port, tries = 15) {
  const p = portOrThrow(port);
  const n = Math.max(1, Math.min(60, Number(tries) || 15));
  return [
    'last="000"', 'i=0',
    `while [ $i -lt ${n} ]; do`,
    `  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${p}/" 2>/dev/null)`,
    '  [ -n "$code" ] && last="$code"',
    '  if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then echo "PORT_SERVING:$code"; exit 0; fi',
    '  i=$((i+1)); sleep 1',
    'done',
    'echo "PORT_NOT_SERVING:$last"',
    '',
  ].join('\n');
}

export function parsePortProbe(stdout) {
  const s = String(stdout || '');
  let m = s.match(/^PORT_SERVING:(\d{3})/m);
  if (m) return { observed: true, responding: true, code: Number(m[1]) };
  m = s.match(/^PORT_NOT_SERVING:(\d{3})/m);
  if (m) return { observed: true, responding: false, code: Number(m[1]) };
  return { observed: false, responding: null, code: null };
}

// ── application health ──────────────────────────────────────────────────

// ROOT, HEALTH and LOGIN, as the readiness probe asks them. Healthy means:
// the root and the login page answer below 500, and /api/health — when the
// app has one — answers 2xx. A 404 on /api/health is "no such endpoint",
// not a failure; a 5xx or no answer is.
export function healthScript(port) {
  const p = portOrThrow(port);
  const lines = ['set -u'];
  for (const [key, path] of [['ROOT', '/'], ['HEALTH', '/api/health'], ['LOGIN', '/login']]) {
    lines.push(`C=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:${p}${path}" 2>/dev/null)`, `echo "${key}:\${C:-000}"`);
  }
  lines.push('');
  return lines.join('\n');
}

export function parseHealth(stdout) {
  const codes = {};
  for (const line of String(stdout || '').split('\n')) {
    const m = line.trim().match(/^(ROOT|HEALTH|LOGIN):(\d{3})$/);
    if (m) codes[m[1]] = Number(m[2]);
  }
  if (codes.ROOT == null) return { observed: false, healthy: null, codes, why: 'the health probe produced no output' };
  const below500 = (c) => c != null && c !== 0 && c < 500;
  const problems = [];
  if (!below500(codes.ROOT)) problems.push(`the root answered ${codes.ROOT}`);
  if (codes.HEALTH != null && codes.HEALTH !== 404 && !(codes.HEALTH >= 200 && codes.HEALTH < 300)) problems.push(`/api/health answered ${codes.HEALTH}`);
  if (codes.LOGIN != null && codes.LOGIN !== 404 && !below500(codes.LOGIN)) problems.push(`/login answered ${codes.LOGIN}`);
  return { observed: true, healthy: problems.length === 0, codes, why: problems.join('; ') || null, hasAuth: codes.LOGIN != null && codes.LOGIN !== 404 };
}

// ── the protected credential (R4) ───────────────────────────────────────

// The active key is read by its own script so the row classification can
// run on the host; the value stays in memory and is never returned in any
// result object below (only whether it is set, and whether it is the
// development literal).
export function activeKeyScript(envFile = '/etc/environment') {
  const f = String(envFile || '/etc/environment');
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(f)) throw new Error('environment file must be an absolute path');
  return `sed -n 's/^AUTH_MASTER_SECRET=//p' '${f}' 2>/dev/null | head -1 | sed -e 's/^"//' -e 's/"$//'\n`;
}

export function credentialProbeScript(guard) {
  const g = normalizeDataGuard(guard);
  if (!g) throw new Error('the data guard is not valid (table, secret_column, nonce_column, schema)');
  return authDataProbeScript(g);
}

// credentialVerdict({ guard, envKey, probeStdout }) →
//   { verified: true|false|null, code, detail } with the gate-one codes:
//   200 every stored row decrypts under the active key (verified)
//   204 nothing stored (verified vacuously — there is nothing to read back)
//   404 a row does not decrypt (NOT verified: the key and the rows disagree)
//   500 the probe could not run (unknown: deferred, never "verified")
export function credentialVerdict({ guard, envKey = '', probeStdout = '' } = {}) {
  const g = normalizeDataGuard(guard);
  if (!g) return { verified: null, code: null, detail: 'no data guard recorded for this app; the credential check was not run' };
  const probe = parseAuthDataProbe(probeStdout);
  const code = masterKeyRowsCode({ probe, envKey, legacyDefault: g.legacy_default || DEV_MASTER_SECRET_LITERAL });
  const keyState = !envKey ? 'unset' : envKey === (g.legacy_default || DEV_MASTER_SECRET_LITERAL) ? 'development-default' : 'set';
  if (code === 200) return { verified: true, code, detail: `${probe.detail}; every row decrypts under the active key (${keyState}); target ${probe.target || '?'}`, keyState };
  if (code === 204) return { verified: true, code, detail: `${probe.detail}; nothing stored to read back (${keyState})`, keyState, vacuous: true };
  if (code === 404) return { verified: false, code, detail: `${probe.detail}; at least one row does not decrypt under the active key (${keyState})`, keyState };
  return { verified: null, code, detail: `the credential probe could not run: ${probe.detail}`, keyState };
}

// ── the ladder ──────────────────────────────────────────────────────────

// verificationFromObservations({ unit, port, health, credential }) → the R4
// state. Each observation may be missing (not run): a missing rung caps the
// state, a failed rung is recovery required.
export function verificationFromObservations({ unit = null, port = null, health = null, credential = null } = {}) {
  const facts = {
    unitConfigured: unit ? unit.loaded : null,
    unitActive: unit && unit.observed ? unit.isActive : null,
    portResponding: port && port.observed ? port.responding : null,
    appHealthy: health && health.observed ? health.healthy : null,
    credentialVerified: credential ? credential.verified : null,
    deferredReason: credential && credential.verified == null ? credential.detail : null,
  };
  // The unit being inactive at the moment of the status read is not a
  // failure when the port then answered (a restart race); the port decides.
  if (facts.unitActive === false && facts.portResponding === true) facts.unitActive = true;
  const v = verificationState(facts);
  return {
    ...v,
    observations: {
      unit: unit ? { loaded: unit.loaded, enabled: unit.enabled, active: unit.active } : null,
      port: port ? { responding: port.responding, code: port.code } : null,
      health: health ? { healthy: health.healthy, codes: health.codes, why: health.why } : null,
      credential: credential ? { verified: credential.verified, code: credential.code, detail: credential.detail, keyState: credential.keyState || null } : null,
    },
  };
}
