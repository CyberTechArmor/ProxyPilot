import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { getDb, logAudit } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { decryptSecret } from '../lib/secrets.js';
import { ldapAuthenticate } from '../lib/ldap.js';
import {
  generateAuthenticationOptions, verifyAssertion, putChallenge, takeChallenge, getRpId, getExpectedOrigins,
  listCredentialDescriptors, getCredentialById, updateCredentialCounter,
} from '../lib/webauthn.js';
import { PASSKEY_USER_VERIFICATION, USER_VERIFICATION_REASON, USER_VERIFICATION_ERROR } from '../lib/passkey-policy.js';
import { recordControlGrant } from '../lib/operational-control-grants.js';
import { checkLockout, recordLoginFailure, resetLoginFailures } from './auth.js';

// A7: the once-per-session agent-control verification (user decision,
// 2026-09-29). The same factors as sudo — password + TOTP, or a passkey — with
// the same lockout accounting, but the outcome is different: it records a grant
// for this session in ops_agent_control_grants and never opens the sudo window.
// Takeover and reconciliation check that grant; nothing else does. Mounted at
// /api/auth/agent-control. No MCP tool, catalog entry or policy reaches it.

async function reprove(req, res, user, factor, check) {
  const db = getDb();
  const lock = checkLockout(user);
  if (lock.locked) {
    return res.status(429).set('Retry-After', String(lock.retryAfterSec))
      .json({ error: 'Account temporarily locked.', lockedUntil: lock.until, retryAfterSec: lock.retryAfterSec });
  }
  const outcome = await check();
  if (!outcome.ok) {
    if (outcome.counts !== false) recordLoginFailure(db, user, req);
    logAudit(user.id, 'AGENT_CONTROL_DENIED', 'session', req.user.jti, { reason: outcome.reason, factor }, req.ip);
    return res.status(outcome.status ?? 401).json({ error: outcome.error, ...(outcome.extra ?? {}) });
  }
  resetLoginFailures(db, user.id);
  recordControlGrant(db, { sessionId: req.user.jti, userId: user.id, factor });
  logAudit(user.id, 'AGENT_CONTROL_VERIFIED', 'session', req.user.jti, { factor }, req.ip);
  return res.json({ verified: true, factor });
}

export const agentControlRouter = Router();

agentControlRouter.post('/', authenticateToken, async (req, res) => {
  try {
    const { password, totpCode } = req.body || {};
    if (typeof password !== 'string' || !password || typeof totpCode !== 'string' || !totpCode)
      return res.status(400).json({ error: 'password and totpCode are required' });
    if (!req.user?.jti) return res.status(401).json({ error: 'This session cannot be verified; sign in again.' });
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    return await reprove(req, res, user, 'totp', async () => {
      const passwordValid = user.auth_source === 'ldap'
        ? (await ldapAuthenticate(user.username, password, { db })).ok
        : await bcrypt.compare(password, user.password_hash || '');
      if (!passwordValid) return { ok: false, reason: 'Invalid password', error: 'Invalid credentials' };
      if (!user.totp_secret) return { ok: false, reason: 'No TOTP', error: 'Invalid TOTP code' };
      const totp = new OTPAuth.TOTP({ issuer: 'ProxyPilot', label: user.username, algorithm: 'SHA1', digits: 6, period: 30,
        secret: OTPAuth.Secret.fromBase32(decryptSecret(user.totp_secret)) });
      if (totp.validate({ token: totpCode, window: 1 }) === null)
        return { ok: false, reason: 'Invalid TOTP', error: 'Invalid TOTP code' };
      return { ok: true };
    });
  } catch (e) {
    console.error('agent-control verification error:', e?.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

agentControlRouter.post('/passkey/begin', authenticateToken, async (req, res) => {
  try {
    if (!req.user?.jti) return res.status(401).json({ error: 'This session cannot be verified; sign in again.' });
    const allowCredentials = listCredentialDescriptors(req.user.id);
    if (allowCredentials.length === 0) return res.status(400).json({ error: 'No passkeys registered.' });
    const options = await generateAuthenticationOptions({ rpID: getRpId(req), allowCredentials,
      userVerification: PASSKEY_USER_VERIFICATION });
    putChallenge(`agent-control:${req.user.jti}`, { challenge: options.challenge, userId: req.user.id });
    return res.json(options);
  } catch (e) {
    console.error('agent-control passkey begin error:', e?.message);
    return res.status(500).json({ error: 'Could not start the passkey check' });
  }
});

agentControlRouter.post('/passkey/verify', authenticateToken, async (req, res) => {
  try {
    const { response } = z.object({ response: z.any() }).parse(req.body);
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    return await reprove(req, res, user, 'passkey', async () => {
      const entry = takeChallenge(`agent-control:${req.user.jti}`);
      if (!entry || entry.userId !== user.id)
        return { ok: false, counts: false, status: 400, reason: 'challenge_missing', error: 'Challenge expired or missing. Try again.' };
      const stored = getCredentialById(req.body?.response?.id);
      if (!stored || stored.user_id !== user.id)
        return { ok: false, counts: false, reason: 'unknown_passkey', error: 'Unknown credential' };
      const result = await verifyAssertion({ response, expectedChallenge: entry.challenge, expectedOrigins: getExpectedOrigins(req),
        expectedRPID: getRpId(req), credential: stored });
      if (!result.ok) return { ok: false, reason: result.reason, error: result.reason === USER_VERIFICATION_REASON
        ? USER_VERIFICATION_ERROR : 'Passkey verification failed', extra: result.reason === USER_VERIFICATION_REASON ? { reason: result.reason } : {} };
      updateCredentialCounter(stored.credential_id, result.info.newCounter);
      return { ok: true };
    });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error('agent-control passkey verify error:', error?.message);
    return res.status(500).json({ error: 'Passkey verification failed' });
  }
});
