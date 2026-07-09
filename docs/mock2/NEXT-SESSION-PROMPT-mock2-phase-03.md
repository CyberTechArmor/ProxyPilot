# Next session — Mock2 Phase M2: project registry, container, bare repo, live URL

You are continuing the build of the Mock2 module inside ProxyPilot. A planning
session read the whole codebase and produced the plan you are executing — do
not re-derive the architecture, and do not trust your instincts over the plan's
citations; they were verified against the code. Phases **M0** (module skeleton +
absence-by-installation) and **M1** (parent domains + per-slug TLS) are already
built. Your phase is **M2, and only M2**.

## What M0 already shipped (do NOT re-implement)

* **The gate.** `admin/backend/src/mock2/gating.js` — `resolveMock2Gate({ env, existsSync, pinPath })` (pure). `MOCK2_ENABLED` (default `false`) + the hard-off pin `/etc/proxypilot/mock2.production.pin`. `canReadMock2Status(user)` is the admin-only predicate.
* **Conditional wiring.** `admin/backend/src/index.js` (just after `/api/notifications`) evaluates the gate and, only when enabled, dynamically imports `./mock2/index.js`, runs `initMock2Db()` + `sweepMock2OnBoot()` + `reconcileMock2Domains()`, and mounts `app.use('/api/mock2', authenticateToken, createMock2Router())`. Add M2 routes to `createMock2Router()` in `routes.js`, not a new mount.
* **The Mock2 DB.** `admin/backend/src/mock2/db.js` opens `data/db/mock2.db` (WAL, `busy_timeout=5000`, dir `0700`/file `0600`). `initMock2Db()` applies block-500 migrations via the main DB's `runMigration()` guard. `getMock2Db()` returns the shared handle. `_resetMock2DbForTests()` exists. **Foreign keys are OFF** on this handle (a `project_id=0` sentinel is how M1's queue rows mark "no project").
* **All four migrations already ran** — `migrations.js` holds 500–503 verbatim; all 21 `mock2_*` tables exist. M2 uses `mock2_projects`, `mock2_project_members`, `mock2_slug_history`, `mock2_locks` (locks are M6-owned; don't wire lock semantics yet). Create schema only if M2 needs a column the model lacks → a NEW append-only migration **504+**, never edit 500–503.
* **Identity.** `users.is_superadmin` (main-DB migration 500) + self-healing boot backfill. Superadmin-protection is pure in `admin/backend/src/lib/superadmin.js`, enforced in `routes/user.js`, surfaced as `isSuperadmin` on `/api/user/profile` + `/api/user/users`.
* **Frontend skeleton.** `api.mock2Status()`; `Layout.jsx` shows a **Projects** nav entry (`adminOnly`) only on a 200; `pages/Projects.jsx` self-guards; route in `App.jsx`.
* **Installer/updater.** `.env.example` carries `MOCK2_ENABLED`, `MOCK2_DATA_DIR`, and (M1) `MOCK2_CADDY_DIR`, `MOCK2_PUBLIC_IP`. `install.sh` asks a fresh `[y/N]`; `update.sh` needs no change. `lib/restore.js` carries the ADR-001 reminder that a future `mock2.db` restore must be pin-gated.

## What M1 shipped (build on it, don't rebuild it)

* **Parent-domain CRUD + verification.** Admin-gated routes in `mock2/routes.js`:
  `GET/POST /parent-domains`, `GET /parent-domains/:id`,
  `POST /parent-domains/:id/verify|enable|disable`, `DELETE /parent-domains/:id`
  (delete adds `requireSudo`). Verification is a two-stage async pipeline
  (`mock2/verify.js`, deps-injectable): wildcard-DNS check → probe cert on a
  canary FQDN → `verify_status='cert_ok'`. Failures dedupe to a bell
  notification **and** a `renewal_failed` queue item (`mock2/queue.js`), and
  auto-resolve on recovery.
* **The selectable gate — USE THIS.** `isSelectable(row)` in
  `mock2/domain-logic.js` returns true only when `verify_status==='cert_ok' &&
  enabled===1`. **M2's project-create MUST call it** — the M1 stub
  `POST /api/mock2/projects` already rejects a non-selectable domain (returns
  400) and otherwise 501s "arrives in M2". Replace that stub body with the real
  create; keep the selectable guard.
* **The Caddy shape M1 chose (extend this exactly).** ADR-009's **per-FQDN
  explicit block**, not on-demand TLS. Everything lives in
  `admin/backend/src/mock2/caddy.js`:
  - `buildMock2SiteBlock({ fqdn, note })` — the per-host block: `X-Robots-Tag:
    noindex`, a `robots.txt` deny handler, a **rendered-but-commented**
    `forward_auth` hook, and a **placeholder handler**. **M2 swaps the
    placeholder handler for a `reverse_proxy` to the container's bridge IP +
    declared web port** — add that as an option to this builder (e.g. an
    `upstream` param); leave the headers/robots/forward_auth lines intact.
  - `buildMock2DomainConfig({ domain, fqdns })` — one file per parent domain,
    one block per active FQDN. Empty list → header-only no-op file.
  - `writeMock2DomainSite(domain, fqdns)` writes to `MOCK2_CADDY_DIR`
    (`/etc/caddy/mock2`) and calls `ensureMock2CaddyImport()` (idempotent
    `import /etc/caddy/mock2/*.caddy` in the main Caddyfile — enabled hosts
    only). `removeMock2DomainSite` / `unpublishMock2Domain` tear down.
    `reloadMock2Caddy()` = `caddyAdapt` then `caddyReload`, returns `{ok}` (never
    throws) so ACME/reload failures become notifications, not 500s.
  - **On slug mint/rotate/archive, recompute the domain's active-FQDN set and
    call `writeMock2DomainSite` + `reloadMock2Caddy`.** `reconcile.js` already
    re-publishes enabled domains at boot — extend its `[]` to the real active
    FQDNs once slugs exist.
* **Data access.** `mock2/domains.js` (parent-domain CRUD). Response shaping via
  `publicDomainShape` (never leaks `dns_credentials_enc`; derives `selectable`).
* **Frontend.** `api.mock2*ParentDomain*` methods in `lib/api.js`;
  `pages/ParentDomains.jsx` at `/projects/domains` (register → poll status →
  enable/disable/delete), linked from `Projects.jsx`. MOBILE_FIRST-compliant.
* **Tests.** `admin/backend/src/__tests__/mock2-domains.test.js` (stub-first, no
  native DB; the pipeline is tested via injected fakes). Full suite has no new
  failures — the 4 pre-existing native-module failures (`cves`, `incus`,
  `webauthn`, `vpn-mtu`) are in `docs/known-issues.md`; leave them alone.

## Read these first, in order

All in `docs/mock2/`:

1. `04-phased-plan.md` — your phase is **M2**. Read the **M1 "Caddy-shape
   decision"** note there too; it tells you which site-file shape you extend.
2. `02-adrs.md` — **ADR-005** (ports declared in `mock2.yaml`, not discovered),
   **ADR-006** (local bare repo is primary; remotes optional; rehydrate-from-repo
   is the only recovery path — never depend on snapshots), **ADR-007** (roles:
   `mock2_project_members` editor/viewer, admin bypass stamps `acting_as_admin`,
   zero editors ⇒ derived `orphaned`), **ADR-008** (Postgres **inside** each
   project container, installed by the template — ProxyPilot stores nothing in
   it).
3. `03-data-model.md` — `mock2_projects`, `mock2_project_members`,
   `mock2_slug_history` (note the `UNIQUE (parent_domain_id, slug)` on both
   projects and history — an old slug is **never** reusable).
4. `01-survey.md` §3 (auth/ACL + the `user_service_access` pattern to model
   memberships on), §4 (Incus/LXC provisioning — today all containers share one
   bridge; per-project bridges are M4, so M2 uses the shared bridge), §6 (git),
   and the `activeCreations` 202+poll provisioning pattern at
   `admin/backend/src/routes/lxc.js` (~738–1143) — mirror it.
5. `05-risks-and-open-questions.md` — **R6** (bare-repo wiring into the
   container: Incus disk device vs. `git remote` over the bridge — decide and
   record), **R3** (Docker/nsenter: every host-side path through
   `lib/host-exec.js` `spawnHost`/`spawnHostSync`), **R7** (never name anything
   "agent").

Background only: `00-original-brief.md`.

## Scope of this session — Phase M2 only

* `mock2_projects` + `mock2_project_members` + `mock2_slug_history` CRUD.
  **Slug minting**: `p-` + 8 hex, reserved prefixes blocked
  (`_mock2-verify-` is used by the M1 canary — reserve the `_mock2` prefix),
  unique per parent domain, and **never** reused (history row blocks it).
  Membership roles + a `requireMock2Role` middleware (admin/superadmin bypass
  stamps `acting_as_admin`). Zero-editor projects derive `orphaned`.
* **Provisioning job** — mirror the `activeCreations` 202+poll pattern
  (`lxc.js`): create bare repo on host (`spawnHost`, under
  `MOCK2_DATA_DIR/repos/<id>.git`) → seed from the project template (placeholder
  web app + `mock2.yaml` + Postgres-in-container per ADR-008) → `incus launch`
  unprivileged `m2-<id>` on the **shared** bridge (per-project bridges are M4) →
  clone into the container → start the dev server → read `mock2.yaml` → register
  the slug's FQDN block in the parent-domain Caddy file (extend
  `buildMock2SiteBlock` with the container upstream) → `reloadMock2Caddy()`.
