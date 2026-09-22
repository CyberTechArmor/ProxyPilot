import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { requestSudo } from "@/lib/sudo";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
export default function LocalRecovery() {
  const [status, setStatus] = useState(null),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .ssoStatus()
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, []);
  async function act(kind) {
    setBusy(true);
    setError("");
    try {
      await requestSudo({ localOnly: true });
      const result = await api.ssoRecoveryAction(kind);
      setMessage(
        result.message ||
          "SSO disabled. Your local credentials and this recovery session remain available.",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Local administrator recovery</CardTitle>
        <CardDescription>
          Uses your local credentials and the existing root recovery command.
          Keycloak is not contacted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {status && !status.recovery ? (
          <p>
            Open the restricted recovery hostname:{" "}
            <a
              className="underline break-all"
              href={`${status.recoveryOrigin}/local-recovery`}
            >
              {status.recoveryOrigin}
            </a>
          </p>
        ) : (
          <>
            <p className="text-sm">
              Confirm with local password + TOTP or a passkey enrolled
              separately on this hostname. If locked out, run{" "}
              <code>
                sudo proxypilot recover admin &lt;username&gt; --password
              </code>{" "}
              on the host.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <Button
                className="min-h-11 bg-foreground text-background hover:bg-foreground/90"
                disabled={busy || !status}
                onClick={() => act("recovery-confirm")}
              >
                Confirm separate-browser recovery
              </Button>
              <Button
                className="min-h-11 bg-red-700 text-white hover:bg-red-800"
                variant="destructive"
                disabled={busy || !status}
                onClick={() => act("disable")}
              >
                Disable SSO
              </Button>
              <a
                className="inline-flex items-center justify-center rounded border px-4 min-h-11 text-sm"
                href="/profile"
              >
                Enroll a local recovery passkey
              </a>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
export function SsoComplete() {
  return (
    <main className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Reauthentication complete</h1>
      <p>
        Return to your original window. Its pending action will continue after
        server verification.
      </p>
      <Button
        className="min-h-11 bg-foreground text-background hover:bg-foreground/90"
        onClick={() => window.close()}
      >
        Close this window
      </Button>
    </main>
  );
}
