import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { requestSudo } from "@/lib/sudo";
import { reauthenticateSso } from "@/lib/sso";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const initial = {
  connectionId: "",
  publicOrigin: window.location.origin,
  recoveryOrigin: "",
  clientId: "proxypilot",
  readerClientId: "proxypilot-observer",
  clientSecret: "",
  readerSecret: "",
  requiredAcr: "1",
  recoveryNetworks: "",
  keycloakVersion: "26.7.4",
  roleMapping: "local-only",
};
const fields = [
  ["publicOrigin", "ProxyPilot HTTPS origin"],
  ["recoveryOrigin", "Local recovery HTTPS origin"],
  ["clientId", "Dedicated ProxyPilot client ID"],
  ["clientSecret", "ProxyPilot client secret"],
  ["readerClientId", "Read-only observer client ID"],
  ["readerSecret", "Observer client secret"],
  ["requiredAcr", "Required signed ACR value"],
  [
    "recoveryNetworks",
    "Existing administrator / WireGuard IPs or CIDRs (comma separated)",
  ],
];
export default function SsoSetup({ connections = [] }) {
  const [state, setState] = useState(null),
    [form, setForm] = useState(initial),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [recoveryUrl, setRecoveryUrl] = useState("");
  async function load(reset = false) {
    const next = await api.getSsoSetup();
    setState(next);
    if (reset && next.config)
      setForm({
        ...Object.fromEntries(
          Object.keys(initial).map((k) => [k, next.config[k] ?? initial[k]]),
        ),
        clientSecret: "",
        readerSecret: "",
        recoveryNetworks: next.config.recoveryNetworks.join(", "),
      });
  }
  useEffect(() => {
    load(true).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!state?.job && !state?.routeJob) return;
    const timer = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [state?.job?.id, state?.routeJob?.id]);
  async function run(name, fn) {
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  const fp = { fingerprint: state?.fingerprint };
  const verified = connections.filter(
    (c) => c.verifiedAt && c.verification?.issuerExact,
  );
  const config = state?.config;
  const client = {
    clientId: form.clientId,
    protocol: "openid-connect",
    enabled: true,
    publicClient: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: [`${form.publicOrigin}/api/auth/sso/callback`],
    webOrigins: [],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "id.token.signed.response.alg": "RS256",
    },
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>ProxyPilot SSO, passkeys & recovery</CardTitle>
        <CardDescription>
          {state?.active
            ? "SSO is active. Local administrator sign-in is available on the restricted recovery hostname."
            : "Local sign-in remains available throughout setup. Activation is a separate action."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 min-w-0">
        {error && (
          <p role="alert" className="text-destructive break-words">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="break-words">
            {notice}
          </p>
        )}
        {!verified.length && (
          <p>
            First verify a Keycloak connection above, then refresh this page.
          </p>
        )}
        <fieldset
          disabled={!!busy || state?.active}
          className="space-y-4 min-w-0"
        >
          <legend className="font-semibold mb-3">
            1. Configure the dedicated client
          </legend>
          <p className="text-sm text-muted-foreground">
            Supported settings: Keycloak 26.7.4. Confirm this is the installed
            version. The realm administrator creates the client and a separate
            confidential observer with service accounts enabled and view-realm,
            view-clients and view-users access. ProxyPilot reads these settings;
            it never changes external realm policies.
          </p>
          <div className="space-y-2">
            <Label htmlFor="sso-connection">Verified Keycloak connection</Label>
            <select
              id="sso-connection"
              className="w-full min-h-11 rounded border bg-background px-3"
              value={form.connectionId}
              onChange={(e) =>
                setForm({ ...form, connectionId: e.target.value })
              }
            >
              <option value="">Choose a connection</option>
              {verified.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.origin} · {c.realm}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {fields.map(([key, label]) => (
              <div key={key} className="space-y-2 min-w-0">
                <Label htmlFor={`sso-${key}`}>{label}</Label>
                <Input
                  id={`sso-${key}`}
                  type={key.endsWith("Secret") ? "password" : "text"}
                  autoComplete={key.endsWith("Secret") ? "new-password" : "off"}
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  placeholder={
                    key.endsWith("Secret") && state?.configured
                      ? "Leave blank to retain saved credential"
                      : ""
                  }
                />
              </div>
            ))}
          </div>
          <p className="text-sm">
            Recovery uses the existing Caddy source-IP allowlist. Enter the
            administrator network or enabled admin/full WireGuard peer IPs you
            already use. The backend port must remain private. DNS and TLS must
            serve this stable hostname.
          </p>
          <details className="rounded border p-3">
            <summary className="cursor-pointer min-h-11">
              Client import configuration and passkey settings
            </summary>
            <pre className="text-xs whitespace-pre-wrap break-all mt-3">
              {JSON.stringify(client, null, 2)}
            </pre>
            <ol className="list-decimal pl-5 mt-4 space-y-2 text-sm">
              <li>
                Import the dedicated client in the selected realm and copy its
                secret. Keep the exact callback above; do not add wildcard
                redirects.
              </li>
              <li>
                Under Authentication → Policies → WebAuthn Passwordless Policy,
                set RP ID to the Keycloak hostname, User Verification to
                required and Discoverable Credential to required.
              </li>
              <li>
                Enable WebAuthn Register Passwordless. Create a dedicated
                loginless flow with one REQUIRED WebAuthn Passwordless
                execution, and select it as this client’s Browser Flow override.
                It must contain no Cookie or alternative password execution.
              </li>
              <li>
                Ensure the signed ACR claim matches the value above (normally 1
                for this single required passkey flow). ProxyPilot verifies both
                this assurance value and fresh auth_time.
              </li>
            </ol>
          </details>
          <p className="text-sm">
            Access mapping: existing local roles only. No email linking,
            role/group imports or automatic administrator grants. Unlinked
            Keycloak identities remain pending with no session.
          </p>
          <Button
            className="min-h-11 bg-foreground text-background hover:bg-foreground/90"
            onClick={() =>
              run("save", async () => {
                const { clientSecret, readerSecret, ...rest } = form;
                await api.saveSsoSetup({
                  ...rest,
                  clientSecret: clientSecret || undefined,
                  readerSecret: readerSecret || undefined,
                  recoveryNetworks: form.recoveryNetworks
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                  expectedRevision: state?.revision || 0,
                  reviewed: true,
                });
                setForm((p) => ({ ...p, clientSecret: "", readerSecret: "" }));
                setNotice(
                  "Saved. Repeat the checks for this revision before activation.",
                );
              })
            }
            disabled={!form.connectionId}
          >
            Save SSO configuration
          </Button>
        </fieldset>
        {config && (
          <>
            <section className="space-y-3">
              <h3 className="font-semibold">
                2. Verify settings and prepare recovery
              </h3>
              <div className="flex flex-col sm:flex-row flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={!!busy}
                  onClick={() =>
                    run("verify", () => api.ssoSetupAction("verify", fp))
                  }
                >
                  Verify client & passkey settings
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={!!busy}
                  onClick={() =>
                    run("route", () => api.ssoSetupAction("recovery-route", fp))
                  }
                >
                  Apply restricted recovery route
                </Button>
              </div>
              <p className="text-sm break-words">
                Settings:{" "}
                {state.verification?.valid
                  ? "verified"
                  : state.job?.status || "not verified"}{" "}
                · Recovery route: {state.routeJob?.status || "not configured"}
              </p>
              {state.verification?.issues?.map((x) => (
                <p key={x} className="text-sm text-destructive">
                  {x}
                </p>
              ))}
              {state.job?.reason && (
                <p className="text-sm break-words">{state.job.reason}</p>
              )}
              {state.routeJob?.reason && (
                <p className="text-sm break-words">{state.routeJob.reason}</p>
              )}
            </section>
            <section className="space-y-3">
              <h3 className="font-semibold">3. Enroll, link and test</h3>
              <p className="text-sm">
                Enroll a Keycloak passkey in its account console first.
                ProxyPilot passkeys remain local; they are not transferred.
                Linking asks you to prove your local password + TOTP or local
                passkey, then sign in to Keycloak.
              </p>
              <div className="flex flex-col sm:flex-row flex-wrap gap-2">
                <a
                  className="inline-flex items-center justify-center rounded border min-h-11 px-4 text-sm"
                  href={`${config.issuer}/account/#/security/signingin`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Enroll in Keycloak
                </a>
                <Button
                  className="min-h-11 bg-foreground text-background hover:bg-foreground/90"
                  disabled={!!busy}
                  onClick={() =>
                    run("link", async () => {
                      await requestSudo({ localOnly: true });
                      const { url } = await api.beginSso({
                        action: "link",
                        confirmLink: true,
                      });
                      window.location.assign(url);
                    })
                  }
                >
                  Link my existing account
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={!!busy}
                  onClick={() =>
                    run("login", async () => {
                      const { url } = await api.beginSso({
                        action: "test-login",
                      });
                      window.location.assign(url);
                    })
                  }
                >
                  Test passkey SSO login
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={!!busy}
                  onClick={() => run("sudo", reauthenticateSso)}
                >
                  Test Keycloak step-up
                </Button>
              </div>
            </section>
            <section className="space-y-3">
              <h3 className="font-semibold">
                4. Check local recovery in another browser
              </h3>
              <p className="text-sm break-words">
                Use {config.recoveryOrigin} with local password + TOTP, or a
                separately enrolled local passkey (RP ID: {config.recoveryRpId}
                ). If needed, use the existing host command{" "}
                <code>
                  sudo proxypilot recover admin &lt;username&gt; --password
                </code>
                .
              </p>
              <Button
                className="min-h-11 bg-foreground text-background hover:bg-foreground/90"
                variant="outline"
                disabled={!!busy}
                onClick={() =>
                  run("recovery", async () => {
                    const result = await api.ssoSetupAction(
                      "recovery-check",
                      fp,
                    );
                    setRecoveryUrl(result.url);
                  })
                }
              >
                Create separate-browser recovery check
              </Button>
              {recoveryUrl && (
                <div className="space-y-2">
                  <Label htmlFor="recovery-check-url">
                    Copy into a separate browser or private profile (valid for
                    15 minutes)
                  </Label>
                  <Input
                    id="recovery-check-url"
                    readOnly
                    value={recoveryUrl}
                    onFocus={(e) => e.target.select()}
                  />
                </div>
              )}
            </section>
            <section className="space-y-3">
              <h3 className="font-semibold">5. Explicitly activate SSO</h3>
              <p className="text-sm">
                Activation closes public local sign-in and its existing
                sessions. Local credentials remain on the restricted recovery
                hostname. Checks must belong to this saved configuration and
                administrator. Login, step-up and recovery evidence expire after
                one hour. Central account checks expire after 60 seconds; SSO
                then fails closed during an IdP outage. Local recovery stays
                independent.
              </p>
              <p role="status" className="text-sm">
                {state.readiness?.ready
                  ? "All activation checks recorded."
                  : `Still needed: ${state.readiness?.missing?.join(", ") || "checks"}`}
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  className="min-h-11 bg-foreground text-background hover:bg-foreground/90"
                  disabled={!!busy || !state.readiness?.ready || state.active}
                  onClick={() =>
                    run("activate", () => api.ssoSetupAction("activate", fp))
                  }
                >
                  {state.active ? "SSO active" : "Activate SSO"}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => run("refresh", () => load())}
                >
                  Refresh check results
                </Button>
                <a
                  href={`${config.recoveryOrigin}/local-recovery`}
                  className="inline-flex items-center justify-center rounded border min-h-11 px-4 text-sm"
                >
                  Open local recovery
                </a>
              </div>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
