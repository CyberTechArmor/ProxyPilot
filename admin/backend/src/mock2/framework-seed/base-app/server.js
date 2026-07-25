'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const store = require('./lib/store');
const rbac = require('./lib/rbac');
const users = require('./lib/users');
const auth = require('./lib/auth');
const session = require('./lib/session');
const ldap = require('./lib/ldap');
const mailer = require('./lib/mailer');
const reset = require('./lib/reset');
const catalog = require('./lib/catalog');
const realtime = require('./lib/realtime');
const audit = require('./lib/audit');
const ratelimit = require('./lib/ratelimit');
const crypto = require('./lib/crypto');
const files = require('./lib/files');
const fields = require('./lib/fields');
const packet = require('./lib/packet');
const branding = require('./lib/branding');
const { readBody, sendJson, parseCookies, clientIp, cookie } = require('./lib/util');

const PORT = +(process.env.PORT || 6525);
const PUBLIC_DIR = path.join(__dirname, 'public');
const OFFICE_PREVIEW_TTL_MS = 15 * 60 * 1000;

// One-time seed of roles/permissions.
rbac.seed();
catalog.seed();
branding.seed();

/* ---------------- cookie helpers ---------------- */
// SECURITY (fix): mark session cookies Secure whenever the request reached us
// over TLS (directly or via a terminating proxy), or when the operator forces it
// with FORCE_SECURE_COOKIES=1. Without it the session cookie would still be sent
// over any plaintext hop a downgrade can induce. HttpOnly + SameSite=Lax were
// already correct and are kept.
function isSecureRequest(req) {
  if (String(process.env.FORCE_SECURE_COOKIES || '') === '1') return true;
  if (req && req.socket && req.socket.encrypted) return true;
  const xfp = req && req.headers ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  return xfp === 'https';
}

function setAuthCookies(res, tokens, req) {
  const secure = isSecureRequest(req);
  res.setHeader('Set-Cookie', [
    cookie(session.ACCESS_COOKIE, tokens.accessToken, { maxAge: session.ABSOLUTE_TTL_MS / 1000, httpOnly: true, sameSite: 'Lax', secure }),
    cookie(session.REFRESH_COOKIE, tokens.refreshToken, { maxAge: session.ABSOLUTE_TTL_MS / 1000, httpOnly: true, sameSite: 'Lax', secure })
  ]);
}
function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    cookie(session.ACCESS_COOKIE, '', { maxAge: 0, httpOnly: true }),
    cookie(session.REFRESH_COOKIE, '', { maxAge: 0, httpOnly: true })
  ]);
}

// SECURITY (fix): emailed links are built from a CONFIGURED origin, never from
// request headers. Trusting X-Forwarded-Host/Host let an attacker POST
// /api/auth/forgot for a victim with a forged host, so the victim received a
// genuine-looking reset email whose link pointed at the attacker's domain —
// handing over the token in the query string. APP_BASE_URL is authoritative;
// header derivation survives only as a development convenience, and is refused
// outright in production.
const APP_BASE_URL = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
if (IS_PRODUCTION && !APP_BASE_URL) {
  console.warn('[security] APP_BASE_URL is not set. Emailed sign-in/reset links cannot be generated safely in production — set it to this app\'s canonical public origin (e.g. https://portal.example.com).');
}

function publicOrigin(req) {
  if (APP_BASE_URL) return APP_BASE_URL;
  // No canonical origin configured: in production refuse rather than mint a
  // link an attacker may have aimed at their own host.
  if (IS_PRODUCTION) throw new Error('APP_BASE_URL_REQUIRED');
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || ('127.0.0.1:' + PORT);
  return `${proto}://${host}`;
}

function htmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mailRuntime() {
  const smtp = store.get().smtpConfig;
  if (!smtp || !smtp.enabled || !smtp.host) return null;
  return Object.assign({}, smtp, { password: crypto.isEncrypted(smtp.password) ? crypto.decryptSecret(smtp.password) : smtp.password });
}

async function sendLinkEmail(user, subject, intro, buttonLabel, link) {
  const runtime = mailRuntime();
  if (!runtime) return { ok: false, code: 'SMTP_NOT_CONFIGURED', reason: 'Email is not configured.' };
  const safeLink = htmlEsc(link);
  return mailer.sendMail(runtime, {
    to: user.email,
    subject,
    text: `Hello ${user.displayName || user.username},\n\n${intro}\n\n${link}\n\nThis link is unique to your account. If you were not expecting this email, contact your administrator.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#12263f"><p>Hello ${htmlEsc(user.displayName || user.username)},</p><p>${htmlEsc(intro)}</p><p><a href="${safeLink}" style="display:inline-block;background:#1466b8;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">${htmlEsc(buttonLabel)}</a></p><p style="font-size:13px;color:#5a6b81">Or copy and paste this link:<br><a href="${safeLink}">${safeLink}</a></p><p style="color:#5a6b81;font-size:12px">This link is unique to your account. If you were not expecting this email, contact your administrator.</p></div>`
  });
}

/* ---------------- auth context ---------------- */
// Returns { user, sid } if a valid, active session; null otherwise.
// `reason` distinguishes deactivation from missing/expired auth.
function authContext(req) {
  const cookies = parseCookies(req);
  const token = cookies[session.ACCESS_COOKIE];
  const payload = session.verifyAccess(token);
  if (!payload) return { error: 'NO_SESSION' };
  const sess = session.getSession(payload.sid);
  if (!sess || sess.revoked) return { error: 'NO_SESSION' };
  if (Date.now() > sess.absoluteExpiry) return { error: 'NO_SESSION' };
  const user = users.findById(payload.uid);
  if (!user) return { error: 'NO_SESSION' };
  if (!user.active) return { error: 'ACCOUNT_DEACTIVATED', user };
  return { user, sid: payload.sid };
}

