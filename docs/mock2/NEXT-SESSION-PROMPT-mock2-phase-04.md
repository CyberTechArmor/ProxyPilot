# Next session — Mock2 Phase M3: archive and rehydrate, proven

You are continuing the build of the Mock2 module inside ProxyPilot. A planning
session read the whole codebase and produced the plan you are executing — do
not re-derive the architecture, and do not trust your instincts over the plan's
citations; they were verified against the code. Phases **M0** (module skeleton +
absence-by-installation), **M1** (parent domains + per-slug TLS), and **M2**
(project registry + container + bare repo + live URL) are already built. Your
phase is **M3, and only M3**.

## What M0 already shipped (do NOT re-implement)

* **The gate.** `admin/backend/src/mock2/gating.js` — `resolveMock2Gate(...)`
  (pure). `MOCK2_ENABLED` (default `false`) + the hard-off pin. `canReadMock2Status`
  is the admin-only predicate.
* **Conditional wiring.** `admin/backend/src/index.js` (after `/api/notifications`)
  evaluates the gate and, only when enabled, dynamically imports `./mock2/index.js`,
  runs `initMock2Db()` + `sweepMock2OnBoot()` + `reconcileMock2Domains()`, and
  mounts `app.use('/api/mock2', authenticateToken, createMock2Router())`. Add M3
  routes to `createMock2Router()` in `routes.js`, not a new mount.
* **The Mock2 DB.** `mock2/db.js` opens `data/db/mock2.db` (WAL, `busy_timeout`,
  0700/0600). `initMock2Db()` applies block-500 migrations via the main DB's
  `runMigration()` guard. **Foreign keys are OFF** (a `project_id=0` sentinel is
  how queue rows with no project are marked).
* **Migrations 500–504 have run.** `migrations.js` holds them verbatim; a new
  column ⇒ a new append-only migration **505+**, never edit 500–504. (M2 added
  504: `mock2_projects.web_port`, `container_ip`, `provision_error`.)
* **Identity.** `users.is_superadmin` + boot backfill; superadmin protection in
  `lib/superadmin.js`, enforced in `routes/user.js`.

## What M1 shipped (build on it, don't rebuild it)

* **Parent-domain CRUD + verification** in `mock2/routes.js` / `verify.js` /
  `domains.js`; the selectable gate `isSelectable(row)` in `domain-logic.js`.
* **The Caddy shape (ADR-009).** Per-FQDN explicit blocks in `mock2/caddy.js`:
  `buildMock2SiteBlock({ fqdn, note, upstream })` (M2 added `upstream` →
  `reverse_proxy`; no upstream → placeholder), `buildMock2DomainConfig`,
  `writeMock2DomainSite` / `reloadMock2Caddy` (returns `{ok}`, never throws).

## What M2 shipped (build on it, don't rebuild it)

* **Project CRUD + membership + slug history.** `mock2/projects.js` (data
  access, native), `mock2/project-logic.js` (pure: `deriveProjectStatus`,
  `publicProjectShape`, `projectActiveFqdns` rotation-grace, `resolveMock2Access`),
  `mock2/slug.js` (pure: `mintSlugCandidate` `p-`+8hex, `isReservedSlug` reserves
  the `_mock2` prefix, `isValidSlugShape`). Slugs are unique-per-parent and
  **never reused** — `createProject` writes a permanent `mock2_slug_history` row,
  and `rotateProjectSlug` puts the old slug in a **1-hour grace** (`active_until`)
  then it 404s forever.
* **`requireMock2Role(minRole)`** middleware in `mock2/authz.js` — admin/superadmin
  bypass stamps `acting_as_admin`; a non-member gets 404, an under-privileged
  member gets 403. It loads `req.mock2Project` + `req.mock2Access`.
