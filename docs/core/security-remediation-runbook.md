# Deploying the September 2026 security remediation

Repository merges do not deploy these changes. S1–S5, S7 and S8 are fixed in
source with regression coverage. **S6 remains partially implemented/open**;
see [the host boundary record](security-host-boundary.md). The dashboard still
has host-root-equivalent authority. Keep dashboard, local recovery and MCP
origins on a controlled management network/VPN with trusted administrators.
Preserve the application's existing origin/SSO allowlists. Do not treat an
ordinary reverse proxy or successful login as host isolation.

## Before deployment

- Retain working host SSH/console root access and a known local administrator's
  factors/passkey. Read `docs/features/root-recovery.md`. Confirm
  `sudo proxypilot recover status` identifies the correct installation. Avoid
  putting generated credentials in session transcripts or tickets.
- Back up the SQLite database consistently with SQLite's backup mechanism and
  protect the associated `.env`/encryption keys, Compose configuration, Caddy
  files, application artifacts and required guest/storage backups as a recovery
  set. Do not copy only an active SQLite main file while ignoring its WAL. Test
  restoration on a disposable host. Preserve stable encryption keys.
- Record the deployed commit/image and the target commit. Review local changes
  and custom logging before update. The updater refuses custom Caddy formats it
  cannot safely redact. Use standard supported logging or have the configuration
  reviewed; do not bypass the guard or resume credential-bearing URL logs.
