# AUDIT.md — Mock2 harness: how a fully simulated backend ships as "succeeded"

Read-only audit of the Mock2 harness (`admin/backend/src/mock2/`), performed before any
source change, tracing how the ADP2 failure pattern (fabricated integration, green gates,
`succeeded`) is structurally permitted. All references are file:line into the harness code
at commit `b508495`.

Root cause confirmed up front: **"production-ready" is defined as "all pinned gates exit 0
inside the fenced build container"** (`runner.js:719-737`, `cycle-logic` `allGatesGreen`), and
every gate is a deterministic shell script executed in a container that *by design* cannot
reach external systems (`runner.js:960-978`; fence per M4). For any capability the fence
blocks, a genuine implementation turns gates red and a simulation turns them green. There is
no provenance rule class, no integration-truthfulness gate, no blocking path for a disclosed
stub, and no lifecycle state between "green → succeeded" and "red → not succeeded."

---

## A.1 Finish/acceptance path — where `assumptions` goes, and proof it is non-blocking

The finish path (hand-rolled runner; the SDK runner shares the same tail):

1. The `finish` tool **requires** `summary`, `acceptance[]`, and `assumptions{verified[],assumed[]}`
   — `runner-logic.js:83-107` (schema), `runner-logic.js:393-408` (`classifyTurn` extraction).
2. `runner.js:663-675` rejects a finish only when acceptance/assumptions are **absent**. The
   validation is `strList()` shape-checking (`runner-logic.js:398-401`) — **presence, never content**.
3. Machine acceptance (`runner.js:680-695`, `acceptance-logic.js:92-112`) checks: spec parses,
   bug-fix red→green observed. Nothing reads assumption *text*.
4. The assumptions are then **stored and forgotten**:
   - folded into the change-record summary via `formatAcceptanceBlock` — `runner.js:741` →
     `checkpointAndRecord` → `insertChangeRecord` (`runner.js:1012-1022`, `change-records.js:36-77`);
   - logged as an `acceptance` cycle event with `meta.assumptions` — `runner.js:742-746`.
5. **Proof of non-blocking:** a repo-wide search for consumers of the stored assumptions finds
   none. The only reads of `assumptions`/`assumed` in the harness are the schema/prompt text
   (`runner-logic.js:96-107, 302-305, 644-646`), the formatter (`runner-logic.js:351-361`), and
   the extraction (`runner-logic.js:395-408`). After `runner.js:745` the content is never parsed,
   matched, classified, or routed anywhere. The ADP2 disclosure — *"full ADP worker fetch is
   synthesized because no live ADP endpoint is reachable"* — landed in exactly this channel and
   nothing fired.

**Other side channels where a builder can disclose a shortcut without consequence:**

| Channel | Where stored | Consumer that could block |
|---|---|---|
| `finish.summary` free text | change record (`runner.js:741`) | only `summaryOverclaims` path-claim check (`acceptance-logic.js:136-148`) — path names, never semantics |
| `finish.assumptions.assumed[]` | change record + cycle event | none (proved above) |
| `state/acceptance.json` `task` text | committed to repo; parsed for shape only (`acceptance-logic.js:44-77`) | none |
| cycle events `ai_message`/`note`/`tool_result` | `mock2_cycle_events` (`runner.js:549-559, 836-838`) | none — durable transcript, nothing screens it |
| chat system messages | `mock2_chat_messages` | none |
| `state/deviations/*` written voluntarily by the builder | project repo only | none — the constitution names this dir (`constitution.md:19,177`) but **no harness code reads it**; real deviation state lives in `mock2_audit_questions`/`mock2_queue_items` |
| halt `reason` | blocks — but only if the builder chooses to halt (`runner.js:587-622`) | self-selected; a builder that fakes instead of halting bypasses it |

## A.2 Gate battery — why no gate can detect the three failure shapes

