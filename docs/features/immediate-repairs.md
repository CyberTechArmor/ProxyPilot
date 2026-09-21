# Immediate repairs (2026-09): what changed, how to update an existing install, and the acceptance record

Gate one of the platform-architecture review. Five security defects that
existed before any identity-provider work, plus the migration behaviour an
existing installation needs. The architecture that follows (Keycloak,
Pomerium, the vaults) is gate two and three and is NOT in this document.

Status: **implementation updated; existing-install upgrade validation
pending.** Everything below marked *sandbox* was proven in this repository's
test suite or a typecheck; everything marked *host* still needs a real
installation.

## What changed

| Area | Before | After |
| --- | --- | --- |
| Passkey assurance | `userVerification: 'preferred'`, `requireUserVerification: false` on registration and assertion | `required`, verified server-side on both ceremonies (`lib/passkey-policy.js`); the UV refusal is audited and explained |
| Elevation | Passkey login opened the 4h sudo window as a side effect | Login only mints a session; elevation comes from `/sudo` or `/sudo/passkey`; migration 605 closed every open window once |
| MCP token validity | Hash + revoked flag | Per call: unexpired (914), a live **admin** owner (913 revoked orphans). Disable, delete and demotion revoke; re-enable and re-promotion never revive |
| Generated-app secrets | Never written; component fell back to a public dev default; no production mode | Owned secrets minted once per project into `/etc/environment`; the unit runs the app in production mode; the deploy is refused unless mode and secrets line up; the component refuses its dev defaults in production |
| Existing generated apps | — | `AUTH_MASTER_SECRET` is minted only when the app's code on disk can migrate data encrypted under the value it replaces (`requires_marker`); otherwise it is **deferred and reported** |
| Component migration bridge | — | A stored LDAPS secret is opened with the current key, then the configured legacy keys; a legacy hit is re-encrypted under the current key by compare-and-swap; the LDAPS settings report `masterKey` |

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
so the marker is present and the key is minted, then open the LDAPS settings:
`masterKey` reads `rekeyed` once, `current` after that. Then **rotate the
LDAP bind credential**: re-encryption does not undo earlier exposure, and a
database copy taken while the dev default was in use can still be read with
that public string. Finally set `AUTH_LEGACY_MASTER_SECRETS=` (empty) in the
app's environment so the bridge is closed; a fresh app can have it empty
from the start.

## MCP token validity rule

On every tool call (the endpoint is POST-per-call with no stream, so this is
the check on an already-connected client):

1. the token exists and is not revoked;
2. it has not expired (`expires_at`, optional; `expires_in_days` at mint, 1 to 3650);
3. its owner exists, is not `pending`, and is an `admin`.

Disabling (dashboard role → pending, `disable_user`, `set_role` to pending),
demoting (admin → user, both surfaces) and deleting a user set `revoked_at`
on their keys; nothing clears it. `owner_status` in the listings reads
`active`, `disabled`, `demoted`, `deleted`, `expired` or `none`.

## Rollback

Restore the **set**, never one half: the database and the keys it was
encrypted with (`/opt/proxypilot/.env` for ProxyPilot; for a generated app,
the guest's `/etc/environment` together with its Postgres — an Incus
snapshot of the guest holds both). Restoring an old environment file over
rows that were re-encrypted under a newer key recreates the unreadable-data
problem this work exists to prevent.

## Acceptance record

| Case | Required result | Evidence |
| --- | --- | --- |
| Fresh generated app | Builds, gets unique secrets, rejects deployed defaults | *sandbox*: `planSecretMint` uniqueness and length; the unit sets production mode; `validateDeployEnvironment` refuses a missing key or an overriding mode; the component's `config.ts` refusal typechecks. *host*: a real provision + deploy still to run |
| Existing app on the dev key | LDAPS credential survives; legacy migration completes | *sandbox*: the master secret is deferred when the marker is absent (guard + `deferred` reporting); the bridge opens legacy ciphertext and rekeys by compare-and-swap; whole auth module typechecks. *host*: a real app with an LDAPS row |
| Existing app with a custom key | Key and encrypted credential intact | *sandbox*: `planSecretMint` never writes an existing key; `mergeEnvFile` replaces nothing it was not asked to. The served app reads only the process environment |
| Restart or repeated update | Secrets unchanged; migrations do not damage data | *sandbox*: mint is idempotent; migrations 605/913/914 guard their own preconditions; the stray-912 history guard is covered by a ratchet test. *host*: run the update twice |
| Authentication | Password/TOTP and verified passkey both log in, with separate sudo | *sandbox*: no passkey-only accounts exist; the login handler carries no sudo stamp; both ceremonies require UV. *host*: fresh-browser checks above |
| MCP | Disabled, deleted, demoted and expired credentials denied, per call | *sandbox*: `mcpTokenRefusal` cases; `findToken` wiring ratchet; revocation on every disable/demote/delete path. *host*: call through an existing connector after disabling its owner |
| Failed upgrade | A tested restore recovers code, database and matching secrets | *host* only: restore the recovery set on a replacement host |

Test evidence: full backend suite on this branch versus the same main commit
(`83c0dff3`) in the same sandbox — identical failure set (the ten documented
`ERR_MODULE_NOT_FOUND` files), everything else passing. The component's
`src/auth` (20 files) typechecks under `strict` + `noUnusedLocals` against
drizzle-orm, express, pg, ldapts and cookie.