- Host Node must be 22.15+ or 24 LTS; shipped container uses Node 24. The updater
  now verifies/reuses a compatible pair or installs Node 24 on supported root
  Debian/Ubuntu updates before application changes. Hosts already stopped by
  the earlier pre-fetch Node gate need the one-time checkout recovery in
  [the update guide](../features/self-update.md#recovering-a-host-already-stopped-at-the-old-node-version-gate). Agent builds
  use Go 1.27.1 with pinned download checksums. The dependency scan record is
  `security-dependency-scan-2026-09.json`. Images/OS packages were not scanned in
  this environment and need the deployment's image/host scan.
- For Docker installs, run the read-only preflight from the target checkout:
  `python3 scripts/check-update-privileges.py /opt/proxypilot` (adjust the install
  directory). Docker Compose v2 must resolve the effective configuration.
  Restricted/custom backends are refused before deployment changes. Preserve
  their running image/configuration and review a compatible migration; do not
  remove restrictions to bypass this check. The updater no longer restores
  privileged mode automatically.
- The agent now requires a kernel peer UID allowed by its root-managed service
  configuration. Standard rootful deployments use UID 0. Native non-root or
  user-namespace deployments need review of the actual host-visible UID and a
  root-owned systemd override for `--client-uids`; do not use group membership
  or a user-supplied UID claim as proof. Verify on a disposable equivalent host.

## Expected account and key transitions

| Change | Operator/user action |
| --- | --- |
| S1 service permissions | Review explicit service read/write grants. Delegated static editors retain granted content access; host/Compose/routing operations require admin and elevation. Missing/untrusted Compose manifests are refused; no host-wide prune runs on destroy |
| S2 terminals | Host terminals require local administrator proof within five minutes and sudo; SSO operators use the configured local recovery origin. Guest users need proxy feature permission and a write grant on the exact guest service. Add only deliberate exact development origins |
| S3 migration 1012 | Existing sessions/sudo and fingerprint-only trusted devices are invalidated once. Announce sign-in with existing MFA/passkeys. Passwords, TOTP seeds and passkeys are preserved |
| S4 migration 1013 | Unfinished-enrollment sessions and MCP authority are retired. Password login resumes limited enrollment; finish MFA before normal access. Factor replacement needs the current factor/password (or supported passkey proof), then signs out existing sessions |
| S5 migrations 1014/1016 | Dashboard roots with unique matching creation audits resume with their original scope, expiry and secret. Unverified historical keys remain paused: use **Restore connection**, choose scope/expiry and save with fresh local admin proof. **Allow all tools** is the new-connection default and really grants the full catalog, including self-edit. Saving existing access preserves the secret/URL and establishes a new root grant. Child containment and revocation remain enforced |
| S5 logging | Prefer bearer headers. Verify MCP URL credentials, Authorization, Cookie and Referer are removed from both Caddy access/runtime output and application errors; inspect with a disposable sentinel, never a live token |
| S8 migration 1015 | Initialized accounts keep their identity and factors. Public setup exposes no username. Unclaimed local admins require a root-issued bootstrap credential and then limited MFA enrollment |

For a new or still-unclaimed local administrator, the installer issues a
15-minute credential file. If it expires, is lost on reboot or was never issued:

```sh
sudo proxypilot recover bootstrap <username>
```

The command prints only the path and expiry. Open the root-owned 0600 file
locally, enter the credential in the setup form over the correct HTTPS origin,
then remove the file. Never send it as a URL, command argument or chat message.
Reissue invalidates previous proof. After the password was claimed, an
interrupted MFA enrollment resumes through password sign-in. For lost existing
credentials, use the documented `recover admin` ceremony, not public bootstrap,
and never delete the database to reopen onboarding.

## Deploy and verify in the maintenance window

Use the supported installation/update process after successful disposable-host
acceptance and backup. Existing update failure/maintenance recovery and job
fencing remain in place. Record the actual installed SHA; an up-to-date version
label alone does not prove which fixes are running.

Verify application health, schema migration records 1012–1016 and a successful
local MFA/passkey login. Check Keycloak/Pomerium sign-in and local recovery from
their configured origins. Use test identities for denied service access,
pending/enrollment-only API and WebSocket denial, delegated guest success,
host-terminal fresh proof, and already-open terminal revocation. Quiet terminal
checks run every five seconds; SSO's existing status cache may add up to sixty
seconds.

Refresh the MCP client tool list after upgrade; review any keys still awaiting
review in MCP Access before reconnecting automation. Test one
allowed operation and one denied cross-resource/child-escalation operation.
Check real job runner heartbeat, a non-destructive setup/lifecycle job, and
backup/restore verification on disposable resources. Confirm agent ping and
required typed methods under the deployed UID/socket permissions. An agent
outage test must not activate any newly migrated privileged fallback; legacy
storage/backend paths remain an S6 blocker, explicitly not a passing result.

Inspect login, factor replacement, MCP review and host-terminal entry at desktop
and 360px widths, including keyboard navigation and visible errors. The MCP correction was browser-tested at 360/375/390/768/1280/1920px with
Lighthouse mobile accessibility 98; the other security-flow browser checks
were not executed in the coding environment. Also run a real sibling-
origin WebSocket rejection test; source tests used actual upgrades with explicit
Origin headers and a fake PTY.

## Recovery and rollback limits

- Retain the management-network restriction during any failure. Read the update
  record and preserve its checkpoint/recovery artifacts; do not blindly rerun
  an uncertain storage, deploy or restore operation.
- Use root recovery for a specific local account. It preserves unrelated data
  and encryption keys. Inspect the plan and backup path before applying it.
  Restoring a whole historical database can restore revoked credentials and
  bypass security migrations; treat it as a security-sensitive recovery with
  access containment, not an ordinary sign-in repair.
- Rolling code back can reopen service authorization, MFA, delegation or public
  bootstrap vulnerabilities. It does not automatically reverse migrations or
  restore sessions/device trust. Do not delete migration rows or restore old
  fingerprint/key authority to make an old build work.
- Restore a compatible, reviewed database/config/key/image set on an isolated
  host and verify before switching traffic. Keep a security-fixed release where
  possible. Never regenerate encryption keys to address a startup failure.
- The restrictive-update preflight intentionally stops unsupported migrations.
  Preserve the prior image and configuration and resolve the missing typed
  operations. There is no automatic opt-out that reinstates privileged mode.

## Evidence and remaining checks

[The remediation ledger](security-remediation-2026-09.md) records per-finding
implementation, tests and compatibility. Security CI runs actual HTTP/auth/DB,
WebSocket (fake PTY), MCP dispatch (recorded host boundary), native migration,
root bootstrap, recovery and dependency regressions; frontend production build;
Go vet/race tests and vulnerability scanning; Python logging/update guards; and
the host-interface inventory check. Hosted CI exercises Unix sockets denied by
the local sandbox.

Production deployment, representative fresh install/upgrade, Docker/Incus/Caddy
integration, image/OS scanning and browser visual checks were not performed.
Those are operator acceptance gates. S6 additionally needs the remaining code
contracts, independently enforced broad-operation grants and removal of direct
backend host interfaces; host testing alone cannot close it.
