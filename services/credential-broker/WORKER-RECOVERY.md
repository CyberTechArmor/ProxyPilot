# Stopped worker backup and restore

This procedure is an operator-reviewed template, not authorization to change a host. No live deployment or off-host custody test has been performed. Use the exact reviewed build and private worker configuration. The companion [broker recovery procedure](RECOVERY.md) covers broker, intake, allocator and independent-authority state; the worker archive does not replace it.

## State and custody

`worker-backup` accepts only `worker.db` and its SQLite `-wal`/`-shm` files. It requires an existing owner-only real state directory, private regular files, and no component lock or unknown files. Configured workers now hold the shared maintenance lease throughout their lifetime, so maintenance refuses running workers and workers refuse incomplete restore targets. Stop gracefully and verify the process exited before backup. Never bypass a live or uncertain lock. After a proven process crash, reconcile the PID in `worker.db.lock` against the exact service instance before explicitly removing only that abandoned component lock. A stale maintenance lease can be cleared by `recover-stopped-lease` only after its PID is demonstrably absent. An incomplete restore directory must be retained for diagnosis or explicitly discarded; restore afresh into another new directory.

Archives use AES-256-GCM with a fresh nonce, authenticated worker-specific format and encrypted manifest. The manifest pins the exact build and configuration digest (only `state_dir` is excluded to permit a new target). A broker archive cannot be interpreted as a worker archive. A private 32-byte recovery key is read from a file and never printed. Keep encrypted archives and keys in separately controlled backup custody. TLS client private keys, certificate trust, broker configuration and independent source signing keys stay outside the state archive and need their own approved custody/recovery procedure. Never put bearer capabilities in the worker state or its config. Worker session bearers remain memory-only and are absent from the archive.

## Reviewed command template

Replace paths and `REVIEWED_BUILD` with reviewed, literal values before executing. Run as the dedicated service account, with private directories already provisioned through a separately approved host step. Do not use these commands to stop/start system services without the deployment decision.

```sh
node services/credential-broker/recovery-main.mjs keygen --key-file /private-key-custody/worker-recovery.key
node services/credential-broker/recovery-main.mjs worker-backup --key-file /private-key-custody/worker-recovery.key --config-file /private-config/worker.json --build REVIEWED_BUILD --archive-file /private-archives/worker.enc
node services/credential-broker/recovery-main.mjs worker-restore --key-file /private-key-custody/worker-recovery.key --config-file /private-config/worker.json --build REVIEWED_BUILD --archive-file /private-archives/worker.enc --destination /private-state/worker-restored
```

Expected output is metadata-only JSON: worker format, file names/sizes, encrypted archive digest; then `restored:true` and `quarantine_required:true`. Values, token caches and plaintext database contents are never printed. Existing archives and destinations are not overwritten. Wrong keys, modified bytes, wrong build/config pins and mixed broker/worker inventory fail closed. Publication stages verified bytes privately under a lease and incomplete marker: an I/O failure leaves an unstartable target, not a partially usable worker.

## Activation and replay boundary

Restore into a new state directory. Keep the old worker stopped: do not run two copies with the same workload identity. Point a reviewed copy of the same worker config at the restored state only after reconciling uncertain upstream operations and inspecting the metadata-only status receipts. Restored unfinished tasks become `interrupted`; possible-send tasks become/remain `uncertain`. No restored task resumes automatically, and the worker refuses both a duplicate task ID and continuation of an interrupted/uncertain task. Historical terminal outcomes are historical evidence, not current readiness. No restored bearer can be recovered because no bearer was persisted.

A worker restart does not itself revoke any capability previously copied out of process. Before restoring after compromise, independently end/revoke the affected broker tasks/sessions and rotate compromised workload TLS identity through the approved custody procedure. Verify old capabilities deny use. Restoring the worker does not restore or weaken current broker authority. Restoring the broker as well additionally requires its new boot challenge, fresh independent signed snapshots and exact human policy reaffirmation. Durable task reservations prevent reissuing the old epoch even if worker backup predates it. Current independent source state must preserve endings/revocations; never republish stale source snapshots to make a restore pass.

Only a new explicitly approved task registration with current user/project/agent, grant, configuration revision, guide/check/environment readiness and new attempt/fence can proceed. A possibly accepted write requires reconciliation and a separately approved linked recovery operation; changing task ID is not permission to retry that write. Dashboard historical receipts and current worker/broker status may differ after rollback; expose the mismatch and reconcile rather than replay.

## Disposable rehearsal evidence

`node --test services/credential-broker/test/worker-recovery.test.mjs services/credential-broker/test/recovery.test.mjs services/credential-broker/test/recovery-authority.test.mjs` passes 11 tests. Worker tests cover actual SQLite files, authenticated encrypted CLI roundtrip, worker/broker archive separation, exact pins/no overwrite, maintenance and component lock refusal, incomplete-restore refusal, a child process exiting after a durable possible-send record, no transport during restoration, memory-only canary exclusion, and actual Ed25519-signed authority revocation/new-registration gates. Broker tests cover tampering, unsafe paths, publication I/O failure and restored broker quarantine with fresh signed boot snapshots. These are disposable local proofs, not a production backup, off-host restore or live pilot.
