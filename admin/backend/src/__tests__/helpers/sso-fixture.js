import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import * as OTPAuth from "otpauth";
process.env.TOTP_ENCRYPTION_KEY = "a".repeat(64);
process.env.JWT_SECRET = "isolated-sso-tests-only-".repeat(3);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
const issuer = "https://identity.example.com/realms/proxypilot";
let currentDb;
const fixture = {
  outage: false,
  enabled: true,
  claims: {},
  badSignature: false,
  policy: {},
  clients: {},
  requests: [],
  codes: new Map(),
};
globalThis.__ssoFixture = {
  getDb: () => currentDb,
  fetch: async (input, options = {}) => {
    const url = new URL(String(input));
    const params = new URLSearchParams(options.body || "");
    fixture.requests.push({
      path: url.pathname,
      method: options.method || "GET",
    });
    if (fixture.outage)
      throw new Error("Scripted IdP outage: secret must not be logged");
    const json = (value) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.endsWith("/certs")) return json({ keys: [publicJwk] });
    if (url.pathname.endsWith("/token")) {
      if (params.get("grant_type") === "client_credentials")
        return json({
          access_token: "observer-token-never-persist",
          token_type: "Bearer",
          expires_in: 60,
        });
      const flow = fixture.codes.get(params.get("code"));
      fixture.codes.delete(params.get("code"));
      if (
        !flow ||
        createHash("sha256")
          .update(params.get("code_verifier") || "")
          .digest("base64url") !== flow.challenge ||
        params.get("redirect_uri") !==
          "https://pilot.example.com/api/auth/sso/callback" ||
        params.get("client_id") !== "proxypilot"
      )
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      const now = Math.floor(Date.now() / 1000),
        claims = {
          iss: issuer,
          sub: flow.subject,
          aud: "proxypilot",
          iat: now,
          exp: now + 300,
          auth_time: now,
          nonce: flow.nonce,
          acr: "1",
          ...fixture.claims,
        };
      const encode = (v) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
      const content = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(claims)}`;
      let signature = sign(
        "RSA-SHA256",
        Buffer.from(content),
        privateKey,
      ).toString("base64url");
      if (fixture.badSignature)
        signature = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
      return json({
        access_token: "access-token-never-persist",
        id_token: `${content}.${signature}`,
        token_type: "Bearer",
        expires_in: 300,
      });
    }
    const base = "/admin/realms/proxypilot",
      c = JSON.parse(
        currentDb.prepare("SELECT config_json FROM sso_config").get()
          .config_json,
      );
    if (url.pathname === base)
      return json({
        realm: "proxypilot",
        enabled: true,
        webAuthnPolicyPasswordlessRpId: "identity.example.com",
        webAuthnPolicyPasswordlessUserVerificationRequirement: "required",
        webAuthnPolicyPasswordlessResidentKey: "required",
        ...fixture.policy,
      });
    if (url.pathname === base + "/clients")
      return json([
        {
          id: "client-uuid",
          clientId: c.clientId,
          protocol: "openid-connect",
          enabled: true,
          publicClient: false,
          bearerOnly: false,
          standardFlowEnabled: true,
          implicitFlowEnabled: false,
          directAccessGrantsEnabled: false,
          serviceAccountsEnabled: false,
          redirectUris: [c.redirectUri],
          attributes: { "pkce.code.challenge.method": "S256" },
          authenticationFlowBindingOverrides: { browser: "flow-id" },
          ...fixture.clients,
        },
      ]);
    if (url.pathname === base + "/authentication/flows")
      return json([{ id: "flow-id", alias: "proxypilot-passkeys" }]);
    if (url.pathname.endsWith("/executions"))
      return json([
        {
          providerId: "webauthn-authenticator-passwordless",
          requirement: "REQUIRED",
          authenticationFlow: false,
        },
      ]);
    if (url.pathname.endsWith("/required-actions"))
      return json([{ alias: "webauthn-register-passwordless", enabled: true }]);
    if (url.pathname.includes("/users/"))
      return json({
        id: decodeURIComponent(url.pathname.split("/").pop()),
        enabled: fixture.enabled,
      });
    throw new Error("Unexpected test endpoint " + url.pathname);
  },
};
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.endsWith("/db.js") &&
      context.parentURL?.includes("/admin/backend/src/")
    )
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export const getDb=()=>globalThis.__ssoFixture.getDb(); export const setSetting=(k,v)=>getDb().prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)").run(k,v); export const getAdminDomain=()=>getSetting('admin_domain'); export const AUDIT_TERMINAL_SESSION_START='TERMINAL_SESSION_START'; export const AUDIT_TERMINAL_SESSION_END='TERMINAL_SESSION_END'; export const getSetting=k=>getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(k)?.value; export function logAudit(user,action,type,id,data){getDb().prepare('INSERT INTO audit VALUES (?,?)').run(action,JSON.stringify(data));}`,
          ),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
  load(url, context, next) {
    // Replace only the network transport; production OAuth parsing, PKCE,
    // cryptographic signature checks, SQL, middleware and routes execute unchanged.
    if (url.endsWith("/lib/sso/oidc.js"))
      return {
        format: "module",
        source: readFileSync(new URL(url), "utf8").replace(
          /export function approvedFetch\([\s\S]*?\n\) \{/,
          "$& return globalThis.__ssoFixture.fetch;",
        ),
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const store = await import("../../lib/sso/store.js");
const sessions = await import("../../lib/sso/sessions.js");
const oidc = await import("../../lib/sso/oidc.js");
const auth = await import("../../middleware/auth.js");
const { authRouter } = await import("../../routes/auth.js");
const { ssoRouter, ssoSetupRouter } = await import("../../routes/sso.js");
const { csrfProtection } = await import("../../middleware/csrf.js");
const { ensureSetupEngineSchema } =
  await import("../../lib/setup-engine/store.js");
const { KEYCLOAK_SCHEMA } =
  await import("../../lib/setup-engine/keycloak-store.js");
export { store, sessions, oidc, auth, fixture };
export const input = {
  expectedRevision: 0,
  connectionId: "kc-aabbcc",
  publicOrigin: "https://pilot.example.com",
  recoveryOrigin: "https://recover.example.com",
  clientId: "proxypilot",
  readerClientId: "proxypilot-observer",
  clientSecret: "client-fixture-secret-only",
  readerSecret: "reader-fixture-secret-only",
  keycloakVersion: "26.7.4",
  requiredAcr: "1",
  recoveryNetworks: ["10.70.0.2/32"],
  roleMapping: "local-only",
  reviewed: true,
};
export async function setup() {
  fixture.outage = false;
  fixture.enabled = true;
  fixture.claims = {};
  fixture.badSignature = false;
  fixture.policy = {};
  fixture.clients = {};
  fixture.requests = [];
  fixture.codes.clear();
  const db = (currentDb = new DatabaseSync(":memory:"));
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,display_name TEXT,password_hash TEXT,totp_secret TEXT,totp_enabled INTEGER DEFAULT 1,role TEXT,auth_source TEXT DEFAULT 'local',password_change_required INTEGER DEFAULT 0,failed_attempts INTEGER DEFAULT 0,last_failed_at TEXT,locked_until TEXT,webauthn_user_handle BLOB,updated_at TEXT);
 CREATE TABLE sessions(auth_level TEXT NOT NULL DEFAULT 'full',id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT,last_used_at TEXT DEFAULT CURRENT_TIMESTAMP,revoked_at TEXT,sudo_until TEXT,ip TEXT,user_agent TEXT);
 CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE audit(action TEXT,data TEXT);
 CREATE TABLE user_permissions(user_id TEXT,permission TEXT);CREATE TABLE ldap_connections(id TEXT,enabled INTEGER,created_at TEXT,name TEXT);
 CREATE TABLE authenticated_devices(id TEXT,user_id TEXT,device_fingerprint TEXT,expires_at TEXT,last_used_at TEXT,ip_address TEXT);
 CREATE TABLE webauthn_credentials(id TEXT,user_id TEXT,credential_id TEXT,transports TEXT,public_key BLOB,counter INTEGER);
 CREATE TABLE mcp_tokens(id TEXT,created_by TEXT,revoked_at TEXT);
 CREATE TABLE user_login_links(id TEXT,user_id TEXT,token_hash TEXT,expires_at TEXT,completed_at TEXT);
 CREATE TABLE services(id TEXT PRIMARY KEY,name TEXT,kind TEXT,runtime TEXT,target_ip TEXT,type TEXT,status TEXT);
 CREATE TABLE service_http_routes(id TEXT PRIMARY KEY,service_id TEXT,domain TEXT,path_prefix TEXT,target_port INTEGER,websocket_enabled INTEGER,ssl_enabled INTEGER,force_https INTEGER,max_upload_size TEXT,strip_prefix INTEGER,ip_allowlist_json TEXT);
 INSERT INTO app_settings VALUES ('admin_domain','pilot.example.com');`);
  ensureSetupEngineSchema(db);
  db.exec(KEYCLOAK_SCHEMA);
  db.exec(store.SSO_SCHEMA);
  db.exec((await import('../../lib/totp-enrollment.js')).TOTP_ENROLLMENT_SCHEMA);
  const passwordHash = await bcrypt.hash("local-password-fixture", 4),
    secret = new OTPAuth.Secret({ size: 20 }).base32;
  for (const role of ["admin", "user", "pending"])
    db.prepare(
      "INSERT INTO users(id,username,password_hash,totp_secret,role) VALUES (?,?,?,?,?)",
    ).run(role, role, passwordHash, secret, role);
  db.prepare(
    "INSERT INTO setup_keycloak(id,ownership,origin,realm,created_revision,created_at,verified_json,verified_at) VALUES ('kc-aabbcc','external','https://identity.example.com','proxypilot',1,?,?,?)",
  ).run(
    new Date().toISOString(),
    JSON.stringify({ issuer, issuerExact: true, signingKeys: true }),
    new Date().toISOString(),
  );
  store.saveConfig(db, input, "admin");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(sessions.recoveryBoundary(db));
  app.use("/api/", csrfProtection);
  app.use("/api/auth/sso", ssoRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/setup/platform/sso", auth.authenticateToken, ssoSetupRouter);
  app.get(
    "/protected",
    auth.authenticateToken,
    auth.requireAdmin,
    auth.requireSudo,
    (req, res) => res.json({ ok: true }),
  );
  app.use((e, req, res, next) => res.status(500).json({ error: e.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  function local(userId = "admin", host = "pilot.example.com", proof = true) {
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId),
      token = auth.generateToken(user);
    sessions.recordLocalSession(db, token, { headers: { host } }, user);
    const row = db
      .prepare("SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1")
      .get();
    if (proof) {
      db.prepare("UPDATE sessions SET sudo_until=? WHERE id=?").run(
        new Date(Date.now() + 3600_000).toISOString(),
        row.id,
      );
      sessions.stampLocalProof(db, row.id);
    }
    return {
      id: row.id,
      token,
      cookie: `pp_token=${token}; pp_csrf=csrf; __Host-pp_sso_browser=${store.random()}`,
    };
  }
  async function request(
    path,
    {
      host = "pilot.example.com",
      cookie = "",
      body,
      method = body === undefined ? "GET" : "POST",
      form = false,
      csrf = true,
    } = {},
  ) {
    const headers = {
      host,
      ...(cookie ? { cookie } : {}),
      ...(csrf
        ? {
            "x-csrf-token":
              cookie.match(/(?:^|; )pp_csrf=([^;]*)/)?.[1] || "csrf",
          }
        : {}),
      ...(body !== undefined
        ? {
            "content-type": form
              ? "application/x-www-form-urlencoded"
              : "application/json",
          }
        : {}),
    };
    const payload =
      body === undefined
        ? undefined
        : form
          ? new URLSearchParams(body).toString()
          : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(url + path, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            for (const entry of Array.isArray(v) ? v : [v])
              responseHeaders.append(k, entry);
          resolve({ status: res.statusCode, headers: responseHeaders, data });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  async function begin(localSession, action = "link") {
    return request("/api/auth/sso/begin", {
      cookie: localSession.cookie,
      body: { action, confirmLink: true },
    });
  }
  function code(url, subject = "subject-admin") {
    const u = new URL(url),
      id = store.random();
    fixture.codes.set(id, {
      nonce: u.searchParams.get("nonce"),
      challenge: u.searchParams.get("code_challenge"),
      subject,
    });
    return { state: u.searchParams.get("state"), code: id, iss: issuer };
  }
  async function callback(beginResult, cookie, subject) {
    return request("/api/auth/sso/callback", {
      cookie,
      body: code(beginResult.data.url, subject),
      form: true,
      csrf: false,
    });
  }
  return {
    server,
    db,
    app,
    url,
    local,
    request,
    begin,
    callback,
    code,
    totp: () =>
      new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(secret),
      }).generate(),
    config: () => store.readConfig(db),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}
