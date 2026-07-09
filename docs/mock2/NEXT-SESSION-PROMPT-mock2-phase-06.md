**Next session — Mock2 Phase M5: connectors, quotas, framework registry (everything a cycle needs to exist)**

You are continuing the build of the Mock2 module inside ProxyPilot. A planning
session read the whole codebase and produced the plan you are executing — do not
re-derive the architecture, and do not trust your instincts over the plan's
citations; they were verified against the code. Phases **M0** (skeleton +
absence), **M1** (parent domains + per-slug TLS), **M2** (project registry +
container + bare repo + live URL) and **M3** (archive + rehydrate + idle-stop
groundwork) are built and merged to `main`. Your phase is **M5, and only M5.**

**Ordering note (read this):** M5 branches off M2 and, per the dependency graph
in `04-phased-plan.md`, **runs parallel to M3/M4 — it does NOT depend on M4
(network isolation).** Branch M5 off the latest `main`. M4 may or may not be
merged yet; do not assume per-project bridges/nftables/squid exist, and do not
build against them. M5 is plain CRUD + encrypted-secret plumbing on the existing
patterns — cheap to build now, blocking for M6 if built late.

**Why M5 now:** the operator shared the target product surface — the chat →
mockup → build → live experience — captured in `docs/mock2/design/`
(`07-chat-mockup-design-reference.md` + `chat-mockup-reference.html`). That
surface is Phases **M7–M9**, and it cannot function until **M5** exists: you
need a **model slot to call** to generate a mockup, and a **framework +
design-system** to constrain what it generates. M5 is that unblock.

**What M0–M3 already shipped (do NOT re-implement)**
- **The gate.** `admin/backend/src/mock2/gating.js` — `resolveMock2Gate(...)`
  (pure). `MOCK2_ENABLED` (default `false`) + the hard-off pin. Conditional
  dynamic-import wiring in `admin/backend/src/index.js` (after
  `/api/notifications`): when enabled it imports `./mock2/index.js`, runs
  `initMock2Db()` + `sweepMock2OnBoot()` + `reconcileMock2Domains()` +
  `sweepIdleStops()`, and mounts `app.use('/api/mock2', authenticateToken,
  createMock2Router())`. **Add M5 routes to `createMock2Router()` in
  `routes.js`.** An `/api` JSON-404 guard sits before the SPA catch-all so a
  disabled host's `/api/mock2/*` is honestly a 404 (added while fixing a false
  "enabled" probe — keep it).
