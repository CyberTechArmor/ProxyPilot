**Next session — Mock2 Phase M4: network isolation (the fence, before any runner)**

You are continuing the build of the Mock2 module inside ProxyPilot. A planning
session read the whole codebase and produced the plan you are executing — do not
re-derive the architecture, and do not trust your instincts over the plan's
citations; they were verified against the code. Phases **M0** (module skeleton +
absence-by-installation), **M1** (parent domains + per-slug TLS), **M2** (project
registry + container + bare repo + live URL) and **M3** (archive + rehydrate +
idle-stop groundwork) are already built and merged to `main`. Your phase is
**M4, and only M4.**

**What M0 already shipped (do NOT re-implement)**
- **The gate.** `admin/backend/src/mock2/gating.js` — `resolveMock2Gate(...)`
  (pure). `MOCK2_ENABLED` (default `false`) + the hard-off pin.
  `canReadMock2Status` is the admin-only predicate.
- **Conditional wiring.** `admin/backend/src/index.js` (after `/api/notifications`)
  evaluates the gate and, only when enabled, dynamically imports
  `./mock2/index.js`, runs `initMock2Db()` + `sweepMock2OnBoot()` +
  `reconcileMock2Domains()` + `sweepIdleStops()`, and mounts
  `app.use('/api/mock2', authenticateToken, createMock2Router())`. Add M4 routes
  to `createMock2Router()` in `routes.js`, not a new mount.
- **The Mock2 DB.** `mock2/db.js` opens `data/db/mock2.db` (WAL, `busy_timeout`,
  0700/0600). `initMock2Db()` applies block-500 migrations via the main DB's
  `runMigration()` guard. **Foreign keys are OFF.**
- **Migrations 500–504 have run.** A new column ⇒ a new append-only migration
  **505+**, never edit 500–504. (M3 needed no new column — `lifecycle` already
  had `'archived'`/`'stopped'`, and `archived_at`/`last_activity_at` already
  existed. M4 WILL add columns/tables — see scope — so it owns migration 505+.)
- **Identity.** `users.is_superadmin` + boot backfill; superadmin protection in
  `lib/superadmin.js`, enforced in `routes/user.js`.

