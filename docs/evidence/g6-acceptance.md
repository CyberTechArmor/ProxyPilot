# G6 guided OpenBao — repository acceptance evidence

Date: 2026-09-22. G6 is accepted at corrected head
`6e48d89dedb058b8d760556b448d00042909b057`; PR #618 is authorized for merge.
Accepted guided progress is **60% (6/10)**. No production deployment is authorized.
The historical pending-review/publication records below describe their original
execution time and are superseded by this acceptance; runtime limits are unchanged.

## Base, scope and publication

PR [#617](https://github.com/CyberTechArmor/ProxyPilot/pull/617) was verified merged.
Accepted G5 recovery `31d0c87b2b1fd4e00c24773e6ae0435e387c70a3` is included in
main at `e9430a2314c881c23fbecc74c25acf8ac62661c2`, the G6 branch base.
The lost `a436546` is not used. Work is isolated on `feat/g6-guided-openbao`;
prior workspaces and unrelated changes were preserved.

Published checkpoints:

- `0f01ca7e565febbb6b0a8f3e834153efc5fde163`: accepted recovery/base and six fixed criteria.
- `686a3c271f53021da37f0e124d921b7d6f1f7400`: initial production implementation.
- `aa95e34a3e3e3da9d8eecca1e0a282a362e18657`: focused adapters, real OpenBao test,
  recovery corrections, public PostgreSQL CA and browser driver; fetched tree
  `29230403c2ed9ce1c51c21ab7f024134700fa50c` matched the local checkpoint.

Final tested code, guidance and evidence are published on the same branch. The
PR head identifies the complete commit; the final report records remote SHA/tree
verification. Git transport initially lacked credentials (`could not read Username`);
the authorized GitHub connection successfully published commits and advanced the
branch without force. There was no publication rejection or dependency merge.

Only G6.1–G6.6 changed. No G7–G10, HA, KMS/HSM, general provisioning, existing
credential migration, A-17, Phase F, installer/updater/U1/U2 changes or live
DNS/database/identity/service operations. Disposable local test processes were
started and stopped. This evidence does not reopen earlier accepted milestones.

## Fixed criteria and observed results

| Criterion | Implementation and focused result | Execution boundary |
| --- | --- | --- |
| G6.1 | Install/connect/skip, inert save, exact review/apply, version pin, independent private persistent single-node Raft runtime, ownership/drift refusal and restricted existing Caddy route. Connect reads state and intended names before owned writes. | Production API/job/runtime/route adapters pass scripted Docker/Caddy responses; actual Docker/Caddy host execution pending. |
| G6.2 | Four states; one attempted initialization, server-side PGP handoff outside application backups, receipt acknowledgement, manual Shamir unseal, no root runtime identity; lost/interrupted handoff means recovery required without reset. Shares/bootstrap tokens never persisted or queued. | Actual 2.6.2 PGP initialization/decryption, persistent Raft restart/seal/unseal and token revocation pass. Lost/partial handoff, redaction and operator crash tested through production adapters. |
| G6.3 | Dedicated exact Keycloak callback/full-path group mapping and scoped policies; unmapped denied; separate protected AppRole credential preserved on retry; allowed/denied operations verified. Earlier clients/login/recovery preserved. | Actual OpenBao AppRole and OIDC engine pass, including mapped/unmapped claims. OIDC provider is a signed-response fixture, not Keycloak. Real Keycloak human browser sign-in pending. |
| G6.4 | Explicit disposable private PostgreSQL target, verified TLS with optional public CA, SCRAM role creation, 60s reader/120s maximum, successful read, denied write, self-token/lease revocation and subsequent auth denial. Outage cannot count as denial. | Production credential-flow/pg adapter with scripted PostgreSQL passes. Actual OpenBao database engine accepts and reads back TLS/SCRAM/role configuration with `verify_connection:false` in the live test. Real PostgreSQL issue/use/revocation remains pending; no successful real database flow is claimed. |
| G6.5 | Existing saved jobs/leases and explicit retry survive API/browser/runner restart; only references in jobs; reuse keys/resources; bind saved configuration and first ready cluster before mutations; sealed/unavailable never currently verified. Recovery/snapshot/config/independent share custody documented. | Actual API process restart and real OpenBao restart; scripted host runner/backend reconciliation, slow child route, lock/collision/missing-key/cluster tests. No new backup/upgrade/restore framework. |
| G6.6 | Admin, CSRF, fresh auth, strict schemas, redaction; focused and affected tests; frontend build; desktop/360px and accessibility checks. | Results and limits below distinguish actual execution from scripted responses. |

## Executed verification

- **184 affected tests pass, zero failures.** One separately identified host
  containment availability assertion is explicitly excluded by the CLI pattern
  below; Node reports 184 selected tests and zero skips. The plain initial run
  confirmed its expected failure here: no writable cgroup tree. It fails on the
  accepted base too and remains earlier host acceptance, not a G6 pass.
- **22 G6 focused tests** are included in those 184 (18 setup/recovery/access plus
  four PostgreSQL/TLS adapter tests). **One additional actual OpenBao test passes**.
- Frontend `npm run build` succeeds. Existing large-chunk warning remains; no
  unrelated bundling work was added.
- Built UI at **360, 375, 768, 1280 and 1920px**: 20 layout audits across install,
  connect, reviewed and unsealed/bootstrap states; no horizontal overflow with
  the global guard disabled; new buttons at least 44px; zero page errors.
- Browser choice/save/apply, receipt acknowledgement, transient share clearing,
  sealed-to-unsealed display and real API-process restart pass. Production
  frontend/auth/CSRF/SQLite routes are exercised; upstream OpenBao responses and
  runner transitions are scripted. Secrets absent from local/session storage and
  rendered output. **Zero axe violations; Lighthouse accessibility 95**.

Evidence: [affected log](g6-affected.txt), [actual OpenBao log](g6-openbao-real.txt),
[build log](g6-build.txt), [browser results](g6-browser.json),
[360px](g6-setup-360.png), [desktop](g6-setup-1280.png).

Affected command, from `admin/backend`:

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
  src/__tests__/openbao-postgres.test.js
```

Real service test, from `admin/backend`, with independently obtained test tools:

```sh
G6_BAO_BINARY=/path/to/verified/bao \
G6_OPENPGP_MODULE=/path/to/openpgp/dist/node/openpgp.mjs \
node --test src/__tests__/openbao-live.test.js
```

The optional fixture library was OpenPGP.js 6.3.1. It generates disposable PGP
custodians and decrypts the **actual OpenBao response**, not a fabricated handoff.
The official Linux amd64 2.6.2 archive matched published `checksums.txt`:
`8dc11cc5fca0b539a9e352727dacb4e2d304daffcf9a66e0718ac325a20d05aa`.
`bao version` identified source commit
`dd9c19c37a878cf4a81b18efb8d6f0599c7da923`. The test uses temporary persistent
Raft data and an actual localhost service, restarts it, supplies existing shares,
and executes AppRole and OIDC APIs. The signed OIDC fixture is explicitly not
proof of Keycloak deployment/client configuration. No plaintext recovery material
is written to the evidence.

Browser driver, from repository root after the build:

```sh
G6_BROWSER_MODULES=/path/to/browser/node_modules \
G6_CHROMIUM=/path/to/chromium \
G6_EVIDENCE_DIR=/path/to/ProxyPilot/docs/evidence \
node admin/backend/scripts/g6-browser-check.mjs
```

It uses Puppeteer, axe-core and Lighthouse with Chromium 141. The production UI
uses the existing central API client, including fresh-auth handling. Screenshots
were visually inspected. No new page or modal framework was introduced.

## Corrections and precise limits

Reproducible G6 blockers corrected within this slice:

- Actual 2.6.2 initialization exceeded the normal API deadline: initialization
  alone gets a bounded 60s socket / 63s total deadline.
- Actual AppRole lookup returns 204 for a missing SecretID; first registration
  supports that response, while a missing previously attempted registration still
  refuses reissue. A nested transaction around the existing lease helper was
  removed after the production operator test reproduced it.
- Selected private-IP PostgreSQL TLS needed a public CA path shared by both
  consumers. Public certificates only, fixed path, read-only managed mount and
  external-owner handoff were added, alongside SCRAM before role SQL.
- Interrupted first bootstrap now records the ready cluster before mutations;
  a replacement cluster is refused on retry.
- New enabled button failed contrast (3:1); G6 buttons now meet contrast and the
  browser audit passes. The runner-kind assertion was stale on the accepted base
  (missing G4/G5); its expected list now includes those and G6, and explicitly
  excludes transient operator jobs. No earlier production behavior changed.

An initial broader run also reported `UNSAFE database mutation with active backend`
in the unchanged U1 PM2 rollback test. The subsequent full runs passed it; the
accepted base passed a full run and three focused reruns. This is recorded as a
transient test observation, not a diagnosed/fixed U1 defect. `install.sh`,
`update.sh`, U1/U2 production code and that test are unchanged.

This execution environment has no Docker daemon/client, Incus or Caddy binary,
no real Keycloak, and no usable PostgreSQL service. A portable PostgreSQL 18.4
package was tried only as a disposable test tool: its loader lacked
`libpq.so.5`, then `libicuuc.so.60` with explicit preload. Switching to a non-root
test user was refused (`cannot set groups: Operation not permitted`). No
permission bypass or infrastructure rebuild was attempted. Therefore full real
PostgreSQL credential success/revocation remains **pending**. Tests use Node's
SQLite fixture adapter; native better-sqlite3/full application entrypoint boot is
not established by this run.

Other pending runtime checks: real Docker lifecycle/Caddy reload and certificate
issuance; actual Keycloak mapped/unmapped browser login; a selected disposable
PostgreSQL service with verified TLS; compatible snapshot restore on the target
host. These are runtime-validation limits, not claimed passes. Earlier G1–G5
host acceptance (including physical passkeys, Pomerium/Infisical integrations and
real containment) stays in its existing records. No new completion gates, later
milestone work or production action is authorized by this report.

Operator steps and version-specific official references:
[guided OpenBao](../features/guided-openbao.md). The repository slice stops here
for review and acceptance at 50%.


## Review correction — runner installation key (2026-09-22)

The independent review reproduced a G6.5/G6.6 startup defect at published
`582046a227609551d0e959a5dfe5d76882d698eb`: the runner resolved the installation
`.env` to locate SQLite but did not load its `TOTP_ENCRYPTION_KEY`. The original
G6 fixture seeded that variable in-process and therefore masked a fresh service
start. A new child-process regression reproduced the same protected-credential
failure before the correction ([before log](g6-runner-key-before.txt)).

The bounded correction is in `cli/src/commands/setup-runner.js`: `serve` and
`once` read only the existing encryption key from the resolved installation
`.env` (including `--env`), validate 64 hex characters and initialize the shared
secret module before opening the job database. A configured service-environment
key remains supported; disagreement with the saved key is refused. Missing or
malformed keys refuse startup before any job is claimed. There is no generated
key, rotation, dotenv sourcing or change to the saved file/credential rows.
`status` and `reconcile` remain available without the key for recovery.

Three new tests run the **production runner command and executor in fresh Node
processes**, explicitly deleting the inherited encryption key and importing no
fixture that assigns it. Disposable file-backed SQLite contains a protected
credential encrypted independently under a random installation key. Both `once`
and the actual `serve` loop reuse it successfully, retain exactly the same
ciphertext and `.env`, and emit no key/client/machine values into output or job
records. Additional fresh-process cases cover missing/placeholder/malformed and
conflicting keys, unchanged queued jobs, recovery inspection and `--env` selection.
OpenBao transport, Keycloak probes and the PostgreSQL proof result are scripted;
this regression proves startup/decryption, not new real-host integration.

Validation after the correction:

- **187 affected tests pass**, adding the three startup regressions to the prior
  184-test command. Use the command above with
  `src/__tests__/openbao-runner-startup.test.js` appended. The same existing
  cgroup-host assertion is excluded; it remains a separate host limit.
- Focused runner/startup execution: **17 pass**. See
  [focused log](g6-runner-key-focused.txt) and
  [affected log](g6-runner-key-affected.txt).
- Frontend build passes ([build log](g6-runner-key-build.txt)); frontend source
  is unchanged, so the already recorded desktop/360px checks remain applicable.
- `install.sh`, `update.sh`, the service unit and accepted U1/U2 behavior are
  unchanged. The affected U1/U2 tests pass. No live service was restarted.

Published as a correction on the existing G6 branch/PR #618. Progress remains
**50% pending correction acceptance**, then 60%. Real PostgreSQL, Keycloak/Caddy
integration, compatible restore and all earlier host acceptance remain separate.
