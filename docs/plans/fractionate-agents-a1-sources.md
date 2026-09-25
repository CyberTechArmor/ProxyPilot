# A1 source, reuse and dependency register

Initial inspection was at clean local HEAD `d5f6483baa4637c3e10f90374aea9ba79c3a2e9c`,
tree `f984051d3ec37dc2f81ee48c9d2cfd9466312cf7`, seven local history
commits ahead of `origin/main` with equal tracked content. The A1 review began
with preserved uncommitted demo source and documents. [A1 evidence](fractionate-agents-a1-evidence.md)
records current status, hashes and fresh live checks. Source inspection alone
is not deployed behavior certification.

| Source and observed contract | Reuse / gap for first agent |
|---|---|
| `admin/backend/src/lib/operational-projects-{schema,store,logic,workflow}.js`, `routes/operational-projects.js`, `docs/features/operations.md` | Reuse Operations project UUID, current-account grants, independent review, immutable version/hash and event patterns. `ops_manual_runs` are human reports. The router exposes no agent launcher/profile/worker/credential binding. A2 adds profile configuration without changing manual records; A5 adds separate run tables and coordinator. |
| `admin/backend/src/lib/operational-evidence-*`, migrations 1103–1105, `docs/features/operations.md` | Frozen guide references and private evidence can inform a guide only within existing access. Evidence is untrusted data, never a tool/authority grant. Media decoder target sandbox and retention remain unverified release gates; the first pilot need not require D5 or shared Knowledge. |
| `admin/frontend/src/App.jsx`, `admin/frontend/src/lib/api.js`, Operations pages | Reuse route/session/CSRF, revision and accessible UI conventions. A2 needs a scoped profile UI; A6 needs a separate Agents/Flightdeck supervisor view. Follow `admin/frontend/MOBILE_FIRST.md` for any UI changes. |
| `admin/backend/src/mock2/{runner,runner-sdk,flightdeck}.js`, `docs/features/flightdeck.md` | Dev Studio's project build worker, file API and polling/terminal patterns are technical references. They are tied to Dev Studio containers and edit authority, with in-memory job progress; they are not Operations project IDs, durable agent runs or a safe generic browser/task sandbox. Do not reuse their mutation/terminal authority. |
| `admin/backend/src/lib/setup-engine/{infisical-agents,agent-network,openbao-agents}.js`, `routes/{infisical,openbao}.js`, `docs/features/agents.md` | Existing management APIs register per-name Infisical projects and OpenBao AppRoles with administrator/sudo/fresh-local-proof mutation. The free-edition Infisical project identity is Admin in its own project and can read its own secret; five-minute token requests do not prove active-token revocation. These are machine identities, not contributor-specific Operations credentials. Container `/32` linking and route rendering do not establish runtime isolation. A2 stores no values; A4 must review/prove new project credential intake and destination grants. |
| `admin/backend/src/lib/host-exec.js`, `docs/core/security-host-boundary.md`, `docs/core/security-remediation-2026-09.md` | Host RPC, Incus, setup and backend remain privileged. PR #674 accepted static inventory contracts for `agent-network.js` and evidence decoder; S6 remains open. A3 cannot expose these to a model. A8 needs deployment-target proof, or an isolated target independent of unsafe host authority. |
| `admin/backend/src/mock2/{project-assets,project-assets-logic,routes}.js` | Dev Studio reference documents are text-sniffed, capped at 2 MiB and tied to numeric Dev Studio project IDs; CSV may fit, PDF does not. This is not an Operations project folder or agent write grant. |
| `admin/frontend/demo/` | Standalone React/Node target for the selected pilot: landing page, modal password login, server-side demo session, signed-in workspace and guarded example CSV download. The website is deployed at `https://demo.fractionate.ai` in `fractionate-demo`, and public browser/ProxyPilot read-only checks were repeated 2026-09-25. It is not an Operations project, an agent runtime or real-key isolation proof. The deployed server/CSV/index/CSS/JS SHA-256 values match source/build bytes that were uncommitted at deployment time; the archive had no commit identity. |
| `admin/backend/src/lib/{s3,operational-evidence-files}.js`, `routes/backups.js`, `docs/features/operations.md` | S3 destination rows/client are for backups; Operations' private evidence root holds PNG/JPEG demonstration media under separate gates. Both offer implementation patterns, not a general PDF/CSV Operations artifact store. A document option needs a new project-scoped broker, record, ACL/prefix, quota, retention and readback contract. |
| `admin/backend/src/lib/setup-engine/vaultwarden-*.js`, `docs/features/guided-vaultwarden.md` | Current adapter installs/connects and verifies Vaultwarden SSO/configuration; it is not a personal-item secret-write API. Vault item encryption and personal versus organization ownership require a contributor-side or specifically authorized collection flow. The [credential backlog](fractionate-project-credentials-backlog.md) records a feasibility gate before claiming cascade. |
| `docs/features/model-routing.md`, existing connector/catalog code | OpenAI appears in Dev Studio routing, and provider keys use encrypted connector rows there. Those code paths are not an A4 agent provider adapter or spending/credential boundary. Initial agent provider selection and actual price/cap semantics require A4 validation. |
| `../FINISH.md`, both adjacent trackers, `fractionate-transition-review.md`, Operations/Demonstrations design and plans, D1–D4 reports and `commands.md` | B1–B4 and D1–D4 source was implemented and PR #674 merged with passing final-head checks. Their 127-test/build/browser evidence is historical; no A1 runtime test was run. The older lower tracker paragraphs still describe a pre-merge state and are superseded by their dated top entries. |

