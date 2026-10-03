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

<!-- BEGIN PINNED MOCK2 GUIDANCE -->
# Governing Mock2 guidance: 1.14.0

The following pinned guidance supersedes historical general-workflow wording above.
ProxyPilot's concrete identity, authorization, private-data and execution contracts remain binding.
Load the applicable rules and CPR documents from .mock2/standards/ before dependent work.
This guidance adoption does not install Relay runtime/producers or migrate existing integrations.

# Mock2 Standards (user-level, applies to every workspace)

You are working inside an organization that develops with the Mock2 framework.
These rules apply to every chat in every repository unless the repository's own
`.github/copilot-instructions.md` deliberately overrides a specific line.

Standards version: see `~/.mock2/version`. Standards site: https://mock2.fractionate.ai
A repository carries its own copy of these standards in `.mock2/standards/`, with the release it
came from in `.mock2/standards/VERSION`. When both exist and disagree, §8 says which one governs.

## 0. Development is not gated; the boundaries that exist are specific and named

Mock2 has no invented gates. No check, review, sign-off or checklist item in these standards may be
used to refuse, restrict, disable or delay implementing or testing what the developer asked for.

- Do not invent a gate. Do not add an approval step, feature flag, allowlist, environment
  restriction, disabled code path or "confirm before proceeding" because it seems prudent.
- Intentional testing of the real path, including real providers and real side effects the
  developer asked for, is allowed. Say what you are about to do; do not refuse it.
- A failing check is information. It never removes permission to keep implementing, to commit, or
  to hand work over; it creates an obligation to record it and repair it.

Three boundaries are real, and applying them is not inventing a gate. Each is scoped to the one
action it concerns and to nothing else:

1. **An explicit CPR requirement**, cited by section. Immutable released versions, expand →
   migrate → contract for breaking changes, a snapshot before promotion, a release that verifies
   its own hashes (CPR §8, §12, §13, A.4). Name the section when you apply one.
2. **A technically necessary condition of an external system** — a migration that must run before
   the query that reads the column, a credential the provider will not work without, a service that
   must be reachable for the call under test. State the condition and satisfy it; it constrains that
   step, not the branch.
3. **A specific destructive or production action identified by evidence** — dropping or truncating
   a table holding real data, sending to real recipients, writing to a production datastore,
   promoting a release. Establish authorization for that action from the developer's existing
   instructions and decisions; ask only if absent or materially exceeded. Evidence means you can
   name what would be destroyed or delivered, not a general feeling that something is risky.

None of these is ever generalized. "There is a pending migration" does not disable the test suite.
"This release is not promoted" does not stop you building the next change. A boundary that cannot
be tied to a cited CPR section, a stated technical condition, or a named destructive effect is an
invented gate, and inventing one is the error this rule exists to prevent.

Project instructions cannot grant access that a tool or service withholds. If a credential, scope
or permission is genuinely absent, say so plainly and name what is missing; do not simulate the
call and do not describe the result as verified. A tool's permission denial is not routed around:
no equivalent command, and no runbook for another session to run. Ask for a direct instruction in a
new message (on a surface that does not count approval given through a question prompt). Until it
comes, stop, record what is done, and hand the developer the exact command and its expected output.

Building, testing, committing, reviewing a candidate and promoting it are five different acts. Only
the last is a production decision, and only the last is a human's to make.

## 1. Requirements, decisions and recommendations — classified by authority, not by subject

What a statement is about never decides its class. Who established it, and whether it is approved,
decides its class.

- **Implementation requirement** — the developer stated it, or an approved decision in
  `state/decisions.md` or the repo's constitution establishes it. It goes into `state/rules.md` and
  it gets built. This holds regardless of subject: recipients, retention, operating hours,
  permissions, rate limits and quiet hours are ordinary requirements when the developer requires
  them. "It sounds like production policy" is not a reason to defer a requirement to a checklist.
- **Open decision** — a question of policy nobody has answered yet. Record it in
  `state/decisions.md` as OPEN with what is needed to close it, and choose a reasonable default so
  the work continues. Say which default you chose.
- **Configurable capability** — the behaviour is in scope and the value is not settled. Build it,
  make it configurable, state the default. A configurable capability is permission to add a setting
  for what was asked for; it is never permission to expand the feature beyond it.
