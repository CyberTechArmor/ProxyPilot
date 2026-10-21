# Application storage: check, cleanup, retention and alerts

**Where to find it:**
- Dashboard: **Application storage** (`/storage/applications`, admin only). It is also reachable from an
  application's **Releases** tab and from a Dev Studio project's **Manage** tab (the **Storage** button).
- API: `/api/app-storage`.
- Code:
  - `admin/backend/src/lib/app-storage/`;
  - the `storage_cleanup` setup-engine job (`lib/setup-engine/storage-cleanup-op.js`);
  - the shared remover and read-only git (`lib/setup-engine/safe-remove.js`, `lib/setup-engine/safe-git.js`);
  - `routes/app-storage.js`, `pages/AppStorage.jsx` and `components/app-storage/`.
- Data: mock2.db migrations 560 (`mock2_storage_checks`, `mock2_storage_policies`, `mock2_storage_cleanups`,
  `mock2_storage_samples`) and 561 (a small summary stored next to each check).

It covers both kinds of hosted application: registered existing applications (for example Nodus in `pp-nodus`)
and Dev Studio projects (`m2-<id>`). Each is a *target*, `application:<id>` or `project:<id>`.

## The storage check (read-only)

**Request storage check** runs a fixed, read-only program inside the container, plus a few read-only host
commands.
- It never writes and never follows a symbolic link.
- It reads no file contents except a release's small marker file and `.git` link files.
- It executes nothing from the application. Where it asks git which files are tracked (`ls-files`, which reads
  the index only), git runs as the repository's owner, or as `nobody` when that owner is root. The exact path is
  marked safe. `core.fsmonitor`, hooks, the pager, the attributes file and the system and global configuration
  are turned off.

It shows:

- **Totals:**
  - what the container uses and has available, and its disk limit;
  - the space on disk including snapshots, and the space only snapshots hold;
  - memory-backed folders such as a tmpfs `/tmp`, shown apart because they use memory, not disk;
  - what was measured item by item, and the remainder that was not (an estimate).

  On a storage pool that is not ZFS, the figures are the host's shared disk. The page says so, and the
  remainder is not estimated from them.
- **Categories:**
  - the running application, dependencies, and application data (databases, uploads, models, settings);
  - releases, build workspaces, and source and transfer archives;
  - caches, test reports, temporary files, logs and execution history;
  - snapshots, exports, and other or unclassified storage.

  Each category has sizes on disk and in memory, counts, the last change and a status. Each expands to its items;
  groups of similar temporary entries expand to their members.
- **Sizes:**
  - Space on disk (after compression) is shown beside file sizes (before compression).
  - A file with several hard links is counted once.
  - A walk that hit its time or entry budget, or could not read part of an item, says "at least".
  - Computed figures say "about".
- **When:** when the check ran, and every area it could not measure and why. Examples: a stopped container, no
  Node.js in the container, unreadable folders.

Each item is **Protected**, **Can be cleaned up** or **Needs a look**, with the reason in plain words.
- An item can be cleaned up only when a rule recognises it by its location *and* its name or marker. Where the
  rule says so, it must also meet an age, show that no process uses it, or show that git does not track it.
- Size or age alone never makes anything removable. Anything unrecognised is "Needs a look", and so is an item
  whose age could not be measured when the rule depends on age.

Some rules in detail:
- **Logs:** only rotated logs (`.1`, `.gz`, `.xz`, `.old`, `-YYYYMMDD`) are ever eligible.
  - A current log the application wrote recently, or holds open, is protected.
  - One nothing has written to for 14 days is "Needs a look".
  - The system's own records stay protected however quiet they are: package logs, installer logs, wtmp.
- **Execution history** is kept and removed in sets: a kept database dump keeps the environment copy taken with it.
- **Transfer bundles** on the host are counted only for the application whose name they carry
  (`bundle-app<id>-…`). Older bundles, which carry no application, are "Needs a look".

