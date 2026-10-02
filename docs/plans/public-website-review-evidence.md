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

## Deferred backlog

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

### Deferred backlog (unchanged)

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

The sole proposed release branch is `ui/website-review-integration-20261002`. Frozen tested source is `da6630b83ff01e392be058557784ccc531492142`. Its product tree is identical to `60bf9968`; backend/scripts match runtime proof `fb5d4bb3`. Subsequent evidence-only commits do not change those tested products. The separate full mockup alignment and original backlog commits are excluded from this branch.

- Repository CI backend selection: 223 passed, zero failures/cancellations/skips.
- Cross-language website-review Python: 9 passed. Frontend selection: 4 passed. Production build passed, retaining existing import/chunk-size warnings.
- Final component: 9 grouped journeys, 21 viewport/theme audits. Full dashboard: 3 journeys, 9 layouts. Signed model bridge: 4 journeys, 2 layouts.
- Actual mobile Lighthouse new form, saved consent/readiness agent and expanded completed result: 100 / 100 / 100. No page errors or external browser requests.
- Independent final review found no concrete release blocker in this scoped implementation.

[Verification manifest](assets/public-website-review/release/verification.json) links retained report hashes and exact test source. [New form](assets/public-website-review/release/dashboard-new-agent-375.png) and [completed evidence](assets/public-website-review/release/dashboard-completed-evidence-375.png) show actual dashboard pixels. All public-site/provider responses are explicitly scripted fixtures. A3/A4 receipt verification is real, but no live public-site/provider or installed-host proof is claimed.

Two first wrapper attempts stopped before component/dashboard startup because WSL could not follow a Windows Git worktree pointer. The wrapper now receives the verified Windows commit explicitly. Both restarted suites exited zero. The already successful signed-runtime suite was not repeated. No failure was counted as a completed journey.

Repository implementation of the separately owned key-preserving updater refresh was authorized through the parent at 16:27 UTC. It is not part of this frozen evidence and needs targeted integration verification. Host actions and public publication remain unauthorized for this executor.
