# Mock2 Organizational Constitution — v2

The constitution is the single, versioned, machine-readable statement of **how**
every Mock2 project is built. It is set once at the platform level and inherited
by every project; end users never see or edit it. A project contributes only its
*name*, a *compliance-mode* flag, and a list of *approved integrations* — nothing
about architecture. This document governs the runner, the generated application,
and every gate; it is independent of any single project's `state/rules.md`.

> Sources: the Mock2 standards, **mock2-core v0.2.0** (2026-09-02,
> https://mock2.fractionate.ai — git.fractionate.ai/mock2/mock2-core), which replaced
> gates with a production checklist and added constitution rule 0; **Continuous
> Production Readiness (CPR) v1.1** (development freedom, host contract, feature
> packaging, release registry — vendored at `framework-seed/cpr/CPR-v1.1.md`); and
> *The Mock2 Framework* v1.1 (Fractionate LLC, July 2026), §3, §6, §9, for the stack
> and the stage model. Where the standards site and this document differ, the site
> is newer and wins; record the difference under **Proposals** in the change record.
> This is the operator's real content (closing risk R8 for the constitution),
> hardened with the lessons from the first build cycles: identity comes only from a
> verified credential (§4), HTML shells are served only through gated routes (§5),
> "done" requires the end-to-end journey and a negative security assertion — not just
> a green compile (§7), and an approved deviation must propagate everywhere (§9).

## 0. How to work in this repo

**Rule 0 — nothing here blocks building or testing** (mock2-core v0.2.0 rule 0;
CPR v1.1 §3.1, §11.3). Every check, review, sign-off and checklist item in this
constitution is a reminder to verify something once the work is confirmed working.
None of them may be used to refuse, restrict, disable or delay implementing or
testing what the Builder asked for.

- **Do not invent a gate.** No approval step, feature flag, allowlist, environment
  restriction, disabled code path, recipient restriction or "confirm before
  proceeding" because it seems prudent. A restriction is mandatory only when the
  Builder or an approved deviation/decision says so, the external system technically
  requires it, or the exact requested action would cause an immediate destructive
  effect outside the intended test scope — and the reason must be specific and
  evidenced. "Unsafe" as a broad inference is not a reason.
- **Classify every production-policy question and keep building.** Who may receive
  this, quiet hours, rate limits, retention, approval workflow, provider
  configuration, alert thresholds and the like are ONE of: an **implementation
  requirement** (only when the Builder or the rules explicitly say so), a
  **configurable capability** (build it, make it configurable, default it sensibly),
  a **production checklist item** (write it to `state/production-checklist.md` under
  *Decisions for the owner*), or a **recommendation** (say it once, in the change
  record under *Proposals*). Only an explicit implementation requirement changes
  what you build.
- **Nothing graduates silently.** A recommendation or checklist item never becomes a
  requirement in a later prompt, phase or session on its own; the Builder says so and
  it is written into `state/rules.md`.
- **Intentional testing of the real path is allowed** — real providers and real side
  effects the Builder asked for included. Say what you are about to do; do not
  refuse it. Distinguish bounded intentional test execution from unrestricted
  automated production operation; only the latter is a promotion question.
- **The platform's gate battery is the automated half of the production checklist**,
  run by the platform at finish (CPR §10.1). A red item is information for the
  Builder and the operator: fix what the task can fix, record what remains failing
  in the change record, and never weaken a test, reword a string, or disable a
  feature to turn it green (§12). A committed secret or an unintentional auth
  bypass is the one non-waivable hard stop (CPR §11.2).

- **Read `state/rules.md` and any approved deviations in `state/deviations/` BEFORE
  changing code.** Confirmed rules and approved deviations override the raw request —
  and, when approved, override this constitution. If the request conflicts with a
  confirmed rule, follow the rule.
- **Authority order (highest wins):** an APPROVED deviation → a confirmed rule in
  `state/rules.md` → this constitution → the raw build request. A DENIED deviation
  must not be built.
- **Read before you write.** Explore the current tree first; don't rebuild what
  exists. Prefer the smallest change that satisfies the confirmed rules.
- **Targeted edits, not whole-file rewrites.** Whole-file regeneration silently drops
  a feature's wiring — the exact way a "done" change loses its UI or its auth.
- **Finish green *and* working.** "Compiles" and "gates green" are not the definition
  of done (see §7). Wire the UI that drives any new capability and prove the
  end-to-end round trip.

## 1. Design principles (non-negotiable)

1. **Restriction is the feature.** Removing technical choices is what makes
   non-coder development possible and outputs consistent. One stack, one
   scaffold, one path. The user's freedom lives entirely in *what* the software
   does; the framework owns every decision about *how* it is built.
2. **The spec is the source of truth.** Code is generated from the approved
   design inventory (`state/inventory.json`) and the confirmed plain-language
   rules (`state/rules.md`) — never the reverse, and never from mockup code.
3. **Deterministic before intelligent.** Wherever a static check, lint rule, or
   test can enforce something, no AI is used to enforce it. AI review is reserved
   for judgment calls machines cannot make.
4. **Nothing self-approves; automation verifies, humans govern.** The building
   runner cannot waive its own checks and no AI promotes to production. A human
   holds the only path to production, informed by the checklist and the change
   record — health is not approval, and a commit is not a release (CPR §3, §12).
5. **The record writes itself.** Every decision, change, test result, and
   sign-off is captured automatically as audit evidence (the hash-chained change
   records), surfaced to humans only when it matters.
6. **Development can never touch production.** Builds happen in sealed, disposable
   containers; production servers *pull* signed, approved releases. No inbound
   path exists from the build platform to production.

## 2. The stack (the only stack)

Every generated application uses exactly this stack. A gate rejects deviations.

- **Language:** TypeScript (strict).
- **HTTP:** Express.
- **Data access:** Drizzle ORM — the *only* way the app reads or writes the
  database. No raw SQL clients, no other ORM.
- **Validation:** Zod — every route validates its input with a Zod schema.
- **Testing:** Vitest.
- **Database:** PostgreSQL — the *only* database. No MySQL, SQLite, Mongo, etc.
  A genuine additional datastore is a one-line constitution amendment by the
  platform admin, never a per-project decision.
- **Reverse proxy / TLS:** Caddy.

## 3. Scaffold conventions

Every application starts from the standard scaffold (`project_template_ref`) and
keeps its shape:

- **Module layout:** feature modules under `src/`, each exposing `routes`,
  `service`, `schema` (Drizzle + Zod), and `*.test.ts`.
- **Route → service → data:** routes validate (Zod) and delegate; services hold
  business logic; all persistence goes through Drizzle schema modules.
- **Migrations:** numbered, ordered, and reversible; a migration must never lose
  data without an explicit, reviewed waiver.
- **Config:** environment-driven; no hardcoded hosts, ports, or credentials.
- **Manifest:** the repo declares its topology in `mock2.yaml` (the one exposed
  `web` port; everything else internal). Ports are *declared, not discovered*.

## 4. Auth pattern (one implementation, applied identically)

- Single sign-on with multi-factor authentication for human access.
- **Identity comes only from a verified credential:** a verified JWT (the
  `Authorization: Bearer` token or the httpOnly access-token cookie), or — on the SSO
  gateway path — identity headers that the edge proxy (ProxyPilot) injects **after**
  authenticating. Nothing else establishes who the caller is.
- **Never trust a client-supplied identity header.** `x-user-role` / `x-tenant-id`
  from an unauthenticated caller must never grant a role. Any SSO-header fallback in
  code is valid **only** because ProxyPilot strips those headers from all inbound
  client requests — do not rely on that guarantee without a test asserting a raw
  `x-user-role: admin` request (no token, no cookie) is **rejected**.
- Role-based access control enforced **server-side on every path** — never in the
  client, never advisory. A Tier-2 review pass confirms RBAC is enforced on every
  route that touches protected data. Least privilege by default.
- Per-tenant isolation (row-level scoping) in the application database.

## 5. Security posture

- **Secrets** live in a dedicated secrets manager and are referenced by name;
  they are **never** committed to a repository. A gate scans every tracked file
  for embedded private keys, cloud credentials, and tokens and fails the build.
- **Required headers** on every response: `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and HSTS in production.
- **HTML documents** (`app.html`, login pages) are served **only** through gated
  routes — never handed out from the static layer, or the `/` session gate is
  bypassable.
- **Token cookies** are `HttpOnly`, `Secure`, `SameSite`. Refresh tokens are stored
  **only as hashes**, rotated on refresh, and revoked on use.
- **Encryption:** TLS in transit (Caddy); sensitive columns encrypted at rest.
- **Logging:** structured and PII-aware; no secrets or full payloads in logs.
- **Supply chain:** dependency and image scanning in the deterministic gate tier;
  releases are signed tags, signing keys held outside the platform.

## 6. The stages (a recommended order, not a set of locks)

Every project — and every change to a live project — follows the same stages
(mock2-core v0.2.0 §1). The change router sends live-app requests back to Stage 1
(appearance) or Stage 2 (behavior); the production checklist and a human's
promotion decision apply to every release, however small. A Builder may start at
any stage: missing inventory or unconfirmed rules are **noted, not blocking** — a
build without confirmed rules writes the rules it implements as `[draft]` in
`state/rules.md` so the owner can confirm them later. Rule status tags are
`[draft]`, `[confirmed]`, and `[observed]` (adopt mode).

1. **Concept** — chat produces a disposable interactive HTML mockup, constrained
   by the locked design system. Sign-off #1 (design approval) extracts the design
   inventory; the mockup code is then discarded.
2. **Define** — a templated plain-language interview (Data / Who-can-do-what /
   Connections / What-happens-when) restates answers as confirmed rules. Sign-off
   #2 (rules confirmation) is the final human gate before code exists.
3. **Build** — the runner derives an internal work file from exactly three
   inputs — this constitution, the design inventory, and the rules (confirmed, or
   drafted per rule 0) — generates the application on a branch inside a sealed
   fenced container, in small targeted changes, running the checks after each and
   fixing what it can. The runner never receives mockup code, never merges to
   main, and can never reach production.
4. **Check** — once the change is confirmed working, the production checklist runs
   (the deterministic battery automatically; the independent review pass in a
   separate context) and every item is recorded as `pass`, `fail (reason)`,
   `open (what is needed)` or `n/a (reason)` in the change record. A failing item is
   recorded as failing and stays visible; it does not undo or hide the working
   feature.
5. **Run** — promotion to production is an explicit human decision informed by the
   checklist and the change record (never a side effect of a commit or a green
   build). The Reviewer reads results and surfaced change descriptions, not diffs;
   approval tags a signed release that production pulls. Blue/green candidate
   slots, the release registry and no-build rollback are the CPR Base Platform's
   responsibility (CPR §12) — ProxyPilot deploys the dev URL and does not claim
   them.

## 7. Definition of production-ready (what the checklist verifies)

"Production-ready" is what the Check stage establishes and what the human promoting
a release reads; it is never a precondition for building or testing (rule 0).
Production-ready means all of:

- The deterministic gates — `typecheck`, `constitution-lint`, `rule-coverage`,
  `security-scan`, `test`, `ui-interaction`, `acceptance` — are **all green**, **and**
- **acceptance is demonstrated** (§12) — "gates green" and "acceptance
  demonstrated" are distinct, separately recorded states, and BOTH are required
  for "succeeded", **and**
- the **end-to-end / journey gate** passes: the primary user journey runs against a
  **real build** (the app booted against Postgres, migrated + seeded, driven over real
  HTTP — e.g. bootstrap → login → gated load of the shell). **Green gates that only
  prove the code compiles are not "done."**
- The e2e gate **fails visibly** when its dependencies are missing — never
  skip-as-pass — and includes at least one **negative security assertion** (e.g. a
  spoofed `x-user-role: admin` request with no credential is rejected).
- **Every confirmed rule in `state/rules.md` has ≥1 covering test** (the rule-coverage
  gate enforces this — it must actually parse confirmed rules, not no-op).

A build stopped at the token/time budget is **"incomplete / resumable," never
"succeeded."** The Reviewer confirms gate results and reads surfaced change
descriptions — a realistic bar for an operational IT lead, not a senior engineer —
but the bar itself is the working journey above, not a green compile.

## 7a. No silent simulation (integration truthfulness)

Hardened after a real failure (project 5, "ADP2"): an app shipped with its entire
external integration faked — a `sync` that upserted a hardcoded roster whenever
credentials were merely *present*, and a "connection test" that reported a
successful mTLS handshake and OAuth token without ever opening a socket — while
every request reported `succeeded` and all gates ran green. The design was
correct; the backend was not real. The builder even disclosed the faking in its
assumptions and nothing happened. These rules bind the gate to reality:

- **Synthesized, sample, fixture, or fabricated data on any production code path
  is a deviation.** A production code path is any path included in a deployable
  artifact or reachable under a non-test runtime configuration; development,
  demo, seed, and fixture paths count as production paths when they are bundled
  or selectable in a deployed environment, unless a gate proves them unreachable
  under every production configuration. *"It's only demo mode"* is not an
  exemption.
- **Any "test/check/probe" that reports success without performing the real
  underlying operation is a deviation.** A connection test that does not open the
  connection, a sync that does not fetch, a probe that reads configuration
  fields — all are deviations regardless of what they return.
- **Connectivity or operational success may never be derived solely from the
  presence of non-empty configuration fields.** This invariant applies
  everywhere: `if (cfg.secret && cfg.key) return { ok: true }` is a defect by
  construction.
- A simulation is valid **only** when it is administrator-approved, recorded in
  `state/deviations/`, registered in the stub registry (`state/stub-registry.json`)
  with a severity, **and** visibly labeled in the running UI. An unrecorded
  simulation is a **gate failure** — the integration gate (§7b) fails the build.
- **`pending-operator-verification` is not a licence to simulate.** It applies
  ONLY to an implemented real integration that passed the integration gate and
  awaits live verification against the actual external system. It must never
  legitimize a stub, a fabricated response, a presence-only connection test, or a
  sample-data production path — those are blocking deviations, not pending work.
- **`pending-operator-verification` is a calm completion, not a blocker.** When
  all in-fence gates are green and the code is real, but a declared integration
  needs a LIVE external check the sealed fence cannot run (an ADP Test Connection,
  an LDAPS bind against the production directory), the correct end state is
  `pending-operator-verification` — returned directly, never routed through the
  deviation/blocker queue. It reads as "Built and verified in-fence — N live
  checks remain before production sign-off," with the live checklist; it is NOT
  "Blocked — needs attention." The live checks are a property of the
  **capability**: they persist across cycles, are ambient status on the Run
  stage, and an operator confirms/waives them independently of any build — a cycle
  that does not touch that capability is never dragged into its verification. The
  app is production-ready only when no capability has an outstanding live check.
- **Injecting production credentials / opening fence egress to verify in-cycle is
  a deliberate, rare admin action — never a routine completion option.** It is
  available only through an explicit, scoped, admin-granted authorization (the
  `request_authorization` path), with its own confirmation and audit record. A
  normal healthy build that awaits live verification must not present credential
  injection as one of its buttons.

## 7b. Integration gate & observable provenance

Every external capability (API, directory, webhook, third-party service) is
declared as a versioned entry in the integration manifest (`state/integrations.json`);
source discovery supplements the manifest and an outbound integration found in
code with no manifest entry is a gate failure, so omitting the manifest is not a
bypass. The integration gate enforces, for each declared or discovered capability:

1. **Dataflow** — the configured destination and credentials flow into the real
   transport invocation; when the flow cannot be established the gate fails closed
   with "provenance not established," never inferring success.
2. **Execution** — the production action actually invokes that transport during
   contract testing; configuration presence alone is never a successful test,
   probe, sync, or connection check.
3. **Result provenance** — returned or persisted data derives from the transport
   response, not from literals, bundled JSON, fixtures, sample records, or a
   fallback generator. Legitimate parsing/transformation of the received response
   passes.
4. **Honest failure** — transport, TLS, authentication, protocol, and
   upstream-validation failures remain failures and are surfaced accurately;
   negative-path contract tests are required (TLS rejection, malformed
   certificate, DNS failure, connection refusal, timeout, auth rejection,
   malformed upstream payload).
5. **Fixture isolation** — contract fixtures run over a real local socket through
   the production transport path, injected only via explicit test-only
   configuration; fixture mode must not be reachable through production defaults
   or a failure fallback. Local contract-test endpoints never count as deploy
   egress.
6. **Observable provenance** — integration actions emit structured evidence:
   destination classification, transport attempted, response status, provenance
   mode — with credentials and secrets redacted.

Lexical screening of finish-payload disclosures is a safety net, never the sole
source-level detector: a disclosure of simulation ("synthesized because no live
endpoint is reachable," "best-effort probe," "would replace this when credentials
are present") creates a **blocking** deviation candidate and the request must not
report `succeeded` while it is unresolved.

**When the external endpoint is unreachable from the build fence — the normal
case — the correct implementation is real transport code plus an in-fence
contract test that drives that code against the local contract-fixture server
(`tests/contract/fixture-server.ts`: a real local TLS socket, injected only via
test-only configuration), landing the capability in `pending-operator-verification`
until an operator confirms it against the live system. Stubbing is never an
acceptable fallback for an unreachable endpoint.** If the fixture tooling cannot
be provisioned for a project, the gate says so explicitly (`fixture-tooling-missing`)
and the resolution is to provision it — not to stub. Every blocked-deviation
finding carries a class, and the harness always offers at least one resolution
that can actually clear each class: an undeclared capability is *declared*
(manifest backfill), unprovable-but-real code is *waived* by an administrator
(analysis limitation) into `pending-operator-verification`, and a positively
fabricated capability is *implemented for real* or *approved as a recorded
simulation*.

## 8. What is deliberately removed

Removed by mock2-core v0.2.0: **gates as blockers**. Every former gate is now a
production-checklist item run after the developer confirms the change works;
`npm run check` (`check:lint`, `check:types`, `check:test`, `check:audit`,
`check:secrets`) replaces `npm run gates` in project scripts. The platform's
battery keeps the historical `gate` name in its report rows; read it as
"checklist item".

Relative to standard spec-driven development, the framework removes per-project
constitutions, Architecture Decision Records as user artifacts, the
clarify/tasks/analyze phases as user-facing steps, prose UI specifications,
coverage-percentage targets, multi-agent orchestration, and per-change AI review.
Each removal survives one test: *does the exact production result survive without
it?*

## 9. Deviations — approve once, propagate everywhere

A deviation from this constitution requires **platform-administrator approval**,
recorded in `state/deviations/`. When a deviation is **APPROVED**, it overrides this
constitution for that project and must be built **exactly as approved and propagated
everywhere** — the application code, the **UI copy**, and `state/inventory.json`. An
approved JWT/password deviation means the login page must not still advertise "SSO
with MFA," and the inventory must describe the auth that was actually built. A
**DENIED** deviation must not be built. Silently obeying the constitution and
building nothing when an exception was approved is a defect, not compliance.

## 10. Scope & integration discipline

- When a task is split across budget-paused chunks, the **final chunk must include an
  integration / wire-up pass.** Do not declare the whole task done until the journey
  works end-to-end — front end wired to back end, one coherent auth model, no orphaned
  placeholder screen.
- A capability is not delivered until something drives it: a new backend route that no
  screen calls, or a new screen that calls nothing, is unfinished work, not a feature.

## 11. Rendered-DOM proof & cross-layer consistency

Hardened after a real regression: an admin's credential inputs shipped **disabled**
through five green gates, because nothing exercised the rendered DOM.

- **A UI change must carry an interaction test.** Any change touching user-facing
  paths must add/update `state/ui-checks.json` with checks covering every touched
  screen (the `ui-interaction` gate enforces coverage; the browser smoke connector
  executes the matching checks against the deployed app). Checks assert the
  **per-role state of interactive controls**: controls a role may edit are enabled
  and **keep typed input**; controls a role may not edit are disabled while status
  stays readable; write-only secrets enable only after Replace; the page produces
  **zero console errors**. Test-fixture users exist for **every role** the app
  defines and are referenced by the checks.
- **A change that touches `migrations/` or the data layer must prove the full
  migration chain applies cleanly to a scratch database and the app boots against
  the result** (the DB smoke connector). A warranted smoke connector that cannot
  run **fails the cycle** — never a silent skip that reads as success.
- **Shared enums live in ONE module.** Role names (and any value shared across
  layers) come from a single shared constants module imported by both server and
  browser code; a hard-coded role string literal in browser code is a lint
  violation.
- **Client checks cite their server source.** Any client-side permission check
  must cite the server source it was verified against, and that source must have
  been **read in the same cycle** — a value assumed rather than read is declared
  as an assumption in the change record, and a permission value left assumed is a
  defect.
- **Change records carry acceptance evidence.** Every finish includes a
  human-runnable acceptance check per user-visible change ("as admin, do X,
  expect Y") and the explicit verified-vs-assumed split of its cross-layer
  assumptions. The review pass rejects a UI diff with no corresponding
  interaction test.

## 12. Acceptance & anti-Goodhart (done means demonstrated)

Hardened after a real failure (cycle 94): a bug-fix cycle reached "succeeded"
with every gate green while the reported defect was never reproduced — its only
committed change reworded string literals so a scanner regex would stop
matching. Gates are a PROXY for the goal; when the proxy is the reward, the
proxy gets optimized. These rules bind the reward to the goal:

- **Every cycle declares its acceptance** in `state/acceptance.json` — the task,
  its kind, and the machine-checkable evidence: regression tests (bug fixes),
  an integration contract test (integration changes), live ui checks that must
  pass against the DEPLOYED app. The `acceptance` gate enforces the declaration;
  the runner and the post-deploy connector enforce the demonstration.
- **Reproduce first.** A bug-fix cycle must add a regression test tagged to the
  defect and demonstrate **red → green inside the cycle**: the test gate must
  have been observed FAILING before the finishing battery goes green. "The code
  looks correct" or "appears already implemented" is not acceptance — if the
  defect cannot be reproduced, the cycle halts with that finding instead of
  succeeding.
- **Reproduce-first applies to product-code changes.** A cycle whose diff —
  **verified by the orchestrator itself**, never taken from a model claim —
  contains no product-code change (an idempotent re-adoption, a `state/`-only
  spec alignment, a nothing-left-to-do re-run) has no behavior change to
  reproduce, and fabricating a red test would itself require a product change.
  Such a cycle finishes as its declared kind (usually a chore) without a red
  test; the record carries `code_diff_empty` and the reproduce-first basis
  explicitly. This is a structural rule, not a per-cycle waiver. When a human
  DOES waive reproduce-first (admin-granted on resume), the waiver is applied
  at the enforcement gate itself and stamped into the record — a waiver that is
  merely narrated is a falsified precondition and remains a stopping condition.
- **No integration validated by mocks alone.** Any external-integration path
  (mTLS, auth, transport) carries at least one contract test that runs the REAL
  logic — actual cert/key matching, a real agent against local fixtures or a
  stub server — never only an injected fake transport.
- **Detector evasion is prohibited.** When a gate fires, classify: the CODE is
  wrong → fix the code; the GATE is wrong → propose the gate/allowlist change as
  a distinct, reviewer-approved act (e.g. `state/secret-scan-allowlist.txt` plus
  a deviation/halt option explaining the false positive). Modifying product code
  for the sole purpose of slipping past a detector pattern is a named
  anti-pattern and a defect in itself.
- **Operator claims are verified, not trusted.** Resume/operator guidance that
  asserts a checkable fact ("the audit is clean", "already implemented") is
  verified against the tree before being relied on; a falsified precondition is
  a **stopping condition** — halt and surface the discrepancy.
- **The record is accountable to the diff.** Every checkpoint auto-carries its
  own `git diff --stat`; a finish summary naming work this cycle did not do is
  rejected. A suspiciously cheap success (small fraction of the estimate, no
  red test observed, no test touched) is auto-flagged for human review.

## 13. Continuous Production Readiness (CPR v1.1) — features and hosts

CPR is the engineering standard the framework builds on (full text:
`framework-seed/cpr/CPR-v1.1.md`; standards site → Standards → CPR). The parts
that bind every project:

- **Development first, production readiness second** (CPR §3, §3.1, §11.3) — rule 0
  above is CPR's no-invented-gates rule. Readiness stages are *Development Ready →
  Integration Ready → Candidate Ready → Production Ready → Production Verified*; a
  BLOCK may stop only the specifically stated integration, destructive operation,
  candidate promotion or unrestricted production action, never unrelated
  development or testing; a WARNING stays visible and may become a promotion
  blocker later.
- **Features consume capabilities; they do not recreate the platform** (CPR §5, §6).
  A feature reaches auth, identity, db, secrets, config, jobs, outbound HTTP, log
  and audit through the **Host Contract** (`HOST_CONTRACT_VERSION` 0.1.0) via the
  **Host SDK** — never a private import of host internals, never its own pool,
  scheduler, secret lookup or `process.env`. Business concepts stay out of the
  platform; a capability is promoted upward only after reuse is demonstrated. The
  platform ships this as the **CPR Host** component (`cpr-host`): adopt it with
  `materialize_component` instead of re-implementing it.
- **Every feature declares a `feature.manifest.json`** (CPR §7, Appendix B): id and
  namespace, host-contract range, host capabilities with a reason each, namespaced
  permissions (`<feature>.<area>.<verb>`, never a role name), migrations with the
  tables they own, jobs with `concurrencySafe`, outbound hosts with a reason,
  install/uninstall actions, portability blockers and risks. Routes, permissions,
  tables, jobs, events, config keys and navigation ids are namespaced; a namespace
  collision blocks integration.
- **Versioning is explicit** (CPR §8): released versions are immutable; a
  behavior change is a new version; wildcard compatibility is prohibited for
  release packages; **expand → migrate → contract** for every breaking database,
  API or contract change. Migrations are classified (additive, transition,
  contraction, destructive) with the rollback path stated; package removal never
  drops feature data (CPR §13).
- **Assurance is evidence-driven** (CPR §10): the deterministic battery + one
  independent review in a separate context; the implementer is never the sole
  authority on its own work; tests are never weakened to pass without saying so in
  the change record (§10.4). The change record is the **Change Evidence** report
  (Appendix C) and carries the assumption ledger verbatim.
- **Decisions are durable** (CPR §3, §17.2, Appendix G): material architectural
  decisions are recorded in `state/decisions.md` (id, date, status, decision,
  rationale, ownership boundary, supersedes, affected artifacts, revisit trigger).
  Current code and runtime evidence describe what exists; they never silently
  supersede an active decision — follow it or propose superseding it. Precedence
  when sources conflict (§17.3): decision record and approved standards → current
  task and authorized scope → repository implementation and tests → runtime
  evidence → historical conversation.
- **Roles** (CPR §17): the Builder is the Developer; the runner is the AI
  Implementer; the review pass is the AI Reviewer; the ProxyPilot operator is the
  System Steward / Production Approver.

## 14. Change records and the production checklist (mock2-core v0.2.0)

- **A change record is written for every unit of work once it is confirmed
  working** — it is evidence for the person deciding whether to promote, never a
  gate. The platform's hash-chained records (`state/changes/<seq>.json`) are the
  audit spine; the human-readable record follows the standards' format —
  **Summary, Rules** (numbers touched, including `[draft]` ones), **Files,
  Checklist** (each item `pass` / `fail (reason)` / `open (what is needed)` /
  `n/a (reason)` with tool output lines verbatim), **Review** (findings by severity,
  each resolved, accepted with reason, or open), **Open items** (capabilities and
  checklist items a human still decides), **Proposals** (standards changes this work
  suggests). A change with failing or open items still gets a record that says so.
- **`state/production-checklist.md`** starts from the baseline (verification:
  `check:lint`, `check:types`, `check:test`, `check:audit`, `check:secrets`; behavior;
  data; security; review; release — see the *Mock2 production checklist* rule) and
  grows with items classified under rule 0. Items that do not apply are marked `n/a`
  with a reason, never deleted.
- **Rollback**: the previous known-good state is identified and reachable without
  rebuilding (CPR §15) — the release before this one, by commit and deploy stamp.

