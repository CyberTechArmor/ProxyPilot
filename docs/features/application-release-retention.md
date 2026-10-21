# Application release cleanup

## Where the setting comes from

An application's release retention is read for each release job
(`effectiveReleaseRetention` in `lib/app-storage/policy.js`):

1. Its **stored storage policy** (Application storage → Cleanup rules) decides
   whenever one exists. With the *Releases* rule on: `keepReleases` (2–20) and
   the `trimBeforeSeal` list; its *Build workspaces* rule decides whether a
   validation also sweeps other abandoned staging attempts. With the rule off,
   no release is removed — turning a rule off on the page really stops it.
2. Only when no policy is stored, the stored row is invalid, or mock2.db cannot
   be read, the static opt-in in
   `admin/backend/src/lib/mcp-policy/application-release-retention.json`
   applies. Nodus is listed there with `keepReleases: 2` and
   `trimBuildCache: true` (= `trimBeforeSeal: [".cache"]`), and its stored
   policy was seeded from these same numbers, so Nodus behaves exactly as
   before until someone changes its rules.
3. Otherwise nothing: an application with no stored policy and no static entry
   keeps every release, as it always has. A registered application's policy
   starts as proposals, so nothing is removed until a person turns a rule on.

Cleanup runs under the application's existing guest lease.

## Staging workspaces and transfer archives

Each validation removes abandoned generated staging attempts after checking
that prior writers stopped. The current attempt is preserved during its
build; its workspace and transferred source archive are removed after failure
or successful sealing. Interrupted cleanup is retried on the next validation.

Host transfer copies are named `bundle-app<applicationId>-<random>`, so the
storage check can tell which application one belongs to. Copies made before
2026-10 are named `bundle-<random>`; nothing records which application made
them, so the check shows them as "Needs a look".

A folder the cleanup cannot remove safely is reported and the job goes on:
the result's `cleanup.kept` lists it with its code, and the sweep before a
build records a `cleanup_incomplete` job event. Codes include `TOO_DEEP` (more
than 512 nested levels, or fewer when the process's open-file limit is low; a
storage cleanup says "This folder is nested too deeply to remove safely;
remove it by hand."), `CHANGED_DURING_REMOVAL` and `MOUNT_INSIDE`. The tree
is measured before anything is moved, so a refusal changes nothing. A live
pointer that changed still stops the job.

## The build and the seal

The stage hands the work tree to the build's service user, but `.git` stays
root-owned (0755) and its identity is recorded. The build's own git calls are
told the exact stage is safe, so `git describe` and similar commands work.

Before the seal the job stops every process the attempt's scripts started (it
kills the systemd scopes and cgroups recorded for the attempt). If one is
still alive, the release is not sealed: "A process the build started could
not be stopped, so this release was not sealed."

The seal then checks that `.git` is the same folder, still root-owned, and
that neither it nor its control files (config, HEAD, info, hooks, …) are
writable by a group or others. Otherwise: "The repository's git metadata
changed during the build, so this release was not sealed." The freeze that
makes the release read-only works through file descriptors and never follows
a link. It closes each folder to other users before it touches what is in
it.

A file that also has a name outside the build tree (a hard link, as a
package manager's store in the service user's home makes) is never re-owned:
the freeze copies its bytes into a new root-owned file in the same folder and
puts the copy in its place, so the file outside keeps its owner, mode and
content. If that file is written while it is copied, the release is not
sealed: "The build output changed while it was being sealed, so this release
was not sealed." A build tree nested more than 512 folders deep (fewer under
a low open-file limit) is not sealed either: "The build left folders nested
too deeply to seal safely, so this release was not sealed."

Read-only git in these programs (`lib/setup-engine/safe-git.js`) never runs
as root over a tree someone else could change: it runs as the repository's
owner, or as `nobody`, with that exact path marked safe, hooks, fsmonitor
and the pager off, and no system or global config or attributes file. A
filter driver the repository itself configures can therefore still run, but
only as that owner or `nobody`. When git cannot answer, the answer is
"unknown" and nothing is removed for it.

## Which releases are kept

`keepReleases` counts the **live release** and the **rollback release**, then
the newest other sealed releases until the number is reached. With the default
of 2 that is exactly live + rollback.

- The rollback release is the release that was live before the current one.
  It is identified, never guessed from folder times:
  1. the path ProxyPilot recorded for the previous live commit;
  2. else the sealed release whose marker names that commit;
  3. else the deploy history: the other release most recently recorded live
     before the current one (`lib/app-storage/release-history.js`
     `previousLiveRelease`, passed in by the host runner).
  A release that was rolled back FROM is never the rollback release: with
  live R5 rolled back to R4, the previous release is R3, not the failed R5.
  Rollback jobs and automatic restores record the release they replaced
  (`rollbackOf` in the live record) for this. Each live record also carries
  the earlier rollbacks forward (`rolledBackFrom`, the newest 50), so a second
  rollback does not erase the first: R5 → R4, then R6 → R4 still gives R3.
- Verifying a live release keeps its recorded previous release (before
  2026-10 `application_verify` dropped it).
- **When nothing identifies the previous release, no release is removed.**
  Every sealed release is kept and the storage check shows them as protected:
  "The previous release could not be identified, so no release is removed
  until the next deployment records it." Workspaces and bundles are still
  cleaned. A validated release that was never deployed is never taken for the
  rollback release.
- These roles are decided in one place, `describeReleases`
  (`lib/setup-engine/application-release-cleanup.js`), which the release job,
  the storage cleanup and the storage check all use. It opens each release
  folder and its marker without following links, and reads a marker only when
  it is a regular file of at most 4 KiB.
- The **release being validated** is kept and is **not counted**, so starting a
  validation no longer deletes the rollback release. (Before 2026-10 the
  incoming release was counted, and the first cleanup of every validation
  removed the previous release before the new build had even passed.)
- A **validated candidate still waiting to be deployed** (the newest passed
  validation made after the live release was recorded) is kept and not
  counted, and so is a sealed release whose **validation has no result yet**.
  A validation that **failed** is a rejection: that release is not kept for
  it. The cap removes the oldest releases outside this protected set first.
- Roots backing preserved shared models/data are always kept and not counted.

So while a candidate waits for deployment the release root holds live,
rollback and candidate (plus any backing root); after the deployment the old
live release becomes the rollback and the release before it is removed at the
next validation.

Only recognized sealed release directories are eligible; unknown files and
staging symlinks are left alone. Every removal (releases, workspaces,
bundles, the pre-seal trim) goes through the one fd-relative remover
(`lib/setup-engine/safe-remove.js`), which never follows a link and never
enters another filesystem, even when the tree changes while it is removed. The live pointer is rechecked before each
obsolete-release deletion. The same predicates decide a release a person
selects in a storage cleanup (`removeSelectedRelease`): live, rollback,
candidate and backing roots are refused there too, and so is every release
while the rollback release is unknown.

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
