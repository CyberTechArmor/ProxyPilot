# Upload Doc — Auth + LDAP + RBAC + Lifecycle

**This is ProxyPilot's standard base application template.** A generated project
starts from this tree, so auth, LDAP, RBAC, the admin console, the lifecycle and
the realtime hub cost nothing per project — build effort goes into the new
feature, not the plumbing. The matching default look is
`framework-seed/design-brief.md` (default, never forced — a project's own design
direction always wins).

Near-zero dependency Node.js implementation (Node built-ins plus `jszip` and
`pdf-lib` for the packet download). Runnable module lives here on the app host.

## Required configuration (read this before deploying)

| Env var | Why it matters |
| --- | --- |
| `APP_BASE_URL` | **Required in production.** The canonical public origin (e.g. `https://portal.example.com`). Every emailed sign-in / password-reset link is built from it. Without it the app refuses to mint links in production rather than trust a request header an attacker can forge. |
| `FORCE_SECURE_COOKIES=1` | Set when a TLS-terminating proxy fronts the app over plain HTTP, so session cookies still get `Secure`. Detected automatically when the request itself is HTTPS or carries `X-Forwarded-Proto: https`. |
| `TRUSTED_PROXY=1` | Set **only** when a trusted proxy sets `X-Forwarded-For`. Off by default: otherwise anyone can spoof the header to rotate identity and walk straight past the IP-keyed rate limits. |
| `PORT` | Listen port (default 6525). |
| `DATABASE_URL` | **Required.** PostgreSQL is the system of record. |
| `APP_DATA_DIR` | Where uploaded bytes, branding assets and `secret.key` live. The dataset itself is in PostgreSQL. |
| `READONLY_DB_ROLE` | Name of the SELECT-only role issued for reporting consumers (default `app_readonly`). |
| `SESSION_PRUNE_GRACE_MS` | How long settled (revoked/expired) sessions are retained for reuse detection before pruning. Default 24 h. |

## Storage — how it actually works

PostgreSQL is the system of record. `lib/store.js` loads the dataset into memory
once at boot (`store.init()`, before the server listens) and serves reads from
there, so every module keeps a **synchronous** `store.get()`. Mutations write
through to Postgres asynchronously on one serialised chain — the same
fire-and-forget contract the old JSON file had.

`store.save('files')` names the slice that changed so a hot path rewrites one
table instead of all of them. Calling `store.save()` with no argument rewrites
everything: always correct, just slower. `audit` is the exception — it is
append-only via `store.appendAudit()`, because the in-memory list is a trimmed
recent window while the table is the permanent archive.

**Still single-process.** The in-memory rate limiter and the SSE hub are
per-process, and so is the read model: a second worker would not see another
worker's writes until it restarted. Do not scale horizontally without replacing
the read model, the limiter and the hub together.

**A failed write does not surface to the caller.** It is logged
(`[store] persist failed: …`) and the process keeps serving from memory. That
makes a schema mistake invisible to the API, which is exactly how a wrong column
type once shipped silently — so the acceptance suite reads the database directly
(`PERSISTENCE:`) rather than trusting the API's answers.

## Integration — other applications

Everything the UI can do, a machine can do, through the **same endpoints and the
same permission checks**. There is no separate `/v1` surface to drift.

- `GET /api/meta` — the capability index. Readable without a key, because a
  consumer needs it before they have one.
- `GET /api/whoami` — check a credential and list what it may do.
- **API keys** (`Authorization: Bearer …`, or `X-API-Key` for tooling that
  cannot set Authorization). A key carries a subset of the *same* RBAC
  permissions people hold, is intersected with its owner's current rights on
  every request (deactivate the person, the keys die), and can never be granted
  a permission its issuer lacks. The token is shown once. Keys cannot change a
  password or mint another key.
- **Read-only SQL** for the questions that are far cheaper as a join than as
  N+1 API calls. Consumers get a SELECT-only role on curated views in the
  `api_read` schema — never the base tables, which hold password hashes,
  refresh-token hashes and encrypted bind passwords. Issue/rotate it from
  Admin → Integration, or by hand with `scripts/provision-readonly.sql`.
  Rotation is the revocation story: the old password stops working at once.

