# Immediate repairs (2026-09): what changed, how to update an existing install, and the acceptance record

Gate one of the platform-architecture review. Five security defects that
existed before any identity-provider work, plus the migration behaviour an
existing installation needs. The architecture that follows (Keycloak,
Pomerium, the vaults) is gate two and three and is NOT in this document.

Status: **ready for controlled host validation; production upgrade approval
pending.** Everything below marked *sandbox* was proven in this repository's
test suite, a typecheck of the component against its real dependencies, or
the component's own vitest run; everything marked *host* still needs a real
installation. Record host results against the exact candidate commit.

## What changed

| Area | Before | After |
| --- | --- | --- |
| Passkey assurance | `userVerification: 'preferred'`, `requireUserVerification: false` on registration and assertion | `required`, verified server-side on both ceremonies (`lib/passkey-policy.js`); the UV refusal is audited and explained |
| Elevation | Passkey login opened the 4h sudo window as a side effect | Login only mints a session; elevation comes from `/sudo` or `/sudo/passkey`; migration 605 closed every open window once |
| MCP token validity | Hash + revoked flag | Per call: unexpired (914), a live **admin** owner (913 revoked orphans). Disable, delete and demotion revoke; re-enable and re-promotion never revive |
| Generated-app secrets | Never written; component fell back to a public dev default; no production mode | Owned secrets minted once per project into `/etc/environment`; the unit runs the app in production mode; the deploy is refused unless mode and secrets line up; the component refuses its dev defaults in production |
| Existing generated apps | — | `AUTH_MASTER_SECRET` is minted only when the app's code can migrate data encrypted under the value it replaces (`requires_marker`, checked in the source **and**, when it exists, the built artifact); otherwise it is **deferred and reported**, and every deploy's readiness result carries a warning until it is resolved |
| Component migration bridge | — | Legacy keys are configuration (`AUTH_LEGACY_MASTER_SECRETS`); a fresh install starts with an **empty** list; a stored LDAPS secret is opened with the current key, then the legacy list; a legacy hit is re-encrypted under the current key by compare-and-swap; the LDAPS settings report `masterKey` for the row read and `masterKeyInventory` across every row |

## Before updating an existing installation

Do these with the current version still running. An already-open dashboard
tab is not evidence of anything below.

1. **Host access that does not go through ProxyPilot.** SSH or console as
   root works, and you know where the database lives
   (`/opt/proxypilot/data/db/proxypilot.db`).
2. **A fresh-browser local login.** Private window, username + password +
   TOTP. Then one sudo-gated action (open the Users page and start an edit)
   and confirm the sudo prompt accepts password + TOTP. If you rely on LDAP
   for your own account, do this as a **local** administrator as well.
3. **A backup you can reach without this host.** A `.ppbackup` config-tier
   backup on an S3 destination, or a copy of the database directory and
   `/opt/proxypilot/.env` taken together (the env file holds the keys the
   database rows are encrypted with — they are one recovery set).
4. **Know what you are giving up.** After the update: a passkey that was
   enrolled on an authenticator that does not verify you (a PIN-less
   security key) will be refused, with a message saying so; every signed-in
   admin re-proves once before their next destructive action; a passkey
   login no longer counts as that re-proof.
5. **Know that the non-destructive root recovery command does not exist
   yet.** `reset.sh` is destructive and targets the legacy database path
   (`docs/known-issues.md`). If step 2 fails, fix that before updating, not
   after.

After the update, repeat step 2 in a fresh browser: local login, sudo
re-proof, and if you use passkeys, a passkey login followed by a separate
passkey sudo re-proof.

## Generated apps: what the update does to each kind

| App | What happens on its next build or deploy |
| --- | --- |
| Fresh app (created after this change) | Gets unique `AUTH_JWT_SECRET` and `AUTH_MASTER_SECRET`, runs in production mode, refuses the dev defaults. Its component carries the migration bridge but has nothing to migrate. |
| Existing app that ran on the dev defaults | `AUTH_JWT_SECRET` is minted (sessions signed with the public default are invalidated — intended). `AUTH_MASTER_SECRET` is **deferred**: the app's installed component does not carry `decryptSecretAny`, and the installer never overwrites a file an app already has, so the stored LDAPS bind password stays readable under the dev default. The project chat says which key was deferred and why. |
| Existing app with an operator-set custom master secret | Untouched. The deployed app reads only the process environment (the unit plus `/etc/environment`), minting never overwrites an existing key, and a value in `/srv/app/.env` was never in effect for the served app. |
| Restart, or the update run twice | No secret changes; the mint plans against what is already present. Migrations 605, 913, 914 are idempotent. |

