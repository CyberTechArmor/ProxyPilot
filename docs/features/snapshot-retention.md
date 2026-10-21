# Rolling instance snapshot retention

## Where the limits come from

The limit for a guest in the default Incus project comes from
`effectiveSnapshotLimits` (`lib/app-storage/policy.js`):

1. Its application's **stored storage policy** (Application storage → Cleanup
   rules) decides whenever one exists: with the *Snapshots* rule on, keep the
   newest `keep` (1–1000) snapshots; with it off, the guest has no limit and
   nothing is pruned. A new Dev Studio project (created empty after this
   feature was installed) has its default rules stored and audited the first
   time either the backend or the host runner resolves them; a registered,
   cloned or older application starts with the rule proposed (off).
2. Only when no policy is stored, the stored row is invalid, or mock2.db cannot
   be read, `admin/backend/src/lib/mcp-policy/snapshot-retention.json` applies.
   Nodus is listed there with three, and its stored policy was seeded from the
   same number, so Nodus keeps its newest three exactly as before until
   someone changes its rules.
3. Otherwise no limit: the guest's snapshots are never pruned by count.

The backend and the host runner each install a provider for these limits at
start (`setSnapshotLimitsProvider`). The limits are cached for at most 30
seconds (`memoizeLimits`); a saved policy drops the backend's cache at once,
so turning a rule on, off or changing its number applies to the next snapshot
without a restart. An "unavailable" answer is never cached, and a provider that
cannot be read prunes nothing (the result says `retention limits unavailable`)
rather than guess a number. Turning a rule on reconciles that guest at once
(`reconcile()`), not only at its next snapshot, and the limits are applied
again at every backend start.

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
