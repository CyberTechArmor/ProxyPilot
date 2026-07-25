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
| `APP_DATA_DIR` | Where `db.json` + `secret.key` live. |
| `SESSION_PRUNE_GRACE_MS` | How long settled (revoked/expired) sessions are retained for reuse detection before pruning. Default 24 h. |

## Scaling ceiling — know this before you build on it

`lib/store.js` serialises the **whole database** on every mutation, on the
request path. That is deliberate for a base template (no schema migrations, no
external service, trivially inspectable) and the "swap for SQL by keeping the
same functions" seam below is real — but it means:

- **Single process only.** In-memory rate limits and the SSE hub are
  per-process, so a second worker would see neither. Do not scale this out
  horizontally without replacing the store, the limiter and the hub together.
- Write cost grows with total data, not with the size of the change.

For anything with many users, files or audit rows, replace `lib/store.js` first.

## Layout
- `server.js` — HTTP router, guards, static SPA host, SSE endpoint
- `lib/crypto.js` — scrypt password hashing, AES-256-GCM secret encryption, tokens
- `lib/store.js` — atomic JSON persistence (`data/db.json`); swap for SQL by keeping the same functions
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
