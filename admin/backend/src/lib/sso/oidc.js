import * as oidc from "openid-client";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { allowedAddress } from "../setup-engine/keycloak-discovery.js";
import { readCredential, fail, assertCurrent } from "./store.js";

// All server traffic stays at the reviewed G2 origin. DNS is pinned for each
// request; TLS, body/time limits and redirect refusal apply to credential POSTs
// as well as discovery/keys. Errors deliberately contain no URLs or bodies.
export function approvedFetch(
  origin,
  { resolve = lookup, request = https.request } = {},
) {
  return async (input, options = {}) => {
    const url = new URL(String(input));
    if (
      url.origin !== origin ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw fail("SSO endpoint is outside the verified Keycloak origin.");
    const addresses = await Promise.race([
      resolve(url.hostname, { all: true, family: 4 }),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(fail("SSO DNS timeout.")), 5000);
        t.unref();
      }),
    ]);
    if (!addresses.length || addresses.some((a) => !allowedAddress(a.address)))
      throw fail("SSO DNS resolves to a blocked address.");
    return new Promise((resolveResponse, reject) => {
      let size = 0;
      const chunks = [];
      const body = options.body == null ? null : String(options.body);
      const req = request(
        url,
        {
          method: options.method || "GET",
          headers: Object.fromEntries(new Headers(options.headers)),
          agent: false,
          lookup: (_host, opts, cb) =>
            opts.all
              ? cb(null, [addresses[0]])
              : cb(null, addresses[0].address, 4),
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400) {
            res.resume();
            req.destroy();
            reject(fail("SSO redirects are refused."));
            return;
          }
          res.on("data", (b) => {
            size += b.length;
            if (size > 2 * 1024 * 1024)
              req.destroy(new Error("SSO response too large"));
            else chunks.push(b);
          });
          res.on("end", () =>
            resolveResponse(
              new Response([204, 205, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          );
          res.on("error", () => reject(fail("SSO response failed.")));
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error("SSO request timeout")),
        7000,
      );
      timer.unref();
      req.on("close", () => clearTimeout(timer));
      req.on("error", () => reject(fail("SSO HTTPS request failed.")));
      if (body) req.write(body);
      req.end();
    });
  };
}
export function oidcConfiguration(db, r, { fetchImpl, reader = false } = {}) {
  const c = r.config,
    base = `${c.issuer}/protocol/openid-connect`;
  const config = new oidc.Configuration(
    {
      issuer: c.issuer,
      authorization_endpoint: `${base}/auth`,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/certs`,
      response_types_supported: ["code"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    },
    reader ? c.readerClientId : c.clientId,
    {
      client_secret: readCredential(
        db,
        reader ? c.readerSecretRef : c.clientSecretRef,
      ),
      id_token_signed_response_alg: "RS256",
    },
    oidc.ClientSecretPost(),
  );
  config[oidc.customFetch] = fetchImpl || approvedFetch(c.keycloakOrigin);
  config.timeout = 10;
  oidc.enableNonRepudiationChecks(config);
  return config;
}
export async function authorizationUrl(db, r, flow, deps = {}) {
  const config = oidcConfiguration(db, r, deps);
  return oidc.buildAuthorizationUrl(config, {
    redirect_uri: r.config.redirectUri,
    response_type: "code",
    response_mode: "form_post",
    scope: "openid",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
    code_challenge_method: "S256",
    prompt: "login",
    max_age: "0",
    acr_values: r.config.requiredAcr,
  }).href;
}
export async function exchange(db, r, flow, url, deps = {}) {
  const tokens = await oidc.authorizationCodeGrant(
    oidcConfiguration(db, r, deps),
    url,
    {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      maxAge: 120,
      idTokenExpected: true,
    },
  );
  const claims = tokens.claims();
  if (
    !claims ||
    claims.iss !== r.config.issuer ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.sub.length > 255
  )
    throw fail("Invalid SSO identity.");
  const now = Date.now() / 1000;
  // prompt=login is a request; signed auth_time/ACR plus the verified passkey-only
  // client flow is the proof. Existing Keycloak cookies alone cannot pass.
  if (
    !Number.isFinite(claims.auth_time) ||
    claims.auth_time < flow.startedAt / 1000 - 5 ||
    now - claims.auth_time > 120 ||
    claims.auth_time > now + 5 ||
    claims.acr !== r.config.requiredAcr
  )
    throw fail(
      "Keycloak did not prove fresh authentication at the required assurance.",
      400,
    );
  return {
    issuer: claims.iss,
    subject: claims.sub,
    authTime: claims.auth_time,
    acr: claims.acr,
  };
}
export async function reader(db, r, deps = {}) {
  const config = oidcConfiguration(db, r, { ...deps, reader: true });
  const result = await oidc.clientCredentialsGrant(config);
  const fetchImpl = deps.fetchImpl || approvedFetch(r.config.keycloakOrigin);
  return async (path) => {
    const response = await fetchImpl(
      `${r.config.keycloakOrigin}/admin/realms/${encodeURIComponent(r.config.realm)}${path}`,
      {
        headers: {
          Authorization: `Bearer ${result.access_token}`,
          Accept: "application/json",
        },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw fail(
        "Read-only Keycloak observer access failed. Check its realm permissions and credential.",
      );
    return response.json();
  };
}
export async function accountEnabled(db, r, subject, deps = {}) {
  const get = await reader(db, r, deps);
  const user = await get(`/users/${encodeURIComponent(subject)}`);
  return !!user && user.id === subject && user.enabled === true;
}
export function validateRealmSettings(c, realm, client, executions, actions) {
  const issues = [];
  if (!realm || realm.realm !== c.realm || realm.enabled !== true)
    issues.push("Realm must be enabled and match the verified connection.");
  if (
    realm?.webAuthnPolicyPasswordlessRpId !== new URL(c.keycloakOrigin).hostname
  )
    issues.push("Set the passwordless RP ID to the stable Keycloak hostname.");
  if (
    realm?.webAuthnPolicyPasswordlessUserVerificationRequirement !== "required"
  )
    issues.push("Set passwordless user verification to required.");
  // 26.7.4 uses the residentKey field; retain its documented deprecated
  // fallback only when the replacement was not configured.
  const resident = realm?.webAuthnPolicyPasswordlessResidentKey;
  if (
    resident
      ? resident !== "required"
      : realm?.webAuthnPolicyPasswordlessRequireResidentKey !== "Yes"
  )
    issues.push("Set passwordless discoverable credentials to required.");
  if (
    !actions?.some(
      (a) => a.alias === "webauthn-register-passwordless" && a.enabled === true,
    )
  )
    issues.push("Enable WebAuthn Register Passwordless.");
  if (
    !client ||
    client.clientId !== c.clientId ||
    client.protocol !== "openid-connect" ||
    !client.enabled ||
    client.publicClient ||
    client.bearerOnly ||
    !client.standardFlowEnabled ||
    client.implicitFlowEnabled ||
    client.directAccessGrantsEnabled ||
    client.serviceAccountsEnabled
  )
    issues.push(
      "Use a dedicated confidential authorization-code client; disable implicit, direct grants and service accounts.",
    );
  if (JSON.stringify(client?.redirectUris) !== JSON.stringify([c.redirectUri]))
    issues.push(
      "Configure only the exact ProxyPilot callback URL; no wildcard redirects.",
    );
  if (client?.attributes?.["pkce.code.challenge.method"] !== "S256")
    issues.push("Require S256 PKCE for the ProxyPilot client.");
  if (
    client?.attributes?.["id.token.signed.response.alg"] &&
    client.attributes["id.token.signed.response.alg"] !== "RS256"
  )
    issues.push("Use RS256 signed ID tokens.");
  const enabled = (executions || []).filter(
    (e) => e.requirement !== "DISABLED",
  );
  if (
    !client?.authenticationFlowBindingOverrides?.browser ||
    enabled.length !== 1 ||
    enabled[0].providerId !== "webauthn-authenticator-passwordless" ||
    enabled[0].requirement !== "REQUIRED" ||
    enabled[0].authenticationFlow
  )
    issues.push(
      "Bind this client to a dedicated loginless flow with one REQUIRED WebAuthn Passwordless execution. No Cookie or alternative password execution.",
    );
  return issues;
}
export async function verifySettings(db, r, deps = {}) {
  const get = await reader(db, r, deps);
  const realm = await get("");
  const clients = await get(
    `/clients?clientId=${encodeURIComponent(r.config.clientId)}`,
  );
  const client = clients?.find((c) => c.clientId === r.config.clientId);
  const flows = await get("/authentication/flows");
  const flow = flows?.find(
    (f) => f.id === client?.authenticationFlowBindingOverrides?.browser,
  );
  const executions = flow
    ? await get(
        `/authentication/flows/${encodeURIComponent(flow.alias)}/executions`,
      )
    : [];
  const actions = await get("/authentication/required-actions");
  const issues = validateRealmSettings(
    r.config,
    realm,
    client,
    executions,
    actions,
  );
  deps.fence?.();
  assertCurrent(db, r.fingerprint);
  const result = {
    valid: issues.length === 0,
    issues,
    keycloakVersion: r.config.keycloakVersion,
    client: !!client,
    passkeyFlow: flow?.alias || null,
    checkedAt: new Date().toISOString(),
    policy: "read-only; no realm or client mutation",
  };
  db.prepare(
    "UPDATE sso_config SET verified_json=?,verified_at=? WHERE id=1 AND fingerprint=?",
  ).run(
    JSON.stringify(result),
    result.valid ? result.checkedAt : null,
    r.fingerprint,
  );
  if (!result.valid) throw fail(issues.join(" "));
  return result;
}