**Always protected:**
- the running application and its release;
- the previous (rollback) release, a validated release waiting to be deployed, and a release still being validated;
- a release folder that holds shared data newer releases link to (Nodus's models live in its adopted folder);
- an active build workspace, and declared data and preserved paths;
- settings and secret files (their contents are never read);
- database folders, and a project's own state and data;
- the source history ProxyPilot keeps, and anything a running process has open.

Leftover working copies such as `/opt/nodus-w48` stay "Needs a look". Their hint says how a person can check one
and remove it by hand; the page has no button for them.

## Cleanup

Nothing is selected when the page opens. Choose any of:

- one item, several items, or **Select all** within a category;
- **Select everything that can be cleaned up**: exactly every item marked "Can be cleaned up" in this check, in
  every category except Snapshots and Exports;
- snapshots and exports, which are only ever chosen in their own section. Deleting a snapshot removes the option
  to restore to that point. The page says so and asks you to tick that you understand before it continues.

**Review cleanup:**
- It lists the exact selection by category, and lets you remove any item from it.
- It shows the space the cleanup should recover. This is an estimate, with notes such as "space held by snapshots
  is only returned after those snapshots are deleted".
- **Clean up N items** asks for your password once (the dashboard's sudo step). After that the cleanup runs
  without further prompts.
- Choosing nothing changes nothing.

**How it runs:**
- It is a `storage_cleanup` job under the container's lease. It is refused while a build or another change holds
  the lease, and while no host runner is live.
- Before each item it re-reads the live release and checks for builds. If either changed, it stops and reports the
  rest as skipped.
- Every removal goes through one remover that works through open folders (`/proc/self/fd`):
  - Each folder is opened from `/` down without following links, and entries are removed through that open folder.
    A link swapped in while the cleanup runs is therefore refused instead of followed.
  - Anything that changes during the removal stops it (`CHANGED_DURING_REMOVAL`).
  - Another filesystem is never entered.
  - A tree nested more than 512 levels deep is refused before anything moves (`TOO_DEEP`).
- An item that changed between the check and the cleanup is put back, or set aside as `.pp-cleanup-hold-…`. A set-aside
  item shows as "Needs a look".
- An interrupted cleanup resumes from its checkpoints, and finishes only the items it had already set aside.
- Snapshots are deleted only while their creation time still matches the check.
- One failure never stops the others.

**Afterwards:**
- It checks the application's health without taking a snapshot.
  - For a registered application: the service is active, the process runs from the live release, the health URL
    answers, and the live release is unchanged.
  - For a project: its service, and its health probe on the project's own port.
- It runs a new check, and shows what was removed, what was skipped and why, what failed, and the remaining
  storage.
- It shows the space actually reclaimed: on disk, in memory and in the pool (snapshots). ZFS can take a little
  while to return space, so a small figure comes with a note to check again.
- Every request, approval, result and policy change is in the audit log: `STORAGE_CHECK_REQUESTED`,
  `STORAGE_CLEANUP_APPROVED`, `STORAGE_CLEANUP_REFUSED`, `STORAGE_CLEANUP_NONE`, `STORAGE_CLEANUP_FINISHED`,
  `STORAGE_RETENTION_APPLIED` and `STORAGE_POLICY_CHANGED`. Export deletions keep their own `LXC_EXPORT_DELETE`.

## Cleanup rules (automatic prevention)

Each target has its own rules, on the **Cleanup rules** tab:
- releases, snapshots, abandoned build workspaces and transfer archives;
- caches, temporary files, test artifacts, logs, and execution history;
- storage alerts.

Each rule shows what it would remove now, from the latest check, before you turn it on. The tab also says who last
changed the rules and when.

| Rule | Default | Runs |
|---|---|---|
| Releases | Keep 2: the live release and the previous one. A release being validated, a validated candidate, a release waiting for its validation result and shared-data folders are kept and not counted; the oldest others go first. Generated caches are removed before a new release is sealed. | During each release validation |
| Snapshots | Keep the newest 3 | After each new snapshot, and at every backend start |
| Build workspaces and transfer archives | Removed when the attempt ends (pass or fail); leftovers after 1 hour | During each validation, and every 6 hours |
| Caches | Not used for 14 days | Every 6 hours |
| Temporary files | Older than 2 days | Every 6 hours |
| Test artifacts | Older than 14 days | Every 6 hours |
| Logs | Rotated logs older than 14 days; system journal kept to 256 MB | Every 6 hours |
| Execution history | Keep the newest 2 sets, and anything younger than 30 days | Every 6 hours |

**Which defaults are on:**
- **New Dev Studio projects** start with these defaults on. That means a project ProxyPilot creates empty after
  this feature was installed. The first time the backend or the host runner resolves its rules, they are stored
  and audited once (`STORAGE_POLICY_CHANGED`, origin `defaults-for-new-project`), and the tab says so.
- **Proposals instead:** registered applications (whenever they were registered: registering adopts an
  application that already has data), cloned projects and existing projects get the defaults as **proposals**.
  Nothing destructive runs until you turn a rule on.
- **Nodus keeps its existing settings:** 2 releases with the `.cache` trim, 3 snapshots, and the build-workspace
  cleanup it already had.
  - The static files `lib/mcp-policy/application-release-retention.json` and `snapshot-retention.json` seed that
    policy.
  - Once a policy is stored, the page decides: turning a rule off stops it.
  - The files apply again only when no policy is stored, or mock2.db cannot be read.
  - See `application-release-retention.md` and `snapshot-retention.md`.

**How the periodic rules run:**
- They use the same cleanup job as a manual cleanup (origin `policy`).
- They never touch snapshots, exports or releases.
- They skip a target that is busy.
- Cron: `PROXYPILOT_APP_STORAGE_RETENTION_CRON` (default `23 */6 * * *`). `PROXYPILOT_DISABLE_CRONS=1` turns the
  automation off.

**Release mechanics:**
- **Caches before sealing:** generated caches are removed from a build before it is sealed (`.cache`, and for new
  applications also `node_modules/.cache`, `test-results`, `playwright-report`, `coverage` and `.nyc_output`),
  when git does not track them. An already sealed release is never modified, so its integrity check stays valid.
- **The previous release** is taken from the deployment history (`lib/app-storage/release-history.js`), never
  from folder dates. It is the release that was live before the live one was promoted, skipping any release that
  was rolled back from: live R5 rolled back to R4 keeps R3. While it cannot be identified, no release is removed
  and the check says so.
- **The build and the seal:**
  - `.git` stays root-owned through the build.
  - The build's leftover processes are stopped before the seal.
  - Sealing refuses a `.git` that changed during the build.
  - The freeze that makes a release read-only works through open folders and never follows a link.

**Changed in this release:**
- Release retention used to count the release being validated, so it deleted the rollback release at the start of
  every validation.
- `application_verify` dropped the record of the previous release, so rollback and retention fell back to folder
  dates.
- It now keeps the previous release and carries its record forward. At most three release folders exist while a
  candidate waits (live, previous, candidate), plus a shared-data folder.

## Alerts

These run next to the existing whole-pool monitoring, every 15 minutes (`PROXYPILOT_APP_STORAGE_MONITOR_CRON`):

- **Usage:** an application uses more than its warning level. The level is 10 GB for Nodus; for others, 80 % of
  the container's disk limit, or 20 GB. It becomes an error at 1.5 times the level, and resolves below 95 % of it.
- **Growth:** an application grew by more than its growth level within its window (default 2 GB in 24 hours).
- **Cleanup:** a cleanup or retention run had failures.
- **Health:** the health check after a cleanup failed.
- Cleanup and Health alerts resolve after the next successful run.

**Delivery:**
- Alerts go to the notification bell. When an alert is new or gets worse, it also goes to every configured
  channel: push, email, SMS, and webhooks (events `appstorage.*`).
- Each alert is kept once (deduplicated) and resolved automatically.
- A dismissed alert stays dismissed while its condition holds.
- At a restart, the current conditions are checked before alerts are restored. An alert raised by the host runner
  while the backend was down is delivered once, at the next pass.
- Thresholds are set per target on the Cleanup rules tab.

## MCP

Three read-only tools: `list_application_storage`, `get_application_storage_check` and
`request_application_storage_check`. No MCP tool can start a cleanup or change a rule, and a ratchet test enforces
this. Cleanups are approved by a person in the dashboard.

## Limits

- A container without Node.js can only be measured from the host (dataset, snapshots, exports).
- A check measures each item up to a time and entry budget; larger trees say "at least".
- Space returned by deleting files does not show in the pool while snapshots still hold those blocks.
- Database contents are never cleaned; neither are uploads, models or settings.
- Windows guests and non-ZFS pools are not measured in full.
- A bind mount created inside an item while it is being removed is not detected. This needs root in the container;
  mounts that exist before the removal starts are refused.
- A filter driver the repository itself configures can still run, but only as the repository's owner or `nobody`,
  never as root.
- Nothing has run against a real container yet; the tests use scripted containers. That includes the step that
  stops the build's leftover processes before a seal.
