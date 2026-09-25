# Next section prompt — A1 scope and architecture only

Prepared for the next session. Do not execute merely by reading this file.

---

Please complete A1 of the official Fractionate A1–A8 agent plan: define and design
the first usable supervised agent workflow. Do not advance to A2 or implement a
runtime in this section.

Workspace:
`C:/Users/thoma/Fractionate/OpenAI/Fractionate/ProxyPilot-batch-03`

## Read first

- `docs/plans/fractionate-agents-a1-a8.md` (authoritative first delivery list),
  `fractionate-follow-on-plan.md` and the committed handoff records beside them.
- The latest Git status/log and relevant PR/check results. Do not assume that the
  requested foundation merge succeeded; distinguish committed, pushed, merged,
  verified and deployed status from recorded evidence.
- Local `../FINISH.md`, both section trackers, transition review, Operations and
  Demonstrations designs/plans and D1–D4 reports/verification/commands, if present.
  Saved evidence is adjacent to the checkout, not necessarily in a fresh clone.
  If unavailable, report that limitation and inspect committed code/tests.
- Applicable AGENTS.md/CLAUDE.md, current Operations/agent/setup/security docs,
  actual authorization, guide/version/evidence and manual-run contracts; current
  execution, host-agent, Infisical and development-runner interfaces. Existing
  management-plane code does not establish an operational task runtime.

## A1 work

1. Record branch, HEAD, complete status and relevant file hashes. Preserve all
   uncommitted work and immutable migrations. No reset, cleanup or unrelated edits.
2. Ask the user early for the first concrete workflow, target application and
   desired output if the session has not already specified them. Also establish
   what the agent may change and what requires human approval. Continue source
   inventory and architecture work while waiting; do not guess permission to use
   a real account or application. Any unanswered selection remains explicit.
3. Define the first-agent acceptance contract: inputs, exact approved guide,
   allowed tools/actions/domains, output, success/failure evidence, escalation,
   cost/time/action limits, stop behavior and human takeover. One supported
   workflow and one concurrent run is the default bounded target.
4. Trace what can be reused and what is missing. Separate Operations identities
   from Dev Studio projects, host agents and Infisical identities. Define stable
   project/profile/run/worker/credential-binding relationships and authority.
5. Produce the architecture and state/authority contracts: guide version pinning,
   worker boundary, provider adapter, credential handling, approval checkpoints,
   durable events/results, stream visibility, cancellation and crash recovery.
   Treat page content, imported evidence and model output as untrusted data;
   none may expand permissions or silently authorize actions.
6. Map SEC-01–05 and INF-01–04 to the concrete pilot. Reinspect host-boundary
   findings and historical integration conflicts. Identify prerequisite fixes in
   A2–A8 and state which broad estate tasks can remain F7 with reasons. Do not
   bypass required CI, shift a live-agent blocker to follow-on work, or claim
   target isolation/credential non-disclosure from configuration alone.
7. Refine A2–A8 into acceptance-sized work without expanding the official eight
   sections. State dependencies, test strategy, deployment requirements and any
   estimate change. Keep F1–F7 deferred; D5 and shared Knowledge are not required
   unless a concrete user-selected workflow creates a reviewed dependency.
8. Write an executable A2 prompt limited to profiles, permissions and guide
   assignment. No provider calls, credential provisioning or runtime creation in
   A2 merely because an agent profile is created.

## Output and stop

Save the architecture, pilot contract, source/dependency register and acceptance
matrix in `docs/plans/`; put baseline, commands, hashes, investigation results,
limitations and exact incremental diff in `../agents-a1-evidence/`. Verify links,
document consistency, preservation and any bounded design experiments. Cite
historical tests as historical; rerun relevant checks only when warranted.

Update the official plan's status and the local FINISH/trackers. If a required
workflow or authority decision is missing, identify it and do not mark A1 complete.
Finish with the reviewable design and A2 prompt, and stop for review.

No runtime implementation, feature activation, live credential reads/provisioning,
provider calls, recordings, RecapShare changes, production service start, host
mutation, live migration/retention/cleanup, deployment or automatic advancement.
Do not commit, push, create/merge a PR in this future section unless separately
requested. The earlier foundation commit/merge authorization is not blanket
authorization for future batches or live actions.
