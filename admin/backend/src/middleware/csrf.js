// Double-submit-cookie CSRF protection. Backend sets two cookies on
// login: pp_token (HttpOnly, session JWT) and pp_csrf (NOT HttpOnly,
// readable by JS). Frontend echoes pp_csrf back as the X-CSRF-Token
// header on every state-changing request. This middleware compares
// the header to the cookie — if they match, the request was made by
// JS that can read same-origin cookies, i.e. our own frontend.
//
// SameSite=Strict on the cookies already prevents most cross-site
// abuse; CSRF check is defense in depth for browsers that don't
// honor SameSite or for misconfigured deployments.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Routes that legitimately receive state-changing POSTs without an
// established session — initial login flow, password setup, TOTP
// enrolment. They have no pp_csrf cookie yet so we can't enforce.
// All of these are also covered by the per-endpoint rate-limiters
// in index.js to limit pre-auth abuse.
const CSRF_EXEMPT_PREFIXES = [
  '/api/auth/login',
  '/api/auth/initial-setup',
  '/api/auth/complete-totp-setup',
  '/api/auth/setup-status',
  // Passkey login is the WebAuthn equivalent of /login: callers don't
  // yet have a session and therefore can't have a pp_csrf cookie.
  // The challenge (returned from /begin, echoed back to /verify) is
  // the binding token here — no CSRF cookie is necessary.
  '/api/auth/passkey/authenticate/begin',
  '/api/auth/passkey/authenticate/verify',
  // Mock2 quick connect: git smart-HTTP endpoints (VS Code / git CLI).
  // Auth is a per-user connect token over HTTP Basic — no ambient cookies
  // are involved, so a cross-site request can't ride a session and the
  // double-submit check has nothing to protect (git clients also cannot
  // echo a CSRF header).
  '/api/mock2/git/',
  // Remote MCP server: auth is a per-token bearer secret (header or
  // tokenized URL) — no ambient cookies are involved, so a cross-site
  // request can't ride a session and the double-submit check has nothing
  // to protect (MCP clients also cannot echo a CSRF header). The upload
  // endpoint's ticket is minted over the same authenticated channel.
  // Deliberately '/api/mcp/' + the exact-path check below — a bare
  // '/api/mcp' prefix would also exempt /api/mcp-tokens (cookie-session
  // admin endpoints that MUST keep double-submit protection).
  '/api/mcp/',
  // Delegated editing endpoint — same rationale, same shape: a per-key bearer
  // secret in a header or a tokenized URL, no ambient cookies. '/api/mcp-editor/'
  // with the trailing slash covers /t/<token>; the bare path is handled by the
  // exact-match check below, so '/api/lxc-editor' (cookie-session admin) keeps
  // full double-submit protection.
  '/api/mcp-editor/',
];

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Use req.originalUrl rather than req.path: this middleware is
  // mounted on '/api/' in index.js, which means Express strips the
  // mount prefix from req.path. The exempt list above carries the
  // full '/api/...' paths so the comparison must be against the full
  // original URL. (req.originalUrl includes query strings; startsWith
  // on a path prefix is unaffected by them.)
  for (const prefix of CSRF_EXEMPT_PREFIXES) {
    if (req.originalUrl.startsWith(prefix)) return next();
  }

  // The MCP endpoint itself (POST /api/mcp with a Bearer token, no trailing
  // path) — exact match, so /api/mcp-tokens stays protected.
  if (req.originalUrl === '/api/mcp' || req.originalUrl.startsWith('/api/mcp?')) {
    return next();
  }
  if (req.originalUrl === '/api/mcp-editor' || req.originalUrl.startsWith('/api/mcp-editor?')) {
    return next();
  }

  // Domain provisioning is dual-auth: an X-API-Key request carries no
  // ambient cookies (the key header is the binding token — same rationale
  // as the mock2 git endpoints), so it is exempt ONLY when that header is
  // actually present. The admin cookie-session path through the very same
  // endpoints keeps full double-submit protection below.
  if (req.originalUrl.startsWith('/api/domains/provision') && req.headers['x-api-key']) {
    return next();
  }

  const cookieValue = req.cookies?.pp_csrf;
  const headerValue = req.headers['x-csrf-token'];

  if (!cookieValue || !headerValue || cookieValue !== headerValue) {
    return res.status(403).json({ error: 'CSRF token missing or invalid' });
  }
  next();
}
