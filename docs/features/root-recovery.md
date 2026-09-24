# Root recovery: restore one administrator without touching anything else

`proxypilot recover` is the break-glass path for an installation whose
operator cannot sign in: a lost password, a lost or replaced authenticator, a
lockout, a passkey on a device that is gone, or — once the identity provider
work lands — a directory or Keycloak that is down. It runs on the host as
root, over SSH or the console, against the backend's live SQLite file, and
needs nothing else to be up: not the dashboard, not Docker, not LDAP.

It replaces what `reset.sh` used to do (clear the credentials in `.env` and
delete the database so first-boot setup ran again, which destroyed every
service, route, user and audit row — and on a current install did not even
work, because the database had moved; `docs/known-issues.md`). `reset.sh`
still exists with the same commands and now delegates to this command.

## What it does, and only when asked

```
sudo proxypilot recover status
sudo proxypilot recover admin <username> --password [--totp] [--unlock] [--passkeys] [--revoke-mcp-keys] [--promote]
sudo proxypilot recover admin <username> --create --password
```

| Flag | Effect on the named account |
| --- | --- |
| `--password` | A new password: generated and shown **once** (24 characters), or taken from `--password-file` / `--password-stdin`. Hashed with bcrypt cost 12, the same as the login handler. `password_change_required` is set so the first login changes it. The lockout is cleared |
| `--totp` | The second factor is cleared (`totp_secret = ''`, `totp_enabled = 0`). The next password login lands in the existing "TOTP setup required" branch of `routes/auth.js` and enrols a new authenticator. TOTP is never disabled for the installation, and never for another account |
| `--unlock` | `failed_attempts`, `last_failed_at` and `locked_until` cleared |
| `--passkeys` | The account's WebAuthn credentials deleted. Without the flag they stay, and the plan says how many |
| `--revoke-mcp-keys` | MCP bearer tokens the account minted get `revoked_at`. Without the flag they stay valid, and the plan says how many |
| `--promote` | A `user` or `pending` **local** account becomes an administrator as part of the recovery |
| `--create` | A **new** local administrator with this name: password required at first login to change, TOTP enrolled at first login. For an installation whose only administrators are directory-backed and the directory is down |

**Every recovery also does three things**, because the old credentials are
presumed lost or exposed: it revokes the account's live sessions, closes its
elevation (sudo) grants, and forgets its trusted devices (the rows that let a
browser skip TOTP).

**It never touches**: any other account, application data, the `.env` file
or the keys in it. The database and `.env` are one recovery set; this
command changes rows in the first and leaves the second alone. Encrypted
values (TOTP secrets, LDAP bind passwords, S3 credentials) are not read.

## What it refuses

| Situation | Result |
| --- | --- |
| Not root | exit 3, nothing opened |
| Unknown account | exit 2, listing the local administrators (names only) |
| A directory-backed (`auth_source = 'ldap'`) account | exit 2: it has no local password to restore; recover a local administrator or `--create` one |
| A non-administrator without `--promote` | exit 2 |
| `--create` for a name that exists, an invalid name, or with `--totp`/`--unlock`/`--passkeys`/`--revoke-mcp-keys`/`--promote` | exit 2 |
| No terminal and no `--yes` | exit 2 before any change |
| A password shorter than 12 characters | exit 2 after the plan, before the backup and the write |
| The row changed between plan and apply (re-created under another id, flipped to LDAP) | exit 2, transaction rolled back, no audit row |
| A database missing the current schema | exit 2, naming the missing tables or columns |

## How a run goes

1. **Locate.** `.env` (default `/opt/proxypilot/.env`) is read for
   `DATABASE_PATH`, `DOMAIN` and `ADMIN_USERNAME` only. The container path
   install.sh writes (`/data/db/proxypilot.db`) maps onto the bind mount
   (`<install>/data/db/proxypilot.db`); `--db` overrides; the pre-2026
   `data/proxypilot.db` is tried last.
2. **Plan.** The account's non-secret standing is read (the hash and the
   TOTP secret leave SQL only as present/absent flags) and the exact steps
   and row counts are printed, with warnings for what the plan leaves in
   place. `--dry-run` stops here.
3. **Confirm.** On a terminal, type the username. `--yes` skips this and is
   required when there is no terminal.
4. **Password.** Generated, or read from the file / stdin. Never argv: no
   option takes a secret value, so neither `ps` nor shell history sees it.
5. **Backup.** `VACUUM INTO <db>.recovery-<timestamp>.bak` next to the
   database, mode 0600, a consistent copy taken by SQLite itself.
   `--no-backup` skips it.