To move an existing app onto a real master secret, install the current
component version into it (a deliberate upgrade — the platform has no
in-place component upgrade flow yet, see `docs/known-issues.md`), redeploy
so the marker is present in `src/auth/crypto.ts` **and** `dist/auth/crypto.js`
and the key is minted, then open the LDAPS settings. `masterKey` reads
`rekeyed` once and `current` after that for the row you read;
`masterKeyInventory` is the completion test — it classifies **every** ldaps
row (all tenants) as current, legacy or unreadable, and `complete` is true
only when legacy and unreadable are both zero. Then **rotate the LDAP bind
credential**: re-encryption does not undo earlier exposure, and a database
copy taken while the dev default was in use can still be read with that
public string. Finally the operator closes the bridge with `set_project_env`
(`AUTH_LEGACY_MASTER_SECRETS=""`, an empty string — the component keeps an
explicitly empty list empty; it never falls back to the default) and
redeploys; `legacyBridgeEnabled` then reads false.

A **fresh** app never has the bridge — and "fresh" is decided by the data,
not by the files. "No component files were kept" only says the files are
new; an app can have new files over an existing or restored PostgreSQL
holding a credential encrypted under an earlier key. So before the platform
writes `AUTH_LEGACY_MASTER_SECRETS=""` or mints a new master secret, it reads
the rows that secret protects from the app's own database (the contract's
`protects` guard: `auth_connections`, `secret_ciphertext`, `secret_nonce`,
`provider = 'ldaps'`) through `psql` as the postgres user, and classifies
them under the component's cipher (`auth-data-logic.js`):

The probe targets the database the app itself uses: `DATABASE_URL` from the
container environment (the file the unit reads), falling back to the scaffold
default, with the database name parsed out of it and never printed (it
carries a password). A non-local host is reported as remote and treated as
unknown. `psql` runs with `-X`, `ON_ERROR_STOP=1` and footer off, and rows
are emitted only when it exited zero — empty output is an empty query only
on a successful query. Every branch prints a result line, so silence is never
read as success.

"Newly provisioned" is a **positive** identification, not an inference: only
the provision path may say it, and only for a container created in that run
from the template with no restored, copied or rehydrated data. A clone that
copies the source database, a rehydrate, a rebuild of files, and every later
install or deploy are not newly provisioned, whatever the probe finds.

| Observed state | Decision |
| --- | --- |
| Newly provisioned container **and** the probe finds no table, no database or no rows | Fresh storage: empty legacy list written; new secret minted |
| Newly provisioned container but the probe finds rows | Contradiction: **deferred**, nothing changed, reported |
| Existing app, correct database, table present, no rows | Initialise, **only while the app is stopped** (the deploy stops it before this probe); no fresh values |
| Existing app, rows all under the development default | Existing data the bridge migrates: mint while stopped, keep the bridge, no fresh values |
| Existing app, expected database or table missing | **Deferred and investigated** — a wrong database name, an unmigrated schema or an incomplete restore looks exactly like this |
| A key already in `/etc/environment` | Preserved, never overwritten |
| Rows under a key that is neither in the environment nor the development default, or a mix | **Deferred** — set `AUTH_MASTER_SECRET` to that key first, then redeploy |
| Connection, permission, query or output-parsing failure, or a remote database | **Deferred without changing secrets**, reason reported |

**The transition is protected against a concurrent write.** The race the
review named — probe finds nothing, the still-running old app saves an LDAPS
credential under the development key, a new key activates with the bridge
disabled — cannot happen because the deploy **stops the app and frees its
port before the final probe and mint**, persists the new key and unit, and
only then starts the new process. A failed mint restarts the old unit. Deploys
for one container are serialized (`deployQueues` in `deploy.js`), so two
deploys cannot make conflicting decisions. Outside the deploy — the
pre-install and retry paths — a key that protects stored data is never minted
for an existing app; it waits for the deploy. The compare-and-swap rekey
covers later individual updates; this ordering covers the transition.

