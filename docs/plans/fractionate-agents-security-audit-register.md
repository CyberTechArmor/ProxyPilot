# Agent platform: register for the later security audit

Opened 2026-09-29, at A6's acceptance. The user asked that these items be
"marked down for a security audit later".
- This register **does not close anything**: every item stays open until an
  audit gives fresh proof, and IDs from earlier documents are kept.
- Add to it; don't rewrite history.
- The dated evidence files stay the record. This page lists the items and
  says where the evidence is.

## Standing findings (from the plan's security map)

| ID | What | Placement | Evidence to start from |
|---|---|---|---|
| **S6** | The standard backend runs with **host-root-equivalent authority**. Stage A authorization fixes and transport hardening do not remove that | Open; A8 target verification | `docs/core/security-host-boundary.md`; `scripts/host-boundary-inventory.py` ("S6 remains open") |
| **SEC-01** | Host isolation / the privileged backend boundary | A1 design; A3 execution boundary (the proof VM, fence, origin proxy, supervisor); A8 target verification | A3 evidence and reference; the A3–A6 host runs |
| **SEC-02** | Required security CI / host inventory | Every merge and A8; no suppression or bypass | `.github/workflows/security-regression.yml`; the inventory |
| **SEC-03** | Real host, migration/rollback and disk growth | A3 resource and storage design; A8 deployment acceptance | A3 resource cases (cpu, memory, disk, tasks) |
| **SEC-04** | Privileged LXC-to-VM cutover | A1: needed only if the pilot requires it; A3/A8 prerequisite; estate migration is F7 | A1 evidence |
| **SEC-05** | Draft-PR compatibility, restricted readers and key rotation | A8 requires compatible integration | A1 evidence |
| **INF-01** | Admin authentication, unattended authority and recovery | A4 and A8; no MFA weakening | A4 evidence |
| **INF-02** | Project/profile/run/worker identity mapping | Enforced at A3–A5 | A5 pins and fences |
| **INF-03** | Key isolation, provider and proxy enforcement | A4; proven on the target before any real-key execution in A8 | A4 evidence (broker, origin proxy, canary) |
| **INF-04** | Stable identity, rotation and session cancellation | A2/A4/A7; prove actual revocation rather than promise immediate recall | A4 binding revocation (below) |

## Items added by A3–A6

| Item | State (2026-09-29) | For the audit |
|---|---|---|
| **The broker's AppRole secret ID** | Replacing it is **not an immediate stop**: tokens already issued stay valid up to 1 h. **Revoking a credential binding is the immediate stop** (next section) | Prove revocation, not rotation, as the kill switch (INF-04). Consider a shorter token TTL |
| **The origin proxy could resend the one sign-in POST** after an upstream timeout (A5 finding) | Fixed in code 2026-09-29 ("a request reaches the origin at most once"; regression test in `test_a4_origin_proxy_login.py`). **Installed and host-proven 2026-09-29** (A6 host run 2): both proxy copies `6c86bc36…`; proxy 21/21, A3 20/20, A4 6/6, A5 17/17, canaries clean. The at-most-once rule itself is proven by the local test (a host run cannot stall the demo on purpose) | Re-check the installed digest; consider a host fault-injection case |
| **Host reboot persistence** of the fence, proxy, supervisor, broker and proof VM | Never proven. `scripts/a6-reboot-check.py` (record/check) written 2026-09-29; **the reboot itself is pending the user's decision** | Run record, reboot, check, then the A3 worker proof |
| **The demo is reached through the router's hairpin NAT** (`192.168.88.1`) | Found in the timeout investigation (`fractionate-agents-open-landing-timeout.md`). Measured fast (under 10 ms); the timeout's cause was DNS | A pinned local address would be an exception to "public addresses only" in the proxy; review it if chosen |
| **The host resolves through public resolvers directly** (1.1.1.1, 9.9.9.9; no local cache; a plain `/etc/resolv.conf`; no IPv6 route) | About 1 in 100 A+AAAA lookups stalls for 1–4 s. The origin proxy now looks up at most once a minute (PR #705, deployed) | The origin proxy trusts these answers, filtered to public addresses. Review the resolver path (a local validating cache, or DNS over TLS) with the proxy's origin check |
| **The A6 widening: the supervisor's backend `view`** | Accepted 2026-09-29 (A3 case `backend_view`). Pixels only; running attempts only; no lease renewal; one frame a second; memory only | Keep the ratchets: no MCP reaches it, and frames are never stored |
| **The planned A7 widening: dashboard takeover and input** for run-access users (once-per-session TOTP or passkey) | Direction decided; not built | Review the backend path to `takeover` and `input`, its limits and its host proof |
| **Neko**, if A7 chooses it | Research only (`fractionate-agents-a7-neko-research.md`) | A new browser layer, WebRTC ports or TURN, member sessions and kiosk lock-down would each need review |
| **The dashboard toggles are on** (Operations, Agent metadata, Agent runs) | Execution is unavailable until A8 (no supervisor socket in the container) | Re-check before the A8 socket mount |
| **A dashboard terminal drop kills its commands** | Operational: long host proofs run detached (`setsid nohup`) | Keep long host steps detached or on SSH |
| **`nodemailer` < 10.0.2** (GHSA-6vj9-mwq6-2f5v, moderate) | Fixed 2026-09-29: 10.0.12, deployed (live `776045d7`; the running container reports 10.0.12) | Keep `npm audit` in CI |
| **Lighthouse mobile accessibility** | Done 2026-09-29: **100** on all six A6 pages (Operations and inbox, Agent runs, the run deck's Browser, Activity and Details, Agents) with `admin/frontend/tests/agent-runs-lighthouse.mjs` | Re-run after UI changes |

## How revoking a credential binding works (A4)

- **What a binding is.** A broker record (`scripts/a4-credential-broker.py`):
  - its UUIDs: binding, project and profile;
  - the site username;
  - the OpenBao path and version of the secret (never the value);
  - a revision and a state.
- **The command.** On the host, as root:
  `python3 a4-broker-operator.py revoke --binding <uuid>`. The record's state
  becomes `revoked`, and the broker's journal gets a `binding_revoked`
  event.
- **It is permanent.** There is no un-revoke; a new binding is made with
  `bind`.
- **Its effect is immediate, at the broker's next call.** Every lookup of a
  revoked binding is refused with `BINDING_REVOKED`, so the broker never
  reads or delivers the value again. Nothing waits for a token to expire.
- **A run pinned to it:**
  - ends `blocked / binding_changed` at its next credential step
    (`operational-run-coordinator.js` maps `BINDING_REVOKED` and the related
    codes to that result);
  - an open approval for its submit goes stale;
  - A5 proves both: `approval_after_revocation` and `binding_changed_mid_run`.
- **Contrast with the AppRole secret ID.** That is the broker's own login to
  OpenBao. Replacing it does not recall the tokens already issued (up to 1 h),
  so it is not the stop.
