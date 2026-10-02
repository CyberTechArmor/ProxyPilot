# Public website review: bounded activation decision

Implemented and fixture-tested in the repository, 2026-10-02, following Thomas's
explicit approval of the bounded refresh. No host action, new credential or live
provider call was performed. Publication/deployment follow the separate release
authorization; Thomas updates production through ProxyPilot.

## Decision

Implement a **code-only runtime refresh in the
existing ProxyPilot Update path**, limited to an already configured A8/A3/A4
installation. It must preserve the existing receipt identity, AppRole/provider
credentials, bindings, prices and ledgers, replace only the two reviewed installed
daemon files and their installation digest records, restart those two existing
services and support paired rollback. After code review and tests, publication /
deployment is a separate decision; Thomas then uses ProxyPilot's normal Update
flow. No manual SSH, host shell or new persistent grant is needed for that path.

This is the smallest missing implementation for Thomas's main-pull workflow.
The currently available `reinstall` commands are not the selected activation path.

## Why a pull alone cannot activate it

`update.sh` updates the checkout/install tree and dashboard. It calls A8 `patch`
but never calls the A3 or A4 installers. Their systemd units execute private
installed copies under `/etc`, not the new files under `/opt/proxypilot/scripts`.
Consequently a dashboard-only update can show the new website UI while the old
supervisor/broker cannot accept its typed model method; readiness must remain
blocked. Modifying journal hashes alone would not install or verify new code.

## Key and credential answer

**Key rotation is not required for this code update.** A3 already signs with a
host-held Ed25519 key; the public key ID is independent of the daemon's source
digest. Updating the source and its verified installation journal can retain
the exact private/public bytes and the same VM/key identity.

Current A3 `reinstall` does `remove` then `install`: it archives the old public
key, deletes the private/public key files, runs `openssl genpkey` and installs a
new key. That path requires A8 `configure` to copy the new public key; A8 `patch`
only checks equality and refuses the stale copy. **Do not use that rotation path
under the no-new-secrets constraint.** A key-preserving code-refresh action does
now exist in `scripts/review-runtime-refresh.py`, with key-preservation tests.

For the proposed refresh, A8 retains `/etc/proxypilot-a8/supervisor-pub.pem`, the
same three socket/key/VM settings and the same read-only mount block. No A8 pin
rewrite is necessary when the key bytes are unchanged. Verify equality before
and after. A missing or stale pin is a refusal, not permission to reconfigure.

Current A4 `reinstall` preserves its AppRole configuration across remove/install,
but temporarily deletes and recreates it. The narrower refresh should leave
`/etc/proxypilot-a4/broker-config.json` untouched. No configure, provider-bind,
price change, credential-bind, vault-write or new website connection is needed.
After restart, the broker may authenticate using the same existing AppRole and
retrieve the same existing provider secret/version; it enrolls no new credential.

## Exact scope and sequence to implement

| Item | Required change |
| --- | --- |
| `/etc/proxypilot-a3-proof/supervisor/a3-worker-supervisor.py` | Install the reviewed public-review methods, validation and signed receipt implementation |
| `/var/lib/proxypilot-a3-proof/supervisor-install.json` | Record that file's verified new digest; preserve version-1 VM/key/public-key and all other file pins |
| `/etc/proxypilot-a4/broker/a4-credential-broker.py` | Install the credential-free `review_call` and existing-ledger accounting / call-ID fence |
| `/var/lib/proxypilot-a4/broker-install.json` | Record that file's verified new digest; preserve existing identity and other file pins |
| Existing A3/A4 systemd services | Bounded stop/restart and readback; no unit, timer, permission or service-user change |
| Dashboard backend/frontend and migration 1116 | The existing normal updater installs these; no automatic start or consent migration |

The paired checkout helper `scripts/review-runtime-refresh.py` is invoked by
`update.sh` through `preflight`, `apply`, `rollback` and `commit`. It reuses existing
installer verification/atomic-write functions; individual installers gain no
independently callable refresh or enrollment action. It uses journal versions and
fixed file paths, with the approved checkout SHA and candidate digests recorded
in the refresh receipt. Refuse other changed A3 package files or unit layout
instead of silently expanding this two-file refresh.

1. The existing root update runner accepts Thomas's normal Update request and
   holds its existing update lock. Build/preflight checks happen before outage.
   The helper is a no-op for installations that have not already opted into A8;
   it never performs first installation, opt-in or credential enrollment.
2. Verify both current installed journals, file digests, root custody, existing
   unit definitions, exact VM identity, healthy A8 pins and matching private /
   public receipt key. Compile the candidates and verify their fixed source paths.
   Keep sensitive comparisons private; report public key ID and code digests only.
