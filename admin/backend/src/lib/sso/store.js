import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { encryptSecret, decryptSecret } from "../secrets.js";
import { createJob, getJob, jobView } from "../setup-engine/store.js";
import {
  keycloakTargetSchema,
  issuerFor,
} from "../setup-engine/keycloak-logic.js";
import { validateRouteEdgeOptions } from "../caddy-site-file.js";

export const SSO_APP = "proxypilot-sso";
export const REVOCATION_MS = 60_000;
export const PROOF_MS = 5 * 60_000;
export const SSO_SCHEMA = `
CREATE TABLE IF NOT EXISTS sso_config (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, config_json TEXT NOT NULL,
 fingerprint TEXT NOT NULL, verified_json TEXT, verified_at TEXT, active INTEGER NOT NULL DEFAULT 0,
 job_id TEXT, route_job_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sso_credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sso_links (
 issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 linked_at TEXT NOT NULL, PRIMARY KEY(issuer,subject), UNIQUE(issuer,user_id)
);
CREATE TABLE IF NOT EXISTS sso_pending (
 issuer TEXT NOT NULL, subject TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'pending' CHECK(role='pending'),
 first_seen TEXT NOT NULL, PRIMARY KEY(issuer,subject)
);
CREATE TABLE IF NOT EXISTS sso_flows (
 id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sso_session_context (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
 origin TEXT NOT NULL, method TEXT NOT NULL, authenticated_at INTEGER NOT NULL,
 local_proof_at INTEGER, issuer TEXT, subject TEXT, fingerprint TEXT, checked_until INTEGER
);
CREATE TABLE IF NOT EXISTS sso_evidence (
 fingerprint TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL,
 checked_at INTEGER NOT NULL, PRIMARY KEY(fingerprint,user_id,kind)
);
CREATE TABLE IF NOT EXISTS sso_recovery_checks (
 id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, user_id TEXT NOT NULL, initiator_browser TEXT NOT NULL,
 expires_at INTEGER NOT NULL, browser_hash TEXT, session_id TEXT
);
`;
export const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
export const random = () => randomBytes(32).toString("base64url");
export const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status, ssoSafe: true });
const origin = z.string().refine(
  (v) =>
    keycloakTargetSchema.safeParse({
      mode: "connect",
      url: v,
      realm: "proxypilot",
    }).success,
  "Use an exact HTTPS DNS origin, without a path or port.",
);
const credential = z.string().min(16).max(4096).optional();
export const configInput = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    connectionId: z.string().regex(/^kc-[a-z0-9]+$/),
    publicOrigin: origin,
    recoveryOrigin: origin,
    clientId: z.string().regex(/^[a-zA-Z0-9._-]{3,100}$/),
    readerClientId: z.string().regex(/^[a-zA-Z0-9._-]{3,100}$/),
    clientSecret: credential,
    readerSecret: credential,
    keycloakVersion: z.literal("26.7.4"),
    requiredAcr: z.string().regex(/^[a-zA-Z0-9:._-]{1,100}$/),
    recoveryNetworks: z.array(z.string().max(50)).min(1).max(30),
    roleMapping: z.literal("local-only"),
    reviewed: z.literal(true),
  })
  .strict();
