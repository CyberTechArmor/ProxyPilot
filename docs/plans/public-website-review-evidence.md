# Bounded public website review: implementation and evidence

Scope authorized by Thomas at 14:12 UTC on 2026-10-02: approved guide save,
user-selected public website, explicit run start and inspectable review/evidence.
Repository development on Duo only. Public means no login or protection bypass.
The UI/UX task owns shared frontend components and navigation.

## Source and ownership

- Initial verified main: `0f1b48f33fe31723100b8c758c717899bb7b3f1d`.
- Incomplete preserved checkpoint: `5c55b8ee8a49ca44691378bd611ecfdf457ed6b6`
  on `feat/public-website-review-20261002`; this is not a release claim.
- Integrated worktree: `task-2/proxypilot-review-integrated`, branch
  `feat/public-website-review-integrated-20261002`, created from verified main
  `56c881be051e2699abac1977bfa0162cd8536183` after guide-only PR #720.
  Its preserved local checkpoint is `8fbcf2204235b7622fb4ea4cbec5087c1fac0e34`.
  The verified runtime implementation commit is
  `9e02012fee0feb56ce40e66663c601228e093a8e`.
- Runtime task owns HTTP extraction, review service/routes/migration,
  A3/A4 model bridge, safety/regression tests and these documents.
- UI task owns `WebsiteReviews.jsx`, browser journeys and project navigation in
  the separate `task/ui-website-review` worktree. It received the v1 API contract;
  the runtime task inspected its in-progress component read-only and confirmed
  save/consent/readiness/start/cancel/evidence requests match the backend contract.

Guide save is implemented by PR #720 and integrated here. The legacy Researcher
synthetic profile is not the website review entry point. Removing its domain guard
or supplying demo hard-rules would not implement this capability.

## Implementation tracker

| Item | State | Evidence |
| --- | --- | --- |
| Freeform approved guide pin, URL/objective, typed limits | Implemented | `operational-website-review.js`; actual G01 save fixture |
| Inert saves/consent and explicit start/cancel | Implemented | service and route regression fixtures |
| DNS/socket pin, redirect/private/management denial | Implemented | real loopback HTTP transport fixture with test-only dial mapping |
| Robots, bounded extraction, unsupported/blocked outcomes | Implemented | HTTP/extraction tests; no production private-network exception |
| Existing provider, no reviewed-site credential | Implemented | real A3/A4 classes with scripted provider, no worker launch |
| Signed model provenance and settlement binding | Implemented | real OpenSSL Python receipt verified by Node |
| Owner/role/config/guide/account checks | Implemented | stale, revocation, wrong-owner and unrelated-admin tests |
| Durable immutable output, cancellation, restart no replay | Implemented | SQLite triggers and service/bridge tests |
| Minimal frontend review component | UI owner committed | `f81857fb`, `902581ff`, `e355f5c0`; navigation remains UI-owned |
| Installed A3/A4 activation and A8 refreshed key | Not performed; separate operator gate | `update.sh` does not reinstall these components |
| Live external provider/website review | Not performed | No production pilot or secret access authorized |

## Measured checks

Run on Windows Duo through WSL Python 3.12.3 / Node 24.13.0, disposable fixtures.
The checkout uses the existing shared Linux development dependencies without
installing or mutating the UI owner's packages. Logs are retained locally in
`task-2/verification`.

| Check | Result |
| --- | --- |
| Operations + Agent runs + toggles aggregate | 197 passed, 0 failed (15.155 seconds), including bounded model wait/socket cancellation |
| Public-review A3/A4 Python suite | 9 passed, 0 failed (2.945 seconds) |
| Full backend aggregate | 3,590 tests: 3,536 passed, 10 failed, 4 cancelled, 40 skipped (279.496 seconds); baseline/environment cases below |
| Verified-main reproduction of failing files | 26 tests: 15 passed, same 10 failed, 1 cancelled (49.608 seconds) on detached main `56c881be` |
| Full script Python aggregate | 293 tests ran, 33 skipped, 0 failures (96.254 seconds); initial CRLF-only checkout failures resolved by local LF normalization |
| UI/runtime integration journey | Passed with real API/CSRF/store/extraction/service/signed bridge, scripted session/site/provider; 4 journeys, 375/1280 layouts |

