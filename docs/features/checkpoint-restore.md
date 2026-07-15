# Checkpoint restore (Projects / Mock2)

Every build checkpoint is a point in time: a git commit in the project's bare
repo (ADR-006) plus a hash-chained change record. Restore rolls the project's
working state — the code **and the in-container Postgres database** — back to a
chosen checkpoint. Whatever is current is what the next build works off; with
no restore that is simply the latest checkpoint ("what was currently built").

## Append-only by construction

Restore never rewrites history. It appends a NEW checkpoint whose tree is the
old one's (the framework-registry revert idiom): the git log keeps every later
commit, the change-record chain keeps verifying, and the restore itself lands
as an auditable record ("Restore: rolled back to checkpoint #N …"). Restoring
is therefore always itself reversible — restore forward to the checkpoint you
came from.

## The database rides in the checkpoint

At every build checkpoint, `checkpointAndRecord` (both runners) first dumps the
ADR-008 in-container Postgres (`pg_dump --clean --if-exists app`) into
`state/db/snapshot.sql` inside the working clone, so the checkpoint commit
carries the database at that point in time — and, like everything else in the
bare repo, it survives rehydrate. Best-effort: a container without Postgres
skips the dump and nothing fails.

On restore, the snapshot found in the **restored** tree is replayed (`--clean
--if-exists` makes it land exactly, not layer on top). Checkpoints from before
this feature carry no snapshot — those restore code only, and the UI/record
say so.

## Mechanics (`restore-logic.js` + `POST /api/mock2/projects/:id/restore`)

Editor-gated, refused while archived, while a cycle is running, or while the
project lock is held. The in-container script:

1. checkpoints any uncommitted work first (nothing is ever lost),
2. resets worktree + index to the target commit (`git read-tree -u --reset`),
   carrying `state/changes/` (the append-only record mirrors) across,
3. replays `state/db/snapshot.sql` if the restored tree has one,
4. commits (`--allow-empty`) as the new checkpoint, pushes to the bare repo,
   and restarts `mock2-dev.service` so the preview serves the restored code,
5. emits `MOCK2_DB_RESTORE=` / `MOCK2_RESTORED_SHA=` markers the route parses.

The route then inserts the hash-chained change record, mirrors it into
`state/changes/`, honors `push_on_checkpoint` remotes, and audit-logs
`MOCK2_PROJECT_RESTORE`.

## UI

Change history (Build → Change history tab): the newest checkpoint wears a
**current** chip; expanding any older checkpoint offers **Restore to this
checkpoint** (editors, project online, no build running). Pure rules are
unit-tested in `admin/backend/src/__tests__/mock2-restore.test.js`.