export function readConfig(db) {
  const r = db.prepare("SELECT * FROM sso_config WHERE id=1").get();
  return r
    ? {
        ...r,
        config: JSON.parse(r.config_json),
        verification: r.verified_json ? JSON.parse(r.verified_json) : null,
      }
    : null;
}
export function assertCurrent(db, fingerprint) {
  const r = readConfig(db);
  if (!r || r.fingerprint !== fingerprint)
    throw fail(
      "SSO configuration changed. Repeat the checks for the saved configuration.",
    );
  const k = db
    .prepare("SELECT * FROM setup_keycloak WHERE id=?")
    .get(r.config.connectionId);
  const v = k?.verified_json ? JSON.parse(k.verified_json) : null;
  if (
    !k?.verified_at ||
    v?.issuer !== r.config.issuer ||
    v?.issuerExact !== true ||
    v?.signingKeys !== true
  )
    throw fail("The selected G2 connection is not verified.");
  return r;
}
export function readCredential(db, ref) {
  const value = db
    .prepare("SELECT value FROM sso_credentials WHERE id=?")
    .get(ref)?.value;
  if (!value)
    throw fail("The protected SSO credential reference is unavailable.");
  return decryptSecret(value);
}
export function recordEvidence(
  db,
  r,
  userId,
  kind,
  sessionId,
  now = Date.now(),
) {
  assertCurrent(db, r.fingerprint);
  db.prepare("INSERT OR REPLACE INTO sso_evidence VALUES (?,?,?,?,?)").run(
    r.fingerprint,
    userId,
    kind,
    sessionId,
    now,
  );
}
export function saveConfig(db, input, userId) {
  const p = configInput.parse(input),
    old = readConfig(db);
  if ((old?.revision || 0) !== p.expectedRevision)
    throw fail("SSO revision changed. Reopen before saving.");
  if (old?.active)
    throw fail(
      "Disable SSO using local recovery before changing its configuration.",
    );
  const k = db
    .prepare("SELECT * FROM setup_keycloak WHERE id=?")
    .get(p.connectionId);
  if (!k?.verified_at) throw fail("Verify the G2 connection first.");
  const issuer = issuerFor({ url: k.origin, realm: k.realm });
  const verified = JSON.parse(k.verified_json || "{}");
  if (
    verified.issuer !== issuer ||
    !verified.issuerExact ||
    !verified.signingKeys
  )
    throw fail("The G2 issuer is not verified.");
  if (new Set([p.publicOrigin, p.recoveryOrigin, k.origin]).size !== 3)
    throw fail(
      "Use three distinct hostnames for ProxyPilot, recovery and Keycloak.",
    );
  const adminDomain = db
    .prepare("SELECT value FROM app_settings WHERE key='admin_domain'")
    .get()?.value;
  if (p.publicOrigin !== `https://${adminDomain}`)
    throw fail(
      "The public origin must match the current ProxyPilot administrator hostname.",
    );
  const networks = validateRouteEdgeOptions({
    ip_allowlist: p.recoveryNetworks,
  });
  if (networks.error || p.recoveryNetworks.some((n) => /\/0$/.test(n)))
    throw fail(
      "Use restricted administrator/WireGuard IPs or CIDRs, never an all-address network.",
    );
  if (p.clientId === p.readerClientId)
    throw fail("Use a separate read-only realm observer client.");
  db.exec("BEGIN IMMEDIATE");
  try {
    if ((readConfig(db)?.revision || 0) !== p.expectedRevision)
      throw fail("SSO revision changed. Reopen before saving.");
    function secretRef(value, prior) {
      if (!value && prior) return prior;
      if (!value) throw fail("Supply both client credentials on first save.");
      const id = randomUUID();
      db.prepare("INSERT INTO sso_credentials VALUES (?,?)").run(
        id,
        encryptSecret(value),
      );
      return id;
    }
    const {
      clientSecret,
      readerSecret,
      expectedRevision,
      reviewed,
      ...fields
    } = p;
    const config = {
      ...fields,
      issuer,
      keycloakOrigin: k.origin,
      realm: k.realm,
      clientSecretRef: secretRef(clientSecret, old?.config.clientSecretRef),
      readerSecretRef: secretRef(readerSecret, old?.config.readerSecretRef),
      redirectUri: `${p.publicOrigin}/api/auth/sso/callback`,
      recoveryRpId: new URL(p.recoveryOrigin).hostname,
    };
    const revision = expectedRevision + 1;
    // Revision is included: re-saving cannot reuse any previous ceremony.
    // The restricted recovery networks are NOT: they are (VPN networks) ∪
    // (operator's additional addresses), edited at any time — also after
    // activation — through the reviewed, step-up-gated, audited networks
    // change, which rewrites this record's list and the recovery route
    // together (activationReadiness still checks the two agree).
    const { recoveryNetworks: _networks, ...bound } = config;
    const fingerprint = hash(JSON.stringify({ revision, config: bound }));
    db.prepare(
      `INSERT INTO sso_config(id,revision,config_json,fingerprint,created_by,created_at) VALUES (1,?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,fingerprint=excluded.fingerprint,
   created_by=excluded.created_by,created_at=excluded.created_at,verified_json=NULL,verified_at=NULL,active=0,job_id=NULL,route_job_id=NULL`,
    ).run(
      revision,
      JSON.stringify(config),
      fingerprint,
      userId,
      new Date().toISOString(),
    );
    db.prepare(
      "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP,sudo_until=NULL WHERE id IN (SELECT session_id FROM sso_session_context WHERE method='oidc')",
    ).run();
    db.prepare("DELETE FROM sso_flows").run();
    db.prepare("DELETE FROM sso_recovery_checks").run();
    db.exec("COMMIT");
    return readConfig(db);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function queueSsoJob(db, r, kind, userId) {
  assertCurrent(db, r.fingerprint);
  const column = kind === "verify_sso" ? "job_id" : "route_job_id";
  const existing = r[column] && getJob(db, r[column]);
  if (existing && ["queued", "running"].includes(existing.status))
    return jobView(existing);
  const job = createJob(db, {
    app: SSO_APP,
    kind,
    plan: { params: { fingerprint: r.fingerprint } },
    configRefs: { sso: r.fingerprint },
    requestedBy: userId,
    via: "ui",
  });
  db.prepare(
    `UPDATE sso_config SET ${column}=? WHERE id=1 AND fingerprint=?`,
  ).run(job.id, r.fingerprint);
  return jobView(job);
}
export function activationReadiness(db, r, userId, now = Date.now()) {
  const checks = Object.fromEntries(
    db
      .prepare("SELECT * FROM sso_evidence WHERE fingerprint=? AND user_id=?")
      .all(r.fingerprint, userId)
      .map((e) => [e.kind, e]),
  );
  const linked = db
    .prepare("SELECT * FROM sso_links WHERE issuer=? AND user_id=?")
    .get(r.config.issuer, userId);
  const admin = db
    .prepare(
      "SELECT id FROM users WHERE id=? AND role='admin' AND (auth_source='local' OR auth_source IS NULL)",
    )
    .get(userId);
  const missing = [];
  if (!admin || !linked) missing.push("administrator_link");
  if (!r.verified_at || !r.verification?.valid)
    missing.push("client_and_passkey_settings");
  for (const kind of ["login", "sudo", "recovery"]) {
    const evidence = checks[kind];
    const session =
      evidence &&
      db
        .prepare("SELECT * FROM sessions WHERE id=? AND user_id=?")
        .get(evidence.session_id, userId);
    if (
      !evidence ||
      now - evidence.checked_at > 3600_000 ||
      !session ||
      session.revoked_at ||
      Date.parse(session.expires_at) <= now
    )
      missing.push(kind);
  }
  if (
    checks.login &&
    checks.recovery &&
    checks.login.session_id === checks.recovery.session_id
  )
    missing.push("separate_recovery_session");
  const job = r.route_job_id && getJob(db, r.route_job_id);
  const route = db
    .prepare(
      `SELECT r.*,s.name,s.target_ip FROM service_http_routes r JOIN services s ON s.id=r.service_id WHERE r.id='proxypilot-local-recovery'`,
    )
    .get();
  if (
    job?.status !== "succeeded" ||
    !route ||
    route.service_id !== "proxypilot-local-recovery" ||
    route.name !== "proxypilot-local-recovery" ||
    route.target_ip !== "127.0.0.1" ||
    route.domain !== new URL(r.config.recoveryOrigin).hostname ||
    route.path_prefix !== "/" ||
    !route.ssl_enabled ||
    !route.force_https ||
    Number(route.target_port) !== Number(process.env.PORT || 3001) ||
    route.ip_allowlist_json !== JSON.stringify(r.config.recoveryNetworks)
  )
    missing.push("recovery_route");
  return { ready: missing.length === 0, missing, checks };
}
export function publicState(db, userId) {
  const r = readConfig(db);
  if (!r) return { configured: false, revision: 0 };
  return {
    configured: true,
    revision: r.revision,
    fingerprint: r.fingerprint,
    active: !!r.active,
    config: r.config,
    verification: r.verification,
    verifiedAt: r.verified_at,
    readiness: activationReadiness(db, r, userId),
    job: r.job_id ? jobView(getJob(db, r.job_id)) : null,
    routeJob: r.route_job_id ? jobView(getJob(db, r.route_job_id)) : null,
    revocation: {
      maximumDelaySeconds: 60,
      outage:
        "SSO requests fail closed when the last account check expires; local recovery remains available.",
    },
  };
}
