# Configured broker integration evidence — 2026-10-01

Current branch: `codex/broker-production-integration`, built on preserved local
checkpoint `4f27d44a` and baseline `06e2c354`. No push, remote CI, deployment,
real credential enrollment, live consumer migration or A8 acceptance occurred.
The portable final review package records its exact commit, tree, patch digest
and freshly generated visual report source commits. Earlier checkpoint reports
below are historical; they are not evidence for later layout changes.

## Final resumed implementation and verification

The final implementation adds the concrete local SQLite/Keycloak authority source,
operator ceilings with explicit task-use permission, current guide/configuration/
environment/output checks, durable single-use proposals (migration1115), registered
worker execution, worker backup/restore and bounded migration/cutover adapters.
The local source explicitly trusts the backend/host; signatures do not resolve
S6/SEC-01. Real Keycloak deployment compatibility remains unverified.

- Broker suite: **84/84 passed** at `4a5013dd`; service source is unchanged in
  the final browser snapshot `6b41af1d`.
- Backend/Operations: **190/190 passed** at `4a5013dd`; backend source is unchanged
  in that final snapshot.
- Original OpenBao and migration integration: **2/2 passed**; migration dry run:
  **5/5 passed**. Migration uses a disposable OpenBao source and concrete broker
  rotation/typed-consumer cutover. An Infisical/MFA adapter is not implemented.
- Full security selection repeated at `4a5013dd`: **305/313 passed**, with the
  same five root-custody and three MCP filesystem-mode failures as baseline.
  No cases omitted or assertions weakened. Isolated root-owned CI is configured,
  but remote CI has not run.
- Build passed. Final setup browser: **10 journeys /18 layouts**, task browser:
  **7 journeys /6 layouts**, four Lighthouse accessibility scores **100**.
- Connected saved-agent browser: **4 journeys passed**, using actual Operations
  routes, file-backed state, source daemon, signed publication, mTLS worker,
  real OpenBao and TLS upstream. Read completed; write produced exactly one
  effect only after broker human approval; stale configuration was refused.
  Dashboard login/fresh-proof and Keycloak protocol identities are explicit
  disposable fixtures, not production identity compatibility evidence.
- Legacy A6: **19 journeys /96 layouts**; A7: **6 journeys /42 layouts** passed.
  A6 exposed an eager registration request while the broker was unavailable;
  lazy compatible-setup loading fixes it without suppressing the check.
- Main/task/connected reports and153 screenshots are captured at `6b41af1d`.
  Build/A6 began at `5039c05e`; the intervening change only waits for asynchronous
  metadata in the connected browser test. Both have frontend tree
  `b9a437c429df2daf76f51c816ebdfffe4182ecaf`. Reports retain original provenance.

The final review package records the delivery commit/tree, exact source hashes,
patch application check and visual manifests. Its public candidate contains the
same tree with clean history; the private development history is not for pushing.

## Earlier configured implementation checkpoint

- Runtime service/core: `3f4e8436`, `a1e2995c`; strict file configuration and
  separate TLS roles, direct human intake/approval, independent OIDC and signed
  authority, vault/registered-worker availability gates.
- Authority: final readiness/revision-pinning contract `69b1f7d7`. Signed current
  guide/check/environment revisions and explicit execution approval are required;
  old sessions cannot revive after disable/re-enable or policy narrowing/restoring.
- Worker: durable typed state, exact authoritative session attribution,
  independent readiness, mTLS transport, possible-send uncertainty and no retry.
  CLI smoke proves startup, readiness-only heartbeat and clean shutdown.
- Dashboard bridge/dispatcher: `32a6793a`; actual TLS configuration, transient
  identity delegation, migration1114, exact task/configuration/epoch receipts,
  explicit typed operator start/approval continuation/cancel. Draft saving starts
  no task and cannot manufacture independently signed readiness.
- Recovery: `d38f8d37`; authenticated encrypted stopped-state archives, strict
  custody/files/pins, no overwrite, interrupted restore lockout, fresh boot-bound
  authority and exact current policy reaffirmation. No production restore claimed.
