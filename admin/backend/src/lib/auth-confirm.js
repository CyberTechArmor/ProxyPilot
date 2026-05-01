// Shared "confirm this destructive action" verifier. Accepts EITHER a
// fresh 6-digit TOTP code OR a fresh passkey assertion (single-use,
// 5-minute TTL challenge from /user/passkey/challenge). Returns
// { ok: true, factor } on success or { ok: false, error } on failure.
//
// Audit logging is handled by the verifier itself — every failure
// records a CONFIRM_FAILED row keyed to the user, so a brute-force
// attempt against the destructive-action TOTP shows up the same way
// LOGIN_FAILED rows do.
import * as OTPAuth from 'otpauth';
import { logAudit } from '../db.js';
import { decryptSecret } from './secrets.js';
import {
  verifyAssertion,
  takeChallenge,
  getRpId,
  getExpectedOrigins,
  getCredentialById,
  updateCredentialCounter,
} from './webauthn.js';

export async function verifyConfirmationFactor({ req, user, totpCode, passkeyAssertion }) {
  // Passkey takes priority when present — it's the stronger factor.
  if (passkeyAssertion) {
    const entry = takeChallenge(`act:${passkeyAssertion.challengeId}`);
    if (!entry || entry.userId !== user.id) {
      return { ok: false, error: 'Passkey challenge expired. Try again.' };
    }
    const credentialId = passkeyAssertion.response?.id;
    if (!credentialId) return { ok: false, error: 'Assertion missing credential id' };
    const stored = getCredentialById(credentialId);
    if (!stored || stored.user_id !== user.id) {
      logAudit(user.id, 'CONFIRM_FAILED', 'user', user.id, { reason: 'unknown_passkey' }, req.ip);
      return { ok: false, error: 'Unknown credential' };
    }
    const result = await verifyAssertion({
      response: passkeyAssertion.response,
      expectedChallenge: entry.challenge,
      expectedOrigins: getExpectedOrigins(req),
      expectedRPID: getRpId(req),
      credential: stored,
    });
    if (!result.ok) {
      logAudit(user.id, 'CONFIRM_FAILED', 'user', user.id, { factor: 'passkey', reason: result.reason }, req.ip);
      return { ok: false, error: 'Passkey verification failed' };
    }
    updateCredentialCounter(stored.credential_id, result.info.newCounter);
    return { ok: true, factor: 'passkey' };
  }

  if (!totpCode) {
    return { ok: false, error: 'Confirmation required' };
  }
  if (!user.totp_enabled || !user.totp_secret) {
    return { ok: false, error: 'TOTP not configured' };
  }
  const totp = new OTPAuth.TOTP({
    issuer: 'ProxyPilot',
    label: user.username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(decryptSecret(user.totp_secret)),
  });
  const delta = totp.validate({ token: totpCode, window: 1 });
  if (delta === null) {
    logAudit(user.id, 'CONFIRM_FAILED', 'user', user.id, { factor: 'totp', reason: 'invalid' }, req.ip);
    return { ok: false, error: 'Invalid TOTP code' };
  }
  return { ok: true, factor: 'totp' };
}
