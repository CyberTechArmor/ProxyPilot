import { readFullPlatform } from '../lib/setup-engine/full-platform-store.js';
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getDb, logAudit } from "../db.js";
import {
  authenticateToken,
  requireAdmin,
  requireSudo,
  generateToken,
  validateSession,
} from "../middleware/auth.js";
import { setAuthCookies } from "./auth.js";
import { encryptSecret, decryptSecret } from "../lib/secrets.js";
import {
  readConfig,
  assertCurrent,
  saveConfig,
  publicState,
  queueSsoJob,
  activationReadiness,
  recordEvidence,
  random,
  hash,
  fail,
  PROOF_MS,
  REVOCATION_MS,
} from "../lib/sso/store.js";
import {
  requestOrigin,
  requireLocalProof,
  sessionContext,
  disableSso,
  refreshCentralCheck,
} from "../lib/sso/sessions.js";
import {
  authorizationUrl,
  exchange,
  accountEnabled,
  verifySettings,
} from "../lib/sso/oidc.js";

const BROWSER = "__Host-pp_sso_browser";
const cookie = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: 24 * 3600_000,
};
function browser(req, res) {
  let value = req.cookies?.[BROWSER];
  if (!/^[A-Za-z0-9_-]{43}$/.test(value || "")) {
    value = random();
    res.cookie(BROWSER, value, cookie);
  }
  return hash(value);
}
const handle = (fn) => async (req, res) => {
  try {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 400).json({
      error: e.ssoSafe
        ? e.message
        : "SSO request failed. Check the saved configuration and retry; no provider credentials or response details are logged.",
    });
  }
};
function current(req) {
  const db = getDb(),
    r = readConfig(db);
  if (!r) throw fail("Save the SSO configuration first.");
  assertCurrent(db, r.fingerprint);
  return { db, r };
}
function publicHost(req, r) {
  if (requestOrigin(req) !== r.config.publicOrigin)
    throw fail("Use the configured ProxyPilot hostname for SSO.", 403);
}
function checkedRevision(req, r) {
  if (req.body?.fingerprint !== r.fingerprint)
    throw fail("The SSO configuration changed. Reopen and repeat the checks.");
}
function localRecovery(req, db, r) {
  if (requestOrigin(req) !== r.config.recoveryOrigin)
    throw fail("Use the independent recovery hostname.", 403);
  return requireLocalProof(db, req.session.id, r.config.recoveryOrigin);
}

export const ssoSetupRouter = Router();
ssoSetupRouter.use(requireAdmin);
ssoSetupRouter.get(
  "/",
  handle((req, res) => {
    browser(req, res);
    res.json(publicState(getDb(), req.user.id));
  }),
);
ssoSetupRouter.put(
  "/",
  requireSudo,
  handle((req, res) => {
    const db = getDb();
    const r = saveConfig(db, req.body, req.user.id);
    logAudit(
      req.user.id,
      "SSO_CONFIG_SAVED",
      "sso",
      r.fingerprint,
      { revision: r.revision },
      req.ip,
    );
    res.json(publicState(db, req.user.id));
  }),
);
for (const [path, kind] of [
  ["verify", "verify_sso"],
  ["recovery-route", "configure_recovery_route"],
])
  ssoSetupRouter.post(
    `/${path}`,
    requireSudo,
    handle((req, res) => {
      const { db, r } = current(req);
      checkedRevision(req, r);
      publicHost(req, r);
      res.status(202).json({ job: queueSsoJob(db, r, kind, req.user.id) });
    }),
  );