6. **Apply.** One `BEGIN IMMEDIATE` transaction: the row is re-read and must
   still be the one planned for; the steps run; an `audit_log` row is
   written (`action = 'ROOT_RECOVERY'`, `user_id` NULL because host root is
   not a dashboard user, `ip_address = 'console'`, details carrying the
   username, the actions, per-step row counts, the uid, host and tty — no
   hash, no password, no secret); commit. Any failure rolls everything back.
7. **Report.** The steps applied, the audit id, the backup path, the login
   URL and what to do next. The generated password is printed exactly once
   (in `--json` mode it is the `password` field of the single result).

## Reading the status

`sudo proxypilot recover status` lists every account with its role, source,
whether a password and a second factor are set, whether it is locked, and
its live sessions, passkeys and MCP keys — never a secret. Two warnings
matter:

- **No local administrator exists.** With the directory down nobody can sign
  in; `--create` one.
- **An administrator has no password.** First-run web setup requires a
  root-issued installation credential. For an unclaimed local administrator:

  ```sh
  sudo proxypilot recover bootstrap <username>
  ```

  The command writes a 256-bit, one-use credential to a new mode-0600 file under
  `/run/proxypilot-bootstrap` (directory mode 0700) and prints only its path and
  15-minute deadline. Read it locally as root, enter it with the username and
  new password in the setup form, then remove the file. It is never placed in a
  URL, command argument or routine log; the database stores only its hash and
  lifecycle state. The runtime delivery file disappears on host reboot.

  Issuing again retires any prior credential. It never resets an initialized
  account, LDAP account, SSO-linked identity or existing passkey. For those
  local account recovery needs, use the existing `recover admin` ceremony.

## Initial setup and interrupted enrollment

Migration 1015 adds installation-bound, one-use bootstrap state. Upgrading an
unclaimed account leaves it locked until root issues a credential. It does not
change any initialized user's password, factor or link. Public status reports
only whether setup is needed; it does not expose a username. The server checks
proof both before password hashing and atomically with the password write.
Concurrent claimants cannot both succeed.

After a valid claim, the session allows only MFA completion and logout. If the
browser closes or the backend restarts during enrollment, sign in with the
chosen password to restart MFA enrollment. If the bootstrap credential expired
before claiming, issue another locally. A host reboot removes the delivery
file; root can reissue without reopening anonymous setup. If the chosen password
is lost, use `recover admin --password` (and the existing factor recovery options
only when needed). No data, encryption key or unrelated account is reset.

Tests in `security-bootstrap.test.js` exercise actual HTTP dispatch with the
same credential issuer as the CLI, including LDAP/SSO refusal, replay, expiry,
concurrent claims and completion. The native database migration test also starts
a second process to verify restart behavior.

## Where it runs from

The command is part of the CLI install.sh copies to `<install>/cli` and
wraps at `/usr/local/bin/proxypilot`, so it has Node and `better-sqlite3`
from the CLI's own `node_modules` and does not depend on the backend's
container image. `bcryptjs` was added to the CLI's dependencies for it.
`reset.sh` runs the same command; `PROXYPILOT_BIN` points it at another
wrapper and `USERNAME=<name>` picks an administrator other than the one in
`.env`.

## Tests

`admin/backend/src/__tests__/root-recovery.test.js` drives the pure modules
and the command end to end against a real SQLite database (`node:sqlite`,
the engine `better-sqlite3` wraps on a host) seeded with the backend's
current table shapes, five accounts (two local administrators, one LDAP
administrator, one user, one locked administrator), sessions with and
without sudo grants, passkeys, trusted devices, MCP keys, permissions,
settings, a service row and an encrypted LDAP secret. Every other row is
snapshotted before and compared after; the audit row is checked for the
absence of the password, the hash and any `enc:v1` material; the backup is
opened and shown to hold the pre-recovery hash; the refusals are exercised
for root, terminal, confirmation, password length, directory accounts,
schema and the changed-underneath race.

## Host acceptance (not yet run)

On a real installation, still to record: run `recover status` against the
live file while the container is up (WAL, cross-process lock), recover a
test administrator with `--password --totp`, sign in in a fresh browser with
the printed password, be walked through TOTP enrolment and the password
change, confirm the dashboard's other accounts and every service are as
they were, and confirm the audit entry appears on the Security page.


## G3 SSO recovery

This command is unchanged by G3. The guided SSO setup retains local credentials and
adds a separate administrator-network-restricted recovery hostname through Caddy.
Use this command if necessary, then sign in locally on that hostname and open
**Local administrator recovery** to disable SSO with fresh local password/TOTP or
a separately enrolled local recovery passkey. Keycloak may be unavailable. A public
Keycloak or ProxyPilot passkey is not automatically a recovery-host credential.
See [guided SSO recovery](guided-sso.md#independent-local-recovery-and-disabling-sso)
for hostname/RP settings, activation checks and the outage contract. The production
root-console acceptance above remains distinct from disposable browser evidence.
