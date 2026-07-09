# Mock2 Phased Implementation Plan

Ten phases. Each leaves the system working, is independently testable, and is
useful on its own. Work through them sequentially unless a phase's header says
it can float. Per-phase workflow is the same as `docs/core/plan/00-how-to-use.md`:
read the phase, read the cited survey/ADR/data-model sections, implement, run
the verification checklist, commit `mock2-MN: <description>`, write the next
`NEXT-SESSION-PROMPT`, move on.

## Where this ordering disagrees with the brief's instinct, and why

The brief proposed: registry/routing → rehydrate → cycle runner → chat/mockup
→ audit → classifier. Three amendments, all driven by the codebase:

1. **Wildcard TLS moves to the front (M1).** It's the plan's only piece with
   installer impact, a new system dependency (lego), and an external
   dependency (a DNS provider API). Everything user-visible routes through it.
   If it slips, every later phase can still be tested on plain HTTP, but you
   want that discovered in week one, not week six. (Survey §5: wildcards are
   HTTP-only today; ADR-009.)
2. **Network isolation (M4) moves before the cycle runner (M6).** The brief's
   own safety argument — "the unconstrained agent is safe because of the
   network, enforce it in the network not the prompt" — is an ordering
   constraint: no runner ever execs into a container that isn't behind the
   fence. Today all containers share one bridge (survey §4), so the fence is
   real work, not config.
3. **Connectors + framework registry (M5) move before the runner (M6),**
   because a cycle can't start without a model slot to call and a framework
   version to pin (ADR-003). Both are plain CRUD with existing patterns —
   cheap to build early, blocking if built late.

Rehydrate stays exactly where the brief put it: immediately after
provisioning, proven before anything depends on it (M3).

---

## Phase M0 — Module skeleton and absence-by-installation

**Goal:** the gate everything else lives behind. *(ADR-001; survey §1, §12.)*