ssoSetupRouter.post(
  "/recovery-check",
  requireSudo,
  handle((req, res) => {
    const { db, r } = current(req);
    checkedRevision(req, r);
    publicHost(req, r);
    const id = random();
    db.prepare("DELETE FROM sso_recovery_checks WHERE expires_at<?").run(
      Date.now(),
    );
    db.prepare(
      "INSERT INTO sso_recovery_checks(id,fingerprint,user_id,initiator_browser,expires_at) VALUES (?,?,?,?,?)",
    ).run(
      id,
      r.fingerprint,
      req.user.id,
      browser(req, res),
      Date.now() + 15 * 60_000,
    );
    res.json({
      url: `${r.config.publicOrigin}/api/auth/sso/recovery-context?id=${id}`,
      expiresInSeconds: 900,
    });
  }),
);
ssoSetupRouter.post(
  "/activate",
  requireSudo,
  handle(async (req, res) => {
    const { db, r } = current(req);
    checkedRevision(req, r);
    publicHost(req, r);
    await verifySettings(db, r);
    const linked = db
      .prepare("SELECT subject FROM sso_links WHERE issuer=? AND user_id=?")
      .get(r.config.issuer, req.user.id);
    if (!linked || !(await accountEnabled(db, r, linked.subject)))
      throw fail(
        "The linked administrator is unavailable or disabled in Keycloak.",
      );
    const full = readFullPlatform(db);
    if (full?.approved_revision && (!full.state.administratorVerified || full.state.handoffFingerprint !== r.fingerprint)) throw fail('Complete the Full Platform permanent-administrator and bootstrap-retirement handoff before activation.');
    const latest = assertCurrent(db, r.fingerprint),
      readiness = activationReadiness(db, latest, req.user.id);
    if (!readiness.ready)
      throw fail(`Activation requires: ${readiness.missing.join(", ")}.`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE sso_config SET active=1 WHERE id=1 AND fingerprint=?",
      ).run(r.fingerprint);
      db.prepare(
        `UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP,sudo_until=NULL WHERE revoked_at IS NULL AND id NOT IN
   (SELECT session_id FROM sso_session_context WHERE method='oidc' OR (method='local' AND origin=?))`,
      ).run(r.config.recoveryOrigin);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    logAudit(req.user.id, "SSO_ACTIVATED", "sso", r.fingerprint, {}, req.ip);
    res.json(publicState(db, req.user.id));
  }),
);

