import test from "node:test";
import assert from "node:assert/strict";
import {
  setup,
  store,
  sessions,
  oidc,
  auth,
  fixture,
  input,
} from "./helpers/sso-fixture.js";
import { getJob } from "../lib/setup-engine/store.js";
import { runBackendSteps } from "../lib/setup-engine/backend-steps.js";
import { configureRecoveryRoute } from "../lib/sso/recovery-route.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withApp(fn) {
  const app = await setup();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}
const cookieValue = (headers, name) =>
  headers
    .getSetCookie()
    .find((x) => x.startsWith(name + "="))
    ?.split(";")[0];

test("G3 configuration requires verified G2, exact host, explicit role policy and protected refs; stale revision refuses", () =>
  withApp(async (a) => {
    const before = a.db.prepare("SELECT * FROM users").all();
    const local = a.local();
    assert.equal((await a.request("/api/setup/platform/sso")).status, 401);
    assert.equal(
      (
        await a.request("/api/setup/platform/sso", {
          cookie: a.local("user").cookie,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await a.request("/api/setup/platform/sso", {
          cookie: local.cookie,
          body: input,
          method: "PUT",
          csrf: false,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await a.request("/api/setup/platform/sso", {
          cookie: local.cookie,
          body: input,
          method: "PUT",
        })
      ).status,
      409,
    );
    const state = (
      await a.request("/api/setup/platform/sso", { cookie: local.cookie })
    ).data;
    assert(!JSON.stringify(state).includes(input.clientSecret));
    assert(!JSON.stringify(state).includes(input.readerSecret));
    assert(
      a.db
        .prepare("SELECT value FROM sso_credentials")
        .all()
        .every((x) => x.value.startsWith("enc:v1:")),
    );
    assert.throws(() =>
      store.saveConfig(
        a.db,
        {
          ...input,
          expectedRevision: 1,
          publicOrigin: "https://attacker.example.com",
        },
        "admin",
      ),
    );
    assert.throws(() =>
      store.saveConfig(
        a.db,
        { ...input, expectedRevision: 1, roleMapping: "admin" },
        "admin",
      ),
    );
    assert.deepEqual(a.db.prepare("SELECT * FROM users").all(), before);
  }));

test("G3 explicit account proof links issuer+subject without changing account data; no email auto-link or silent admin", () =>
  withApp(async (a) => {
    const admin = a.local(),
      before = a.db.prepare("SELECT * FROM users").all();
    assert.equal(
      (await a.begin(a.local("admin", "pilot.example.com", false))).status,
      403,
    );
    const begin = await a.begin(admin);
    assert.equal(begin.status, 200);
    const u = new URL(begin.data.url);
    assert.equal(u.searchParams.get("response_mode"), "form_post");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("prompt"), "login");
    assert.equal(u.searchParams.get("max_age"), "0");
    assert.equal((await a.callback(begin, admin.cookie)).status, 303);
    assert.deepEqual(a.db.prepare("SELECT * FROM users").all(), before);
    assert.equal(
      a.db.prepare("SELECT user_id FROM sso_links").get().user_id,
      "admin",
    );
    const user = a.local("user");
    assert.equal(
      (await a.callback(await a.begin(user), user.cookie)).status,
      409,
    );
    a.db.prepare("UPDATE sso_config SET active=1").run();
    const login = await a.request("/api/auth/sso/login", {
      cookie: user.cookie,
    });
    fixture.claims = {
      email: "admin@example.com",
      realm_access: { roles: ["admin"] },
      groups: ["admins"],
    };
    const cb = await a.request("/api/auth/sso/callback", {
      cookie: user.cookie,
      body: a.code(login.headers.get("location"), "unknown-subject"),
      form: true,
      csrf: false,
    });
    assert.equal(cb.status, 403);
    assert.equal(
      a.db.prepare("SELECT role FROM sso_pending").get().role,
      "pending",
    );
    assert.equal(a.db.prepare("SELECT COUNT(*) n FROM users").get().n, 3);
    assert(!cb.headers.getSetCookie().some((x) => x.startsWith("pp_token=")));
  }));

test("G3 real OIDC validation rejects bad signature, issuer, audience, expiry, nonce, state, PKCE and replay", () =>
  withApp(async (a) => {
    const local = a.local();
    for (const [name, patch] of [
      ["issuer", { iss: "https://evil.example.com" }],
      ["audience", { aud: "another-client" }],
      ["expiry", { exp: 1 }],
      ["nonce", { nonce: "wrong" }],
      ["future auth", { auth_time: Math.floor(Date.now() / 1000) + 120 }],
      ["stale auth", { auth_time: Math.floor(Date.now() / 1000) - 600 }],
      ["assurance", { acr: "0" }],
    ]) {
      fixture.claims = patch;
      const begin = await a.begin(local);
      assert.equal(begin.status, 200, name);
      const cb = await a.callback(begin, local.cookie);
      assert.equal(cb.status, 400, name + JSON.stringify(cb.data));
    }
    fixture.claims = {};
    fixture.badSignature = true;
    assert.equal(
      (await a.callback(await a.begin(local), local.cookie)).status,
      400,
    );
    fixture.badSignature = false;
    let begin = await a.begin(local),
      body = a.code(begin.data.url);
    assert.equal(
      (
        await a.request("/api/auth/sso/callback", {
          cookie: local.cookie,
          body: { ...body, state: store.random() },
          form: true,
          csrf: false,
        })
      ).status,
      400,
    );
    const badCookie = local.cookie.replace(
      /__Host-pp_sso_browser=[^;]+/,
      `__Host-pp_sso_browser=${store.random()}`,
    );
    assert.equal(
      (
        await a.request("/api/auth/sso/callback", {
          cookie: badCookie,
          body,
          form: true,
          csrf: false,
        })
      ).status,
      400,
    );
    begin = await a.begin(local);
    body = a.code(begin.data.url);
    fixture.codes.get(body.code).challenge = "wrong-pkce";
    assert.equal(
      (
        await a.request("/api/auth/sso/callback", {
          cookie: local.cookie,
          body,
          form: true,
          csrf: false,
        })
      ).status,
      400,
    );
    begin = await a.begin(local);
    body = a.code(begin.data.url);
    assert.equal(
      (
        await a.request("/api/auth/sso/callback", {
          cookie: local.cookie,
          body,
          form: true,
          csrf: false,
        })
      ).status,
      303,
    );
    assert.equal(
      (
        await a.request("/api/auth/sso/callback", {
          cookie: local.cookie,
          body,
          form: true,
          csrf: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (await a.request("/api/auth/sso/callback", { cookie: local.cookie }))
        .status,
      404,
    );
  }));

test("G3 sudo requires the linked subject, fresh required assurance and live initiating session; SSO login never elevates", () =>
  withApp(async (a) => {
    const local = a.local();
    await a.callback(await a.begin(local), local.cookie);
    let cb = await a.callback(await a.begin(local, "test-login"), local.cookie);
    assert.equal(cb.status, 303, JSON.stringify(cb.data));
    const token = cookieValue(cb.headers, "pp_token");
    const sso = {
      cookie: `${token}; pp_csrf=csrf; ${local.cookie.split("; ").at(-1)}`,
    };
    const ctx = a.db
      .prepare("SELECT * FROM sso_session_context WHERE method='oidc'")
      .get();
    sso.id = ctx.session_id;
    assert.equal(
      a.db.prepare("SELECT sudo_until FROM sessions WHERE id=?").get(sso.id)
        .sudo_until,
      null,
    );
    assert.equal(
      (await a.request("/protected", { cookie: sso.cookie })).status,
      401,
    );
    cb = await a.callback(
      await a.begin(sso, "sudo"),
      sso.cookie,
      "different-subject",
    );
    assert.equal(cb.status, 403);
    const pending = await a.begin(sso, "sudo");
    a.db
      .prepare("UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(sso.id);
    assert.equal((await a.callback(pending, sso.cookie)).status, 403);
    const good = await a.begin(local, "sudo");
    assert.equal((await a.callback(good, local.cookie)).status, 303);
    assert.equal(
      store.activationReadiness(a.db, a.config(), "admin").checks.sudo
        .session_id,
      local.id,
    );
  }));

test("G3 passkey settings and exact client are checked read-only using 26.7.4 resident-key precedence", () =>
  withApp(async (a) => {
    assert.equal((await oidc.verifySettings(a.db, a.config())).valid, true);
    for (const policy of [
      { webAuthnPolicyPasswordlessUserVerificationRequirement: "preferred" },
      {
        webAuthnPolicyPasswordlessResidentKey: "discouraged",
        webAuthnPolicyPasswordlessRequireResidentKey: "Yes",
      },
      { webAuthnPolicyPasswordlessRpId: "unstable.example.com" },
    ]) {
      fixture.policy = policy;
      await assert.rejects(oidc.verifySettings(a.db, a.config()));
    }
    fixture.policy = {
      webAuthnPolicyPasswordlessResidentKey: "",
      webAuthnPolicyPasswordlessRequireResidentKey: "Yes",
    };
    assert.equal((await oidc.verifySettings(a.db, a.config())).valid, true);
    fixture.clients = { redirectUris: ["https://pilot.example.com/*"] };
    await assert.rejects(oidc.verifySettings(a.db, a.config()));
    assert(
      fixture.requests.every(
        (r) => r.method === "GET" || r.path.endsWith("/token"),
      ),
      "no admin API mutation",
    );
  }));

test("G3 revocation permits at most 60 seconds; disable/delete and outage deny SSO while local recovery stays valid", () =>
  withApp(async (a) => {
    const local = a.local();
    await a.callback(await a.begin(local), local.cookie);
    await a.callback(await a.begin(local, "test-login"), local.cookie);
    const ctx = a.db
      .prepare("SELECT * FROM sso_session_context WHERE method='oidc'")
      .get();
    fixture.enabled = false;
    await sessions.refreshCentralCheck(a.db, ctx.session_id, {
      now: () => ctx.checked_until - 1,
    });
    assert.equal(auth.validateSession(ctx.session_id).ok, true);
    await sessions.refreshCentralCheck(a.db, ctx.session_id, {
      now: () => ctx.checked_until,
    });
    assert.equal(auth.validateSession(ctx.session_id).ok, false);
    assert.equal(
      a.db
        .prepare("SELECT sudo_until FROM sessions WHERE id=?")
        .get(ctx.session_id).sudo_until,
      null,
    );
    fixture.enabled = true;
    await a.callback(await a.begin(local, "test-login"), local.cookie);
    const second = a.db
      .prepare(
        "SELECT * FROM sso_session_context WHERE method='oidc' ORDER BY rowid DESC",
      )
      .get();
    fixture.outage = true;
    a.db
      .prepare(
        "UPDATE sso_session_context SET checked_until=0 WHERE session_id=?",
      )
      .run(second.session_id);
    await sessions.refreshCentralCheck(a.db, second.session_id);
    assert.equal(auth.validateSession(second.session_id).ok, false);
    const recovery = a.local("admin", "recover.example.com");
    assert.equal(
      auth.validateSession(recovery.id, "https://recover.example.com").ok,
      true,
    );
    assert.equal(
      auth.validateSession(recovery.id, "https://pilot.example.com").ok,
      false,
    );
    a.db.prepare("DELETE FROM users WHERE id=?").run("admin");
    assert.equal(auth.validateSession(recovery.id).ok, false);
  }));

test("G3 activation enforces configuration-bound administrator, SSO, sudo, route and separate-browser recovery; offline disable works", () =>
  withApp(async (a) => {
    const local = a.local(),
      fp = { fingerprint: a.config().fingerprint };
    assert.equal(
      (
        await a.request("/api/setup/platform/sso/activate", {
          cookie: local.cookie,
          body: fp,
        })
      ).status,
      409,
    );
    await a.callback(await a.begin(local), local.cookie);
    await a.callback(await a.begin(local, "test-login"), local.cookie);
    await a.callback(await a.begin(local, "sudo"), local.cookie);
    const job = store.queueSsoJob(
      a.db,
      a.config(),
      "configure_recovery_route",
      "admin",
    );
    a.db
      .prepare("UPDATE setup_jobs SET status='succeeded' WHERE id=?")
      .run(job.id);
    const routeDir = mkdtempSync(join(tmpdir(), "g3-activation-route-"));
    try {
      await configureRecoveryRoute(a.db, {
        fingerprint: a.config().fingerprint,
        fence: () => {},
        render: {
          caddyFilePath: (domain) => join(routeDir, "sites", domain + ".caddy"),
          regenerate: async () => {},
          adapt: async () => {},
          reload: async () => {},
          writeConfig: async () => {},
          deleteConfig: async () => {},
        },
      });
    } finally {
      rmSync(routeDir, { recursive: true, force: true });
    }
    const check = await a.request("/api/setup/platform/sso/recovery-check", {
      cookie: local.cookie,
      body: fp,
    });
    const checkPath =
      new URL(check.data.url).pathname + new URL(check.data.url).search;
    assert.equal(
      (await a.request(checkPath, { cookie: local.cookie })).status,
      409,
    );
    const secondBrowser = `__Host-pp_sso_browser=${store.random()}`;
    const context = await a.request(checkPath, { cookie: secondBrowser });
    assert.equal(context.status, 303);
    const enterUrl = new URL(context.headers.get("location"));
    const enter = await a.request(enterUrl.pathname + enterUrl.search, {
      host: "recover.example.com",
      cookie: secondBrowser,
    });
    assert.equal(enter.status, 303);
    const recovery = a.local("admin", "recover.example.com");
    recovery.cookie = `pp_token=${recovery.token}; pp_csrf=csrf; ${secondBrowser}; ${cookieValue(enter.headers, "__Host-pp_recovery_check")}`;
    fixture.outage = true;
    const confirmed = await a.request("/api/auth/sso/recovery-confirm", {
      host: "recover.example.com",
      cookie: recovery.cookie,
      body: {},
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    fixture.outage = false;
    a.db.prepare("UPDATE service_http_routes SET ip_allowlist_json='[]'").run();
    assert.equal(
      (
        await a.request("/api/setup/platform/sso/activate", {
          cookie: local.cookie,
          body: fp,
        })
      ).status,
      409,
    );
    a.db
      .prepare("UPDATE service_http_routes SET ip_allowlist_json=?")
      .run(JSON.stringify(a.config().config.recoveryNetworks));
    assert.equal(
      (
        await a.request("/api/setup/platform/sso/activate", {
          cookie: local.cookie,
          body: fp,
        })
      ).status,
      200,
    );
    assert.equal(a.config().active, 1);
    assert.equal(
      (
        await a.request("/api/auth/sso/disable", {
          cookie: local.cookie,
          body: {},
        })
      ).status,
      401,
    );
    fixture.outage = true;
    assert.equal(
      (
        await a.request("/api/auth/sso/disable", {
          host: "recover.example.com",
          cookie: recovery.cookie,
          body: {},
        })
      ).status,
      200,
    );
    assert.equal(a.config().active, 0);
    assert.equal(auth.validateSession(recovery.id).ok, true);
    assert.equal(
      a.db
        .prepare(
          "SELECT COUNT(*) n FROM sessions WHERE id IN (SELECT session_id FROM sso_session_context WHERE method='oidc') AND revoked_at IS NULL",
        )
        .get().n,
      0,
    );
    assert.equal(
      a.db.prepare("SELECT COUNT(*) n FROM sso_evidence").get().n,
      0,
    );
  }));

test("G3 saved configuration invalidates old callback and activation evidence; jobs carry references only and resume safely", () =>
  withApp(async (a) => {
    const local = a.local(),
      begin = await a.begin(local),
      old = a.config();
    const job = store.queueSsoJob(a.db, old, "verify_sso", "admin");
    store.recordEvidence(a.db, old, "admin", "login", local.id);
    store.saveConfig(a.db, { ...input, expectedRevision: 1 }, "admin");
    assert.equal((await a.callback(begin, local.cookie)).status, 400);
    assert.equal(
      store.activationReadiness(a.db, a.config(), "admin").checks.login,
      undefined,
    );
    const result = await runBackendSteps({
      db: a.db,
      owner: "backend@g3#1:test",
      deps: {
        ssoStep: () => {
          throw new Error("must not run stale job");
        },
      },
    });
    assert.equal(result.ran[0].status, "refused");
    assert(!JSON.stringify(getJob(a.db, job.id)).includes(input.clientSecret));
    const next = store.queueSsoJob(a.db, a.config(), "verify_sso", "admin");
    await runBackendSteps({
      db: a.db,
      owner: "backend@g3#1:test",
      deps: {
        ssoStep: async () => {
          await oidc.verifySettings(a.db, a.config());
          return {};
        },
      },
    });
    assert.equal(getJob(a.db, next.id).status, "succeeded");
  }));

test("G3 Caddy recovery route reuses protected IP options, rejects collisions and has a fenced durable job", () =>
  withApp(async (a) => {
    const dir = mkdtempSync(join(tmpdir(), "g3-route-"));
    let renders = 0;
    try {
      const render = {
        caddyFilePath: (domain) => join(dir, "sites", domain + ".caddy"),
        regenerate: async (db, domain) => {
          renders++;
          const row = db
            .prepare("SELECT * FROM service_http_routes WHERE domain=?")
            .get(domain);
          assert.equal(row.ip_allowlist_json, '["10.70.0.2/32"]');
        },
        adapt: async () => {},
        reload: async () => {},
        writeConfig: async () => {},
        deleteConfig: async () => {},
      };
      const job = store.queueSsoJob(
        a.db,
        a.config(),
        "configure_recovery_route",
        "admin",
      );
      await runBackendSteps({
        db: a.db,
        owner: "backend@g3#1:test",
        deps: {
          ssoStep: ({ fingerprint, fence }) =>
            configureRecoveryRoute(a.db, { fingerprint, fence, render }),
        },
      });
      assert.equal(getJob(a.db, job.id).status, "succeeded");
      assert.equal(renders, 1);
      await configureRecoveryRoute(a.db, {
        fingerprint: a.config().fingerprint,
        render,
        fence: () => {},
      });
      assert.equal(
        a.db.prepare("SELECT COUNT(*) n FROM service_http_routes").get().n,
        1,
      );
      a.db.prepare("UPDATE services SET target_ip='192.0.2.1'").run();
      await assert.rejects(
        configureRecoveryRoute(a.db, {
          fingerprint: a.config().fingerprint,
          render,
          fence: () => {},
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

test("G3 actual local password/TOTP login and step-up work offline on recovery; trusted devices cannot skip its second factor", () =>
  withApp(async (a) => {
    fixture.outage = true;
    const before = fixture.requests.length;
    a.db
      .prepare(
        "INSERT INTO authenticated_devices(id,user_id,device_fingerprint) VALUES ('trusted','admin','known')",
      )
      .run();
    let result = await a.request("/api/auth/login", {
      host: "recover.example.com",
      body: {
        username: "admin",
        password: "local-password-fixture",
        deviceFingerprint: "known",
      },
      csrf: false,
    });
    assert.equal(result.status, 401);
    assert.equal(result.data.totpRequired, true);
    result = await a.request("/api/auth/login", {
      host: "recover.example.com",
      body: {
        username: "admin",
        password: "local-password-fixture",
        totpCode: a.totp(),
      },
      csrf: false,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert(
      result.headers
        .getSetCookie()
        .filter((x) => x.startsWith("pp_token="))
        .every((x) => !x.toLowerCase().includes("domain=")),
    );
    const cookie = result.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
    const csrf = cookieValue(result.headers, "pp_csrf").slice(
      "pp_csrf=".length,
    );
    // request helper uses a fixed CSRF token; retain its double-submit contract.
    const fixedCookie = cookie.replace(`pp_csrf=${csrf}`, "pp_csrf=csrf");
    const step = await a.request("/api/auth/sudo", {
      host: "recover.example.com",
      cookie: fixedCookie,
      body: { password: "local-password-fixture", totpCode: a.totp() },
    });
    assert.equal(step.status, 200, JSON.stringify(step.data));
    a.db
      .prepare("UPDATE setup_keycloak SET verified_at=NULL,verified_json=NULL")
      .run();
    const disable = await a.request("/api/auth/sso/disable", {
      host: "recover.example.com",
      cookie: fixedCookie,
      body: {},
    });
    assert.equal(disable.status, 200);
    assert.equal(
      fixture.requests.length,
      before,
      "recovery did not contact any IdP",
    );
    assert.equal(
      (
        await a.request("/api/auth/login", {
          host: "recover.example.com",
          body: {
            username: "user",
            password: "local-password-fixture",
            totpCode: a.totp(),
          },
          csrf: false,
        })
      ).status,
      401,
    );
    const { getRpId, getExpectedOrigins } = await import("../lib/webauthn.js");
    const req = {
      headers: { host: "recover.example.com" },
      hostname: "recover.example.com",
    };
    assert.equal(getRpId(req), "recover.example.com");
    assert.deepEqual(getExpectedOrigins(req), ["https://recover.example.com"]);
  }));

test("G3 activation closes public local-login bypass while retaining independent local recovery and credentials", () =>
  withApp(async (a) => {
    const passwordHash = a.db
      .prepare("SELECT password_hash FROM users WHERE id='admin'")
      .get().password_hash;
    a.db.prepare("UPDATE sso_config SET active=1").run();
    fixture.enabled = false;
    const publicLogin = await a.request("/api/auth/login", {
      body: {
        username: "admin",
        password: "local-password-fixture",
        totpCode: a.totp(),
      },
      csrf: false,
    });
    assert.equal(publicLogin.status, 200);
    assert.equal(publicLogin.data.user.linkOnly, true);
    const restrictedCookie = publicLogin.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
    assert.equal(
      (await a.request("/protected", { cookie: restrictedCookie })).status,
      403,
    );
    const { verifyWsUpgrade } = await import("../middleware/wsAuth.js");
    assert.throws(
      () =>
        verifyWsUpgrade({
          headers: { cookie: restrictedCookie, host: "pilot.example.com" },
        }),
      /linking/,
    );
    assert.equal(
      (await a.request("/api/setup/platform/sso", { cookie: restrictedCookie }))
        .status,
      403,
    );
    // Existing administrator-issued invitations only set a password. The normal
    // login afterwards must still mint a linking-only session after activation.
    const invitation = store.random();
    a.db
      .prepare("INSERT INTO user_login_links VALUES (?,?,?,?,NULL)")
      .run(
        "invite",
        "user",
        store.hash(invitation),
        new Date(Date.now() + 60000).toISOString(),
      );
    const invited = await a.request("/api/auth/link/complete", {
      body: { token: invitation, newPassword: "new-local-password-for-link" },
      cookie: "pp_csrf=csrf",
    });
    assert.equal(invited.status, 200, JSON.stringify(invited.data));
    assert(
      !invited.headers.getSetCookie().some((x) => x.startsWith("pp_token=")),
    );
    const invitedLogin = await a.request("/api/auth/login", {
      body: {
        username: "user",
        password: "new-local-password-for-link",
        totpCode: a.totp(),
      },
      csrf: false,
    });
    assert.equal(invitedLogin.status, 200);
    assert.equal(invitedLogin.data.user.linkOnly, true);
    const ldapSession = a.local("user");
    a.db.prepare("UPDATE users SET auth_source='ldap' WHERE id='user'").run();
    const { recordLocalSession } = await import("../lib/sso/sessions.js");
    a.db
      .prepare("DELETE FROM sso_session_context WHERE session_id=?")
      .run(ldapSession.id);
    recordLocalSession(
      a.db,
      ldapSession.token,
      { headers: { host: "pilot.example.com" } },
      a.db.prepare("SELECT * FROM users WHERE id='user'").get(),
    );
    assert.equal(
      (await a.request("/protected", { cookie: ldapSession.cookie })).status,
      403,
    );
    const recovery = await a.request("/api/auth/login", {
      host: "recover.example.com",
      body: {
        username: "admin",
        password: "local-password-fixture",
        totpCode: a.totp(),
      },
      csrf: false,
    });
    assert.equal(recovery.status, 200);
    assert.equal(
      a.db.prepare("SELECT password_hash FROM users WHERE id='admin'").get()
        .password_hash,
      passwordHash,
    );
  }));
