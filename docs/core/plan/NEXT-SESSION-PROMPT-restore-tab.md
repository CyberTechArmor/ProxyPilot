# Next-Session Kickoff — Housekeeping Restore tab

Copy everything inside the fenced block below into the first message of a
new Claude Code session.

The phased plan in `docs/core/plan/` is on a separate track — do NOT touch
any `phase-NN-*.md` file during this session. The work below sits outside
that plan.

---

```
You are picking up the Housekeeping > Restore tab.  Goal: a third tab
in the Housekeeping page (next to Backups and Cleanup) that surfaces a
unified, cross-source list of every restorable artifact ProxyPilot
knows about — local on-disk, AND every S3 destination — so an operator
on a fresh ProxyPilot install can wire up their old destinations,
discover what's there, and pull anything they need back.

Branch: claude/housekeeping-restore-tab-<short-id>
Cut from: origin/main

================================================================
CONTEXT
================================================================

Today there are TWO restorable surfaces, in two places:

  * /housekeeping → Backups tab → list of `backups` rows from the
    DB.  Already has Restore + Download buttons.  But: only shows
    what THIS dashboard's DB has a row for; an operator on a fresh
    install with empty DB sees an empty list even when their S3
    destination has a year of nightly artifacts.

  * /lxc → per-container detail dialog → snapshots panel.  Lists
    snapshots from `incus snapshot list` joined with
    lxc_snapshot_s3_exports rows.  Has Pull-to-local for S3-only
    snapshots, Push-to-S3 for local-only.  Tied to one container
    at a time; no global view.

Neither covers the "fresh install, point me at my S3, show me what
I can restore" case.  That's the gap the Restore tab fills.

================================================================
SCOPE — what you're shipping
================================================================

A `Restore` tab in admin/frontend/src/pages/Housekeeping.jsx that
renders a single grouped list with these row types:

  ROW TYPE A — `pp-backup-XXX.ppbackup` (config / config_plus_data /
    full tier).  Sourced from:
      * the `backups` DB table (rows that already have S3 metadata),
        AND
      * a live `ListObjectsV2` against every configured destination
        with prefix `<dest.prefix>/backups/` so operators see S3
        artifacts that have NO matching DB row (the fresh-install
        case).
    Each row shows: created_at, tier (parsed from the .ppbackup
    header — see lib/backup-unpack.js parseHeader; size; the set of
    locations it lives in (local / dest_a / dest_b / ...).  Action
    buttons: Restore (opens RestoreDialog), Download, Pull to local
    (S3 → local file), Push to other S3 (already-local → another
    dest), Delete (per-location, with the existing 'locked' guard
    from the snapshot-S3 delete flow).

  ROW TYPE B — LXC container snapshots.  Sourced from:
      * the `lxc_snapshot_s3_exports` DB table (every snapshot
        export the dashboard knows about), AND
      * a live ListObjects against each destination with prefix
        `<dest.prefix>/snapshots/<container>/` so snapshots from
        an OLDER ProxyPilot install whose DB the operator already
        wiped still show up.
    Each row groups by (container_name, snapshot_name) and lists
    every location.  Same per-row actions as ROW TYPE A but the
    'Pull to local' for snapshots reuses the existing
    importSnapshotFromS3 path (see lib/snapshot-s3-export.js +
    routes/lxc.js), which lands the snapshot as a NEW container
    named `<container>-<snapshot>` (operator can transfer-routes
    onto the original after).

Optional — quote/skip if it bloats the session: also surface
'orphan' S3 objects that don't fit either pattern (e.g.
`<prefix>/something-else.tar.gz`) under a `Other` group with just
Download + Delete.  Lets operators clean up unknown bucket
contents from the dashboard without an S3 client.

================================================================
NON-SCOPE — explicitly do NOT do
================================================================

  * No new backup tier.  config / config_plus_data / full are it.
  * No automatic 'restore everything' button.  Each artifact gets
    restored individually.  An operator who wants 'rebuild from
    scratch' uses Restore-production on the most-recent
    config_plus_data + Pull-to-local on each LXC snapshot.
  * No catalog cache.  Listing is live every time the tab renders
    (with a refresh button).  Rate-limit the ListObjects calls so
    a destination outage doesn't hang the page.
  * Don't touch the existing Backups tab data flow (the one that
    powers Create backup + Schedule).  This is a NEW read-only-ish
    surface that consumes the same primitives.

================================================================
BUILDING BLOCKS ALREADY IN PLACE
================================================================

You'll lean on these — read them before writing code:

Backend:
  * lib/s3.js              — clientForDestination, getObjectStream,
                              headObject (retention info), deleteObject,
                              listObjects(dest, { prefix, maxKeys })
  * lib/backup-unpack.js   — parseHeader(buf) returns { tier,
                              created_at, ... } from the .ppbackup
                              wire format
  * lib/backup-pack.js     — pack helpers (don't need them here, but
                              their wire format is what parseHeader
                              decodes)
  * lib/snapshot-s3-export.js — fanOutSnapshotExport,
                                  importSnapshotFromS3,
                                  inspectSnapshotS3Object,
                                  deleteSnapshotExport
  * lib/restore.js         — runModeA, runModeB, runModeC,
                              loadBackupBuffer (the new host-fallback
                              one)
  * routes/backups.js      — POST /:id/restore, DELETE /:id, etc.
  * routes/lxc.js          — /containers/:name/snapshot-exports,
                              /containers/:name/snapshot/:snapshotName/s3-export/:exportId/restore

Frontend:
  * pages/housekeeping/BackupsTab.jsx       — the existing tab
  * pages/housekeeping/RestoreDialog.jsx    — Dry run / Restore
                                                production picker
  * pages/housekeeping/StorageTab.jsx       — destinations list
                                                (same data shape)
  * pages/LxcContainers.jsx                 — Pull-from-S3 dialog
                                                + import progress
                                                poll

================================================================
NEW BACKEND ENDPOINTS (suggested shape)
================================================================

GET /api/housekeeping/restore-catalog?refresh=<bool>

Response shape:
  {
    backups: [
      {
        kind: 'backup',
        id_local: '<uuid>' | null,            // backups.id row, if any
        s3_keys: { '<dest_id>': '<s3_key>' }, // per-destination key
        sources: ['local', 'dest_a', 'dest_b'], // where the bytes are
        tier: 'config' | 'config_plus_data' | 'full' | 'unknown',
        size_bytes: <int> | null,
        created_at: <iso>,
        local_path: '<path>' | null,
        s3_uploaded: <bool>,
        // For S3-only rows that had no DB match: tier comes from
        // parseHeader on the first 64 KB streamed from S3, then
        // cached for the rest of the session.
      },
      ...
    ],
    snapshots: [
      {
        kind: 'snapshot',
        container_name: '<str>',
        snapshot_name: '<str>',
        s3_exports: [
          {
            export_id: '<uuid>' | null,        // DB row, if any
            destination_id: '<id>',
            destination_name: '<str>',
            s3_key: '<key>',
            size_bytes: <int> | null,
            status: 'exported' | 'pending' | 'failed' | 'deleted',
            retention_until: <iso> | null,     // from headObject when surfaced
          }, ...
        ],
        has_local: <bool>,                     // joined from incus snapshot list
        sources: ['local', 'dest_a', ...],
      },
      ...
    ],
    other: [...],                              // optional per the non-scope note
    destinations: [
      { id: <str>, name: <str>, bucket: <str>,
        reachable: <bool>, error: <str> | null },
      ...
    ],
  }

Implementation notes:
  * Live ListObjects per destination, parallel.  Per-destination
    timeouts (5s) so one dead bucket doesn't block the others.
  * Merge by (kind, identifier) so a row that has both a DB entry
    and an S3 object surfaces once with both sources.
  * Cache the parsed-header result for the lifetime of the request
    handler — don't re-parseHeader the same s3_key multiple times.

POST /api/housekeeping/restore-catalog/refresh
  No body.  Force-purges any in-process cache and re-runs ListObjects.
  Idempotent.

The per-row actions reuse existing endpoints — no new routes
needed for them:
  * Restore       → POST /api/backups/:id/restore (existing) or
                     POST /api/lxc/.../s3-export/:exportId/restore (existing)
  * Download      → GET /api/backups/:id/download (existing)
  * Pull to local → POST /api/backups/:id/pull-local (existing) or
                     POST /api/lxc/.../s3-export/:exportId/restore (existing)
  * Push to S3    → POST /api/lxc/.../snapshot/:snapshotName/s3-export
                     (existing for snapshots; needs a new equivalent
                     for backups — call out as scope creep if you
                     don't have time)
  * Delete        → DELETE /api/backups/:id (existing) or
                     DELETE /api/lxc/.../s3-export/:exportId (existing)

For S3-only rows with NO DB row: the existing endpoints all key
off the DB id.  You'll need a 'register' endpoint that ingests
an S3 object into the DB:

POST /api/housekeeping/restore-catalog/register
  Body: { kind: 'backup' | 'snapshot', destination_id, s3_key }
  Behavior:
    For backup kind: stream first 64 KB from S3, parseHeader, INSERT
      backups row with destination_id, s3_key, size_bytes,
      tier, manifest_json='{}', status='ok', s3_uploaded=1,
      local_path=NULL.  Returns the new row id.
    For snapshot kind: parse `<prefix>/snapshots/<container>/<snap>.tar.gz`
      out of the s3_key, INSERT lxc_snapshot_s3_exports row with
      status='exported'.  Returns the new export_id.
  After register, the row behaves exactly like one that was
  created via this dashboard — restore, pull, delete all work.

================================================================
FRONTEND
================================================================

New file: pages/housekeeping/RestoreTab.jsx

Layout:
  * Top row: refresh button + per-destination reachability badges.
  * Two collapsible sections: 'Backups' and 'LXC snapshots'.
    (Plus optional 'Other' if you ship that.)
  * Each section is a table with columns: Created / Tier (or
    Container/Snapshot) / Size / Sources (chips like the existing
    LXC snapshot row uses) / Actions.
  * Empty state: 'No restorable artifacts found in the local DB or
    any reachable S3 destination.'

Per-row actions render from the same chip set used today:
  * The Local chip + per-S3 chips with their own 🗑 buttons (mirror
    the LXC snapshots panel).
  * Whole-row trash → confirm dialog enumerating which locations
    will be removed (mirror the snapshot whole-delete flow).

Hook the row's Restore button to RestoreDialog (the same one
Backups tab uses); for snapshots, hook the Pull-to-local to the
LxcContainers' existing pull dialog OR factor that dialog out into
a shared component (your call — if it's <30 minutes of refactor,
do it; otherwise inline a copy and document it as TODO).

================================================================
TESTS
================================================================

  * Backend: at least one happy-path test for the catalog endpoint
    (fake S3 destination, fake backups + lxc_snapshot_s3_exports
    rows, assert merged response shape).  Plus a test for the
    'register' endpoint (parseHeader-from-stream path).
  * Frontend: not strictly required (no test infrastructure for
    React in this repo), but if you add anything, an integration
    test against the catalog endpoint via msw is welcome.
  * Backend test count baseline: 110/114 passing today (4 failures
    are pre-existing better-sqlite3 / vpn-mtu issues; documented
    in docs/known-issues.md).  Don't fix those; just don't regress
    the other 110.

================================================================
COMMIT / PUSH WORKFLOW
================================================================

Same as the rest of this branch's history:
  * One logical commit per backend route + one for the frontend
    tab is fine.  Squash within scope.
  * Push to the branch.  Do NOT open a PR unless the operator asks.
  * Final summary back to the operator: branch name, commit hashes,
    tests passing, what's left.

Hard segmentation rules:
  * Use TodoWrite to track sub-steps.
  * One tool call does ONE thing.  Don't bundle 'read 5 files +
    refactor 3 modules' in a single message.
  * When in doubt about scope or trade-offs, ASK the operator
    before writing code.

================================================================
NICE-TO-HAVES (DO ONLY IF THE CORE LANDS WITH TIME LEFT)
================================================================

  * 'Bootstrap from this S3' button at the section header:
    runs Restore-production on the most-recent config_plus_data
    automatically and surfaces the snapshot list with one-click
    Pull-to-local for each.
  * Per-destination 'Discover' button that runs ListObjects with
    higher MaxKeys + paging so an operator with 1000+ artifacts
    sees them all.
  * Search / filter box on the table for tier / container / date
    range.

If any of these stretch the session past a clean stopping point,
DROP them and document in the final summary as follow-ups.
```