The component's own test pins that an explicitly empty list stays empty. The
bridge is enabled only where storage was not positively identified as new.

The source-and-artifact marker is a **compatibility** check, not proof that
the running process carries the code. The declared built artifact
(`dist/auth/crypto.js`) must now **exist** and carry the marker, because the
service unit executes the manifest start command (`node dist/server.js`): a
missing build defers the key with "minted by the deploy once the build
exists", a stale build defers it with "not the code that will run". The host
acceptance test for an upgraded app is: the deploy that mints the key also
built `dist/` from that source, the unit started with the environment it was
given, and the LDAPS credential decrypts after a restart. A capability
recorded by the build itself would be the durable form of this check and is
a follow-up.

Until an app is fully migrated it stays visibly marked. The readiness probe
that runs after every deploy reports **three separate facts**, each a
warning and never a failure, in the build status panel and the deploy chat
message; none implies the others:

| Line | 200 means | Otherwise |
| --- | --- | --- |
| `MASTERKEY` | a **non-default** master secret is active in the environment (set, and not the development literal) | unset, or still the development default |
| `MASTERKEY_ROWS` | every stored credential decrypts under the active key (204: nothing stored) | 404: at least one row is under another key; 500: the probe could not run |
| `LEGACYBRIDGE` | `AUTH_LEGACY_MASTER_SECRETS` is set to an empty string | the bridge is still enabled |

The guest-side probe is plain `sed`/`grep`; the rows check is computed on
the platform side with the same classifier the mint decision uses. A project
with no auth component gets none of the three.

Read `MASTERKEY` precisely: it reports the key **configured** in the file the
unit reads at start. Readiness runs after the deploy restarted the unit, so
that is the key the process this deploy started loaded — not proof about any
older process. The application-level confirmation is the host test: after the
restart, the LDAPS settings decrypt the stored credential and report
`masterKey` current with the inventory complete.

Nothing sensitive leaves the probe: the classifier decrypts in memory and
discards plaintext, reasons carry counts and psql's error wording, the
database URL is never printed, and the shell helper does not log command
output.

## MCP token validity rule

On every tool call (the endpoint is POST-per-call with no stream, so this is
the check on an already-connected client):

1. the token exists and is not revoked;
2. it has not expired;
3. its owner exists, is not `pending`, and is an `admin`.

Expiry is **supported, not yet universal**. A newly minted token expires
after `MCP_TOKEN_DEFAULT_DAYS` (365) unless the mint says otherwise;
`expires_in_days` accepts 1 to 3650, or `0` for never, which the audit row
records as an explicit choice. Tokens minted before migration 914 carry no
expiry and keep working, so automation is not broken by the update. They are
the inventory to replace: the MCP Access page and `list_mcp_keys` show
`never expires` on each one; mint a replacement with a lifetime, move the
client to it, revoke the old key.

Disabling (dashboard role → pending, `disable_user`, `set_role` to pending),
demoting (admin → user, both surfaces) and deleting a user set `revoked_at`
on their keys; nothing clears it. `owner_status` in the listings reads
`active`, `disabled`, `demoted`, `deleted`, `expired` or `none`.

## Rollback

