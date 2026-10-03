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