* **The provisioning job** — `mock2/provision.js`, the `activeProvisions` 202+poll
  mirror of `routes/lxc.js`. **Steps (memorize this sequence — M3 archive/rehydrate
  reuses most of it):** seed bare repo host-side (`buildSeedScript` → temp work
  tree → `git push` into `MOCK2_DATA_DIR/repos/<id>.git`) → `incus launch
  images:debian/12 m2-<id>` on the **shared** bridge → wait for bridge IP →
  **mount the bare repo as an Incus disk device** (`reporepo disk source=<repo>
  path=/srv/repo.git shift=true`, **ADR-011 — this is the R6 decision**) → clone
  `/srv/repo.git` → `/srv/app` inside the container → read the DECLARED web port
  from `mock2.yaml` (`parseManifestWebPort`, ADR-005) → run the container setup
  script (`buildContainerSetupScript`: python3 + Postgres best-effort + a
  `mock2-dev.service` systemd unit) → `updateProject({ lifecycle:'active',
  web_port, container_ip })` → publish the slug's Caddy block.
* **The active-FQDN reconcile shape — REUSE THIS.** `mock2/publish.js`
  `publishDomain(parentDomainId)` recomputes a parent domain's ENTIRE active-FQDN
  set across all its projects (each project's current slug + grace slugs, each →
  `container_ip:web_port`) and rewrites the one Caddy file + reloads. Every path
  that changes routing (provision, rotate, delete, and **M3 archive/rehydrate**)
  calls `publishDomain`. `reconcile.js` calls it per enabled domain at boot.
* **The template.** `mock2/template.js` (pure): `buildSeedFiles(project, {webPort})`
  (mock2.yaml + `public/index.html` placeholder + `serve.py` + `.env.example`
  secrets manifest + `state/rules.md`), `parseManifestWebPort`,
  `buildContainerSetupScript`. **Postgres runs inside the container** (ADR-008).
* **Routes.** `POST /projects` (admin, mints slug on a selectable domain, adds
  creator as editor, 202 → provision), `GET /projects` + `GET /projects/:id`
  (+`provision-status`), `POST /projects/:id/rotate-slug|members|flag|custom-domain`,
  `DELETE /projects/:id` (admin+sudo — destroys container, **keeps bare repo +
  slug history**). Delete is the M2 end-state stand-in; **archive is M3**.
* **Frontend.** `pages/Projects.jsx` (tiles + create dialog offering only
  selectable domains), `pages/ProjectDetail.jsx` (status, URL, rotate, members,
  flag, admin custom-domain + debug `bridge_ip:port`, sudo delete),
  `lib/mock2-status.jsx` (`statusChip` — one status→chip map), `api.mock2*Project*`.
* **Tests.** `__tests__/mock2-projects.test.js` (stub-first, pure). Full suite has
  no new failures — the 4 pre-existing native-module failures (`cves`, `incus`,
  `webauthn`, `vpn-mtu`) are in `docs/known-issues.md`; leave them.

## Read these first, in order

All in `docs/mock2/`:

1. `04-phased-plan.md` — your phase is **M3** (archive + rehydrate). Read its
   explicit verify test: create → modify files in container → archive →
   rehydrate → modified state is back at the same URL; then archive → delete the
   image cache → rehydrate still works (proves **no snapshot dependency**).
2. `02-adrs.md` — **ADR-006** (bare repo is the ONLY recovery path — rehydrate
   must NEVER depend on a snapshot), **ADR-011** (the disk-device mount you
   re-add on rehydrate), **ADR-005** (re-read `mock2.yaml` on rehydrate),
   **ADR-008** (Postgres-in-container: schema comes from repo migrations, dev
   data is disposable — do NOT try to preserve Postgres data across archive).
3. `03-data-model.md` — `mock2_projects.lifecycle` already has `'archived'` and
   the `archived_at` column; **archived = read-only** (Q4/ADR direction) is
   enforced in the API layer as ONE guard, not per-route sprinkles.
4. `05-risks-and-open-questions.md` — **R3** (every host path through
   `lib/host-exec.js`), **R6** (RESOLVED by ADR-011 — the mount is your transport),
   **R7** (never name anything "agent").

## Scope of this session — Phase M3 only

* **Archive** (`POST /projects/:id/archive`, admin or editor): checkpoint-commit
  the working tree inside the container → **final `git push` into the bare repo
  over the ADR-011 mount** → destroy the container → `lifecycle='archived'`,
  `archived_at` set → `publishDomain` drops its slug block (the slug stays
  reserved — it was never released). Repo, chats, change records, memberships
  retained. **Do NOT** touch the bare repo or the slug history.
