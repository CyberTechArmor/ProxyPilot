# Existing application release runner

This operation family manages an application already hosted in an Incus guest.
It does not install an application, rewrite its service, create an account,
create credentials, configure access, migrate its database, or convert its
deployment layout. It is separate from Dev Studio's generated application
installer.

## Supported layout

The immutable application profile names the existing guest, service, live source
path, loopback health endpoint and named npm scripts. Validation requires at
least one explicit validation script. `installScript` and `buildScript` alone do
not establish test acceptance. The scripts run as the existing service user,
without linking the application's production environment files or data into
the test directory.

Deployment requires an existing root-owned symlink at `sourceDir`, pointing into
the root-owned, non-group-writable `releaseRoot`. Its parent directories must
also be protected. The existing service must use the source path as its working
directory or refer to it in ExecStart. The running process must resolve its
working directory to the selected release. Unsupported wrappers and ordinary
live directories return blockers; this workflow never silently converts them.

Internal `preservePaths` and `envFiles` are absolute profile paths. After tests,
their corresponding paths are linked to the existing data. External paths are
untouched. Tracked-source collisions, overlapping paths and traversal through
unapproved symlink parents are refused. Database changes and migrations are
outside this first supported mode because file rollback cannot undo them.

## Durable operations

`application_validate`, `application_deploy`, `application_verify` and
`application_rollback` use the existing setup-engine queue, guest lease and
epoch fencing. A request queues only application ID, exact 40-character Git SHA,
tree SHA and immutable profile revision/digest. The independent host runner
loads its application registry from `mock2.db` next to its resolved main database;
it does not create a second registry in a checkout or run these jobs in the API
process.

Validation exports the exact commit and its ancestors through a temporary Git
repository and bundle. It does not export other branches from the mutable
canonical repository. Bundle transport uses the runner's host capability;
connector credentials remain on the host. Scripts execute in job-specific
process containment and emit status metadata rather than raw output to the
public job log.

The tested release is sealed under a unique SHA/profile/job path. Its marker
records source SHA, tree SHA, profile digest, test-evidence digest and the digest
of the actual artifact inventory, including generated output and dependencies.
Files become root-owned and read-only; data links are added separately. The
marker and parent directory are synced before publication. Deployment checks
the artifact digest again, then records the previous target before atomically
switching the symlink and restarting the existing service. Acceptance requires
the expected path/SHA, active service, matching process working directory,
successful health probe and unchanged artifact inventory.

Failure restores the recorded previous target, restarts and verifies it. An
interrupted disruptive job is resumed only into this recovery path; deployment
and scripts are not blindly replayed. An unknown current target is held for
inspection. If recovery itself fails, the job retains a stale lease with its
checkpoint. An explicit rollback request for the exact interrupted candidate
creates a fenced recovery job; unrelated operations cannot consume that hold.

## Evidence limits

The tests exercise real SQLite job persistence and fences, actual Git/temporary
filesystem artifact sealing and tamper detection, and a scripted Incus/service
adapter for release, failure and recovery orchestration. They are not a live
Incus deployment, database recovery test or physical-device acceptance.
