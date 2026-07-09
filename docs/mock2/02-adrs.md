# Mock2 Architecture Decision Records

Status values: **Proposed** (needs operator sign-off before the affected phase
starts) or **Accepted-by-brief** (the brief itself decided it; recorded here so
build sessions treat it as settled). Each ADR notes which phase enforces it.

---

## ADR-001 — Dev/prod trust inversion; absence-by-installation

**Status:** Accepted-by-brief (mechanism below is Proposed). **Phase:** M0.

**Context.** ProxyPilot's production posture is pull-based; Mock2 inverts it —
the orchestrator holds an exec handle into project containers and writes files
directly. The compliance claim must be "the module is absent by installation,"
not "a toggle is off." The codebase has no feature-gated route registration
and no persisted-operator-answer pattern (survey §1, §12).

**Decision.** Absence is enforced by four independent mechanisms, checked in
this order at boot:

1. **Pin file** `/etc/proxypilot/mock2.production.pin` — if present, Mock2 is
   hard-off: installer never prompts, `MOCK2_ENABLED=true` in `.env` is
   ignored with a logged warning, nothing below happens. Created by the
   operator (or a future production install profile); never created by code.
2. **Env flag** `MOCK2_ENABLED` (default `false` in `.env.example`). Fresh
   `install.sh` asks once with default **No** (`[y/N]`, matching the
   `install.sh:1202` prompt idiom); re-running `install.sh` re-asks only if
   the current value is `false` and no pin exists. `update.sh` never prompts:
   `sync_env_keys()` appends `MOCK2_ENABLED=false` to hosts that lack the key
   and never touches an existing value — the preserve-on-upgrade requirement
   falls out of the existing mechanism (`update.sh:130-222`).
3. **Separate state file.** All Mock2 state — including model API keys — lives
   in `data/db/mock2.db`, a second SQLite database opened only when enabled.
   On a disabled host the key store does not exist as a file, not merely as
   empty tables. Mock2's migrations (block 500) run inside that DB only.
4. **Conditional wiring.** `index.js` uses a dynamic `await import()` for the
   Mock2 router and runner behind the flag; when disabled, no `/api/mock2/*`
   route exists (404, indistinguishable from unknown route), no Mock2 boot
   sweep runs, no cron registers, and the frontend hides the nav entry when
   `GET /api/mock2/status` 404s.

**Honesty note (required in compliance language).** The brief's "LXC exec
socket is not mounted into the orchestrator" cannot be literally true on a
ProxyPilot host: the backend already holds host-exec capability
(nsenter / incus CLI) for its existing LXC management (survey §4). Mock2 adds
no *capability* that isn't already present; it adds new *uses* of it, and
those uses are what the four mechanisms above remove. The runner is backend
code, not a separate binary, so "the agent binary is not installed" maps to
"the runner code path is never imported" — if a separately-installed runner
binary is ever wanted for stronger separation, that's a later hardening step,
not v1. State the claim as: *"on a disabled host, no Mock2 route, state file,
credential store, or runner code path exists."*

**Consequences.** Enabling requires editing `.env` (or answering the installer)
AND adding at least one model connector — routes register on the flag, but
cycle-runner endpoints refuse to start work until a connector with a decryptable
key exists ("environment variable **and** presence of credentials"). Backups:
`mock2.db` sits in the DB dir the config-tier backup already packs
(`lib/backup-scope.js:9-16`) — acceptable, but restore onto a pinned host must
skip it; note in the restore path when Phase M0 lands.

---

## ADR-002 — Audit routing split: editors own rules, admins own deviations

**Status:** Accepted-by-brief. **Phase:** M8 (mechanism), M9 (classifier).