export const ssoRouter = Router();
ssoRouter.get(
  "/status",
  handle((req, res) => {
    const r = readConfig(getDb()),
      recovery = !!r && requestOrigin(req) === r.config.recoveryOrigin;
    res.json({
      enabled: !!r?.active && !recovery,
      recovery,
      recoveryOrigin: r?.config.recoveryOrigin || null,
    });
  }),
);
async function begin(req, res, action) {
  const { db, r } = current(req);
  publicHost(req, r);
  if (action === "login" && !r.active) throw fail("SSO is not activated.");
  if (!["login", "link", "test-login", "sudo"].includes(action))
    throw fail("Unknown SSO action.", 400);
  if (action === "link") {
    if (req.body?.confirmLink !== true)
      throw fail("Explicit linking confirmation is required.");
    requireLocalProof(db, req.session.id, r.config.publicOrigin);
  }
  const link =
    action !== "login" &&
    db
      .prepare("SELECT * FROM sso_links WHERE issuer=? AND user_id=?")
      .get(r.config.issuer, req.user.id);
  if (["sudo", "test-login"].includes(action) && !link)
    throw fail("Link this local account to Keycloak first.");
  await verifySettings(db, r);
  const startedAt = Date.now();
  const flow = {
    state: random(),
    nonce: random(),
    verifier: random(),
    startedAt,
    action,
    sessionId: req.session?.id || null,
    userId: req.user?.id || null,
    subject: link?.subject || null,
  };
  const url = await authorizationUrl(db, r, flow);
  assertCurrent(db, r.fingerprint);
  db.prepare("DELETE FROM sso_flows WHERE expires_at<?").run(startedAt);
  db.prepare("INSERT INTO sso_flows VALUES (?,?,?,?,?)").run(
    hash(flow.state),
    browser(req, res),
    r.fingerprint,
    startedAt + PROOF_MS,
    encryptSecret(JSON.stringify(flow)),
  );
  if (action === "login") res.redirect(303, url);
  else res.json({ url });
}
ssoRouter.get(
  "/login",
  handle((req, res) => begin(req, res, "login")),
);
ssoRouter.post(
  "/begin",
  authenticateToken,
  handle((req, res) =>
    begin(
      req,
      res,
      z.enum(["link", "test-login", "sudo"]).parse(req.body?.action),
    ),
  ),
);
ssoRouter.post(
  "/callback",
  handle(async (req, res) => {
    const { db, r } = current(req);
    publicHost(req, r);
    const state = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(req.body.state);
    // DELETE RETURNING spends the state atomically BEFORE network exchange.
    const saved = db
      .prepare("DELETE FROM sso_flows WHERE id=? RETURNING *")
      .get(hash(state));
    if (
      !saved ||
      saved.expires_at <= Date.now() ||
      saved.fingerprint !== r.fingerprint ||
      saved.browser_hash !== hash(req.cookies?.[BROWSER] || "")
    )
      throw fail("Invalid, expired or replayed SSO callback.", 400);
    const flow = JSON.parse(decryptSecret(saved.payload));
    const identity = await exchange(
      db,
      r,
      flow,
      new Request(r.config.redirectUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(req.body).toString(),
      }),
    );
    await verifySettings(db, r);
    const checkStarted = Date.now();
    if (!(await accountEnabled(db, r, identity.subject)))
      throw fail("The Keycloak account is disabled or unavailable.", 403);
    assertCurrent(db, r.fingerprint);
    let localSession = null;
    if (flow.sessionId) {
      await refreshCentralCheck(db, flow.sessionId);
      localSession = validateSession(flow.sessionId, r.config.publicOrigin);
      if (!localSession.ok || localSession.session.user_id !== flow.userId)
        throw fail("The initiating local session expired or was revoked.", 403);
    }
    if (flow.action === "link") {
      requireLocalProof(db, flow.sessionId, r.config.publicOrigin);
      const user = db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(flow.userId);
      if (!user || user.auth_source === "ldap" || user.role === "pending")
        throw fail("Link an enabled local account.", 403);
      const existing = db
        .prepare(
          "SELECT * FROM sso_links WHERE issuer=? AND (subject=? OR user_id=?)",
        )
        .all(identity.issuer, identity.subject, user.id);
      if (
        existing.some(
          (x) => x.subject !== identity.subject || x.user_id !== user.id,
        )
      )
        throw fail(
          "One of these identities is already linked. No account was changed.",
        );
      db.prepare("INSERT OR IGNORE INTO sso_links VALUES (?,?,?,?)").run(
        identity.issuer,
        identity.subject,
        user.id,
        new Date().toISOString(),
      );
      db.prepare("DELETE FROM sso_pending WHERE issuer=? AND subject=?").run(
        identity.issuer,
        identity.subject,
      );
      recordEvidence(db, r, user.id, "link", flow.sessionId);
      logAudit(
        user.id,
        "SSO_LINKED",
        "user",
        user.id,
        { issuer: identity.issuer },
        req.ip,
      );
      return res.redirect(
        303,
        sessionContext(db, flow.sessionId)?.method === "link-only"
          ? "/api/auth/sso/login"
          : user.role === "admin"
            ? "/platform-setup?sso=linked"
            : "/profile?sso=linked",
      );
    }
    const linked = db
      .prepare("SELECT * FROM sso_links WHERE issuer=? AND subject=?")
      .get(identity.issuer, identity.subject);
    if (!linked) {
      db.prepare(
        "INSERT OR IGNORE INTO sso_pending(issuer,subject,first_seen) VALUES (?,?,?)",
      ).run(identity.issuer, identity.subject, new Date().toISOString());
      return res.status(403).json({
        error:
          "Your Keycloak identity is pending. Sign in to your local account and explicitly link both identities. An administrator must assign access.",
        role_pending: true,
      });
    }
    if (
      flow.userId &&
      (linked.user_id !== flow.userId || identity.subject !== flow.subject)
    )
      throw fail("Reauthentication must use the same issuer and subject.", 403);
    const user = db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(linked.user_id);
    if (!user || user.role === "pending")
      throw fail("This local account is disabled or pending.", 403);
    if (flow.action === "sudo") {
      const until = new Date(
        Date.now() + Number(process.env.SUDO_GRANT_HOURS || 4) * 3600_000,
      ).toISOString();
      db.prepare(
        "UPDATE sessions SET sudo_until=? WHERE id=? AND revoked_at IS NULL",
      ).run(until, flow.sessionId);
      recordEvidence(db, r, user.id, "sudo", flow.sessionId);
      logAudit(
        user.id,
        "SUDO_GRANTED",
        "session",
        flow.sessionId,
        { factor: "oidc" },
        req.ip,
      );
      return res.redirect(303, "/sso-complete");
    }
    if (flow.action === "login" && !readConfig(db).active)
      throw fail("SSO was disabled during login.");
    const token = generateToken(user, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }),
      id = jwt.decode(token).jti;
    db.prepare(
      `INSERT INTO sso_session_context(session_id,user_id,origin,method,authenticated_at,issuer,subject,fingerprint,checked_until) VALUES (?,?,?,'oidc',?,?,?,?,?)`,
    ).run(
      id,
      user.id,
      r.config.publicOrigin,
      Date.now(),
      identity.issuer,
      identity.subject,
      r.fingerprint,
      checkStarted + REVOCATION_MS,
    );
    setAuthCookies(res, token);
    recordEvidence(db, r, user.id, "login", id);
    logAudit(
      user.id,
      "LOGIN_SUCCESS",
      "user",
      user.id,
      { factor: "oidc" },
      req.ip,
    );
    res.redirect(
      303,
      flow.action === "test-login" ? "/platform-setup?sso=login" : "/",
    );
  }),
);
// A fresh browser must first visit the primary hostname. Host-only cookies on
// two different hosts are not evidence of different browser contexts by themselves.
ssoRouter.get(
  "/recovery-context",
  handle((req, res) => {
    const { db, r } = current(req);
    publicHost(req, r);
    const id = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(req.query.id);
    const check = db
      .prepare("SELECT * FROM sso_recovery_checks WHERE id=?")
      .get(id);
    if (
      !check ||
      check.expires_at <= Date.now() ||
      check.fingerprint !== r.fingerprint ||
      check.browser_hash
    )
      throw fail("Recovery check expired or already opened.");
    const b = browser(req, res);
    if (b === check.initiator_browser)
      throw fail(
        "Open this check in a separate browser or private browser profile.",
      );
    const proof = random();
    db.prepare(
      "UPDATE sso_recovery_checks SET browser_hash=? WHERE id=? AND browser_hash IS NULL",
    ).run(`enter:${hash(proof)}`, id);
    res.redirect(
      303,
      `${r.config.recoveryOrigin}/api/auth/sso/recovery-enter?id=${id}&proof=${proof}`,
    );
  }),
);
ssoRouter.get(
  "/recovery-enter",
  handle((req, res) => {
    const { db, r } = current(req);
    if (requestOrigin(req) !== r.config.recoveryOrigin)
      throw fail("Use the recovery hostname.");
    const id = z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .parse(req.query.id),
      proof = z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .parse(req.query.proof);
    const result = db
      .prepare(
        "UPDATE sso_recovery_checks SET browser_hash=? WHERE id=? AND fingerprint=? AND expires_at>? AND browser_hash=?",
      )
      .run(
        browser(req, res),
        id,
        r.fingerprint,
        Date.now(),
        `enter:${hash(proof)}`,
      );
    if (!result.changes) throw fail("Invalid recovery check.");
    res.cookie("__Host-pp_recovery_check", id, {
      ...cookie,
      maxAge: 15 * 60_000,
    });
    res.redirect(303, "/login?recovery=1");
  }),
);
ssoRouter.post(
  "/recovery-confirm",
  authenticateToken,
  requireAdmin,
  requireSudo,
  handle((req, res) => {
    const { db, r } = current(req),
      ctx = localRecovery(req, db, r);
    const id = req.cookies?.["__Host-pp_recovery_check"];
    const check = db
      .prepare("SELECT * FROM sso_recovery_checks WHERE id=?")
      .get(id || "");
    if (
      !check ||
      check.user_id !== req.user.id ||
      check.fingerprint !== r.fingerprint ||
      check.expires_at <= Date.now() ||
      check.browser_hash !== hash(req.cookies?.[BROWSER] || "") ||
      ctx.authenticated_at < check.expires_at - 15 * 60_000 ||
      check.session_id
    )
      throw fail(
        "Start a new separate-browser check and sign in locally as the linked administrator.",
      );
    db.prepare("UPDATE sso_recovery_checks SET session_id=? WHERE id=?").run(
      req.session.id,
      id,
    );
    recordEvidence(db, r, req.user.id, "recovery", req.session.id);
    res.json({
      success: true,
      message:
        "Local recovery verified for this configuration. Return to the primary browser to activate SSO.",
    });
  }),
);
ssoRouter.post(
  "/disable",
  authenticateToken,
  requireAdmin,
  requireSudo,
  handle((req, res) => {
    const db = getDb(),
      r = readConfig(db);
    if (!r) throw fail("No SSO configuration is saved.");
    localRecovery(req, db, r);
    disableSso(db);
    logAudit(
      req.user.id,
      "SSO_DISABLED",
      "sso",
      r.fingerprint,
      { via: "local-recovery" },
      req.ip,
    );
    res.json({ success: true });
  }),
);
ssoRouter.get(
  "/session",
  authenticateToken,
  handle((req, res) => {
    const { db, r } = current(req);
    res.json({
      canReauthenticate:
        !req.user.linkOnly &&
        requestOrigin(req) === r.config.publicOrigin &&
        !!db
          .prepare("SELECT 1 FROM sso_links WHERE issuer=? AND user_id=?")
          .get(r.config.issuer, req.user.id),
      recovery: requestOrigin(req) === r.config.recoveryOrigin,
      lastSsoProofAt:
        db
          .prepare(
            "SELECT checked_at FROM sso_evidence WHERE fingerprint=? AND user_id=? AND kind='sudo' AND session_id=?",
          )
          .get(r.fingerprint, req.user.id, req.session.id)?.checked_at || null,
      localProofAt: sessionContext(db, req.session.id)?.local_proof_at || null,
    });
  }),
);