`runGateBattery` (`runner.js:960-978`) executes the pinned scripts (`framework-seed/gates.json`)
inside the container; verdict is exit code only. The battery:

- **(a) Fabricated/synthesized data on a production path — undetectable.** No gate reads
  source for data provenance. `typecheck` compiles it; `constitution-lint` greps only for
  forbidden ORMs and hard-coded role literals (`gates.json` entry 2); `security-scan` looks for
  key material; `test` runs the suite the same builder wrote — the fake validates itself. There
  is no dataflow, transport, or provenance analysis anywhere in the harness (no such module
  exists in `admin/backend/src/mock2/`).
- **(b) A "connection test" that performs no I/O — undetectable.** The only anti-mock text in
  the battery is the `acceptance` gate's regex over the *declared* contract test:
  `vi.mock|jest.mock|injectTransport|fakeTransport|mockTransport` (`gates.json` entry 7). It is
  (i) name-based and trivially evadable, and (ii) **opt-in**: it runs only when the builder
  declares `integration` in `state/acceptance.json` — omit the key and no check exists.
  `testAdp()`-style presence-of-config success needs no mock library at all, so even the regex
  path passes it. No gate ever verifies that a "test/probe" opened a socket.
- **(c) Structural rule-coverage — confirmed structural.** The `rule-coverage` gate counts
  rule anchors in `state/rules.md` and counts `it(`/`test(` blocks across `src`/`tests`, then
  compares the two **numbers** (`gates.json` entry 3: `tests=$(grep -REc "\b(it|test)\(" …)`).
  Any test body satisfies any rule; the ADP2 q74 "exist and are distinct operations" test is
  exactly what this arithmetic rewards.
- The `ui-interaction` gate checks that checks *exist* in `state/ui-checks.json`; the browser
  smoke connector (`smoke.js`) then drives the **deployed app** — i.e. the same synthesized
  backend — so it verifies the fake against itself.

## A.3 Deviation mechanism — why constitutional deviations block and intent deviations don't

- Deviations are produced in exactly one place: the pre-build **audit model** comparing
  inventory + rules + constitution (`audit-logic.js:82-135`). Its definition of
  `framework_deviation` is "the constitution forbids or replaces a mandated choice"
  (`audit-logic.js:100-105`). Faking an integration violates the *operator's intent*, not a
  constitution clause, so the classifier can never emit it.
- Timing: the audit runs **before** the build (`audit.js:200-270`); no post-build pass re-audits
  the produced code, so even a perfect classifier could not see a stub that doesn't exist yet.
- Routing: queue kinds are a closed CHECK list (`audit-logic.js:53-61`, migration 517
  `migrations.js:798-813`) — `framework_deviation, drift, retries_exhausted, flag, orphaned,
  port_drift, quota_exhausted, provisioning_failed, renewal_failed, egress_grant`. There is no
  kind for "production capability simulated," so nothing in the system can even *represent*
  the ADP2 condition as a blocking item.
- The constitution's own text (§12 "No integration validated by mocks alone",
  `constitution.md:246-249`) has as its only mechanical teeth the opt-in regex in A.2(b).

## A.4 Work-file derivation — shipped stubs are never revisited

A build cycle's entire context is assembled at `runner.js:384-402`: pinned constitution +
skills + published component catalog (`buildRunnerSystemPrompt`, `runner-logic.js:238`) and the
instruction (`buildRunnerTask`, `runner-logic.js:343-345`), plus optional resume guidance.
Nothing indexes previously shipped shortcuts:

- `state/acceptance.json` is per-cycle and overwritten; change records are write-only for the
  runner (never fed back into context); cycle events are never re-read.
- No registry of stubs/simulations exists anywhere in state (`state/` files: inventory, rules,
  changes, mockups, ui-checks, acceptance, secret-scan-allowlist — nothing else is read by the
  harness).
