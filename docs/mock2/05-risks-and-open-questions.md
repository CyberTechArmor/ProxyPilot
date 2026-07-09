# Risks, unknowns, and open questions

## Risks the existing architecture creates

**R1 — Wildcard TLS is the plan's hardest external dependency.** Nothing in
the stack does DNS-01 today; wildcards are actively downgraded to HTTP
(`services.js:6056-6060`). ADR-009's lego sidecar keeps Caddy stock, but it
adds a new system service, a DNS-provider API dependency, and a renewal
failure mode that must be monitored. If the operator's DNS host has no API
(or no lego provider), parent domains are dead in the water — confirm the
provider before Phase M1 (Q1).

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

**R8 — Framework seed content is a prerequisite, not a code artifact.** Phase
M5 seeds framework v1 (constitution, four skills, gate scripts, design
system, project template). That content is the Mock2 product itself and
doesn't exist in this repo. It must come from the operator's Mock2 material —
without it M6+ can only run with placeholder gates (Q3).

**R9 — Existing test-suite gap.** Three backend tests already fail in fresh
checkouts because they import real `db.js` (`docs/known-issues.md`). Mock2
adds a second native-module DB; write all Mock2 tests stub-first (the passing
pattern) so the module never worsens that hole.

**R10 — MOBILE_FIRST is a merge gate for a chat product.** Chat + tappable
rule questions + gates-going-green must be designed at 360px from the first
mock, or M7–M9 will churn on retrofits. Reuse the phase-stepper pattern
(`LxcContainers.jsx:2304-2340`) for the build view.

## Open questions for the operator

**Q1 (blocks M1):** Which DNS provider(s) for parent domains? (Needs a lego-
supported API; Cloudflare is the well-trodden path.) Also: is a low-effort
alternative acceptable as an M1 fallback — per-slug HTTP-01 certs (no
wildcard, slower first-hit, no DNS API needed) — if wildcard setup stalls?

**Q2 (blocks M2):** ADR-007 (ride existing auth, defer LDAPS) and ADR-008
(Postgres-in-container) are deviations from the brief. Approve, or redirect —
each redirect adds a sizable prerequisite phase (LDAP integration; shared
Postgres+PgBouncer buildout ≈ core-plan phases 4+7).

**Q3 (blocks M5 seed / M6 usefulness):** Where does Mock2 framework v1
content come from? (Constitution, the four skills, gate scripts, design
system, project template.) If it lives in another repo, the git-sync import
in M5 becomes the seed path.

**Q4 (policy, non-blocking, from the brief):** Retention and purge are
deferred by design — but "nothing is ever deleted" needs an eventual policy:
archived-project repos, chat transcripts, change records, quota ledgers.
Flagged here so it's a decision, not an oversight.

**Q5 (non-blocking):** Does the dev-plane host run anything else? If the
Mock2 host is dedicated (recommended — it makes the trust-inversion story
cleaner), say so in the runbook; if it shares with production-adjacent
proxying, the M4 isolation matrix gets stricter.

**Q6 (M4 detail):** Egress proxy choice — squid (per-source ACLs, SNI
peeking, heavier) vs tinyproxy (lighter, cruder filtering). Default
recommendation is squid; veto if there's an operational preference.

**Q7 (M5 detail):** Are Anthropic/OpenAI/Gemini keys expected to be
BAA-covered accounts (per the brief's PHI position)? Doesn't change code,
does change the connector-setup runbook text.
