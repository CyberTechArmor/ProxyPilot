# Survey: what exists, what's new, and where the seams are

Everything below was verified against the code on 2026-07-09 (branch head of
`main` at the time of planning). Citations are `file:line` and clickable in
Claude Code. Sections end with a **Seams** list — the exact code a Mock2 build
session extends — and, where relevant, a **Corrections to the brief** note.

A recurring theme: `cli/` and `docs/core/` describe a second, largely-planned
"core infrastructure" product (Postgres, PgBouncer, Infisical, Valkey, audit
sync). The **running product** is `admin/backend` + `admin/frontend`. Several
things the brief assumes exist are only in that planned layer.

---

## 1. Runtime shape and module gating

**Exists.** Express 4 ESM app, `better-sqlite3` WAL SQLite. Every router is
imported at top of `admin/backend/src/index.js:12-23` and mounted
unconditionally at `index.js:411-423`; `/api/auth` is the only unauthenticated
mount. There is **no env-gated route registration anywhere** — the closest
precedent is `PROXYPILOT_DISABLE_CRONS` gating background crons
(`lib/backup-scheduler.js:140`).

**New for Mock2.** Conditional module loading: a single guard in `index.js`
that skips the `import` and the `app.use('/api/mock2', …)` mount when the
module is disabled (ADR-001). This is a new pattern but a small one.

**Seams:** `admin/backend/src/index.js:411-423` (mount point),
`index.js:474-547` (post-listen reconcilers — Mock2 boot sweeps go here),
`index.js:455-456` (interval scheduler precedent).

## 2. Database and migrations

**Exists.** Migration framework with reserved version blocks per feature area
(`db.js:55-84`): 1–8 core, 100s routing/L4, 200s backups, 300 notifications,
400 cert-mounts. `runMigration()` at `db.js:172-199`. Column-level secret
encryption: AES-256-GCM keyed by `TOTP_ENCRYPTION_KEY` (32-byte hex, no KDF),
wire format `enc:v1:<iv>:<tag>:<ct>` — `lib/secrets.js:16-19,62-89`. Used for
TOTP secrets and S3 credentials (`db.js:808-809`, `routes/backups.js:244,303`).

**New for Mock2.** Mock2 state lives in a **separate SQLite file**
(`data/db/mock2.db`), attached only when the module is enabled — this is how
"no model API key store exists" on a disabled host becomes literally true
(ADR-001). Mock2 claims migration block **500** inside its own DB. Reuse
`encryptSecret`/`decryptSecret` for connector keys.

**Correction to the brief:** the brief says "Mock2 lives in Postgres." There
is no Postgres on a ProxyPilot host — the orchestrator's store is SQLite, and
Mock2's orchestrator state should be too (ADR-008 covers project databases).

**Seams:** `admin/backend/src/db.js:55-84` (numbering convention),
`lib/secrets.js:62-89` (encryption primitives).

## 3. Authentication, roles, sessions

**Exists.**
- JWT (HS256) in httpOnly `pp_token` cookie, `jti` keyed to a revocable
  `sessions` row with sliding idle + absolute TTL
  (`middleware/auth.js:73-136`, `db.js:535-553`). Deactivating a user can
  revoke live sessions today — the revocation check runs on every request and
  on WebSocket upgrade (`middleware/wsAuth.js:61-66`).
- Sudo elevation (`requireSudo`, `middleware/auth.js:187-209`) with password+
  TOTP or passkey; frontend modal auto-retries the original call once
  (`admin/frontend/src/lib/api.js:76-83`).
- Roles: **exactly two** — `users.role IN ('admin','user')` (`db.js:224`).
  First user force-promoted to admin (`db.js:250-256`).
- Per-resource ACL precedent: `user_service_access(can_view, can_write)` +
  `canViewService`/`canWriteService` helpers with admin bypass
  (`db.js:263-274`, `middleware/auth.js:225-277`). This is structurally the
  editor/viewer model, scoped to services instead of projects.
- Account lockout, WebAuthn, TOTP, trusted devices — all present.

**Not present — corrections to the brief:**
- **LDAP/LDAPS: zero code, zero dependencies.** The two-step
  LDAPS-proves-employment design is entirely new work (ADR-007 defers it).
