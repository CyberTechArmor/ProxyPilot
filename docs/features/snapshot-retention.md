# Rolling instance snapshot retention

`admin/backend/src/lib/mcp-policy/snapshot-retention.json` opts named guests
in the default Incus project into a rolling snapshot count. Nodus is set to
keep its newest three snapshots. Other guests have no count limit here.

Successful snapshot creation in the setup engine prunes the oldest excess
snapshots before reporting success, under the creating job's fenced lease.
A failed creation prunes nothing. A retention failure reports that the new
snapshot exists but cleanup failed; it does not claim a successful cap.

The backend also subscribes to Incus lifecycle events, so snapshots created
through the native CLI/API trigger cleanup immediately. These deletes use
ordinary setup-engine jobs bound to the snapshot's creation timestamp.
Busy guests retry after a second; deployments and restores retain their
locks. The selected restore target is kept until the restore job finishes.
The event listener reconciles inventories on startup and reconnection.

Snapshots are ordered by creation time, including nanosecond precision.
Missing timestamps, invalid inventories, or a tie at the retention boundary
stop pruning rather than guessing. No guest files, release directories,
export archives, other instances, or independent Sanoid/ZFS snapshots are
deleted by this policy.