**Decision.** Audit output routes by kind, never by convenience. **Domain
questions** go to the project's editors as tappable choices in the chat;
answers append to the project's `state/rules.md` (in-repo) and constitute the
rules-confirmation sign-off. **Framework deviations** go to the admin queue
(`mock2_queue_items.kind='framework_deviation'`). A project's answer never
writes to the framework; a genuine standards gap opens a separate framework
change (ADR-003's registry, superadmin-gated).

**Mechanism.** One table (`mock2_audit_questions`) with a `route` column
(`editor`|`admin`) written by the audit step; editor questions render in-chat,
admin questions materialize queue items. Both block the cycle: status
`awaiting user` / `awaiting admin` are derived from open questions, not set by
hand. The three-outcome iteration classifier (implements / contradicts /
unaddressed) reuses the same question plumbing — outcome 2 and 3 create editor
questions; classifier bias is toward flagging (a false positive costs a tap).

**Consequences.** The queue table and question table must exist before any
build runs against real user intent — Phase M8 precedes public iteration.
Editors can be non-technical: question text is model-generated plain language
with fixed-choice options; free-text answer is always the escape hatch.

---

## ADR-003 — Framework registry: project floats, cycle pins

**Status:** Accepted-by-brief. **Phase:** M5 (registry), M6 (pinning).

**Decision.** The framework (constitution prose + four skills + gate scripts)
is a versioned bundle in `mock2_framework_versions` — one monotonic integer
across the whole bundle; content rows are immutable; revert = new version with
old content. Editing is **admin-gated** (operator decision 2026-07-09, relaxing the
  brief's superadmin-only rule; `is_superadmin` remains for the
  cannot-be-demoted protection in ADR-007), diff before commit, `logAudit`
  entry.
Projects are never pinned: each cycle snapshots `current_framework_version_id`
at start into `mock2_cycles.framework_version_id` and uses it for the entire
cycle; change records stamp it immutably. Drift = audit compares the project's
last-built version against current and raises a `drift` queue item; remediation
only ever happens as an explicit consented cycle labeled `Mock2 X → Y`.

**Consequences.** Gate scripts are content-addressed by version — the runner
copies the pinned version's gate scripts into the container at cycle start
(never "latest"). Optional git sync of the framework is an import path only;
the DB row a cycle pinned remains the source of truth for what actually ran.

---

## ADR-004 — Checkout lock is container-scoped

**Status:** Accepted-by-brief. **Phase:** M6.

**Decision.** One lock per project, held by whatever writes (human session or
cycle). Idle timer (default 15 min, admin-configurable via `mock2_settings`)
counts from **last write** — for a cycle, "write" is any exec that mutates the
working tree; for a human, any file-touching action through the module.
Auto-release always checkpoints first: commit (even dirty/WIP, message
`checkpoint: auto-release`) then release; the release that cannot commit does
not release — it escalates to `awaiting admin`. Holder is warned before expiry
(chat banner + keep-working button); waiters see holder + remaining time and
can request takeover (pings holder); admins force-release (audit-logged).
Viewers can never acquire.

**What this forecloses (write it in onboarding docs too):** branch-per-user,
parallel preview environments, and concurrent cycles per project. The lock
guards the *container* (working tree + dev server + DB), so any future
multi-writer feature requires per-writer containers or worktrees and a
redesign of this ADR — do not bolt branches onto the current lock.

**Consequences.** Lock state is one row per project (`mock2_locks`), enforced
in the API layer (every mutating project endpoint checks holder), not in git.
The existing terminal idle-timeout machinery (`terminal-ws.js:216-222`) is the
style precedent, not shared code.

---

## ADR-005 — Ports are declared, not discovered

**Status:** Accepted-by-brief. **Phase:** M2 (manifest read), M4 (enforcement),
M8 (drift).

**Decision.** Each project repo carries `mock2.yaml` declaring its topology
(`web: 3000` exposed; `postgres: 5432`, `valkey: 6379` internal). ProxyPilot
reads the manifest at provision/rehydrate and registers exactly one HTTPS
route to the declared web port; everything else is default-denied at the
project bridge. Scanning (`lib/port-detector.js`, already written) runs as
**verification**: diff live listeners against the manifest and raise a `drift`
queue item on mismatch. Never auto-allow a discovered port.

**Consequences.** The manifest is versioned with the code (survives archive/
rehydrate); changing exposure is a commit, visible in change records. The
Mock2 framework's project template ships the default manifest so the model
never has to invent one.

---

## ADR-006 — Local bare repo is primary; remotes are optional

**Status:** Accepted-by-brief. **Phase:** M2 (repos), M3 (rehydrate proves it),
M5 (remotes).

**Decision.** Every project gets a bare repo at
`/var/lib/proxypilot/mock2/repos/<project_id>.git` at creation, always. The
container's working clone uses it as `origin` (Incus disk device or
`git remote` over the bridge is decided in Phase M2 — see risks §R6). The
runner and users commit inside the container; the orchestrator fetches into
the bare repo after every checkpoint. External remotes (GitHub/Gitea
connectors) are push targets **from the orchestrator only**, using
connector-stored credentials that never enter a container; if direct push from
a container is ever required, mint per-repo write-only short-TTL tokens per
operation. "Export as zip" is `git archive` of the bare repo — same state
model, no second code path. Rehydrate-from-repo is the only recovery path and
must never depend on ZFS/Incus snapshots.