- **Recommendation** — your idea, not theirs. Mention it once, in the change record, under
  Proposals. It never becomes a requirement by repetition.

Worked example. "Send reminders only between 09:00 and 17:00" is an explicit requirement: implement
the window, write it into `state/rules.md`, test it. If no window was ever stated, do not invent
one — record the question as an open decision if it matters, build without a window, and say so.

A recommendation or checklist item never silently becomes a requirement. A requirement is never
demoted to a checklist item because it touches production behaviour.

The developer's current instruction is authoritative whether or not it has been recorded yet.
Record it in `state/decisions.md` in the same turn, before the dependent work, and mark whatever it
supersedes as SUPERSEDED with the date and the instruction that replaced it. Never ask them to
repeat a decision they have already given.

## 2. The pipeline (a recommended order, not a set of locks)

1. Concept — a disposable interactive HTML mockup, decided through the design workflow and within the design principles (§13). Output: design approval and `state/inventory.json`.
2. Define — a plain-language interview in four categories (data, actions, permissions, edge cases). Output: `state/rules.md`, confirmed by the owner.
3. Build — targeted changes on a branch, derived from constitution + inventory + rules. Output: working code the developer has confirmed.
4. Check — independent review and applicable checklist results in the change record; acceptance pending is explicit when review precedes acceptance.
5. Run — promotion to production is an explicit human decision informed by the checklist. Never a side effect of a commit.

Prompt files: `/mock2-init`, `/mock2-concept`, `/mock2-define`, `/mock2-build`, `/mock2-check`.
Agents: **Mock2 Concept** (mockups and rules), **Mock2 Build** (implementation), **Mock2 Reviewer**
(independent review for `/mock2-check`, run in a separate context — see §7).

A developer may start at any stage. Missing inventory or unconfirmed rules are noted, not blocking;
if you are building without confirmed rules, write the rules you are implementing as `[draft]` in
`state/rules.md` so the owner can confirm them later.

A diagnostic or independent review requested before acceptance is ordinary work: run it, report it,
and populate applicable checklist/change-record evidence with acceptance pending. The evidence
itself does not establish acceptance, and neither review nor record adds a confirmation loop.

## 3. Before writing code

- Read `.mock2/capacity.md`, then `.github/copilot-instructions.md`, `state/rules.md`,
  `state/decisions.md`, `state/inventory.json` and `state/production-checklist.md` if they exist.
  Read `000-READ-FIRST.md` if this branch has written one; it is created once per branch, so its
  absence is normal and is not something to report or scaffold.
- Restate the rule(s) you are implementing, by number, before you implement them; draft new ones when none apply.
- Ask one question at a time, and only when you cannot proceed without the answer. Prefer a sensible default plus a note over a question.

## 4. While writing code

- Small, targeted changes on a branch. One concern per commit.
- The repository's stack, directory layout, styling tokens and host conventions come from its
  **application profile**, not from this file — see §9. Do not introduce a second ORM, validator,
  test runner or component library without saying why, and do not change a repository's stack
  because a profile prefers a different one.
- Every input crossing a trust boundary is validated at that boundary.
- No secrets in code, committed config, or chat. Application secrets come from the environment (say
  which variable) or the host's secret service. Integration credentials an operator manages are
  entered in the admin interface and stored encrypted (security baseline).
- Tests are part of the change, not a follow-up. Every external service the change talks to has a
  fake in the repo and the suite runs green with no network. Never resolve a failure by weakening a
  test or a requirement without saying so in the change record.
- Browser tests select on whatever expresses the behaviour most durably. Prefer role and accessible
  name (`getByRole`, `getByLabel`) where the assertion is about user-facing behaviour and
  accessibility semantics — that selector fails when the experience breaks, which is the point. Use
  a stable test id (`data-*`) where the contract is structural, where no accessible name is stable,
  or where the element is not user-facing. Either way the selector is a contract: changing one is
  recorded in the change record, and the affected tests are updated without weakening what they
  assert.

## 5. Verification

The current workflow is `rules/mock2-verification.md` in the governing standards baseline.