- Real configured vertical: `c0e6dbc6`; actual signed HTTPS OIDC, independently
  signed Ed25519 updates, mTLS roles, OpenBao2.6.2 restricted AppRoles/KV, TLS
  upstream and worker. **No service dependency injection.** Read, direct-human
  exact write approval, task cancellation, expired feed and revocation tested.
  Tested canary/bearer sinks: returned projections and service database files.
- Earlier full broker selection: **64 passed**, including real configured proof,
  identity, authority, recovery, worker/runtime and hostile transport. Additional
  original real OpenBao proof: **1 passed**. Dashboard/Operations selection:
  **185 passed**, including the real bridge and staged packaged-client proofs.
  Final rerun counts/logs are included in the delivery summary.
- Independent reviewer reran31 authority/recovery/worker tests; all passed and
  reported no remaining concrete authorization/replay defect in reviewed changes.
  A100ms TLS fixture timeout was isolated to its intentional deadline case;
  normal transport tests now permit a2s handshake budget.

## Visual evidence and limits

A separate visual review compared the supplied original image pixels with revised
Office screenshots. Requested corrections now include project/detail balance, visible
workspace heading, compact numbered progression, outlined scope cards with
explicit Edit scope, complete centered modal/footer and separated legacy setup.
The cloud executor did not retrieve original pixels and claims no pixel/font match.
Midnight/Latte/Office preserve shared geometry and remain the only theme choices.

Final visual reports record generated time and actual source commit. They include
three-theme desktop/mobile setup, Work/Controls/Review, scope summary/edit,
shared catalogue/lifecycle, modal/footer and explicit operator task panels.
The task UI fixture labels itself synthetic and does not prove server enforcement;
the separate configured real OpenBao proof supplies that evidence. Earlier
reports bundled in intermediate checkpoints are historical, not fresh validation.

## Activation and remaining decisions

Choose exact broker/vault privilege domain, real IdP subject mapping/freshness,
accepted authority-source trust and key administration, intake origin, certificate/key
custody, retention/off-host backup and first real service/resource permissions.
A same-host VM does not protect against the root-equivalent backend/hypervisor.
The shipped adapter is the synthetic ledger; GitHub Issues read-only on a disposable
repository is a proposed next real adapter, not an implemented/approved live pilot.

Required release CI has not run remotely. The full current security selection and
all eight baseline failures are recorded above. The earlier40-test subset did not
resolve the three omitted mode cases. Deferred A8 host/runner/readback/recovery
evidence remains separate and is not counted as passed. No source secrets or reusable secret hashes
are included in review artifacts; fixture private state is destroyed on cleanup.

---

# Historical synthetic checkpoint evidence — 2026-10-01

Baseline `06e2c354bdd1c9dae2203e5447e14dbb84d4a3b8` (PR716), tree
`40b552baf5e52f2c94c2f0ee9c04b60c611dc213`. Local integration branch
`codex/openbao-broker-integration`; no push or remote CI execution.

## Reviewed components

- Contract/B0: `c00daff0`; metadata dry-run: `60202b0e`.
- Dashboard backend: `7e46fa40`, `cd29deac`, `b6dca3dc`; synthetic composition
  `20a9fee7`; projection hardening `2538de3c`; Controls authority `1ed53fea`.
- Broker: integrated `71e72be5`, original service review `e3d488fa`.
- Core UI: integrated `73d55c38`, original review `c565f304`.
- Final integration/browser/theme/documentation commits follow these; use final
  delivery HEAD, not the historical B0 status, for the complete local result.

## Executed evidence

