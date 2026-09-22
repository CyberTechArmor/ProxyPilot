import { spawn } from "node:child_process";
// Disposable acceptance only. Start a dedicated Keycloak 26.7.4 on loopback,
// supply G3_KEYCLOAK_URL, G3_KEYCLOAK_PASSWORD, G3_TLS_KEY, G3_TLS_CERT and
// CHROMIUM_EXECUTABLE_PATH. Never point at an existing/production realm.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  openSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const express = require("express");
const base = process.env.G3_KEYCLOAK_URL;
if (
  !base ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) ||
  !process.env.G3_KEYCLOAK_PASSWORD
)
  throw new Error(
    "Use an explicitly supplied disposable loopback Keycloak and bootstrap password.",
  );
const output = process.env.G3_EVIDENCE_DIR || "/tmp/g3-evidence/live";
mkdirSync(output, { recursive: true });
async function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || "GET",
        headers: {
          ...Object.fromEntries(new Headers(options.headers)),
          "x-forwarded-proto": "https",
          "x-forwarded-port": "443",
          "x-forwarded-host": "identity.example.com",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () =>
          resolve(
            new Response(
              res.statusCode === 204 ? null : Buffer.concat(chunks),
              { status: res.statusCode, headers: res.headers },
            ),
          ),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(String(options.body));
    req.end();
  });
}
let keycloakChild;
if (process.env.G3_KEYCLOAK_HOME) {
  const log = openSync(output + "/keycloak.log", "w");
  keycloakChild = spawn(
    process.env.G3_KEYCLOAK_HOME + "/bin/kc.sh",
    [
      "start-dev",
      "--http-host=127.0.0.1",
      "--http-port=" + new URL(base).port,
      "--hostname=https://identity.example.com",
      "--proxy-headers=xforwarded",
    ],
    {
      env: {
        ...process.env,
        KC_BOOTSTRAP_ADMIN_USERNAME: "g3-bootstrap",
        KC_BOOTSTRAP_ADMIN_PASSWORD: process.env.G3_KEYCLOAK_PASSWORD,
      },
      stdio: ["ignore", log, log],
    },
  );
  process.on("exit", () => keycloakChild?.kill("SIGTERM"));
  for (let i = 0; i < 300; i++) {
    try {
      const r = await httpFetch(
        base + "/realms/master/.well-known/openid-configuration",
      );
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}
let adminToken;
async function kc(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
  retried = false,
) {
  const response = await httpFetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && !retried) {
    // Keycloak's bootstrap access token expires while long accessibility audits run.
    const fresh = await httpFetch(
      base + "/realms/master/protocol/openid-connect/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "admin-cli",
          username: "g3-bootstrap",
          password: process.env.G3_KEYCLOAK_PASSWORD,
        }),
      },
    );
    if (!fresh.ok) throw new Error("Disposable bootstrap refresh failed");
    adminToken = (await fresh.json()).access_token;
    return kc(path, body, method, true);
  }
  if (!response.ok)
    throw new Error(
      `Disposable Keycloak ${method} ${path}: ${response.status}`,
    );
  return response.status === 204 || response.status === 201
    ? null
    : response.json();
}
const tokenResponse = await httpFetch(
  base + "/realms/master/protocol/openid-connect/token",
  {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "g3-bootstrap",
      password: process.env.G3_KEYCLOAK_PASSWORD,
    }),
  },
);
if (!tokenResponse.ok)
  throw new Error("Disposable bootstrap authentication failed");
