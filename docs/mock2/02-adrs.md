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

**Amendment (2026-07-29, operator decision).** Adoption is now **automatic by
default**: a sweep (`auto-adopt.js`, boot + 10-minute timer) starts the same
`Mock2 X → Y` update cycle for any project that is online, idle, past design
approval, and has built before — at most once per project per published
version (every cycle pins the version at insert, so even a refused or failed
attempt latches). The explicit-consent behaviour survives as the
`framework_auto_adopt = off` setting (Framework admin page /
`MOCK2_FRAMEWORK_AUTO_ADOPT`), and the manual "Update now" button still works
either way. Rationale: the banner nagged on every project after every publish,
and a project whose operator missed it kept building against a constitution
the install had moved past.

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

**Status:** **Accepted** (operator, 2026-07-09). The confirmed three-way
split: user access to projects is gated by SQLite (memberships on top of
ProxyPilot auth); project details, chats, cycles, and change records live in
SQLite (`mock2.db`); and **each project gets its own Postgres, inside its
container, used only by that project's generated application** — ProxyPilot
itself never stores anything in it. **Phase:** M2 (template),
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

> **SUPERSEDED (2026-07-13): squid removed.** The filtering proxy was
> unreliable — a single malformed `http_port` line failed every provision (its
> ready-check was a hard gate), and it exceeded the complexity guardrail below
> in practice. It has been removed. Egress is now the project bridge's own Incus
> NAT (`ipv4.nat=true`); the nftables fence (a) blocks + logs lateral movement to
> RFC1918 / link-local ranges (other bridges, the host LAN, the control plane)
> and (b) LOGS every new outbound connection to the kernel log, which the backend
> parses into the per-project "egress traffic" view. Consequence: hostname
> allowlisting is gone (it is not enforceable at the IP layer) — egress is
> monitor-style (log, don't block by host), and the firewall log replaces
> squid's access log. The rest of this ADR is retained as historical context.

**Status:** **Accepted with a complexity guardrail** (operator, 2026-07-09:
"squid is only fine if it doesn't add that much complexity"). The intended
weight is: one apt package, one systemd service, and one ProxyPilot-generated
config file with per-project ACLs — the same generate-config → reload →
reconcile-at-boot pattern already used for Caddy sites and L4 forwards, and
smaller than either. **Guardrail:** if the Phase M4 implementation grows
materially beyond that (custom builds, TLS interception, per-project proxy
instances), stop, fall back to bridge-isolation-only (no FQDN egress
filtering), and record the dropped allowlist requirement here. The proxy is
installed **only when Mock2 is enabled** (ADR-001-consistent). Plain-language
explanation in `05-risks-and-open-questions.md` §Q6. **Phase:** M4.

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

**Implementation note (M4 build session, 2026-07-10).** Two decisions were
made against the running code and are recorded here (as M1 recorded its
Caddy-shape choice):

1. **A dedicated `table inet mock2`, NOT an extension of `table inet
   proxypilot`.** The letter of this ADR said "extend the `container_egress`
   chain." Building it revealed that would be actively unsafe: the running
   backend does not manage nftables directly — it shells to the CLI binary
   (`routes/firewall.js` → `proxypilot firewall …`), whose renderer emits
   `flush table inet proxypilot` on *every* reconcile
   (`cli/src/core/firewall/render.js`). Anything Mock2 added to that table
   would be wiped the next time an operator toggled a firewall rule, and the
   CLI firewall may not be installed at all (it is the "largely-planned core"
   layer, survey §13). A dedicated table is (a) byte-for-byte absent on a
   disabled host — the module never imports the firewall code there, so the
   table never exists (ADR-001); (b) un-clobberable by the CLI's flush; and
   (c) no weaker for the deny half, because nftables `drop` is final across
   tables. State lives in Mock2's own file (`MOCK2_DATA_DIR/firewall.json`),
   never the CLI's `/var/lib/proxypilot/firewall.json`. Implemented in
   `admin/backend/src/mock2/firewall.js` (rules) + `network-logic.js` (pure
   renderer). The forward hook denies bridge egress + non-web inbound; the
   input hook permits DNS/DHCP/proxy to the bridge gateway only and denies the
   control plane. Both at `priority -10` (in front of the postrouting NAT path
   — risk R2).
2. **The R2 cross-table matrix is verified on a host, not from docs.** The one
   interaction the code cannot settle by construction is how Mock2's *allow*
   rules (DNS/proxy to the gateway) coexist with the CLI firewall's input
   `policy drop` *when that firewall is installed and active*: an `accept` in
   the Mock2 table does not stop a later `drop` in the CLI's `input_hook`. This
   is exactly the "real test matrix, not reasoning from docs" R2 demanded, and
   is a step in `scripts/mock2-m4-verify.sh`. The deny half holds regardless
   (drop is final); if the allow half is blocked on a CLI-firewalled host, the
   remedy is to permit the `m2br*` bridges' DNS+proxy ingress in that firewall.
   On a host without the CLI firewall's input policy-drop (the common case),
   the Mock2 input chain's allow + deny is self-sufficient.

**Guardrail compliance.** The squid layer meets the ADR-010 weight exactly:
one package (squid), one service (the stock unit), one generated file
(`/etc/squid/conf.d/mock2.conf`, ACL-only, regenerated per project by
`mock2/egress.js`). Installed only when enabled, by `scripts/mock2-enable-egress.sh`
(invoked from `install.sh`). No custom build, no TLS interception, no
per-project proxy instance — so the guardrail's fallback (bridge-isolation-only)
was not triggered and no allowlist requirement was dropped.

---

## ADR-011 — Bare-repo ↔ container git transport: Incus disk-device mount

**Status:** **Accepted** (M2 build session, 2026-07-09; resolves risk R6).
**Phase:** M2 (transport), M3 (rehydrate exercises it).

**Context.** Every project has a bare repo at `MOCK2_DATA_DIR/repos/<id>.git`
(ADR-006). R6 left the container↔bare-repo transport open: mount the bare repo
as an Incus disk device (simplest, but a hostile container can corrupt the bare
repo), or expose it over the project bridge via `git daemon`/HTTP (cleaner trust
story, more moving parts, and in M2 there is no per-project bridge yet — that is
M4). The M2 verification checklist also requires that `git log` in the bare repo
shows the seed commit immediately, and that no host port is ever exposed.

**Decision.** M2 mounts the bare repo into the container as an **Incus disk
device** (`incus config device add <c> reporepo disk source=<repo>
path=/srv/repo.git shift=true`); the container's working clone at `/srv/app`
uses `/srv/repo.git` as `origin` over that mount. No git-over-bridge transport,
no `git daemon`, no host port. The **seed commit is made host-side** in
`provision.js` (a temp work tree → `git push` into the bare repo) *before* the
container exists, so the bare repo's `git log` proves the seed the moment
provisioning reaches step 2 — independent of the container ever coming up.
Checkpoint fetches (the runner writing back, M6) will `git push` from inside the
container over the same mount; the orchestrator never depends on `incus file
pull` at scale (R6's rejected path).

**Mitigations for the shared-mount trust cost (R6's concern).** `shift=true`
keeps the mount inside the unprivileged container's id-map; a future phase can
tighten to read-only + orchestrator-side fetch if a hostile runner becomes a
real threat model. `git fsck` on the bare repo after a checkpoint and the bare
repo joining the backup story (ADR-006) bound the blast radius. M2's placeholder
has no runner writing into the container, so the write path is not yet exercised
— M3 rehydrate is where the mount's round-trip (clone-from-repo → modify →
fetch-back → rehydrate) is proven end to end.

**Consequences.** Archive (M3) keeps the bare repo and the mount definition;
rehydrate re-adds the disk device and re-clones. Per-project bridges (M4) do not
change this decision — the mount is orthogonal to the network fence. Delete (M2)
destroys the container but **keeps** the bare repo and the slug-history
reservation, so the slug stays un-reusable forever.

## ADR-012 — Declared, admin-approved outbound egress grants

**Context.** ADR-010's fence NATs each project bridge to the internet but blocks
(and now `reject`s) lateral movement to RFC1918 / link-local ranges — other
bridges, the host LAN, the control plane. That is the right default, but some
apps have a legitimate need to reach ONE internal host: an ADP LDAPS directory at
`ldaps://<lan-ip>:636`, an internal API, a licence server. Hostname allowlisting
died with squid (ADR-010 implementation note); we needed a way to punch a narrow,
audited hole in the deny-private block for a specific `host:port` without
reopening the whole private range.

**Decision.** Egress is **declared, never inferred** — the same discipline as
ports (ADR-005), extended to egress:

- An app declares what it must reach in `mock2.yaml` under `egress:` — a list of
  `{host, port, protocol, reason}`. Anything not listed stays blocked.
- On deploy/provision the declaration is synced into `mock2_egress_grants`
  (migration 511): each new entry becomes a `pending` grant plus an
  `egress_grant` admin-queue item; a removed entry is `revoked`.
- An admin approves or denies each grant through the existing admin-queue flow
  (resolve → approved, dismiss → denied). Approval stamps who + when on the grant
  row and is `logAudit`'d (`MOCK2_EGRESS_GRANT_APPROVE` / `_DENY`) — the audit
  trail the acceptance test requires.
- Only **approved** grants are wired. On reconcile the firewall resolves each
  approved host to an IPv4 and `renderEgressGrantRules` emits a scoped
  allow-hole (`ip saddr <bridge> ip daddr <ip> <proto> dport <port> accept`)
  **before** the deny-private block, with its own `mock2-egress-grant` log
  prefix. Revoking (removing the declaration or denying) drops the rule on the
  next reconcile.

**Failure visibility (acceptance #4).** deny-private changed from `drop` to
`reject with icmpx type admin-prohibited`, so a policy-blocked connection fails
fast with "connection refused" — distinguishable in-container from a real
host-down timeout. The firewall log now carries three actions: `GRANT` (allowed
to a declared host), `OUT` (general internet), `BLOCK` (policy-denied). A failed
`GRANT`/`OUT` is therefore host-down, not policy.

**Host reachability preflight (acceptance #5).** Before wiring, ProxyPilot probes
whether the HOST itself can route to the destination (`probeHostReachable`, a TCP
connect from the host) and records the result on the grant
(`ok`/`refused`/`timeout`/`unreachable`/`dns_fail`). If the host can't reach the
directory, that is reported as the blocker rather than built around; the Details
"Outbound egress" card surfaces it and admins can re-probe on demand.

**Consequences.** The pure layer (`egress-logic.js`: parse, validate, nft render)
is unit-tested at the module boundary; the store (`egress-grants.js`), the fence
wiring (`firewall.js`), and the probe (`network.js`) are the host-acting shells.
No inference anywhere: a grant exists only because the app declared it, and it is
wired only because an admin approved it.
