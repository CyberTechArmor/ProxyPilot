# Next session — Mock2 Phase M1: parent domains + per-slug TLS

You are continuing the build of the **Mock2** module inside ProxyPilot. A
planning session read the whole codebase and produced the plan you are
executing — do not re-derive the architecture, and do not trust your instincts
over the plan's citations; they were verified against the code. **Phase M0 is
already merged** (module skeleton + absence-by-installation). Your phase is
**M1, and only M1**.

## What M0 already shipped (do NOT re-implement)

Everything below is live on `main` — build on it, don't rebuild it:

* **The gate.** `admin/backend/src/mock2/gating.js` — `resolveMock2Gate({ env,
  existsSync, pinPath })` returns `{ enabled, pinned, warning }` (pure, no
  native imports). `MOCK2_ENABLED` (default `false`) + the hard-off pin file
  `/etc/proxypilot/mock2.production.pin` are both honored. `canReadMock2Status(user)`
  is the admin-only predicate for the status route.
* **Conditional wiring.** `admin/backend/src/index.js` (just after the
  `/api/notifications` mount) evaluates the gate and, only when enabled,
  `await import()`s `./mock2/index.js`, runs `initMock2Db()` + `sweepMock2OnBoot()`,
  and mounts `app.use('/api/mock2', authenticateToken, createMock2Router())`.
  On a disabled/pinned host nothing is imported — `/api/mock2/*` is
  indistinguishable from any unknown route, and `mock2.db` is never created.
  **Add your M1 routes to `createMock2Router()`**, not to a new mount point.
* **The Mock2 database.** `admin/backend/src/mock2/db.js` opens
  `data/db/mock2.db` (WAL, `busy_timeout=5000`, dir `0700` / file `0600`,
  path derived from `DATABASE_PATH`). `initMock2Db()` applies the block-500
  migrations via the main DB's `runMigration()` guard against the *mock2* DB
  handle. `getMock2Db()` returns the shared handle. `sweepMock2OnBoot()` is
  the orphan-cycle sweep (a no-op until M6). `_resetMock2DbForTests()` exists.
* **All four migrations already ran.** `admin/backend/src/mock2/migrations.js`
  holds migrations **500–503** verbatim from `03-data-model.md` — all 21
  `mock2_*` tables exist after first enabled boot, including
  **`mock2_parent_domains`, `mock2_projects`, `mock2_slug_history`**. M1 only
  *uses* these tables; you do not create schema unless M1 genuinely needs a
  column the data model doesn't have (if so: a NEW append-only migration 504+,
  never edit 500–503).
* **Identity.** `users.is_superadmin` (main-DB migration 500) + a self-healing
  boot backfill of the oldest admin. The rule "a non-superadmin cannot
  demote/deactivate a superadmin" is enforced in `routes/user.js` via the pure
  `admin/backend/src/lib/superadmin.js` `checkSuperadminProtection(...)`.
  `is_superadmin` is surfaced as `isSuperadmin` on `/api/user/profile` and
  `/api/user/users`.
* **The one route.** `admin/backend/src/mock2/routes.js` exposes
  `GET /api/mock2/status` (admin-gated) → `{ status:'ok', enabled:true, phase }`.
* **Frontend.** `admin/frontend/src/lib/api.js` has `api.mock2Status()`.
  `Layout.jsx` probes it on mount (admins only) and shows a **Projects** nav
  entry (`adminOnly`, `FolderGit2` icon) only on 200; hidden on 404.
  `admin/frontend/src/pages/Projects.jsx` is an empty placeholder that
  self-guards (bounces home if status 404s). Route wired in `App.jsx`.
* **Installer/updater.** `.env.example` carries the `MOCK2_ENABLED=false` +
  `MOCK2_DATA_DIR=/var/lib/proxypilot/mock2` block. `install.sh` asks a fresh
  `[y/N]` prompt (default No), suppressed by the pin, re-asked on re-run only
  while currently `false`. `update.sh` needs **no change** — verified: its
  `sync_env_keys()` appends `MOCK2_ENABLED=false` and dotenv parses it
  correctly past the `# TODO: review` inline comment.
* **Restore note.** `lib/restore.js` carries the ADR-001 reminder that a future
  `mock2.db` restore must be pin-gated.
* **Tests.** `admin/backend/src/__tests__/mock2.test.js` (stub-first, no native
  DB) covers flag off/on, pin-overrides-flag, status-route admin gating, and
  the superadmin rule. Full suite: no new failures (the pre-existing
  `vpn-mtu`/`cves`/`incus`/`webauthn` native-module failures in a fresh
  checkout are documented in `docs/known-issues.md` — leave them alone).

## Read these first, in order

All in `docs/mock2/`:

