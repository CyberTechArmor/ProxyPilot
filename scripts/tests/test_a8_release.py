import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('a8_release', ROOT / 'a8-release-check.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'data/db').mkdir(parents=True)
        self.dbpath = self.root / 'data/db/proxypilot.db'
        self.db = sqlite3.connect(self.dbpath)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT)')
        self.db.executemany('INSERT INTO schema_migrations VALUES(?,?)', [(v, f'migration-{v}') for v in release.REQUIRED])
        self.db.execute('CREATE TABLE secrets(id INTEGER PRIMARY KEY, value TEXT)')
        self.db.execute("INSERT INTO secrets VALUES(1,'fixture-secret-never-output')")
        self.db.commit()
        (self.root / '.env').write_text('TOTP_ENCRYPTION_KEY=fixture-private-key\n')
        (self.root / 'docker-compose.yml').write_text('fixture compose\n')
        self.patches = [patch.object(release.wire, 'secure', lambda p: None),
                        patch.object(release.os, 'geteuid', return_value=0), patch.object(release, 'JOURNALS', ())]
        for p in self.patches:
            p.start()

    def tearDown(self):
        self.db.close()
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_backup_includes_wal_and_restores_without_touching_production(self):
        self.assertGreater(Path(str(self.dbpath) + '-wal').stat().st_size, 0)
        before = release.fingerprint(self.dbpath)
        result = release.backup(self.root)
        folder = Path(result['backup'])
        self.assertEqual(release.fingerprint(folder / 'proxypilot.db'), before)
        self.assertEqual(release.fingerprint(self.dbpath), before)
        self.assertTrue(release.verify(self.root, folder)['restore_check'])
        self.assertEqual((folder / '.env').read_bytes(), (self.root / '.env').read_bytes())
        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        for p in folder.iterdir():
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('fixture-secret', json.dumps(result))
        self.assertNotIn('fixture-private', json.dumps(result))
        self.db.execute("INSERT INTO secrets VALUES(2,'later')")
        self.db.commit()
        self.assertEqual(release.fingerprint(folder / 'proxypilot.db')['rows']['secrets'], 1)
        self.assertEqual(release.fingerprint(self.dbpath)['rows']['secrets'], 2)

    def test_missing_migration_and_tampered_backup_refuse(self):
        self.db.execute('DELETE FROM schema_migrations WHERE version=1112')
        self.db.commit()
        with self.assertRaises(ValueError):
            release.backup(self.root)
        self.assertFalse((self.root / '.a8-release').exists())
        self.db.execute("INSERT INTO schema_migrations VALUES(1112,'recovery')")
        self.db.commit()
        result = release.backup(self.root)
        folder = Path(result['backup'])
        (folder / '.env').write_text('changed')
        with self.assertRaises(ValueError):
            release.verify(self.root, folder)


if __name__ == '__main__':
    unittest.main()
