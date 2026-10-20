# Application release cleanup

## Where the setting comes from

An application's release retention is read for each release job, in this
order:

1. Its **storage policy** (Application storage → Retention), when the
   policy's *Releases* rule is turned on: `keepReleases` (2–20) and the
   `trimBeforeSeal` list. Its *Build workspaces* rule decides whether a
   validation also sweeps other abandoned staging attempts.
2. Otherwise the static opt-in in
   `admin/backend/src/lib/mcp-policy/application-release-retention.json`.
   Nodus is listed there with `keepReleases: 2` and `trimBuildCache: true`
   (= `trimBeforeSeal: [".cache"]`). The Nodus policy is created from these
   same numbers, so Nodus behaves exactly as before.
3. Otherwise nothing: an application with no enabled rule and no static entry
   keeps every release, as it always has.

A policy that cannot be read applies no retention to that job (it says so in
a `retention_unavailable` job event) rather than a guessed one.

Cleanup runs under the application's existing guest lease.

## Staging workspaces and transfer archives

Each validation removes abandoned generated staging attempts after checking
that prior writers stopped. The current attempt is preserved during its
build; its workspace and transferred source archive are removed after failure
or successful sealing. Interrupted cleanup is retried on the next validation.

## Which releases are kept

`keepReleases` counts the **live release** and the **rollback release**, then
the newest other sealed releases until the number is reached. With the default
of 2 that is exactly live + rollback.

- The rollback release is the release the previous live version runs from:
  the path ProxyPilot recorded for the previous live commit, else the sealed
  release whose marker names that commit, else the newest other sealed
  release.
- The **release being validated** is kept and is **not counted**, so starting a
  validation no longer deletes the rollback release. (Before 2026-10 the
  incoming release was counted, and the first cleanup of every validation
  removed the previous release before the new build had even passed.)
- A **validated candidate still waiting to be deployed** is kept and not
  counted.
- Roots backing preserved shared models/data are always kept and not counted.

So while a candidate waits for deployment the release root holds live,
rollback and candidate (plus any backing root); after the deployment the old
live release becomes the rollback and the release before it is removed at the
next validation.

Only recognized sealed release directories are eligible; unknown files and
staging symlinks are left alone. The live pointer is rechecked before each
obsolete-release deletion. The same predicates decide a release a person
selects in a storage cleanup (`removeSelectedRelease`): live, rollback,
candidate and backing roots are refused there too.

## Trimming before sealing

New artifacts discard generated output listed in `trimBeforeSeal` after
validation and before their artifact digest is computed:

- `.cache`: removed; a tracked `.cache` refuses the step
  (`TRACKED_BUILD_CACHE`), as before.
- Any other entry (for example `node_modules/.cache`, `test-results`,
  `playwright-report`, `coverage`, `.nyc_output`): removed only when it is
  untracked and reached through real directories. A tracked entry, a link, or
  an invalid path is kept and reported in the job's `trim` event.

A tree that already carries a release marker is never trimmed
(`ALREADY_SEALED`). Existing sealed releases are not modified, preserving
their integrity evidence. No database, environment file, shared model, or live
dependency is removed.
