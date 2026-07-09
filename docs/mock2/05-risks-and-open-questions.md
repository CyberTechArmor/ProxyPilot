# Risks, unknowns, and open questions

## Risks the existing architecture creates

**R1 — TLS for project URLs.** *(Downgraded 2026-07-09: the operator accepted
per-slug Let's Encrypt HTTP-01 certs — ADR-009 — removing the lego/DNS-API
dependency.)* Residual risk is Let's Encrypt rate limits (50 new certs/week
per registered domain; slug-rotation churn counts) and first-hit issuance
latency. M1 must surface ACME failures as notifications rather than silent
502s. The wildcard DNS-01 sidecar remains the documented upgrade path if the
limits ever bite.

**R2 — Per-project bridges interact with existing networking code.**
`ensureNetworkNat()` NATs *every* managed bridge it finds (`lxc.js:105-154`),
so Mock2 bridges will be NAT'd the moment they exist — which fights the
default-deny egress posture unless the nftables chain sits in front of the
NAT path. Order of rules across `table inet proxypilot`, Incus's own firewall
rules, and Docker's chains (when the backend runs in compose) needs a real
test matrix in Phase M4, not reasoning from docs. Budget time for it.

**R3 — The backend may itself run inside Docker.** All host mutations pivot
through `nsenter -t 1` (`host-exec.js:26-60`). Every new host-side moving
part (lego, squid, git on host paths, nftables edits, per-project bridges)
must work through that pivot and be exercised in both deployment shapes.
This is boring, pervasive, and the most likely source of "works on my host"
bugs.

**R4 — SQLite under a chat + cycle workload.** better-sqlite3 is synchronous;
a busy runner writing checkpoints/change records while the UI polls chat is
new write pressure. WAL helps; still: keep transactions short, set
`busy_timeout`, and keep `mock2.db` separate (already decided) so Mock2 churn
never blocks the main DB. Load-test in M10; if it cracks, the escape hatch is
a queue-thread for writes, not a database migration.

**R5 — Cost estimation is speculative.** "Estimate the cycle's cost before it
starts" has no reliable oracle for agentic loops. Treat the reservation as an
envelope (per-stage historical p90 from the ledger × safety factor), refuse
on the envelope, and rely on the mid-cycle buffer stop as the real guard.
Expect the first weeks of estimates to be bad; the ledger exists to fix that.

**R6 — Bare-repo ↔ container git transport needs a decision in M2.** Options:
mount the bare repo into the container as an Incus disk device (simplest;
but a hostile container can then corrupt the bare repo directly — mitigate
with `git fsck` on fetch and repo backups), or expose it read-write over the
project bridge via `git daemon`/http on the host (cleaner trust story, more
moving parts). Recommend the mount for v1 **read-only** with commits fetched
by the orchestrator from the container's working clone (orchestrator-side
`git fetch <container-path>` via `incus file pull` is not viable at scale —
so: orchestrator runs `git -C <bare> fetch <container-clone-via-incus-mount>`;
concretely, mount a host-side *fetch mirror* rather than the bare repo
itself). This paragraph is deliberately unresolved: settle it in the M2
session with a spike, and record it as ADR-011.

**R7 — Terminology collision: "agent."** `proxypilot-agent` is an installed
Go host daemon, load-bearing for one CVE path (`security-cve-driver.js:18-59`).
The brief's "agent" (the AI that builds) is called the **runner** everywhere
in this bundle. Keep that discipline in code (`mock2/runner.js`, not
`mock2/agent.js`) or grep will lie to future sessions.

**R8 — Framework seed content is a prerequisite, not a code artifact.**
*(Resolved in direction, 2026-07-09: seed v1 is the operator's current Mock2
framework, vendored into this repo so it is "built in by default" — see Q3.)*
The content handoff itself is still a Phase M5 prerequisite: the operator
must supply the current Mock2 material (constitution, four skills, gate
scripts, design system, project template) for vendoring under
`admin/backend/src/mock2/framework-seed/`. Without it, M6+ runs on
placeholder gates.

**R9 — Existing test-suite gap.** Three backend tests already fail in fresh
checkouts because they import real `db.js` (`docs/known-issues.md`). Mock2
adds a second native-module DB; write all Mock2 tests stub-first (the passing
pattern) so the module never worsens that hole.

**R10 — MOBILE_FIRST is a merge gate for a chat product.** Chat + tappable
rule questions + gates-going-green must be designed at 360px from the first
mock, or M7–M9 will churn on retrofits. Reuse the phase-stepper pattern
(`LxcContainers.jsx:2304-2340`) for the build view.

## Open questions — operator answers recorded 2026-07-09

**Q1 — TLS mechanism. ANSWERED.** "Caddy just grabs the Let's Encrypt cert —
fine for now." → v1 uses per-slug HTTP-01 certificates; no DNS provider API;
wildcard DNS still points at the host; DNS-01 is the deferred upgrade path.
ADR-009 updated and accepted. M1 unblocked.

**Q2 — Identity and project databases. HALF-ANSWERED.**
- *Identity (ADR-007): accepted.* ProxyPilot's built-in auth is the
  initial-setup path. LDAPS, later, is the user-provisioning layer: LDAP
  authenticates; local authorization flags decide whether that directory
  user is admin / editor / viewer / **nothing at all**. The ADR-007 model
  already has that shape; no change needed when LDAPS lands.
- *Project databases (ADR-008): still open.* The answer addressed identity
  only. **Confirm Postgres-inside-each-project-container vs. shared cluster
  before Phase M2.**

**Q3 — Framework v1 source. ANSWERED.** Seed is the operator's current Mock2
framework, vendored into this repo ("built in by default"), editable in-app
as markdown, **admin-gated** (relaxed from superadmin-only), versioned in the
registry (`mock2_framework_versions` — the brief's "versioned by postgres"
maps to `mock2.db` per survey §2). Content handoff remains an M5
prerequisite (R8).

**Q4 — Retention/purge. ANSWERED (as policy direction).** Archive leaves the
git repo alone, destroys the LXC, and freezes everything else **read-only**:
viewable but not changeable (no chat, cycles, membership or settings edits;
rehydrate is the only action). Long-term purge policy remains deferred by
design — still flagged, still a future decision.

**Q5 — Host topology. ANSWERED.** Typical company setup: one dedicated
dev/build server (Mock2 enabled) + a separate production server (pinned
disabled). Home lab may run a single host for everything. Both are supported;
the runbook documents the two shapes, and the single-host shape leans harder
on M4 isolation.

**Q6 — Egress proxy. AWAITING DECISION (explained).** What it is: the brief
requires each project container to reach *only* npm, the model APIs, and its
git remote. Firewalls match IP addresses, but those services are host*names*
on CDNs whose IPs change constantly — so the standard mechanism is a small
host-side "egress proxy" (squid): containers are pointed at it via standard
`HTTP(S)_PROXY` env vars, it forwards traffic only to allowlisted hostnames,
and the bridge firewall blocks everything that tries to go around it. It is
**not** in ProxyPilot today; it would be installed only when Mock2 is
enabled. Alternatives if vetoed: (a) bridge isolation only — containers can't
reach each other or the control plane but have open internet egress (drops
the brief's allowlist requirement); (b) DNS-resolved IP sets in nftables —
no new daemon, but brittle against CDN rotation. Recommendation stands:
squid. Decision gates Phase M4 only.

**Q7 — BAA. ANSWERED.** Yes, cloud model accounts are expected to be
BAA-covered — enforced as a one-time acknowledgement message on connector
save (recorded: who/when on the connector row), not a blocker. Added to M5
scope and the data model.