Restore the **set**, never one half: the database and the keys it was
encrypted with (`/opt/proxypilot/.env` for ProxyPilot; for a generated app,
the guest's `/etc/environment` together with its Postgres). Restoring an old
environment file over rows that were re-encrypted under a newer key
recreates the unreadable-data problem this work exists to prevent.

For a generated app, an Incus instance snapshot captures the guest's root
filesystem — both files — but with two qualifications. Incus excludes the
contents of attached **custom volumes** from instance snapshots and exports,
so a project that keeps its database on one needs that volume backed up with
it; and a snapshot lives in the instance's storage pool, so it is not a
host-loss recovery on its own — take an off-host copy (the guest export
download, or the migration/backup features that ship a tarball to S3). For
a running PostgreSQL the capture must include the data directory and WAL
consistently; for the first drill, stop the guest cleanly before the export
and the question does not arise.

## Acceptance record

| Case | Required result | Evidence |
| --- | --- | --- |
| Fresh generated app | Builds, gets unique secrets, rejects deployed defaults | *sandbox*: `planSecretMint` uniqueness and length; the unit sets production mode; `validateDeployEnvironment` refuses a missing key or an overriding mode; the component's `config.ts` refusal typechecks. *host*: a real provision + deploy still to run |
| Existing app on the dev key | LDAPS credential survives; legacy migration completes | *sandbox*: the master secret is deferred when the marker is absent (guard + `deferred` reporting); the bridge opens legacy ciphertext and rekeys by compare-and-swap; whole auth module typechecks. *host*: a real app with an LDAPS row |
| Existing app with a custom key | Key and encrypted credential intact | *sandbox*: `planSecretMint` never writes an existing key; `mergeEnvFile` replaces nothing it was not asked to. The served app reads only the process environment |
| Restart or repeated update | Secrets unchanged; migrations do not damage data | *sandbox*: mint is idempotent; migrations 605/913/914 guard their own preconditions; the migration-history repair is a pure transactional module tested against populated databases for every state — nothing recorded, a legitimate main 912, the former PR 912, duplicate owner records, a 913 under another name, an interrupted retry, and a vetoed write leaving history untouched. *host*: run the update twice |
| Fresh project | Secrets minted once; legacy fallback disabled; app works after restart | *sandbox*: first install writes an empty legacy list only when the data probe confirms fresh storage; the component's vitest run proves an explicitly empty list stays empty and production refuses the dev defaults. *host*: provision, restart the guest, sign in |
| New files, existing database | Existing keys preserved; legacy migration decided explicitly | *sandbox*: `mock2-auth-data.test.js` — new files over a database holding a dev-key credential yields not-fresh and a mint through the bridge only with writers stopped; a custom or mixed key defers; an unreadable probe defers; rows on a supposedly new container defer. *host*: rebuild a project's files over its database and watch the chat message and readiness lines |
| Wrong or unavailable database | Key and legacy configuration unchanged | *sandbox*: a missing table or database on an existing app, a remote `DATABASE_URL`, a schema error, no psql, or no output all decide `defer` with nothing written. *host*: point `DATABASE_URL` at a wrong name, deploy, confirm the environment file is unchanged and the reason is reported |
| Write attempted during the transition | Prevented, or safely handled | *sandbox*: ratchet — the deploy stops the unit and frees the port before the final probe and mint, mints with `writersStopped: true`, restarts the old unit on failure; deploys per container are serialized; pre-install and retry never mint a data-guarded key for an existing app. *host*: start a deploy, attempt an LDAPS settings save during it, confirm the save fails or lands readable |
| After restart | The application itself decrypts the credential with the intended configuration | *host* only: open the LDAPS settings after the deploy's restart; `masterKey` current, inventory complete, connection test passes |
| Authentication | Password/TOTP and verified passkey both log in, with separate sudo | *sandbox*: no passkey-only accounts exist; the login handler carries no sudo stamp; both ceremonies require UV. *host*: fresh-browser checks above |
| MCP | Disabled, deleted, demoted and expired credentials denied, per call | *sandbox*: `mcpTokenRefusal` cases; `findToken` wiring ratchet; revocation on every disable/demote/delete path; new tokens default to a finite lifetime. *host*: call through an existing connector after disabling its owner; mint a 1-day token and call after it lapses |
| Failed upgrade | A tested restore recovers code, database and matching secrets | *host* only: restore the recovery set on a replacement host |

Test evidence: full backend suite on this branch versus the same main commit
(`83c0dff3`) in the same sandbox — **no additional failures compared with the
baseline**; the ten documented `ERR_MODULE_NOT_FOUND` files fail on both.
The component's `src/auth` (20 non-test files) typechecks under `strict` +
`noUnusedLocals` against drizzle-orm, express, pg, ldapts and cookie, and its
`config.test.ts` passes under vitest. The frontend production build
(`npm run build`, dependencies from the committed lockfile via `npm ci`) was
run on the `c15a6b63` tree after that commit and succeeds; nothing in the
frontend changed after it.
