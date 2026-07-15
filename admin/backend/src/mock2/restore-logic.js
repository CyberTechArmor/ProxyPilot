// Mock2 checkpoint-restore PURE decision layer. Native-free, unit-tested
// stub-first (risk R9). Every build checkpoint is a point in time (a git commit
// in the project's bare repo + a hash-chained change record); RESTORE rolls the
// project's working state — code AND the in-container Postgres database — back
// to one of those points, as a NEW checkpoint. Nothing is deleted or rewritten:
// the chain stays append-only (the framework-registry idiom — revert = a new
// version carrying old content), and the next build simply works off whatever
// HEAD now holds. The default, with no restore, is the latest checkpoint —
// "what was currently built".
//
// The database ride-along: buildDbSnapshotScript dumps the ADR-008 in-container
// Postgres (postgres://app:app@127.0.0.1:5432/app) into DB_SNAPSHOT_PATH right
// before each build checkpoint commits, so the commit itself carries the DB at
// that point in time — and survives rehydrate, which depends only on the bare
// repo (ADR-006). Restore replays the snapshot found in the RESTORED tree.

// Where the per-checkpoint database snapshot lives inside the working clone.
export const DB_SNAPSHOT_PATH = 'state/db/snapshot.sql';

// Paths that must SURVIVE a restore: the change-record mirrors are the
// append-only history (rehydrate reads them if mock2.db is lost — ADR-006);
// rolling them back would amputate the very history the restore appends to.
export const RESTORE_PRESERVED_PATHS = Object.freeze(['state/changes']);

export function isValidCommitSha(sha) {
  return /^[0-9a-f]{7,40}$/i.test(String(sha || '').trim());
}

// Pure request validation for the restore route. `record` is the change record
// picked by seq (or null), `latestSeq` the project's newest chain seq.
export function validateRestoreRequest({ record, latestSeq, runningCycles = 0, lifecycle = 'active' } = {}) {
  if (lifecycle !== 'active') {
    return { ok: false, error: `Project must be online to restore (it is "${lifecycle}").` };
  }
  if (Number(runningCycles) > 0) {
    return { ok: false, error: 'A build is running — wait for it to finish (or interrupt it) before restoring.' };
  }
  if (!record) return { ok: false, error: 'No such checkpoint in this project\'s history.' };
  if (!isValidCommitSha(record.commit_sha)) {
    return { ok: false, error: `Checkpoint #${record.seq} has no commit to restore to (it predates checkpointing).` };
  }
  if (Number(record.seq) === Number(latestSeq)) {
    return { ok: false, error: `Checkpoint #${record.seq} is already the current state — the next build works off it by default.` };
  }
  return { ok: true };
}

// Dump the in-container Postgres (ADR-008: role app, db app) into the working
// clone so the NEXT checkpoint commit carries the database at that point in
// time. Best-effort by design — always exits 0: a container without Postgres
// (install is non-fatal at provision) just skips, and a dump failure must never
// fail the checkpoint it rides on.
export function buildDbSnapshotScript({ appDir = '/srv/app' } = {}) {
  return `set -e
APP_DIR="${appDir}"
[ -d "$APP_DIR" ] || exit 0
mkdir -p "$APP_DIR/$(dirname '${DB_SNAPSHOT_PATH}')"
if command -v pg_dump >/dev/null 2>&1 && su - postgres -c "psql -tAc 'SELECT 1'" >/dev/null 2>&1; then
  # --clean --if-exists: replaying the snapshot resets schema AND data, so a
  # restore lands exactly on the dumped state instead of layering on top.
  if su - postgres -c "pg_dump --clean --if-exists app" > "$APP_DIR/${DB_SNAPSHOT_PATH}.tmp" 2>/dev/null; then
    mv "$APP_DIR/${DB_SNAPSHOT_PATH}.tmp" "$APP_DIR/${DB_SNAPSHOT_PATH}"
    echo "[mock2] db snapshot written to ${DB_SNAPSHOT_PATH}"
  else
    rm -f "$APP_DIR/${DB_SNAPSHOT_PATH}.tmp"
    echo "[mock2] db snapshot failed (non-fatal)"
  fi
else
  echo "[mock2] no postgres — db snapshot skipped"
fi
exit 0
`;
}

