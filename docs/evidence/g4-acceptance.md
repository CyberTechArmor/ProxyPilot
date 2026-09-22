# G4 submission evidence — 2026-09-22

Branch `feat/g4-guided-pomerium` starts at `main@66624b5`. The accepted G3 head
`4e7b257` is merged through PR #615: GitHub main metadata and local
`git merge-base --is-ancestor 4e7b257 66624b5` agreed. No dependency was merged by
this work. Other worktrees were preserved. Accepted progress remains 30% pending
review; accepting G4 would make it 40% (4/10).

## Execution evidence

| Criterion | Implemented and checked here | Execution limit |
| --- | --- | --- |
| G4.1 | Real admin API install/connect/skip, encrypted refs and retry identity; fixed v0.33.3 Docker argv; exact read-only existing-container/config verification; preservation of external keys/unrelated routes; owner-only revision files and drift refusal | Docker is absent here; independent review reports parser acceptance, while Core startup/health remain unverified |
| G4.2 | G2 verification requirement; separate client/observer refusal; exact callback/origin, confidential flow, S256 checks; protected credentials; G3 regression suite | Pomerium-to-Keycloak login has not executed here; no claim that a reader check validates the supplied client secret |
| G4.3 | Actual route review/API, policy/route digest, production Caddy renderer, SQLite ownership triggers; alias/native listener refusals; signed test app runs over real HTTP and crypto | Socket/HTTP host observations scripted; real PPL authorized/denied browser flows and off-host bypass probe outstanding |
| G4.4 | Existing runner/backend jobs, locks/fences/reconcile; failed runtime, invalid Caddy, failed probe → durable denial, unavailable-Caddy honesty, repeat apply, interruption/retry, separate API process restart, explicit removal | Caddy adapt/reload and Docker responses scripted; their real failure behavior requires isolated host execution |
| G4.5 | Independent dashboard/recovery/Keycloak files remain byte-identical across apply; subsequent renders retain the same directives; selected-route exclusions; existing G3/local/root recovery tests; documented actual session limits | No live MCP client, delegated edit, provisioning/migration run, terminal connection or service outage drill |
| G4.6 | Focused suite, affected suites, production frontend build; actual signed-assertion test app accepts valid JWT, refuses spoof/invalid issuer/audience/expiry/direct unauthenticated access; real UI/API restart and removal flow; 360px/desktop inspection | Not a real three-service acceptance run; real authenticated denial is outstanding, not inferred from a template/policy assertion |

Commands from `admin/backend` (Node 24.19.0; installed dependency trees reused via
local symlinks, excluded from the commit):

```sh
node --test --test-concurrency=1 \
  src/__tests__/pomerium-setup.test.js \
  src/__tests__/platform-setup.test.js \
  src/__tests__/keycloak-setup.test.js \
  src/__tests__/guided-sso.test.js \
  src/__tests__/root-recovery.test.js \
  src/__tests__/setup-engine.test.js \
  src/__tests__/setup-runner.test.js \
  src/__tests__/setup-post-launch.test.js \
  src/__tests__/route-render.test.js \
  src/__tests__/caddy-site-file.test.js
```

The original submission affected set contains **188 tests: 187 pass, one existing containment test
skipped** because this environment has neither writable cgroups nor systemd.
The 20 G4 tests pass. Two existing registry expectations now include Pomerium's
new job/service capability. During verification, a new preservation assertion
was corrected to exclude the renderer's generated timestamp when rerendering;
untouched files are still compared byte-for-byte. No production behavior was
changed to accommodate that assertion.

An additional `setup-deploy-closeout.test.js` run reported its existing mandatory
host-containment sentinel failure (no writable cgroup tree). The other closeout
checks passed. This is recorded rather than rebuilding host/process containment;
A-17 continuation is excluded. Native better-sqlite3 deployment remains a host
limit; isolated tests use Node SQLite with the real SQL/schema and narrow DB
fixture hooks.

From `admin/frontend`, `npm run build` passes (existing large-chunk warning).
From `admin/backend`, the repeatable browser check is:

```sh
G4_BROWSER_MODULES=/path/to/browser-dependencies/node_modules \
G4_CHROMIUM=/path/to/chromium node scripts/g4-browser-check.mjs
```

The browser dependencies are puppeteer-core, axe-core and lighthouse. This script
serves the built frontend and an isolated real API/SQLite process. It scripts host
completion solely to exercise removal UI. `g4-browser.json` records 15 layout
checks (configuration, protection review, removal review at 360/375/768/1280/1920),
no horizontal overflow with the global CSS guard disabled, primary button heights
at least 44px, axe zero, Lighthouse accessibility 95, API restart/reopen and
explicit removal. Desktop/360 screenshots are included and visually inspected.
No database, identity or host-command fixture result is represented as real Core.

## Concrete blockers to a real stack result