function requireAuth(req, res) {
  const ctx = authContext(req);
  if (ctx.user && !ctx.error) return ctx;
  if (ctx.error === 'ACCOUNT_DEACTIVATED') { sendJson(res, 403, { code: 'ACCOUNT_DEACTIVATED', message: 'This account has been deactivated.' }); return null; }
  sendJson(res, 401, { code: 'UNAUTHENTICATED', message: 'Authentication required.' }); return null;
}
function requirePerm(req, res, perm) {
  const ctx = requireAuth(req, res);
  if (!ctx) return null;
  if (!rbac.userCan(ctx.user, perm)) {
    audit.record({ action: 'authorization.denied', actorId: ctx.user.id, actorLabel: ctx.user.username, reason: perm, ip: clientIp(req), userAgent: req.headers['user-agent'], outcome: 'denied' });
    sendJson(res, 403, { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.', required: perm });
    return null;
  }
  return ctx;
}
function canReadFile(user, rec) {
  if (!rec || !user) return false;
  if (rec.ownerId === user.id) return true;
  const owner = users.findById(rec.ownerId);
  if (owner && (owner.roles || []).includes('physician')) return rbac.userCan(user, 'portal.review');
  if (owner && rbac.isTeamRoles(owner.roles)) return rbac.userCan(user, 'internal.review');
  return false;
}
function canReviewOwner(user, owner) {
  if (!user || !owner) return false;
  if ((owner.roles || []).includes('physician')) return rbac.userCan(user, 'portal.review');
  if (rbac.isTeamRoles(owner.roles)) return rbac.userCan(user, 'internal.review');
  return false;
}
function officePreviewSig(id, expires) {
  return nodeCrypto.createHmac('sha256', crypto.MASTER_KEY).update(`${id}.${expires}`).digest('base64url');
}
function makeOfficePreviewToken(id) {
  const expires = Date.now() + OFFICE_PREVIEW_TTL_MS;
  return `${expires}.${officePreviewSig(id, expires)}`;
}
function verifyOfficePreviewToken(id, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const expires = Number(parts[0]);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = Buffer.from(officePreviewSig(id, expires));
  const actual = Buffer.from(parts[1]);
  return actual.length === expected.length && nodeCrypto.timingSafeEqual(actual, expected);
}
async function refreshLdapUserProfile(user) {
  const cfg = store.get().ldapConfig;
  if (!user || user.provider !== 'ldap' || !cfg || !cfg.enabled || !cfg.host) return user;
  const login = user.username || user.email;
  if (!login || !ldap.lookupUser) return user;
  const result = await ldap.lookupUser(cfg, login).catch(() => null);
  if (!result || !result.ok || !result.profile) return user;
  const profile = result.profile;
  const updated = users.updateProfile(user.id, { displayName: profile.displayName, email: profile.email, ldapDN: profile.dn });
  return users.sanitize(updated) || user;
}

/* ---------------- static serving ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(data);
  });
}

/* ---------------- route table ---------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url;
  const method = req.method;
  // Consume the request body BEFORE routing, once, and hand the parsed value to
  // whichever route wants it (readBody returns this cached promise).
  //
  // Why up-front and not per-route: a route that answers WITHOUT reading the
  // body — an auth guard rejecting early, a POST that takes no body such as
  // .../password-reset, a 404 — leaves the unread bytes in the socket, including
  // a chunked encoding's terminating 0-chunk. On a keep-alive connection the
  // parser is then still mid-message when the NEXT request arrives and rejects
  // it with "Parse Error: Invalid method encountered", killing an unrelated
  // request. Node's own HTTP client has had keep-alive on by default since v19,
  // so this corrupts real clients, not just tests. Draining afterwards races the
  // response that was already sent; draining first is deterministic.
  // Framing, not method, decides whether a body exists: a client may attach one
  // to ANY method (Node's http client sends `GET` with a chunked body if you
  // write to the request), and an unconsumed body desynchronises the parser
  // exactly the same way regardless of the verb.
  if (req.headers['content-length'] || req.headers['transfer-encoding']) {
    req._bodyPromise = readBody(req);
    // Surface the read error through the route's own await, not as an
    // unhandled rejection here.
    req._bodyPromise.catch(() => {});
  }
  try {
    if (url.startsWith('/api/')) return await api(req, res, url.split('?')[0], method);
    // The browser asks for /favicon.ico with no cookies and no <link> hint, so
    // it has to resolve without a session. Falls back to the logo when no
    // dedicated favicon was uploaded; 404s rather than letting serveStatic's
    // SPA fallback answer an icon request with a page of HTML.
    if (url.split('?')[0] === '/favicon.ico') {
      const id = branding.faviconId(branding.raw());
      if (!id) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No favicon'); }
      return branding.streamAsset(res, id);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    if (e.message === 'INVALID_JSON') return sendJson(res, 400, { code: 'INVALID_JSON', message: 'Malformed request body.' });
    console.error('server error', e);
    if (!res.headersSent) sendJson(res, 500, { code: 'SERVER_ERROR', message: 'Unexpected server error.' });
  } finally {
    // ALWAYS drain the request body. Any route that answers without reading it
    // (an auth guard rejecting early, a POST that takes no body, a 404) leaves
    // the unread bytes — including a chunked encoding's terminating 0-chunk —
    // sitting in the socket. On a keep-alive connection the parser then reads
    // those leftovers as the START of the next request and kills it with
    // "Parse Error: Invalid method encountered". Node has enabled keep-alive by
    // default on its own HTTP client since v19, so this corrupts real clients,
    // not just tests. Draining costs nothing on requests that were fully read.
    if (!req.readableEnded) req.resume();
  }
});

async function api(req, res, p, method) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'];
  let m;

  /* ----- public branding + legal -----
     Deliberately unauthenticated: the sign-in screen renders the copyright
     notice, the logo and the Privacy / Terms links BEFORE there is a session,
     and the browser fetches the favicon with no cookies at all. Nothing here is
     permission-bearing — see branding.publicView(). */
  if (p === '/api/branding' && method === 'GET')
    return sendJson(res, 200, { branding: branding.publicView() });

  if ((m = p.match(/^\/api\/legal\/([a-z-]+)$/)) && method === 'GET') {
    const pg = branding.page(m[1]);
    if (!pg) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Page not found.' });
    return sendJson(res, 200, { page: pg });
  }

  if ((m = p.match(/^\/api\/branding\/assets\/([A-Za-z0-9-]+)$/)) && method === 'GET')
    return branding.streamAsset(res, m[1]);

  /* ----- setup ----- */
  if (p === '/api/setup/status' && method === 'GET')
    return sendJson(res, 200, { needsSetup: auth.needsSetup() });

  if (p === '/api/setup' && method === 'POST') {
    if (!auth.needsSetup()) return sendJson(res, 409, { code: 'ALREADY_INITIALIZED', message: 'Setup has already been completed.' });
    const body = await readBody(req);
    if (!body.username || !body.password) return sendJson(res, 400, { code: 'VALIDATION', message: 'Username and password are required.' });
    if (String(body.password).length < 8) return sendJson(res, 400, { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' });
    const admin = auth.createSuperAdmin(body);
    audit.record({ action: 'setup.completed', actorId: admin.id, actorLabel: admin.username, targetId: admin.id, provider: 'local', outcome: 'ok', ip, userAgent: ua });
    const tokens = session.createSession(admin, req);
    setAuthCookies(res, tokens, req);
    users.touchLogin(admin.id);
    return sendJson(res, 201, { code: 'OK', user: auth.buildIdentity(admin) });
  }

  /* ----- auth ----- */
  if (p === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const login = String(body.login || body.username || '').trim();
    const rl = ratelimit.hit('login:' + ip + ':' + login.toLowerCase(), { windowMs: 15 * 60 * 1000, max: 8 });
    if (rl.limited) { audit.record({ action: 'login.rate_limited', targetLabel: login, ip, userAgent: ua, outcome: 'blocked' }); return sendJson(res, 429, { code: 'RATE_LIMITED', message: `Too many attempts. Try again in ${rl.retryAfter}s.`, retryAfter: rl.retryAfter }); }
    if (!login || !body.password) return sendJson(res, 400, { code: 'VALIDATION', message: 'Login and password are required.' });
    const result = await auth.authenticate(login, body.password);
    if (result.ok) {
      ratelimit.reset('login:' + ip + ':' + login.toLowerCase());
      const tokens = session.createSession(result.user, req);
      setAuthCookies(res, tokens, req);
      users.touchLogin(result.user.id);
      audit.record({ action: 'login.success', actorId: result.user.id, actorLabel: result.user.username, provider: result.provider, outcome: 'ok', ip, userAgent: ua });
      return sendJson(res, 200, { code: 'OK', user: auth.buildIdentity(result.user) });
    }
    audit.record({ action: 'login.failure', targetLabel: login, provider: result.provider || null, reason: result.code, outcome: 'fail', ip, userAgent: ua });
    const status = result.code === 'ACCOUNT_DEACTIVATED' ? 403 : 401;
    return sendJson(res, status, { code: result.code, message: result.message, needsPasswordSetup: result.code === 'PASSWORD_SETUP_REQUIRED', mfaRequired: result.code === 'MFA_REQUIRED' });
  }

  // SECURITY (fix): first-login password setup now requires PROOF OF IDENTITY.
  //
  // This endpoint previously accepted { login, newPassword } and asked only that
  // the account still had mustSetPassword — no token, no temporary password, no
  // email proof. Anyone who knew or guessed the username of an admin-provisioned
  // account could claim it and was handed a session immediately. Now the caller
  // must present ONE of:
  //   * token         — a single-use setup/reset link token (hash-stored, the
  //                     same machinery admin-issued reset links already use), or
  //   * tempPassword  — the temporary password the admin set on the account.
  // The account is identified BY THE TOKEN when one is supplied, so `login` can
  // no longer be used to point the request at somebody else. Rate limited, and
  // failures stay deliberately vague so the endpoint is not an oracle.
  if (p === '/api/auth/set-password' && method === 'POST') {
    const body = await readBody(req);
    const rlKey = 'setpw:' + ip;
    const rl = ratelimit.hit(rlKey, { windowMs: 15 * 60 * 1000, max: 10 });
    if (rl.limited) {
      audit.record({ action: 'password.set.rate_limited', targetLabel: String(body.login || ''), ip, userAgent: ua, outcome: 'blocked' });
      return sendJson(res, 429, { code: 'RATE_LIMITED', message: `Too many attempts. Try again in ${rl.retryAfter}s.`, retryAfter: rl.retryAfter });
    }
    const token = String(body.token || '').trim();
    const tempPassword = String(body.tempPassword || body.currentPassword || '');
    let u = null;
    if (token) {
      // The token identifies the account — a caller cannot aim it elsewhere.
      const userId = reset.verifyReset(token) || reset.verifyLogin(token);
      u = userId ? users.findById(userId) : null;
    } else if (tempPassword) {
      const candidate = users.findByLogin(body.login || '');
      // Constant work regardless of whether the account exists.
      const ok = candidate && candidate.passwordHash
        ? crypto.verifyPassword(tempPassword, candidate.passwordHash) : false;
      u = ok ? candidate : null;
    } else {
      audit.record({ action: 'password.set.denied', targetLabel: String(body.login || ''), reason: 'NO_PROOF', ip, userAgent: ua, outcome: 'fail' });
      return sendJson(res, 400, { code: 'PROOF_REQUIRED', message: 'A setup link token or the temporary password is required to set your password.' });
    }
    if (!u || !u.mustSetPassword) {
      audit.record({ action: 'password.set.denied', targetLabel: String(body.login || ''), reason: 'INVALID_PROOF', ip, userAgent: ua, outcome: 'fail' });
      return sendJson(res, 400, { code: 'INVALID_REQUEST', message: 'Password setup is not pending for this account, or the link is invalid or already used.' });
    }
    if (!u.active) return sendJson(res, 403, { code: 'ACCOUNT_DEACTIVATED', message: 'This account has been deactivated.' });
    if (String(body.newPassword || '').length < 8) return sendJson(res, 400, { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' });
    ratelimit.reset(rlKey);
    users.setPassword(u.id, body.newPassword);
    audit.record({ action: 'password.set', actorId: u.id, actorLabel: u.username, outcome: 'ok', ip, userAgent: ua });
    const tokens = session.createSession(u, req);
    setAuthCookies(res, tokens, req);
    return sendJson(res, 200, { code: 'OK', user: auth.buildIdentity(users.findById(u.id)) });
  }

  if (p === '/api/auth/change-password' && method === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || body.password || '');
    if (ctx.user.provider !== 'local' || !ctx.user.passwordHash) return sendJson(res, 409, { code: 'NOT_LOCAL', message: 'This account uses directory sign-in. Change your password with your directory administrator.' });
    if (!currentPassword) return sendJson(res, 400, { code: 'VALIDATION', message: 'Current password is required.' });
    if (newPassword.length < 8) return sendJson(res, 400, { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' });
    if (!crypto.verifyPassword(currentPassword, ctx.user.passwordHash)) {
      audit.record({ action: 'password.change', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'fail', reason: 'bad_current_password', ip, userAgent: ua });
      return sendJson(res, 401, { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' });
    }
    users.setPassword(ctx.user.id, newPassword);
    audit.record({ action: 'password.change', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, userAgent: ua });
    return sendJson(res, 200, { code: 'OK', user: auth.buildIdentity(users.findById(ctx.user.id)) });
  }

  if (p === '/api/auth/register' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const rl = ratelimit.hit('register:' + ip, { windowMs: 60 * 60 * 1000, max: 5 });
    if (rl.limited) { audit.record({ action: 'register.rate_limited', targetLabel: email, ip, userAgent: ua, outcome: 'blocked' }); return sendJson(res, 429, { code: 'RATE_LIMITED', message: `Too many sign-up attempts. Try again in ${rl.retryAfter}s.`, retryAfter: rl.retryAfter }); }
    const result = auth.registerPhysician({ email, password: body.password, displayName: body.displayName });
    if (!result.ok) {
      audit.record({ action: 'register.failure', targetLabel: email, reason: result.code, outcome: 'fail', ip, userAgent: ua });
      const status = result.code === 'USER_EXISTS' ? 409 : (result.code === 'SETUP_REQUIRED' ? 409 : 400);
      return sendJson(res, status, { code: result.code, message: result.message });
    }
    const tokens = session.createSession(result.user, req);
    setAuthCookies(res, tokens, req);
    users.touchLogin(result.user.id);
    audit.record({ action: 'register.success', actorId: result.user.id, actorLabel: result.user.username, provider: 'local', outcome: 'ok', ip, userAgent: ua });
    return sendJson(res, 201, { code: 'OK', user: auth.buildIdentity(result.user) });
  }

  /* ----- provider password reset (forgot password) ----- */
  if (p === '/api/auth/forgot' && method === 'POST') {
    const body = await readBody(req);
    const login = String(body.login || body.email || '').trim();
    const rl = ratelimit.hit('forgot:' + ip, { windowMs: 60 * 60 * 1000, max: 10 });
    if (rl.limited) return sendJson(res, 429, { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${rl.retryAfter}s.`, retryAfter: rl.retryAfter });
    // Always respond the same way so we never reveal whether an account exists.
    const generic = { code: 'OK', message: 'If an account exists for that email, password reset instructions have been sent.' };
    const u = users.findByLogin(login);
    // Providers only: active, local (password) accounts holding the physician role with an email.
    const eligible = u && u.active && u.provider === 'local' && Array.isArray(u.roles) && u.roles.includes('physician') && u.email;
    if (!eligible) { audit.record({ action: 'password_reset.request', targetLabel: login, outcome: 'ignored', reason: u ? 'not_eligible' : 'no_user', ip, userAgent: ua }); return sendJson(res, 200, generic); }
    const smtp = store.get().smtpConfig;
    if (!smtp || !smtp.enabled || !smtp.host) { audit.record({ action: 'password_reset.request', actorId: u.id, targetLabel: u.email, outcome: 'fail', reason: 'smtp_not_configured', ip }); return sendJson(res, 200, generic); }
    const token = reset.createReset(u.id);
    const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host || ('127.0.0.1:' + PORT);
    const link = `${proto}://${host}/?reset=${encodeURIComponent(token)}`;
    const runtime = Object.assign({}, smtp, { password: crypto.isEncrypted(smtp.password) ? crypto.decryptSecret(smtp.password) : smtp.password });
    const mail = await mailer.sendMail(runtime, {
      to: u.email,
      subject: 'Reset your Upload Doc password',
      text: `Hello,\n\nWe received a request to reset your Upload Doc password. Use the link below within 1 hour to choose a new password:\n\n${link}\n\nIf you didn't request this, you can safely ignore this email.`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#12263f"><p>Hello,</p><p>We received a request to reset your <b>Upload Doc</b> password. Use the button below within 1 hour to choose a new password:</p><p><a href="${link}" style="display:inline-block;background:#1466b8;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Reset password</a></p><p style="font-size:13px;color:#5a6b81">Or copy and paste this link:<br><a href="${link}">${link}</a></p><p style="color:#5a6b81;font-size:12px">If you didn't request this, you can safely ignore this email.</p></div>`
    });
    audit.record({ action: 'password_reset.request', actorId: u.id, targetLabel: u.email, outcome: mail.ok ? 'ok' : 'fail', reason: mail.ok ? null : mail.code, ip });
    return sendJson(res, 200, generic);
  }

  if (p === '/api/auth/reset' && method === 'POST') {
    const body = await readBody(req);
    const token = String(body.token || '');
    const newPassword = String(body.newPassword || body.password || '');
    if (String(newPassword).length < 8) return sendJson(res, 400, { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' });
    const userId = reset.verifyReset(token);
    if (!userId) { audit.record({ action: 'password_reset.complete', outcome: 'fail', reason: 'invalid_token', ip, userAgent: ua }); return sendJson(res, 400, { code: 'INVALID_TOKEN', message: 'This reset link is invalid or has expired. Please request a new one.' }); }
    const u = users.findById(userId);
    if (!u || !u.active || u.deleted || u.provider !== 'local') { audit.record({ action: 'password_reset.complete', outcome: 'fail', reason: 'ineligible', ip }); return sendJson(res, 400, { code: 'INVALID_TOKEN', message: 'This reset link is no longer valid.' }); }
    users.setPassword(u.id, newPassword);
    reset.consumeReset(token);
    audit.record({ action: 'password_reset.complete', actorId: u.id, actorLabel: u.username, outcome: 'ok', ip, userAgent: ua });
    const tokens = session.createSession(u, req);
    setAuthCookies(res, tokens, req);
    users.touchLogin(u.id);
    return sendJson(res, 200, { code: 'OK', user: auth.buildIdentity(users.findById(u.id)) });
  }

  if (p === '/api/auth/otp/request' && method === 'POST') {
    const body = await readBody(req);
    const login = String(body.login || body.email || body.username || '').trim();
    const rl = ratelimit.hit('otp:' + ip + ':' + login.toLowerCase(), { windowMs: 60 * 60 * 1000, max: 10 });
    if (rl.limited) return sendJson(res, 429, { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${rl.retryAfter}s.`, retryAfter: rl.retryAfter });
    const generic = { code: 'OK', message: 'If this account can use email sign-in, a one-time link has been sent.' };
    const u = users.findByLogin(login);
    const eligible = u && u.active && !u.deleted && u.email && !u.mustSetPassword && !u.forcePasswordReset;
    if (!eligible) { audit.record({ action: 'email_login.request', targetLabel: login, outcome: 'ignored', reason: u ? 'not_eligible' : 'no_user', ip, userAgent: ua }); return sendJson(res, 200, generic); }
    const token = reset.createLogin(u.id, { self: true });
    const link = `${publicOrigin(req)}/?otp=${encodeURIComponent(token)}`;
    const mail = await sendLinkEmail(u, 'Your Upload Doc sign-in link', 'Use this one-time Upload Doc sign-in link within 15 minutes to sign in automatically.', 'Sign in to Upload Doc', link);
    audit.record({ action: 'email_login.request', actorId: u.id, actorLabel: u.username, targetId: u.id, targetLabel: u.username, outcome: mail.ok ? 'ok' : 'fail', reason: mail.ok ? null : mail.code, ip, userAgent: ua });
    return sendJson(res, 200, generic);
  }

  if (p === '/api/auth/otp' && method === 'POST') {
    const body = await readBody(req);
    const token = String(body.token || '');
    const userId = reset.verifyLogin(token);
    if (!userId) { audit.record({ action: 'email_login.complete', outcome: 'fail', reason: 'invalid_token', ip, userAgent: ua }); return sendJson(res, 400, { code: 'INVALID_TOKEN', message: 'This sign-in link is invalid or has expired.' }); }
    const u = users.findById(userId);
    if (!u || !u.active || u.deleted) { audit.record({ action: 'email_login.complete', outcome: 'fail', reason: 'ineligible', ip }); return sendJson(res, 400, { code: 'INVALID_TOKEN', message: 'This sign-in link is no longer valid.' }); }
    if (u.forcePasswordReset) return sendJson(res, 409, { code: 'PASSWORD_RESET_REQUIRED', message: 'A password reset is required before this account can sign in.' });
    reset.consumeLogin(token);
    const tokens = session.createSession(u, req);
    setAuthCookies(res, tokens, req);
    users.touchLogin(u.id);
    audit.record({ action: 'email_login.complete', actorId: u.id, actorLabel: u.username, outcome: 'ok', ip, userAgent: ua });
    return sendJson(res, 200, { code: 'OK', user: auth.buildIdentity(users.findById(u.id)) });
  }

  if (p === '/api/auth/refresh' && method === 'POST') {
    const cookies = parseCookies(req);
    const result = await session.rotate(cookies[session.REFRESH_COOKIE], req);
    if (!result.ok) { clearAuthCookies(res); audit.record({ action: 'refresh.failure', reason: result.error, outcome: 'fail', ip, userAgent: ua }); return sendJson(res, 401, { code: 'REFRESH_FAILED', reason: result.error }); }
    const user = users.findById(result.userId);
    if (!user) { clearAuthCookies(res); return sendJson(res, 401, { code: 'REFRESH_FAILED' }); }
    setAuthCookies(res, result);
    audit.record({ action: 'refresh.success', actorId: user.id, actorLabel: user.username, outcome: 'ok', ip });
    // Note: active status still enforced by /me and guards. Deactivated users can rotate but cannot access resources (enables auto-restore on reactivation).
    return sendJson(res, 200, { code: 'OK', user: auth.buildIdentity(user), active: user.active });
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    const cookies = parseCookies(req);
    const payload = session.verifyAccess(cookies[session.ACCESS_COOKIE]);
    const rt = cookies[session.REFRESH_COOKIE];
    if (rt && rt.indexOf('.') > 0) session.revokeSession(rt.slice(0, rt.indexOf('.')), 'logout');
    else if (payload) session.revokeSession(payload.sid, 'logout');
    if (payload) audit.record({ action: 'logout', actorId: payload.uid, outcome: 'ok', ip });
    clearAuthCookies(res);
    return sendJson(res, 200, { code: 'OK' });
  }

  if (p === '/api/auth/me' && method === 'GET') {
    const ctx = authContext(req);
    if (ctx.error === 'ACCOUNT_DEACTIVATED') return sendJson(res, 403, { code: 'ACCOUNT_DEACTIVATED', message: 'This account has been deactivated.' });
    if (ctx.error) return sendJson(res, 401, { code: 'UNAUTHENTICATED' });
    return sendJson(res, 200, { code: 'OK', user: auth.buildIdentity(ctx.user) });
  }

  /* ----- files (upload + serve credentialing documents) ----- */
  if (p === '/api/files' && method === 'POST') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    // A physician uploads to their own record. The credentialing team can upload
    // on behalf of a provider by passing that provider's id in X-Owner.
    let ownerId = ctx.user.id;
    const wantOwner = req.headers['x-owner'];
    if (wantOwner && wantOwner !== ctx.user.id) {
      const target = users.findById(wantOwner);
      if (!target || !canReviewOwner(ctx.user, target)) return sendJson(res, 403, { code: 'FORBIDDEN', message: 'You cannot upload on behalf of this user.' });
      ownerId = target.id;
    }
    try {
      const rec = await files.save(req, {
        filename: req.headers['x-filename'] || 'document',
        mime: req.headers['content-type'] || '',
        ownerId,
        docKey: req.headers['x-dockey'] || null
      });
      audit.record({ action: 'file.upload', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: ownerId, outcome: 'ok', ip, meta: { id: rec.id, name: rec.name, size: rec.size } });
      return sendJson(res, 201, { code: 'OK', file: rec });
    } catch (e) {
      const map = { TOO_LARGE: [413, 'File exceeds the maximum allowed size.'], UNSUPPORTED_TYPE: [415, 'This file type is not allowed.'], EMPTY: [400, 'The uploaded file was empty.'] };
      const [status, message] = map[e.code] || [400, 'Upload failed.'];
      return sendJson(res, status, { code: e.code || 'UPLOAD_FAILED', message });
    }
  }
  if ((m = p.match(/^\/api\/files\/([A-Za-z0-9-]+)$/)) && method === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    const rec = files.get(m[1]);
    if (!rec) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Document not found.' });
    if (!canReadFile(ctx.user, rec)) return sendJson(res, 403, { code: 'FORBIDDEN', message: 'You do not have permission to open this document.' });
    const download = /[?&]dl=1/.test(req.url);
    return files.stream(res, rec.id, { download });
  }
  if ((m = p.match(/^\/api\/files\/([A-Za-z0-9-]+)\/office-url$/)) && method === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    const rec = files.get(m[1]);
    if (!rec) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Document not found.' });
    if (!files.OFFICE_EXT.has(rec.ext)) return sendJson(res, 400, { code: 'NOT_OFFICE', message: 'This document does not use the Microsoft viewer.' });
    if (!canReadFile(ctx.user, rec)) return sendJson(res, 403, { code: 'FORBIDDEN', message: 'You do not have permission to open this document.' });
    const token = makeOfficePreviewToken(rec.id);
    return sendJson(res, 200, { code: 'OK', url: `/api/public/files/${encodeURIComponent(rec.id)}?token=${encodeURIComponent(token)}`, expiresIn: Math.floor(OFFICE_PREVIEW_TTL_MS / 1000) });
  }
  if ((m = p.match(/^\/api\/public\/files\/([A-Za-z0-9-]+)$/)) && method === 'GET') {
    const rec = files.get(m[1]);
    if (!rec) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Document not found.' });
    if (!files.OFFICE_EXT.has(rec.ext)) return sendJson(res, 400, { code: 'NOT_OFFICE', message: 'This preview URL is only for Microsoft Office documents.' });
    const token = new URL(req.url, 'http://127.0.0.1').searchParams.get('token');
    if (!verifyOfficePreviewToken(rec.id, token)) return sendJson(res, 403, { code: 'PREVIEW_EXPIRED', message: 'This preview link has expired.' });
    return files.stream(res, rec.id, { forceInline: true });
  }

  // Delete a single uploaded document. The owning physician can remove their own
  // files; the credentialing team (portal.review) can remove any.
  if ((m = p.match(/^\/api\/files\/([A-Za-z0-9-]+)$/)) && method === 'DELETE') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    const rec = files.get(m[1]);
    if (!rec) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Document not found.' });
    if (!canReadFile(ctx.user, rec)) {
      return sendJson(res, 403, { code: 'FORBIDDEN', message: 'You do not have permission to delete this document.' });
    }
    files.remove(m[1]);
    audit.record({ action: 'file.delete', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: m[1], name: rec.name } });
    return sendJson(res, 200, { code: 'OK' });
  }

  // Current user's own uploaded documents (physician self-service view).
  if (p === '/api/my/files' && method === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    return sendJson(res, 200, { files: files.listByOwner(ctx.user.id), fields: fields.listByOwner(ctx.user.id), sectionAcks: users.getSectionAcks(ctx.user) });
  }

  // Save non-document input fields for a checklist item. A physician saves their
  // own; the credentialing team can save on behalf of a provider via X-Owner.
  if ((m = p.match(/^\/api\/fields\/([A-Za-z0-9_]+)$/)) && method === 'PUT') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    let ownerId = ctx.user.id;
    const wantOwner = req.headers['x-owner'];
    if (wantOwner && wantOwner !== ctx.user.id) {
      const target = users.findById(wantOwner);
      if (!target || !canReviewOwner(ctx.user, target)) return sendJson(res, 403, { code: 'FORBIDDEN', message: 'You cannot edit fields on behalf of this user.' });
      ownerId = target.id;
    }
    const body = await readBody(req);
    const rec = fields.setValues(ownerId, m[1], body.values || {}, { id: ctx.user.id, name: ctx.user.displayName || ctx.user.username });
    audit.record({ action: 'fields.save', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: ownerId, outcome: 'ok', ip, meta: { docKey: m[1] } });
    return sendJson(res, 200, { code: 'OK', fields: rec });
  }

  // Document catalog (sections + documents) used to render the checklist.
  if (p === '/api/catalog' && method === 'GET') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    return sendJson(res, 200, { catalog: catalog.publicCatalog() });
  }
  if (p === '/api/internal/catalog' && method === 'GET') {
    const ctx = requirePerm(req, res, 'internal.review'); if (!ctx) return;
    return sendJson(res, 200, { catalog: catalog.publicCatalog('internal') });
  }

  // Credentialing team: list signed-up physicians with their uploaded documents.
  if (p === '/api/physicians' && method === 'GET') {
    const ctx = requirePerm(req, res, 'portal.review'); if (!ctx) return;
    const list = users.listUsers()
      .filter(u => (u.roles || []).includes('physician'))
      .map(u => ({
        id: u.id,
        displayName: u.displayName,
        email: u.email,
        active: u.active,
        createdAt: u.createdAt,
        deal: users.getDeal(u),
        sectionAcks: users.getSectionAcks(u),
        files: files.listByOwner(u.id),
        fields: fields.listByOwner(u.id)
      }));
    return sendJson(res, 200, { physicians: list });
  }

  // Credentialing team: download the PDF packet and a copy of each submitted file.
  if ((m = p.match(/^\/api\/providers\/([A-Za-z0-9-]+)\/packet$/)) && method === 'GET') {
    const ctx = requirePerm(req, res, 'portal.review'); if (!ctx) return;
    const target = users.findById(m[1]);
    if (!target || !(target.roles || []).includes('physician')) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Provider not found.' });
    const submitted = files.listByOwner(target.id);
    const pdf = await packet.createPacketPdf({ provider: target, sections: catalog.publicCatalog().sections, files: submitted, fields: fields.listByOwner(target.id), readBuffer: files.readBuffer });
    const body = await packet.createPacketBundle({ pdf, files: submitted, readBuffer: files.readBuffer });
    const safeName = String(target.displayName || target.email || 'provider').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
    audit.record({ action: 'file.packet_download', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: target.id, targetLabel: target.email, outcome: 'ok', ip, meta: { files: submitted.length } });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': body.length,
      'Content-Disposition': `attachment; filename="${safeName}-credentialing-packet.zip"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(body);
  }

  // Internal credentialing: team-member employees with the same document model.
  if (p === '/api/internal/employees' && method === 'GET') {
    const ctx = requirePerm(req, res, 'internal.review'); if (!ctx) return;
    const teamUsers = await Promise.all(users.listUsers()
      .filter(u => rbac.isTeamRoles(u.roles))
      .map(u => refreshLdapUserProfile(u)));
    const list = teamUsers.map(u => ({
        id: u.id,
        displayName: u.displayName,
        username: u.username,
        email: u.email,
        active: u.active,
        provider: u.provider,
        roles: u.roles || [],
        createdAt: u.createdAt,
        files: files.listByOwner(u.id),
        fields: fields.listByOwner(u.id)
      }));
    return sendJson(res, 200, { employees: list });
  }

  // Credentialing team: pipeline / deal + expiry reporting.
  if (p === '/api/reports' && method === 'GET') {
    const ctx = requirePerm(req, res, 'portal.review'); if (!ctx) return;
    const cat = catalog.publicCatalog();
    const keyCount = cat.sections.reduce((n, s) => n + s.items.length, 0);
    const expiryMode = {};
    cat.sections.forEach(s => s.items.forEach(it => { expiryMode[it.key] = it.expiry; }));
    const physicians = users.listUsers().filter(u => (u.roles || []).includes('physician'));
    const now = Date.now();
    const soon = now + 30 * 24 * 60 * 60 * 1000;
    const deals = { pending: 0, completed: 0, cancelled: 0 };
    let complete = 0, expired = 0, expiringSoon = 0;
    for (const u of physicians) {
      const deal = users.getDeal(u);
      deals[deal.status] = (deals[deal.status] || 0) + 1;
      const flist = files.listByOwner(u.id);
      const byKey = {};
      flist.forEach(f => { if (f.docKey && !byKey[f.docKey]) byKey[f.docKey] = f; });
      const approved = Object.values(byKey).filter(f => f.status === 'approved').length;
      if (keyCount > 0 && approved >= keyCount) complete++;
      for (const f of Object.values(byKey)) {
        if (expiryMode[f.docKey] === 'expires' && f.expiresAt) {
          const t = new Date(f.expiresAt).getTime();
          if (!isNaN(t)) { if (t < now) expired++; else if (t < soon) expiringSoon++; }
        }
      }
    }
    return sendJson(res, 200, { report: { providers: physicians.length, deals, complete, expired, expiringSoon } });
  }

  // Credentialing team: set a provider's deal status (Active date / cancel).
  if ((m = p.match(/^\/api\/providers\/([A-Za-z0-9-]+)\/deal$/)) && method === 'POST') {
    const ctx = requirePerm(req, res, 'portal.review'); if (!ctx) return;
    const target = users.findById(m[1]);
    if (!target || !(target.roles || []).includes('physician')) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Provider not found.' });
    const body = await readBody(req);
    const deal = users.setDeal(target.id, { status: body.status, activeDate: body.activeDate, reason: body.reason });
    audit.record({ action: 'deal.update', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: target.id, targetLabel: target.email, outcome: 'ok', ip, meta: { status: deal.status, activeDate: deal.activeDate } });
    return sendJson(res, 200, { code: 'OK', deal });
  }

  // Credentialing team: acknowledge (unlock) a gated section for a provider so the
  // sections that follow it become visible before the section is fully approved.
  if ((m = p.match(/^\/api\/providers\/([A-Za-z0-9-]+)\/section-ack$/)) && method === 'POST') {
    const ctx = requirePerm(req, res, 'portal.review'); if (!ctx) return;
    const target = users.findById(m[1]);
    if (!target || !(target.roles || []).includes('physician')) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Provider not found.' });
    const body = await readBody(req);
    if (!body.sectionId) return sendJson(res, 400, { code: 'VALIDATION', message: 'sectionId is required.' });
    const acks = users.setSectionAck(target.id, String(body.sectionId), body.on !== false, { id: ctx.user.id, name: ctx.user.displayName || ctx.user.username });
    audit.record({ action: 'section.ack', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: target.id, targetLabel: target.email, outcome: 'ok', ip, meta: { sectionId: body.sectionId, on: body.on !== false } });
    return sendJson(res, 200, { code: 'OK', sectionAcks: acks });
  }

  // Credentialing team: toggle a section's gate (hide later sections until this
  // one is complete or acknowledged). Applies to every provider.
  if ((m = p.match(/^\/api\/catalog\/sections\/([A-Za-z0-9-]+)\/gate$/)) && method === 'POST') {
    const ctx = requirePerm(req, res, 'portal.review'); if (!ctx) return;
    const body = await readBody(req);
    const s = catalog.updateSection(m[1], { gate: body.gate !== false });
    if (!s) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Section not found.' });
    audit.record({ action: 'catalog.section_gate', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: s.id, gate: !!s.gate } });
    return sendJson(res, 200, { code: 'OK', catalog: catalog.publicCatalog() });
  }
  if ((m = p.match(/^\/api\/files\/([A-Za-z0-9-]+)\/review$/)) && method === 'PATCH') {
    const ctx = requireAuth(req, res); if (!ctx) return;
    const existing = files.get(m[1]);
    const owner = existing && users.findById(existing.ownerId);
    if (!existing) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Document not found.' });
    if (!canReviewOwner(ctx.user, owner)) return sendJson(res, 403, { code: 'FORBIDDEN', message: 'You do not have permission to review this document.' });
    const body = await readBody(req);
    try {
      const rec = files.setReview(m[1], { status: body.status, note: body.note, expiresAt: body.expiresAt });
      if (!rec) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Document not found.' });
      audit.record({ action: 'file.review', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: rec.id, status: rec.status } });
      return sendJson(res, 200, { code: 'OK', file: rec });
    } catch (e) {
      if (e.code === 'BAD_STATUS') return sendJson(res, 400, { code: 'BAD_STATUS', message: 'Invalid review status.' });
      throw e;
    }
  }

  /* ----- realtime (SSE) ----- */
  if (p === '/api/realtime' && method === 'GET') {
    const ctx = authContext(req);
    if (!ctx.user) { res.writeHead(401); return res.end(); }
    realtime.addClient(ctx.user.id, ctx.sid, res);
    return;
  }

  /* ----- admin: users ----- */
  if (p === '/api/admin/users' && method === 'GET') {
    const ctx = requirePerm(req, res, 'users.view'); if (!ctx) return;
    const withTeam = u => ({ ...u, isTeam: rbac.isTeamRoles(u.roles) });
    return sendJson(res, 200, { users: users.listUsers().map(withTeam), deleted: users.listDeleted().map(withTeam), online: realtime.stats() });
  }
  if (p === '/api/admin/users' && method === 'POST') {
    const ctx = requirePerm(req, res, 'users.manage'); if (!ctx) return;
    const body = await readBody(req);
    if (!body.username) return sendJson(res, 400, { code: 'VALIDATION', message: 'Username is required.' });
    try {
      const created = users.createUser({ username: body.username, email: body.email, displayName: body.displayName, roles: body.roles, active: body.active !== false, password: body.password, mustSetPassword: body.mustSetPassword || !body.password, provider: 'local' });
      audit.record({ action: 'user.create', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: created.id, targetLabel: created.username, outcome: 'ok', ip });
      return sendJson(res, 201, { user: users.sanitize(created) });
    } catch (e) { return sendJson(res, 409, { code: e.code || 'ERROR', message: 'Could not create user (may already exist).' }); }
  }

  if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/roles$/)) && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'users.manage'); if (!ctx) return;
    const body = await readBody(req);
    const target = users.findById(m[1]);
    if (!target) return sendJson(res, 404, { code: 'NOT_FOUND' });
    // Guardrail: cannot strip admin from the last active admin
    if (target.roles.includes('admin') && !(body.roles || []).includes('admin') && users.countActiveAdmins(target.id) === 0)
      return sendJson(res, 409, { code: 'LAST_ADMIN', message: 'Cannot remove the last administrator.' });
    const before = target.roles.slice();
    users.assignRoles(target.id, body.roles);
    audit.record({ action: 'user.roles_changed', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: target.id, targetLabel: target.username, outcome: 'ok', ip, meta: { before, after: target.roles } });
    realtime.publish(target.id, 'permissions.changed', { roles: target.roles });
    return sendJson(res, 200, { user: users.sanitize(target) });
  }

  if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/active$/)) && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'users.manage'); if (!ctx) return;
    const body = await readBody(req);
    const target = users.findById(m[1]);
    if (!target) return sendJson(res, 404, { code: 'NOT_FOUND' });
    const activate = !!body.active;
    if (!activate) {
      // Guardrails: no self-deactivation, no deactivating last active admin
      if (target.id === ctx.user.id) return sendJson(res, 409, { code: 'SELF_DEACTIVATION', message: 'You cannot deactivate your own account.' });
      if (target.roles.includes('admin') && users.countActiveAdmins(target.id) === 0) return sendJson(res, 409, { code: 'LAST_ADMIN', message: 'Cannot deactivate the last administrator.' });
    }
    users.setActive(target.id, activate);
    audit.record({ action: activate ? 'user.activated' : 'user.deactivated', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: target.id, targetLabel: target.username, outcome: 'ok', ip });
    if (!activate) {
      // Realtime enforcement: push to all live sessions, then disconnect them. Sessions are NOT revoked so reactivation can auto-restore.
      realtime.publish(target.id, 'account.deactivated', { reason: 'Deactivated by administrator', at: Date.now() });
      setTimeout(() => realtime.disconnectUser(target.id), 200);
    } else {
      realtime.publish(target.id, 'account.reactivated', { at: Date.now() });
    }
    return sendJson(res, 200, { user: users.sanitize(target) });
  }

  if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/password-reset$/)) && method === 'POST') {
    const ctx = requirePerm(req, res, 'users.manage'); if (!ctx) return;
    const target = users.findById(m[1]);
    if (!target || target.deleted) return sendJson(res, 404, { code: 'NOT_FOUND' });
    if (!target.active) return sendJson(res, 409, { code: 'ACCOUNT_DEACTIVATED', message: 'Activate this user before sending a reset link.' });
    if (target.provider !== 'local') return sendJson(res, 409, { code: 'NOT_LOCAL', message: 'Password reset links are only available for local accounts.' });
    if (!target.email) return sendJson(res, 400, { code: 'EMAIL_REQUIRED', message: 'Add an email address before sending a reset link.' });
    users.requirePasswordReset(target.id, true);
    const token = reset.createReset(target.id, { admin: true, by: ctx.user.id });
    const link = `${publicOrigin(req)}/?reset=${encodeURIComponent(token)}`;
    const mail = await sendLinkEmail(target, 'Reset your Upload Doc password', 'Your administrator requested a password reset for your Upload Doc account. Use this link within 1 hour to choose a new password; your old password will not sign you in until this is complete.', 'Choose new password', link);
    audit.record({ action: 'password_reset.admin_request', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: target.id, targetLabel: target.username, outcome: mail.ok ? 'ok' : 'fail', reason: mail.ok ? null : mail.code, ip, userAgent: ua });
    return sendJson(res, 200, { code: 'OK', link, emailed: !!mail.ok, message: mail.ok ? 'Password reset email sent.' : 'Reset link created, but email was not sent. Copy the link and share it securely.', mailCode: mail.code || null });
  }

  if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/login-link$/)) && method === 'POST') {
    const ctx = requirePerm(req, res, 'users.manage'); if (!ctx) return;
    const target = users.findById(m[1]);
    if (!target || target.deleted) return sendJson(res, 404, { code: 'NOT_FOUND' });
    if (!target.active) return sendJson(res, 409, { code: 'ACCOUNT_DEACTIVATED', message: 'Activate this user before sending a sign-in link.' });
    if (target.forcePasswordReset) return sendJson(res, 409, { code: 'PASSWORD_RESET_REQUIRED', message: 'This user must reset their password before using a sign-in link.' });
    if (!target.email) return sendJson(res, 400, { code: 'EMAIL_REQUIRED', message: 'Add an email address before sending a sign-in link.' });
    const token = reset.createLogin(target.id, { admin: true, by: ctx.user.id });
    const link = `${publicOrigin(req)}/?otp=${encodeURIComponent(token)}`;
    const mail = await sendLinkEmail(target, 'Your Upload Doc sign-in link', 'Your administrator sent you a one-time Upload Doc sign-in link. Use this link within 15 minutes to sign in automatically.', 'Sign in to Upload Doc', link);
    audit.record({ action: 'email_login.request', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: target.id, targetLabel: target.username, outcome: mail.ok ? 'ok' : 'fail', reason: mail.ok ? null : mail.code, ip, userAgent: ua });
    return sendJson(res, 200, { code: 'OK', link, emailed: !!mail.ok, message: mail.ok ? 'One-time sign-in email sent.' : 'Sign-in link created, but email was not sent. Copy the link and share it securely.', mailCode: mail.code || null });
  }

  // Soft delete a team member (never a 3rd-party provider). The account is
  // hidden from active rosters and can no longer sign in until restored.
  if ((m = p.match(/^\/api\/admin\/users\/([^/]+)$/)) && method === 'DELETE') {
    const ctx = requirePerm(req, res, 'users.manage'); if (!ctx) return;
    const target = users.findById(m[1]);
    if (!target || target.deleted) return sendJson(res, 404, { code: 'NOT_FOUND' });
    if (target.id === ctx.user.id) return sendJson(res, 409, { code: 'SELF_DELETE', message: 'You cannot delete your own account.' });
    if (!rbac.isTeamRoles(target.roles)) return sendJson(res, 409, { code: 'NOT_TEAM_MEMBER', message: '3rd-party accounts cannot be deleted.' });
    if (target.roles.includes('admin') && users.countActiveAdmins(target.id) === 0) return sendJson(res, 409, { code: 'LAST_ADMIN', message: 'Cannot delete the last administrator.' });
    users.softDelete(target.id, ctx.user);
    audit.record({ action: 'user.deleted', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: target.id, targetLabel: target.username, outcome: 'ok', ip });
    realtime.publish(target.id, 'account.deactivated', { reason: 'Account removed by administrator', at: Date.now() });
    setTimeout(() => realtime.disconnectUser(target.id), 200);
    return sendJson(res, 200, { user: users.sanitize(target) });
  }

  // Restore a soft-deleted account back into the active roster.
  if ((m = p.match(/^\/api\/admin\/users\/([^/]+)\/restore$/)) && method === 'POST') {
    const ctx = requirePerm(req, res, 'users.manage'); if (!ctx) return;
    const target = users.findById(m[1]);
    if (!target || !target.deleted) return sendJson(res, 404, { code: 'NOT_FOUND' });
    users.restore(target.id);
    audit.record({ action: 'user.restored', actorId: ctx.user.id, actorLabel: ctx.user.username, targetId: target.id, targetLabel: target.username, outcome: 'ok', ip });
    realtime.publish(target.id, 'account.reactivated', { at: Date.now() });
    return sendJson(res, 200, { user: users.sanitize(target) });
  }

  /* ----- admin: roles ----- */
  if (p === '/api/admin/roles' && method === 'GET') {
    const ctx = requirePerm(req, res, 'roles.view'); if (!ctx) return;
    return sendJson(res, 200, { roles: rbac.listRoles() });
  }
  if (p === '/api/admin/roles' && method === 'POST') {
    const ctx = requirePerm(req, res, 'roles.manage'); if (!ctx) return;
    const body = await readBody(req);
    const key = String(body.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!key) return sendJson(res, 400, { code: 'VALIDATION', message: 'A role key is required.' });
    const db = store.get();
    if (db.roles.find(r => r.key === key)) return sendJson(res, 409, { code: 'ROLE_EXISTS', message: 'A role with that key already exists.' });
    const role = { key, label: body.label || key, system: false, editable: true, deletable: true };
    db.roles.push(role);
    for (const perm of db.permissions) db.defaultRolePerms.push({ roleKey: key, permKey: perm.key, allowed: Array.isArray(body.permissions) && body.permissions.includes(perm.key) });
    store.save();
    audit.record({ action: 'role.create', actorId: ctx.user.id, actorLabel: ctx.user.username, targetLabel: key, outcome: 'ok', ip });
    return sendJson(res, 201, { role });
  }
  if ((m = p.match(/^\/api\/admin\/roles\/([^/]+)$/)) && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'roles.manage'); if (!ctx) return;
    const body = await readBody(req);
    const role = rbac.getRole(m[1]);
    if (!role) return sendJson(res, 404, { code: 'NOT_FOUND' });
    if (!role.editable) return sendJson(res, 409, { code: 'ROLE_PROTECTED', message: 'This role cannot be edited.' });
    if (body.label) role.label = String(body.label);
    if (Array.isArray(body.permissions)) {
      const db = store.get();
      for (const perm of db.permissions) {
        const row = db.defaultRolePerms.find(d => d.roleKey === role.key && d.permKey === perm.key);
        const allowed = body.permissions.includes(perm.key);
        if (row) row.allowed = allowed; else db.defaultRolePerms.push({ roleKey: role.key, permKey: perm.key, allowed });
      }
    }
    store.save();
    audit.record({ action: 'role.update', actorId: ctx.user.id, actorLabel: ctx.user.username, targetLabel: role.key, outcome: 'ok', ip });
    return sendJson(res, 200, { role });
  }
  if ((m = p.match(/^\/api\/admin\/roles\/([^/]+)$/)) && method === 'DELETE') {
    const ctx = requirePerm(req, res, 'roles.manage'); if (!ctx) return;
    const role = rbac.getRole(m[1]);
    if (!role) return sendJson(res, 404, { code: 'NOT_FOUND' });
    if (!role.deletable) return sendJson(res, 409, { code: 'ROLE_PROTECTED', message: 'This role cannot be deleted.' });
    const assigned = store.get().users.filter(u => u.roles.includes(role.key));
    if (assigned.length) return sendJson(res, 409, { code: 'ROLE_IN_USE', message: `Role is assigned to ${assigned.length} user(s).` });
    const db = store.get();
    db.roles = db.roles.filter(r => r.key !== role.key);
    db.defaultRolePerms = db.defaultRolePerms.filter(d => d.roleKey !== role.key);
    db.permOverrides = db.permOverrides.filter(o => o.roleKey !== role.key);
    store.save();
    audit.record({ action: 'role.delete', actorId: ctx.user.id, actorLabel: ctx.user.username, targetLabel: role.key, outcome: 'ok', ip });
    return sendJson(res, 200, { code: 'OK' });
  }

  /* ----- admin: permissions + overrides ----- */
  if (p === '/api/admin/permissions' && method === 'GET') {
    const ctx = requirePerm(req, res, 'roles.view'); if (!ctx) return;
    return sendJson(res, 200, { permissions: rbac.listPermissions(), matrix: rbac.effectiveMatrix() });
  }
  if (p === '/api/admin/overrides' && method === 'PUT') {
    const ctx = requirePerm(req, res, 'perms.manage'); if (!ctx) return;
    const body = await readBody(req);
    const db = store.get();
    if (!rbac.getRole(body.roleKey) || !db.permissions.find(pp => pp.key === body.permKey)) return sendJson(res, 400, { code: 'VALIDATION' });
    db.permOverrides = db.permOverrides.filter(o => !(o.roleKey === body.roleKey && o.permKey === body.permKey));
    if (body.allowed === true || body.allowed === false) db.permOverrides.push({ roleKey: body.roleKey, permKey: body.permKey, allowed: body.allowed });
    store.save();
    audit.record({ action: 'permission.override', actorId: ctx.user.id, actorLabel: ctx.user.username, targetLabel: `${body.roleKey}:${body.permKey}`, reason: String(body.allowed), outcome: 'ok', ip });
    // Notify affected users so guards re-evaluate.
    for (const u of db.users) if (u.roles.includes(body.roleKey)) realtime.publish(u.id, 'permissions.changed', { role: body.roleKey });
    return sendJson(res, 200, { matrix: rbac.effectiveMatrix() });
  }

  /* ----- admin: LDAP ----- */
  if (p === '/api/admin/ldap' && method === 'GET') {
    const ctx = requirePerm(req, res, 'ldap.manage'); if (!ctx) return;
    const cfg = store.get().ldapConfig;
    const safe = cfg ? Object.assign({}, cfg, { bindPassword: undefined, hasPassword: !!cfg.bindPassword }) : null;
    return sendJson(res, 200, { config: safe });
  }
  if (p === '/api/admin/ldap' && method === 'PUT') {
    const ctx = requirePerm(req, res, 'ldap.manage'); if (!ctx) return;
    const body = await readBody(req);
    const db = store.get();
    const existing = db.ldapConfig || {};
    const cfg = {
      enabled: body.enabled !== false,
      host: body.host || '', port: +body.port || (body.useTLS ? 636 : 389),
      baseDN: body.baseDN || '', bindDN: body.bindDN || '',
      userFilter: body.userFilter || '(userPrincipalName=%u)',
      useTLS: !!body.useTLS, tlsVerify: body.tlsVerify !== false,
      defaultRoles: Array.isArray(body.defaultRoles) && body.defaultRoles.length ? body.defaultRoles : ['staff'],
      // Retain existing encrypted password if omitted in payload.
      // WARNING: Do NOT change the LDAP bind password when testing — repeated
      // updates with a wrong/new password cause directory account lockouts.
      // Leave bindPassword blank in the payload to keep the stored value.
      bindPassword: (body.bindPassword != null && body.bindPassword !== '') ? crypto.encryptSecret(body.bindPassword) : existing.bindPassword || null
    };
    db.ldapConfig = cfg;
    store.save();
    audit.record({ action: 'ldap.config_update', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { host: cfg.host, port: cfg.port, useTLS: cfg.useTLS } });
    return sendJson(res, 200, { config: Object.assign({}, cfg, { bindPassword: undefined, hasPassword: !!cfg.bindPassword }) });
  }
  if (p === '/api/admin/ldap/test' && method === 'POST') {
    const ctx = requirePerm(req, res, 'ldap.manage'); if (!ctx) return;
    const body = await readBody(req);
    const stored = store.get().ldapConfig || {};
    const cfg = Object.assign({}, stored, body);
    if (body.bindPassword == null || body.bindPassword === '') cfg.bindPassword = stored.bindPassword; // use stored (encrypted)
    const result = await ldap.connectionTest(cfg);
    audit.record({ action: 'ldap.connection_test', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: result.status, reason: result.code, ip });
    return sendJson(res, 200, result);
  }

  /* ----- admin: SMTP / email ----- */
  if (p === '/api/admin/smtp' && method === 'GET') {
    const ctx = requirePerm(req, res, 'smtp.manage'); if (!ctx) return;
    const cfg = store.get().smtpConfig;
    const safe = cfg ? Object.assign({}, cfg, { password: undefined, hasPassword: !!cfg.password }) : null;
    return sendJson(res, 200, { config: safe, providers: Object.keys(mailer.PRESETS) });
  }
  if (p === '/api/admin/smtp' && method === 'PUT') {
    const ctx = requirePerm(req, res, 'smtp.manage'); if (!ctx) return;
    const body = await readBody(req);
    const db = store.get();
    const existing = db.smtpConfig || {};
    const preset = mailer.presetFor(body.provider) || {};
    const secure = body.secure != null ? !!body.secure : (existing.secure != null ? existing.secure : !!preset.secure);
    const cfg = {
      enabled: body.enabled !== false,
      provider: body.provider || existing.provider || 'custom',
      host: (body.host || preset.host || existing.host || '').trim(),
      port: +body.port || preset.port || existing.port || (secure ? 465 : 587),
      secure,
      username: (body.username != null ? body.username : (preset.username || existing.username || '')).trim(),
      fromEmail: (body.fromEmail || existing.fromEmail || '').trim(),
      fromName: (body.fromName || existing.fromName || '').trim(),
      tlsVerify: body.tlsVerify !== false,
      // Retain existing encrypted password when omitted (blank keeps the stored value).
      password: (body.password != null && body.password !== '') ? crypto.encryptSecret(body.password) : (existing.password || null)
    };
    db.smtpConfig = cfg;
    store.save();
    audit.record({ action: 'smtp.config_update', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { host: cfg.host, port: cfg.port, secure: cfg.secure, from: cfg.fromEmail } });
    return sendJson(res, 200, { config: Object.assign({}, cfg, { password: undefined, hasPassword: !!cfg.password }) });
  }
  if (p === '/api/admin/smtp/test' && method === 'POST') {
    const ctx = requirePerm(req, res, 'smtp.manage'); if (!ctx) return;
    const body = await readBody(req);
    const stored = store.get().smtpConfig || {};
    const preset = mailer.presetFor(body.provider) || {};
    const runtime = {
      provider: body.provider || stored.provider || 'custom',
      host: (body.host || preset.host || stored.host || '').trim(),
      port: +body.port || preset.port || stored.port || (body.secure ? 465 : 587),
      secure: body.secure != null ? !!body.secure : (stored.secure != null ? stored.secure : !!preset.secure),
      username: (body.username != null ? body.username : (preset.username || stored.username || '')).trim(),
      fromEmail: (body.fromEmail || stored.fromEmail || '').trim(),
      fromName: (body.fromName || stored.fromName || '').trim(),
      tlsVerify: body.tlsVerify !== false,
      password: (body.password != null && body.password !== '') ? body.password
        : (crypto.isEncrypted(stored.password) ? crypto.decryptSecret(stored.password) : stored.password)
    };
    const to = (body.testTo || runtime.fromEmail || '').trim();
    const result = await mailer.connectionTest(runtime, to);
    audit.record({ action: 'smtp.connection_test', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: result.status, reason: result.code, ip, meta: { to } });
    return sendJson(res, 200, result);
  }

  /* ----- admin: document catalogs ----- */
  const catAdmin = p.startsWith('/api/admin/internal-catalog')
    ? { base: '/api/admin/internal-catalog', scope: 'internal', audit: 'internal_catalog' }
    : (p.startsWith('/api/admin/catalog') ? { base: '/api/admin/catalog', scope: 'provider', audit: 'catalog' } : null);
  const catPath = catAdmin ? (p.slice(catAdmin.base.length) || '') : '';
  if (catAdmin && catPath === '' && method === 'GET') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    return sendJson(res, 200, { catalog: catalog.publicCatalog(catAdmin.scope), expiryModes: catalog.EXPIRY_MODES, types: catalog.TYPES, fieldTypes: catalog.FIELD_TYPES });
  }
  if (catAdmin && catPath === '/sections' && method === 'POST') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const body = await readBody(req);
    if (!String(body.title || '').trim()) return sendJson(res, 400, { code: 'VALIDATION', message: 'Section title is required.' });
    const s = catalog.addSection(body.title, catAdmin.scope);
    audit.record({ action: catAdmin.audit + '.section_add', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: s.id, title: s.title } });
    return sendJson(res, 201, { code: 'OK', section: s, catalog: catalog.publicCatalog(catAdmin.scope) });
  }
  // Reorder all sections to an explicit id list (drag-and-drop). Must be checked
  // before the "/sections/:id" route so "reorder" isn't treated as a section id.
  if (catAdmin && catPath === '/sections/reorder' && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const body = await readBody(req);
    if (!catalog.reorderSections(body.order, catAdmin.scope)) return sendJson(res, 400, { code: 'VALIDATION', message: 'order must be an array of section ids.' });
    audit.record({ action: catAdmin.audit + '.section_reorder', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { count: (body.order || []).length } });
    return sendJson(res, 200, { code: 'OK', catalog: catalog.publicCatalog(catAdmin.scope) });
  }
  if (catAdmin && (m = catPath.match(/^\/sections\/([A-Za-z0-9-]+)$/)) && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const body = await readBody(req);
    const s = catalog.updateSection(m[1], body, catAdmin.scope);
    if (!s) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Section not found.' });
    audit.record({ action: catAdmin.audit + '.section_update', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: s.id } });
    return sendJson(res, 200, { code: 'OK', catalog: catalog.publicCatalog(catAdmin.scope) });
  }
  if (catAdmin && (m = catPath.match(/^\/sections\/([A-Za-z0-9-]+)$/)) && method === 'DELETE') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const ok = catalog.deleteSection(m[1], catAdmin.scope);
    if (!ok) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Section not found.' });
    audit.record({ action: catAdmin.audit + '.section_delete', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: m[1] } });
    return sendJson(res, 200, { code: 'OK', catalog: catalog.publicCatalog(catAdmin.scope) });
  }
  // Move a section one step up/down in the checklist (applies to all providers).
  if (catAdmin && (m = catPath.match(/^\/sections\/([A-Za-z0-9-]+)\/move$/)) && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const body = await readBody(req);
    const ok = catalog.moveSection(m[1], body.dir === 'up' ? 'up' : 'down', catAdmin.scope);
    if (!ok) return sendJson(res, 400, { code: 'NO_MOVE', message: 'Section could not be moved.' });
    audit.record({ action: catAdmin.audit + '.section_move', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: m[1], dir: body.dir } });
    return sendJson(res, 200, { code: 'OK', catalog: catalog.publicCatalog(catAdmin.scope) });
  }
  if (catAdmin && (m = catPath.match(/^\/sections\/([A-Za-z0-9-]+)\/items$/)) && method === 'POST') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const body = await readBody(req);
    if (!String(body.name || '').trim()) return sendJson(res, 400, { code: 'VALIDATION', message: 'Document name is required.' });
    const it = catalog.addItem(m[1], body, catAdmin.scope);
    if (!it) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Section not found.' });
    audit.record({ action: catAdmin.audit + '.item_add', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { key: it.key, name: it.name } });
    return sendJson(res, 201, { code: 'OK', item: it, catalog: catalog.publicCatalog(catAdmin.scope) });
  }
  // Reorder documents within a section to an explicit key list (drag-and-drop).
  if (catAdmin && (m = catPath.match(/^\/sections\/([A-Za-z0-9-]+)\/items\/reorder$/)) && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const body = await readBody(req);
    if (!catalog.reorderItems(m[1], body.order, catAdmin.scope)) return sendJson(res, 400, { code: 'VALIDATION', message: 'order must be an array of document keys.' });
    audit.record({ action: catAdmin.audit + '.item_reorder', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { sectionId: m[1] } });
    return sendJson(res, 200, { code: 'OK', catalog: catalog.publicCatalog(catAdmin.scope) });
  }
  // Move a document one step up/down within its section.
  if (catAdmin && (m = catPath.match(/^\/items\/([A-Za-z0-9_]+)\/move$/)) && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const body = await readBody(req);
    const ok = catalog.moveItem(m[1], body.dir === 'up' ? 'up' : 'down', catAdmin.scope);
    if (!ok) return sendJson(res, 400, { code: 'NO_MOVE', message: 'Document could not be moved.' });
    audit.record({ action: catAdmin.audit + '.item_move', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { key: m[1], dir: body.dir } });
    return sendJson(res, 200, { code: 'OK', catalog: catalog.publicCatalog(catAdmin.scope) });
  }
  if (catAdmin && (m = catPath.match(/^\/items\/([A-Za-z0-9_]+)$/)) && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const body = await readBody(req);
    const it = catalog.updateItem(m[1], body, catAdmin.scope);
    if (!it) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Document not found.' });
    audit.record({ action: catAdmin.audit + '.item_update', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { key: it.key } });
    return sendJson(res, 200, { code: 'OK', item: it, catalog: catalog.publicCatalog(catAdmin.scope) });
  }
  if (catAdmin && (m = catPath.match(/^\/items\/([A-Za-z0-9_]+)$/)) && method === 'DELETE') {
    const ctx = requirePerm(req, res, 'catalog.manage'); if (!ctx) return;
    const ok = catalog.deleteItem(m[1], catAdmin.scope);
    if (!ok) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Document not found.' });
    audit.record({ action: catAdmin.audit + '.item_delete', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { key: m[1] } });
    return sendJson(res, 200, { code: 'OK', catalog: catalog.publicCatalog(catAdmin.scope) });
  }

  /* ----- admin: branding, legal pages & assets -----
     NOTE on ordering: every literal path below is matched before the
     parameterised /assets/:id patterns. A parametric route registered first
     swallows its own literal siblings ("assets/reorder" read as an id), which
     is a 404 that looks like a missing feature rather than a routing bug. */
  if (p === '/api/admin/branding' && method === 'GET') {
    const ctx = requirePerm(req, res, 'branding.manage'); if (!ctx) return;
    return sendJson(res, 200, { branding: branding.adminView() });
  }

  if (p === '/api/admin/branding' && method === 'PUT') {
    const ctx = requirePerm(req, res, 'branding.manage'); if (!ctx) return;
    const body = await readBody(req);
    try {
      const view = branding.updateIdentity(body, ctx.user.username);
      audit.record({ action: 'branding.update', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { fields: Object.keys(body || {}) } });
      return sendJson(res, 200, { code: 'OK', branding: view });
    } catch (e) {
      if (e.code === 'VALIDATION') return sendJson(res, 400, { code: 'VALIDATION', message: e.detail || 'Invalid branding settings.' });
      if (e.code === 'NOT_FOUND') return sendJson(res, 404, { code: 'NOT_FOUND', message: e.detail || 'Asset not found.' });
      throw e;
    }
  }

  if ((m = p.match(/^\/api\/admin\/branding\/pages\/([a-z-]+)$/)) && method === 'PUT') {
    const ctx = requirePerm(req, res, 'branding.manage'); if (!ctx) return;
    const body = await readBody(req);
    try {
      const pg = branding.updatePage(m[1], body, ctx.user.username);
      audit.record({ action: 'branding.page_update', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { slug: m[1] } });
      return sendJson(res, 200, { code: 'OK', page: pg });
    } catch (e) {
      if (e.code === 'VALIDATION') return sendJson(res, 400, { code: 'VALIDATION', message: e.detail || 'Invalid page.' });
      if (e.code === 'NOT_FOUND') return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Page not found.' });
      throw e;
    }
  }

  if ((m = p.match(/^\/api\/admin\/branding\/pages\/([a-z-]+)\/reset$/)) && method === 'POST') {
    const ctx = requirePerm(req, res, 'branding.manage'); if (!ctx) return;
    try {
      const pg = branding.resetPage(m[1]);
      audit.record({ action: 'branding.page_reset', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { slug: m[1] } });
      return sendJson(res, 200, { code: 'OK', page: pg });
    } catch (e) {
      if (e.code === 'NOT_FOUND') return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Page not found.' });
      throw e;
    }
  }

  if (p === '/api/admin/branding/assets' && method === 'GET') {
    const ctx = requirePerm(req, res, 'branding.manage'); if (!ctx) return;
    return sendJson(res, 200, { assets: branding.adminView().assets });
  }

  // Raw-binary upload, same shape as /api/files: bytes in the body, original
  // name in X-Filename. The up-front drain in the server entry point only runs
  // for JSON routes, so this reads the stream itself.
  if (p === '/api/admin/branding/assets' && method === 'POST') {
    const ctx = requirePerm(req, res, 'branding.manage'); if (!ctx) return;
    try {
      const asset = await branding.saveAsset(req, {
        filename: req.headers['x-filename'],
        mime: req.headers['content-type'],
        kind: req.headers['x-asset-kind'],
        alt: req.headers['x-asset-alt'] ? decodeURIComponent(req.headers['x-asset-alt']) : '',
        key: req.headers['x-asset-key'],
        actor: ctx.user.username
      });
      audit.record({ action: 'branding.asset_upload', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: asset.id, kind: asset.kind, name: asset.name } });
      return sendJson(res, 201, { code: 'OK', asset, branding: branding.adminView() });
    } catch (e) {
      if (e.code === 'UNSUPPORTED_TYPE') return sendJson(res, 415, { code: 'UNSUPPORTED_TYPE', message: 'That file type cannot be used as an asset.' });
      if (e.code === 'TOO_LARGE') return sendJson(res, 413, { code: 'TOO_LARGE', message: 'That file is too large.' });
      if (e.code === 'EMPTY') return sendJson(res, 400, { code: 'VALIDATION', message: 'The uploaded file was empty.' });
      throw e;
    }
  }

  if ((m = p.match(/^\/api\/admin\/branding\/assets\/([A-Za-z0-9-]+)$/)) && method === 'PATCH') {
    const ctx = requirePerm(req, res, 'branding.manage'); if (!ctx) return;
    const body = await readBody(req);
    try {
      const asset = branding.updateAsset(m[1], body);
      audit.record({ action: 'branding.asset_update', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: m[1] } });
      return sendJson(res, 200, { code: 'OK', asset, branding: branding.adminView() });
    } catch (e) {
      if (e.code === 'NOT_FOUND') return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Asset not found.' });
      throw e;
    }
  }

  if ((m = p.match(/^\/api\/admin\/branding\/assets\/([A-Za-z0-9-]+)$/)) && method === 'DELETE') {
    const ctx = requirePerm(req, res, 'branding.manage'); if (!ctx) return;
    const removed = branding.removeAsset(m[1]);
    if (!removed) return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Asset not found.' });
    audit.record({ action: 'branding.asset_delete', actorId: ctx.user.id, actorLabel: ctx.user.username, outcome: 'ok', ip, meta: { id: m[1], name: removed.name } });
    return sendJson(res, 200, { code: 'OK', branding: branding.adminView() });
  }

  /* ----- admin: audit ----- */
  if (p === '/api/admin/audit' && method === 'GET') {
    const ctx = requirePerm(req, res, 'audit.view'); if (!ctx) return;
    return sendJson(res, 200, { events: audit.list({}, 300) });
  }

  return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Unknown endpoint.' });
}

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`Credentialing portal listening on http://0.0.0.0:${PORT}`));
}
module.exports = { server, api };
