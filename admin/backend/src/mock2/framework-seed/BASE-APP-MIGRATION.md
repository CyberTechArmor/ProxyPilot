# Base app template — migration note

What changed when ProxyPilot's standard base application was refreshed to the
new "Upload Doc" codebase, so an existing project can be diffed against it.

The core contract is unchanged: **auth + LDAP + RBAC + lifecycle + SSE + JSON
store**, machine-readable outcome codes, HMAC access token + rotating refresh
with family reuse detection. A project built on the previous base does not have
to move; this note exists so you can see exactly what you would gain.

---

## 1. Security fixes — these are the reason not to keep running the old base

Four of these were real holes in the incoming codebase and are fixed **in the
template**, not left to each project to rediscover. Each has an acceptance test
(`test/run.js`, the `SECURITY:` cases) that fails if the fix is reverted.

| # | Was | Now |
| --- | --- | --- |
| 1 | **Unauthenticated account takeover.** `POST /api/auth/set-password` accepted `{login, newPassword}` and asked only that the account still had `mustSetPassword`. Anyone who knew or guessed the username of a provisioned account could claim it and was handed a session. | Requires proof of identity: a single-use setup/reset **token** (the account is identified *by the token*, so a caller cannot aim it at someone else) **or** the temporary password. Rate limited; failures are deliberately vague. |
| 2 | **Host-header poisoning of emailed links.** `publicOrigin()` trusted `X-Forwarded-Host`/`Host`, so an attacker could trigger a reset for a victim and have the genuine email carry a link to the attacker's domain. | `APP_BASE_URL` is authoritative for every emailed link. Header derivation survives only in development, and production **refuses** to mint a link when it is unset. |
| 3 | **Session cookies never got `Secure`.** | Set when the request arrived over TLS (directly or via `X-Forwarded-Proto`), or when `FORCE_SECURE_COOKIES=1`. `HttpOnly` + `SameSite=Lax` unchanged. |
| 4 | **`clientIp()` trusted `X-Forwarded-For` unconditionally**, so spoofing it rotated identity and bypassed every IP-keyed rate limit. | Honoured only behind `TRUSTED_PROXY=1`; otherwise the socket address is used. |
| 5 | **Sessions accumulated forever** in the JSON store (resets were pruned; sessions were not), and every mutation rewrites the whole file. | Pruned on session create and on rotation, with a grace window (`SESSION_PRUNE_GRACE_MS`, default 24 h) so reuse detection still recognises a stolen token's family. |

Also fixed while integrating:

- **Client-side HTML escapers missed quotes.** Both `public/portal.js` and
  `public/app.js` escaped only `& < > "`. Values that reach an attribute context
  could break out with a single quote. Both now escape `'` as well. (The review
  believed `app.js` already covered it; it did not.)

## 2. A robustness bug found while bringing the suite up

The vendored acceptance suite failed **9 of 21** checks out of the box with
`socket hang up`. Root cause: the harness called `req('GET', path, null, …)`,
and `JSON.stringify(null)` is the 4-byte string `"null"` — so those GETs carried
a chunked body. Nothing consumed it, the parser stayed mid-message, and the
*next* request on that keep-alive socket was rejected with
`Parse Error: Invalid method encountered`. Node's own HTTP client has had
keep-alive on by default since v19, so this is not a test-only artifact.

Fixed in the harness (send no body when there is none), and the server was
hardened independently so the class cannot recur:

- **The request body is consumed once, up front**, keyed on *framing*
  (`Content-Length` / `Transfer-Encoding`) rather than on the method, and cached
  for whichever route wants it. Routes that answer without reading a body — an
  auth guard rejecting early, `POST .../password-reset`, a 404 — can no longer
  strand bytes in the socket. Draining afterwards races the response that was
  already sent; draining first is deterministic.
- **`sendJson` now sets `Content-Length`** (byte length, not character length),
  instead of falling back to chunked encoding for every reply.

Suite is now **25/25**, including the four new `SECURITY:` regressions.

## 3. Features present in this base that the previous one lacked or did poorly

- **Microsoft Office viewing in a new tab** — `GET /api/files/:id/office-url`
  returns a short-lived HMAC-signed public URL (15 min, office extensions only,
  permission-checked) which the client hands to Microsoft's free viewer using the
  popup-blocker-safe pattern (synchronously open `about:blank`, sever `opener`,
  `location.replace` after the async fetch, close + toast on failure).
  **The app must be internet-reachable** for the viewer to fetch the file.
- **Document viewer** with carousel, inline images / PDF iframe, 50–400% zoom
  that mutates the transform without re-rendering (so scroll survives), and the
  ZIP packet download (summary PDF via `pdf-lib` + files via `jszip`).
- **Custom date picker** (`openCalendar`) with month/year drill-down, live
  long-form readout, confirm-then-commit and timezone-safe ISO handling — shared
  by both the portal and the admin console.
- **Admin console**: soft delete + restore (team only), admin-issued reset and
  one-time login links (emailed, or shown once with copy-to-clipboard), the
  tri-state permission override matrix pushed live over SSE, LDAP config with
  encrypted-at-rest bind password and the "leave blank to keep saved value"
  pattern, SMTP provider presets with an HTTPS API fallback, two independently
  managed document catalogs with drag-and-drop ordering and per-section gating,
  and the structured audit log.
- **Multi-audience auth**: external self-signup vs admin-provisioned internal
  users, first-login `mustSetPassword`, admin-forced reset, email OTP sign-in.

## 4. What to check when diffing an existing project against this base

1. Does `POST /api/auth/set-password` still accept a bare `{login,newPassword}`?
   If yes, it is vulnerable — take fix #1 first.
2. Is `APP_BASE_URL` set in the deployment? Emailed links are unsafe without it.
3. Are `TRUSTED_PROXY` / `FORCE_SECURE_COOKIES` set correctly for the topology?
4. Do the client escapers cover `'`?
5. Is anything relying on `lib/store.js` at a scale it cannot carry (see the
   RUNBOOK's scaling-ceiling note)?