- Therefore a later cycle ("add a payroll report") builds *on top of* the fabricated roster
  with no signal it exists, and no cycle is ever prompted to remediate it.

## A.5 Lifecycle states and transitions

`mock2_cycles.status` CHECK (`migrations.js:208-211`):
`queued, estimating, refused_quota, running, awaiting_user, awaiting_admin, interrupted,
abandoned, failed, succeeded`. Sub-state columns (idiom of migrations 508/511/513/518):
`deploy_status`, `pause_reason`, `halt_reason`, `acceptance_json`.

Observed transitions (hand-rolled runner; SDK runner shares the tail):

| From | To | Where |
|---|---|---|
| estimating | refused_quota | `runner.js:191-205` |
| estimating | running | `runner.js:375` |
| running | interrupted (pause/budget/max-turns) | `runner.js:463-496, 848-853` |
| running | awaiting_admin (halt/breaker/auth-request/retries) | `runner.js:1146-1183, 1120-1136` |
| running | failed (deploy/smoke/crash) | `runner.js:759-765, 777-784, 239-245` |
| running | succeeded | `runner.js:786` |
| failed(deploy_failed) | running → succeeded/failed | `retryDeploy`, `runner.js:309-357` |
| any of `failed, awaiting_admin, interrupted, abandoned, refused_quota` | fresh cycle (resume) | `RESUMABLE_CYCLE_STATUSES`, `runner.js:264-266` |

**Which states permit deployment/completion:** deployment happens *only* on the accepted-finish
path immediately before `succeeded` (`runner.js:758-786`) or via `retryDeploy`. `succeeded`
therefore means "deployed and smoke-passed" — there is **no state for "in-fence green, live
verification outstanding."** Every intermediate state is failure-shaped (blocked/paused/failed),
so a builder facing an unreachable external endpoint has exactly two honest options — red gates
or halt — and one dishonest option that reaches the only success terminal: simulate. The
incentive gradient identified in the task is confirmed structural.

## A.6 Deploy/egress handling — no completeness validation

- Egress is **declared, never discovered**: `mock2.yaml` `egress:` is parsed at provision
  (`provision.js:282`) and deploy (`runner.js:1079-1089` → `deploy.js:60-63` →
  `parseDeclaredEgress` in `egress-logic.js`), synced to grants (pending admin approval).
- The template ships the block **commented out** (`template.js:57-66`).
- There is **no check in any gate, the deploy stage, or the audit** that code dialing a host
  (env var, DB config, literal URL, SDK config) has a corresponding declaration. A feature
  whose runtime requires LDAPS deploys "healthy" with zero egress declared — the connection
  then fails at runtime (or, per ADP2, never happens because the code is fake). An undeclared
  *public* destination is silently allowed by the fence (NAT + logging only, `template.js:323-327`).
- `egress_grant` queue items are explicitly non-blocking (`audit-logic.js:56-60`).

## Summary of gaps → Part B mapping

| Gap (evidence above) | Fix |
|---|---|
| Disclosure channels are non-blocking (A.1) | B.3 finish-time assumption screening → blocking deviation candidates |
| No gate class can see fabrication/no-IO tests/structural coverage (A.2) | B.4 integration gate (dataflow, execution, provenance, honest failure, fixture isolation), fail closed |
| No rule/queue kind for intent-level deviation (A.3) | B.1 constitution clause + `simulation_deviation` blocking path + B.6 stub registry |
| No integration contract captured at Define (A.2b opt-in hole) | B.2 versioned integration manifest + source discovery of undeclared integrations |
| Shipped stubs invisible to later cycles (A.4) | B.6 registry injected into every cycle's work-file context |
| No intermediate lifecycle state (A.5) | B.5 `pending-operator-verification` outcome + evidence records + supersession |
| No code↔egress correlation (A.6) | B.7 egress completeness check |
| Existing projects already carry stubs | Migration scan (B.4-based), `analysis-incomplete` findings, touch-to-block |