- **No `superadmin` or `viewer` global role.** Mock2 needs project-scoped
  roles (`editor`/`viewer` per membership) and a `is_superadmin` marker.
  The "local superadmin independent of LDAP" requirement is trivially
  satisfied today because *all* users are local.
- "Postgres grants access" → SQLite grants access.

**Seams:** `middleware/auth.js:212-222` (`requireAdmin` — template for
`requireMock2Role`), `user_service_access` pattern for `mock2_project_members`,
`routes/user.js:575-615` (session revocation endpoints).

## 4. LXC / Incus lifecycle

**Exists (backend path — the one Mock2 extends).**
- Shells out to the `incus` CLI, pivoting through `nsenter -t 1` when the
  backend runs in Docker (`routes/lxc.js:66-92`, shared lib
  `lib/host-exec.js:37-72`). Incus is the source of truth; **there is no
  `containers` DB table** in the backend.
- Create is an async job: `202` + in-memory `activeCreations` Map + poll
  endpoint (`lxc.js:738-1143,1146`). Instances are prefixed `pp-`
  (`lxc.js:49`). Unprivileged by default; `security.nesting` etc. only when
  Docker-in-LXC is requested (`lxc.js:914-925`). Resource limits via
  `incus config set limits.cpu/limits.memory` (`lxc.js:983-990`).
- Exec: one-shot `incus exec … -- sh -c` with 60s timeout (`lxc.js:2734-2767`);
  interactive PTY over WebSocket (`routes/terminal-ws.js`, `lib/pty.js:65-121`);
  file push/pull (`lxc.js:2930,2973`).
- Snapshots: create/list/export exist; **no restore endpoint in the backend**
  (the CLI layer has one via REST, `cli/src/incus/client.js:226-232`).
- Port detection: `readListeningPorts` parses `/proc/net/tcp,udp` inside the
  container (`lib/port-detector.js:166-167`) — this is the scan half of
  "scanning is verification" already written.

**Not present:**
- **Per-container/per-project networking.** All containers share one bridge;
  `ensureNetworkNat()` NATs every managed bridge (`lxc.js:105-154`). The CLI
  layer knows how to create managed bridges with static IPs
  (`cli/src/lxc/networking.js:47-65`) but the backend never does.
- **Idle-stop, container quotas** — none anywhere.
- The Go host agent (`cmd/agent`) is installed and load-bearing for one CVE
  routine, but has **no container methods**; all container ops go through
  nsenter+CLI. (Terminology note: the brief's "agent" is the AI runner, a
  different thing — the plan calls it the **runner** to avoid collision with
  `proxypilot-agent`.)

**Seams:** `routes/lxc.js:738-1143` (create-job pattern to reuse for project
provisioning), `lxc.js:2734-2767` (exec), `lib/pty.js:65-121` (long-lived
exec), `lib/port-detector.js` (manifest verification), `l4-reconciler.js`
(DB-authoritative reconcile pattern to copy for bridges/routes).

## 5. Routing, TLS, Caddy

**Exists.** Two-table route model (`services` + `service_http_routes`,
`db.js:308-333,444-457`); one generated file per domain in
`/etc/caddy/sites/` (`services.js:242-248`); reload via adapt+reload driver
with an nsenter path and an agent path behind `PROXYPILOT_USE_AGENT_FOR_CADDY`
(`lib/caddy-driver.js:76-125`). Caddy reaches containers directly at
`bridge_ip:port` — **no host port allocation exists today**, which matches the
brief's requirement for free (`services.js:5832-5834`). L4 forwards reconcile
to Incus proxy devices (`lib/l4-reconciler.js`).

**Not present — corrections to the brief (this is the biggest gap):**
- **Wildcard TLS does not exist.** Any `*.domain` is force-downgraded to
  `http://` in the generated site address (`services.js:6056-6060`); docs
  confirm wildcards serve plaintext. There is **no DNS-01/ACME-DNS support
  anywhere**, and stock (cloudsmith apt) Caddy ships no DNS provider modules.
  Parent domains with wildcard certs are a new capability with installer
  impact (ADR-009).
- **No domain-ownership verification** of any kind (no TXT/A checks).
  Parent-domain and custom-domain verification flows are new.
- **No `forward_auth`**, no `X-Robots-Tag`, no `robots.txt` handling, no
  custom-header control — the generated `header{}` block is fixed
  (`services.js:6136-6171`). The brief's day-one requirements (noindex
  headers, robots.txt deny, forward-auth hook present-but-off) all require
  extending the generator — or, better, a **separate Mock2-owned site
  template** written to the same `/etc/caddy/sites/` dir (one file per parent
  domain with a `map`/`handle` per slug), so Mock2 routes don't contort the
  existing per-service generator.
