# G7 guided Vaultwarden — repository evidence

Date: 2026-09-22. G7 repository implementation is accepted at
`04820930cf7d467e40b756e398ed7382a10e6f38`; PR #619 is authorized for merge.
Accepted progress is **70% (G1–G7, 7/10)**. Historical pending-review and no-merge
records below are superseded by this acceptance; runtime limits are unchanged.
Actual Vaultwarden/Keycloak browser SSO, vault unlock and denied-user execution
could not run here; they are explicitly unverified, not inferred from fixtures.

## Baseline, scope and checkpoints

Accepted G6 head `6e48d89dedb058b8d760556b448d00042909b057` is an ancestor of
main `24ba567eea4a5bd6f469b1f3fa30c0857201dfae`, the merge of
[#618](https://github.com/CyberTechArmor/ProxyPilot/pull/618). Branch
`feat/g7-guided-vaultwarden` starts there; no unmerged dependency was merged.
An isolated worktree preserved unrelated work. The G6 runner installation-key
correction is unchanged and its fresh-process tests are included in this run.

Published checkpoints:

- `bcf5412ac37e830ccfd4909227406961a475bf11`: accepted G6 ancestry and six fixed G7 criteria.
- `7238a8311812019d2f4e0d0f453db9e994922a5c`: production UI, store, runner, private
  runtime, Caddy, effective-config/identity readers and focused/browser tests.
  Remote tree `dcccbd246c7b6499fa6005441060da25b82ae6af` matched the local tree.

The final PR head includes guidance, evidence and final validation. The delivery
report records its exact fetched/tested SHA. Local HTTPS git push lacked a
credential (`could not read Username`); the authorized GitHub connection
successfully published the same tree and advanced the feature branch without
force. There was no policy rejection, permission bypass or publication blocker.

Only G7.1–G7.6 are implemented. No G8–G10, migration/import, general provisioning,
A-17, Phase F, infrastructure rebuild, installer/updater or accepted U1/U2 changes.
No merge, deployment, live DNS/database/identity mutation, credential rotation or
live service restart. Test processes and data were disposable local fixtures.

## Six fixed criteria and evidence boundary

| Criterion | Implemented and exercised | Actual execution limit |
| --- | --- | --- |
| G7.1 | Administrator-reviewed install/connect/skip; inert save; 1.37.3 pin after official release/deployment/OIDC/client review; private independent persistent SQLite service and Caddy route; read-only Connect; ownership collision and missing-data refusal. | Production API, store, Docker-command and Caddy-render adapters run with scripted Docker/Caddy upstreams. No actual container installation here. |
| G7.2 | Separate Keycloak client, exact callback/origin, S256, RS256, scopes, client-only token lifetime and conditional role denial; accepted passkey policy reused. Credentials encrypted/reused, effective admin form including persisted overrides checked, only owned files/routes changed, exact owner handoff. | Production observer/readback against source-shaped responses plus a real local HTTP socket. Actual Keycloak flow and Vaultwarden admin rendering remain unexecuted. |
| G7.3 | Separate login/unlock explanations, disposable allowed/denied/account-linking recipe, SSO-only refused, retained login, no secret/item input schema or frontend persistence. Operator evidence rereads configuration and records only bound booleans. | Browser form observations are scripted and explicitly labeled operator-only. No actual vault decryption, harmless-item creation, account linking or out-of-policy identity ceremony is claimed. |
| G7.4 | Durable job/child/leases, runner-only dispatch, fresh-process key loading, browser/API restart, reconciliation and explicit retry. Existing resources/ciphertext/data/key bytes preserved; uncertain create, missing data/key and drift refuse reset. Health and historical proof are distinct. | Real process/API/SQLite/crypto execution; service restart and data/key bytes use named fixture sentinels, not a real vault database or encryption engine. |
| G7.5 | Release-compatible SQLite/attachments/sends/config/signing-key and matching ProxyPilot backup set; restart/restore/outage/lost-device steps; administrator cannot recover an unknown unlock secret; separate ProxyPilot recovery preserved. | Guidance/source review and preservation checks. Compatible real restore remains separately recorded host acceptance, not executed here. |
| G7.6 | 208 affected passes, frontend build, production-adapter failures/repeat/retry/redaction, admin/CSRF/fresh-auth, 20 responsive audits including 360px/desktop and accessibility checks. | Existing host exclusion and native/runtime limits below remain explicit. No fixture assertion is presented as real service acceptance. |

## Executed checks

- **208 selected tests pass, zero failures**. This includes **21 G7 tests**:
  20 setup/transport/runtime/identity/route cases and one fresh-process test that
  exercises both runner `once` and `serve`. The existing containment-host assertion
  is excluded by its unchanged name; it is not part of the 208 passes. Node reports
  zero skips because that test was filtered out by the command.
- G6's three accepted fresh-runner key regressions remain passing. G7's additional
  test independently encrypts credentials under a random installation key, starts
  the production runner command without an inherited key, and verifies unchanged
  ciphertext and `.env` with no private values in output.
- A real localhost HTTP listener exercises the production bounded transport,
  admin authentication form and escaped-secret effective HTML parser. The server
  response is a fixture. Separate tests refuse metadata addresses, alternate
  endpoints, redirects, wrong release, health failure and persisted overrides.
- Runtime/route adapter tests cover repeat apply, private listeners, credential,
  database/key byte preservation, foreign resource collision, uncertain creation,
  missing data/keys, protected-file drift, custom Caddy collision, Caddy validation
  failure and a changed owned route. No failing operation deletes/replaces them.
- Frontend `npm run build` passes. The existing large-chunk warning remains.
- Built frontend, production HTTP/auth/CSRF/SQLite and runner adapters pass the
  browser choice/save/apply/error/retry flow, including an actual API-process
  restart with a durable queued job. Vaultwarden and Keycloak responses are scripted.
- **20 layout audits** across install, connect, review and ceremony forms at
  **360, 375, 768, 1280 and 1920px**: no horizontal overflow with the global guard
  disabled, no short new buttons, zero page errors, **zero axe violations**, and
  **Lighthouse accessibility 95**. Desktop/360px screenshots were visually checked.
  Service credentials and prohibited vault values are absent from rendered output
  and local/session storage.

Logs and visual evidence: [affected](g7-affected.txt), [build](g7-build.txt),
[browser JSON](g7-browser.json), [360px](g7-setup-360.png),
[desktop](g7-setup-1280.png).

From `admin/backend`:

```sh
node --test --test-concurrency=1 \
  --test-skip-pattern='^containment mechanisms are present on this host' \
  src/__tests__/setup-engine.test.js \
  src/__tests__/setup-runner.test.js \
  src/__tests__/setup-deploy.test.js \
  src/__tests__/setup-deploy-closeout.test.js \
  src/__tests__/setup-deploy-finish.test.js \
  src/__tests__/update-runner-maintenance.test.js \
  src/__tests__/keycloak-setup.test.js \
  src/__tests__/pomerium-setup.test.js \
  src/__tests__/guided-sso.test.js \
  src/__tests__/sso-transport.test.js \
  src/__tests__/infisical-setup.test.js \
  src/__tests__/platform-setup.test.js \
  src/__tests__/openbao-setup.test.js \
  src/__tests__/openbao-postgres.test.js \
  src/__tests__/openbao-runner-startup.test.js \
  src/__tests__/vaultwarden-setup.test.js \
  src/__tests__/vaultwarden-runner-startup.test.js
```

From the repository root after the frontend build:

```sh
G7_BROWSER_MODULES=/path/to/browser/node_modules \
G7_CHROMIUM=/path/to/chromium \
G7_EVIDENCE_DIR=/path/to/ProxyPilot/docs/evidence \
node admin/backend/scripts/g7-browser-check.mjs
```

The script uses the existing Puppeteer/axe/Lighthouse test-tool installation and
Chromium. It writes no vault password, recovery code or real item content.
Its checkbox completion tests the observation endpoint, not an actual SSO ceremony.

## Corrections made before final validation

An initial focused run found a missing `readVaultwarden` executor import in the
new slow-child branch; the production slow-Caddy test now passes. A fresh-auth
assertion incorrectly demanded 403 where the existing middleware returns 401;
the test now accepts the existing auth denial without changing middleware.
The runner-kind expectation was extended for the new G7 job only.

Source review found that an empty configured `sso_audience_trusted` string is a
permissive regex in 1.37.3. The saved expected config now requires an anchored,
escaped match of the dedicated client ID; empty/wildcard effective values fail.
Keycloak 26.7.4 source also established the exact `negate` condition key. Missing
SQLite detection before retry/start prevents initializing an empty replacement.
The final browser screenshot waits for the existing responsive transition and
resets ancestor horizontal scroll after scrolling the guide into view. Layout
audits check the document and guide widths with overflow guards disabled.
No accepted earlier implementation was repaired or redesigned.

## Concrete runtime blockers and unchanged limitations

This environment has **no Docker client/daemon, Incus, Caddy, Rust toolchain or
running disposable Vaultwarden/Keycloak service**. A read-only attempt to obtain
the Vaultwarden container via `ghcr.io` returned **HTTP 403**; no workaround around
that rejection or infrastructure rebuild was attempted. A Keycloak source clone
also returned `CONNECT tunnel failed, response 403`; the needed public 26.7.4
source was instead read using the existing authorized GitHub connection.
Source inspection is not runtime execution.

Consequently the real-service portions of G7.1–G7.3/G7.6 remain **unexecuted**:
actual Docker lifecycle, effective Vaultwarden admin page, dedicated Keycloak
passkey/role denial, browser SSO followed by separate vault unlock and harmless
item, supported existing-account linking, and real Caddy TLS/reload. The exact
disposable ceremony and failure expectations are in the
[operator guide](../features/guided-vaultwarden.md). No real restore was performed.

Tests reuse the existing Node SQLite fixture adapter. They do not establish
native `better-sqlite3` loading or full production application entrypoint boot.
The host containment assertion is excluded because this environment lacks the
accepted writable cgroup/containment prerequisites. Earlier G1–G6 host limitations
(including physical passkeys, Pomerium/Infisical, PostgreSQL and compatible
restore) remain in their existing evidence; they are not reopened or presented as
passes. These are execution limits within the six requested criteria, not added
milestones or completion gates. Repository work stops at G7 for review.
