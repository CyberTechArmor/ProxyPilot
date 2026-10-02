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
| Minimal discoverable frontend review journey | UI owner in progress | Separate component/navigation/browser worktree |
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
| Full backend aggregate | 3,590 tests: 3,536 passed, 10 failed, 4 cancelled, 40 skipped (279.496 seconds); unaffected baseline/environment cases under verification |
| Full script Python aggregate | 293 tests ran, 33 skipped, 0 failures (96.254 seconds); initial CRLF-only checkout failures resolved by local LF normalization |
| UI build/browser journey | Owned by UI task; integrated evidence pending |

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

## Deferred backlog

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
