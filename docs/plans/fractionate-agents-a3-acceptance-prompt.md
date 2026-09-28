# Next section prompt: A3 target proof and acceptance

Do not execute merely by reading this file. This is the bounded next section
after the 2026-09-28 supervisor implementation. It closes A3 only on observed
evidence from the proof VM. It does **not** start A4: the
[A4 prompt](fractionate-agents-a4-prompt.md) becomes eligible only after this
section records A3 as accepted.

Start from the [A3 reference](fractionate-agents-a3-reference.md). It has the
exact revisions, target identity, component map, interfaces, commands, rollback
order and rules. Then read the last two dated sections of the
[A3 evidence](fractionate-agents-a3-evidence.md), `CLAUDE.md` and the
[host boundary](../core/security-host-boundary.md). Historical prompts and the
[archived handoff](fractionate-agents-a3-claude-handoff.md) are background.
Later dated evidence supersedes them.

## Goal

Install the host-owned supervisor on the proof host. Run the full target proof
against it, fix any real failure with a reviewed change, and derive the worker
minimum and VM sizing from measurements. Then decide A3 acceptance against the
explicit criteria below. A3 is accepted only if every required criterion has
observed, reviewed evidence. Otherwise it stays open, the open gates are named,
and A4 stays blocked.

## Preserve

- Branch `claude/step-a3-isolated-execution-yg80mx` (code `3cd80b70`; later
  commits are docs). If a different branch is designated, carry the work there
  through a reviewable integration. Never rewrite pushed history.
- PR #686 stays draft and unmerged. Do not open, merge or mark ready any PR
  unless the user asks. Exact-head Security CI needs a PR, so ask the user once
  whether to open a draft PR for the branch.
- A2/A3/Operations activation stays off. No provider, model call, credential,
  vault, live identity or deployment. `pp-nodus` and `nodus.fractionate.ai`
  are untouchable. Never use `--upgrade-incus` or an Incus archive, and never
  bypass managed-LXC refusals.
- Migrations 1100–1109 and all immutable run, attempt and event history. The
  Windows workspace's uncommitted work and the untracked
  `scripts/tests/a3-vm-probe.zip`.
- The pre-network snapshot `pp-mcp-pre-network-20260927-222658`.

## Steps

1. **Reconcile.**
   - Read `get_self_status`, `inspect_a3_vm agents-a3-debian13-proof-20260927` and
     `get_host_services filter=a3`, the branch and PR #686 state, and GitHub `main`.
   - Record SHAs, VM UUID, boot ID, QEMU PID, shape, NIC and unit states.
   - Compare with the reference and state every difference. If `main` or the
     candidate moved, re-plan the staging command and simulate it before giving it
     to the user.
2. **Stage and check the candidate.**
   - If the user has not already done so, give them the reference's one host
     command. It fetches the branch, checks that the pinned code commit is an
     ancestor, cherry-picks exactly `12ad1392..3cd80b70`, installs and runs the
     proof.
   - Then run `run_self_checks` with `backend-tests` and `frontend-build` on the
     exact candidate head. Record the totals, failures and skips. Never skip a
     database test; if the install drops the native binding, the candidate's
     `prepare-self-check-native.mjs` step must restore it.
   - Do not upload repository content from a cloud session to the host; the
     exfiltration guard refuses it.
3. **Review the install output.**
   - Expect `"installed": true`, the key ID, `"accepting_launch": true` and no
     blockers.
   - A failure is rolled back automatically (journal phase `rolled_back`). Read
     the refusal and fix the cause; never force.
4. **Review the proof output case by case.**
   - The 18 cases: `sessions`, `human_takeover`, `origin_refusals`, `escape`,
     `guest_root_egress`, `cpu`, `memory`, `tasks`, `disk`, `runtime`, `actions`,
     `descendant`, `lease_expiry`, `stale_fence`, `launch_failure`,
     `backend_refusals`, `supervisor_crash`, `guest_crash`.
   - Ask the user for the full report JSON path under
     `/var/lib/proxypilot-a3-proof/proof/` when a summary line is not enough.
   - Corroborate independently where possible: `inspect_a3_vm` for the boot
     change after `guest_crash`, `get_host_services` for supervisor restarts, and
     `run_lxc_command` read-only checks.