* **Slug rotate**: new slug, 1-hour grace via `mock2_slug_history.active_until`
  (old + new FQDN blocks coexist during grace), old slug 404s after and is never
  reusable. **Custom domains**: admin-gated, DNS A-record check, HTTP-01 via a
  standard per-domain block.
* Admin debug view shows `bridge_ip:port`; **no host ports anywhere**.
* Frontend: project tiles + a detail skeleton, and a create flow that only
  offers **selectable** parent domains. MOBILE_FIRST (render at 360/375/768, no
  horizontal scroll, 44px touch targets).

## Do NOT implement (later phases)

* The checkout lock semantics / cycle runner (M6 — the `mock2_locks` table
  exists; don't wire its timers yet).
* Per-project bridges, nftables egress, the squid proxy (M4 — M2 uses the shared
  bridge).
* Connectors, quotas, framework registry/editor/seed (M5).
* Chat, mockups, audit, classifier, summaries (M7–M9).
* Archive/rehydrate (M3) — though M2 must not do anything that would *depend* on
  a snapshot (ADR-006).
* The wildcard DNS-01 / lego sidecar (deferred; `dns_provider` /
  `dns_credentials_enc` / `cert_path` stay NULL).
* Any LDAP anything (deferred by ADR-007).

## Hard constraints

* **Naming (R7):** the AI build component is the **runner**; `proxypilot-agent`
  is an unrelated Go daemon. No new file, table, or route may use the bare word
  "agent."
* **Absence (ADR-001):** new routes on `createMock2Router()`; new host-side
  artifacts (containers, repos, Caddy files) only on an enabled host. A
  disabled/pinned host stays byte-for-byte unchanged.
* **Never clobber operator/service Caddy.** `/etc/caddy/custom/*` is the
  operator's; `/etc/caddy/sites/*` is the per-service generator's. Write only
  Mock2's own `/etc/caddy/mock2/*` files via `caddy.js`.
* **Docker/nsenter (R3):** every host-side path (incus, git, bare-repo fs)
  through `lib/host-exec.js`.
* **Migrations append-only:** never edit 500–503; a new column is 504+.
* **Conventions:** Zod on routes, `{ error }` shape, `requireAdmin`/`requireSudo`
  middleware, `logAudit` for admin/destructive actions. Frontend passes
  `admin/frontend/MOBILE_FIRST.md`.

## What "done" looks like

The Phase M2 verification checklist in `04-phased-plan.md`: create → tile shows
`provisioning` → `online`; the URL serves the placeholder over a per-slug LE
cert; `git log` in the bare repo shows the seed commit; rotate works and the old
slug 404s after grace; a viewer can open but not mutate; a second project can
**never** take the same slug (history row blocks). Plus:

```
cd admin/backend && node --test 'src/__tests__/*.test.js'
```

no NEW failures (write M2 tests stub-first like `mock2-domains.test.js` —
slug-mint uniqueness, reserved-prefix blocking, `requireMock2Role`, and the
Caddy upstream builder are all pure and unit-testable). And build the frontend:
`cd admin/frontend && npm run build`. A host with `MOCK2_ENABLED=false` still
behaves byte-for-byte like today.

## Branch

Harness assigns. Commit as `mock2-M2: <description>`. Do not push to main.

## Before you finish

Write `docs/mock2/NEXT-SESSION-PROMPT-mock2-phase-04.md` for **Phase M3**
(archive + rehydrate, proven) in this same format: what M0+M1+M2 shipped
(especially the R6 bare-repo-into-container decision you made, and the
active-FQDN reconcile shape), pointers into the plan bundle, and M3 scope from
`04-phased-plan.md`.

All gating decisions are closed (ADR-005/006/007/008 accepted). The only
outstanding external prerequisite is the framework content handoff for Phase M5
(risk R8) — not needed for M2 or M3.
