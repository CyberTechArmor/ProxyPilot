import jwt from "jsonwebtoken";
import {
  readConfig,
  assertCurrent,
  REVOCATION_MS,
  PROOF_MS,
  fail,
} from "./store.js";
import { accountEnabled, verifySettings } from "./oidc.js";

export const hasSsoSchema = (db) =>
  !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sso_session_context'",
    )
    .get();
export function sessionContext(db, id) {
  return hasSsoSchema(db)
    ? db.prepare("SELECT * FROM sso_session_context WHERE session_id=?").get(id)
    : null;
}
// Use Host, never caller-controlled X-Forwarded-Host. Caddy preserves Host.
export function requestOrigin(req) {
  return `https://${String(req.headers.host || "").toLowerCase()}`;
}
export function recordLocalSession(db, token, req, user, method = "local") {
  if (!hasSsoSchema(db)) return;
  const id = jwt.decode(token).jti;
  if (
    req.localRecovery &&
    (user.role !== "admin" || user.auth_source === "ldap")
  ) {
    db.prepare(
      "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?",
    ).run(id);
    throw fail("Recovery requires a local administrator.", 403);
  }
  db.prepare(
    "INSERT INTO sso_session_context(session_id,user_id,origin,method,authenticated_at) VALUES (?,?,?,?,?)",
  ).run(
    id,
    user.id,
    requestOrigin(req),
    readConfig(db)?.active && !req.localRecovery
      ? "link-only"
      : user.auth_source === "ldap"
        ? "ldap"
        : method,
    Date.now(),
  );
  req.linkOnly = readConfig(db)?.active && !req.localRecovery;
}
export function stampLocalProof(db, id, now = Date.now()) {
  if (hasSsoSchema(db))
    db.prepare(
      "UPDATE sso_session_context SET local_proof_at=? WHERE session_id=? AND method IN ('local','link-only')",
    ).run(now, id);
}
export function requireLocalProof(db, id, origin, now = Date.now()) {
  const ctx = sessionContext(db, id);
  if (
    !ctx ||
    !["local", "link-only"].includes(ctx.method) ||
    ctx.origin !== origin ||
    !ctx.local_proof_at ||
    now - ctx.local_proof_at > PROOF_MS
  )
    throw fail(
      "Re-prove your local password + TOTP or local passkey within five minutes before linking or recovery.",
      403,
    );
  return ctx;
}
export function checkSessionContext(
  db,
  session,
  origin = null,
  now = Date.now(),
) {
  const ctx = sessionContext(db, session.id);
  if (!ctx) {
    const r = hasSsoSchema(db) && readConfig(db);
    return r && origin === r.config.recoveryOrigin
      ? {
          ok: false,
          status: 401,
          error: "Sign in locally on the recovery hostname.",
        }
      : { ok: true };
  }
  if (origin && ctx.origin !== origin)
    return {
      ok: false,
      status: 401,
      error: "This session belongs to a different hostname.",
    };
  if (ctx.method === "oidc" && (!ctx.checked_until || ctx.checked_until <= now))
    return {
      ok: false,
      status: 401,
      error:
        "SSO account verification expired. Local recovery remains available.",
    };
  return { ok: true };
}
const inFlight = new Map();
export async function refreshCentralCheck(db, sessionId, deps = {}) {
  const ctx = sessionContext(db, sessionId),
    now = deps.now?.() ?? Date.now();
  if (!ctx || ctx.method !== "oidc") return;
  if (ctx.checked_until > now) return;
  const session = db
    .prepare("SELECT * FROM sessions WHERE id=?")
    .get(sessionId);
  if (!session || session.revoked_at || Date.parse(session.expires_at) <= now)
    return;
  if (inFlight.has(sessionId)) return inFlight.get(sessionId);
  const work = (async () => {
    try {
      const r = assertCurrent(db, ctx.fingerprint);
      await (deps.verifySettings || verifySettings)(db, r, deps);
      const enabled = await (deps.accountEnabled || accountEnabled)(
        db,
        r,
        ctx.subject,
        deps,
      );
      assertCurrent(db, ctx.fingerprint);
      if (!enabled) {
        db.prepare(
          `UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP,sudo_until=NULL WHERE id IN
     (SELECT session_id FROM sso_session_context WHERE method='oidc' AND issuer=? AND subject=?)`,
        ).run(ctx.issuer, ctx.subject);
        return;
      }
      // Budget starts BEFORE the network request. Slow checks cannot extend it.
      db.prepare(
        "UPDATE sso_session_context SET checked_until=? WHERE session_id=?",
      ).run(now + REVOCATION_MS, sessionId);
    } catch {
      /* fail closed at the persisted deadline; no provider error/token logging */
    }
  })();
  inFlight.set(sessionId, work);
  try {
    await work;
  } finally {
    inFlight.delete(sessionId);
  }
}
export function disableSso(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE sso_config SET active=0 WHERE id=1").run();
    db.prepare(
      "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP,sudo_until=NULL WHERE id IN (SELECT session_id FROM sso_session_context WHERE method='oidc')",
    ).run();
    db.prepare("DELETE FROM sso_flows").run();
    db.prepare("DELETE FROM sso_evidence").run();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
// The recovery host accepts local administrators only and does not expose
// machine APIs or initiate LDAP/SSO. The existing auth/TOTP/passkey routes run.
export function recoveryBoundary(db) {
  return (req, res, next) => {
    const r = readConfig(db);
    if (!r) return next();
    const recovery = requestOrigin(req) === r.config.recoveryOrigin;
    const localEntry = [
      "/api/auth/login",
      "/api/auth/initial-setup",
      "/api/auth/complete-totp-setup",
      "/api/auth/link/complete",
      "/api/auth/passkey/authenticate/begin",
      "/api/auth/passkey/authenticate/verify",
    ].includes(req.path);
    if (r.active && !recovery && localEntry) {
      // Local proof can onboard an existing user after activation, but the minted
      // session is link-only. authenticateToken refuses every application action.
      if (req.path === "/api/auth/initial-setup")
        return res.status(403).json({
          error: "SSO is active. Use the restricted recovery hostname.",
        });
    }
    if (!recovery) return next();
    req.localRecovery = true;
    if (req.path.startsWith("/api/mcp") || req.path.startsWith("/api/domains"))
      return res.status(403).json({ error: "Use the normal API hostname." });
    if (
      req.path === "/api/auth/login" ||
      req.path === "/api/auth/complete-totp-setup"
    ) {
      const user = db
        .prepare(
          "SELECT * FROM users WHERE username=? AND role='admin' AND (auth_source='local' OR auth_source IS NULL)",
        )
        .get(req.body?.username || "");
      if (!user)
        return res
          .status(401)
          .json({ error: "A local recovery administrator is required." });
      // Never skip a recovery second factor with a trusted-device cookie.
      req.body.deviceToken = undefined;
      req.body.registerDevice = false;
    }
    if (req.path === "/api/auth/initial-setup")
      return res
        .status(403)
        .json({ error: "Use the existing root recovery command." });
    next();
  };
}
