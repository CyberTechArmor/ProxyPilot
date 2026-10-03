# Selected runtime update preservation

Scope: ProxyPilot and its browser runtime only. No Incus upgrade, application
updates, network expansion, provider configuration or acceptance enrollment.

## Evidence and change

The operator ran the bounded detached planning job on the actual host. Planning
returned exit 0 for PR730 `fcd0bd32fcdcb0ce9692b615a2d2998e6e540c43`, with
25 owned files (9 new, 10 changed, 6 unchanged), then restarted the original
dashboard container and verified `/api/health`. The supplied plan digest was
`ab80fb4af2c6774cd91496457135cbeb91e1d4be3b27c573047178b19ae89c2b`.
This is historical planning evidence, not an installation approval receipt or
proof of general-site execution. Fresh planning is required after source delivery
changes. Raw protected host inventories are not published in this record.

Ordinary Update previously rejected any selected-package transaction directory.
The new metadata-only preservation profile admits only a separately committed
package whose full installed code/unit pins equal the current delivered source
contract. It preserves current keys, configuration, proof bytes and business
history. Source changes affecting installed runtime code/units still require the
coordinated package workflow. Recognized completed package rollback may retain
its historical directory while returning to the positively identified legacy
profile. A fully rolled-back later upgrade preserves its prior expanded generation only when delivered source matches that generation. Partial installation is refused.

The package installation CLI, its interactive root review, immutable plan digest,
one-time expiry/consumption and separate apply/commit remain unchanged. Internal
read-only health/identity methods gain an explicit post-dashboard-start mode so
ordinary-update commit can observe legitimate new work without replay or ledger
restore. No external CLI flag enables that mode for package installation.

## Verification

- 27 existing package installation/recovery tests passed.
- 22 existing legacy update/preservation tests passed.
- 15 new selected preservation/serving-health tests passed with real temporary package files,
  keys, journals and metadata; service/VM/socket behavior remains simulated.
- Two existing tests initially could not bind temporary Unix sockets under the
  cloud sandbox. They passed with that local test capability enabled; no test
  was skipped or weakened.
- Source review added explicit retained-journal comparison, recognized only the
  certificate renewal pair, and completed-rollback recognition. Diff whitespace
  checks passed. Independent review and exact published-head CI remain pending.

## Deployment and remaining proof

Not merged or deployed at this checkpoint. The actual host remains on PR730;
the expanded package is not installed and no acceptance marker was produced.
Required next steps: exact-head review/CI, merge and ordinary deployment while
still on the legacy runtime, fresh controlled host plan and root review/apply/
commit, private storage/decoder and provider setup, actual public/authenticated/
authorized-internal tasks, live viewing/privacy and recovery proofs, followed by
a real ordinary update preserving the activated runtime. Source and fixture
tests do not certify those host outcomes. Phase 2 remains pending Phase 1.

## Independent review handoff

PR: https://github.com/CyberTechArmor/ProxyPilot/pull/731
Implementation candidate: `ecdce70f78cd81f2090591eccafb13bba04ef20c`.
Base and merge base: main `fcd0bd32fcdcb0ce9692b615a2d2998e6e540c43`.
Compare the current PR head to that base; subsequent documentation-only handoff
changes do not replace the implementation identity above. No dependency,
database schema, runtime protocol or unit content change is shipped.

Read the user's browser-runtime requirements, this package contract, the pinned
Mock2 1.14 guidance/CPR, `scripts/review-runtime-refresh.py`,
`scripts/selected-runtime-package.py`, `scripts/tests/test_selected_runtime_preservation.py`,
and the existing package/refresh tests. Check update.sh's preflight/apply/commit
and failure-recovery call order, the read-only package import after source
attestation, transaction routing, old/new pin selection after both rollback
kinds, certificate renewal, active work after restart, protected state and
metadata durability. Challenge the implementation; do not treat test fixtures as
real host acceptance. Inspect exact-head CI and reproduce concrete gaps. Report
findings without modifying application code. Independent review has not run in
this implementation context and must not be represented as complete.

The operational handoff must use a real root TTY independent of the dashboard
for interactive package review: the dashboard has to be stopped first. The
browser Host Shell cannot be assumed to survive that stop. Do not pipe a digest
into review, fabricate a TTY approval, or reuse the historical host plan after
source delivery changes. A fresh bounded plan, recorded exact container
recovery path and real root review precede installation. No acceptance marker
is created by this change.

## Independent review findings and corrections

A separate reviewer inspected implementation `ecdce70` / head `3a053857` with
shell and GitHub tools, without editing application code. Both CI workflows for
that head passed, but targeted reproductions found in-scope recovery failures:
certificate renewal during rebuild, host reboot, completed new ledger history,
and the updater's own absent-policy .env append could strand metadata recovery.
The review also identified the relevant pre-existing updater failure interaction:
restoring a pre-update database after newly admitted work can lose that work.

Corrections recognize only a freshly validated certificate/key/journal renewal,
allow reboot identity change for stopped/idle metadata rollback, retain completed
ledger history, and recognize only the exact updater-owned absent-policy suffix
whose removal matches the original private env pin. All other drift still
refuses. Update now arms a preservation guard before the first possible new DB
writer (including setup runner restart), so a late failure keeps current data
and reports incomplete recovery instead of restoring a stale backup. Existing
pre-start build-failure recovery remains. Test expectations were changed to
assert retained real SQLite rows, current layout and incomplete metadata after
post-start failure; no production test is weakened to certify activation.

These corrections require renewed independent review and current-head CI.
Actual general-browser installation/provider/acceptance remain incomplete.

A subsequent independent reproduction found A7's separate daily TURN certificate
sync could also strand preservation. The narrow correction validates only the
existing0640 TURN pair against system certificate trust, retained hostname,
expiry, matching private key, stable fixed service units and a final file-pin
readback. Every other A7 file stays exact. Tests use a real temporary CA, issued
certificate and private key with wrong-hostname/untrusted-chain/key-mismatch
and active-renewal refusals; service state is still simulated. There is no host
acceptance claim. Re-review and final published-head CI apply to this correction.

## Final candidate review

The independent reviewer rechecked all corrections and reported no remaining
substantive code findings. Nine focused recovery/refusal scenarios and the real
SQLite maintenance harness were independently checked; the final TURN pair
correction received a further two-test independent check using real OpenSSL.
Local final validation: 20 preservation/serving/TURN tests and 35 updater
maintenance/policy tests pass with no skips. Earlier unchanged package/legacy
checks remain valid. Final published-head CI is required before merge.

Reviewed production file SHA256 pins:
- `scripts/review-runtime-refresh.py`: `2a34d29fd0697c833d023b49e9c089e38c6bf194bb224a266d34ae3c77e3f69b`
- `scripts/selected-runtime-package.py`: `64d5908d144fea51bbe795ee1b5ee64e6d7da93fbdbfdf7e14087c9378096e53`
- `update.sh`: `42e36e9912c482502d44a8abc750118bcce354dec986cf0c0af3bf8e575697bd`

An actively running certificate sync can still cause an explicit safe refusal;
current service/data are retained and metadata recovery can revalidate after
the renewal settles. This is not installed acceptance. The user authorized the
independent reviewer and instructed continuation without another operator
terminal; the available connector still lacks the fixed host-root package
review/install operation, and no interactive-review bypass is introduced.