The implementation defects found and fixed during verification were an
order-sensitive usage JSON comparison in the cross-language receipt bridge and
unconditionally extending the capability response of routers without a review
service. The tests now require exact signed usage fields while allowing key
reordering, and preserve the legacy response when the new service is absent.
The final review also added a cancellable supervisor socket/model wait: a provider
that never returns cannot keep a dashboard run active past its time budget.
Public fetching resolves A records only, so a normal site with both A and AAAA
records can be read without enabling IPv6 transport; every returned A address
is still screened and the selected address pinned.

The fixtures cover three unrelated site subjects (museum, garden, ocean research)
at separate HTTP/HTTPS origins, ordinary navigation/redirects, a server-rendered
page and a JavaScript-only shell, robots wildcard rules and redirect robots denial,
auth/bot/paywall/empty/non-text outcomes, bounded chunked responses, hanging DNS /
sockets, DNS rebinding and mixed private answers, hostile page instructions,
Unicode/escaped input size, model/provider/usage/cost failures, explicit cancellation,
access changes during waits, stale pins and restart interruption.

The model fixtures use scripted provider replies through the real reservation /
settlement and supervisor code. They prove wiring, policy and provenance; they
do not claim a live model quality evaluation or a successful production review.
Actual completed results are accepted only from the configured provider's signed
response. No production request, host mutation, credential enrollment, push,
merge, un-draft or history rewrite was performed for website review.

The full backend failures are outside changed code. Four browser probes cannot
find Playwright's default `chromium_headless_shell-1228` (the explicitly configured
Chromium used for review journeys is available); five bootstrap cases require a
canonical root-owned credential directory; the containment acceptance case needs
a writable cgroup tree. All ten reproduce on verified current main with the same
dependencies/environment. Four runner-startup cases timed out under the full
aggregate load; one also reproduces on main's isolated failing-file run, while the
other three pass there. No containment, ownership, credential or test assertion
was weakened to make the aggregate green. Logs: `backend-aggregate.log` and
`backend-main-baseline.log` in the local verification directory.

The separate integration branch `test/public-website-review-e2e-20261002` combines
runtime `9e02012f` and the UI owner's `f81857fb`, `902581ff`, `e355f5c0` commits.
`admin/frontend/tests/website-review-runtime.browser.mjs` uses the real component,
central API client, Express Operations router, CSRF middleware, approved-guide
store, public extractor, review service and Ed25519 verifier. Only authentication,
the public-site socket dial mapping and the provider answer are scripted fixtures.
It proves the TAG Armor / Summarize flow through the actual guide-save endpoint,
inert configuration and consent, explicit start, cited output/evidence, cancel
during provider wait, client-render-only refusal, missing CSRF and wrong-owner
denial. There are three explicit starts, two model calls and eight read-only
website requests; no website authorization/cookie header or browser external
request occurs. The result is visually inspected at 375 and 1280 pixels, without
horizontal overflow. Shared production project navigation remains UI-owner work.

Retained artifacts are explicitly fixture evidence, not a live provider review:
[journey report](assets/public-website-review/runtime-review-report.json),
[phone](assets/public-website-review/runtime-review-375.png),
[desktop](assets/public-website-review/runtime-review-1280.png).

## Key-preserving updater refresh

The separately reviewable updater change adds a fixed-path paired transaction
for already opted-in A8/A3/A4 installations. Only the two daemon sources and their
installation digest journals change. Existing receipt key bytes, A8 pins, VM
identity, AppRole config, provider references, bindings, prices and runtime ledgers
are retained. It refuses active/unknown work and foreign drift, checks both serving
digests without a model call, and rolls back both sources/journals before dashboard
recovery. No individual reinstall/configure action, new permission or enrollment
is introduced. Ordinary installs and `--no-restart` remain a runtime no-op.

Initial evidence: 14 refresh cases passed with a real Ed25519 fixture; root updater
selection passed 81/81 with zero skips; Python aggregate passed 307 tests with 33
environment skips and zero failures. A final CLI no-op test was then added to
prove no lock/backup creation for non-opted-in installations. Final source-specific
results follow after convergence onto frozen website/UI release `444cc2fe`.

Final combined checks: on updater integration source
`1d57201827d0766e0369d9fdd0c011ade2a33a5d`, the full Python aggregate passed
308 tests / 33 environment skips / zero failures (77.510 seconds), root updater
selection passed 81/81 / zero skips (14.571 seconds), and Operations passed 197/197
(18.782 seconds). Fresh Windows CRLF bytes initially failed two unchanged Linux
fixture assertions (systemd unit exact line; A7 pinned patch digest). Normalizing
those local fixture files to committed LF bytes resolved both without any product
diff, pin rewrite or weakened assertion.