// The restore script run inside the container. Append-only by construction:
// 1. any uncommitted work is checkpointed first (nothing is ever lost),
// 2. the working tree + index are reset to the TARGET commit's tree
//    (git read-tree -u --reset), with RESTORE_PRESERVED_PATHS carried across,
// 3. the database is replayed from the snapshot the restored tree carries
//    (best-effort — an old checkpoint from before snapshots just skips),
// 4. the result is committed as a NEW commit (--allow-empty so the change
//    record always gets its own sha) and pushed to the bare repo (ADR-006),
// 5. the dev service restarts so the live preview serves the restored code.
//
// Machine-readable markers on stdout (parse with parseRestoreOutput):
//   MOCK2_DB_RESTORE=restored|no_snapshot|no_postgres|failed
//   MOCK2_RESTORED_SHA=<sha of the new restore commit>
export function buildRestoreScript({ appDir = '/srv/app', commitSha, message = 'restore checkpoint' } = {}) {
  const sha = String(commitSha || '').trim();
  if (!isValidCommitSha(sha)) throw new Error('buildRestoreScript: invalid commit sha');
  const msg = String(message).replace(/["'`$\\]/g, '');
  const preserved = RESTORE_PRESERVED_PATHS.join(' ');
  return `set -e
APP_DIR="${appDir}"
TARGET="${sha}"
cd "$APP_DIR"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
git cat-file -e "$TARGET^{commit}" 2>/dev/null || { echo "[mock2] restore target $TARGET not found in repo"; exit 3; }
# 1) Checkpoint any uncommitted work first — a restore must never destroy state.
git add -A
if ! git diff --cached --quiet 2>/dev/null; then
  git -c user.name="ProxyPilot Mock2" -c user.email="mock2@proxypilot.local" \\
    commit -q -m "checkpoint: pre-restore (auto)" || true
fi
# 2) Carry the append-only history mirrors across the reset.
KEEP=$(mktemp -d)
for p in ${preserved}; do
  [ -e "$p" ] && mkdir -p "$KEEP/$(dirname "$p")" && cp -a "$p" "$KEEP/$(dirname "$p")/" 2>/dev/null || true
done
# 3) Working tree + index := the target commit's tree.
git read-tree -u --reset "$TARGET"
for p in ${preserved}; do
  if [ -e "$KEEP/$p" ]; then rm -rf "$p"; mkdir -p "$(dirname "$p")"; cp -a "$KEEP/$p" "$(dirname "$p")/"; fi
done
rm -rf "$KEEP"
# 4) Replay the database snapshot the RESTORED tree carries (ADR-008 Postgres).
if [ -f "${DB_SNAPSHOT_PATH}" ]; then
  if command -v psql >/dev/null 2>&1 && su - postgres -c "psql -tAc 'SELECT 1'" >/dev/null 2>&1; then
    if su - postgres -c "psql -v ON_ERROR_STOP=0 -q app" < "${DB_SNAPSHOT_PATH}" >/dev/null 2>&1; then
      echo "MOCK2_DB_RESTORE=restored"
    else
      echo "MOCK2_DB_RESTORE=failed"
    fi
  else
    echo "MOCK2_DB_RESTORE=no_postgres"
  fi
else
  echo "MOCK2_DB_RESTORE=no_snapshot"
fi
# 5) Commit the restored state as a NEW checkpoint and push to the bare repo.
git add -A
git -c user.name="ProxyPilot Mock2" -c user.email="mock2@proxypilot.local" \\
  commit -q --allow-empty -m "${msg}"
git push -q origin HEAD:main
systemctl restart mock2-dev.service 2>/dev/null || true
echo "MOCK2_RESTORED_SHA=$(git rev-parse HEAD)"
`;
}

// Parse the restore script's stdout markers. Never throws.
export function parseRestoreOutput(stdout) {
  const text = String(stdout || '');
  const sha = text.match(/MOCK2_RESTORED_SHA=([0-9a-f]{7,40})/i)?.[1] || null;
  const db = text.match(/MOCK2_DB_RESTORE=(restored|no_snapshot|no_postgres|failed)/)?.[1] || null;
  return { sha, db };
}

// The change-record summary for a restore — written for the history reader:
// says WHERE the project went back to and that the database rode along (or why
// it could not).
export function restoreSummary({ seq, commitSha, db }) {
  const short = String(commitSha || '').slice(0, 8);
  const dbNote = db === 'restored'
    ? 'code and database'
    : db === 'no_snapshot'
      ? 'code (no database snapshot existed at that checkpoint)'
      : db === 'failed'
        ? 'code (database replay failed — inspect the container)'
        : 'code';
  return `Restore: rolled back to checkpoint #${seq} (${short}) — ${dbNote} now match that point in time. History above is preserved; the next build works off this state.`;
}