**What M1 shipped (build on it, don't rebuild it)**
- **Parent-domain CRUD + verification** in `mock2/routes.js` / `verify.js` /
  `domains.js`; the selectable gate `isSelectable(row)` in `domain-logic.js`.
- **The Caddy shape (ADR-009).** Per-FQDN explicit blocks in `mock2/caddy.js`
  under `/etc/caddy/mock2/` (`MOCK2_CADDY_DIR`); `buildMock2SiteBlock`,
  `buildMock2DomainConfig`, `writeMock2DomainSite` / `reloadMock2Caddy` (returns
  `{ok}`, never throws). `publish.js` `publishDomain(parentDomainId)` recomputes
  a parent domain's entire active-FQDN set and rewrites the one file + reloads.

**What M2 shipped (build on it, don't rebuild it)**
- **Project CRUD + membership + slug history.** `mock2/projects.js` (data
  access), `mock2/project-logic.js` (pure), `mock2/slug.js` (pure). Slugs
  unique-per-parent, never reused.
- **`requireMock2Role(minRole)`** in `mock2/authz.js` (admin bypass stamps
  `acting_as_admin`, non-member → 404, under-privileged → 403; loads
  `req.mock2Project` + `req.mock2Access`).
- **The provisioning job** — `mock2/provision.js`, the `activeProvisions`
  202+poll mirror of `routes/lxc.js`. **Every host mutation goes through
  `lib/host-exec.js spawnHost` (risk R3 — nsenter inside Docker).**
- **The template** — `mock2/template.js` (pure): `buildSeedFiles`,
  `parseManifestWebPort` (ADR-005), `buildContainerSetupScript` (Postgres in
  container, ADR-008).

**What M3 shipped (build on it, don't rebuild it) — READ THIS, M4 extends it**
- **The shared launch sequence is factored.** `provision.js` now has
  `bringUpFromRepo(project, { repoPath, containerName, mode })` — the ONE
  `launch→wait-ip→resolv→mount(ADR-011)→clone→read-manifest→setup→activate→publishDomain`
  path, used by **both** create (after the host-side seed) and rehydrate. **M4
  extends THIS function**, not the old inline steps: the per-project bridge
  creation, NIC pinning, and `HTTP(S)_PROXY` injection all belong inside (or
  immediately around) `bringUpFromRepo` so create AND rehydrate get the fence
  identically. Do not fork a second launch path.
- **Archive / rehydrate / wake / idle-stop.** `provision.js` exports
  `startArchive` (checkpoint-commit in container → `git push origin HEAD:main`
  over the ADR-011 mount → `incus delete` → `lifecycle='archived'`,
  `container_name`/`container_ip` NULLed, `archived_at` set → `publishDomain`
  drops the slug block; **bare repo + slug history + memberships retained**),
  `startRehydrate` (route flips to `'provisioning'` + restores `container_name`,
  then `bringUpFromRepo` mode `'rehydrate'`; a failed rehydrate reverts to
  `'archived'`, never a snapshot — ADR-006), `startWake` + `stopProjectContainer`
  (idle-stop groundwork). `buildCheckpointScript` is pure in `template.js`.
- **Archived = read-only.** The ONE guard is `refuseIfArchived` in `routes.js`
  (keys off pure `isProjectReadOnly` in `project-logic.js`), inserted after
  `requireMock2Role` on every mutating project route (rotate-slug, members
  ±, flag, custom-domain); delete additionally 409s on archived inline. Only
  **view** and **rehydrate** work on an archived project. **When you add M4
  mutating routes (allowlist edits), add `refuseIfArchived` to them too.**
- **Idle-stop.** `mock2/settings.js` (`getMock2Setting`/`setMock2Setting`,
  `getIdleStopDays`, key `idle_stop_days` in `mock2_settings`); pure
  `isIdleStale(project, now, days)`; `mock2/idle.js` `sweepIdleStops()` wired at
  boot (M9 adds the timer). Routes `GET/POST /projects/:id`… wait — the idle
  window route is `GET/POST /settings/idle-stop-days` (admin).
- **Frontend.** `pages/ProjectDetail.jsx` gained Archive (confirm dialog),
  Rehydrate, and Start (wake) actions, an archived read-only banner, and hides
  every mutating card when archived; `pages/Projects.jsx` gained an **Archived**
  section (dimmed `ProjectTile`s). `api.mock2Archive/Rehydrate/WakeProject`,
  `api.mock2Get/SetIdleStopDays`.
- **Verify.** `scripts/mock2-m3-verify.sh` (on-host: create → modify in
  container → archive → rehydrate → same URL; then image-cache-delete →
  rehydrate to prove no snapshot dependency). Unit tests stub-first in
  `__tests__/mock2-lifecycle.test.js`. Full suite has **no new failures** — the
  4 pre-existing native-module failures (`cves`, `incus`, `webauthn`,
  `vpn-mtu`) are in `docs/known-issues.md`; leave them.

**Read these first, in order** (all in `docs/mock2/`)
1. `04-phased-plan.md` — your phase is **M4**. Read its explicit verify test:
   from inside project A, `curl https://registry.npmjs.org` OK via proxy;
   direct `curl 1.1.1.1` fails; project B's bridge IP unreachable; control-plane
   (host :3001, main bridge) unreachable; Postgres inside A unreachable from the
   host network but fine locally; `npm install` works; existing non-Mock2
   `pp-*` containers untouched.
2. `02-adrs.md` — **ADR-010** (default-deny bridge + filtering egress proxy,
   **accepted WITH a hard complexity guardrail**: one apt package, one systemd
   service, one generated ACL file — if it grows beyond that, fall back to
   bridge-isolation-only and record the dropped allowlist here), **ADR-005**
   (manifest-declared ports; the scan-vs-manifest `port_drift` queue item is the
   inbound half), **ADR-008** (Postgres-in-container is the thing isolation must
   keep unreachable across projects).
3. `05-risks-and-open-questions.md` — **R2** (`ensureNetworkNat()` NATs *every*
   managed bridge — the nftables chain must sit in front of the NAT path; needs
   a real test matrix across `table inet proxypilot`, Incus's own rules, and
   Docker's chains, NOT reasoning from docs), **R3** (every host path through
   `lib/host-exec.js`, exercised in both Docker and bare-metal shapes), **R7**
   (never name anything "agent"), **Q6** (the plain-language egress-proxy
   explanation + the guardrail).
4. `01-survey.md` §4, §13 — the CLI's `createNetwork` REST pattern (the
   reference for per-project managed bridges), the existing
   `container_egress` chain in `table inet proxypilot`, and the firewall state
   file `/var/lib/proxypilot/firewall.json` (extend it with a per-project
   section; reconcile at boot, l4-reconciler pattern).

**Scope of this session — Phase M4 only**
- **Per-project managed bridge** `m2br<id>` created at provision (extend
  `bringUpFromRepo`); the container NIC pinned to it; **torn down on archive and
  on delete** (the archive path in `provision.js` and the delete route both need
  the teardown). `mock2_projects.bridge_name` column already exists (500) — set
  it. M3 still used the shared bridge; M4 makes bridges real.
- **nftables:** extend the `table inet proxypilot` egress chain — default-deny
  from project bridges; allow DNS-to-host, established/related, the host egress
  proxy port, and the manifest's web port from Caddy; deny inter-bridge and
  control-plane. Persist in the firewall state file; reconcile at boot.
- **Filtering egress proxy** (squid or tinyproxy) with per-project allowlist
  ACLs keyed by source subnet; the template bakes `HTTP(S)_PROXY`/`NO_PROXY`
  into container env. Default allowlist: npm registry, model API hosts (from
  connectors — but connectors are M5, so seed a static default + make the list
  editable), the project git remote host. **Installed only when Mock2 is
  enabled** (ADR-001-consistent). **Honor the ADR-010 guardrail.**
- **Manifest enforcement:** only the `mock2.yaml` web port is reachable from
  host/Caddy; `lib/port-detector.js` diffs live listeners against the manifest
  → `port_drift` queue item (`mock2_queue_items` already has the kind; surface
  via the notifications bell until the M8 queue UI).
- Frontend: an admin allowlist editor (audit-logged), and the debug card grows
  the bridge name. MOBILE_FIRST.

**Do NOT implement (later phases):** connectors/quotas/framework registry (M5 —
the egress allowlist references model-API hosts, so seed a static default now
and let M5 wire it to connectors); cycle runner / checkout lock (M6);
chat/mockups/audit/classifier (M7–M9); wildcard DNS-01 (deferred); LDAP
(ADR-007). The idle-stop **timer** is M9 — M4 leaves `sweepIdleStops` as the
boot-only + on-demand mechanism M3 shipped.

**Hard constraints:** Naming (R7) — nothing new uses the bare word "agent."
Absence (ADR-001) — new routes on `createMock2Router()`; the squid package +
its config + the per-project bridges + nftables edits are new host artifacts
that exist **only on an enabled host**, so a `MOCK2_ENABLED=false` (or pinned)
host must stay byte-for-byte as today (add an install/enable path, not an
always-on one). Docker/nsenter (R3) — every host path through
`lib/host-exec.js`, tested in both shapes. Never clobber operator/service Caddy
(`/etc/caddy/sites`, `/etc/caddy/custom`) or the shared-bridge assumptions in
`ensureNetworkNat()` / the L4 reconciler — Mock2 containers don't use
`service_l4_forwards`. Migrations append-only (505+). Zod on routes,
`{ error }` shape, `requireAdmin`/`requireSudo`, `logAudit`. Frontend passes
`MOBILE_FIRST.md`.

**What "done" looks like:** the M4 verify checklist in `04-phased-plan.md`
(egress allow/deny matrix from inside a container; inter-project + control-plane
unreachable; Postgres isolation; `npm install` works; non-Mock2 `pp-*`
containers untouched — regression-check one). Plus `cd admin/backend && node
--test 'src/__tests__/*.test.js'` (no NEW failures; write M4 tests stub-first)
and `cd admin/frontend && npm run build`. A `MOCK2_ENABLED=false` host still
behaves byte-for-byte like today (including: no squid installed, no
`m2br*` bridges, no new nftables rules).

**Commit as** `mock2-M4: <description>`. (M0–M3 are merged to `main`; branch M4
off `main`, open its own PR.)

**Before you finish:** write `docs/mock2/NEXT-SESSION-PROMPT-mock2-phase-06.md`
for **Phase M5** (connectors, quotas, framework registry — ADR-003) in this same
format: what M0–M4 shipped (especially the egress allowlist that M5 wires to
model connectors, and the per-project bridge/nftables/proxy factoring), plan-
bundle pointers, and M5 scope. **The one outstanding external prerequisite is
the framework content handoff for Phase M5 (risk R8)** — flag it in that prompt
so the operator supplies the constitution/skills/gates/design-system/template
before M5 build starts; it is not needed for M4.
