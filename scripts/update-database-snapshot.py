#!/usr/bin/env python3
"""Private, migration-free core + sibling Mock2 SQLite rollback bundles.

The updater must stop its supported writers before calling this helper and keep
those writers stopped until restore completes. SQLite reservations additionally
refuse active writers and hold both source databases stable during capture.
Committed WAL pages are folded into standalone backup files; SHM is rebuilt,
never copied from an unrelated database generation.
"""
import argparse
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import tempfile
from urllib.parse import quote

SCHEMA = 'proxypilot-database-snapshot@1'
NAMES = ('proxypilot.db', 'mock2.db')


def regular(path, *, optional=False):
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        if optional:
            return False
        raise ValueError(f'Missing snapshot/database file: {path.name}')
    if not stat.S_ISREG(mode):
        raise ValueError(f'Refusing non-regular snapshot/database file: {path.name}')
    return True


def targets(core):
    core = Path(core).absolute()
    sibling = core.parent / 'mock2.db'
    if core == sibling:
        raise ValueError('The core database cannot be mock2.db')
    return (core, sibling)


def connect(path, mode):
    return sqlite3.connect(f'file:{quote(str(path), safe="/")}?mode={mode}', uri=True, timeout=0.5)


def check_sidecars(path):
    for suffix in ('-wal', '-shm', '-journal'):
        regular(Path(str(path) + suffix), optional=True)


@contextmanager
def reserved(paths):
    """Acquire all SQLite writer reservations before reading any source state."""
    with ExitStack() as stack:
        for path in paths:
            check_sidecars(path)
            db = connect(path, 'rw')
            stack.callback(db.close)
            db.execute('BEGIN IMMEDIATE')
            stack.callback(db.rollback)
        yield


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def private_file(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(fd)


def sync_file(path):
    with path.open('rb') as stream:
        os.fsync(stream.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def validate_sqlite(path):
    regular(path)
    # A normalized backup is standalone. An extra WAL could change the read
    # contents without changing the main file's manifest hash.
    for suffix in ('-wal', '-shm', '-journal'):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            raise ValueError('A standalone snapshot must not contain sidecars')
    db = connect(path, 'ro')
    try:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError(f'Snapshot integrity check failed: {path.name}')
    finally:
        db.close()


def snapshot(core, parent, *, after_reservation=None):
    source = targets(core)
    if not regular(source[0]):
        raise ValueError('The core database must exist before an update snapshot')
    present = [regular(path, optional=True) for path in source]
    if not present[1]:
        for suffix in ('-wal', '-shm', '-journal'):
            sidecar = Path(str(source[1]) + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                raise ValueError('Mock2 has orphan sidecars; absence is not confirmed')
    parent = Path(parent).absolute()
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if parent.is_symlink() or not parent.is_dir():
        raise ValueError('The backup parent must be a real directory')
    folder = Path(tempfile.mkdtemp(prefix='pre-update-databases-', dir=parent))
    os.chmod(folder, 0o700)
    try:
        with reserved([p for p, exists in zip(source, present) if exists]):
            if after_reservation:
                after_reservation()  # test seam, never a CLI command or callback
            entries = []
            for path, name, exists in zip(source, NAMES, present):
                entry = {'name': name, 'present': exists}
                if exists:
                    metadata = path.stat()
                    destination = folder / name
                    private_file(destination)
                    src, dst = connect(path, 'ro'), connect(destination, 'rw')
                    try:
                        src.backup(dst)
                        dst.execute('PRAGMA journal_mode=DELETE')
                    finally:
                        dst.close()
                        src.close()
                    validate_sqlite(destination)
                    os.chmod(destination, 0o600)
                    sync_file(destination)
                    entry.update(bytes=destination.stat().st_size, sha256=digest(destination), uid=metadata.st_uid, gid=metadata.st_gid)
                entries.append(entry)
            if not present[1] and regular(source[1], optional=True):
                raise ValueError('Mock2 appeared during capture; writers were not quiescent')
            manifest = folder / 'manifest.json'
            private_file(manifest)
            manifest.write_text(json.dumps({'schema': SCHEMA, 'core': str(source[0]), 'databases': entries}, indent=2) + '\n')
            sync_file(manifest)
            sync_directory(folder)
            sync_directory(parent)
        return folder
    except BaseException:
        shutil.rmtree(folder)
        raise


def restore(core, folder):
    source, folder = targets(core), Path(folder).absolute()
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError('The snapshot must be a real directory')
    manifest = folder / 'manifest.json'
    regular(manifest)
    data = json.loads(manifest.read_text())
    if data.get('schema') != SCHEMA or data.get('core') != str(source[0]):
        raise ValueError('Snapshot does not match this database source')
    entries = data.get('databases')
    if not isinstance(entries, list) or len(entries) != 2:
        raise ValueError('Incomplete paired database snapshot')
    # Validate the complete pair before touching either live database.
    for entry, name in zip(entries, NAMES):
        if entry.get('name') != name or type(entry.get('present')) is not bool:
            raise ValueError('Invalid paired database snapshot entry')
        if entry['present']:
            path = folder / name
            validate_sqlite(path)
            if path.stat().st_size != entry.get('bytes') or digest(path) != entry.get('sha256'):
                raise ValueError('Snapshot content does not match its manifest')
            if any(type(entry.get(key)) is not int or entry[key] < 0 for key in ('uid', 'gid')):
                raise ValueError('Snapshot ownership is missing or invalid')
        elif regular(folder / name, optional=True):
            raise ValueError('An absent database snapshot unexpectedly contains a file')
    if not entries[0]['present']:
        raise ValueError('The core snapshot is required')
    existing = [path for path in source if regular(path, optional=True)]
    staged = []
    try:
        with reserved(existing):
            for target, entry, name in zip(source, entries, NAMES):
                check_sidecars(target)
                if entry['present']:
                    fd, temporary = tempfile.mkstemp(prefix=f'.{name}.restore-', dir=target.parent)
                    os.close(fd)
                    temporary = Path(temporary)
                    staged.append((target, temporary))
                    shutil.copyfile(folder / name, temporary)
                    os.chmod(temporary, 0o600)
                    os.chown(temporary, entry['uid'], entry['gid'])
                    sync_file(temporary)
        # The updater keeps all writers stopped across this replacement. A live
        # process retaining an old SQLite inode is not a supported restore.
        for target in source:
            for suffix in ('-wal', '-shm', '-journal'):
                Path(str(target) + suffix).unlink(missing_ok=True)
        for target, temporary in staged:
            os.replace(temporary, target)
        for target, entry in zip(source, entries):
            if not entry['present']:
                target.unlink(missing_ok=True)
        sync_directory(source[0].parent)
        return {'restored': True, 'mock2': 'present' if entries[1]['present'] else 'absent'}
    finally:
        for _, temporary in staged:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    create = sub.add_parser('create')
    create.add_argument('--core', required=True)
    create.add_argument('--parent', required=True)
    recover = sub.add_parser('restore')
    recover.add_argument('--core', required=True)
    recover.add_argument('--snapshot', required=True)
    args = parser.parse_args()
    if args.action == 'create':
        print(snapshot(args.core, args.parent))
    else:
        print(json.dumps(restore(args.core, args.snapshot)))


if __name__ == '__main__':
    main()