* **Archived = read-only:** one API-layer guard that refuses every mutating
  project route on an archived project except **view** and **rehydrate**
  (mirror how M2 gates with `requireMock2Role`, but add a lifecycle check —
  one helper, not sprinkles).
* **Rehydrate** (`POST /projects/:id/rehydrate`): rebuild the container from the
  template, **re-add the disk-device mount, clone from the bare repo** (ADR-011,
  ADR-006 — never a snapshot), re-read `mock2.yaml`, re-run the setup script,
  `lifecycle='active'`, refresh `container_ip`/`web_port`, `publishDomain` →
  **same slug, same URL** (it was never released). Reuse `provision.js`'s steps;
  factor the shared launch→mount→clone→setup→publish sequence so archive/rehydrate
  and create don't fork it.
* **Idle-stop groundwork:** `incus stop` after N days idle (`mock2_settings`),
  restart-on-visit; distinct from archive. Wire the setting + the stop path;
  the visit-restart can be minimal.
* Frontend: an **Archive/Rehydrate** action on `ProjectDetail.jsx`, an archived
  filter/section on `Projects.jsx`, and read-only rendering for archived
  projects. MOBILE_FIRST.

## Do NOT implement (later phases)

* Checkout lock / cycle runner (M6 — `mock2_locks` exists; don't wire timers).
* Per-project bridges, nftables egress, squid (M4 — M3 still uses the shared
  bridge; archive destroys the container, and in M2/M3 there is no per-project
  bridge to destroy yet).
* Connectors, quotas, framework registry (M5); chat/mockups/audit/classifier
  (M7–M9); wildcard DNS-01 (deferred); LDAP (ADR-007).

## Hard constraints

* **Naming (R7):** the AI build component is the **runner**; no new file/table/
  route uses the bare word "agent."
* **Absence (ADR-001):** new routes on `createMock2Router()`; new host artifacts
  only on an enabled host. A disabled/pinned host stays byte-for-byte unchanged.
* **No snapshot dependency (ADR-006):** rehydrate rebuilds from the template +
  bare repo ONLY. The verify test deletes the image cache between archive and
  rehydrate — your rehydrate must survive that.
* **Never clobber operator/service Caddy** — write only `/etc/caddy/mock2/*` via
  `caddy.js` / `publish.js`.
* **Docker/nsenter (R3):** every host path through `lib/host-exec.js`.
* **Migrations append-only (505+).** Zod on routes, `{ error }` shape,
  `requireAdmin`/`requireSudo`, `logAudit` on admin/destructive actions.
  Frontend passes `admin/frontend/MOBILE_FIRST.md`.

## What "done" looks like

The Phase M3 verify checklist in `04-phased-plan.md`: create → modify files in
the container → archive → rehydrate → the modified state is back and served at
the **same URL**; then archive → delete the container image cache → rehydrate
still works. **Run it as an automated test if at all feasible** (the round-trip
is the whole point of M3 landing before anything depends on it). Plus:

```
cd admin/backend && node --test 'src/__tests__/*.test.js'   # no NEW failures
cd admin/frontend && npm run build
```

Write M3 tests stub-first (the archive/rehydrate state transitions, the
read-only guard, and any pure helpers you factor out are all unit-testable
without the native DB). A `MOCK2_ENABLED=false` host still behaves byte-for-byte
like today.

## Branch

Harness assigns. Commit as `mock2-M3: <description>`. Do not push to main.
(M0–M2 currently live on the `claude/mock2-parent-domains-ui-a8875a` branch, not
`main` — branch M3 off wherever M2 landed, and open its own PR.)

## Before you finish

Write `docs/mock2/NEXT-SESSION-PROMPT-mock2-phase-05.md` for **Phase M4**
(network isolation: per-project bridges, nftables egress, squid — ADR-010) in
this same format: what M0–M3 shipped (especially the archive/rehydrate shape and
the shared-launch-sequence factoring you did), plan-bundle pointers, and M4
scope from `04-phased-plan.md`.

The only outstanding external prerequisite is the framework content handoff for
Phase M5 (risk R8) — not needed for M3 or M4.