- **The Mock2 DB.** `mock2/db.js` opens `data/db/mock2.db` (WAL, `busy_timeout`,
  0700/0600). `initMock2Db()` applies block-500 migrations via the main DB's
  `runMigration()` guard. **Foreign keys are OFF.** Secrets are encrypted at
  rest with `TOTP_ENCRYPTION_KEY` (same key the main app's TOTP/S3 secrets use).
- **Migrations 500–504 have run — and 503 ALREADY CREATED YOUR TABLES.** Block
  503 defined `mock2_model_connectors`, `mock2_model_slots`, `mock2_model_prices`,
  `mock2_quotas`, `mock2_quota_ledger`, `mock2_git_connectors`,
  `mock2_project_remotes`, `mock2_summaries`; block 501 defined
  `mock2_framework_versions`. Read them in `mock2/migrations.js` /
  `03-data-model.md`. `mock2_model_connectors` already has `baa_ack_by`/
  `baa_ack_at` (Q7). **So M5 is mostly data-access + routes + UI, not schema.**
  Only if you genuinely need a new column ⇒ a new append-only migration **505+**,
  never edit 500–504.
- **Settings.** `mock2/settings.js` (`getMock2Setting`/`setMock2Setting`) already
  exists (M3 idle-stop) — reuse it for any singleton M5 setting.
- **Identity.** `users.is_superadmin` + boot backfill; superadmin protection in
  `lib/superadmin.js`. Framework editing is **admin-gated** (ADR-003, relaxed
  from superadmin-only), `is_superadmin` remains for the cannot-be-demoted rule.
- **Module conventions to mirror:** pure decision layer in a `*-logic.js`
  (unit-tested stub-first), thin native data-access in a sibling module, routes
  in `routes.js` with Zod + `{ error }` shape + `requireAdmin`/`requireSudo` +
  `logAudit`. Naming (R7): nothing uses the bare word "agent" — the AI build
  component is the **runner**.

**The pattern to CLONE for connectors (do not invent one):** ProxyPilot's
backup-destinations / S3 connector subsystem. Encrypted key at rest, a
`publicShape` that never leaks the secret but exposes `secret_decryptable`, a
cached healthcheck/test-status, and a "test connection" endpoint. Find it via
`routes/backups.js` + `lib/` (S3/destinations) and follow it wholesale.

**Read these first, in order** (all in `docs/mock2/`)
1. `04-phased-plan.md` — your phase is **M5**. Read its verify checklist.
2. `02-adrs.md` — **ADR-003** (framework registry: one monotonic version across
   the bundle, content rows immutable, revert = new version, each cycle pins
   `current_framework_version_id`, drift is an audit concern; **admin-gated**
   editor with diff-before-commit + `logAudit`; **seed v1 vendored** under
   `admin/backend/src/mock2/framework-seed/`, inserted on first enabled boot),
   **ADR-008** (Postgres-in-container — the connector work is orthogonal),
   **ADR-001** (absence: connectors + keys exist only on an enabled host, in
   `mock2.db`, encrypted).
3. `03-data-model.md` — the 501/503 schemas (your tables), especially
   `mock2_model_slots` (the 7 slots: `concept_chat`, `mockup`, `audit`,
   `classifier`, `build_runner`, `summary`, `remediation`) and
   `mock2_framework_versions` columns.
4. `05-risks-and-open-questions.md` — **R5** (cost estimation is speculative:
   treat the reservation as an envelope from ledger p90 × safety factor, refuse
   on the envelope, rely on the mid-cycle buffer stop in M6 — build the pure
   `canStartCycle` now), **R8** (framework content handoff is a real
   prerequisite — see below), **Q7** (BAA acknowledgement).
5. `design/07-chat-mockup-design-reference.md` — the product surface M5 feeds:
   the framework's **`design_system_md`** seed should be coherent with this
   chat→mockup→build→live vision, and the connector slots (`concept_chat`,
   `mockup`) are what M7 calls to render those mockups. **When building AI/model
   features, load the `claude-api` skill and default to the latest Claude models
   (Opus 4.8 / Sonnet 5 / Haiku 4.5) — do not hardcode stale model ids.**

**⚠ External prerequisite (R8) — surface this immediately if unmet.** Seed
framework v1 is the operator's *current* Mock2 framework content — constitution
prose, the four skills, gate scripts, the design system, and the project
template — vendored under `admin/backend/src/mock2/framework-seed/`. The
chat-mockup design reference is a *start* on the design-system/surface direction,
but the full content (constitution, four skills, gate scripts, project template)
must be supplied by the operator. **If that content is not available, build the
registry + seed *mechanism* against a clearly-labelled placeholder seed and flag
in your summary that real v1 content is still owed** — do not invent a
constitution/skills/gates and pass them off as the operator's framework.

**Scope of this session — Phase M5 only**
- **Model connectors** (`mock2_model_connectors` + `mock2_model_slots` +
  `mock2_model_prices`): CRUD + a **test-connection endpoint** per the
  backup-destinations pattern (encrypted key, `publicShape` w/ `secret_decryptable`,
  cached `test_status`/`test_at`). Providers: `anthropic`, `openai`, `gemini`,
  `ollama`, `openai_compatible`. **Capability enforcement on slot assignment** —
  a slot like `build_runner` refuses a chat-only model. **BAA acknowledgement
  (Q7):** saving a cloud connector (anthropic/openai/gemini) shows a one-time
  acknowledgement and records `baa_ack_by`/`baa_ack_at` — an acknowledgement, not
  a blocker.
- **Quotas** (`mock2_quotas` + `mock2_quota_ledger`): budgets, ledger, buffer%,
  and a **pure `canStartCycle(estimate) → {ok, reason}`** in a `*-logic.js`,
  unit-tested now (enforced by M6). Ledger arithmetic is pure + tested.
- **Git connectors** (`mock2_git_connectors` + `mock2_project_remotes`):
  orchestrator-side push after checkpoint (optional; credentials never enter a
  container — ADR-006), plus a **`git archive` zip export** endpoint for a
  project's bare repo.
- **Framework registry** (`mock2_framework_versions`): versions list + an
  **admin-gated editor** (markdown fields + **side-by-side diff before commit**),
  **revert-as-new-version**, `logAudit` on publish, optional git-sync import.
  **Seed v1 vendored** under `framework-seed/`, inserted on first enabled boot
  (idempotent). Content immutable per version; version is one monotonic integer
  across the bundle.
- **Frontend** (MOBILE_FIRST): a connectors admin page (add/test/enable, slot
  assignment, BAA ack), a quotas view, and a framework-versions page (view/diff/
  edit/publish/revert). All admin-gated; reachable only when Mock2 is enabled.

**Do NOT implement (later phases):** the cycle runner / checkout lock (M6 — it
*uses* `canStartCycle`, the pinned slots, and the pinned gate scripts, but is not
this phase); chat/mockups/audit/classifier (M7–M9); network isolation (M4, if not
already merged — parallel, independent). Absence (ADR-001): the framework-seed
vendored files are inert source; nothing installs or runs on a disabled host.

**Hard constraints:** Naming (R7) — nothing new uses the bare word "agent."
Absence (ADR-001) — connectors, keys, quotas, and framework rows live only in
`mock2.db` on an enabled host; keys encrypted with `TOTP_ENCRYPTION_KEY`; the
`publicShape` never returns a decrypted secret. Migrations append-only (**505+**,
and only if a column is genuinely missing — 501/503 already have your tables).
Docker/nsenter (R3) — git-connector host operations go through
`lib/host-exec.js`. Zod on routes, `{ error }` shape, `requireAdmin`/`requireSudo`
for destructive/secret ops, `logAudit`. Tests **stub-first** (import only pure
`*-logic.js`, never `db.js`/native) so the suite gains no new failures — the 4
pre-existing native-module failures (`cves`, `incus`, `webauthn`, `vpn-mtu`) are
in `docs/known-issues.md`; leave them. Frontend passes `MOBILE_FIRST.md`.

**What "done" looks like:** the M5 verify checklist in `04-phased-plan.md` —
connector test endpoints round-trip against a real key and a fake one; slot
assignment refuses a chat-only model for `build_runner`; framework edit → diff →
publish → v2; revert → v3 carrying v1's content; ledger arithmetic unit-tested;
`canStartCycle` unit-tested; zip export of an M2 project opens and builds. Plus
`cd admin/backend && node --test 'src/__tests__/*.test.js'` (no NEW failures) and
`cd admin/frontend && npm run build`. A `MOCK2_ENABLED=false` host still behaves
byte-for-byte like today (no connectors table, no keys, no framework rows).

**Commit as** `mock2-M5: <description>`. (M0–M3 merged to `main`; branch M5 off
`main`, open its own PR. M5 is independent of M4 — they can merge in either
order.)

**Before you finish:** write `docs/mock2/NEXT-SESSION-PROMPT-mock2-phase-07.md`
for **Phase M6** (cycle runner + checkout lock — ADR-003/004) in this same
format: what M0–M5 shipped (especially the pinned slots, `canStartCycle`, and the
pinned-gate-scripts-into-container mechanism the runner consumes), plan-bundle
pointers, and M6 scope. Restate the R8 framework-content status (the runner runs
on placeholder gates until real v1 content lands) so it stays visible.