**Consequences.** The bare repo dir joins the backup story (add to
`backup-scope` service tier when Phase M2 lands). Archive = checkpoint →
final fetch → destroy container → keep repo + DB rows. Nothing is ever
deleted; retention/purge is an open policy item (risks §Q4).

---

## ADR-007 — Identity: reuse ProxyPilot auth now; LDAPS is a separate feature

**Status:** **Accepted** (operator, 2026-07-09). **Phase:** M2.

**Operator clarification (2026-07-09).** ProxyPilot's built-in auth is the
initial-setup and break-glass path. LDAPS, when it lands, is the
**user-provisioning/management layer**: LDAP authenticates ("proves
employment"); the local tables below authorize — a directory user maps to
admin / editor / viewer / **or nothing at all** (signed in but no access
until approved). That is exactly the shape this ADR's model supports, so
nothing here changes when LDAPS arrives; it slots in front of the same
`users` + membership tables.

**Context.** The brief specifies LDAPS-proves-employment + Postgres-grants-
access, directory reconcile, and a local break-glass superadmin. ProxyPilot
has no LDAP code at all, its user store is SQLite, and it already has local
users, TOTP/passkeys, revocable server-side sessions, lockout, and a
per-resource ACL pattern (survey §3).

**Decision.** Mock2 v1 rides the existing auth stack:
- Global roles: keep `admin`/`user`; add `users.is_superadmin` (0/1; the
  first admin is backfilled as superadmin; a superadmin cannot be deactivated
  or demoted by a non-superadmin — enforced in `routes/user.js`).
- Project roles: `mock2_project_members(project_id, user_id, role editor|viewer)`,
  modeled on `user_service_access`. Admins/superadmins bypass membership
  (and any such access is stamped `acting_as_admin` in transcripts and change
  records). Zero editors ⇒ derived `orphaned` status.
- Session revocation on deactivation already works (every request re-checks
  the session row) — the brief's requirement holds today.

LDAPS + scheduled directory reconcile becomes a standalone future feature
(it would slot cleanly *under* this model: LDAP would authenticate, the same
`users` table + memberships would authorize; the local superadmin requirement
is already satisfied). Building LDAP inside the Mock2 plan would couple an
org-wide auth change to a module that must be absent on production hosts.

**Consequences.** The brief's role table maps as: Superadmin →
`is_superadmin`; Admin → `role='admin'`; Editor/Viewer → membership rows.
No schema in `mock2.db` references LDAP.

---

## ADR-008 — Project databases: Postgres inside the project container

**Status:** **Proposed — still awaiting an explicit operator answer.** The
operator's 2026-07-09 review answered the identity half of the question but
not this one; confirm before Phase M2. **Phase:** M2 (template),
M4 (isolation verifies it).

**Context.** The brief wants a shared Postgres cluster with per-project roles,
PgBouncer, and `pg_hba` source scoping. No Postgres, PgBouncer, or any of that
provisioning exists on a ProxyPilot host (core phases 4–7 are unbuilt,
survey §13). Standing up a hardened shared cluster is a large infra project
whose misconfigurations leak *across* projects — the exact blast radius the
network design is trying to eliminate.

**Decision.** v1 runs PostgreSQL **inside each project container** (installed
by the project template). Consequences that fall out for free: the DB is
unreachable from other projects by construction (it never leaves the project
bridge, and Phase M4 marks 5432 internal per the manifest); archive/rehydrate
has one story (schema from Drizzle migrations in the repo; dev data is
disposable — seed scripts are part of the Mock2 standard); no PgBouncer, no
per-project role ceremony, no shared-cluster failure domain. Cost: RAM per
container (~50–80MB idle for Postgres 16) and no centralized DB ops — both
acceptable at dev-plane scale, and the idle-stop lifecycle (Phase M9) reclaims
the RAM.

Moving to a shared cluster later is an optimization behind the same manifest
line (`postgres: 5432 internal` → connection string in the container `.env`);
it does not change the repo contract, so deferring it costs nothing
structural. If the operator insists on shared-cluster-first, Phase M2 grows a
prerequisite phase implementing core-plan phases 4+7 — flagging that cost is
the point of this ADR.

---

## ADR-009 — TLS for project URLs: per-slug HTTP-01 certs; wildcard DNS-01 deferred

**Status:** **Accepted** (operator, 2026-07-09: "Caddy just grabs the Let's
Encrypt cert — that is fine for now"). **Phase:** M1.

**Context.** True wildcard certs require ACME DNS-01, which stock cloudsmith
Caddy cannot do (no DNS provider modules), and today ProxyPilot downgrades
wildcard domains to HTTP (survey §5). The original proposal was a `lego`
DNS-01 sidecar; the operator chose to stay on Caddy's ordinary Let's Encrypt
automation instead.

**Decision.** v1 issues an **individual certificate per active slug FQDN**
via Caddy's automatic HTTPS (HTTP-01) — no wildcard cert, no DNS provider
API, no new system service:

- Parent-domain registration still requires **wildcard DNS**
  (`*.dev.example.com` → this host). Verification before the domain becomes
  selectable: a random-label resolution check, then a successful probe-cert
  issuance on a canary FQDN (proves ACME works end to end).
- The Mock2-owned Caddy site file per parent domain contains **one site block
  per active slug/custom-domain FQDN** (bare-domain address → auto-HTTPS),
  regenerated on slug mint/rotate and custom-domain changes, reloaded through
  the existing `caddyAdapt`/`caddyReload` driver. The dev headers
  (`X-Robots-Tag: noindex`), `robots.txt` deny, and the disabled
  `forward_auth` hook ride in every block, unchanged from the brief.
- Rotation grace: old and new slug blocks coexist for the 1-hour window.
- Implementation option the M1 session may take instead of per-slug blocks:
  Caddy **on-demand TLS** with an `ask` endpoint (`GET /api/mock2/tls-ask`)
  that approves exactly the FQDNs in `mock2_projects`/grace-window slug
  history — one wildcard-address site block, certs minted on first hit.
  Either satisfies this ADR; pick whichever survives contact with the
  existing generator more cleanly.

**Known limits, accepted:** Let's Encrypt rate limits (50 new certs/week per
registered domain — ample for dev scale, but slug-rotation churn counts
against it; surface a notification if issuance starts failing); first hit
after a mint/rotate pays cert-issuance latency (seconds).

**Upgrade path, deferred:** the lego DNS-01 sidecar issuing a real wildcard
cert into `/var/lib/proxypilot/mock2/certs/<domain>/` with explicit
`tls cert key`. The `mock2_parent_domains.dns_provider`/`dns_credentials_enc`
columns exist for it and stay NULL in v1.

---

## ADR-010 — Egress control: default-deny bridge + filtering proxy

**Status:** **Proposed — awaiting operator confirmation.** The operator's
2026-07-09 review asked what the egress proxy is; the plain-language
explanation and the weaker fallbacks are in `05-risks-and-open-questions.md`
§Q6. Nothing here is in ProxyPilot today; the proxy is installed **only when
Mock2 is enabled** (ADR-001-consistent). If vetoed, Phase M4 ships bridge
isolation without FQDN egress filtering and the brief's "egress allowlist"
requirement is formally dropped. **Phase:** M4.

**Context.** The brief wants a per-project egress allowlist (registries, git
remote, model APIs — nothing else). Allowlists are FQDN-shaped; nftables
matches IPs, and registries/APIs live behind CDNs with rotating IPs. Pure
firewall rules can't express "npmjs.org only." The CLI firewall's
`container_egress` chain exists but only gates bridge→host-service traffic
against a hardcoded list (survey §13).

**Decision.** Two layers, both per-project:
1. **nftables at the project bridge (default deny):** allow DNS to the host
   resolver, established/related, traffic to the container's own bridge
   gateway ports that the manifest exposes (for Caddy), and TCP to the host's
   egress proxy port. Deny inter-bridge, deny control-plane subnets, deny
   direct internet egress. Extend the `table inet proxypilot` /
   `container_egress` chain rather than inventing a second table; the state
   model in `/var/lib/proxypilot/firewall.json` grows a per-project section.
2. **Filtering forward proxy on the host** (Squid or tinyproxy with a
   per-project ACL file; one listener, source-IP → project mapping since each
   project has its own bridge subnet): allows CONNECT/GET only to the
   project's allowlist — default: `registry.npmjs.org`, the configured model
   API hosts, the project's git remote host if any. Containers get
   `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` baked into the template's
   environment; npm/pip/git all honor them. TLS is tunneled (CONNECT), not
   intercepted — the proxy filters by SNI/host, never decrypts.

A model that ignores the proxy env vars hits the bridge default-deny and gets
nothing — the enforcement is the firewall; the proxy is the *allow* path.

**Consequences.** Per-project bridges become real (one managed Incus bridge
`m2-<project>` each, created at provision; the CLI's `createNetwork` REST
pattern shows how). The shared-bridge assumption in `ensureNetworkNat()` and
the L4 reconciler is untouched — Mock2 containers don't use `service_l4_forwards`.
Allowlist edits are editor-visible, admin-gated, audit-logged. Scan-vs-manifest
drift (ADR-005) covers the inbound side; this ADR covers outbound.
