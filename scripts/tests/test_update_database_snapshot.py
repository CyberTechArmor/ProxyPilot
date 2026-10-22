"""Real SQLite and actual updater boundary tests; never touches an installed host."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/update-database-snapshot.py'
spec = importlib.util.spec_from_file_location('update_database_snapshot', HELPER)
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)
UPDATER = (ROOT / 'update.sh').read_text()


def function(name):
    return re.search(r'^' + name + r'\(\) \{\n[\s\S]*?^}', UPDATER, re.M)[0]


class DatabaseSnapshots(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pp-database-snapshot-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.core, self.mock2 = self.root / 'proxypilot.db', self.root / 'mock2.db'
        self.backups = self.root / 'backups'

    def database(self, path, value):
        db = sqlite3.connect(path)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA wal_autocheckpoint=0')
        db.execute('CREATE TABLE evidence(value TEXT)')
        db.execute('INSERT INTO evidence VALUES(?)', (value,))
        db.commit()
        return db

    def value(self, path):
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            return db.execute('SELECT value FROM evidence').fetchone()[0]

    def change(self, path, value):
        with sqlite3.connect(path) as db:
            db.execute('UPDATE evidence SET value=?', (value,))

    def test_wal_contents_become_private_standalone_pair_and_reopen(self):
        core, mock2 = self.database(self.core, 'core-committed-in-wal'), self.database(self.mock2, 'mock2-committed-in-wal')
        self.addCleanup(core.close); self.addCleanup(mock2.close)
        self.assertGreater(Path(str(self.mock2) + '-wal').stat().st_size, 0)
        folder = snapshot.snapshot(self.core, self.backups)
        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.value(folder / 'proxypilot.db'), 'core-committed-in-wal')
        self.assertEqual(self.value(folder / 'mock2.db'), 'mock2-committed-in-wal')
        self.assertEqual({p.name for p in folder.iterdir()}, {'proxypilot.db', 'mock2.db', 'manifest.json'})
        for path in folder.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        data = json.loads((folder / 'manifest.json').read_text())
        self.assertTrue(all(entry['present'] for entry in data['databases']))

    def test_both_sources_are_write_reserved_together_until_snapshot_finishes(self):
        self.database(self.core, 'core').close(); self.database(self.mock2, 'mock2').close()
        observed = []
        def competing_writers():
            for path in (self.core, self.mock2):
                db = sqlite3.connect(path, timeout=0)
                try:
                    with self.assertRaises(sqlite3.OperationalError):
                        db.execute("UPDATE evidence SET value='collision'")
                    observed.append(path.name)
                finally:
                    db.close()
        folder = snapshot.snapshot(self.core, self.backups, after_reservation=competing_writers)
        self.assertEqual(observed, ['proxypilot.db', 'mock2.db'])
        self.assertEqual(self.value(folder / 'mock2.db'), 'mock2')
        self.change(self.mock2, 'after-release')
        self.assertEqual(self.value(self.mock2), 'after-release')

    def test_active_writer_and_interrupted_capture_refuse_without_a_complete_bundle(self):
        self.database(self.core, 'core').close(); self.database(self.mock2, 'mock2').close()
        busy = sqlite3.connect(self.mock2); busy.execute('BEGIN IMMEDIATE')
        try:
            with self.assertRaises(sqlite3.OperationalError):
                snapshot.snapshot(self.core, self.backups)
        finally:
            busy.rollback(); busy.close()
        self.assertEqual(list(self.backups.iterdir()), [])
        with self.assertRaises(InterruptedError):
            snapshot.snapshot(self.core, self.backups, after_reservation=lambda: (_ for _ in ()).throw(InterruptedError()))
        self.assertEqual(list(self.backups.iterdir()), [])
        self.change(self.core, 'unlocked')

    def test_restore_matches_pair_removes_failed_generation_sidecars_and_preserves_owner(self):
        self.database(self.core, 'old-core').close(); self.database(self.mock2, 'old-mock2').close()
        metadata = self.core.stat()
        folder = snapshot.snapshot(self.core, self.backups)
        self.change(self.core, 'failed-core'); self.change(self.mock2, 'failed-mock2')
        # Retain actual committed failed-generation WAL bytes after its connection
        # closes, matching a stopped/crashed writer rather than an active handle.
        db = sqlite3.connect(self.mock2); db.execute('PRAGMA journal_mode=WAL')
        db.execute("UPDATE evidence SET value='failed-in-wal'"); db.commit()
        wal = Path(str(self.mock2) + '-wal').read_bytes()
        db.close(); Path(str(self.mock2) + '-wal').write_bytes(wal)
        result = snapshot.restore(self.core, folder)
        self.assertEqual(result, {'restored': True, 'mock2': 'present'})
        for path in (self.core, self.mock2):
            self.assertFalse(Path(str(path) + '-wal').exists()); self.assertFalse(Path(str(path) + '-shm').exists())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.core.stat().st_uid, self.core.stat().st_gid), (metadata.st_uid, metadata.st_gid))
        self.assertEqual(self.value(self.core), 'old-core'); self.assertEqual(self.value(self.mock2), 'old-mock2')
        snapshot.restore(self.core, folder)  # retrying a stopped restore is safe
        self.assertEqual(self.value(self.mock2), 'old-mock2')

    def test_absent_mock2_is_recorded_and_newly_created_generation_is_removed(self):
        self.database(self.core, 'original').close()
        folder = snapshot.snapshot(self.core, self.backups)
        self.assertEqual(json.loads((folder / 'manifest.json').read_text())['databases'][1], {'name': 'mock2.db', 'present': False})
        self.assertFalse(self.mock2.exists(), 'capture must never seed a disabled Mock2 database')
        self.database(self.mock2, 'created-by-failed-start').close()
        self.change(self.core, 'failed')
        self.assertEqual(snapshot.restore(self.core, folder)['mock2'], 'absent')
        self.assertFalse(self.mock2.exists()); self.assertEqual(self.value(self.core), 'original')

    def test_invalid_pair_or_active_writer_refuses_before_restoring_either_database(self):
        self.database(self.core, 'original-core').close(); self.database(self.mock2, 'original-mock2').close()
        folder = snapshot.snapshot(self.core, self.backups)
        self.change(self.core, 'current-core'); self.change(self.mock2, 'current-mock2')
        busy = sqlite3.connect(self.mock2); busy.execute('BEGIN IMMEDIATE')
        try:
            with self.assertRaises(sqlite3.OperationalError): snapshot.restore(self.core, folder)
        finally:
            busy.rollback(); busy.close()
        self.assertEqual(self.value(self.core), 'current-core')
        self.change(folder / 'mock2.db', 'tampered')
        with self.assertRaisesRegex(ValueError, 'manifest'): snapshot.restore(self.core, folder)
        self.assertEqual(self.value(self.core), 'current-core'); self.assertEqual(self.value(self.mock2), 'current-mock2')

    def test_symlinks_or_orphan_sidecars_never_become_an_absence_claim(self):
        self.database(self.core, 'core').close()
        sentinel = self.root / 'sentinel'; sentinel.write_text('keep')
        self.mock2.symlink_to(sentinel)
        with self.assertRaises(ValueError): snapshot.snapshot(self.core, self.backups)
        self.mock2.unlink(); Path(str(self.mock2) + '-wal').write_text('orphan')
        with self.assertRaisesRegex(ValueError, 'orphan'): snapshot.snapshot(self.core, self.backups)
        Path(str(self.mock2) + '-wal').unlink()
        folder = snapshot.snapshot(self.core, self.backups)
        (folder / 'proxypilot.db-wal').write_text('unverified sidecar')
        with self.assertRaisesRegex(ValueError, 'sidecar'): snapshot.restore(self.core, folder)
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_actual_shell_stage_requires_quiescence_and_ignores_inherited_core_backup(self):
        self.database(self.core, 'core').close(); self.database(self.mock2, 'mock2').close()
        old = self.root / 'old-core-only'; old.write_text('old backup is not coverage')
        declarations = '\n'.join((function('backup_quiesced_databases'), 'log(){ :; }',
            f'SCRIPT_DIR={str(ROOT)!r}', f'DB_BACKUP_SOURCE={str(self.core)!r}', f'DB_BACKUP_FILE={str(old)!r}',
            'DB_SNAPSHOT_DIR=""', 'DB_WRITERS_QUIESCED=false'))
        result = subprocess.run(['bash', '-c', declarations + '\nbackup_quiesced_databases'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0); self.assertFalse(self.backups.exists())
        result = subprocess.run(['bash', '-c', declarations + '\nDB_WRITERS_QUIESCED=true\nbackup_quiesced_databases\nprintf "%s" "$DB_SNAPSHOT_DIR"'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        folder = Path(result.stdout)
        self.assertTrue((folder / 'mock2.db').exists()); self.assertEqual(self.value(folder / 'mock2.db'), 'mock2')
        self.assertEqual(old.read_text(), 'old backup is not coverage')

    def test_restore_interruption_leaves_bundle_retryable_and_does_not_claim_atomic_pair(self):
        self.database(self.core, 'core').close(); self.database(self.mock2, 'mock2').close()
        folder = snapshot.snapshot(self.core, self.backups)
        self.change(self.core, 'new-core'); self.change(self.mock2, 'new-mock2')
        replace = os.replace
        def interrupted(src, dst):
            if Path(dst) == self.mock2: raise InterruptedError('second replacement interrupted')
            return replace(src, dst)
        with patch.object(snapshot.os, 'replace', side_effect=interrupted):
            with self.assertRaises(InterruptedError): snapshot.restore(self.core, folder)
        self.assertTrue((folder / 'manifest.json').exists())
        snapshot.restore(self.core, folder)
        self.assertEqual(self.value(self.core), 'core'); self.assertEqual(self.value(self.mock2), 'mock2')

    def test_actual_legacy_layout_moves_sibling_and_rolls_back_pair_plus_environment(self):
        install = self.root / 'install'; (install / 'scripts').mkdir(parents=True)
        shutil.copyfile(HELPER, install / 'scripts' / HELPER.name)
        data = install / 'data'; data.mkdir()
        core, mock2 = data / 'proxypilot.db', data / 'mock2.db'
        self.database(core, 'core').close(); self.database(mock2, 'mock2').close()
        environment = 'DATABASE_PATH=/data/proxypilot.db\nUNRELATED=value\n'
        (install / '.env').write_text(environment)
        migration = function('migrate_db_layout').replace('/opt/proxypilot', str(self.root / 'absent-install'))
        code = '\n'.join(('set -e', migration, function('backup_quiesced_databases'), function('restore_db'),
            'log(){ :; }; log_verbose(){ :; }; stop_update_writers(){ DB_WRITERS_QUIESCED=true; }',
            f'SCRIPT_DIR={str(install)!r}', f'DB_BACKUP_SOURCE={str(core)!r}', 'DB_WRITERS_QUIESCED=true',
            'DB_SNAPSHOT_DIR=""', 'DB_SNAPSHOT_ATTEMPTED=false', 'backup_quiesced_databases', 'migrate_db_layout',
            'test -f "$DB_LAYOUT_NEW_MOCK2_PATH"', f'test ! -e {str(mock2)!r}',
            'printf foreign > "${DB_LAYOUT_NEW_PATH}-journal"', 'printf foreign > "${DB_LAYOUT_NEW_MOCK2_PATH}-journal"',
            'restore_db', 'test ! -e "$DB_LAYOUT_NEW_PATH"', 'test ! -e "$DB_LAYOUT_NEW_MOCK2_PATH"',
            'test ! -e "${DB_LAYOUT_NEW_PATH}-journal"', 'test ! -e "${DB_LAYOUT_NEW_MOCK2_PATH}-journal"'))
        result = subprocess.run(['bash', '-c', code], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.value(core), 'core'); self.assertEqual(self.value(mock2), 'mock2')
        self.assertEqual((install / '.env').read_text(), environment)

    def test_legacy_layout_refuses_any_target_generation_or_dangling_sidecar_before_moving(self):
        for name in ('proxypilot.db', 'mock2.db'):
            for suffix in ('', '-wal', '-shm', '-journal'):
                for link in (False, True):
                    with self.subTest(name=name, suffix=suffix, dangling_link=link):
                        install = self.root / f'conflict-{name}-{suffix}-{link}'
                        data = install / 'data'; (data / 'db').mkdir(parents=True)
                        core, mock2 = data / 'proxypilot.db', data / 'mock2.db'
                        self.database(core, 'core').close(); self.database(mock2, 'mock2').close()
                        (install / '.env').write_text('DATABASE_PATH=/data/proxypilot.db\n')
                        conflict = data / 'db' / (name + suffix)
                        if link: conflict.symlink_to(self.root / 'absent-target')
                        else: conflict.write_text('foreign-generation')
                        migration = function('migrate_db_layout').replace('/opt/proxypilot', str(self.root / 'absent-install'))
                        code = '\n'.join((migration, 'log(){ :; }; log_verbose(){ :; }',
                            'stop_update_writers(){ echo MUST-NOT-STOP; }', f'SCRIPT_DIR={str(install)!r}', 'migrate_db_layout'))
                        result = subprocess.run(['bash', '-c', code], capture_output=True, text=True)
                        self.assertNotEqual(result.returncode, 0); self.assertNotIn('MUST-NOT-STOP', result.stdout)
                        self.assertEqual(self.value(core), 'core'); self.assertEqual(self.value(mock2), 'mock2')
                        self.assertEqual((install / '.env').read_text(), 'DATABASE_PATH=/data/proxypilot.db\n')
                        self.assertTrue(conflict.is_symlink() if link else conflict.read_text() == 'foreign-generation')

    def test_actual_restore_refuses_failed_capture_instead_of_older_core_only_fallback(self):
        sentinel = self.root / 'old-core-copy'; sentinel.write_text('not a paired snapshot')
        code = '\n'.join((function('restore_db'), 'log(){ :; }; log_verbose(){ :; }',
            'stop_update_writers(){ echo MUST-NOT-RUN; }', 'DB_SNAPSHOT_ATTEMPTED=true', 'DB_SNAPSHOT_DIR=""',
            f'DB_BACKUP_FILE={str(sentinel)!r}', f'DB_BACKUP_SOURCE={str(self.core)!r}', 'restore_db'))
        result = subprocess.run(['bash', '-c', code], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0); self.assertNotIn('MUST-NOT-RUN', result.stdout)
        self.assertFalse(self.core.exists())
        incomplete = self.root / 'incomplete-pair'; incomplete.mkdir()
        (incomplete / 'manifest.json').write_text('{}')
        result = subprocess.run(['bash', '-c', code.replace('DB_SNAPSHOT_DIR=""', f'DB_SNAPSHOT_DIR={str(incomplete)!r}')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0); self.assertNotIn('MUST-NOT-RUN', result.stdout)
        self.assertFalse(self.core.exists())

    def test_first_old_script_reexec_and_first_direct_exact_build_capture_before_migration(self):
        # Reuse the disposable real-Git entry fixture, replacing only its build
        # tail/quiescence boundary. Production argument/Git/reexec functions and
        # real paired SQLite helper still run. No installed services are used.
        from test_update_git import UpdateGit
        fixture = UpdateGit('runTest'); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        core, mock2 = fixture.root / 'db', fixture.root / 'mock2.db'
        self.database(core, 'core').close(); self.database(mock2, 'mock2').close()
        shutil.copyfile(HELPER, fixture.repo / 'scripts' / HELPER.name)
        # Keep this regression runnable in a shallow checkout: model the old
        # loaded function set by refusing the new stage in the installed prefix.
        # Only a real exec of the newly fetched script can supply its function.
        old = UPDATER.replace(function('backup_quiesced_databases'),
            'backup_quiesced_databases(){ echo stale-updater-function >&2; return 91; }')
        def bounded(source):
            source = source.split('# A new dependency floor must not strand', 1)[0]
            source = source.replace('set -e\n', 'set -e\necho entry >> "$FIXTURE_EVENTS"\n', 1)
            source = source.replace('LOG_FILE="/tmp/proxypilot-update.log"', 'LOG_FILE="$FIXTURE_LOG"')
            source = source.replace('# Backup the database before any code changes.',
                'resolve_db_path(){ echo "$FIXTURE_ROOT/db"; }\n'
                'backup_db(){ echo old-core-backup >> "$FIXTURE_EVENTS"; DB_BACKUP_FILE="$FIXTURE_ROOT/backup"; DB_BACKUP_SOURCE="$FIXTURE_ROOT/db"; }\n'
                '# Backup the database before any code changes.', 1)
            return source + '\nDB_WRITERS_QUIESCED=true\nbackup_quiesced_databases\necho "paired:$DB_SNAPSHOT_DIR" >> "$FIXTURE_EVENTS"\necho migration >> "$FIXTURE_EVENTS"\npp_complete_update\n'
        (fixture.repo / 'update.sh').write_text(bounded(old))
        fixture.git('add', '.'); fixture.git('commit', '-q', '-m', 'installed-old-updater')
        fixture.base = fixture.git('rev-parse', 'HEAD').strip(); fixture.git('push', '-q', 'origin', 'main')
        (fixture.repo / 'update.sh').write_text(bounded(UPDATER))
        target = fixture.target()
        result = fixture.run_update()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = fixture.events()
        self.assertEqual(events.count('entry'), 2, 'old updater must actually exec the freshly pulled script')
        self.assertEqual(events.count('old-core-backup'), 1, 'new quiescent stage must not depend on repeating early backup')
        paired = [event for event in events if event.startswith('paired:')]
        self.assertEqual(len(paired), 1); self.assertLess(events.index(paired[0]), events.index('migration'))
        self.assertEqual(self.value(Path(paired[0][7:]) / 'mock2.db'), 'mock2')
        result = fixture.run_update(f'--build-current={target}')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len([event for event in fixture.events() if event.startswith('paired:')]), 2)

    def test_production_capture_is_after_stop_before_migrations_and_before_native_launch(self):
        docker = UPDATER.index('        backup_quiesced_databases\n')
        self.assertLess(UPDATER.rindex('        stop_update_writers\n', 0, docker), docker)
        self.assertLess(docker, UPDATER.index('            review_runtime_refresh apply', docker))
        self.assertLess(docker, UPDATER.index('        if ! migrate_db_layout', docker))
        native = UPDATER.index('    backup_quiesced_databases\n', docker + 1)
        self.assertLess(native, UPDATER.index('        pm2 start src/index.js', native))
        self.assertLess(native, UPDATER.index('        nohup $NODE_CMD src/index.js', native))


if __name__ == '__main__':
    unittest.main()
