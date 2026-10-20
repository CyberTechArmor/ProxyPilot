# Rolling instance snapshot retention

## Where the limits come from

The limit for a guest in the default Incus project is, in this order:

1. Its application's **storage policy** (Application storage → Retention),
   when the policy's *Snapshots* rule is turned on: keep the newest `keep`
   (1–1000) snapshots.
2. Otherwise `admin/backend/src/lib/mcp-policy/snapshot-retention.json`.
   Nodus is listed there with three; the Nodus policy is created from the same
   number, so Nodus keeps its newest three exactly as before.
3. Otherwise no limit: the guest's snapshots are never pruned by count.

The backend and the host runner each install a provider for these limits at
start (`setSnapshotLimitsProvider`), and the limits are **re-read on every
use** — each snapshot creation, each lifecycle event, each pruning round — so
turning a rule on, off or changing its number applies to the next snapshot
without a restart. A provider that cannot be read prunes nothing (the result
says `retention limits unavailable`) rather than fall back to a guessed number.
Turning a rule on reconciles that guest at once (`reconcile()`), not only at
its next snapshot.

## How pruning works

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

Deleting a particular snapshot by hand from a storage cleanup is separate:
it is never automatic, needs its own acknowledgement, and is bound to that
snapshot's creation time (see `docs/features/application-storage.md`).
