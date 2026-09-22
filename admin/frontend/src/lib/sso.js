import { api } from "./api";
// Uses a popup so the existing sudo modal can replay the original gated action.
// Poll server evidence: opener messages or an existing grant are not proof.
export async function reauthenticateSso() {
  const popup = window.open(
    "about:blank",
    "proxypilot-step-up",
    "popup,width=600,height=760",
  );
  if (!popup) throw new Error("Allow this sign-in popup, then try again.");
  const started = Date.now();
  try {
    const { url } = await api.beginSso({ action: "sudo" });
    popup.location.href = url;
    while (Date.now() - started < 5 * 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const state = await api.ssoSession();
      if (state.lastSsoProofAt >= started) return;
    }
    throw new Error("Keycloak reauthentication timed out. Try again.");
  } finally {
    popup.close();
  }
}
