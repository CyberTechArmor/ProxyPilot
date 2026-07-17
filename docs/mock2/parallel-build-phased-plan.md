# Parallel build workers — phased plan

Goal: one build request fans out to **multiple concurrent workers**, each owning
an isolated area of the codebase, followed by an **integration pass** that wires
anything depending on the completed areas. Phases are ordered; each ships alone
and is useful without the ones after it. (Terminology, risk R7: these are
"workers"/"lanes" — nothing in code is named "agent".)

Why this order: decomposition must exist before isolation can be enforced,
isolation must be enforced before concurrency is safe, and concurrency must be
safe before it's worth building product surface on top.

---

## Phase P0 — The work plan artifact (decompose; no concurrency yet)

The prerequisite for everything: a machine-checkable statement of WHO owns WHAT.

- After component pre-install, one planning model call (build lane, low effort)
  decomposes the approved inventory + instruction into **areas**:
  `{id, title, goal, owns: [path globs], api: [what it exposes], depends_on: [area ids]}`.
- **Pure validation** (`plan-logic.js`, stub-first): ownership globs must be
  pairwise disjoint; the dependency graph must be a DAG; shared spine files
  (`src/app.ts`, `src/server.ts`, `mock2.yaml`, `migrations/`, `state/`) are
  reserved for the final integration area only — a plan that violates any of
  this is rejected and re-planned once, then falls back to single-worker.
- Persist as `state/build-plan.json` (hash-chained like all `state/` content);
  render it in the Build panel.

Deliverables: `plan-logic.js` + tests, a `plan` step in the runner, UI list.
No behavior change to execution yet.

## Phase P1 — Sequential area execution (prove isolation before parallelism)

Run the plan with ONE worker, area by area in topological order.

- Each area runs as a scoped segment: the area's goal + its dependencies'
  manifests as the task, and a **write fence** — `executeTool` rejects
  `write_file`/edits outside the area's `owns` globs (pure glob check, tested).
- Completed areas publish `state/areas/<id>.json` (files written, endpoints,
  exports) — the manifest later areas receive as "already built, reference it".
- Cheap per-area verification (typecheck only); the full gate battery runs once
  at the end, unchanged.

This alone shrinks blast radius and proves the fence + manifest contract with
zero locking changes. Bail-out: any fence violation downgrades the build to
today's single-loop behavior.

## Phase P2 — Concurrency in one container (worktrees + shared budget)

Make N workers safe in the same project container.

- **Isolation:** per-area `git worktree` under `/srv/work/<area-id>` on branch
  `area/<id>`, created from the pre-install checkpoint. Workers never touch
  `/srv/app` directly; the container-level checkout lock (ADR-004) stays held
  by the parent build for the whole fan-out — external writers are still
  excluded, and workers can't collide by construction (disjoint `owns` + the
  P1 fence, now relative to each worktree).
- **Scheduling:** areas whose `depends_on` are all complete become eligible;
  run up to `MOCK2_PARALLEL_WORKERS` (default 3) model loops concurrently.
  Dependents start as soon as their dependencies' manifests exist — no global
  barrier.
- **Shared accounting:** token/cost/soft-pause budgets aggregate atomically
  across workers per run; a pause checkpoints every worker's worktree. Events
  gain a `worker` tag so the request log interleaves legibly.
- **One-time setup stays serial:** npm installs and migrations happen in the
  parent before fan-out (declared deps only) — workers never run installs, so
  there is no package/DB contention.
- Watch: provider rate limits multiply with N (TPM); surface 429 backoff per
  worker, and let quota refuse fan-out down to 1 worker gracefully.

## Phase P3 — Merge + the integration pass (the "reference what's done" half)

- **Merge** area branches into `/srv/app` in topological order. Conflicts are
  impossible if ownership was honored — so a conflict is treated as a plan
  violation: fail that area loudly (halt with options), never auto-resolve.
- **Integration worker** runs last, owning the reserved spine files: its prompt
  carries every completed area's manifest and it wires the dependents — mounts
  routes, imports modules, renumbers migrations — then runs the FULL gate
  battery, acceptance, checkpoint, deploy (all unchanged from today).
- **Partial failure:** a failed/halted area doesn't sink the rest — green areas
  merge; the integration pass works with what exists; the failed area resumes
  individually with its worktree intact (per-area resume instead of whole-build
  resume).

## Phase P4 — Product surface + budgets

- Build panel: one progress lane per worker (name, current step, spend), plus
  the plan view from P0 with live per-area status.
- Admin settings: worker count (1 disables the feature), per-mode defaults —
  fan-out ON for initial/MVP builds (big, decomposable), OFF for small update
  cycles (routing's difficulty score gates it: difficulty >= 4 or initial
  build → fan out).
- Cost truth: per-area itemization on the request record; the change record
  lists areas + the integration merge as one hash-chained history.

## Phase P5 — Hardening & leverage

- SDK-runner (`BUILD_RUNNER=sdk`) parity for the fan-out path.
- Deterministic resume: `state/build-plan.json` + area manifests make a resumed
  fan-out re-enter exactly where it stopped (completed areas are cache hits).
- The plan becomes a durable **module map**: later single-worker cycles receive
  the area map so "anything that depends on it" is referenced from manifests
  instead of re-read from source — cheaper context for every future build.

---

## Test strategy (every phase)

Pure logic first, at the module boundary (risk R9): plan validation (disjoint
globs, DAG, reserved spine), write-fence glob checks, eligibility scheduling
(which areas may start given completed set), merge ordering, budget
aggregation. Container/git behavior gets one integration test per phase behind
the existing stubbed-DB pattern.

## Explicit non-goals

- Cross-container distribution (all workers share the one project container).
- Speculative execution of dependent areas before their dependencies finish.
- Auto-resolving merge conflicts (a conflict is always a surfaced plan bug).
