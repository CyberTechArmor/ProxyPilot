// Mock2 gating — the pure decision layer for "is this module present?"
//
// ADR-001 (absence-by-installation): a disabled host must behave
// byte-for-byte like one that never shipped Mock2 — no route, no state
// file, no credential store, no runner code path. The decision of whether
// any of that gets wired is made HERE, and deliberately kept free of
// `better-sqlite3`, Express, and every other native/heavy import so it can
// be unit-tested at the module boundary without dragging the DB in (the
// stub-first discipline in docs/known-issues.md / risk R9).
//
// Precedence, checked at boot (ADR-001, in order):
//   1. Pin file present  -> hard OFF, even if MOCK2_ENABLED=true (logged).
//   2. MOCK2_ENABLED flag -> on/off from .env (default false).
//
// The pin file is operator-created and NEVER written by code.

// Hard-off production pin. If this file exists, Mock2 is off no matter
// what the env says. Created by the operator (or a future production
// install profile); ProxyPilot never creates it.
export const MOCK2_PIN_PATH = '/etc/proxypilot/mock2.production.pin';

// Parse a MOCK2_ENABLED-style env value into a boolean. Accepts the
// idioms an operator or the installer might write; everything else
// (including undefined/empty) is false — absence defaults to OFF.
function parseFlag(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

// Resolve the Mock2 gate. Pure: `existsSync` is injected so tests can
// drive the pin-file branch without touching the filesystem.
//
// Returns { enabled, pinned, warning }:
//   enabled  — mount the module (routes, DB, boot sweep) when true
//   pinned   — the production pin overrode everything
//   warning  — a string to log when the pin contradicts MOCK2_ENABLED=true,
//              otherwise null
export function resolveMock2Gate({ env = {}, existsSync, pinPath = MOCK2_PIN_PATH } = {}) {
  const flagEnabled = parseFlag(env.MOCK2_ENABLED);
  const pinned = typeof existsSync === 'function' ? !!existsSync(pinPath) : false;

  if (pinned) {
    return {
      enabled: false,
      pinned: true,
      warning: flagEnabled
        ? `[mock2] production pin present at ${pinPath} — forcing Mock2 OFF despite MOCK2_ENABLED=true`
        : null,
    };
  }

  return { enabled: flagEnabled, pinned: false, warning: null };
}

// Authorization predicate for GET /api/mock2/status. The route is also
// wrapped in requireAdmin middleware; this mirror exists so the gating
// rule is unit-testable without the auth/DB stack. Admins only.
export function canReadMock2Status(user) {
  return !!user && user.role === 'admin';
}