5. **Fix real failures, never the gate.**
   - For each failed case, diagnose from the report, the attempt journal
     (`a3-worker-operator.py journal`), the unit journal and the launch diagnostic.
   - Change code with a test that reproduces the failure locally where possible,
     rerun the local suites, and push.
   - Give the user one command that stages the new exact commit, runs
     `a3-install-supervisor.py reinstall` and reruns only the affected cases
     (`--only …`), then the full proof once more at the end.
   - Never broaden sandbox properties, the socket methods, the proxy policy or the
     fence to make a case pass. If the Chromium sandbox or a unit property proves
     incompatible, record the exact error and choose the narrowest reviewed
     alternative, for example `DynamicUser` or a different tmpfs layout.
6. **Sizing.**
   - From the three `sessions` measurements, record:
     - unit `memory.peak` and `pids.peak`;
     - host QEMU tree RSS (idle and during the session);
     - guest MemAvailable and pressure;
     - root free space, `/var/log` and apt cache;
     - browser start and action latency.
   - Confirm or change the provisional worker minimums (CPU 1, 1024 MiB, 64 MiB)
     with headroom for a browser restart. Change them in the supervisor,
     `operational-worker-boundary.js` and `AccessPolicy.jsx` together.
   - Resize the VM only in the failing dimension, only after recording the
     evidence, and through supported MCP with a snapshot first.
7. **Human control by a real person.**
   - Ask the user to open the `human` page (SSH local forward) on a running
     attempt, take over, and click and type on the synthetic page.
   - Record what they saw and the receipt. The automated `human_takeover` case
     does not substitute for this.
8. **Host restart.**
   - Only with the user's explicit approval and a chosen window, reboot the host.
   - Then verify:
     - the fence → proxy → supervisor start order and the dependency readback;
     - the VM stays stopped (autostart false);
     - recovery issued receipts for any attempt that was live;
     - a fresh launch works after the VM is started through MCP.
   - Without approval, leave this gate explicitly open.
9. **Proxy certificate.** If the proxy certificate has under two days left,
   plan its re-issue with the user (proxy `remove`, then `install`, then
   `a3-probe-proxy.py`) before any proof run.
10. **Security CI.** If the user opens a draft PR, run and record the
    exact-head Security regression and storage workflows. Treat red CI as work,
    and keep the PR draft.
11. **Record and decide.**
    - Append a dated section to the A3 evidence with:
      - exact revisions and user commands;
      - output excerpts and every failure and its fix;
      - measurements and sizing decisions;
      - the acceptance decision and the remaining open items.
    - Update the reference page, the plan's A3 row and status note, and the
      `CLAUDE.md` A3 bullet if interfaces changed.

## Acceptance criteria

A3 is accepted only if all of these have observed, reviewed evidence on the
proof VM with the installed production supervisor:

- Approved-origin browser session (landing, dialog, session readback,
  workspace) in three measured cold starts.
- Negative cases:
  - page-level cross-origin, raw-IP, alternate-port, plain-HTTP, login
    submission, unlisted-path, WebSocket and cross-origin subresource attempts;
  - in-unit host, management, routed IPv4/IPv6, DNS, loopback, raw, packet and
    vsock network refusals;
  - forbidden files, sockets and devices;
  - read-only system paths, no capabilities and `NoNewPrivs`;
  - guest-root fence drops with counter deltas.
- Forced overruns against the production launcher: CPU throttling at the
  configured quota, OOM kill at the configured memory, the task limit, ENOSPC at
  the temporary-disk limit, termination at the pinned deadline, the action limit
  across attempts, and a detached descendant killed at stop.
- Lifecycle:
  - cancellation, lease expiry, stale fence and launch failure;
  - supervisor crash between reservation and delivery, with the action
    `uncertain` and not replayed;
  - guest crash with a new boot and verified teardown, and relaunch bound to the
    new boot.
  - Every receipt verifies, and no attempt revives.
- Backend-socket refusals of operator-only methods, proof workloads, extra
  fields, other origins, below-minimum limits and credential submission.
- Human takeover: the automated path passes, and a real person has used the page.
- Measured worker minimum and VM sizing recorded, with headroom stated.
- Local suites, the host-boundary inventory without suppression, and the
  candidate `backend-tests` pass on the exact heads. Security CI passes if a PR
  was authorized, otherwise it is recorded as open.

The host reboot proof, backend socket mount and coordinator wiring (A5), and
S6/SEC-01/SEC-04 may remain open only if named explicitly. Accepting A3 does
not authorize A4 activation, deployment or promotion of the candidate to live.
Promotion is a separate user decision.

## Stop

Stop after the evidence update and acceptance decision. If accepted, point to
the [A4 prompt](fractionate-agents-a4-prompt.md) and stop for review before
any A4 work. If not accepted, write the smallest next A3 prompt that names the
failed or open gates.