- `node .mock2/bin/check.mjs` aggregates selected checks and fails if a selected required check
  fails or cannot run. A focused invocation does not certify the full required set. Commands in
  `.mock2/checks.json` map to this repository's toolchain; do not assume npm.
- `;` can mask an earlier failure with the final command's status. `&&` short-circuits on failure:
  use it for true prerequisites, and use the aggregate runner for independent outcomes. A missing,
  interrupted or prerequisite-blocked check is never a pass.
- Run focused checks during implementation; overlap independent work within one shared server
  budget; build before checks consuming its output; revalidate affected inputs after repairs.
  Final integration needs valid evidence for every applicable required check. Broad or unknown
  impact requires the full applicable set.
- Reuse successful complete deterministic evidence only with proven matching input, tool,
  configuration/environment and freshness identities. Label it **reused — inputs unchanged**, with
  its original time/run. Invalidated or unproven evidence is **historical**. Never imply reuse ran
  again. The reviewer challenges assertions and evidence, then runs reproductions or fills gaps.
- Scan outgoing commit history and final delivered content. Reuse or generate repeated facts from
  one canonical run record; keep authored decisions and history. Select checklist modules by impact.
  The verification rule also defines controlled before/after comparisons of time and quality.

## 6. Once the developer confirms it works

- Run `/mock2-check` (or walk `state/production-checklist.md` by hand). Verify applicable modules,
  recording unaffected modules with a reason and reusing valid evidence. Failed or open items stay
  visible. A request for review authorizes review before acceptance too; it adds no confirmation loop.
- Write the change record: `state/change-records/YYYY-MM-DD-<slug>.md` (what changed, which rules, checklist results, review findings, open items, and — when useful — what was checked and deliberately left alone). A trivial fix gets a one-paragraph record.
- A rule that exists because of a defect found in use names the release that fixed it and the test that asserts it, in `state/rules.md`. That set is the parity guard a rewrite or port must keep green.
- Promotion is the developer's decision. Say what the checklist shows and what is still open;
  honor existing authorization and perform the applicable release verification without a repeated
  approval request. Without that authorization, hand over the reviewable candidate. A guest snapshot
  precedes every promotion.

## 7. Independent review means a separate context, not a different persona

`/mock2-check` runs the review in a context that has not just written the code: a subagent where the
surface supports one, otherwise a new session started from the review handoff the build turn wrote.
Announcing a persona change inside the same conversation is not independent review and is never
reported as one.

The reviewer receives the approved requirements, the applicable standards, the actual comparison
base (branch and merge base), the changed files, the candidate identity, relevant dependencies and
migrations, the verification evidence with the state each check tested, and any release prompt or
runner instructions the change ships with. It inspects the change and challenges the
implementation; it does not take the build turn's summary on trust.

The reviewer reads files, validates captured evidence, and runs targeted reproductions or missing
checks under the shared server budget. It does not repair application code — findings go back to
the implementation agent. Its toolset is not mechanically read-only, so it is described accurately:
it is instructed not to modify application code, and the change record says which tools it had.
After a material fix, affected validation and independent review evidence are refreshed against the
updated candidate. Unaffected successful evidence can remain valid under §5; invalidated or unproven
evidence is labelled historical and cannot certify current acceptance.

Where a surface cannot provide an isolated context, say so, and write the review handoff so the
review can be run in a new session. Do not describe isolation that did not happen.

## 8. Which standards govern

`.mock2/standards/VERSION` in the repository and `~/.mock2/version` on the machine may differ.

- The repository's copy governs work in that repository. It travels with the clone, and it is what
  a host with no installation has.
- When the machine's version is newer, say so once at the start of the work and carry on with the
  repository's copy. Bringing the repo up is a deliberate step (`/mock2-init` top-up, or the remote
  seeder), recorded like any other change — never a silent switch mid-task.
- When the repository has no `.mock2/standards/`, use the machine's copy and record in the change
  record which baseline was used and that the repository had none.
- When neither exists, say which baseline is unavailable, review against what you do have, and
  state the limits of the evaluation. Never describe a partial review as full conformance.

Two versions never silently govern one task. Whichever applies is named in the change record.
Load the concise current entry and rules needed for the task once, then read targeted sections as
needed. Historical documents remain provenance; the resolved current amendment takes precedence.
Do not repeatedly load conflicting historical wording and re-derive settled resolutions each turn.