This workspace has neither `docker` nor `caddy` installed. Binary download through
the available repository connector is unsupported; the permitted command network
did not provide those release binaries. No disposable three-service environment
was therefore started during implementation. The independent review supplied by
the user subsequently ran the actual Core parser and reported that it accepted
the generated configuration. Full startup did not complete: Envoy encountered a
sandbox socket restriction. That parser result is review evidence, not an
execution repeated in this correction. Private listeners, Keycloak login,
authorized access, authenticated denial and Caddy TLS/reload remain **unverified**.
No live environment was used to work around these limits.

## Isolated host acceptance matrix (not performed)

Use a disposable Linux host with the existing ProxyPilot runner/backend, Caddy,
Docker, verified G2 realm and accepted G3 setup. Keep its test identity/data
separate from production. Follow `docs/features/guided-pomerium.md`, preserving
G3's client/passkey policy. Record image/version, commit, test origin, timestamps,
redacted job IDs/outcomes and application status/subject; never tokens/secrets.

| Check | Required observation |
| --- | --- |
| Install and connect | Managed image/private listeners/owner label match; Caddy alone owns 80/443. For Connect preserve hashes of external globals/keys/unrelated routes; only the operator merges owned route entries and starts it |
| Unauthenticated | New browser to test app redirects through self-hosted authentication to the verified Keycloak realm; exact callback returns without loops |
| Authorized | Allowed test identity finishes the actual login/passkey flow; app returns 200 with a locally validated signed assertion |
| Authenticated denial | Separate profile for a valid unlisted identity finishes login and receives Core denial (403), never test-app 200 |
| Spoof | Repeat unauthenticated request with forged assertion/user/email/Authorization headers; no app access. With an allowed session, injected user headers do not change the signed app identity |
| Direct bypass | From another host, public-host-IP:18443 and any aliases cannot reach the app; local unauthenticated 127.0.0.1:18443 returns 401. Verify all private Core listeners and route_localnet assertions |
| Invalid / failed apply | Corrupt only a disposable candidate/own resource to exercise refusal, parser/start failure and failed Caddy reload. Existing protected traffic stays gateway/denied. Failed initial denial is explicitly unverified; fix Caddy, retry |
| Repeat / restart | Repeat identical apply creates no new route/keys/container; close browser/restart only disposable API/runner between stages and reopen recorded progress |
| Removal | Separate explicit review/action restores direct Caddy route and its retained restrictions; test app still requires its own assertion |
| Independence | Verify dashboard/native G3 and separate-browser local recovery. Exercise MCP/delegated editing/provisioning/migration/terminal with existing credentials and health with its normal contract, with Core down; no new browser redirects |
| Sessions / outage / backups | Measure user disable/logout and refresh timing; stop disposable Keycloak/Core and record behavior. Verify the existing DB/env backup plus companion protected config pack; restore references with sessions intentionally absent |

## Separate live-host acceptance limits

Production DNS/certificates, real deployment's Docker/Caddy versions, public
network/firewall behavior, physical passkeys, native database module, actual
identity token lifetimes and recovery/backup restore were not changed or tested.
Those host exercises need their own authorization. This submission makes no
production-readiness or accepted-progress claim. No G5–G10, Phase F, A-17 work,
installer/updater behavior, live credential rotation, deployment or merge.

Optional broader runtime profiles, richer claim selection, automatic external
management and continuous host-drift monitoring are backlog only. Stop at G4.


## G4 review correction — pinned image CA environment

The review of `dff6e18` identified the official v0.33.3 image's inherited
`SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`. The runtime inspection guard
previously rejected it. The Docker fixtures now include that literal default.
Before changing production code, the existing-container and new managed-repeat
regressions both failed with the reported unsupported-environment error; initial
managed installation succeeded before its repeat inspection failed.

The bounded correction permits only that exact additional value. Changed/empty
CA paths, a conflicting duplicate, SSL_CERT_DIR and unrelated Core/autocert
settings still fail before file writes, lifecycle commands or health execution.
No environment-prefix exemption, image change or configuration redesign.

The managed regression executes initial installation, actual adapter reinspection
(no extra create/start/restart), then a new route-protection apply. The latter
reuses the container, owner marker and credentials and finishes protected rather
than denied. The existing connection test reinspects the official environment
twice while preserving the external file, keys and unrelated route; no external
restart or write is issued. These host responses remain scripted.

Correction validation: **22 focused tests pass; affected suite 190 tests / 189
pass / one existing containment skip; frontend build passes** with its existing
chunk-size warning. Frontend code is unchanged, so the previous layout evidence
is retained. The user's independent review also reported 187 pass / one skip and
a passing build for the original submission, plus actual parser acceptance;
full startup/login stopped at the sandbox socket restriction described above.
Real Pomerium–Keycloak allowed/denied login and Caddy execution remain the same
recorded integration checks. Accepted progress is **30%**, G4 pending; acceptance
would make it **40%**. No merge, deployment, live service or later-milestone work.