| Check | Result and boundary |
| --- | --- |
| Broker unit/security tests | 27 passed: policy intersections, expiry/revisions, revocation races, CAS/recovery, intake CSRF/no replay, TLS/DNS/redirect/size/time restrictions, finite-schema echo refusal, SIGKILL and restored-policy quarantine. Mocked policy tests explicitly supplemental. |
| Real OpenBao integration | 1 passed against 2.6.2 pinned digest below; exact-path AppRole ACL, denied provisioning/other credential/agent bearer, CAS conflict, stale vault version, rotation/revoke, canary sinks, one uncertain write without resend. |
| Real TLS consumer demonstration | Read plus exactly one fresh-approved synthetic write passed. |
| Connected browser | Actual Express/Operations SQLite + separate HTTPS intake + real OpenBao + TLS upstream: enroll, safe test, create disabled agent, assign, consume, view operation activity, rotate, deny stale session, consume with fresh session, unassign and revoke passed. No browser API mocking; independent identity is a synthetic fixture. |
| Dashboard/Operations regression | 174 passed before final Controls harness addition. Follow-up broker suite 11 passed, including new current Controls/revision test. |
| Metadata-only migration | 5 passed; values/tokens/hashes and unknown fields refused, bounded input, unsupported mappings explicit. No secret transfer performed. |
| Shared platform/network compatibility | 54 passed: Pomerium/platform, selected-agent network, evidence decoder. |
| Python regression | 272 total, 239 passed, 33 skipped, no failures. Skips are not evidence of completed host/A8 proofs. |
| Dependency audits | Backend/frontend/CLI/framework seed:0 reported vulnerabilities. Lockfiles unchanged. |
| Host-boundary inventory | 97 candidate backend files inventoried; S6 remains open. |
| Independent review | Reviewed broker e3d488fa, backend a1c98d1a, core UI c565f304; independently28 broker tests including real OpenBao and 8 HTTP/backend tests passed. Later Controls and theme changes have their own tests. |

OpenBao image:
`openbao/openbao:2.6.2@sha256:11fd73a2102cda9c55d5d881a8c3210303146a7ec1e8ac76f526e175c6d24641`.
Node24.19.0; Chromium `/usr/bin/chromium`; Docker28.4. Fixture configuration is
source-controlled under `services/credential-broker/fixtures/disposable.mjs`;
TLS keys, canaries, human proofs and resource IDs are generated per run and removed
on cleanup. No reproducible credential values or reusable secret hashes recorded.

## Broader check limitations and corrections

The broad authentication/security selection ran 313 tests: 305 passed, 8 failed.
All 8 failures reproduced in detached baseline 06e2c354: five bootstrap tests require
root-owned disposable directories (cloud user UID1000, sudo unavailable); three
unchanged MCP staged-write mode tests received0700 instead of expected preserved
mode in this filesystem. Baseline comparison ran 170 tests, 162 passed, the same 8
failed. These are unresolved CI/environment gates, not silently suppressed passes.

Legacy A6/A7 browser checks initially failed because the new UI collapsed existing
synthetic-agent controls. The fix keeps that section open; final rerun results are
recorded below. Initial browser executable configuration was corrected to the
installed Chromium without changing tests' assertions.

Local logs are under `/workspace/scratch/broker-*.log`; UI screenshots/report are
under `/tmp/broker-ui-artifacts`. They contain synthetic fixtures, not live keys.
Original mockup and palette Library image reads returned extracted text but no
pixels; exact original visual comparison remains unavailable. The implementation
uses the supplied hierarchy and palette descriptions, without pixel-match claims.

No production host/version/deployment was inspected or changed. No real credential,
consumer cutover, legacy revocation, live pilot or A8 acceptance is established.

Source configuration SHA-256 (not secret-value hashes):
- Contract v1: `a2f4230aba055863ef4bf507aef242786914afa1e6e4490a8cc6989cd3abf305`.
- Disposable fixture: `5a6beacb0e24bb5ecb677e0d422fdc67fb4364ba10de540883367995e335c8e2`.
- Branding/PWA regression:35 passed before theme integration; rerun on final
  palette commit below. Disposable broker containers removed after proofs.

## Final integrated checks

- Backend/Operations/Controls/readiness plus branding/PWA: **213 passed**.
  Readiness follows owner assignment → rotation → re-test → revocation; shared
  permission ceilings not fully available in projections remain unverified.
- Connected OpenBao browser journey rerun after readiness and theme integration:
  **passed**, including rotation and stale-session denial.