adminToken = (await tokenResponse.json()).access_token;
const existing = await httpFetch(base + "/admin/realms/proxypilot", {
  headers: { Authorization: `Bearer ${adminToken}` },
});
if (existing.ok) {
  const old = await existing.json();
  if (old.attributes?.g3_disposable !== "true")
    throw new Error("Refusing to replace an unmarked realm");
  await kc("/admin/realms/proxypilot", undefined, "DELETE");
}
await kc("/admin/realms", {
  realm: "proxypilot",
  enabled: true,
  attributes: { g3_disposable: "true" },
  registrationAllowed: false,
  webAuthnPolicyPasswordlessRpId: "identity.example.com",
  webAuthnPolicyPasswordlessUserVerificationRequirement: "required",
  webAuthnPolicyPasswordlessResidentKey: "required",
  webAuthnPolicyPasswordlessSignatureAlgorithms: ["ES256", "RS256"],
});
const rb = "/admin/realms/proxypilot";
await kc(
  rb + "/authentication/required-actions/webauthn-register-passwordless",
  {
    alias: "webauthn-register-passwordless",
    name: "WebAuthn Register Passwordless",
    providerId: "webauthn-register-passwordless",
    enabled: true,
    defaultAction: false,
  },
  "PUT",
);
await kc(rb + "/authentication/flows", {
  alias: "proxypilot-passkeys",
  providerId: "basic-flow",
  topLevel: true,
  builtIn: false,
});
await kc(
  rb + "/authentication/flows/proxypilot-passkeys/executions/execution",
  { provider: "webauthn-authenticator-passwordless" },
);
const execution = (
  await kc(rb + "/authentication/flows/proxypilot-passkeys/executions")
)[0];
await kc(
  rb + "/authentication/flows/proxypilot-passkeys/executions",
  { ...execution, requirement: "REQUIRED" },
  "PUT",
);
const flow = (await kc(rb + "/authentication/flows")).find(
  (x) => x.alias === "proxypilot-passkeys",
);
await kc(rb + "/clients", {
  clientId: "proxypilot",
  protocol: "openid-connect",
  enabled: true,
  publicClient: false,
  secret: "client-fixture-secret-only",
  standardFlowEnabled: true,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  redirectUris: ["https://pilot.example.com/api/auth/sso/callback"],
  attributes: {
    "pkce.code.challenge.method": "S256",
    "id.token.signed.response.alg": "RS256",
  },
  authenticationFlowBindingOverrides: { browser: flow.id },
});
await kc(rb + "/clients", {
  clientId: "proxypilot-observer",
  protocol: "openid-connect",
  enabled: true,
  publicClient: false,
  secret: "reader-fixture-secret-only",
  standardFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: true,
});
const observer = (await kc(rb + "/clients?clientId=proxypilot-observer"))[0],
  management = (await kc(rb + "/clients?clientId=realm-management"))[0];
const serviceAccount = await kc(
  `${rb}/clients/${observer.id}/service-account-user`,
);
const roles = await kc(`${rb}/clients/${management.id}/roles`);
await kc(
  `${rb}/users/${serviceAccount.id}/role-mappings/clients/${management.id}`,
  roles.filter((x) =>
    ["view-realm", "view-clients", "view-users"].includes(x.name),
  ),
);
await kc(rb + "/users", {
  username: "g3-admin",
  firstName: "G3",
  lastName: "Test",
  email: "g3@example.com",
  emailVerified: true,
  enabled: true,
  requiredActions: ["webauthn-register-passwordless"],
  credentials: [
    { type: "password", value: "disposable-user-passphrase", temporary: false },
  ],
});
const user = (await kc(rb + "/users?username=g3-admin"))[0];
const { setup, oidc, store, auth } =
  await import("../../backend/src/__tests__/helpers/sso-fixture.js");
const a = await setup();
// Keep every production OIDC operation; map only the verified origin's network
// traffic to this real loopback service. TLS browser proxy is below.
globalThis.__ssoFixture.fetch = (url, options) =>
  httpFetch(
    base + new URL(String(url)).pathname + new URL(String(url)).search,
    options,
  );
await oidc.verifySettings(a.db, a.config());
const { PLATFORM_PLAN_SCHEMA } =
  await import("../../backend/src/lib/setup-engine/platform-plan.js");
