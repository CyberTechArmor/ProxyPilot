import { fail, uuid } from "./schema.mjs";
/** Caller supplies distinct AppRole credentials; these closures never reach policy DB or projections. */
export function createOpenBaoClient({
  transport,
  roleId,
  secretId,
  mount = "fractionate-broker-kv",
  clock = () => Date.now(),
  canWrite = false,
}) {
  if (
    !/^[a-z0-9-]+$/.test(mount) ||
    typeof roleId !== "string" ||
    typeof secretId !== "string"
  )
    fail("INVALID_REQUEST");
  let token = null,
    expires = 0;
  const login = async () => {
    if (token && expires > clock() + 1000) return token;
    token = null;
    const r = await transport("POST", "/v1/auth/approle/login", {
      body: { role_id: roleId, secret_id: secretId },
    });
    if (
      typeof r.auth?.client_token !== "string" ||
      !Number.isFinite(r.auth.lease_duration) ||
      r.auth.lease_duration <= 1 ||
      r.auth.policies?.includes("root")
    )
      fail("BROKER_UNAVAILABLE", 503);
    token = r.auth.client_token;
    expires = clock() + Math.min(r.auth.lease_duration, 300) * 1000;
    return token;
  };
  const path = (p) => {
    const m = /^owners\/([^/]+)\/credentials\/([^/]+)$/.exec(p);
    if (!m) fail("INVALID_REQUEST");
    uuid(m[1]);
    uuid(m[2]);
    return `/v1/${mount}/data/${p}`;
  };
  return {
    async read(p, version) {
      if (!Number.isSafeInteger(version) || version < 1)
        fail("INVALID_REQUEST");
      const headers = { "X-Vault-Token": await login() };
      const metadata = await transport(
        "GET",
        path(p).replace("/data/", "/metadata/"),
        { headers },
      );
      if (
        metadata.data?.current_version !== version ||
        metadata.data?.versions?.[version]?.destroyed ||
        metadata.data?.versions?.[version]?.deletion_time
      )
        fail("CREDENTIAL_VERSION_STALE", 409);
      const r = await transport("GET", path(p) + `?version=${version}`, {
        headers,
      });
      if (
        r.data?.metadata?.version !== version ||
        typeof r.data?.data?.value !== "string" ||
        typeof r.data?.data?.intent !== "string"
      )
        fail("BROKER_UNAVAILABLE", 503);
      return { value: r.data.data.value, intent: r.data.data.intent, version };
    },
    async write(p, value, { cas, intent, beforeSend }) {
      if (!canWrite) fail("NOT_PERMITTED", 403);
      if (!Number.isSafeInteger(cas) || cas < 0 || typeof value !== "string")
        fail("INVALID_REQUEST");
      uuid(intent);
      const r = await transport("POST", path(p), {
        headers: { "X-Vault-Token": await login() },
        body: { options: { cas }, data: { value, intent } },
        beforeSend,
      });
      if (r.data?.version !== cas + 1) fail("BROKER_UNAVAILABLE", 503);
      return { version: r.data.version };
    },
    forget() {
      token = null;
      expires = 0;
    },
  };
}
export function splitVault({ reader, enroller }) {
  return {
    read: (...args) => reader.read(...args),
    write: (...args) => enroller.write(...args),
  };
}
