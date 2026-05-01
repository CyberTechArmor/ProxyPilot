// Frontend passkey wrapper. Sits between @simplewebauthn/browser and
// our /auth/passkey/* endpoints, so React components don't need to
// know the WebAuthn ceremony — they just call register() / authenticate()
// / sudo() and get back { ok, code, message } envelopes.
//
// Returns:
//   { ok: true, ...payload } on success
//   { ok: false, code, message } on failure, where `code` is one of:
//     - 'UNSUPPORTED'      — browser has no PublicKeyCredential
//     - 'CANCELLED'        — user dismissed the OS prompt
//     - 'BEGIN_FAILED'     — backend /begin returned a non-2xx
//     - 'CEREMONY_FAILED'  — startRegistration/Authentication threw
//     - 'VERIFY_FAILED'    — backend /verify returned a non-2xx

import {
  startRegistration,
  startAuthentication,
} from '@simplewebauthn/browser';
import { api } from './api';

export function isPasskeySupported() {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential === 'function';
}

function fail(code, message) {
  return { ok: false, code, message };
}

function isCancellation(err) {
  // SimpleWebAuthn surfaces user cancellation as a NotAllowedError DOMException.
  // Some browsers throw an InvalidStateError when the user picks an
  // already-registered credential; treat that as a cancel-equivalent so
  // the UI can show "Already registered" instead of a hard error.
  const name = err?.name || '';
  return name === 'NotAllowedError' || name === 'AbortError';
}

export async function registerPasskey({ label } = {}) {
  if (!isPasskeySupported()) {
    return fail('UNSUPPORTED', 'Passkeys are not supported on this browser.');
  }

  let options;
  try {
    options = await api.passkeyRegisterBegin();
  } catch (err) {
    return fail('BEGIN_FAILED', err?.message || 'Could not start registration');
  }

  let attResp;
  try {
    attResp = await startRegistration({ optionsJSON: options });
  } catch (err) {
    if (isCancellation(err)) return fail('CANCELLED', 'Registration cancelled.');
    return fail('CEREMONY_FAILED', err?.message || 'Browser refused to create credential');
  }

  try {
    const result = await api.passkeyRegisterVerify({ response: attResp, label });
    return { ok: true, ...result };
  } catch (err) {
    return fail('VERIFY_FAILED', err?.message || 'Server rejected the new passkey');
  }
}

// Login-style passkey use. Returns { ok: true, user, token } on success.
export async function authenticateWithPasskey({ username, registerDevice } = {}) {
  if (!isPasskeySupported()) {
    return fail('UNSUPPORTED', 'Passkeys are not supported on this browser.');
  }

  let options;
  try {
    options = await api.passkeyAuthBegin({ username });
  } catch (err) {
    return fail('BEGIN_FAILED', err?.message || 'Could not start authentication');
  }

  const challengeId = options.challengeId;

  let assertion;
  try {
    assertion = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    if (isCancellation(err)) return fail('CANCELLED', 'Sign-in cancelled.');
    return fail('CEREMONY_FAILED', err?.message || 'Browser could not retrieve credential');
  }

  try {
    const result = await api.passkeyAuthVerify({ challengeId, response: assertion, registerDevice });
    return { ok: true, ...result };
  } catch (err) {
    return fail('VERIFY_FAILED', err?.message || 'Server rejected the assertion');
  }
}

// Sudo re-auth via passkey. Caller is already logged in. Returns
// { ok: true, sudoUntil } on success.
export async function sudoWithPasskey() {
  if (!isPasskeySupported()) {
    return fail('UNSUPPORTED', 'Passkeys are not supported on this browser.');
  }

  let options;
  try {
    options = await api.sudoPasskeyBegin();
  } catch (err) {
    return fail('BEGIN_FAILED', err?.message || 'Could not start sudo');
  }

  let assertion;
  try {
    assertion = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    if (isCancellation(err)) return fail('CANCELLED', 'Sudo cancelled.');
    return fail('CEREMONY_FAILED', err?.message || 'Browser could not retrieve credential');
  }

  try {
    const result = await api.sudoPasskeyVerify({ response: assertion });
    return { ok: true, ...result };
  } catch (err) {
    return fail('VERIFY_FAILED', err?.message || 'Sudo passkey verification failed');
  }
}

// Per-action passkey confirmation. Used inside destructive dialogs
// that historically asked for a TOTP code. Returns the raw
// PublicKeyCredential JSON ready to drop into the request body as
// `passkeyAssertion`, OR an error envelope. The destructive endpoint
// re-verifies the assertion server-side against a fresh challenge
// from /user/passkey/challenge.
export async function getActionAssertion() {
  if (!isPasskeySupported()) {
    return fail('UNSUPPORTED', 'Passkeys are not supported on this browser.');
  }

  let options;
  try {
    options = await api.passkeyChallengeForAction();
  } catch (err) {
    return fail('BEGIN_FAILED', err?.message || 'Could not get challenge');
  }

  let assertion;
  try {
    assertion = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    if (isCancellation(err)) return fail('CANCELLED', 'Passkey cancelled.');
    return fail('CEREMONY_FAILED', err?.message || 'Browser could not retrieve credential');
  }

  return { ok: true, assertion: { challengeId: options.challengeId, response: assertion } };
}

// Lightweight browser fingerprint for default passkey labels. Falls
// back to "this device" if we can't recognise the UA.
export function defaultPasskeyLabel() {
  const ua = navigator.userAgent || '';
  let browser = 'Browser';
  if (/Firefox/.test(ua)) browser = 'Firefox';
  else if (/Edg/.test(ua)) browser = 'Edge';
  else if (/Chrome/.test(ua)) browser = 'Chrome';
  else if (/Safari/.test(ua)) browser = 'Safari';
  let os = 'this device';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  return `Passkey on ${browser} / ${os}`;
}