Final code source `10446cf9d9369c89667a40b389019b77908a5415` additionally recognizes
the broker's existing terminal `provider_error` state without changing its ledger.
Its entire refresh selection passed 15/15 as root, zero skips (0.916 seconds).
Other script/backend sources are identical to the aggregate-tested integration
source. The unchanged frontend, website backend/runtime and browser fixture blobs
exactly match `444cc2fe`; their retained UI proof above remains applicable. No
cosmetic redesign, Relay work or unrelated feature was added. The final CI will
run the combined source again. [Updater verification manifest](assets/public-website-review/release/updater-verification.json)
records exact sources and local log hashes.

## Deferred backlog (unchanged)

- Authenticated browsing; passwords, OAuth, MFA and CAPTCHA handling.
- Website writes: forms, uploads, purchases, account changes and other actions.
- Arbitrary computer actions or generic agent SDK compatibility.
- Browser JavaScript rendering under a reviewed general public-site browser fence.
- IPv6 transport and nonstandard ports.
- New memory/storage architecture, bulk approval migrations and automatic starts.
- General credential-broker expansion and additional provider credential enrollment.

The synthetic A3/A4/A7/A8 pilot and its credential/write approvals remain separate.
Auto-approved guide saves confer no credential-write approval or website-write
permission. No dependency on completing the cosmetic redesign is introduced.

## Frozen converged release evidence - 2026-10-02

The website/UI slice was frozen on `ui/website-review-integration-20261002`. Its tested source is `da6630b83ff01e392be058557784ccc531492142`; product tree matches `60bf9968` and backend/scripts match runtime proof `fb5d4bb3`. Website evidence-only commits do not change those tested products. The separate full mockup alignment and original backlog commits are excluded. The combined branch is `feat/website-review-updater-release-20261002`, based on frozen slice `444cc2fe` with the separately reviewed updater commit `1d572018`.

- Repository CI backend selection: 223 passed, zero failures/cancellations/skips.
- Cross-language website-review Python: 9 passed. Frontend selection: 4 passed. Production build passed, retaining existing import/chunk-size warnings.
- Final component: 9 grouped journeys, 21 viewport/theme audits. Full dashboard: 3 journeys, 9 layouts. Signed model bridge: 4 journeys, 2 layouts.
- Actual mobile Lighthouse new form, saved consent/readiness agent and expanded completed result: 100 / 100 / 100. No page errors or external browser requests.
- Independent final review found no concrete release blocker in this scoped implementation.

[Verification manifest](assets/public-website-review/release/verification.json) links retained report hashes and exact test source. [New form](assets/public-website-review/release/dashboard-new-agent-375.png) and [completed evidence](assets/public-website-review/release/dashboard-completed-evidence-375.png) show actual dashboard pixels. All public-site/provider responses are explicitly scripted fixtures. A3/A4 receipt verification is real, but no live public-site/provider or installed-host proof is claimed.

Two first wrapper attempts stopped before component/dashboard startup because WSL could not follow a Windows Git worktree pointer. The wrapper now receives the verified Windows commit explicitly. Both restarted suites exited zero. The already successful signed-runtime suite was not repeated. No failure was counted as a completed journey.

Repository implementation of the key-preserving updater refresh was authorized through the parent at 16:27 UTC. Its affected checks are recorded below separately from the unchanged website/UI fixtures. Thomas subsequently explicitly authorized publishing the combined draft PR, with parent review/CI before merge and production Update performed by Thomas. No production action was performed by this executor.

## Retained guest compatibility repair - 2026-10-02

Repair branch `fix/review-guest-compatibility-20261002` starts from verified main
`35c2e9d4eb657f92e1499d8d56035217b04f7ae6`. The user's read-only diagnostic
identified one candidate mismatch: installed and recorded `a3-worker-guest.py`
hash `d0724e5fb5573a18095a8e906cd9bb9c2542c17c494184ca15cbc65d345331f9`
matches the historical PR #710 source (`02398ef`); candidate hash
`54302e5ee880470480d9b4de3d30616b263c7213d9eb08712b1ef3f50c5c0d21`
matches `39ada2b`'s deferred bound-session/single-sign-out correction. The other
adjacent sources and A3/A4 units matched the journal and candidate.