3. Require no live Demo worker or review/provider call. Thomas explicitly finishes
   or cancels active work; busy or unverifiable state refuses the refresh. Do not
   force-stop a run to make this pass. Unknown/uncertain ledger reservations remain
   retained and are not interpreted as an active call or refunded.
4. After the ordinary updater confirms the dashboard backend is stopped and its
   existing recovery guard is armed, recheck that work is quiescent. This closes
   the dashboard Start race. Stage byte-exact old code/digest journals and service
   state in a root-private update transaction backup. Do not copy, delete, rewrite
   or print receipt keys or AppRole/provider secrets.
5. Stop the two existing daemons, replace only the two allowlisted source files
   and their installation digest records, then start A4 followed by A3. Check
   both serving digests, unchanged key ID / A8 equality and metadata-only
   `public_review_status` with the existing provider/price requirement. No model
   call or synthetic browser pilot is part of activation verification.
6. Continue the normal dashboard update/start/health check. Failure at any stage
   restores the prior two daemon files/digest journals and serving state as part
   of the updater's recovery path. A failed restore reports a blocked update; it
   cannot claim the runtime is ready. Provider and supervisor runtime ledgers are
   retained, never replaced with pre-update copies or replayed.

## Existing Demo impact and rollback

There is a short A3/A4 service interruption inside the normal dashboard update
outage. Existing Demo sign-in capability, VM UUID, receipt identity, fence, proxy,
Neko/coturn setup, credential binding IDs/versions, provider route/price table and
write/control approvals stay unchanged. The original synthetic methods and their
allowlists remain enforced. No worker, VM, network, firewall, Incus profile or
new mount is created or altered by the refresh. An active run blocks the refresh.

Past receipts remain verifiable with the same public key. Paired rollback restores
the old installed code and digest records with that same identity and credentials.
The old runtime then lacks public-review support, so website readiness is blocked;
Demo behavior remains available after the existing checks pass. Rollback cannot
undo a provider charge or erase its ledger; no run is retried automatically.

## Required repository proof before requesting publication

- Installer fixtures prove exact key/config bytes and modes stay unchanged,
  candidate-source/digest/identity refusal, busy-state refusal, idempotence and
  paired restoration after each replacement/restart/readback failure.
- Updater fixtures prove no-op when not already opted in, fixed-path invocation
  only after the backend is confirmed stopped, health-failure rollback and no
  success before both installed components/A8 pins pass. No request-flag, MCP
  action or persistent permission expansion is needed.
- Re-run the existing A3/A4/A7/A8 installer/runtime regressions, receipt tests,
  Operations aggregate and UI integrated journeys on one frozen release head.
- No host rehearsal or live model invocation is implied by repository tests.

## Release convergence checkpoint

The refresh fixtures now cover all four replacements, stop/start/readback failures,
byte-exact paired restoration, a real Ed25519 key pair and A8 pin, unchanged AppRole
configuration and permissions, repeated unchanged refresh without a service restart,
active DB Start/Demo/provider work, uncertain reservation retention, unknown state,
tampered transaction paths/modes/digests and foreign configuration/ledger drift.
Root WSL updater/self-update tests pass 81/81 with zero skips. Full Python selection
passed 307 tests with 33 environment skips before the final CLI no-op regression
was added; final converged results are recorded in the evidence tracker.

Only old code and installation journals are backed up, never keys/config/ledgers.
Commit allows legitimate new ledger updates after dashboard startup. A later
failure with new active work or ledger drift refuses rollback instead of force
cancelling work, overwriting accounting or replaying a call. Recovery remains
blocked and reports that refusal. CI runs updater tests in its existing root
container and the Python suite in its broker job; no host opt-in is added.

The parent-provided UI head `f1e6f6d9` still contained the older checkpoint runtime.
The UI owner subsequently incorporated implementation `9e02012f` as `68c74201`,
baseline evidence `5e01957c` as `def2e51e`, and UI/runtime evidence `fb5d4bb3` as
`70ab72f2619c2b06dfb6187cbe6f3b4381ec28d4` on
`ui/website-review-integration-20261002`. At that head, Git blobs exactly match
the runtime branch for public extraction, review service/bridge, supervisor
client, Operations routes, both Python daemons and critical receipt/Python tests.

Preserve the UI owner's dashboard/navigation work and its source-specific browser
evidence (`eb46eef7`: three journeys, nine layouts). Runtime evidence is Operations
197/197, Python 293 tests / 33 environment skips, and the four real UI/runtime
fixture journeys. These predate activation-helper implementation. Run the agreed
checks again on the frozen converged release head; do not treat a fixture journey
as live installed-provider proof.
