#!/usr/bin/env python3
"""Private SQLite backup, isolated restore check and pilot disk baseline.

The source DB is read-only, SQLite's backup API includes committed WAL data,
and the restore check never replaces production. This is not an off-host backup.
"""
import argparse
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time

spec = importlib.util.spec_from_file_location('a8_wire', Path(__file__).with_name('a8-wire-dashboard.py'))
wire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wire)
REQUIRED = set(range(1100, 1113))
JOURNALS = (Path('/var/lib/proxypilot-a3-proof/supervisor'), Path('/var/lib/proxypilot-a4/broker'))


def read_db(path):
    return sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=20)


def fingerprint(path, require_migrations=True):
    with closing(read_db(path)) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('Database integrity check failed')
        if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise ValueError('Database foreign-key check failed')
        migrations = [r[0] for r in db.execute('SELECT version FROM schema_migrations ORDER BY version')]
        if require_migrations and not REQUIRED.issubset(migrations):
            raise ValueError('A3–A7 migrations are missing')
        schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
        counts = {}
        for kind, name, _, _ in schema:
            if kind == 'table':
                counts[name] = db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
        # Hash includes rows, not only the schema/counts. Values stay in memory
        # and private backup files; none are emitted in the result.
        digest = hashlib.sha256()
        for statement in db.iterdump():
            digest.update(statement.encode())
            digest.update(b'\n')
        return {'logical_sha256': digest.hexdigest(), 'migrations': migrations,
                'schema_sha256': hashlib.sha256(json.dumps(schema).encode()).hexdigest(), 'rows': counts}


def disk_baseline(install_dir):
    paths = {'database': install_dir / 'data/db', 'release_backups': install_dir / '.a8-release',
             'wiring_backups': install_dir / '.a8-backups'}
    paths.update({f'journal_{i}': p for i, p in enumerate(JOURNALS)})
    sizes = {}
    for name, path in paths.items():
        wire.secure(path)
        total, files = 0, 0
        if path.exists():
            for root, dirs, names in os.walk(path, followlinks=False):
                if any((Path(root) / p).is_symlink() for p in [*dirs, *names]):
                    raise ValueError('Symlink in pilot storage')
                for filename in names:
                    total += (Path(root) / filename).stat().st_size
                    files += 1
        sizes[name] = {'bytes': total, 'files': files}
    sizes['filesystem_free_bytes'] = shutil.disk_usage(install_dir).free
    return sizes


def restore_check(target):
    expected = fingerprint(target)
    with tempfile.TemporaryDirectory(prefix='restore-check-', dir=target.parent) as temp:
        restored = Path(temp) / 'proxypilot.db'
        with closing(read_db(target)) as origin, closing(sqlite3.connect(restored)) as destination:
            restored.chmod(0o600)
            origin.backup(destination)
        if fingerprint(restored) != expected:
            raise ValueError('Restored database differs from backup')
    return expected


def verify(install_dir, folder):
    wire.secure(folder)
    if folder.parent != install_dir / '.a8-release' or folder.stat().st_mode & 0o777 != 0o700:
        raise ValueError('Expected a private backup from this installation')
    manifest_path = folder / 'manifest.json'
    wire.secure(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    files = manifest.get('files')
    if not isinstance(files, dict) or set(files) != {'proxypilot.db', '.env', 'docker-compose.yml'}:
        raise ValueError('Invalid backup manifest')
    for name, digest in files.items():
        path = folder / name
        wire.secure(path)
        if path.stat().st_mode & 0o777 != 0o600 or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('Backup file changed')
    restored = restore_check(folder / 'proxypilot.db')
    if restored['logical_sha256'] != manifest['logical_sha256'] or restored['schema_sha256'] != manifest['schema_sha256']:
        raise ValueError('Backup logical state changed')
    return {'backup': str(folder), 'files_verified': True, 'restore_check': True,
            'logical_sha256': restored['logical_sha256'], 'migrations': restored['migrations']}


def backup(install_dir):
    if os.geteuid() != 0:
        raise ValueError('Host operator required')
    source = install_dir / 'data/db/proxypilot.db'
    env = install_dir / '.env'
    compose = install_dir / 'docker-compose.yml'
    root = install_dir / '.a8-release'
    for path in (source, env, compose, root):
        wire.secure(path)
    # Fail before writing on a wrong database; no automatic migrations here.
    fingerprint(source)
    root.mkdir(mode=0o700, exist_ok=True)
    if root.stat().st_mode & 0o777 != 0o700:
        raise ValueError('Private release backup directory required')
    folder = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%SZ-'), dir=root))
    target = folder / 'proxypilot.db'
    with closing(read_db(source)) as origin, closing(sqlite3.connect(target)) as destination:
        target.chmod(0o600)
        origin.backup(destination, pages=256, sleep=0.05)
    expected = restore_check(target)
    for path in (env, compose):
        wire.atomic(folder / path.name, path.read_bytes(), 0o600)
    files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (target, folder / '.env', folder / compose.name)}
    result = {'backup': str(folder), 'restore_check': True, 'integrity': True, 'foreign_keys': True,
              'logical_sha256': expected['logical_sha256'], 'schema_sha256': expected['schema_sha256'],
              'migrations': expected['migrations'], 'files': files, 'disk': disk_baseline(install_dir),
              'off_host_copy_required': True}
    wire.atomic(folder / 'manifest.json', (json.dumps(result, indent=2) + '\n').encode(), 0o600)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('backup', 'verify', 'disk'))
    parser.add_argument('--install-dir', type=Path, default=Path('/opt/proxypilot'))
    parser.add_argument('--backup-dir', type=Path)
    args = parser.parse_args()
    try:
        if os.geteuid() != 0 or not args.install_dir.is_absolute():
            raise ValueError('Host operator and absolute installation required')
        if (args.mode == 'verify') != (args.backup_dir is not None):
            raise ValueError('Only verify takes a backup directory')
        result = backup(args.install_dir) if args.mode == 'backup' else verify(args.install_dir, args.backup_dir) if args.mode == 'verify' else disk_baseline(args.install_dir)
        print(json.dumps(result))
    except (OSError, ValueError, sqlite3.Error):
        print(json.dumps({'ok': False, 'error': 'A8 release check refused; review private paths and database integrity/migrations'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
