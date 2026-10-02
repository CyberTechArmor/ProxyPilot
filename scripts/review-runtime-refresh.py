#!/usr/bin/env python3
"""Paired, identity-preserving A3/A4 code refresh for the existing root updater.

No installation, opt-in, key generation, configuration, ledger restore or run
replay. Only two installed Python files and their two digest journals may change.
The dashboard must be stopped before apply/rollback. Incomplete transactions
require rollback; neither a new update nor a repeated apply resumes them.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True

TRANSACTION = Path('/var/lib/proxypilot/update/review-runtime-refresh')
LIVE = {'launching', 'running', 'human', 'stopping'}
ACTIVE_DB = {
    'ops_agent_runs': {'prepared', 'starting', 'running', 'cancelling'},
    'ops_website_review_runs': {'queued', 'extracting', 'reviewing'},
}
MAX_FILE = 2 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def load(name, directory):
    spec = importlib.util.spec_from_file_location('refresh_' + name, directory / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bounded(path):
    if not path.is_file() or path.stat().st_size > MAX_FILE:
        raise ValueError('Required bounded regular file is missing')
    return path.read_bytes()


def ledger(path, vm, serving_field):
    data = json.loads(bounded(path))
    if data.get('version') != 1 or data.get('vm_uuid') != vm:
        raise ValueError('Runtime ledger identity is unknown')
    # A daemon records its new source digest on startup. All business state,
    # uncertain reservations, prices and bindings must remain identical.
    data.pop(serving_field, None)
    return data


def idle(supervisor, broker):
    if (any(a.get('state') not in LIVE | {'stopped', 'lost', 'refused'}
            for a in supervisor.get('attempts', {}).values()) or
            any(c.get('state') not in {'reserved', 'sent', 'uncertain', 'refused', 'abandoned',
                                      'settled', 'settled_at_reservation'}
                for c in broker.get('calls', {}).values()) or
            any(v.get('state') not in {'reserved', 'completed', 'cancelled'}
                for v in supervisor.get('public_reviews', {}).values())):
        raise ValueError('Unknown runtime work state; inspect it before Update')
    if supervisor.get('active') is not None or any(
            a.get('state') in LIVE for a in supervisor.get('attempts', {}).values()):
        raise ValueError('Active Demo work; finish or cancel it before Update')
    if any(c.get('state') in {'reserved', 'sent'} for c in broker.get('calls', {}).values()):
        raise ValueError('Active provider call; wait for settlement before Update')
    # Failed historical A3 review reservations can remain reserved after a
    # settled broker call. They are never replayed or cleared by this helper.
    for review in supervisor.get('public_reviews', {}).values():
        if review.get('state') == 'reserved':
            call = broker.get('calls', {}).get(review.get('call_id'))
            if not call or call.get('state') in {'reserved', 'sent'}:
                raise ValueError('Unverifiable review reservation; inspect it before Update')


def database_idle(path):
    if not path.is_file():
        raise ValueError('Dashboard database is missing; cannot verify active work')
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'ops_agent_runs' not in tables:
            raise ValueError('Dashboard run schema is unknown')
        for table, states in ACTIVE_DB.items():
            if table in tables and db.execute(
                    f'SELECT 1 FROM {table} WHERE state IN ({",".join("?" for _ in states)}) LIMIT 1',
                    sorted(states)).fetchone():
                raise ValueError('Active dashboard work; finish or cancel it before Update')


class Host:
    """Production adapter; tests replace service/VM/socket operations, not files."""
    def __init__(self, install, source, source_sha, database):
        self.install, self.source, self.source_sha = install, source, source_sha
        self.database = database
        self.a8 = load('a8-wire-dashboard', install / 'scripts')
        self.a3 = load('a3-install-supervisor', install / 'scripts')
        self.a4 = load('a4-install-broker', install / 'scripts')
        self.vm = self.a8.VM
        self.targets = (self.a3.TARGET / 'a3-worker-supervisor.py', self.a4.TARGET,
                        self.a3.JOURNAL, self.a4.JOURNAL)
        self.ledgers = (self.a3.STATE_DIR / 'state.json', self.a4.broker.JOURNAL)
        self.protected = (self.a3.KEY, self.a3.PUBLIC_KEY, self.a8.KEY, self.a4.broker.CONFIG,
                          install / 'docker-compose.yml')

    def secure(self, path):
        self.a8.secure(path)

    def write(self, path, data, mode):
        self.a3.save_bytes(path, data, mode)

    def execute(self, argv, timeout=90, cwd=None):
        return subprocess.run(argv, check=True, capture_output=True, text=True,
                              timeout=timeout, cwd=cwd).stdout

    def opted_in(self):
        self.secure(self.install / '.env')
        if not (self.install / '.env').exists():
            return False
        return self.a8.configured(bounded(self.install / '.env').decode())

    def candidates(self):
        if not re.fullmatch('[0-9a-f]{40}', self.source_sha or ''):
            raise ValueError('Verified checkout SHA is required')
        self.secure(self.source)
        if self.execute(['git', '-C', str(self.source), 'rev-parse', '--verify', 'HEAD']).strip() != self.source_sha:
            raise ValueError('Checkout changed after Update pinned its commit')
        candidates = {}
        for target, name in zip(self.targets[:2], ('a3-worker-supervisor.py', 'a4-credential-broker.py')):
            path = self.install / 'scripts' / name
            self.secure(path)
            data = bounded(path)
            committed = subprocess.run(['git', '-C', str(self.source), 'show',
                                        self.source_sha + ':scripts/' + name], check=True,
                                       capture_output=True, timeout=15).stdout
            if data != committed or not data.startswith(b'#!/usr/bin/env python3\n'):
                raise ValueError('Candidate differs from the pinned checkout')
            compile(data.decode(), name, 'exec')
            candidates[target] = data
        # No adjacent package, unit or timer upgrade is silently bundled.
        old = self.a3.read_journal()
        for path, data in self.a3.plan_files(self.install / 'scripts').items():
            if path in {self.a3.RENEW_SERVICE, self.a3.RENEW_TIMER} and str(path) not in old['files']:
                continue
            if path != self.targets[0] and old['files'].get(str(path)) != sha(data):
                raise ValueError('Other A3 package/unit changes require separate review')
        if self.a4.read_journal()['files'].get(str(self.a4.UNIT)) != sha(self.a4.UNIT_TEXT.encode()):
            raise ValueError('Broker unit changes require separate review')
        return candidates

    def identity(self):
        for path in self.protected:
            self.secure(path)
        a, b = self.a3.read_journal(), self.a4.read_journal()
        expected_a = {str(self.a3.TARGET / name) for name in self.a3.SOURCES} | {
            str(self.a3.PUBLIC_KEY), str(self.a3.UNIT), str(self.a3.RENEW_SERVICE), str(self.a3.RENEW_TIMER)}
        # The pre-renewal installation is recognized; no timer is enrolled here.
        allowed_a = (expected_a, expected_a - {str(self.a3.RENEW_SERVICE), str(self.a3.RENEW_TIMER)})
        if (set(a.get('files', {})) not in allowed_a or
                set(b.get('files', {})) != {str(self.a4.TARGET), str(self.a4.UNIT)} or
                a.get('phase') != 'installed' or b.get('phase') != 'installed' or
                a.get('vm_uuid') != self.vm or b.get('vm_uuid') != self.vm):
            raise ValueError('Installation identity or owned file set is unknown')
        self.a3.verify_files(a)
        self.a4.verify_files(b)
        for p, mode in ((self.a3.KEY, 0o600), (self.a3.PUBLIC_KEY, 0o644),
                        (self.a8.KEY, 0o600), (self.a4.broker.CONFIG, 0o600)):
            self.secure(p)
            if stat.S_IMODE(p.stat().st_mode) != mode:
                raise ValueError('Existing key/config permissions differ from the installed contract')
        private_der = subprocess.run(['openssl', 'pkey', '-in', str(self.a3.KEY), '-pubout', '-outform', 'DER'],
                                     check=True, capture_output=True, timeout=10).stdout
        key = self.a8.public_key_id(self.a3.PUBLIC_KEY)
        if sha(private_der) != key or key != a.get('key_id') or self.a8.wiring_checks() != key:
            raise ValueError('Receipt key identity/pin mismatch; no key is rewritten')
        compose = bounded(self.install / 'docker-compose.yml').decode()
        if self.a8.compose_text(compose) != compose or not self.opted_in():
            raise ValueError('Existing A8 settings/mounts are not the reviewed opt-in')
        return key

    def healthy(self, digests, key, new=False):
        self.a3.unit_checks()
        self.a4.unit_checks()
        self.a3.renew_timer_checks(self.a3.read_journal())
        a = self.a3.wait_status(key)
        b = self.a4.wait_status(digests[1])
        if (a['supervisor'].get('supervisor_sha256') != digests[0] or
                a.get('vm_uuid') != self.vm or a.get('active') is not None or
                not a.get('accepting_launch') or b.get('vm_uuid') != self.vm):
            raise ValueError('Serving identity/source or idle boundary verification failed')
        if new:
            result = self.a3.call('public_review_status', timeout=10)
            status = result.get('result', {})
            if (not result.get('ok') or status.get('contract_version') != 'website-review.v1' or
                    b.get('public_review') is not True or status.get('available') not in (True, False) or
                    (not status['available'] and status.get('code') not in {'PROVIDER_UNAVAILABLE', 'PRICE_UNKNOWN'})):
                raise ValueError('Installed public review contract verification failed')
            return status
        return None

    def backend_stopped(self):
        try:
            self.execute(['docker', 'compose', 'version'], timeout=10)
            compose = ['docker', 'compose']
        except subprocess.CalledProcessError:
            compose = ['docker-compose']
        if self.execute(compose + ['ps', '--status', 'running', '--quiet', 'proxypilot'],
                        cwd=self.install, timeout=15).strip():
            raise ValueError('Dashboard backend is still running')

    def db_idle(self):
        self.secure(self.database)
        database_idle(self.database)

    def stop(self):
        for unit in (self.a3.UNIT, self.a4.UNIT):
            self.execute(['systemctl', 'stop', unit.name])
            state = self.execute(['systemctl', 'show', unit.name, '--property=ActiveState', '--value']).strip()
            if state != 'inactive':
                raise ValueError('Runtime service did not stop cleanly')

    def start(self):
        for unit in (self.a4.UNIT, self.a3.UNIT):
            self.execute(['systemctl', 'start', unit.name])


class Refresh:
    def __init__(self, host, directory=TRANSACTION):
        self.host, self.directory = host, directory
        self.journal = directory / 'transaction.json'

    def read(self):
        self.host.secure(self.journal)
        if (stat.S_IMODE(self.directory.stat().st_mode) != 0o700 or
                stat.S_IMODE(self.journal.stat().st_mode) != 0o600):
            raise ValueError('Refresh transaction custody/mode changed')
        data = json.loads(bounded(self.journal))
        records = data.get('files', [])
        if (data.get('version') != 1 or data.get('vm_uuid') != self.host.vm or
                data.get('phase') not in {'prepared', 'replacing', 'applied', 'committed', 'rolled_back'} or
                [r.get('path') for r in records] != [str(p) for p in self.host.targets] or
                any(not re.fullmatch('[0-9a-f]{64}', r.get(k, '')) for r in records for k in ('old', 'new')) or
                [r.get('mode') for r in records] != [0o644, 0o644, 0o600, 0o600] or
                set(data.get('protected', {})) != {str(p) for p in self.host.protected}):
            raise ValueError('Refresh transaction is unknown; refusing recovery')
        return data

    def save(self, data):
        self.host.write(self.journal, encoded(data), 0o600)

    def protected(self):
        result = {}
        for path in self.host.protected:
            self.host.secure(path)
            result[str(path)] = [sha(bounded(path)), stat.S_IMODE(path.stat().st_mode)]
        return result

    def ledgers(self):
        values = []
        for path, field in zip(self.host.ledgers, ('supervisor_sha256', 'broker_sha256')):
            self.host.secure(path)
            values.append(ledger(path, self.host.vm, field))
        idle(*values)
        return [sha(encoded(v)) for v in values]

    def unchanged(self, data):
        if self.protected() != data['protected'] or self.ledgers() != data['ledgers']:
            raise ValueError('Protected identity/configuration or runtime ledger changed; refusing overwrite')

    def preflight(self):
        if not self.host.opted_in():
            return {'skipped': True, 'reason': 'not_opted_in'}
        if self.journal.exists() and self.read()['phase'] not in {'committed', 'rolled_back'}:
            raise ValueError('Incomplete refresh; rollback required before another Update')
        key = self.host.identity()
        for n, path in enumerate(self.host.targets):
            self.host.secure(path)
            if stat.S_IMODE(path.stat().st_mode) != (0o644 if n < 2 else 0o600):
                raise ValueError('Installed code/journal permissions are unknown')
        candidates = self.host.candidates()
        digests = [sha(bounded(p)) for p in self.host.targets[:2]]
        self.host.healthy(digests, key)
        self.host.db_idle()
        self.ledgers()
        return {'skipped': False, 'key_id': key, 'old': digests,
                'new': [sha(candidates[p]) for p in self.host.targets[:2]]}

    def apply(self):
        result = self.preflight()
        if result['skipped']:
            return result
        self.host.backend_stopped()
        self.host.db_idle()
        if result['old'] == result['new']:
            readiness = self.host.healthy(result['new'], result['key_id'], new=True)
            return {'unchanged': True, 'key_id': result['key_id'], 'readiness': readiness}
        candidates = self.host.candidates()
        if result['new'] != [sha(candidates[p]) for p in self.host.targets[:2]]:
            raise ValueError('Candidate changed after preflight')
        old = [bounded(p) for p in self.host.targets]
        for n, target in enumerate(self.host.targets[:2]):
            journal = json.loads(old[n + 2])
            journal['files'][str(target)] = sha(candidates[target])
            candidates[self.host.targets[n + 2]] = encoded(journal)
        data = {'version': 1, 'phase': 'prepared', 'vm_uuid': self.host.vm,
                'source_sha': self.host.source_sha, 'key_id': result['key_id'],
                'protected': self.protected(), 'ledgers': self.ledgers(),
                'files': [{'path': str(p), 'old': sha(previous), 'new': sha(candidates[p]),
                           'mode': 0o644 if n < 2 else 0o600}
                          for n, (p, previous) in enumerate(zip(self.host.targets, old))]}
        self.host.secure(self.directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if stat.S_IMODE(self.directory.stat().st_mode) != 0o700:
            raise ValueError('Refresh backup directory must be private')
        for n, previous in enumerate(old):
            self.host.write(self.directory / f'old-{n}', previous, 0o600)
        self.save(data)
        # The dashboard is down and its accepted Start is already represented
        # in SQLite. Recheck all durable state immediately before service stop.
        self.host.backend_stopped()
        self.host.db_idle()
        self.unchanged(data)
        self.host.healthy(result['old'], result['key_id'])
        self.host.stop()
        self.unchanged(data)
        for record in data['files']:
            if sha(bounded(Path(record['path']))) != record['old']:
                raise ValueError('Installed code changed during refresh')
        data['phase'] = 'replacing'
        self.save(data)
        for record in data['files']:
            self.host.write(Path(record['path']), candidates[Path(record['path'])], record['mode'])
        if self.host.identity() != data['key_id']:
            raise ValueError('Receipt identity changed')
        self.host.start()
        data['readiness'] = self.host.healthy(result['new'], data['key_id'], new=True)
        self.unchanged(data)
        data['phase'] = 'applied'
        self.save(data)
        return {'refreshed': True, 'key_id': data['key_id'], 'digests': result['new'],
                'readiness': data['readiness'], 'awaiting_dashboard_health': True}

    def rollback(self):
        if not self.journal.exists():
            return {'skipped': True, 'reason': 'no_transaction'}
        data = self.read()
        if data['phase'] in {'rolled_back', 'committed'}:
            return {'skipped': True, 'reason': data['phase']}
        self.host.backend_stopped()
        self.host.db_idle()
        self.unchanged(data)
        backups = []
        for n, record in enumerate(data['files']):
            path = Path(record['path'])
            self.host.secure(path)
            backup = self.directory / f'old-{n}'
            self.host.secure(backup)
            content = bounded(backup)
            if (sha(content) != record['old'] or stat.S_IMODE(backup.stat().st_mode) != 0o600 or
                    stat.S_IMODE(path.stat().st_mode) != record['mode'] or
                    sha(bounded(path)) not in {record['old'], record['new']}):
                raise ValueError('Rollback digest drift; refusing to overwrite unknown files')
            backups.append(content)
        self.host.stop()
        self.unchanged(data)
        for record, content in zip(data['files'], backups):
            self.host.write(Path(record['path']), content, record['mode'])
        if self.host.identity() != data['key_id']:
            raise ValueError('Rollback identity mismatch')
        self.host.start()
        self.host.healthy([r['old'] for r in data['files'][:2]], data['key_id'])
        self.unchanged(data)
        data['phase'] = 'rolled_back'
        self.save(data)
        return {'rolled_back': True, 'key_id': data['key_id'], 'replayed': False}

    def commit(self):
        if not self.journal.exists():
            return {'skipped': True, 'reason': 'no_transaction'}
        data = self.read()
        if data['phase'] in {'committed', 'rolled_back'}:
            return {'skipped': True, 'reason': data['phase']}
        if data['phase'] != 'applied':
            raise ValueError('Only a verified applied refresh can commit')
        # After dashboard startup, legitimate new work may have updated its
        # ledgers. Never compare/restore a stale runtime ledger at this point.
        if self.protected() != data['protected'] or self.host.identity() != data['key_id']:
            raise ValueError('Protected identity changed before update completion')
        for record in data['files']:
            if sha(bounded(Path(record['path']))) != record['new']:
                raise ValueError('Installed code changed before update completion')
        data['phase'] = 'committed'
        data['completed_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        self.save(data)
        return {'committed': True, 'key_id': data['key_id']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('preflight', 'apply', 'rollback', 'commit'))
    parser.add_argument('--install-dir', required=True, type=Path)
    parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--database', required=True, type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Existing root update runner required')
    for path in (args.install_dir, args.source_dir, args.database):
        if not path.is_absolute() or path != path.resolve():
            parser.error('Canonical absolute paths required')
    host = Host(args.install_dir, args.source_dir, args.source_sha, args.database)
    # No new lock/path is created on installations that never opted in.
    if args.action in ('rollback', 'commit') and not (TRANSACTION / 'transaction.json').exists():
        print(json.dumps({'skipped': True, 'reason': 'no_transaction'}))
        return
    if args.action in ('preflight', 'apply') and not host.opted_in():
        print(json.dumps({'skipped': True, 'reason': 'not_opted_in'}))
        return
    lock = Path('/run/proxypilot-a3-fence.lock')
    host.secure(lock)
    with lock.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(getattr(Refresh(host), args.action)()))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print subprocess output or a configuration/ledger payload.
        detail = str(error) if isinstance(error, ValueError) else type(error).__name__
        print('Review runtime refresh refused: ' + detail, file=sys.stderr)
        sys.exit(1)
