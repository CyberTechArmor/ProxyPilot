# Encrypted stopped-service recovery

These are operator inputs for review, not deployment authorization. No production
host, off-host backup destination, recovery key or live credential is configured.
Run as the dedicated broker service account. Production root work remains a
reviewed paste the operator runs. Never pass key values through arguments, environment,
chat or stdout. The recovery tool accepts **file paths** only.

## State and custody

Configured service must hold `acquireStateLease(config.state_dir)` for its entire
lifetime and close the lease only after every component closes. An existing lease,
component lock, unknown state file, symlink, hardlink, non-owner or group/world
accessible state fails closed. This prevents concurrent startup during backup.
The private state root contains:

- `broker.db`, plus SQLite `-wal` / `-shm` if present;
- `intake.json`, `authority.json`, `allocator.json`;
- optionally `identity.json` if a future identity implementation persists state.

Metadata and session verifiers in these files are sensitive. Backup encrypts the
entire payload with AES-256-GCM, a fresh 96-bit nonce and a dedicated random
256-bit key. Version/algorithm headers are authenticated; the encrypted manifest
pins the broker contract, reviewed build and configuration digest. Per-file size
and SHA-256 integrity checks are inside authenticated ciphertext and never printed.
The only reported digest covers the randomized encrypted archive.

The key and archive must be kept separately in existing approved encrypted
operator custody. External TLS, AppRole, OIDC and publisher signing keys are
**not** swept into state archives: keep their established custody/recovery path.
No unattended root token, token cache export or secret-bearing manifest is added.
Recovery does not supply off-host transfer, key escrow or retention automation.

## Reviewed commands

Before using these examples replace absolute paths and BUILD with reviewed values.
All parent directories and metadata configuration/key/archive files must be owned
by the service account and private (0700 directories / 0600 files). The config
contains metadata and references to secret files, never embedded secret values.

```sh
# Once, into separate protected recovery custody. Prints {"created":true} only.
node services/credential-broker/recovery-main.mjs keygen --key-file /private/recovery/broker.key

# Stop through the reviewed service manager and verify the process has exited first.
# This command itself never stops or mutates a running service.
node services/credential-broker/recovery-main.mjs backup --config-file /private/broker/config.json --build BUILD --key-file /private/recovery/broker.key --archive-file /private/backup/broker.enc

# Restore to a new private directory. Existing paths are always refused.
node services/credential-broker/recovery-main.mjs restore --config-file /private/broker/config.json --build BUILD --key-file /private/recovery/broker.key --archive-file /private/backup/broker.enc --destination /private/broker/restored-state
```

The configuration digest excludes only `state_dir`, so the reviewed configuration
may select the new state directory without weakening endpoint, identity, authority,
key-path or adapter pins. Different builds/configurations are refused; there is no
"ignore mismatch" switch. Perform any compatible version upgrade as a separate
reviewed migration against a separately retained original backup.

Restore authenticates and validates **all bytes before publication**, stages them
in a private sibling directory, then publishes to an exclusively created target
under a service lease and an incomplete-restore marker. A crash during publication
leaves the target unstartable. Never clear that marker to force startup: inspect,
discard that new target through a reviewed action, and restore again from the
unchanged archive to another new directory. Existing service state is untouched.

After an unclean stop, the explicit command below checks the recorded PID is dead;
it refuses a live/reused PID or incomplete restore. Recover each component's own
stale lock through its reviewed stopped-process recovery function as well. PID
checks are deliberately conservative; there is no automatic lock stealing.

```sh
node services/credential-broker/recovery-main.mjs recover-stopped-lease --state-dir /private/broker/state
```

## Required reactivation sequence

1. Verify archive/build/config pins, custody, and restored files. Keep old state
   and encrypted backup until separately approved retirement.
2. Start only the reviewed service against the new state directory. Startup
   revokes saved broker sessions/approvals, marks possible sends uncertain,
   reconciles interrupted enrollment and quarantines restored policy.
3. Independent authority publishes a **fresh signed snapshot for the new boot
   challenge**. Old signatures, expired leases and dashboard assertions cannot
   reactivate authority. Compare current task/grant IDs, revisions, policy,
   credential versions and allocation slots against independent current state.
4. A fresh independently authenticated owner explicitly revalidates the exact
   connection policy. Authority must match independently current policy, not
   merely recognize the owner. Until both steps succeed, old and newly requested
   capabilities fail closed, including credential tests/rotation.
5. Reconcile incomplete enrollment with vault CAS/version readback. Restored
   allocator slots cannot justify overwriting newer vault values: CAS 0 must
   reject occupied slots. Reconcile or replace slots under reviewed provisioning.
6. Review uncertain writes; no restart, restore or linked recovery automatically
   resends. Restored old bearer values stay unusable. Explicitly issue fresh
   task-scoped capabilities only after current task/guide/Controls checks.

A backup alone cannot prove current external policy or erase previously exposed
upstream keys. Synthetic tests establish encrypted state integrity, conservative
restore mechanics and quarantine; live recovery/custody acceptance remains a
separate observed deployment requirement.

Worker state is a separate stopped-service archive. See [worker recovery and replay rehearsal](WORKER-RECOVERY.md) for the worker-specific encrypted format, lifetime lease, restored task quarantine and independent authority requirements.