1. `04-phased-plan.md` — your phase is **M1** ("Parent domains and per-slug
   TLS"). Read the "ordering disagreements" preamble for why M1 is first after
   the skeleton.
2. `02-adrs.md` — **ADR-009** is the specification for this phase (per-slug
   HTTP-01 certs; wildcard DNS-01 deferred). Skim ADR-005 (ports declared) and
   ADR-001 (absence) for the invariants you must preserve.
3. `03-data-model.md` — migration 500's `mock2_parent_domains` and
   `mock2_slug_history` (already created); the `dns_provider` /
   `dns_credentials_enc` / `cert_path` columns stay **NULL** in v1.
4. `01-survey.md` **§5** (routing/TLS/Caddy — the biggest gap; wildcards are
   force-downgraded to HTTP today, no DNS-01, no domain-ownership checks, no
   `forward_auth`/`X-Robots-Tag`/`robots.txt`), **§10** (notification dedupe
   pattern for issuance failures).
5. `05-risks-and-open-questions.md` — **R1** (Let's Encrypt rate limits +
   first-hit latency), **R3** (Docker/nsenter — every host-side moving part
   must work through the `nsenter -t 1` pivot in both deployment shapes),
   **R7** (never name anything "agent").

Background only: `00-original-brief.md`.

## Scope of this session — Phase M1 only

From `04-phased-plan.md` §M1 and ADR-009:

* **`mock2_parent_domains` CRUD** (admin-gated). `dns_provider` /
  `dns_credentials_enc` / `cert_path` exist for the deferred wildcard upgrade
  and stay NULL.
* **Registration verification pipeline:** wildcard-DNS check (random label →
  host IP) → probe-cert issuance on a canary FQDN via ordinary Caddy
  auto-HTTPS (HTTP-01) → `verify_status='cert_ok'`. A domain is selectable only
  when `cert_ok AND enabled`. Issuance failures → **deduped notification**
  (mirror the S3-healthcheck pattern, survey §10) and a `renewal_failed` queue
  item (`mock2_queue_items`, already exists).
* **A Mock2-owned Caddy site file per parent domain** — do **not** modify
  `buildDomainCaddyConfig`/the per-service generator. One site block per active
  FQDN (bare-domain address → Caddy fetches a per-slug Let's Encrypt cert via
  HTTP-01), each block carrying `X-Robots-Tag: noindex`, a `robots.txt` deny
  handler, and a `forward_auth` block **rendered but disabled** (the day-one
  hook). Reload through the existing `caddyAdapt`/`caddyReload` driver
  (`lib/caddy-driver.js`). **Alternative allowed by ADR-009:** a single
  on-demand-TLS site with a backend `ask` endpoint (`GET /api/mock2/tls-ask`)
  that approves exactly the FQDNs in `mock2_projects` + grace-window slug
  history. Pick whichever survives contact with the existing generator more
  cleanly, and **record the choice in `04-phased-plan.md` §M1** (or a short
  ADR-note) so M2 knows which shape it is extending.
* **Watch-item (ADR-009):** log/notify on ACME issuance failures so Let's
  Encrypt rate limits surface instead of silently 502ing.
* **Frontend:** a parent-domains admin surface (register, see verify status,
  enable) under the Mock2 Projects area — MOBILE_FIRST compliant.

## Do NOT implement (later phases)

* Projects, containers, bare repos, slug minting/rotation, memberships (M2 —
  even though the tables exist).
* Per-project bridges, nftables egress, the squid proxy (M4).
* Connectors, quotas, the framework registry/editor, the framework seed (M5).
* Anything called a **runner**, cycle, chat, connector, framework editor,
  classifier (M5–M9). The tables exist; the features do not.
* The wildcard DNS-01 / lego sidecar (deferred; keep those columns NULL).
* Any LDAP anything (deferred by ADR-007).

## Hard constraints

* **Naming (R7):** the AI build component is the **runner**;
  `proxypilot-agent` is an existing unrelated Go daemon. No new file, table,
  or route may use the bare word "agent."
* **Absence (ADR-001):** everything you add lives behind the existing gate —
  new routes go on `createMock2Router()`, new host-side artifacts (Caddy site
  files, certs) are created only on an enabled host. A disabled/pinned host
  must stay byte-for-byte unchanged.
* **Never clobber operator Caddy.** `/etc/caddy/custom/*.caddy` is
  operator-owned; the per-service generator's `/etc/caddy/sites/*.caddy` files
  are not yours to rewrite. Write Mock2's own site file(s).
* **Docker/nsenter (R3):** exercise every host-side path (git/cert/Caddy
  reload) through `lib/host-exec.js` so it works both native and in-container.
* **Migrations append-only:** never edit 500–503; a genuinely new column is a
  new migration 504+.
* **Conventions:** Zod on backend routes, `{ error }` response shape,
  `requireAdmin`/`requireSudo` middleware, `logAudit` for admin actions
  (domain register/enable/delete are audit-worthy). Frontend changes must pass
  `admin/frontend/MOBILE_FIRST.md` (merge gate): render at 360/375/768, no
  horizontal scroll, 44px touch targets.

## What "done" looks like

The Phase M1 verification checklist in `04-phased-plan.md`:

> register a real domain end to end; a registered test FQDN serves valid
> per-host TLS, the noindex header, and robots.txt deny; an unregistered label
> gets no cert/route; an un-verified domain is not selectable in the (stub)
> project-create API.

Plus:

```
cd admin/backend && node --test 'src/__tests__/*.test.js'
```

no NEW failures (the pre-existing native-module failures in a fresh checkout
are documented in `docs/known-issues.md` — leave them alone; write M1 tests
stub-first like `mock2.test.js`). A host with `MOCK2_ENABLED=false` still
behaves byte-for-byte like today.

## Branch

Harness assigns. Commit as `mock2-M1: <description>`. Do not push to main.

## Before you finish

Write `docs/mock2/NEXT-SESSION-PROMPT-mock2-phase-03.md` for **Phase M2**
(project registry, container, bare repo, live URL) in this same format: what
M0+M1 shipped (so M2 doesn't re-implement it, especially which Caddy-site shape
M1 chose), pointers into the plan bundle, and M2 scope from `04-phased-plan.md`.

All gating decisions are closed (ADR-007/008/009/010 accepted, 2026-07-09 — see
`05-risks-and-open-questions.md`). The only outstanding external prerequisite is
the **framework content handoff for Phase M5** (risk R8) — not needed for M1 or
M2.