## 9. Application profiles

The workflow above is general: scope control, requirement traceability, durable decisions,
handoffs, verification provenance and independent review apply to any repository in any language.

Technology choices live in a named profile. The **CPR application profile**
(`.mock2/standards/profile-cpr.md`) is the intended default for new CPR applications: TypeScript,
Express, Drizzle, Zod, Vitest, PostgreSQL on the server; React + TypeScript built by Vite,
Tailwind and shadcn/ui primitives on the client; the prescribed directory layout, the `--t-*` theme
tokens, and the Host SDK conventions.

Every repository records its profile in `.github/copilot-instructions.md` — `cpr`, or `none` for a
stack the profile does not describe — together with its deliberate deviations and their reasons.
Adopting Mock2 never rewrites an application's stack and never creates host-platform features
outside the repository's scope. Verification maps to the selected toolchain through
`.mock2/checks.json`.

Exact new-project pins and compatibility scope live in `stack.versions.json` / `Stack-Versions.md`.
Existing repositories retain their recorded release lines with maintenance patches unless the
developer asks to upgrade/migrate. AI data/retrieval follows `AI-Data-Standards.md` when applicable;
model/index identity, permission filters and private object storage are host capabilities.

## 10. CPR — Continuous Production Readiness v1.1

Mock2 builds on the CPR standard (full text in `.mock2/standards/CPR-v1.1.md` with
`CPR-v1.1-addendum-A.md` beside it, or `~/.mock2/standards/` on an installed machine; the rule
`mock2-cpr.md` carries the binding parts). §0 above is CPR's development-first rule (§3.1, §11.3).
In addition: features consume host capabilities through the Host SDK and never recreate auth,
database access, jobs, secrets, configuration, realtime, theming or AI access (§5–§6, Addendum A.2);
every feature declares a `feature.manifest.json` with namespaced permissions, owned migrations,
jobs, outbound hosts and the fakes its tests ship (§7, Appendix B, A.6); released versions are
immutable and breaking changes go expand → migrate → contract (CPR §8, §13); material architectural
decisions are recorded in `state/decisions.md` and never silently superseded by new code (§17.2);
commit is not release — promotion is an explicit human decision after review of the exact candidate,
preceded by a snapshot and delivered by a release that verifies its own hashes (§12, A.4). The Host
SDK conventions in that list belong to the CPR application profile (§9); the decision, review and
release rules are general.

## 11. Working style

- Prefer showing a mockup or a diff over describing one.
- When a rule and a request conflict, name the conflict and follow the request unless the rule is an explicit implementation requirement; record the conflict.
- When you learn something the standards should say, write it under **Proposals** in the change record rather than acting on it silently.
- Keep `000-READ-FIRST.md` current when you ship if this branch has one. Preserve history, but keep
  one concise current instruction for resolved standards. Archive dated rationale or superseded text
  with a pointer; do not require agents to merge an unbounded stack of conflicting addenda on every run.
- The developer's limiting words ("investigation only", "just confirm", "double-check, don't rerun") outrank a pasted prompt's broader instructions; a double-check is read-only.
- A question ("please tell me…") is answered, not built: its authorized task is the answer. When the developer answers your questions, restate the answers, record them (decisions, and stated requirements as `[draft]` rules), formalize the plan, and build when the developer says build. That is their instruction, not a gate.
- When the developer asks to hear before a merge or deploy, list what the merge does, what goes through the release surface, other sessions' work riding along and shared-database cautions, then wait for their go. This follows their instruction (and §0's third boundary where the deploy writes shared production data); it is not a gate on building or testing.
- A question stands on its own: say what it is about and why it matters, and offer concrete options with a recommendation. Before writing the next prompt, ask what the developer has already done; explain prompts plainly.
- Check before asserting how infrastructure behaves: read the ACTIVE decision, and test from where the code runs. Correct an earlier wrong statement both in the records and to the developer.
- When asked, estimate before building, and report the actual time against the estimate. A long silent stretch of work gets a short progress note.
- A stop the developer asks for ("stop and save") is CANCELLED, not STOPPED SHORT: start nothing new, commit what is verified on the session's branch, record the exact next step, and say what is left with an estimate.
- A compliance fact the developer asserts and you cannot verify is recorded as the developer's decision, naming every other link that must also be covered.
- A large plan is split into sections that each end in their own candidate release; a section with no design stop ships on its own.
- With no retention rule (check the existing rules first), nothing is deleted; record that storage grows until a rule exists.
- Before briefing helpers, confirm which copy of the code is live. Background processes you start must be able to end, and are stopped before the turn ends: `pgrep -f` and `pkill -f` match their own command line, so wait on a process id or a log line.