## Layout
- `server.js` — HTTP router, guards, static SPA host, SSE endpoint
- `lib/crypto.js` — scrypt password hashing, AES-256-GCM secret encryption, tokens
- `lib/db.js` — PostgreSQL pool, schema, and a clear "cannot reach the database" failure
- `lib/store.js` — the in-memory read model + section-scoped write-through to Postgres
- `lib/api-keys.js` — machine credentials: mint, verify, revoke; permissions from the RBAC catalog
- `lib/readonly.js` — the SELECT-only role and the curated `api_read` views
- `lib/session.js` — access token (HMAC) + rotating refresh, idle + absolute expiry, reuse detection
- `lib/rbac.js` — DB-driven roles/permissions, default map + overrides, effective authorization
- `lib/users.js`, `lib/auth.js` — user lifecycle + local→LDAP auth, machine codes, super-admin setup
- `lib/ldap.js` — dependency-free LDAPv3 simple bind + search + structured connection test
- `lib/realtime.js` — SSE hub (per-user channels); contract `publish(userId,event,data)` swappable for WebSocket
- `lib/audit.js`, `lib/ratelimit.js` — audit trail + sliding-window login limiter
- `public/` — SPA: setup wizard, login, set-password, MFA, deactivated page, portal, admin console
- `test/run.js` — acceptance suite (includes the security regressions below)

## Known limits (deliberate, documented, not bugs)

- **MFA is a stub.** `mfaRequired` gates login and the UI shows a code screen,
  but there is no verification endpoint. The UI labels it honestly — keep that
  label; do not let a generated project ship believing MFA is real.
- **Office preview URLs are bearer links.** `/api/public/files/:id?token=...` is
  a 15-minute HMAC-signed URL, office extensions only. Anyone holding the URL
  can fetch the file inside that window — unavoidable, because Microsoft's
  viewer fetches the file from their servers. Two consequences: **the app must
  be reachable from the internet** for the viewer to work at all, and these URLs
  appear in proxy/access logs.
- **Local password mismatch falls through to LDAP.** Intentional: a user with
  both identities who forgets their local password can still authenticate via
  the directory. Deliberate, and worth knowing.
- **Signup reveals account existence** (`USER_EXISTS`), unlike forgot-password
  and OTP which are neutral by design. Rate limited at 5/hour/IP.

## Run (dev/prod)
    cd ~/credentialing-portal/app
    node server.js            # serves on 0.0.0.0:6525 (PORT env overrides)

Restart:
    pkill -f "node server.js"; nohup node server.js > ../server.log 2>&1 &

## Secrets
- Master key auto-generated at `data/secret.key` (chmod 600). In prod set `APP_MASTER_KEY` (64 hex chars) instead.
- LDAP bind password encrypted at rest (AES-256-GCM). Never logged. Omit it in an LDAP update to retain the stored value.

## First run
1. Open http://<host>:6525/ — the one-time **super administrator** wizard appears (only while no active admin exists).
2. Create the admin; you are signed in immediately. The wizard never shows again.

## Config (env)
- `PORT` (default 6525)
- `ACCESS_TTL_MS` (600000), `IDLE_TTL_MS` (1800000), `ABSOLUTE_TTL_MS` (43200000)
- `APP_MASTER_KEY` (hex, 32 bytes) — encryption master key

## Machine-readable codes (clients branch on these)
`OK`, `SETUP_REQUIRED`, `INVALID_CREDENTIALS`, `ACCOUNT_DEACTIVATED`,
`PASSWORD_SETUP_REQUIRED`, `MFA_REQUIRED`, `RATE_LIMITED`, `FORBIDDEN`,
`SELF_DEACTIVATION`, `LAST_ADMIN`, `ROLE_PROTECTED`, `ROLE_IN_USE`.

## Verification checklist
    node test/run.js         # 16 acceptance checks
Live lifecycle proof: open the app as a user, deactivate them in the admin console →
their tab reroutes to the deactivated page within ~1s (SSE); reactivate → it restores
automatically without a manual login.

## Tests covered
local auth + LDAP fallback (success/failure) · deactivated login = ACCOUNT_DEACTIVATED ·
active-session deactivation realtime reroute · automatic reactivation restore ·
role/permission override authorization · protected-role + self-deactivation guardrails ·
refresh rotation · audit capture.
