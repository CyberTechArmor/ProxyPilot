# Setup engine requirements (gate two)

The platform-architecture review's ninth and tenth passes turned two
limitations that gate one (`docs/features/immediate-repairs.md`, PR #601)
acknowledges into requirements for the guided upgrade that follows it. This
page is the requirements record for that work. Nothing here is implemented
unless the section says so.

## What gate one provides today, and where it stops

| Provided (PR #601) | Limit |
| --- | --- |
| One exclusive lock per container (`mock2/container-lock.js`), taken by the deploy, `restore_project_db`, `restore_snapshot` and the retry path's secret mint; a restore is refused while a deploy holds it; checked server-side for every surface | In-process: it lives in the backend's memory and does not survive a backend restart |
| The deploy stops the app before the final probe and mint, restarts the unit on every failure after the stop, and reports whether the app is serving again | A backend restart mid-deploy leaves the app stopped until the next deploy or a manual start; nothing resumes or records the interrupted operation |
| The restart reports *restart attempted: serving / not serving / unknown* | It never reports *recovered*: the protected credential is not read back through the application |
| Deferred, refused and failed outcomes are reported in the project chat, the readiness lines and the tool reply | There is no saved operation with a state a browser can reopen |

Unrestricted administrator shells (`run_project_command`, `run_lxc_command`,
the workspace terminal, a root login) remain an operational boundary to
document, not something the engine coordinates.

## Requirements

### R1. One exclusive lock per app, persistent, for every platform operation

Deployment, restore (database and snapshot) and credential migration acquire
the **same** exclusive lock for the affected app. The check happens
server-side and applies to the dashboard, the CLI and MCP requests alike. The
job runner that does the work holds the lock for the operation's lifetime;
the request that submitted it does not. The lock survives a backend restart:
a held lock with a dead holder is a *recorded* condition, not a free lock.

### R2. Recovery does not wait for another deployment

An independent host runner executes the operation with **saved progress** and
enough recorded information to either finish it or recover a compatible
deployment. The browser and the ProxyPilot API submit work and observe it;
restarting either does not erase the operation. On start, the runner finds
any operation it left in flight and continues it or enters a recorded
recovery state — an app the previous run stopped is never left stopped
silently.

### R3. Acceptance criteria for the guided frontend

| Event | Expected behaviour |
| --- | --- |
| Browser closes | The operation continues; reopening shows its current state |
| ProxyPilot restarts while an app is stopped | The host runner continues, or enters a recorded recovery state the dashboard shows |
| Restore requested during a deployment | The server rejects or queues it **before** making any change |
| New application fails to start | The runner attempts the applicable recovery procedure and **verifies** the result |
| Recovery cannot complete | The dashboard reports the app as unavailable and shows the recovery procedure |

### R4. Distinct states

*Restart attempted* and *application recovered* are different states and are
never conflated. Recovery is marked successful only after the service is
healthy **and** the protected credential is readable through the application
(the LDAPS settings report `masterKey` current with the inventory complete,
or the equivalent for the component in question). Failed, deferred and
recovery states are meaningful, saved, and shown.

### R5. Probe hygiene carried forward

The data probe's two host checks from the tenth review are closed in gate one
and stay requirements for the engine's own probes: connect as the app's role
and check row-level security before trusting an empty result; pass the
password through a protected temporary password file, never argv or the
process environment.

## Deliverables, in order

1. **Non-destructive root recovery command** that preserves data and
   encryption keys, tested independently of the dashboard (replaces the
   destructive `reset.sh` path recorded in `docs/known-issues.md`).
   **Implemented** (`proxypilot recover`, `docs/features/root-recovery.md`);
   host acceptance outstanding. Progress ledger:
   `docs/core/setup-engine-ledger.md`.
2. **Independent host runner**, with the planned privilege separation: the
   runner, not the privileged backend container, is what executes host
   operations.
3. **Persistent setup engine and shared locks that survive backend
   restarts** (R1, R2, R4): saved operations, resumption or recorded recovery
   on start.
4. **Setup APIs and the frontend wizard** (R3, R4): progress, deferred
   actions, retries and recovery states. Server-side state only: the browser
   never declares an installation fresh or an operation complete.
5. **Service adapters and identity integration** (Keycloak linking, step-up,
   with activation gated on a successful login and the recovery checks),
   followed by **app provisioning automation** (registry, shared
   integrations, coordinated lifecycle).

The persistent runner (2–3) is the main development focus once gate one's
last check is resolved; the real-host acceptance work for gate one runs
separately from these code milestones.

## Status

Requirements recorded 2026-09-21. Gate one's production rollout stays pending
the real-host evidence listed in `docs/features/immediate-repairs.md`
("Acceptance record"); its acknowledged queue and restore limitations are the
first two requirements above.
