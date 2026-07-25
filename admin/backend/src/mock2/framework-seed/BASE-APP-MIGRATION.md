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

---

## 5. Added since the re-vendor

### Light / dark theme

`public/theme.js` carries a three-state preference — `system` (default),
`light`, `dark` — under the `ud-theme` key. It is loaded **synchronously and
before the stylesheet** in `index.html`: a deferred script applies the theme
after first paint, which shows a dark-mode user a white flash on every single
page load. `style.css` declares the palette twice, `:root` and
`[data-theme="dark"]`, and both set `color-scheme` so native form controls and
scrollbars follow.

Two rules for anyone extending the stylesheet:

- **Surfaces use `var(--surface)`, never `var(--white)`.** `--white` is literal
  white in *both* themes on purpose — it is for text and icons sitting on a
  solid coloured fill. Using it as a background leaves that element white in
  dark mode. A test pins this.
- Toggles are wired by **delegation**, not per-render binding. The auth layout
  renders from five separate call sites; binding in each one means the sixth is
  silently broken.

### Mobile

Breakpoints at 901 / 900 / 768 / 640 / 400px, single-column grids below 768,
and a `min-height:44px` floor on controls at phone widths. `prefers-reduced-
motion` is honoured globally.

One fix worth knowing about: the `@media(max-width:768px)` block used to set
`.split .left{position:static}`. The decorative `.glow` is absolutely
positioned inside `.left` and clipped by its `overflow:hidden` — a *static*
`.left` hands the glow the initial containing block, it escapes the clip, and
the page scrolled sideways by 120px on every phone. Only the brand needed to go
static.

### Branding, legal pages and assets — `lib/branding.js`

New `branding.manage` permission (admin by default), a `branding` slice in the
JSON store, and asset bytes on disk under `data/branding/`.

- **Public, no session:** `GET /api/branding`, `GET /api/legal/:slug`,
  `GET /api/branding/assets/:id`, and `GET /favicon.ico`. These render on the
  sign-in screen, so an auth guard on them is a bug — a test asserts they are
  registered before the gated routes and call neither `requireAuth` nor
  `requirePerm`.
- **Admin:** `GET|PUT /api/admin/branding`, `PUT /api/admin/branding/pages/:slug`
  (+ `/reset` to restore the shipped copy), and CRUD on
  `/api/admin/branding/assets`.
- The sign-in screen and the app shell both render a footer: Privacy Policy and
  Terms & Conditions as real buttons, plus the copyright notice. **The year is
  computed on read, never stored** — on the server and again on the client, so
  a tab left open across New Year corrects itself.
- Privacy and Terms ship with generic, jurisdiction-neutral copy so a fresh app
  is not serving a dead link. `{{ORG}}` is substituted at read time, so renaming
  the organisation updates the legal text too.
- Page bodies are a tiny block syntax (`## ` heading, `- ` bullet, blank-line
  paragraph) that is **escaped first, then wrapped**. Raw HTML from the store
  never reaches `innerHTML` — otherwise an admin could turn the unauthenticated
  privacy page into a script host.
- **The favicon falls back to the logo** when none was uploaded, and deleting an
  asset clears both pointers so the fallback can never dangle to a 404.
- Assets are served with a fixed `Content-Type`, `nosniff`, and
  `Content-Security-Policy: default-src 'none'; sandbox`. SVG is allowed *only*
  because of those headers; HTML is not a storable type at all.

### `appContext` — a contract for every build

`branding.appContext` is `{ summary, audience, features: [{title, detail}] }`,
editable under **Admin console → Branding & Content → About this app**.

**Every build that adds or changes a user- or admin-facing capability should
update it.** Record *what a person can now do* — "Administrators can export the
audit log as CSV" — not why it was built, who asked for it, or how it was
implemented. End users read this text on the sign-in screen; rationale and
internal history do not belong in it.


---

## 6. PostgreSQL, the machine API, and read-only SQL

### The store moved to PostgreSQL

The JSON file is gone. `lib/db.js` owns the pool and the schema; `lib/store.js`
loads the dataset into memory once at boot and writes through to Postgres.

`store.get()` is still **synchronous**, deliberately — that is what let every
`lib/` module stay byte-identical instead of becoming a whole-application
rewrite with the acceptance suite as the only safety net. The cost is that the
dataset must be loaded before the first request, so `server.js` now has an async
`boot()` and only calls `listen()` once it resolves.

`store.save('files')` names the slice that changed; `store.save()` with no
argument rewrites everything (always correct, just slower). `audit` is
append-only through `store.appendAudit()` — the in-memory list is a trimmed
5000-entry window while the table is the permanent archive, so rewriting the
section from memory would delete history.

**The failure mode to know about.** A failed write is logged and swallowed; the
process keeps serving from memory. That means a schema mistake is invisible to
the API. It is not hypothetical — `password_resets.expires_at` was typed
`bigint` while `lib/reset.js` stores an ISO string, and every acceptance test
passed while nothing persisted. The suite now reads the database directly
(`PERSISTENCE:`) instead of trusting the API's answers. Keep that test.

### API keys — the app is now consumable by other applications

Layered onto the SAME `requireAuth` / `requirePerm` the UI already goes through,
not a parallel `/v1` surface. Every existing endpoint became machine-callable
with exactly the permission check it already had, and a route cannot end up open
to machines but closed to people because there is only one check.

- Keys carry a subset of the **same RBAC permissions people hold** — no second
  scope vocabulary to drift out of sync.
- A key can never be granted a permission its issuer lacks, and its permissions
  are re-intersected with its owner's **current** rights on every request:
  deactivate the person and their integrations stop.
- The token is shown once; only a SHA-256 hash is stored. Revoking clears the
  hash entirely.
- A key cannot change a password or mint another key (`allowKey: false`), so a
  machine credential can neither take over its account nor make revocation
  unwinnable.
- `GET /api/meta` publishes the capability index without auth — a consumer needs
  it *before* they have a key. `GET /api/whoami` checks a credential.

### Read-only SQL

For the questions that are far cheaper as a join than as N+1 API calls. Consumers
get a SELECT-only Postgres role on curated views in the `api_read` schema.

**Views, never base tables** — and that is the whole safety story. `users.data`
holds `passwordHash`; `sessions` holds `refresh_hash`; `api_keys` holds
`token_hash`; `app_documents` holds the encrypted LDAP bind and SMTP passwords. A
blanket `GRANT SELECT ON ALL TABLES` would hand every reporting consumer the
password hashes. The role is granted on the views only, `REVOKE ALL ON SCHEMA
public` is explicit, and default privileges are never widened to base tables, so
adding a table later does not silently expose it.

Issuing rotates: the previous password stops working immediately, which is the
revocation story. The app needs `CREATEROLE` (never superuser) to manage the
credential itself; where that is not granted it returns a 409 naming the exact
statement to run, and `scripts/provision-readonly.sql` is the DBA path.

### What to check when adopting this

1. `DATABASE_URL` is set, and the database exists.
2. The acceptance suite needs `TEST_DATABASE_URL` pointing at a **throwaway**
   database — it truncates every table on start.
3. If you want in-app management of read-only access: `ALTER ROLE <app_role>
   CREATEROLE;`
4. Do not run more than one process against this: the read model, the rate
   limiter and the SSE hub are all per-process.
