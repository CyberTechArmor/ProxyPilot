# G5 recovery acceptance evidence — 2026-09-22

Branch: `feat/g5-guided-infisical-recovery`, based on
`d2ca73abf874f08a05c1a8121aa25ea39837af1d` (accepted G4, PR #616).
G5 was historically accepted at `a4365466acf6df50cd0204d96a335f27d7f80b10`:
**50% (5/10)**. That original commit/full tree is unavailable. This reconstruction
gets a new commit identity; it is not claimed byte-identical to the missing tree.
Acceptance, reconstructed-tree verification, publication, merge and deployment
are separate. This recovery is for PR review only: no merge or deployment.

## Preservation and reconstruction

The input archive SHA256 was verified as
`ae5cb3e4106ab57ff775bfb96dccd0b10a43d36527112b60218df2010c34f93d`.
`git apply --check` passed on the recorded base; applying its partial patch
restored exactly 24 files. Missing files were not treated as deletions.
[The input manifest](g5-recovered-files.json) preserves every supplied file size
and SHA256; its PARTIAL status describes the input, not the reconstructed result.

Checkpoint published before reconstruction:
[`ee3845f49775b61d7a89774c0e7f399e7f8cfa07`](https://github.com/CyberTechArmor/ProxyPilot/commit/ee3845f49775b61d7a89774c0e7f399e7f8cfa07).
Its remote tree `654050aec95a810e2be9c79f2ad38dbbdb10b1b2` exactly matched the
local checkpoint tree. GitHub's branch ref was read back to confirm persistence.
All **24/24 recovered files remain byte-identical after reconstruction**. That
includes backend operations, migration/integrations, routes, stores, fixtures,
tests and the original browser driver. No backend defect or integration conflict
required modifying them. No `install.sh`, `update.sh`, CLI, lockfile or G1–G4
implementation changes were made during reconstruction.

Restored missing pieces:

- `InfisicalSetup.jsx`: immutable reviewed targets, identity handoff, protected
  submission, exact policies/proxied service, explicit apply/retry, pending/failure
  and configuration-bound evidence, optional SSO and backup guidance.
- Frontend API methods using the existing CSRF/fresh-auth client; PlatformSetup
  integration and independent Agent Proxy install/connect/skip controls.
- [Operator guide](../features/guided-infisical.md), existing ledger/feature
  records, this fresh evidence, and a supplemental browser script for restored
  choice controls, failure and retry. No attempt to manufacture the old 35-file
  count or recover historical screenshots.

The command-line Git push lacked credentials. The connected GitHub API published
the checkpoint. An automatic approval review initially rejected the packaged
Keycloak test as unrelated; its actual one-line G5 installable-services assertion
and explicit inclusion in the authorized 24-file manifest established the scope,
and the retry was approved. No rejection was bypassed. The same tree-verification
method is used for final publication; the PR's commit/ref supplies its identity.

## Original six criteria

| Criterion | Current evidence | Separate runtime limits |
| --- | --- | --- |
| G5.1 | Production HTTP admin/CSRF/sudo and strict-input checks; inert saves; independent install/connect/skip; actual reconstructed UI saves/reopens; production runtime/Caddy adapters preserve resources on retry and inspect existing proxy without mutation | Docker, Incus, Caddy and real data services absent; host commands/inspection and route adapt/reload scripted |
| G5.2 | Separate workload/proxy/agent references; encrypted credentials; exact effective-policy audit including folder grants; broader grants denied; bounded operator handoff, missing-service failure and successful retry; unchanged credentials | Infisical organization/project/policy service responses scripted; edition/permission capability is verified at apply, never assumed; human SSO optional and unconfigured |
| G5.3 | Actual Python consumer and HTTP destination use one disposable application value through production stdin delivery; anonymous/agent value-read refusals; secret conflict preservation; encrypted local reference and job/event/audit redaction assertions | Real Infisical permission engine and a real Incus VM not executed |
| G5.4 | Actual CLI 0.43.133 substitutes the proxy-only real value for the placeholder, destination receives it twice, zero unauthorized real-value receipts; denied no-auth/invalid-token/wrong-folder/unmatched requests; agent script has no proxy token or real application/proxy values | Auth, CA signing, scoped service/secret API scripted; Incus dispatch runs local Python for this executable test, so it does not establish VM isolation or general HTTPS interception |
| G5.5 | Production jobs/locks/fences/reconcile; slow child wait, lost VM lock, interruption, runtime/Caddy/API failures, missing keys, resource drift and retry; real separate API process restart; UI displays persistent failed/queued state and explicit related retry | No actual systemd/host runner restart or live service outage; backup is documented through existing packs, not an executed restore |
| G5.6 | Current affected suite, production build, real browser/API checks and visual inspection; mobile touch/overflow, axe and Lighthouse; original protected auth/CSRF/fresh-auth code paths retained | Full production entrypoint with native better-sqlite3 was not booted; node:sqlite backs disposable production-route fixtures |

## Current tests, not historical results

Node **v24.19.0**, Python 3 and Chromium **141.0.7390.0** in an isolated workspace.
Dependencies installed from existing backend/frontend/CLI lockfiles with
`npm ci --ignore-scripts --no-audit --no-fund`; no package changes. An initial
affected run could not load CLI bcryptjs; installing the locked CLI dependencies
resolved it. The final run below is the current evidence.

From `admin/backend`:

```sh
PP_G5_CLI=/path/to/verified/infisical node --test --test-reporter=tap --test-concurrency=1 \
  src/__tests__/infisical-setup.test.js \
  src/__tests__/infisical-live-proxy.test.js \
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

Result: **210 tests, 209 pass, zero failures, one existing containment skip**.
The 20 G5 tests (19 setup + one actual CLI flow) all pass. Current output:
[affected TAP](g5-recovery-affected.tap). TAP/build logs normalize trailing
whitespace only; outcomes are unchanged. The skip reports no writable real
cgroup/systemd containment mechanism (or required runtime paths); no test was
weakened or removed. A preliminary focused 19/19 pass is also current, but the
complete affected run includes those same tests and is authoritative here.

Actual CLI obtained from the official
[v0.43.133 release](https://github.com/Infisical/cli/releases/tag/v0.43.133), asset
`cli_0.43.133_linux_amd64.tar.gz` (58,591,714 bytes), downloaded via the GitHub
release asset API after direct-download timeouts. SHA256 matched the official
release asset digest:
`ec79bed991c7b96350c015ee37cffe61fb8bd8dcc5322d9a1dd65f168959efb3`.
`infisical --version` reports 0.43.133. No substitute script is presented as CLI
execution. The upstream Infisical service in this test is explicitly scripted.

From `admin/frontend`, `npm run build` passes. Current output:
[production build](g5-recovery-build.txt). The existing >2000 kB chunk-size
advisory remains. Vite development-server transforms returned HTTP 200 for
PlatformSetup, InfisicalSetup and the frontend API client. Compiled bundles were scanned for every disposable fixture/flow
credential value: none present. `git diff --check` passes. The actual package
SHA256 comparison was repeated after integration and validation: 24/24 unchanged.

## Current browser and visual evidence

Both scripts start disposable SQLite/real HTTP API processes; production setup
routers, auth, CSRF and encrypted references execute. Background shell endpoints
are fixture responses. No host runner or external stack is started by a browser
check. Each script creates a private temporary database and deletes it afterward.

```sh
# admin/backend; independent local browser test dependencies, not product packages
export G5_BROWSER_MODULES=/path/to/browser-dependencies/node_modules
export G5_CHROMIUM=/path/to/chromium
node scripts/g5-browser-check.mjs
node scripts/g5-recovery-browser-check.mjs
```

- Preserved driver: **20 audits** across configuration, identity form, policy
  review and pending/reopened state at **360/375/768/1280/1920 px**; overflow guard
  disabled; every visible G5 button at least 44 px tall. Saved encrypted identity
  references and queued job reopen after a separate API process restart. Credential
  fields are cleared, saved credentials absent from rendered state. **Zero page
  errors, zero axe violations; Lighthouse mobile accessibility 94 (gate ≥90)**.
  See [browser JSON](g5-browser.json) and [current run](g5-browser-run.txt).
- Supplemental restored-UI checks: full skip, connect/reopen, independent proxy
  skip clearing its endpoint, inert target save and acknowledgement, scripted
  failed job through the real job store, explicit related retry preserving refs,
  unsaved-plan refusal/reopen, and **390 px** overflow audit. See
  [supplemental JSON](g5-recovery-browser.json). The failure transition is scripted,
  while its persistence, API and frontend rendering are real.
- Current [360 px](g5-setup-360.png) and [1280 px](g5-setup-1280.png) screenshots
  were generated and visually inspected during reconstruction. No historical
  screenshot is reused. The exact-policy JSON is expandable to keep review actions
  reachable on mobile. No new dialog or navigation entry is introduced.

The runtime's default Chromium download returned an invalid/truncated archive.
A separate npm-distributed Chromium 141 executable was used for these checks;
no product version pin or dependency was changed.

## Concrete host limits and stopping rule

Docker, Incus, Caddy, PostgreSQL and redis-server executables are absent. Host
interface discovery returns `ERR_SYSTEM_ERROR`, `uv_interface_addresses returned
Unknown system error 1`; production local-address validation cannot complete on
this host. Loopback HTTP sockets **do** work, as demonstrated by current real
API/consumer/CLI execution; do not reuse G4's prior socket restriction as a G5
claim. Full native better-sqlite3 entrypoint boot is also not exercised here.

Outstanding disposable-host acceptance: full Infisical/PostgreSQL/Redis startup,
real scoped identity/edition enforcement, managed/external proxy inspection,
actual Incus VM isolation and Caddy adapt/reload/TLS, and data/key restore using
the existing backup mechanism. These are runtime limits, not authorization for
another development milestone or infrastructure rebuild. G4's Pomerium–Keycloak
allowed/denied login and Caddy execution remain outstanding separately.

No live DNS, database, identity settings, credentials or services were changed.
No G6–G10, A-17, Phase F, general agent orchestration, existing-secret migration,
installer/updater work or additional completion gates. Stop after verified,
durably published reconstructed G5 and its PR; do not merge or deploy.