- `lib/caddy-cert.js` resolves **already-issued** cert directories for
  bind-mounting into containers; it does not obtain certs, and its wildcard
  path handling doesn't match Caddy's on-disk `wildcard_.domain` naming
  (`caddy-cert.js:93-96`) — don't build on it for wildcard work.

**Seams:** `services.js:87-173` (`ensureCaddyStructure` — global block +
imports), `services.js:5923-6183` (site-block builder to mirror, not modify),
`lib/caddy-driver.js` (reload), `CADDY_SITES_DIR` env.

## 6. Git

**Exists.** Nothing in the Node backend. The only git in the repo is the
Python CVE engine's shallow read-only clones (`proxypilot/engine/source_git.py`).
`update.sh` itself is the pull-based production update path
(`update.sh:538-570`) — confirming the brief's "production pulls" model.

**New for Mock2.** All of it: per-project bare repo on the host
(`/var/lib/proxypilot/mock2/repos/<project>.git`), init/fetch/archive
operations from the orchestrator (via `spawnHost` so it works in Docker),
working clones inside project containers, checkpoint commits, external-remote
push from the orchestrator only, `git archive` zip export (ADR-006).

**Seams:** `lib/host-exec.js` (run `git` on the host), the CVE inbox's
additive-sync discipline (`source_git.py:284-357`) as a style reference.

## 7. Secrets and connectors

**Exists.** The S3 destination pattern is the connector template Mock2 should
copy exactly (table + encrypted secret column + `publicShape()` that computes
`secret_decryptable` + test endpoint + daily healthcheck with deduped
notification): `db.js:815-839`, `routes/backups.js:88-122,244,303,358-389`,
`lib/s3.js:37-124`, `lib/backup-s3-healthcheck.js`.

**Not present:** Infisical — zero integration in running code (planning docs
only: `docs/core/prompt/09-infisical.md`). The brief's "production injects
from Infisical at pull time" describes the *other* (production) host's planned
capability; nothing in the Mock2 module depends on it. Project-container
`.env` management is new but simple (file in container, editor-gated routes).

## 8. Jobs, long operations, queues

**Exists.** No generic job queue. The established pattern is **per-domain
status table + boot orphan-sweep + frontend polling**:
`restore_runs` with append-only `steps_json` (`db.js:927-948`),
`lxc_snapshot_s3_exports` with bytes-progress + `cancel_requested`
(`db.js:1085-1150`), boot sweeps at `index.js:216-404`. The backup scheduler's
single-flight `busy` + FIFO queue (`lib/backup-scheduler.js:49-53,161-188`) is
the concurrency precedent. The CVE inbox (`routes/cves.js`) is a working
"queue of actionable items with statuses and admin actions" precedent.

**New for Mock2, following those patterns.** `mock2_cycles` is a status table
(orphan-swept to `failed` at boot); cycle/gate progress reaches the UI by
polling (which fits the brief — the user sees stages and gates, not a token
stream); the admin queue is a DB table (`mock2_queue_items`), not a filesystem
inbox. Chat delivery can start as polling; SSE is a later nicety.

## 9. Audit and change records

**Exists.** `audit_log` + `logAudit()` helper (`db.js:1376-1387,1566-1574`) —
append-only by convention, not enforced, not hash-chained. WS/terminal
sessions already audit start/end.

**New for Mock2.** `mock2_change_records`: append-only **and hash-chained**
(`prev_hash`, `hash` columns; chain verified on read), carrying initiator,
acted-as-admin flag, pinned framework version, rules touched, gates run
(ADR field list in `03-data-model.md`). Keep writing `logAudit` rows too for
host-level actions (lock force-release, connector edits, framework edits).

## 10. Notifications and the admin queue

**Exists.** One channel: in-app bell backed by `notifications` table with
dedupe-key UPSERT and auto-resolve (`lib/notifications.js:28-100`). Frontend
polls every 30s (`Layout.jsx:60-108`).