The updater recognizes only that exact pair, still requiring actual installed
bytes to match the journal. It retains the guest source and pin, and changes
only the existing two daemon files/two install journals. Unknown/reversed
pairs, foreign installed bytes and all other adjacent source/unit mismatches
remain refused; the refusal now names the path. The Demo guest correction
remains deferred. No guest VM action, enrollment, new permission or host target
is introduced. Public reviews use backend extraction and the A3/A4 model
bridge, without launching this worker or its browser.

The exact historical guest is reconstructed from the reviewed four-change
delta and asserted against its full source hash, so tests need no historical
Git object or duplicate worker distribution. Before the repair, two real-file
regression cases reproduced the same generic preflight refusal. After it:

- Root refresh: 16/16, zero skips. Real Ed25519 key, installer adapters and
  fixed files prove apply/rollback retain guest bytes, modes and journal pin,
  plus keys/config/pins/other package files. Unknown and reversed hash pairs,
  changed candidates, foreign bytes and each other adjacent source/unit reject.
- Public review: 16/16, zero skips, including real Python-to-Node receipt
  verification. The historical guest module completes a scripted provider
  review while browser construction, worker creation and guest launch raise
  assertions; no website credential binding occurs.
- Full Python runtime/security selection: 316 cases, 33 existing environment
  skips, zero failures (73.230 seconds).
- Root updater/self-update selection: 83/83, zero skips/failures (23.794 seconds).
- Whitespace verification passed. Frontend, dashboard/provider daemons,
  manifests, worker source, units and update orchestration are unchanged.

[Compatibility verification manifest](assets/public-website-review/release/guest-compatibility-verification.json)
records source and local log hashes, including the reproduced pre-fix failure.
These are local fixtures with scripted VM/service/socket/provider operations;
no production shell, host write, model call or deployment was performed. Parent
review and exact-head CI precede merge; Thomas's normal Update remains the
deployment path, with existing provider/price readiness requirements intact.

## Bounded retained-ledger recovery - 2026-10-02

Repair branch `fix/review-runtime-input-diagnostics-20261002` starts from verified
main `f5a8509b9fb1a931d174fcbe1e531190c8c691ab`. User metadata at 18:17 UTC
identified regular runtime files: A3 ledger **2,998,598 bytes**, A4 ledger
**556,188 bytes**. The updater had incorrectly applied its 2 MiB source/config
cap to runtime history and described every oversized/nonregular input as missing.
The failure remained before dashboard stop or runtime replacement.

Both runtime ledgers now use a separate **16 MiB** cap, allowing retained history
while bounding each read/allocation. All code/config/install-journal/transaction
and backup inputs retain **2 MiB**. Every preflight/apply/rollback ledger digest
uses the same reader; transaction records contain ledger hashes, not ledger
backups. No ledger is created, pruned, migrated, restored or replayed. Reads
require regular files, preserve existing root-custody checks, refuse symlinks,
check the opened descriptor again and read at most the applicable cap plus one
byte. Missing, nonregular, unreadable, oversized and concurrently growing inputs
now name the path and condition without printing payloads. Invalid UTF-8/JSON or
VM identity still refuses. The exact retained guest compatibility remains intact.

The historical-worker/real-Ed25519 transaction fixture now combines a retained A3
ledger larger than the observed file with the exact PR #710 guest. The existing
supervisor loader accepts that terminal history. Two pre-fix cases reproduced
the misleading refusal; after the repair, apply and rollback retain exact
fixture ledger bytes, guest bytes/digest pin, keys, config and other owned files.
Both ledger paths accept bounded larger documents and refuse missing/invalid
or over-cap input. Activity, unknown states, wrong VM identity and foreign
history mutations still refuse before service effects or recovery overwrite.
Additional checks retain the 2 MiB code/config cap, reject nonregular/symlink
inputs and enforce bounded reads when a file grows after metadata validation.

Local validation: root refresh **21/21** with zero skips/failures, full Python
runtime/security selection **321 cases / 33 existing environment skips / zero
failures**, root updater/self-update **83/83** with zero skips/failures, and
whitespace verification passed. Frontend, A3/A4 daemon and guest sources, units,
credentials, permissions, update orchestration and host targets are unchanged.
[Ledger verification manifest](assets/public-website-review/release/ledger-verification.json)
records exact source/local log hashes, including the reproduced pre-fix failure.
All service/VM/socket/provider actions in these tests are local scripted fixtures;
no production command, mutation, live model call or deployment was performed.
Files above the explicit cap remain a separately inspected refusal; history
retention/compaction architecture stays in the backlog. Parent review and CI
precede merge, then Thomas uses normal Update.