## Security and infrastructure findings mapped to this pilot

Webpage sign-in at `demo.fractionate.ai` with a public fixture account is the
selected first workflow. The separate React/Node demo under
`admin/frontend/demo/` has a protected CSV endpoint, but it is locally built
and is now deployed at that origin. Target-specific **agent-worker** isolation and credential
dependencies cannot be closed by the demo's source alone. A2–A8 owners below are the
minimum placement; revisit after selection and at each release gate.

| ID | Pilot decision and required proof | Placement / F7 boundary |
|---|---|---|
| SEC-01 / S6 | A model must not reach root-equivalent backend, Docker socket, Incus, host shell, evidence decoder or broader management roots. Prove target OS/process/network/filesystem isolation and enforcement independent of backend-writable flags. | A3 architecture/test; A8 on target. Broader platform privilege removal remains S6/F7 only if the selected pilot does not depend on unsafe host paths. |
| SEC-02 | Preserve inventory and required security CI; inspect exact new worker/broker host candidates, with reviewed typed contracts. | Every A2–A8 integration/merge and A8 final-head CI. No bypass; PR #674 pass is historical for its own head. |
| SEC-03 | Bound worker CPU/RSS/processes/time/disk, DB/event growth, private artifact ACLs, backup/restore and migration rollback; test real target and interruption. | A3 budgets, A5 durability, A8 target/restore. Estate-wide non-pilot host checks may remain F7 only after pilot-specific acceptance passes. |
| SEC-04 | Decide whether selected worker/credential route or the existing privileged LXC fleet requires VM cutover. The demo website LXC is known; the agent worker target is not selected. | If required, A3/A8 prerequisite. If not, non-pilot LXC-to-VM migration remains F7 with a documented network/host separation proof. |
| SEC-05 | Reinspect historical draft PR compatibility, migration numbers, restricted reader enforcement and delegated-key rotation before integrating any of its code or relying on it. No automatic merge of #671. | A2 current-user authorization; A4 credential/revocation; A8 exact-base integration. Unused estate PR work may remain F7, but no pilot dependency may be deferred. |
| INF-01 | Preserve Infisical administrator fresh sign-in and MFA/refusal/recovery. Do not let unattended worker use human administrator authority. | A4 design/negative tests, A8 real ceremony where used. Unused management automation remains F7. |
| INF-02 | Profile/run/worker/binding IDs must be distinct from `pp-agent-<name>` and Dev Studio project IDs. Enforce parent relationships and per-attempt attribution at every broker call. | A2 schema/auth; A3–A5 enforcement; A8 audit. |
| INF-03 | A proxy placeholder does not prove secret non-disclosure: an Admin identity can read its project. Verify dedicated scoped target account, proxy enforcement, network egress and no secret in model/logs/streams. | A4 on disposable target; A8 real-key proof before use. No real credential pilot if proof unavailable. |
| INF-04 | Display rename must not change stable ID; rotation must stop future use and test live token/session cancellation. Cancellation fences worker and broker separately. | A2 identity, A4 revocation, A7 recovery, A8 live acceptance. |

## Delivery dependencies and preserved deferral

1. **A1 → A2:** review the selected and live-verified synthetic demo sign-in target,
   [pilot contract](fractionate-agents-a1-pilot-contract.md), exact Operations
   project/final site and approved guide, run/credential-use authority, limits
   and takeover boundary. Review [owner project modes](fractionate-project-credentials-backlog.md)
   before A2 implements them.
   A2 remains profile metadata and guide assignment. Optional posting of a
   downloaded file to Operations needs a separate explicit pilot-scope decision
   and destination policy.
2. **A2 → A3:** stable IDs, project-scoped access and immutable assignment
   revision exist. Select a worker target with no management-plane privilege.
3. **A3 → A4:** isolated worker and broker enforcement are proven in a
   disposable environment before introducing credential references/provider keys.
4. **A4 → A5:** provider spending and credential revocation contracts are tested;
   A5 can then add a bounded synthetic loop and durable transitions.
5. **A5 → A6 → A7:** durable events/results precede supervision; supervision
   precedes takeover and crash/reconciliation exercises.
6. **A7 → A8:** exact-head CI, reviewed deployment target, backup/rollback,
   credential/isolation proof and separately authorized real pilot.

F1 still-import feasibility, F2 capture/modalities, F3 shared Knowledge, F4
richer critique, F5 concurrent agents, F6 broader Flightdeck/workflows and F7
non-pilot estate operations remain deferred. They are not prerequisites for a
single direct-guide pilot absent a concrete selection that proves otherwise.
The 8–12 focused-conversation estimate remains provisional: the open pilot
choice and S6/credential target findings could add integration sessions, but
they do not create an unreviewed ninth section.