**New for Mock2.** The admin queue is its own table + page (queue of items,
filterable by project — brief's requirement), with `postNotification` used
only as the attention-getter ("3 items awaiting admin"). Editor-facing rule
questions are *not* notifications; they render in the project chat.

## 11. Frontend

**Exists.** React 18 + Vite, React Router 6, shadcn/ui, Tailwind, plain
Context + `setInterval` polling (no react-query, **no frontend Zod** — CLAUDE.md
overstates that). Tile pattern: shadcn Card grid `grid-cols-1 sm:grid-cols-2
lg:grid-cols-3` with `StatusBadge` (`LxcContainers.jsx:34-60,2145-2285`).
Create-progress phase stepper (`LxcContainers.jsx:2304-2340`) is the canonical
"watch stages go green" UI — exactly the shape the Build view needs. Terminal
WS component exists (`InteractiveTerminal.jsx`). Role gating in UI is cosmetic
admin/user; backend is authoritative. MOBILE_FIRST.md is a merge gate.

**New for Mock2.** Projects page (tiles), project detail (chat, design
section, changelog, adaptive summary, preview link), admin queue page,
framework registry editor (superadmin, markdown + diff), connectors settings.
All must pass MOBILE_FIRST — chat and tappable rule questions on a 360px
screen is a design constraint to hold from the first mock.

## 12. Installer, updates, absence-by-installation

**Exists.**
- `install.sh` is purely interactive (`read -rp` prompts, `[Y/n]` confirm
  precedent at `install.sh:1154,1202-1207`); writes `/opt/proxypilot/.env`
  (`install.sh:893-977`), preserves existing secrets on re-run
  (`install.sh:907-933`).
- `update.sh` is the pull-based updater (`git pull origin main`,
  `update.sh:565-570`) with `sync_env_keys()`: any key present in
  `.env.example` but missing from the deployed `.env` is **appended verbatim
  with its example default** (`update.sh:130-222`). This is precisely the
  mechanism that makes "non-interactive upgrades preserve the answer / never
  default to enabled" work: ship `MOCK2_ENABLED=false` in `.env.example` and
  an upgraded host gains the key as `false`; an existing value is never
  touched.
- **No pin-file or persisted-answer pattern exists** — the production pin is
  a new (tiny) mechanism (ADR-001).
- Docker detection + nsenter pivot (`lib/host-exec.js:26-60`); the backend
  container already holds host-exec capability for LXC management, which
  bounds what "absence" can mean (see ADR-001 honesty note).

**Seams:** `install.sh:1202-1207` (prompt pattern), `update.sh:130-222`
(env retrofit), `.env.example` (canonical key list — add the `MOCK2_*` block).

## 13. Planned-but-unbuilt core phases Mock2 must not assume

From `docs/core/plan/99-execution-order.md` and verified absent from code:
PostgreSQL + PgBouncer (phase 4), Valkey (5), Infisical (6), pgBackRest (7),
audit logging sync (9, beyond the existing `audit_log` table), compliance
checker (18), observability (20). The CLI firewall's `container_egress`
nftables chain exists (`cli/src/core/firewall/render.js:151-180,246-249`) but
today only gates bridge→host-service traffic against a hardcoded service list
— it is an insertion point for Phase M4, not a finished egress allowlist.

---

## Scorecard against the brief's subsystem assumptions

| Brief assumes | Reality | Verdict |
|---|---|---|
| LXC lifecycle exists | Yes — create/exec/snapshot/export, async-job pattern | **Reuse** |
| Routing exists | Per-domain HTTP routes, container-IP upstreams, no host ports | **Reuse + extend** |
| Wildcard cert management | Absent; wildcards downgraded to HTTP; no DNS-01 | **New (ADR-009)** |
| Secrets management | Column encryption + S3 connector pattern | **Reuse pattern** |
| LDAPS auth, superadmin/viewer roles | No LDAP; two roles only; per-service ACL seam | **Defer LDAP (ADR-007); new project roles** |
| Shared Postgres + PgBouncer | Nothing built | **Deviate: per-container Postgres (ADR-008)** |
| Infisical injection | Planning docs only | Out of Mock2 scope; note in secrets manifest doc |
| Observability | Bell notifications + audit_log only | Sufficient for v1 |
| Job queue / stage machine | Per-op status tables + polling | **Reuse pattern** |
| Git plumbing | None in backend | **New (ADR-006)** |
| Network isolation | Single shared bridge; egress chain scaffold in CLI firewall | **New (ADR-010)** |