a.db.exec(PLATFORM_PLAN_SCHEMA);
const { setupRouter } = await import("../../backend/src/routes/setup.js");
a.app.use(
  "/api/setup",
  auth.authenticateToken,
  auth.blockPendingRole,
  setupRouter,
);
a.app.get("/api/user/profile", auth.authenticateToken, (req, res) =>
  res.json({ user: { ...req.user, hasPasskey: false } }),
);
a.app.get("/api/user/version", (_req, res) =>
  res.json({ version: "G3 disposable acceptance" }),
);
a.app.get("/api/user/version/check", (_req, res) =>
  res.json({ updateAvailable: false }),
);
a.app.get("/api/notifications", (_req, res) =>
  res.json({ notifications: [], unread_count: 0 }),
);
a.app.get("/api/branding", (_req, res) => res.json({}));
a.app.get("/api/cves", (_req, res) => res.json({ items: [] }));
a.app.get("/api/mock2/status", (_req, res) =>
  res.status(404).json({ error: "disabled" }),
);
a.app.use(express.static(resolve("admin/frontend/dist")));
a.app.get("*", (_req, res) =>
  res.sendFile(resolve("admin/frontend/dist/index.html")),
);
const tls = https.createServer(
  {
    key: readFileSync(process.env.G3_TLS_KEY),
    cert: readFileSync(process.env.G3_TLS_CERT),
  },
  (req, res) => {
    const isKc = req.headers.host === "identity.example.com",
      upstream = new URL(isKc ? base : a.url);
    const proxy = http.request(
      {
        hostname: "127.0.0.1",
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          "x-forwarded-proto": "https",
          "x-forwarded-port": "443",
          "x-forwarded-host": req.headers.host,
        },
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    proxy.on("error", () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(proxy);
  },
);
await new Promise((resolve) => tls.listen(18443, "127.0.0.1", resolve));
const forwardProxy = http.createServer((_req, res) => {
  res.writeHead(405);
  res.end();
});
forwardProxy.on("connect", (req, socket, head) => {
  if (!/^(identity|pilot|recover)\.example\.com:443$/.test(req.url)) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(18443, "127.0.0.1", () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
await new Promise((resolve) =>
  forwardProxy.listen(18888, "127.0.0.1", resolve),
);
let browser, lastPage;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors",
      "--proxy-server=http://127.0.0.1:18888",
      "--proxy-bypass-list=<-loopback>",
      "--remote-debugging-port=9223",
    ],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = (lastPage = await context.newPage());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.request().isNavigationRequest())
      console.log(
        "Navigation",
        r.status(),
        new URL(r.url()).origin,
        new URL(r.url()).pathname,
        r.headers()["location"]
          ? new URL(r.headers()["location"], r.url()).origin
          : "",
      );
  });
  page.on("requestfailed", (r) =>
    console.log(
      "Request failed",
      new URL(r.url()).origin,
      new URL(r.url()).pathname,
      r.failure()?.errorText,
    ),
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await page.goto("https://identity.example.com/realms/proxypilot/account/");
  await page.getByLabel("Username or email").fill("g3-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("disposable-user-passphrase");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: output + "/enrollment-before.png" });
  console.log("Enrollment location:", new URL(page.url()).pathname);
  console.log(
    "Enrollment screen:",
    (await page.locator("body").innerText()).slice(0, 2000),
  );
  // The following selects the actual Keycloak registration button; no credential
  // is inserted through the admin API or fabricated by the application.
  await page
    .getByRole("button", { name: /Register|Create a passkey/i })
    .first()
    .click();
  await page.waitForTimeout(1500);
  if (await page.getByLabel(/label/i).count()) {
    await page.getByLabel(/label/i).first().fill("G3 virtual passkey");
    await page
      .getByRole("button", { name: /OK|Save|Continue/i })
      .first()
      .click();
  }
  const credentials = await kc(`${rb}/users/${user.id}/credentials`);
  assert(credentials.some((c) => c.type === "webauthn-passwordless"));
  const local = a.local();
  await context.addCookies([
    {
      name: "pp_token",
      value: local.token,
      url: "https://pilot.example.com",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "pp_csrf",
      value: "csrf",
      url: "https://pilot.example.com",
      secure: true,
      sameSite: "Strict",
    },
    {
      name: "__Host-pp_sso_browser",
      value: local.cookie.split("__Host-pp_sso_browser=")[1],
      url: "https://pilot.example.com",
      secure: true,
      httpOnly: true,
      sameSite: "None",
    },
  ]);
  await page.goto("https://pilot.example.com/platform-setup");
  await page
    .getByRole("heading", { name: "ProxyPilot SSO, passkeys & recovery" })
    .waitFor();
  const audits = [];
  for (const width of [360, 375, 390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.addStyleTag({
      content: "html,body{overflow-x:visible!important}",
    });
    await page
      .getByRole("heading", { name: "ProxyPilot SSO, passkeys & recovery" })
      .scrollIntoViewIfNeeded();
    const sizes = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    assert.equal(sizes.scroll, sizes.client);
    audits.push({ width, ...sizes });
    if ([360, 1280].includes(width))
      await page.screenshot({ path: `${output}/guide-${width}.png` });
  }
  await page
    .getByRole("button", { name: "Link my existing account", exact: true })
    .click();
  await page
    .getByLabel("Password", { exact: true })
    .fill("local-password-fixture");
  await page.getByLabel("Authenticator Code", { exact: true }).fill(a.totp());
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.waitForURL(/identity\.example\.com/);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: output + "/link-keycloak.png" });
  const signIn = page.getByRole("button", {
    name: /Sign in with.*passkey|Sign in with.*security|Authenticate/i,
  });
  if (await signIn.count()) await signIn.first().click();
  await page.waitForURL("https://pilot.example.com/platform-setup?sso=linked", {
    timeout: 30000,
  });
  assert.equal(
    a.db.prepare("SELECT subject FROM sso_links").get().subject,
    user.id,
  );
  await page
    .getByRole("button", { name: "Test passkey SSO login", exact: true })
    .click();
  await page.waitForURL(/identity\.example\.com/);
  if (await signIn.count()) await signIn.first().click();
  await page.waitForURL("https://pilot.example.com/platform-setup?sso=login", {
    timeout: 30000,
  });
  const sso = a.db
    .prepare("SELECT * FROM sso_session_context WHERE method='oidc'")
    .get();
  assert(sso);
  assert.equal(
    a.db
      .prepare("SELECT sudo_until FROM sessions WHERE id=?")
      .get(sso.session_id).sudo_until,
    null,
  );
  const cookies = await context.cookies("https://pilot.example.com");
  const ssoCookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const popupEvent = context.waitForEvent("page");
  await page
    .getByRole("button", { name: "Test Keycloak step-up", exact: true })
    .click();
  const popup = await popupEvent;
  const popupCdp = await context.newCDPSession(popup);
  await popupCdp.send("WebAuthn.enable");
  const popupAuth = await popupCdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  for (const credential of (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials)
    await popupCdp.send("WebAuthn.addCredential", {
      authenticatorId: popupAuth.authenticatorId,
      credential,
    });
  await popup.waitForURL(/identity\.example\.com/);
  const popupSign = popup.getByRole("button", {
    name: /Sign in with.*passkey|Sign in with.*security|Authenticate/i,
  });
  if (await popupSign.count()) await popupSign.first().click();
  await popup.waitForEvent("close", { timeout: 30000 });
  assert(
    a.db
      .prepare("SELECT sudo_until FROM sessions WHERE id=?")
      .get(sso.session_id).sudo_until,
  );
  await page.goto("https://pilot.example.com/platform-setup");
  await page
    .getByRole("heading", { name: "ProxyPilot SSO, passkeys & recovery" })
    .waitFor();
  const lighthouseScores = {},
    surfaceAudits = [],
    accessibility = [];
  const browserCdp = await browser.newBrowserCDPSession();
  async function auditSurface(surface, name, { lighthouseCheck = true } = {}) {
    await surface.waitForLoadState("networkidle");
    for (const width of [360, 375, 390, 768, 1280, 1920]) {
      await surface.setViewportSize({ width, height: 900 });
      await surface.waitForTimeout(400); // Let the existing responsive sidebar transition settle.
      await surface.addStyleTag({
        content: "html,body{overflow-x:visible!important}",
      });
      const size = await surface.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      assert.equal(size.scroll, size.client, `${name} overflow ${width}`);
      surfaceAudits.push({ page: name, width, ...size });
      if (name === "guide")
        await surface
          .getByRole("heading", { name: "ProxyPilot SSO, passkeys & recovery" })
          .scrollIntoViewIfNeeded();
      if ([360, 1280].includes(width))
        await surface.screenshot({ path: `${output}/${name}-${width}.png` });
    }
    await surface.addScriptTag({
      path: require.resolve("axe-core/axe.min.js"),
    });
    const violations = await surface.evaluate(async () =>
      (
        await axe.run(document.querySelector("main") || document, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21aa"],
        })
      ).violations.map((x) => ({
        id: x.id,
        impact: x.impact,
        targets: x.nodes.map((n) => n.target),
      })),
    );
    accessibility.push({ page: name, violations });
    assert.deepEqual(violations, [], `${name} accessibility`);
    if (lighthouseCheck && process.env.G3_LIGHTHOUSE_MODULE) {
      const { default: lighthouse } = await import(
        process.env.G3_LIGHTHOUSE_MODULE
      );
      const cookies = await surface
        .context()
        .cookies(new URL(surface.url()).origin);
      await browserCdp.send("Storage.clearCookies");
      await browserCdp.send("Storage.setCookies", {
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          url: new URL(surface.url()).origin,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
        })),
      });
      const result = await lighthouse(surface.url(), {
        port: 9223,
        onlyCategories: ["accessibility"],
        output: "json",
        logLevel: "error",
        formFactor: "mobile",
        screenEmulation: {
          mobile: true,
          width: 360,
          height: 800,
          deviceScaleFactor: 1,
          disabled: false,
        },
        disableStorageReset: true,
      });
      assert.equal(
        new URL(result.lhr.finalDisplayedUrl).pathname,
        new URL(surface.url()).pathname,
        `Lighthouse ${name} destination`,
      );
      lighthouseScores[name] = result.lhr.categories.accessibility.score * 100;
      assert(
        lighthouseScores[name] >= 90,
        `${name} Lighthouse ${lighthouseScores[name]}`,
      );
      writeFileSync(
        output + "/lighthouse-scores.json",
        JSON.stringify(lighthouseScores),
      );
    }
  }
  await auditSurface(page, "guide");
  const challenge = await a.request("/api/setup/platform/sso/recovery-check", {
    cookie: ssoCookie,
    body: { fingerprint: a.config().fingerprint },
  });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.data));
  const recoveryContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 375, height: 812 },
  });
  const recoveryPage = (lastPage = await recoveryContext.newPage());
  recoveryPage.on("response", async (r) => {
    if (new URL(r.url()).pathname === "/api/auth/login") {
      const d = await r.json().catch(() => ({}));
      console.log("Recovery sign-in", r.status(), {
        error: d.error,
        totpRequired: d.totpRequired,
      });
    }
  });
  await recoveryPage.goto(challenge.data.url);
  await recoveryPage.getByLabel("Username", { exact: true }).fill("admin");
  await recoveryPage
    .getByLabel("Password", { exact: true })
    .fill("local-password-fixture");
  await recoveryPage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await recoveryPage.getByLabel("TOTP Code", { exact: true }).fill(a.totp());
  await recoveryPage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await recoveryPage.waitForURL("https://recover.example.com/local-recovery");
  await recoveryPage
    .getByRole("button", { name: "Confirm separate-browser recovery" })
    .click();
  await recoveryPage
    .getByLabel("Password", { exact: true })
    .fill("local-password-fixture");
  await recoveryPage
    .getByLabel("Authenticator Code", { exact: true })
    .fill(a.totp());
  await recoveryPage
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await recoveryPage
    .getByRole("status")
    .filter({ hasText: "Local recovery verified" })
    .waitFor();
  assert(
    a.db.prepare("SELECT 1 FROM sso_evidence WHERE kind='recovery'").get(),
  );
  await auditSurface(recoveryPage, "recovery");
  const routeDir = mkdtempSync(join(tmpdir(), "g3-live-route-"));
  try {
    const { runBackendSteps } =
      await import("../../backend/src/lib/setup-engine/backend-steps.js");
    const { configureRecoveryRoute } =
      await import("../../backend/src/lib/sso/recovery-route.js");
    store.queueSsoJob(a.db, a.config(), "configure_recovery_route", "admin");
    await runBackendSteps({
      db: a.db,
      owner: "backend@g3#1:live",
      deps: {
        ssoStep: ({ fingerprint, fence }) =>
          configureRecoveryRoute(a.db, {
            fingerprint,
            fence,
            render: {
              caddyFilePath: (domain) =>
                join(routeDir, "sites", domain + ".caddy"),
              regenerate: async () => {},
              adapt: async () => {},
              reload: async () => {},
              writeConfig: async () => {},
              deleteConfig: async () => {},
            },
          }),
      },
    });
  } finally {
    rmSync(routeDir, { recursive: true, force: true });
  }
  await page
    .getByRole("button", { name: "Refresh check results", exact: true })
    .click();
  await page.getByRole("button", { name: "Activate SSO", exact: true }).click();
  await page.getByRole("button", { name: "SSO active", exact: true }).waitFor();
  assert.equal(a.config().active, 1);
  const linkContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 375, height: 812 },
  });
  const linkPage = (lastPage = await linkContext.newPage());
  await linkPage.goto("https://pilot.example.com/login");
  await linkPage
    .getByRole("link", { name: "Sign in with Keycloak passkey", exact: true })
    .waitFor();
  await auditSurface(linkPage, "sso-login");
  await linkPage.goto("https://pilot.example.com/login?link=1");
  await linkPage.getByLabel("Username", { exact: true }).fill("user");
  await linkPage
    .getByLabel("Password", { exact: true })
    .fill("local-password-fixture");
  await linkPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await linkPage.getByLabel("TOTP Code", { exact: true }).fill(a.totp());
  await linkPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await linkPage.waitForURL("https://pilot.example.com/link-sso");
  await auditSurface(linkPage, "account-link");

  await kc(`${rb}/users/${user.id}`, { enabled: false }, "PUT");
  a.db
    .prepare(
      "UPDATE sso_session_context SET checked_until=0 WHERE session_id=?",
    )
    .run(sso.session_id);
  const revoked = await a.request("/api/auth/verify", { cookie: ssoCookie });
  assert.equal(revoked.status, 401);
  if (keycloakChild) {
    keycloakChild.kill("SIGTERM");
    await new Promise((r) => keycloakChild.once("exit", r));
    keycloakChild = null;
  }
  await recoveryPage
    .getByRole("button", { name: "Disable SSO", exact: true })
    .click();
  await recoveryPage
    .getByLabel("Password", { exact: true })
    .fill("local-password-fixture");
  await recoveryPage
    .getByLabel("Authenticator Code", { exact: true })
    .fill(a.totp());
  await recoveryPage
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await recoveryPage
    .getByRole("status")
    .filter({ hasText: "SSO disabled" })
    .waitFor();
  assert.equal(a.config().active, 0);
  await recoveryPage.goto("https://recover.example.com/login");
  // An explicit unauthenticated recovery browser verifies the local login form.
  const loginContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const loginPage = await loginContext.newPage();
  await loginPage.goto("https://recover.example.com/login");
  await auditSurface(loginPage, "local-login");
  const evidence = {
    keycloak: "26.7.4",
    database: "disposable H2",
    browser:
      "headless Chromium with virtual CTAP2 UV/discoverable authenticator",
    ceremonies: [
      "actual Keycloak passkey registration",
      "actual signed authorization-code + PKCE linking",
      "actual passkey SSO login without elevation",
      "actual fresh same-subject OIDC sudo",
      "actual central disable observed by read-only admin API at forced local cache expiry (60-second boundary tested in the backend suite)",
      "separate-browser local password/TOTP recovery and sudo",
      "explicit frontend activation after all server prerequisites",
      "local disable with disposable Keycloak stopped",
    ],
    audits: [...audits, ...surfaceAudits],
    lighthouseScores,
    accessibility,
    pageErrors: errors,
    limitations: [
      "loopback transport mapping and locally generated TLS certificate",
      "virtual authenticator, not physical device",
      "Caddy route job uses production SQL/job code but scripted binary responses; production administrator-network controls not exercised",
      "no production changes",
    ],
  };
  assert.deepEqual(errors, []);
  writeFileSync(output + "/evidence.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (e) {
  if (lastPage) {
    await lastPage
      .screenshot({ path: output + "/failure.png" })
      .catch(() => {});
    console.log("Failure location:", new URL(lastPage.url()).pathname);
    console.log(
      "Failure screen:",
      (await lastPage.locator("body").innerText()).slice(0, 2400),
    );
  }
  throw e;
} finally {
  if (browser) await browser.close();
  forwardProxy.close();
  await new Promise((resolve) => tls.close(resolve));
  await a.close();
  if (keycloakChild) keycloakChild.kill("SIGTERM");
}
