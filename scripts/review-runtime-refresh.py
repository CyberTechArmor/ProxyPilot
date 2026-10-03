#!/usr/bin/env python3
"""Paired, identity-preserving A3/A4 code refresh for the existing root updater.

No installation, opt-in, key generation, configuration, ledger restore or run
replay. Only two installed Python files and their two digest journals may change.
The dashboard must be stopped before apply/rollback. Incomplete transactions
require rollback; neither a new update nor a repeated apply resumes them.

An expanded selected-browser source release instead preserves the recognized
legacy installation. Its distinct metadata-only transaction never replaces
runtime files, stops daemons, installs selected helpers or grants acceptance.
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
TERMINAL_DB = {
    'ops_agent_runs': ('completed', 'cancelled', 'failed', 'blocked'),
    'ops_selected_browser_runs': ('completed', 'cancelled', 'failed', 'uncertain'),
    'ops_website_review_runs': ('completed', 'cancelled', 'failed', 'blocked', 'interrupted'),
    'ops_browser_conversions': ('completed', 'blocked', 'cancelled', 'interrupted'),
    'ops_agent_model_calls': ('chosen', 'refused', 'uncertain'),
    'ops_selected_browser_model_reservations': ('settled', 'uncertain', 'suppressed'),
}
MAX_FILE = 2 * 1024 * 1024
# Runtime journals retain terminal attempts/calls and can legitimately outgrow
# a source/config file. This separate cap covers both ledgers at every read;
# it does not authorize pruning, migration, replay or rewriting their history.
MAX_LEDGER = 16 * 1024 * 1024
SOURCE_RECORD = Path('/var/lib/proxypilot/update/source-dir')
SELECTED = ('selected_browser_supervisor.py', 'selected_browser_policy.py', 'selected_browser_gateway.py',
            'selected_browser_worker.py', 'selected_browser_contract.py', 'selected-browser-schemas.json',
            'selected-browser-model.py')
# Authentic PR724 public-review runtime, not mutually agreeing mutable journals.
# The previously approved PR710 guest may remain installed unchanged.
LEGACY_SOURCE_HASHES = {
    'a3-worker-supervisor.py': 'd672c404e04faf75a8dd1e5ef9c7cfb60002271f8dea24fd04def84d235bc7ae',
    'a3-install-proxy.py': '59ae252ee010f0ff0484e952880188404aa90ff3d6ca241c09d76be98d7c7af2',
    'a3-install-fence.py': 'bb396c84f85448cd60710c71ae917cec52482d3a4d51591425ba52d2b529f4e3',
    'a3-network-fence.py': 'e7208d606aec742f46a3742db772445600a2558f3144ed45f946799b89d1237b',
    'a3-origin-proxy.py': '6c86bc369abbf3b9f25261f19b156a6ff1a98c8be94d937324eb663d2704ba5c',
    'a4-credential-broker.py': '7ea1610e46058d7dbac48090cec51a0bb03fe3f1379b8adba6ca7053ba2e44ef',
}
LEGACY_UNIT_HASHES = {
    'supervisor': '4d34825a89d9336b4ae40386ba9bd6b1403a0e6344d1c7a5b7165747c06c61ec',
    'broker': '23aeff46dadf4a7d3591fe779459182783e3fb4530b4379fa0a697dc0c8f11e4',
    'proxy': 'e2dbdd3c2e708062a8581090d622441783b8003802fdcb2d6767dfacbd39666f',
    'renew_service': 'cfd074a814f28052a6d799a0f1d3f097c472e8d76ec6ec5416ffe1e7a5d2d88d',
    'renew_timer': '058e2af8a0bc992bc73d336d72eb919feaece125e956546343b96fbd1b820af9',
}
# PR #710's installed Demo worker is protocol-compatible with this review
# bridge. 39ada2b only corrects bound-session/sign-out observations; that guest
# refresh remains deferred. Retain its bytes and pin, never copy the candidate.
GUEST_REVIEW_COMPATIBILITY = (
    'd0724e5fb5573a18095a8e906cd9bb9c2542c17c494184ca15cbc65d345331f9',
    '54302e5ee880470480d9b4de3d30616b263c7213d9eb08712b1ef3f50c5c0d21',
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def load(name, directory):
    spec = importlib.util.spec_from_file_location('refresh_' + name, directory / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bounded(path, max_bytes=MAX_FILE):
    def check(info):
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f'Required path is not a regular file: {path}')
        if info.st_size > max_bytes:
            raise ValueError(f'Required file exceeds {max_bytes}-byte limit: {path} ({info.st_size} bytes)')
    try:
        check(path.lstat())
        # A changed path cannot become a symlink or blocking FIFO between
        # metadata validation and opening. The descriptor is checked again.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            check(os.fstat(stream.fileno()))
            data = stream.read(max_bytes + 1)
    except FileNotFoundError:
        raise ValueError(f'Required file is missing: {path}') from None
    except OSError as error:
        raise ValueError(f'Required file cannot be read: {path} ({type(error).__name__})') from None
    if len(data) > max_bytes:
        raise ValueError(f'Required file grew beyond {max_bytes}-byte limit: {path}')
    return data


def ledger(path, vm, serving_field):
    try:
        data = json.loads(bounded(path, MAX_LEDGER).decode('utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError(f'Runtime ledger is not valid UTF-8 JSON: {path}') from None
    if not isinstance(data, dict) or data.get('version') != 1 or data.get('vm_uuid') != vm:
        raise ValueError(f'Runtime ledger identity is unknown: {path}')
    # A daemon records its new source digest on startup. All business state,
    # uncertain reservations, prices and bindings must remain identical.
    data.pop(serving_field, None)
    return data


def idle(supervisor, broker):
    if (any(a.get('state') not in LIVE | {'stopped', 'lost', 'refused'}
            for a in supervisor.get('attempts', {}).values()) or
            any(c.get('state') not in {'reserved', 'sent', 'uncertain', 'refused', 'abandoned',
                                      'settled', 'settled_at_reservation', 'provider_error'}
                for c in broker.get('calls', {}).values()) or
            any(v.get('state') not in {'reserved', 'completed', 'cancelled', 'failed'}
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


def database_idle(path, selected=False):
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
        if selected:
            for table, terminal in TERMINAL_DB.items():
                if table in tables and db.execute(
                        f'SELECT 1 FROM {table} WHERE state IS NULL OR state NOT IN ({",".join("?" for _ in terminal)}) LIMIT 1',
                        terminal).fetchone():
                    raise ValueError('Active or unknown dashboard namespace; inspect it before Update')


class Host:
    """Production adapter; tests replace service/VM/socket operations, not files."""
    def __init__(self, install, source, source_sha, database):
        self.install, self.source, self.source_sha = install, source, source_sha
        self.database = database
        self.source_record = SOURCE_RECORD
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

    def selected_absent(self):
        root, state = self.a3.TARGET.parent, self.a3.STATE_DIR.parent
        paths = tuple(self.a3.TARGET / name for name in SELECTED) + (
            root / 'selected_browser_gateway.py', root / 'selected_browser_policy.py',
            root / 'selected-browser-acceptance.json', state / 'selected-gateway',
            TRANSACTION.parent / 'selected-runtime-package')
        for path in paths:
            self.secure(path)
            if path == TRANSACTION.parent / 'selected-runtime-package' and hasattr(self, 'rolled_back_check'):
                self.rolled_back_check()
                continue
            if path.exists():
                raise ValueError(f'Selected runtime state requires separate package review: {path}')

    def unconfigured_absent(self):
        # Expanded source may be delivered to a completely unenrolled host.
        # Missing A8 settings cannot hide an existing or partial installation.
        if not hasattr(self.a3, 'SELECTED_SOURCES'):
            return
        self.selected_absent()
        for path in (self.a3.TARGET.parent, self.a3.STATE_DIR.parent,
                     self.a4.TARGET.parent.parent, self.a4.JOURNAL.parent, self.a8.KEY.parent,
                     self.a3.UNIT, self.a4.UNIT, self.a3.RENEW_SERVICE, self.a3.RENEW_TIMER,
                     self.a3.proxy.UNIT, self.a3.proxy.i.UNIT):
            self.secure(path)
            if path.exists():
                raise ValueError(f'Runtime artifacts exist without the reviewed A8 opt-in: {path}')

    def source_profile(self, require_legacy=True):
        if not hasattr(self.a3, 'SELECTED_SOURCES'):
            return None  # Retain the historical public-review-only refresh.
        if tuple(self.a3.SELECTED_SOURCES) != SELECTED:
            raise ValueError('Selected source owned set is unknown')
        names = self.a3.SOURCES + SELECTED + ('a4-credential-broker.py', 'a3-install-supervisor.py',
                                            'a4-install-broker.py', 'selected-runtime-package.py')
        if not re.fullmatch('[0-9a-f]{40}', self.source_sha or ''):
            raise ValueError('Verified checkout SHA is required')
        self.secure(self.source)
        self.secure(self.source_record)
        record = bounded(self.source_record, 4096)
        if (record != (str(self.source) + '\n').encode() or
                stat.S_IMODE(self.source_record.stat().st_mode) not in {0o600, 0o644}):
            raise ValueError('Update source differs from the root-recorded checkout')
        head = lambda: self.execute(['git', '-C', str(self.source), 'rev-parse', '--verify', 'HEAD']).strip()
        if head() != self.source_sha:
            raise ValueError('Checkout changed after Update pinned its commit')
        pins, modes = {}, {}
        for name in names:
            path = self.install / 'scripts' / name
            self.secure(path)
            value = bounded(path)
            committed = subprocess.run(['git', '-C', str(self.source), 'show',
                self.source_sha + ':scripts/' + name], check=True, capture_output=True, timeout=15).stdout
            source_path = self.source / 'scripts' / name
            self.secure(source_path)
            if (value != committed or bounded(source_path) != committed or
                    stat.S_IMODE(path.stat().st_mode) not in {0o600, 0o644, 0o700, 0o755}):
                raise ValueError('Delivered source differs from the pinned checkout contract')
            pins[name] = sha(value)
            modes[name] = stat.S_IMODE(path.stat().st_mode)
        if (head() != self.source_sha or bounded(self.source_record, 4096) != record or
                any(sha(bounded(self.install/'scripts'/name)) != pins[name] or
                    stat.S_IMODE((self.install/'scripts'/name).stat().st_mode) != modes[name] for name in names)):
            raise ValueError('Source identity changed during Update verification')
        helper = self.install / 'scripts/review-runtime-refresh.py'
        self.secure(helper)
        helper_bytes = bounded(helper)
        committed = subprocess.run(['git', '-C', str(self.source), 'show',
            self.source_sha + ':scripts/review-runtime-refresh.py'], check=True, capture_output=True, timeout=15).stdout
        helper_source = self.source / 'scripts/review-runtime-refresh.py'
        self.secure(helper_source)
        helper_mode = stat.S_IMODE(helper.stat().st_mode)
        if (helper_bytes != committed or bounded(helper_source) != committed or
                helper_mode not in {0o600, 0o644, 0o700, 0o755} or head() != self.source_sha or
                bounded(self.source_record, 4096) != record):
            raise ValueError('Refresh helper differs from the pinned source delivery')
        if require_legacy:
            self.selected_absent()
        return {'source_sha': self.source_sha, 'source_checkout': str(self.source),
                'source_record_sha256': sha(record), 'source_files': pins, 'source_modes': modes,
                'refresh_helper_sha256': sha(helper_bytes), 'refresh_helper_mode': helper_mode}

    def preservation(self):
        """Positive legacy recognition, including proxy and its dynamic cert pins."""
        self.selected_absent()
        files = {}
        for name, digest in LEGACY_SOURCE_HASHES.items():
            path = self.a4.TARGET if name == 'a4-credential-broker.py' else self.a3.TARGET / name
            files[path] = digest
        guest = self.a3.TARGET / 'a3-worker-guest.py'
        self.secure(guest)
        if sha(bounded(guest)) not in GUEST_REVIEW_COMPATIBILITY:
            raise ValueError(f'Legacy runtime source is unrecognized: {guest}')
        files[guest] = sha(bounded(guest))
        files.update({self.a3.UNIT: LEGACY_UNIT_HASHES['supervisor'], self.a4.UNIT: LEGACY_UNIT_HASHES['broker']})
        recorded = self.a3.read_journal()['files']
        for path, digest in ((self.a3.RENEW_SERVICE, LEGACY_UNIT_HASHES['renew_service']),
                            (self.a3.RENEW_TIMER, LEGACY_UNIT_HASHES['renew_timer'])):
            if str(path) in recorded:
                files[path] = digest
            elif path.exists():
                raise ValueError(f'Unowned renewal file requires separate review: {path}')
        proxy = self.a3.proxy
        journal = json.loads(bounded(proxy.JOURNAL))
        expected = {str(p) for p in (proxy.INSTALLED, proxy.CERT, proxy.KEY, proxy.UNIT)}
        if (journal.get('version') != 1 or journal.get('phase') != 'installed' or
                journal.get('vm_uuid') != self.vm or set(journal.get('files', {})) != expected):
            raise ValueError('Legacy proxy installation journal is unrecognized')
        files[proxy.INSTALLED] = LEGACY_SOURCE_HASHES['a3-origin-proxy.py']
        files[proxy.UNIT] = LEGACY_UNIT_HASHES['proxy']
        for path in (proxy.CERT, proxy.KEY):
            digest = journal['files'][str(path)]
            if not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
                raise ValueError('Proxy certificate/key journal digest is unknown')
            files[path] = digest
        for path, digest in files.items():
            self.secure(path)
            if sha(bounded(path)) != digest:
                raise ValueError(f'Legacy runtime source is unrecognized: {path}')
            if path in (proxy.INSTALLED, proxy.CERT, proxy.KEY, proxy.UNIT) and journal['files'][str(path)] != digest:
                raise ValueError('Legacy proxy installation digest mismatch')
        # A3 identity already validates each code/journal digest and receipt key.
        # Verify proxy service, target VM and certificate without a mutation.
        proxy.status()
        private = subprocess.run(['openssl', 'pkey', '-in', str(proxy.KEY), '-pubout', '-outform', 'DER'],
                                 check=True, capture_output=True, timeout=10).stdout
        public = subprocess.run(['openssl', 'x509', '-in', str(proxy.CERT), '-pubkey', '-noout'],
                                check=True, capture_output=True, timeout=10).stdout
        cert_der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public,
                                  check=True, capture_output=True, timeout=10).stdout
        if private != cert_der:
            raise ValueError('Existing proxy certificate/key identity mismatch')
        # Journals/certificate/key are preservation pins, not rollback backups.
        for path in self.targets[2:] + (proxy.JOURNAL, self.a3.PUBLIC_KEY):
            self.secure(path)
            files[path] = sha(bounded(path))
        result = {}
        for path, digest in files.items():
            mode = 0o600 if path in self.targets[2:] + (proxy.JOURNAL, proxy.KEY) else 0o644
            if stat.S_IMODE(path.stat().st_mode) != mode:
                raise ValueError(f'Legacy runtime file mode changed: {path}')
            result[str(path)] = [digest, mode]
        return result

    def preservation_paths(self):
        proxy = self.a3.proxy
        timers = tuple(p for p in (self.a3.RENEW_SERVICE, self.a3.RENEW_TIMER) if str(p) in self.a3.read_journal()['files'])
        return tuple(self.a3.TARGET / n for n in self.a3.SOURCES) + timers + (
            self.a4.TARGET, self.a3.UNIT, self.a4.UNIT,
            proxy.INSTALLED, proxy.UNIT, proxy.CERT, proxy.KEY, proxy.JOURNAL,
            self.targets[2], self.targets[3], self.a3.PUBLIC_KEY)

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
                recorded = old['files'].get(str(path))
                if (path == self.a3.TARGET / 'a3-worker-guest.py' and
                        (recorded, sha(data)) == GUEST_REVIEW_COMPATIBILITY):
                    self.secure(path)
                    if sha(bounded(path)) == recorded:
                        continue
                raise ValueError(f'Other A3 package/unit changes require separate review: {path}')
        if self.a4.read_journal()['files'].get(str(self.a4.UNIT)) != sha(self.a4.UNIT_TEXT.encode()):
            raise ValueError(f'Broker unit changes require separate review: {self.a4.UNIT}')
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

    def healthy(self, digests, key, new=False, allow_work=False):
        self.a3.unit_checks()
        self.a4.unit_checks()
        self.a3.renew_timer_checks(self.a3.read_journal())
        a = self.a3.wait_status(key)
        b = self.a4.wait_status(digests[1])
        active_work = (allow_work and isinstance(a.get('active'), dict) and
                       a['active'].get('state') in LIVE and a.get('blockers') == [])
        if (a['supervisor'].get('supervisor_sha256') != digests[0] or
                a.get('vm_uuid') != self.vm or (not allow_work and a.get('active') is not None) or
                (not a.get('accepting_launch') and not active_work) or b.get('vm_uuid') != self.vm):
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

    def preservation_db_idle(self):
        self.secure(self.database)
        database_idle(self.database, selected=True)

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
        if data.get('version') == 3:
            # A subsequently rolled-back package may return to the positively
            # recognized legacy profile. Only terminal preservation metadata
            # can be superseded; an interrupted selected update still refuses.
            validate_selected_preservation(data)
            if data['phase'] not in {'committed', 'rolled_back'}:
                raise ValueError('Incomplete selected preservation requires recovery')
            return data
        if data.get('version') == 2:
            fields = {'version', 'mode', 'phase', 'vm_uuid', 'source', 'key_id', 'protected', 'ledgers', 'files'}
            if data.get('phase') == 'committed':
                fields.add('completed_at')
            if (set(data) != fields or data.get('mode') != 'preserve_legacy' or
                    data.get('phase') not in {'applied', 'committed', 'rolled_back'} or data.get('vm_uuid') != self.host.vm or
                    not re.fullmatch('[0-9a-f]{64}', str(data.get('key_id'))) or
                    set(data.get('files', {})) != {str(p) for p in self.host.preservation_paths()} or
                    set(data.get('protected', {})) != {str(p) for p in self.host.protected} or
                    any(not isinstance(v, list) or len(v) != 2 or not re.fullmatch('[0-9a-f]{64}', str(v[0])) or
                        type(v[1]) is not int or v[1] not in {0o600, 0o644} for v in data['files'].values())):
                raise ValueError('Preservation transaction is unknown; refusing recovery')
            return data
        records = data.get('files', [])
        if (data.get('version') != 1 or not isinstance(records, list) or
                any(not isinstance(record, dict) for record in records) or data.get('vm_uuid') != self.host.vm or
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

    def ledgers(self, selected=False):
        values = []
        for path, field in zip(self.host.ledgers, ('supervisor_sha256', 'broker_sha256')):
            self.host.secure(path)
            values.append(ledger(path, self.host.vm, field))
        idle(*values)
        if selected:
            for record in values[0].get('selected_browser_model_runs', {}).values():
                if (record.get('state') not in {'active', 'cancelled'} or not isinstance(record.get('calls'), dict) or
                        any(call.get('state') not in {'completed', 'refused'} for call in record['calls'].values())):
                    raise ValueError('Active or unknown selected model reservation; inspect it before Update')
        return [sha(encoded(v)) for v in values]

    def unchanged(self, data):
        if self.protected() != data['protected'] or self.ledgers() != data['ledgers']:
            raise ValueError('Protected identity/configuration or runtime ledger changed; refusing overwrite')

    def preflight(self):
        if not self.host.opted_in():
            getattr(self.host, 'unconfigured_absent', lambda: None)()
            return {'skipped': True, 'reason': 'not_opted_in'}
        if self.journal.exists() and self.read()['phase'] not in {'committed', 'rolled_back'}:
            raise ValueError('Incomplete refresh; rollback required before another Update')
        key = self.host.identity()
        for n, path in enumerate(self.host.targets):
            self.host.secure(path)
            if stat.S_IMODE(path.stat().st_mode) != (0o644 if n < 2 else 0o600):
                raise ValueError('Installed code/journal permissions are unknown')
        digests = [sha(bounded(p)) for p in self.host.targets[:2]]
        self.host.healthy(digests, key)
        self.host.db_idle()
        self.ledgers()
        profile = getattr(self.host, 'source_profile', lambda: None)()
        if profile is not None:
            self.host.preservation_db_idle()
            self.ledgers(selected=True)
            return {'skipped': False, 'preserved': True, 'key_id': key, 'old': digests,
                    'source': profile, 'files': self.host.preservation(),
                    'selected_browser_available': False, 'reason': 'separate_runtime_package_required'}
        candidates = self.host.candidates()
        return {'skipped': False, 'key_id': key, 'old': digests,
                'new': [sha(candidates[p]) for p in self.host.targets[:2]]}

    def apply(self):
        result = self.preflight()
        if result['skipped']:
            return result
        self.host.backend_stopped()
        self.host.db_idle()
        if result.get('preserved'):
            data = {'version': 2, 'mode': 'preserve_legacy', 'phase': 'applied', 'vm_uuid': self.host.vm,
                    'source': result['source'], 'key_id': result['key_id'], 'protected': self.protected(),
                    'ledgers': self.ledgers(selected=True), 'files': result['files']}
            self.verify_preservation(data)
            self.host.secure(self.directory)
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if stat.S_IMODE(self.directory.stat().st_mode) != 0o700:
                raise ValueError('Preservation metadata directory must be private')
            self.save(data)
            self.verify_preservation(data)
            return dict(result, awaiting_dashboard_health=True, runtime_changed=False)
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
        if data.get('version') == 2:
            self.host.preservation_db_idle()
            self.ledgers(selected=True)  # Check current idle state; never restore old history.
            self.verify_preservation(data)
            data['phase'] = 'rolled_back'
            self.save(data)
            return {'preserved': True, 'rolled_back': True, 'runtime_changed': False, 'replayed': False}
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
        if data.get('version') == 2:
            # Dashboard may have admitted legitimate work. Runtime history is
            # not compared with the pre-update snapshot and is never restored.
            self.verify_preservation(data, allow_work=True)
            data['phase'] = 'committed'
            data['completed_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            self.save(data)
            return {'committed': True, 'preserved': True, 'runtime_changed': False,
                    'selected_browser_available': False, 'reason': 'separate_runtime_package_required'}
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

    def verify_preservation(self, data, allow_work=False):
        if (self.host.identity() != data['key_id'] or self.protected() != data['protected'] or
                self.host.source_profile() != data['source'] or self.host.preservation() != data['files']):
            raise ValueError('Preserved runtime/source identity drift; no runtime restoration authorized')
        if not allow_work:
            self.host.preservation_db_idle()
            if self.ledgers(selected=True) != data['ledgers']:
                raise ValueError('Runtime ledger changed during preservation admission')
        self.host.healthy([sha(bounded(p)) for p in self.host.targets[:2]], data['key_id'], allow_work=allow_work)


def validate_selected_preservation(value):
    fields = {'version', 'mode', 'phase', 'snapshot'}
    if value.get('phase') == 'committed':
        fields.add('completed_at')
    if (set(value) != fields or value.get('version') != 3 or value['mode'] != 'preserve_selected' or
            value['phase'] not in {'applied', 'committed', 'rolled_back'} or
            not isinstance(value['snapshot'], dict) or
            set(value['snapshot']) != {'source', 'package_transaction', 'identity', 'files', 'protected', 'units', 'ledgers'}):
        raise ValueError('Selected preservation transaction is unknown')


def verify_package_journals(package, module, transaction, journals, side):
    """Only the owned certificate renewal may alter journal metadata."""
    for index, path in enumerate(module.JOURNALS):
        slot = list(module.OWNED).index(path)
        staged = module.TRANSACTION + '/' + transaction['id'] + '/' + side + '-' + str(slot)
        original_bytes = package.t.read(staged)
        original_pin = transaction['files'][path][side]
        if sha(original_bytes) != original_pin['sha256'] or len(original_bytes) != original_pin['bytes']:
            raise ValueError('Selected package journal evidence changed')
        original, current = json.loads(original_bytes), json.loads(json.dumps(journals[index]))
        if index == 1:
            for cert in (module.ROOT + '/proxy-cert.pem', module.ROOT + '/proxy-key.pem'):
                original['files'].pop(cert)
                current['files'].pop(cert)
        if original != current:
            raise ValueError('Selected installation journal metadata changed')


def verify_rolled_back_package(package, module):
    transaction = package.tx()
    if transaction['phase'] != 'rolled_back':
        raise ValueError('Retained package transaction is not rolled back')
    journals, pins = package.installed('install')
    for path, pin in pins.items():
        if path not in module.JOURNALS and pin != transaction['files'][path]['old']:
            raise ValueError('Rolled-back package differs from its original files')
    verify_package_journals(package, module, transaction, journals, 'old')
    # Legacy positive recognition independently verifies the old code, current
    # certificate/key, VM and serving identity. Retained metadata is not deleted.


class SelectedRefresh:
    """Metadata-only preservation of a separately committed selected package.

    Source equivalence is deliberately strict: a normal application update may
    preserve the package, but changing its code/units requires package review.
    No method starts/stops runtime services or restores runtime/business data.
    """
    def __init__(self, host, package, module, directory=TRANSACTION):
        self.host, self.package = host, package
        self.module = module
        self.h, self.t = package.h, package.t
        self.directory = str(directory)
        self.journal = self.directory + '/transaction.json'

    def read(self):
        if self.t.read(self.journal, missing=True) is None:
            return None
        if (stat.S_IMODE(self.t.secure(self.directory).st_mode) != 0o700 or
                self.t.pin(self.journal)['mode'] != 0o600):
            raise ValueError('Selected preservation metadata custody changed')
        value = json.loads(self.t.read(self.journal))
        if value.get('version') != 3:
            # The legacy update immediately preceding package enrollment may
            # leave a completed metadata record. Never supersede an incomplete
            # or structurally unknown historical transaction.
            prior = Refresh(self.host, Path(self.directory)).read()
            if prior['phase'] not in {'committed', 'rolled_back'}:
                raise ValueError('Incomplete legacy refresh requires recovery')
            return prior
        validate_selected_preservation(value)
        return value

    def save(self, value):
        self.t.mkdir(self.directory, 0o700)
        if stat.S_IMODE(self.t.secure(self.directory).st_mode) != 0o700:
            raise ValueError('Selected preservation directory must remain private')
        self.t.write(self.journal, encoded(value), 0o600)

    def snapshot(self, allow_work=False):
        profile = self.host.source_profile(require_legacy=False)
        if profile is None:
            raise ValueError('Selected runtime requires its reviewed source contract')
        # Import is performed only after source_profile attests the delivered
        # package helper and refresh helper against the pinned Git revision.
        module = self.module
        transaction = self.package.tx()
        side = 'new'
        if transaction['phase'] == 'rolled_back' and transaction['operation'] == 'update':
            side = 'old'
        elif transaction['phase'] != 'committed':
            raise ValueError('Selected package must be committed or its upgrade fully rolled back before ordinary Update')
        journals, pins = self.package.installed('update')
        revision, sources, checkout = self.h.sources()
        if revision != profile['source_sha'] or checkout['path'] != profile['source_checkout']:
            raise ValueError('Selected package and updater source identity differ')
        candidates = module.candidate_files(sources)
        for path, value in candidates.items():
            if (pins[path]['sha256'] != sha(value) or pins[path] != transaction['files'][path][side]):
                raise ValueError('Selected runtime code/unit change requires a separately reviewed package update')
        # The certificate renewer may legitimately update the certificate/key
        # hashes in the proxy journal. Preserve all journal metadata; only that
        # documented pair may differ from the committed generation.
        verify_package_journals(self.package, module, transaction, journals, side)
        identity = self.h.identity(allow_work=allow_work)
        # Reboots and the owned renewal job do not change the enrolled machine,
        # VM, effective network/Chromium policy or receipt signing identity.
        stable = ('machine_id', 'vm_uuid', 'vm_configuration_sha256', 'nft_sha256', 'managed_policy_sha256', 'key_id')
        if any(identity.get(k) != transaction['identity'].get(k) for k in stable):
            raise ValueError('Selected enrollment identity/policy changed')
        protected = self.package.protected()
        units = self.h.unit_check()
        self.h.health(pins, identity['key_id'], True, allow_work=allow_work)
        ledgers = None
        if not allow_work:
            self.host.preservation_db_idle()
            ledgers = module.idle_ledgers(self.t)
        return dict(source=profile,
                    package_transaction=self.t.pin(module.TRANSACTION + '/transaction.json'),
                    identity=identity, files=pins, protected=protected, units=units, ledgers=ledgers)

    def preflight(self):
        prior = self.read()
        if prior is not None and prior['phase'] not in {'committed', 'rolled_back'}:
            raise ValueError('Incomplete selected preservation requires rollback before Update')
        return self.snapshot()

    @staticmethod
    def result(**extra):
        # Runtime acceptance/readiness is evaluated by the real runtime API.
        # Installation preservation must not invent availability or proof.
        return dict(preserved=True, runtime_changed=False, mode='preserve_selected',
                    acceptance_created=False, readiness_recheck_required=True, **extra)

    def apply(self):
        self.preflight()
        self.h.stopped_backend()
        snapshot = self.snapshot()
        data = dict(version=3, mode='preserve_selected', phase='applied', snapshot=snapshot)
        self.save(data)
        if self.snapshot() != snapshot:
            raise ValueError('Selected runtime/source changed during preservation')
        return self.result(awaiting_dashboard_health=True)

    def finish(self, operation):
        data = self.read()
        if data is None:
            return {'skipped': True, 'reason': 'no_transaction'}
        if data['phase'] in {'committed', 'rolled_back'}:
            return {'skipped': True, 'reason': data['phase']}
        if data.get('version') != 3 or data['phase'] != 'applied':
            raise ValueError('Unknown selected preservation recovery')
        if operation == 'rollback':
            self.h.stopped_backend()
        current = self.snapshot(allow_work=operation == 'commit')
        expected = dict(data['snapshot'])
        if operation == 'commit':
            # The healthy dashboard may have admitted new work. Never restore,
            # compare or settle historical reservations after restart.
            expected['ledgers'] = None
        if current != expected:
            raise ValueError('Selected preservation drift; no runtime restoration authorized')
        data['phase'] = 'committed' if operation == 'commit' else 'rolled_back'
        if operation == 'commit':
            data['completed_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        self.save(data)
        return self.result(**{data['phase']: True})

    def commit(self):
        return self.finish('commit')

    def rollback(self):
        return self.finish('rollback')


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
        getattr(host, 'unconfigured_absent', lambda: None)()
        print(json.dumps({'skipped': True, 'reason': 'not_opted_in'}))
        return
    lock = Path('/run/proxypilot-a3-fence.lock')
    host.secure(lock)
    with lock.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        selected = TRANSACTION.parent / 'selected-runtime-package'
        host.secure(selected)
        if selected.exists():
            host.source_profile(require_legacy=False)
            package_module = load('selected-runtime-package', args.install_dir / 'scripts')
            package_host = package_module.Host()
            package = package_module.Package(package_host)
            transaction = package.tx()
            if transaction['phase'] == 'rolled_back' and transaction['operation'] == 'install':
                host.rolled_back_check = lambda: verify_rolled_back_package(package, package_module)
                host.rolled_back_check()
                flow = Refresh(host)
            else:
                flow = SelectedRefresh(host, package, package_module)
        else:
            flow = Refresh(host)
        print(json.dumps(getattr(flow, args.action)()))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print subprocess output or a configuration/ledger payload.
        detail = str(error) if isinstance(error, ValueError) else type(error).__name__
        print('Review runtime refresh refused: ' + detail, file=sys.stderr)
        sys.exit(1)
