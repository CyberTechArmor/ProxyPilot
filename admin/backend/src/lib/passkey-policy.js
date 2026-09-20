// Passkey assurance policy — the ONE place that says what a ProxyPilot passkey
// ceremony has to prove. Pure (no DB, no @simplewebauthn import) so it can be
// unit-tested in the sandbox and imported by both the WebAuthn helper and the
// auth router without either drifting from the other.
//
// Why "required" and not "preferred" (the 2026-09 immediate-repairs review):
// a passkey assertion is ProxyPilot's PASSWORDLESS login — no password, no
// TOTP afterwards. With user verification merely preferred, an authenticator
// that skipped its PIN / biometric check still produced a session, so
// possession of an unlocked device was the whole factor. Requesting
// `userVerification: 'required'` in the browser options is only half of the
// fix: the backend must also verify the signed UV flag in the assertion and
// attestation (`requireUserVerification: true` on both SimpleWebAuthn
// verify calls), or a client that ignores the request still gets in.
//
// residentKey stays 'preferred': discoverability is what lets the sign-in
// page offer a username-free passkey prompt; it is not an assurance property.

export const PASSKEY_USER_VERIFICATION = 'required';
export const PASSKEY_RESIDENT_KEY = 'preferred';
// The server-side counterpart of PASSKEY_USER_VERIFICATION. Passed as
// `requireUserVerification` to BOTH verifyRegistrationResponse and
// verifyAuthenticationResponse.
export const PASSKEY_REQUIRE_UV = true;

// authenticatorSelection for generateRegistrationOptions.
export function passkeyAuthenticatorSelection() {
  return { residentKey: PASSKEY_RESIDENT_KEY, userVerification: PASSKEY_USER_VERIFICATION };
}

// The audit reason recorded when a ceremony fails ONLY because the
// authenticator did not perform user verification.
export const USER_VERIFICATION_REASON = 'user_verification_required';

// The operator-facing message for that failure. Generic "verification
// failed" hides the one thing the person can act on: re-enrol with an
// authenticator that asks for a PIN, fingerprint or face.
export const USER_VERIFICATION_ERROR =
  'Your authenticator did not verify you with a PIN or biometric. ProxyPilot passkeys require user verification — use an authenticator that asks for a PIN, fingerprint or face, or enrol this passkey again on one that does.';

// classifyWebAuthnFailure(message) → USER_VERIFICATION_REASON when the
// SimpleWebAuthn error is the UV refusal ("User verification required, but
// user could not be verified"), else null. Matched loosely on purpose: the
// library's wording has moved between majors and the point is to keep the
// audit row and the UI hint honest, not to depend on one string.
export function classifyWebAuthnFailure(message) {
  const m = String(message || '');
  return /user\s+verification/i.test(m) ? USER_VERIFICATION_REASON : null;
}