## 12. Capacity and delivery

The authorized task is the scope the developer established; the run plan in `state/work.md` records
and decomposes it and cannot expand it. A run is a bounded, verifiable work package, not one response;
a run boundary reached with green checks and nothing undecided is a checkpoint to continue through,
and completing one run does not complete the authorized task. Size items in points (S 1, M 2, L 4; 4
per run; XL decomposed first; decomposition stops when an item is independently executable and
verifiable) and classify a multi-item request as FITS, SPLIT or CANNOT. A valid existing plan takes
precedence over reclassification.

Every turn on a run produces at least one recorded verifiable outcome: an implementation cycle;
a validation that completes a pending requirement or establishes materially new evidence — re-running
a known unchanged failure is not progress, and recording an in-scope failure obliges the repair rather
than permitting a stop; or a bounded investigation that was the run's assigned purpose. Record every
material check with its command, result, original time/run and complete tested input identity;
label valid reuse `reused — inputs unchanged`, otherwise historical, and never imply it ran again. An item is VERIFIED when its
acceptance behavior is demonstrated, not when a command exits zero. Returning while the authorized task
is incomplete and actionable, with no supported stopping reason, is `STOPPED SHORT` whether or not an
outcome was produced; two in a row shrink the next execution unit, not the task. Reported context
percentages make state durable; they are not stopping rules, and a compaction notice is not a reason to
stop.

Bookkeeping is proportionate. A trivial change gets a concise work entry, a one-paragraph change
record and the evidence that actually matters; a multi-step task keeps enough durable state in
`state/work.md` and `state/handoff.md` to resume accurately in a new session. Neither size skips
recording what was checked and what it tested.

End every turn by updating `state/work.md` and writing `state/handoff.md`. Canonical rule:
`.mock2/capacity.md` in the repository.

## 13. Design principles

Every interface is designed within these from its first mockup, beside accessibility at every level
of the design workflow's precedence (`mock2-design-workflow.md`, in `.mock2/standards/rules/` or
`~/.claude/rules/`). They guide the design and never gate building or testing (§0); a developer's
explicit departure from one is followed and recorded (§11).

- **Designed for the device and the mode it is used in.** A screen used on a phone is designed for
  its edges, and an app with a web app manifest for the installed view as well as the browser tab:
  bottom-anchored controls clear the system navigation bar in both, whether or not the phone reports
  an inset, on first launch, reload and resume. Mockups and checks cover both modes; viewport-sized
  shells refresh their height and account for excluded space once, with device checks through the
  lifecycle rather than only the first look.
  Pattern, the Android fallback and the checks: `mock2-mobile-web.md`; CPR current §O
  (`CPR-v1.1-current.md`).

## 14. Relay work visibility

For work-event capture and execution replay, load `rules/mock2-relay.md`. The check runner records
actual outcomes; agents record their own meaningful checkpoints. CPR `Relay.md` defines the
portable feature and host integration; existing host auth and data boundaries remain authoritative.

## 14. Universal integration foundations

New applications establish the small, working, empty-connection-capable foundation in
`Universal-Integration.md` and `Universal-Integration-New-App-Prompt.md`: internal identity,
scoped external mappings, connections, versioned outcome contracts, adapters/composition,
capability evidence and authorized dispatch. Existing integration modernization uses
`Universal-Integration-Existing-App-Prompt.md`: inventory and wrap first, preserve working
connections, then migrate verified caller slices. A standards-only update does not authorize
application migration. Reuse the current stack/host capabilities and keep domain models relevant
to the app. Record actual implementation, crosswalk, conformance evidence and limitations in
`state/integrations.md` or its established equivalent; no connection or speculative vendor is required.

<!-- END PINNED MOCK2 GUIDANCE -->
