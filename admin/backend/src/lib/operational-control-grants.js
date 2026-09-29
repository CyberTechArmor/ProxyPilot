// A7: the once-per-session agent-control verification (user decision,
// 2026-09-29). A person with run access proves it is them once per dashboard
// session, with password + TOTP or a passkey, before their first takeover or
// reconciliation; later ones in the same session do not ask again. The grant is
// bound to the session row: logout, revocation, expiry or the idle timeout end
// the session and with it the grant. It is not sudo: it never sets sudo_until,
// and a sudo grant does not count for it. It grants nothing by itself; every
// action still checks Operations run access.

export function recordControlGrant(db, { sessionId, userId, factor, at = new Date().toISOString() }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof userId !== 'string' || !['totp', 'passkey'].includes(factor))
    throw Object.assign(new Error('INVALID_CONTROL_GRANT'), { code: 'INVALID_CONTROL_GRANT' });
  db.prepare(`INSERT INTO ops_agent_control_grants(session_id,user_id,factor,verified_at) VALUES(?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET user_id=excluded.user_id,factor=excluded.factor,verified_at=excluded.verified_at`)
    .run(sessionId, userId, factor, at);
}

// Valid only for this user on this live session (not revoked, not expired).
// The request's own authentication has already checked the session's idle
// window; the expiry and revocation are checked again here.
export function hasControlGrant(db, { sessionId, userId, now = new Date() }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof userId !== 'string') return false;
  const row = db.prepare(`SELECT g.verified_at, s.expires_at, s.revoked_at, s.user_id FROM ops_agent_control_grants g
    JOIN sessions s ON s.id=g.session_id WHERE g.session_id=? AND g.user_id=?`).get(sessionId, userId);
  if (!row || row.revoked_at || row.user_id !== userId) return false;
  const expires = Date.parse(row.expires_at);
  return Number.isFinite(expires) && expires > now.getTime();
}
