import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { requestSudo } from "@/lib/sudo";
import { Button } from "@/components/ui/button";
export default function AccountSso() {
  const [status, setStatus] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    api
      .ssoStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);
  if (!status?.enabled && !status?.recovery) return null;
  return (
    <section className="rounded-lg border p-4 space-y-3">
      <h2 className="font-semibold">Keycloak and local recovery</h2>
      <p className="text-sm">
        Your local passkeys stay here. Enroll separately in Keycloak. Linking
        requires proof of both accounts and preserves your local role.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {status.recovery ? (
        <a
          href="/local-recovery"
          className="underline inline-flex items-center min-h-11"
        >
          Open local recovery controls
        </a>
      ) : (
        <Button
          className="min-h-11 bg-foreground text-background hover:bg-foreground/90"
          onClick={async () => {
            try {
              await requestSudo({ localOnly: true });
              const { url } = await api.beginSso({
                action: "link",
                confirmLink: true,
              });
              window.location.assign(url);
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          Link my local account to Keycloak
        </Button>
      )}
    </section>
  );
}