**Scope:**
- `MOCK2_ENABLED=false` + `MOCK2_DATA_DIR` in `.env.example`; `install.sh`
  fresh-install prompt (`[y/N]`, default No, suppressed by pin file, re-asked
  on re-run only when currently `false`); `update.sh` needs **no change**
  (`sync_env_keys` retrofits the key as `false` — verify, don't assume).
- Pin file check `/etc/proxypilot/mock2.production.pin` (hard-off, logged).
- `admin/backend/src/mock2/` module: `db.js` (opens `data/db/mock2.db`,
  migration registry block 500, migrations 500–503 from `03-data-model.md`),
  `routes.js` (only `GET /api/mock2/status` for now), dynamic-import wiring in
  `index.js` behind the flag; boot sweep stub.
- Main-DB addition: `users.is_superadmin` (backfill first admin).
- Frontend: nav entry + empty Projects page, rendered only when
  `GET /api/mock2/status` succeeds; hidden otherwise.
- Tests: stub-DB pattern (module-boundary stubs like the passing 73), covering
  flag/pin gating logic.

**Verify:** disabled host → `/api/mock2/*` is 404, `mock2.db` absent, no nav
entry. Pin + `MOCK2_ENABLED=true` → still off, warning logged. Enabled →
status 200, `mock2.db` created with schema, nav visible to admins.
`update.sh` on a `.env` without the key → key appended as `false`.

## Phase M1 — Parent domains and wildcard TLS

**Goal:** superadmin registers `dev.example.com`; `https://anything.dev.example.com`
serves a placeholder with dev headers. *(ADR-009; survey §5.)*

**Scope:**
- `mock2_parent_domains` CRUD (superadmin; DNS credentials via `encryptSecret`).
- lego integration: install-when-enabled (install.sh/update.sh), issuance +
  renewal systemd timer, renewal-failure → deduped notification
  (S3-healthcheck pattern, survey §10).
- Registration verification pipeline: wildcard DNS check (random label →
  host IP) → DNS-01 issuance → `verify_status='cert_ok'`.
- **Mock2-owned Caddy site file per parent domain** (do not modify
  `buildDomainCaddyConfig`): wildcard site address, explicit `tls cert key`,
  `X-Robots-Tag: noindex`, `robots.txt` deny handler, a `forward_auth`
  block behind a comment/flag **rendered but disabled** (the day-one hook),
  and a slug→upstream map (empty for now → placeholder page). Reload via the
  existing `caddyAdapt`/`caddyReload` driver.

**Verify:** register a real domain end to end; `curl -H 'Host: x.dev.example.com'`
gets valid TLS, noindex header, robots.txt deny; cert renewal dry-run passes;
un-verified domain is not selectable in the (stub) project-create API.

## Phase M2 — Project registry, container, bare repo, live URL (no AI)

**Goal:** the brief's first instinct phase: create project → container +
bare repo + slug route → live placeholder app. *(ADR-005/006/007/008;
survey §3, §4, §6.)*

**Scope:**
- `mock2_projects`, `mock2_project_members`, `mock2_slug_history` CRUD;
  slug minting (`p-` + 8 hex, reserved prefixes blocked, unique per parent);
  membership roles + `requireMock2Role` middleware (admin bypass stamps
  `acting_as_admin`); orphaned derivation.
- Provisioning job (mirror the `activeCreations` 202+poll pattern,
  `lxc.js:738-1143`): create bare repo (host, via `spawnHost`) → seed from the
  project template (placeholder web app + `mock2.yaml` + secrets manifest +
  Postgres-in-container per ADR-008) → `incus launch` unprivileged `m2-<id>`
  → clone into container → start dev server (systemd unit inside container)
  → read `mock2.yaml` → register slug route in the parent-domain site file →
  reload Caddy.
- Slug rotate (new slug, 1h grace via `mock2_slug_history.active_until`,
  old slug never reusable). Custom domains: admin-gated, DNS A-record check,
  HTTP-01 via a standard per-domain site file.
- Admin debug view shows `bridge_ip:port`; no host ports anywhere.
- Project tiles + detail skeleton (MOBILE_FIRST).

**Verify:** create → tile shows `provisioning` → `online`; URL serves the
placeholder over the wildcard cert; `git log` in the bare repo shows the seed
commit; rotate works and old slug 404s after grace; viewer can open, not
mutate; second project cannot take the same slug ever (history row blocks).

## Phase M3 — Archive and rehydrate, proven

**Goal:** the only recovery path exists and is trusted **before** anything
depends on it. *(ADR-006; survey §4 — note: no snapshot-restore exists in the
backend, and rehydrate must never depend on one.)*

**Scope:**
- Archive: checkpoint-commit inside container → final fetch into bare repo →
  destroy container + bridge + route → `lifecycle='archived'`; repo, chats,
  change records, memberships retained. Archived list filter.
- Rehydrate: rebuild container from template + clone from bare repo + re-run
  manifest → route registration; same slug (it was never released).
- Idle-stop groundwork: `incus stop` after N days idle (`mock2_settings`),
  restart-on-visit; distinct from archive.

**Verify (the brief's explicit test):** create project → modify files in
container → archive → rehydrate → modified state is back and served at the
same URL. Then: archive → delete the container image cache → rehydrate still
works (proves no snapshot dependency). Run this as an automated test if at
all feasible.

## Phase M4 — Network isolation

**Goal:** the fence, before any runner exists. *(ADR-010, ADR-005; survey §4, §13.)*

**Scope:**
- Per-project managed bridge `m2br<id>` at provision (extend provisioning
  job; CLI's `createNetwork` REST pattern as reference); container NIC pinned
  to it; teardown on archive.
- nftables: extend the `table inet proxypilot` egress chain — default-deny
  from project bridges; allow DNS-to-host, established, host-proxy port;
  deny inter-bridge and control-plane. Persisted in the firewall state file;
  reconciled at boot (l4-reconciler pattern).
- Filtering egress proxy (squid or tinyproxy) with per-project allowlist ACLs
  keyed by source subnet; template bakes `HTTP(S)_PROXY` into container env.
  Default allowlist: npm registry, model API hosts (from connectors), project
  git remote host.
- Manifest enforcement: only `mock2.yaml`-exposed web port is reachable from
  the host/Caddy; port scan (`port-detector.js`) diffs against manifest →
  `port_drift` queue item (table exists; queue UI arrives in M8 — until then
  it surfaces via the notifications bell).

**Verify:** from inside project A: `curl https://registry.npmjs.org` OK via
proxy; direct `curl 1.1.1.1` fails; project B's bridge IP unreachable;
control-plane (host :3001, main bridge) unreachable; Postgres inside A
unreachable from host network but fine locally. `npm install` works in the
template app. Existing non-Mock2 containers are untouched (regression-check
an `pp-*` service).

## Phase M5 — Connectors, quotas, framework registry

**Goal:** everything a cycle needs to exist. *(ADR-003; survey §7; brief's
models/quotas/git-connectors sections.)*

**Scope:**
- `mock2_model_connectors` + slots + prices + test endpoint — clone the
  backup-destinations pattern wholesale (encrypted key, `publicShape` with
  `secret_decryptable`, healthcheck caching). Capability enforcement on slot
  assignment. Providers: anthropic, openai, gemini, ollama/openai-compatible.
- `mock2_git_connectors` + `mock2_project_remotes`: orchestrator-side push
  after checkpoint (optional), `git archive` zip export endpoint.
- Quotas: budgets, ledger, buffer; a pure function
  `canStartCycle(estimate) → {ok, reason}` used (and unit-tested) now,
  enforced by M6.
- Framework registry: versions table, superadmin editor (markdown +
  side-by-side diff before commit), revert-as-new-version, `logAudit` on
  publish; optional git-sync import; seed version 1 with the Mock2 bundle
  (constitution, four skills, gate scripts, design system, project template
  ref).

**Verify:** connector test endpoints round-trip against a real key and a fake
one; slot assignment refuses a chat-only model for `build_runner`; framework
edit → diff → publish → v2; revert → v3 with v1's content; ledger arithmetic
unit-tested; zip export of an M2 project opens and builds.

## Phase M6 — Cycle runner and checkout lock

**Goal:** the machine: exec into container, targeted change, gates,
checkpoints — triggered by a canned API call, no chat yet. *(ADR-003/004;
survey §8; brief's Build/interrupt/escalation sections.)*

**Scope:**
- `mock2_locks` semantics exactly per ADR-004 (last-write idle timer,
  checkpoint-then-release, warn + keep-working, takeover request, admin
  force-release, viewer exclusion). Every mutating project endpoint checks it.
- `mock2_cycles` state machine (status table + boot orphan-sweep + poll
  endpoint — the house pattern). Cycle start: estimate → quota check
  (`refused_quota` is a real terminal status) → pin framework version → take
  lock → copy pinned gate scripts into container.
- Runner: provider-agnostic agentic loop (tool set: exec-in-container,
  read/write file via `incus file push/pull`, run gates) driven by the
  `build_runner` slot. Checkpoint commit after each targeted change and each
  green gate battery; orchestrator fetch after each checkpoint; change record
  (hash-chained) per checkpoint.
- Interrupts: `queue_after_step` / `stop_after_step` / `abandon` honored at
  step boundaries; admin stop-all; retries-exhausted → `awaiting_admin` +
  queue item + handoff (container name, branch, log) — terminal stays
  admin-only.
- Gate reports stored per gate for the "review, not error" framing.
- Buffer-crossed mid-cycle: finish current step, checkpoint, stop, say so.

**Verify:** scripted cycle ("add /health endpoint") on a template project:
lock taken → checkpoints appear in bare repo → gates run → green → lock
released. Kill the backend mid-cycle → boot sweep fails the cycle, branch at
last checkpoint, lock released with commit. Quota set to $0 → cycle refuses
to start. Force-release is audit-logged. Chain verification over change
records passes.

## Phase M7 — Stage 1: chat, mockup, design approval

**Goal:** Concept stage end to end. *(Brief's Flow section; survey §8, §11.)*

**Scope:**
- Chat UI in project detail (polling like the rest of the app; whole-message
  updates; SSE only if polling proves inadequate). `mock2_chat_messages`,
  `acting_as_admin` stamped.
- Concept-stage loop on the `concept_chat`/`mockup` slots, constrained to the
  pinned framework's design system; mockup is an HTML artifact committed
  under `state/mockups/` and served through the project's preview URL path
  (new tab, per the brief).
- The stage's *only* exit: the design-approval gesture writes
  `state/inventory.json`, commits, and unlocks Build. Concept stage
  structurally cannot write backend code or rules (the runner tool policy for
  this stage excludes those paths — enforced in the orchestrator, not the
  prompt).
- Stage/progress indicator persistent in project detail.

**Verify:** non-technical-path walkthrough: describe an app → mockup renders
at the preview URL → iterate → approve → `inventory.json` in repo with a
commit + change record; Build button appears only after approval; chat and
approval work at 360px (MOBILE_FIRST gate).

## Phase M8 — Audit, rule questions, admin queue

**Goal:** the two-way routing that gates Build. *(ADR-002; survey §10;
data-model `mock2_audit_questions`/`mock2_queue_items`.)*

**Scope:**
- Audit step on Build press (audit slot): mockup + inventory + existing
  `rules.md` + pinned framework → question list, split by route. No questions
  → build starts immediately.
- Editor questions: tappable choices in chat, answers append to `rules.md`
  (commit + change record); cycle blocked in `awaiting_user` until all
  answered. Free-text always allowed.
- Admin queue page: the queue-of-items view (filter by project, kind,
  status), backed by `mock2_queue_items`; framework deviations, drift,
  retries-exhausted, port-drift, flags all land here; bell notification as
  attention-getter only.
- Drift detection each audit: compare `last_built_framework_version_id` vs
  current → `drift` item + "update available" project banner; remediation
  cycle (explicit consent, `Mock2 X → Y` change record, full gate battery).
- "Flag an Admin" button (editors + viewers) → `!` overlay + queue item.

**Verify:** seed a mockup that implies an ambiguous domain rule → audit asks
the editor, answer lands in `rules.md`, build proceeds; seed a MySQL request
→ deviation lands in admin queue, build blocked until resolved; bump
framework → next audit raises drift, nothing auto-remediates; flag button
raises `!` and a queue item.

## Phase M9 — Iteration: classifier, summary, lifecycle polish

**Goal:** the steady-state loop the user actually lives in. *(ADR-002's
classifier; brief's adaptive summary/container lifecycle/status sections.)*

**Scope:**
- Rule-change classifier (classifier slot) on every iteration message,
  three outcomes, biased to flag; outcome 2 → reconfirm flow (editor-only —
  an admin answer is rejected for domain rules); outcome 3 → lazy rule
  question then build.
- Adaptive summary: deterministic trigger (cycle touched `rules.md` /
  `inventory.json` / screens±actions), generated from change records +
  `rules.md` only, versioned + diffable (`mock2_summaries`).
- Container idle-stop enforcement (N days, `mock2_settings`), restart-on-
  visit; `stopped` in derived status.
- Derived-status function finalized across all states; tile + detail use it.
- Quota UX: pre-cycle refusal message, mid-cycle buffer stop message,
  `quota exhausted` status; wall-clock/concurrency caps for self-hosted slots.

**Verify:** "schedulers should see other practices' shifts" (classifier fixture
suite: implements / contradicts / unaddressed × N paraphrases) routes to
outcome 3 → question → rules.md → build; summary regenerates only on
qualifying cycles and diffs cleanly; idle project stops after N days and
wakes on visit; quota exhaustion mid-cycle checkpoints and reports plainly.

## Phase M10 — Hardening pass (pre-adoption gate)

**Goal:** the compliance story holds under adversarial review.

**Scope:** disabled/pinned-host audit (fresh install with pin → grep the
process, FS, and route table for any Mock2 surface); container-escape review
of runner tool set; egress-proxy bypass attempts from a hostile container
(direct IP, DNS tunneling posture, proxy CONNECT to non-allowlisted host);
change-record chain verification tool (`GET /api/mock2/projects/:id/verify-chain`);
restore-of-mock2.db-onto-pinned-host behavior; docs: operator runbook +
compliance claim language from ADR-001's honesty note; load test: 10 projects,
2 concurrent cycles, SQLite contention check (WAL busy_timeout tuning).

---

## Dependency graph

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M6 ─► M7 ─► M8 ─► M9 ─► M10
              │              ▲
              └─► M5 ────────┘        (M5 can run parallel to M3/M4)
```

M1 needs a DNS provider decision (ADR-009). M2 needs ADR-007/008 sign-off.
M4 needs ADR-010 sign-off. Nothing blocks M0.