- Production frontend build: **passed** (existing large-chunk advisory remains).
- Themes integrated at `dd1c24ce` (reviewed source `536d9872`): exactly three
  persisted keyboard-selectable palettes; legacy defaults retained; three unit
  tests, ten fixture journeys,18 theme/width combinations and four Lighthouse
  snapshots (all100) passed. Root visually inspected mobile dialogs in all three
  palettes; shared layout and branding retained. Body/helper/action contrast
  minimum 4.95:1. Exact original image pixel comparison remains unavailable.

Legacy A7/A8 dashboard regression after preserving visible controls: **6/6
journeys and 42 layout checks passed** (fixture supervisor/WebRTC as documented
by that suite; not a fresh host pilot). The root inspection of theme screenshots
confirms the same dialog structure and typography across all three palettes.

Final scoped color-role review (`7ed0235b`): four unit tests, ten fixture journeys,
18 theme/width combinations and accessibility snapshots passed. Broker inputs and
errors use semantic roles referencing existing Midnight colors, with no change
to the original dark tokens. Functional contrast (focus/input/status/error):
Midnight 5.28/9.77/11.21/16.63; Latte 5.72/3.24/10.45/6.55;
Office 6.46/3.70/17.43/4.59. Decorative card borders are measured separately and
are not counted as functional controls. Original legacy controls outside this
scope are not certified by these checks. Evidence is
`/tmp/broker-ui-role-contrast-artifacts/broker-ui-report.json`.

The legacy A6 toggle test's expected heading was updated from “New operation” to
“New project” to match the requested setup design; authorization assertions are
unchanged. The new Add person disabled control now has an explicit accessible
explanation. These were test-discovered UI/label corrections, not removed checks.

Final A6 regression: **19/19 journeys and 96 layout checks passed** after the
intentional project-heading assertion update. A7/A8: **6/6 journeys and 42
layout checks passed**. These preserve the existing supervised synthetic paths;
they do not replace deferred host proofs or constitute A8 acceptance.

Final color-role changes integrated as `807141ec`; four theme tests pass on the
integration checkout. CI definitions are prepared, but no remote CI run has been
triggered and the baseline root/filesystem failures above remain explicit gates.

## Final configured integration corrections

The actual dashboard bridge is tested against the actual configured service using
OIDC, signed authority and mTLS; vault/upstream in this supplemental bridge test
are explicit memory fixtures. It accepts the real readiness fields/reasons while
keeping intake/use disabled before worker verification. The packaged backend
contains its own restricted worker transport; a staged Docker filesystem test
proves it no longer depends on absent standalone service paths. The separate
full configured OpenBao proof uses real vault/upstream with no service injection.

Direct broker intake, delegated reservation, rotation and final vault send all
require current verified worker readiness. The real configured proof now asserts
intake disabled before heartbeat and enabled only after exact registered mTLS
verification. Metadata listing remains possible while execution is unavailable.

The first frozen screenshot attempt encountered a blank React mount without a
page error; the same-source retry passed. Its cause was not conclusively established.
Final source-pinned reports are freshly regenerated; no old report is substituted.

## Resumed verification and worker recovery

At local source `f38c8afe`, worker recovery and the configured real-OpenBao flow
passed together (4/4), and the worker CLI TLS heartbeat/shutdown test passed
(1/1). The encrypted worker archive requires a stopped process, exact build and
configuration pins and a fresh destination. Restored paused/possible-send tasks
remain interrupted/uncertain and cannot resume automatically.

The complete earlier authentication/security selection was repeated: 313 tests,
305 passed and the same eight failed. This includes all three MCP staged-write
mode failures as well as five root-custody failures. The later 40-test subset did
not resolve the omitted mode failures. The CI workflow now includes the complete
selection in an isolated root-owned Node container with unchanged assertions;
that CI job has not been executed remotely and is not a claimed pass.

Private Library/chat identifiers and personal paths have been removed from new
public-candidate documentation. Historical local commits still contain private
provenance; public publication must use a clean reviewed cumulative candidate,
not the private development history. The original private evidence is retained
separately; this cleanup changes no host identifiers or runtime settings.
