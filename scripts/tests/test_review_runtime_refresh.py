"""Real fixed-file transactions with simulated service/VM/socket operations."""
import importlib.util
import base64
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
import uuid
import zlib
from unittest.mock import patch
from contextlib import redirect_stdout
from guest_compatibility_fixture import legacy_guest_source, LEGACY_GUEST_SHA, BASELINE_GUEST_SHA

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('refresh_test', ROOT / 'review-runtime-refresh.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

PR724 = '9b88f8f03925ee4c4cf097e40429897be9195e2f'
PR724_BUNDLE_SHA = 'e64b0397323eac04037945e32982ca5d8b0a46a1b64c4e03e19e24d0da467586'
PR724_NAMES = ('a3-install-supervisor.py','a3-install-proxy.py','a3-install-fence.py','a3-network-fence.py',
               'a3-origin-proxy.py','a3-worker-supervisor.py','a4-install-broker.py','a4-credential-broker.py','a8-wire-dashboard.py')


def reviewed_legacy_package(directory):
    """Authentic PR724 package, independent of current code and Git history.

    The test-only bundle was extracted with git show at PR724. Its whole-file
    hash and each source hash are checked before any historical helper loads.
    Production updater allowlists/guest compatibility pins are never patched.
    """
    bundle = ROOT / 'tests/fixtures/review-runtime-pr724-sources.json'
    raw = bundle.read_bytes()
    if r.sha(raw) != PR724_BUNDLE_SHA:
        raise AssertionError('Frozen PR724 runtime bundle must keep its reviewed hash')
    data = json.loads(raw)
    if data['source_commit'] != PR724 or set(data['files']) != set(PR724_NAMES):
        raise AssertionError('Unknown historical runtime package')
    directory.mkdir(parents=True)
    for name in PR724_NAMES:
        value = data['files'][name]
        source = zlib.decompress(base64.b64decode(value['zlib_base64'],validate=True))
        if r.sha(source) != value['sha256']:
            raise AssertionError('Historical source digest mismatch: ' + name)
        (directory/name).write_bytes(source)
    guest = (ROOT/'tests/fixtures/a3-worker-guest-pr724.py.txt').read_bytes()
    if r.sha(guest) != BASELINE_GUEST_SHA:
        raise AssertionError('Frozen PR724 guest source changed')
    (directory/'a3-worker-guest.py').write_bytes(guest)
    return directory


def grown_supervisor_ledger(vm):
    """Retained terminal history accepted by the existing supervisor loader."""
    data = {'version': 1, 'vm_uuid': vm, 'active': None, 'runs': {}, 'attempts': {}}
    for index in range(500):
        identity = str(uuid.UUID(int=index + 1, version=4))
        data['attempts'][identity] = {
            'attempt_id': identity, 'run_id': identity, 'workspace_id': identity,
            'state': 'stopped', 'fence': 1, 'workload': 'browser', 'actions': [],
            'unit': 'pp-a3-worker-' + identity,
            'log': [['2026-10-02T12:00:00Z', 'worker_stopped'] for _ in range(100)],
        }
    return r.encoded(data)


class FixtureHost:
    vm = '49592202-a8b0-45af-9ac6-5439761d73e4'
    source_sha = 'a' * 40

    def __init__(self, root):
        self.root = root
        self.targets = tuple(root / p for p in ('etc/a3.py', 'etc/a4.py', 'state/a3-install.json', 'state/a4-install.json'))
        self.ledgers = tuple(root / p for p in ('state/supervisor.json', 'state/broker.json'))
        self.protected = tuple(root / p for p in ('etc/private.pem', 'etc/public.pem', 'etc/a8.pem', 'etc/config.json', 'compose.yml'))
        self.key = 'f' * 64
        self.enabled = True
        self.running = True
        self.backend = False
        self.events = []
        self.fail = None
        self.race = None
        self.install = root
        self.database = root / 'dashboard.db'
        for n, path in enumerate(self.targets[:2]):
            self.write(path, f'#!/usr/bin/env python3\nold_{n} = True\n'.encode(), 0o644)
        for n, path in enumerate(self.targets[2:]):
            self.write(path, r.encoded({'version': 1, 'vm_uuid': self.vm, 'key_id': self.key,
                                       'phase': 'installed', 'files': {str(self.targets[n]): r.sha(self.targets[n].read_bytes())},
                                       'untouched': 'other-file-pin'}), 0o600)
        self.write(self.ledgers[0], r.encoded({'version': 1, 'vm_uuid': self.vm, 'active': None,
                                             'attempts': {}, 'runs': {}, 'public_reviews': {}}), 0o600)
        self.write(self.ledgers[1], r.encoded({'version': 1, 'vm_uuid': self.vm, 'calls': {},
                                             'provider': {'revision': 7}, 'prices': {'revision': 9},
                                             'bindings': {'keep': {'revision': 2}}, 'runs': {}}), 0o600)
        for n, path in enumerate(self.protected):
            self.write(path, f'existing-secret-or-pin-{n}'.encode(), 0o600)
        with sqlite3.connect(self.database) as db:
            db.executescript('CREATE TABLE ops_agent_runs (state TEXT); CREATE TABLE ops_website_review_runs (state TEXT);')
        self.events.clear()

    def secure(self, path):
        if path.is_symlink():
            raise ValueError('symlink')

    def write(self, path, data, mode):
        if getattr(self, 'fail', None) == ('write', path):
            self.fail = None
            raise OSError('injected replacement failure')
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_bytes(data)
        temporary.chmod(mode)
        os.replace(temporary, path)
        self.events.append(('write', path))

    def opted_in(self):
        return self.enabled

    def candidates(self):
        return {p: f'#!/usr/bin/env python3\nnew_{n} = True\n'.encode() for n, p in enumerate(self.targets[:2])}

    def identity(self):
        for n, path in enumerate(self.targets[2:]):
            data = json.loads(path.read_text())
            if data['vm_uuid'] != self.vm or data['key_id'] != self.key:
                raise ValueError('identity mismatch')
            if data['files'][str(self.targets[n])] != r.sha(self.targets[n].read_bytes()):
                raise ValueError('digest mismatch')
        return self.key

    def healthy(self, digests, key, new=False):
        self.events.append(('health', new))
        if self.fail == ('health', new):
            self.fail = None
            raise ValueError('injected health failure')
        if not self.running or digests != [r.sha(p.read_bytes()) for p in self.targets[:2]] or key != self.key:
            raise ValueError('wrong serving digest/key')
        return {'contract_version': 'website-review.v1', 'available': False, 'code': 'PROVIDER_UNAVAILABLE'} if new else None

    def backend_stopped(self):
        self.events.append(('backend_stopped',))
        if self.backend:
            raise ValueError('backend still running')

    def db_idle(self):
        self.events.append(('db_idle',))
        if self.race:
            race, self.race = self.race, None
            race()
        r.database_idle(self.database)

    def stop(self):
        self.events.append(('stop',))
        if self.fail == ('stop',):
            self.fail = None
            raise OSError('injected stop failure')
        self.running = False

    def start(self):
        self.events.append(('start',))
        if self.fail == ('start',):
            self.fail = None
            raise OSError('injected start failure')
        self.running = True


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.host = FixtureHost(Path(self.temp.name))
        self.refresh = r.Refresh(self.host, self.host.root / 'transaction')
        self.original = {p: (p.read_bytes(), p.stat().st_mode & 0o777) for p in self.host.targets + self.host.protected}
        self.ledger_original = self.refresh.ledgers()

    def tearDown(self):
        self.temp.cleanup()

    def assert_preserved(self):
        for p in self.host.protected:
            self.assertEqual((p.read_bytes(), p.stat().st_mode & 0o777), self.original[p])
        self.assertEqual(self.refresh.ledgers(), self.ledger_original)

    def test_no_optin_no_files_services_or_backup(self):
        self.host.enabled = False
        self.assertTrue(self.refresh.preflight()['skipped'])
        self.assertTrue(self.refresh.apply()['skipped'])
        self.assertFalse(self.refresh.directory.exists())
        self.assertEqual(self.host.events, [])

    def test_grown_ledger_keeps_activity_identity_and_unknown_state_denials(self):
        path = self.host.ledgers[0]
        data = json.loads(grown_supervisor_ledger(self.host.vm))
        self.assertGreater(len(r.encoded(data)), 2998598)
        attempt = next(iter(data['attempts'].values()))
        for state, message in (('running', 'Active Demo'), ('unreviewed-state', 'Unknown runtime')):
            attempt['state'] = state
            self.host.write(path, r.encoded(data), 0o600)
            with self.assertRaisesRegex(ValueError, message):
                self.refresh.preflight()
            self.assertNotIn(('stop',), self.host.events)
        attempt['state'] = 'stopped'
        data['vm_uuid'] = 'unknown-vm'
        self.host.write(path, r.encoded(data), 0o600)
        with self.assertRaisesRegex(ValueError, 'ledger identity.*' + str(path)):
            self.refresh.preflight()

    def test_both_ledger_reads_use_the_separate_cap_and_never_treat_absence_as_empty(self):
        for path in self.host.ledgers:
            original = path.read_bytes()
            path.write_bytes(original + b' ' * (3 * 1024 * 1024))
            self.assertFalse(self.refresh.preflight()['skipped'])
            with path.open('wb') as stream:
                stream.truncate(r.MAX_LEDGER + 1)
            with self.assertRaisesRegex(ValueError, f'exceeds {r.MAX_LEDGER}-byte limit: {path}'):
                self.refresh.preflight()
            path.unlink()
            with self.assertRaisesRegex(ValueError, 'file is missing: ' + str(path)):
                self.refresh.preflight()
            path.write_bytes(b'not JSON or ledger data')
            with self.assertRaisesRegex(ValueError, 'not valid UTF-8 JSON: ' + str(path)):
                self.refresh.preflight()
            path.write_bytes(original.decode().encode('utf-16'))
            with self.assertRaisesRegex(ValueError, 'not valid UTF-8 JSON: ' + str(path)):
                self.refresh.preflight()
            path.write_bytes(original)
        self.assertNotIn(('stop',), self.host.events)

    def test_large_ledger_provider_work_and_foreign_mutation_still_refuse(self):
        path = self.host.ledgers[0]
        self.host.write(path, grown_supervisor_ledger(self.host.vm), 0o600)
        broker = json.loads(self.host.ledgers[1].read_bytes())
        broker['calls']['active-call'] = {'state': 'sent'}
        self.host.write(self.host.ledgers[1], r.encoded(broker), 0o600)
        with self.assertRaisesRegex(ValueError, 'Active provider'):
            self.refresh.preflight()
        broker['calls'] = {}
        self.host.write(self.host.ledgers[1], r.encoded(broker), 0o600)
        self.refresh.apply()
        before = path.read_bytes()
        data = json.loads(before)
        next(iter(data['attempts'].values()))['log'].append(['2026-10-02T18:00:00Z', 'foreign-change'])
        path.write_bytes(r.encoded(data))
        self.host.events.clear()
        with self.assertRaisesRegex(ValueError, 'runtime ledger changed'):
            self.refresh.rollback()
        self.assertNotIn(('stop',), self.host.events)
        path.write_bytes(before)
        self.refresh.rollback()
        self.assertEqual(path.read_bytes(), before)

    def test_success_keeps_exact_keys_configuration_permissions_and_journal_identity(self):
        result = self.refresh.apply()
        self.assertTrue(result['refreshed'])
        self.assertEqual(result['readiness']['code'], 'PROVIDER_UNAVAILABLE')
        self.assertEqual(self.refresh.read()['phase'], 'applied')
        self.assertEqual(self.host.targets[0].read_bytes(), self.host.candidates()[self.host.targets[0]])
        for n, path in enumerate(self.host.targets[2:]):
            old, new = json.loads(self.original[path][0]), json.loads(path.read_text())
            old['files'][str(self.host.targets[n])] = new['files'][str(self.host.targets[n])]
            self.assertEqual(old, new)
        self.assert_preserved()
        self.refresh.commit()
        self.assertEqual(self.refresh.read()['phase'], 'committed')
        self.assertTrue(self.refresh.commit()['skipped'])
        self.assertTrue(self.refresh.rollback()['skipped'])

    def test_repeat_apply_refuses_pending_and_successful_update_can_repeat_after_commit(self):
        self.refresh.apply()
        with self.assertRaisesRegex(ValueError, 'Incomplete refresh'):
            self.refresh.apply()
        self.refresh.commit()
        self.host.events.clear()
        self.assertTrue(self.refresh.apply()['unchanged'])
        self.assertNotIn(('stop',), self.host.events)
        self.refresh.commit()
        self.assert_preserved()

    def test_each_replacement_restart_and_health_failure_rolls_back_both_components(self):
        for failure in [('write', p) for p in self.host.targets] + [('stop',), ('start',), ('health', True)]:
            with self.subTest(failure=failure):
                self.host.fail = failure
                with self.assertRaises((OSError, ValueError)):
                    self.refresh.apply()
                self.refresh.rollback()
                for path in self.host.targets:
                    self.assertEqual((path.read_bytes(), path.stat().st_mode & 0o777), self.original[path])
                self.assertTrue(self.host.running)
                self.assert_preserved()
                self.assertEqual(self.refresh.read()['phase'], 'rolled_back')

    def test_backend_live_db_start_race_and_demo_work_are_refused_before_stop(self):
        self.host.backend = True
        with self.assertRaisesRegex(ValueError, 'backend'):
            self.refresh.apply()
        self.host.backend = False
        def start():
            with sqlite3.connect(self.host.database) as db:
                db.execute("INSERT INTO ops_website_review_runs VALUES ('queued')")
        self.host.race = start
        with self.assertRaisesRegex(ValueError, 'Active dashboard'):
            self.refresh.apply()
        with sqlite3.connect(self.host.database) as db:
            db.execute('DELETE FROM ops_website_review_runs')
        data = json.loads(self.host.ledgers[0].read_text())
        data['attempts']['demo'] = {'state': 'launching'}
        self.host.write(self.host.ledgers[0], r.encoded(data), 0o600)
        with self.assertRaisesRegex(ValueError, 'Active Demo'):
            self.refresh.apply()
        self.assertNotIn(('stop',), self.host.events)

    def test_active_provider_and_unknown_review_refused_uncertain_reservation_retained(self):
        broker = json.loads(self.host.ledgers[1].read_text())
        for state in ('reserved', 'sent'):
            broker['calls']['c'] = {'state': state, 'reservation': '0.03'}
            self.host.write(self.host.ledgers[1], r.encoded(broker), 0o600)
            with self.assertRaisesRegex(ValueError, 'Active provider'):
                self.refresh.apply()
        broker['calls']['c']['state'] = 'uncertain'
        self.host.write(self.host.ledgers[1], r.encoded(broker), 0o600)
        supervisor = json.loads(self.host.ledgers[0].read_text())
        supervisor['public_reviews']['r'] = {'state': 'reserved', 'call_id': 'c'}
        self.host.write(self.host.ledgers[0], r.encoded(supervisor), 0o600)
        self.ledger_original = self.refresh.ledgers()
        self.refresh.apply()
        self.refresh.rollback()
        self.assert_preserved()
        broker['calls']['c']['state'] = 'provider_error'
        self.host.write(self.host.ledgers[1], r.encoded(broker), 0o600)
        self.assertFalse(self.refresh.preflight()['skipped'])
        supervisor['public_reviews']['r']['call_id'] = 'unknown'
        self.host.write(self.host.ledgers[0], r.encoded(supervisor), 0o600)
        with self.assertRaisesRegex(ValueError, 'Unverifiable'):
            self.refresh.apply()

    def test_rollback_refuses_foreign_digest_key_config_ledger_and_backup_drift(self):
        self.refresh.apply()
        victims = [self.host.targets[0], self.host.protected[0], self.host.protected[3],
                   self.host.ledgers[1], self.refresh.directory / 'old-0']
        for victim in victims:
            with self.subTest(victim=victim):
                old = victim.read_bytes()
                victim.write_bytes(old + b'\nforeign-change')
                self.host.events.clear()
                with self.assertRaises(ValueError):
                    self.refresh.rollback()
                self.assertNotIn(('stop',), self.host.events)
                victim.write_bytes(old)
        self.refresh.rollback()
        self.assert_preserved()

    def test_tampered_transaction_cannot_select_arbitrary_path_or_mode(self):
        self.refresh.apply()
        original = self.refresh.journal.read_bytes()
        for field, value in [('path', '/etc/shadow'), ('mode', 0o777), ('old', 'unknown')]:
            data = json.loads(original)
            data['files'][0][field] = value
            self.refresh.journal.write_bytes(r.encoded(data))
            with self.assertRaisesRegex(ValueError, 'transaction is unknown'):
                self.refresh.rollback()
        self.refresh.journal.write_bytes(original)
        self.refresh.rollback()

    def test_commit_allows_later_legitimate_work_and_never_restores_ledger(self):
        self.refresh.apply()
        state = json.loads(self.host.ledgers[1].read_text())
        state['calls']['new'] = {'state': 'sent', 'reservation': '0.04'}
        self.host.write(self.host.ledgers[1], r.encoded(state), 0o600)
        self.refresh.commit()
        self.assertEqual(json.loads(self.host.ledgers[1].read_text()), state)
        self.assertTrue(self.refresh.rollback()['skipped'])

    def test_missing_unknown_database_and_private_backup_modes_refuse(self):
        with sqlite3.connect(self.host.database) as db:
            db.execute('DROP TABLE ops_agent_runs')
        with self.assertRaisesRegex(ValueError, 'schema'):
            self.refresh.preflight()
        with sqlite3.connect(self.host.database) as db:
            db.execute('CREATE TABLE ops_agent_runs (state TEXT)')
        self.refresh.apply()
        (self.refresh.directory / 'old-0').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'digest drift'):
            self.refresh.rollback()

    def test_source_mode_transaction_custody_and_unknown_work_state_refuse(self):
        self.host.targets[0].chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'permissions are unknown'):
            self.refresh.apply()
        self.host.targets[0].chmod(0o644)
        state = json.loads(self.host.ledgers[1].read_text())
        state['calls']['c'] = {'state': 'new-unreviewed-state'}
        self.host.write(self.host.ledgers[1], r.encoded(state), 0o600)
        with self.assertRaisesRegex(ValueError, 'Unknown runtime'):
            self.refresh.apply()
        state['calls'].clear()
        self.host.write(self.host.ledgers[1], r.encoded(state), 0o600)
        self.refresh.apply()
        self.refresh.directory.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'custody/mode'):
            self.refresh.rollback()


class HostContractTests(unittest.TestCase):
    def test_required_input_errors_distinguish_missing_nonregular_and_code_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'input'
            with self.assertRaisesRegex(ValueError, 'file is missing: ' + str(path)):
                r.bounded(path)
            path.mkdir()
            with self.assertRaisesRegex(ValueError, 'not a regular file: ' + str(path)):
                r.bounded(path)
            path.rmdir()
            path.symlink_to(Path(temp))
            with self.assertRaisesRegex(ValueError, 'not a regular file: ' + str(path)):
                r.bounded(path)
            path.unlink()
            with path.open('wb') as stream:
                stream.truncate(r.MAX_FILE + 1)
            with self.assertRaisesRegex(ValueError, f'exceeds {r.MAX_FILE}-byte limit: {path}'):
                r.bounded(path)
            path.write_bytes(b'bounded input')
            self.assertEqual(r.bounded(path), b'bounded input')
            with patch.object(r.os, 'open', side_effect=PermissionError('sensitive error detail')):
                with self.assertRaisesRegex(ValueError, 'cannot be read: ' + str(path) + r' \(PermissionError\)') as caught:
                    r.bounded(path)
            self.assertNotIn('sensitive error detail', str(caught.exception))

    def test_descriptor_read_stays_bounded_if_file_grows_after_stat(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'input'
            path.write_bytes(b'x')
            real_fdopen = r.os.fdopen
            reader = io.BytesIO(b'x' * 9)
            seen = []
            def fdopen(fd, mode):
                actual = real_fdopen(fd, mode)
                class GrowingFile:
                    def __enter__(self):
                        return self
                    def __exit__(self, *args):
                        actual.close()
                    def fileno(self):
                        return actual.fileno()
                    def read(self, size):
                        seen.append(size)
                        return reader.read(size)
                return GrowingFile()
            with patch.object(r.os, 'fdopen', fdopen):
                with self.assertRaisesRegex(ValueError, 'grew beyond 8-byte limit: ' + str(path)):
                    r.bounded(path, 8)
            self.assertEqual(seen, [9])

    def test_cli_never_creates_lock_or_backup_for_unconfigured_installs(self):
        with tempfile.TemporaryDirectory() as temp:
            host = FixtureHost(Path(temp))
            host.enabled = False
            for action in ('preflight', 'apply', 'rollback', 'commit'):
                argv = ['refresh', action, '--install-dir', temp, '--source-dir', temp,
                        '--source-sha', 'a' * 40, '--database', str(host.database)]
                with patch.object(r.sys, 'argv', argv), patch.object(r.os, 'geteuid', lambda: 0), \
                        patch.object(r, 'Host', lambda *_: host), \
                        patch.object(r, 'TRANSACTION', host.root / 'transaction'), \
                        patch.object(r.fcntl, 'flock', side_effect=AssertionError('No lock on unconfigured install')), \
                        redirect_stdout(io.StringIO()):
                    r.main()
            self.assertFalse((host.root / 'transaction').exists())
            self.assertEqual(host.events, [])
    @unittest.skipUnless(shutil.which('openssl'), 'openssl required for exact existing key proof')
    def test_real_installer_journals_key_pair_and_a8_pin_survive_refresh_and_rollback(self):
        # Exercise the production installer/file/key adapters with a real
        # Ed25519 pair. Only VM/service/socket readback is simulated.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            host = r.Host.__new__(r.Host)
            baseline = reviewed_legacy_package(root/'reviewed-pr724')
            host.a3 = r.load('a3-install-supervisor', baseline)
            host.a4 = r.load('a4-install-broker', baseline)
            host.a8 = r.load('a8-wire-dashboard', baseline)
            host.vm, host.install, host.source = host.a8.VM, root, root
            for directory in ('etc/supervisor', 'state/supervisor', 'etc/broker', 'state/broker', 'etc/a8', 'run/backend', 'scripts', 'systemd'):
                (root / directory).mkdir(parents=True, exist_ok=True)
            a, b, w = host.a3, host.a4, host.a8
            a.TARGET, a.UNIT = root / 'etc/supervisor', root / 'systemd/proxypilot-a3-supervisor.service'
            a.KEY, a.PUBLIC_KEY = root / 'etc/private.pem', root / 'etc/public.pem'
            a.JOURNAL, a.STATE_DIR = root / 'state/a3-install.json', root / 'state/supervisor'
            a.RENEW_SERVICE, a.RENEW_TIMER = root / 'systemd/renew.service', root / 'systemd/renew.timer'
            b.TARGET, b.UNIT, b.JOURNAL = root / 'etc/broker/a4-credential-broker.py', root / 'systemd/broker.service', root / 'state/a4-install.json'
            b.broker.CONFIG, b.broker.JOURNAL = root / 'etc/broker-config.json', root / 'state/broker/state.json'
            w.KEY_DIR, w.KEY, w.SOURCE_KEY = root / 'etc/a8', root / 'etc/a8/supervisor-pub.pem', a.PUBLIC_KEY
            w.SOCKET = root / 'run/backend/supervisor.sock'
            host.targets = (a.TARGET / 'a3-worker-supervisor.py', b.TARGET, a.JOURNAL, b.JOURNAL)
            host.ledgers = (a.STATE_DIR / 'state.json', b.broker.JOURNAL)
            host.protected = (a.KEY, a.PUBLIC_KEY, w.KEY, b.broker.CONFIG, root / 'docker-compose.yml')
            host.secure = lambda _: None
            a.i.secure = b.broker.secure = w.secure = lambda _: None
            for name in a.SOURCES:
                shutil.copyfile(baseline / name, root / 'scripts' / name)
            shutil.copyfile(baseline / 'a4-credential-broker.py', root / 'scripts/a4-credential-broker.py')
            subprocess.run(['git', 'init', '-q', str(root)], check=True, capture_output=True)
            subprocess.run(['git', '-C', str(root), 'add', 'scripts'], check=True, capture_output=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                            'commit', '-qm', 'Fixture reviewed sources'], check=True, capture_output=True)
            host.source_sha = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'],
                                             check=True, capture_output=True, text=True).stdout.strip()
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(a.KEY)], check=True, capture_output=True)
            a.KEY.chmod(0o600)
            subprocess.run(['openssl', 'pkey', '-in', str(a.KEY), '-pubout', '-out', str(a.PUBLIC_KEY)], check=True, capture_output=True)
            a.PUBLIC_KEY.chmod(0o644)
            shutil.copyfile(a.PUBLIC_KEY, w.KEY)
            w.KEY.chmod(0o600)
            w.KEY_DIR.chmod(0o700)
            w.SOCKET.parent.chmod(0o700)
            import socket
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(w.SOCKET))
            w.SOCKET.chmod(0o600)
            try:
                key = a.key_id(a.PUBLIC_KEY)
                afiles = a.plan_files(root / 'scripts')
                afiles[a.PUBLIC_KEY] = a.PUBLIC_KEY.read_bytes()
                afiles[host.targets[0]] += b'\n# previously installed source\n'
                guest = a.TARGET / 'a3-worker-guest.py'
                afiles[guest] = legacy_guest_source()
                bfiles = {b.TARGET: (root / 'scripts/a4-credential-broker.py').read_bytes() + b'\n# previous source\n',
                          b.UNIT: b.UNIT_TEXT.encode()}
                for files, journal in ((afiles, a.JOURNAL), (bfiles, b.JOURNAL)):
                    for path, data in files.items():
                        host.write(path, data, 0o644)
                    host.write(journal, r.encoded({'version': 1, 'phase': 'installed', 'vm_uuid': host.vm,
                                                 'key_id': key, 'files': {str(p): r.sha(d) for p, d in files.items()}}), 0o600)
                fixture = FixtureHost(root / 'fixture')
                for destination, source in zip(host.ledgers, fixture.ledgers):
                    host.write(destination, source.read_bytes(), 0o600)
                large_history = grown_supervisor_ledger(host.vm)
                self.assertGreater(len(large_history), 2998598)
                host.write(host.ledgers[0], large_history, 0o600)
                supervisor = r.load('a3-worker-supervisor', baseline)
                supervisor.installer.secure = lambda _: None
                loaded = supervisor.Supervisor(host=object(), journal=host.ledgers[0], runner_source='# fixture')
                self.assertEqual(loaded.state, json.loads(large_history))
                host.write(b.broker.CONFIG, b'{"role_id":"existing-role","secret_id":"existing-secret"}\n', 0o600)
                host.write(root / '.env', ''.join(f'{k}={v}\n' for k, v in w.SETTINGS.items()).encode(), 0o600)
                compose = 'services:\n  proxypilot:\n    privileged: true\n    pid: host\n    env_file:\n      - .env\n    volumes:\n      - /data:/data\n'
                host.write(root / 'docker-compose.yml', w.compose_text(compose).encode(), 0o600)
                host.database = fixture.database
                host.backend_stopped = lambda: None
                host.stop = lambda: None
                host.start = lambda: None
                a.unit_checks = b.unit_checks = lambda: None
                a.renew_timer_checks = lambda _: None
                a.wait_status = lambda _: {'supervisor': {'supervisor_sha256': r.sha(host.targets[0].read_bytes())},
                                           'vm_uuid': host.vm, 'active': None, 'accepting_launch': True}
                b.wait_status = lambda _: {'broker': {'broker_sha256': r.sha(b.TARGET.read_bytes())},
                                           'vm_uuid': host.vm, 'public_review': True}
                a.call = lambda *_a, **_k: {'ok': True, 'result': {'contract_version': 'website-review.v1',
                                           'available': False, 'code': 'PROVIDER_UNAVAILABLE'}}
                refresh = r.Refresh(host, root / 'transaction')
                preserved = host.protected + tuple(afiles.keys() - {host.targets[0]}) + (b.UNIT,) + host.ledgers
                before = {p: (p.read_bytes(), p.stat().st_mode & 0o777) for p in host.targets + preserved}
                self.assertEqual(host.identity(), key)
                self.assertEqual(r.sha(guest.read_bytes()), LEGACY_GUEST_SHA)
                self.assertEqual(r.sha((root / 'scripts/a3-worker-guest.py').read_bytes()), BASELINE_GUEST_SHA)
                refresh.apply()
                self.assertEqual(host.identity(), key)
                self.assertEqual(a.read_journal()['files'][str(guest)], LEGACY_GUEST_SHA)
                self.assertEqual(set(refresh.read()['files'][n]['path'] for n in range(4)),
                                 set(str(p) for p in host.targets))
                for p in preserved:
                    self.assertEqual((p.read_bytes(), p.stat().st_mode & 0o777), before[p])
                refresh.rollback()
                self.assertEqual(a.read_journal()['files'][str(guest)], LEGACY_GUEST_SHA)
                for p in host.targets + preserved:
                    self.assertEqual((p.read_bytes(), p.stat().st_mode & 0o777), before[p])
                # The current selected package is a separate installation
                # review: preserve the authentic old installer/owned journal
                # and stage the actual current candidate checkout, then prove
                # the ordinary two-file refresh refuses before any effect.
                current = r.load('a3-install-supervisor', ROOT)
                for name in current.SOURCES + current.SELECTED_SOURCES + ('a4-credential-broker.py',):
                    shutil.copyfile(ROOT/name,root/'scripts'/name)
                subprocess.run(['git','-C',str(root),'add','scripts'],check=True,capture_output=True)
                subprocess.run(['git','-C',str(root),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
                                'commit','-qm','Separately reviewed selected package fixture'],check=True,capture_output=True)
                host.source_sha=subprocess.run(['git','-C',str(root),'rev-parse','HEAD'],check=True,capture_output=True,text=True).stdout.strip()
                with patch.object(host,'stop',side_effect=AssertionError('No service stop on refused package')) as stopped, \
                        patch.object(host,'start',side_effect=AssertionError('No service start on refused package')) as started, \
                        patch.object(host,'write',side_effect=AssertionError('No file write on refused package')) as written:
                    with self.assertRaisesRegex(ValueError,'Other A3 package/unit changes require separate review: '+str(guest)):
                        r.Refresh(host,root/'selected-refused-transaction').apply()
                    stopped.assert_not_called();started.assert_not_called();written.assert_not_called()
                self.assertFalse((root/'selected-refused-transaction').exists())
                for p in host.targets + preserved:
                    self.assertEqual((p.read_bytes(),p.stat().st_mode & 0o777),before[p])
            finally:
                listener.close()

    def test_guest_exception_is_exact_and_every_other_adjacent_mismatch_names_its_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            host = r.Host.__new__(r.Host)
            baseline = reviewed_legacy_package(root/'reviewed-pr724')
            host.a3 = r.load('a3-install-supervisor', baseline)
            host.a4 = r.load('a4-install-broker', baseline)
            host.install, host.source, host.source_sha = root, root, 'a' * 40
            host.targets = (root / 'supervisor/a3-worker-supervisor.py', root / 'broker/a4-credential-broker.py')
            host.a3.TARGET, host.a3.UNIT = root / 'supervisor', root / 'systemd/a3.service'
            host.a3.RENEW_SERVICE, host.a3.RENEW_TIMER = root / 'systemd/renew.service', root / 'systemd/renew.timer'
            host.a4.UNIT = root / 'systemd/a4.service'
            host.secure = lambda _: None
            host.execute = lambda *_: host.source_sha
            (root / 'scripts').mkdir()
            for name in host.a3.SOURCES + ('a4-credential-broker.py',):
                shutil.copyfile(baseline / name, root / 'scripts' / name)
            files = host.a3.plan_files(root / 'scripts')
            guest = host.a3.TARGET / 'a3-worker-guest.py'
            files[guest] = legacy_guest_source()
            for path, data in files.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            recorded = {str(p): r.sha(data) for p, data in files.items()}
            host.a3.read_journal = lambda: {'files': recorded}
            broker_unit = {str(host.a4.UNIT): r.sha(host.a4.UNIT_TEXT.encode())}
            host.a4.read_journal = lambda: {'files': broker_unit}
            def committed(argv, **kwargs):
                return subprocess.CompletedProcess(argv, 0, (baseline / argv[-1].split(':scripts/')[1]).read_bytes())
            with patch.object(r.subprocess, 'run', committed):
                self.assertEqual(set(host.candidates()), set(host.targets))
                candidate = root / 'scripts/a3-worker-guest.py'
                guest.write_bytes(candidate.read_bytes())
                recorded[str(guest)] = BASELINE_GUEST_SHA
                self.assertEqual(set(host.candidates()), set(host.targets))
                candidate.write_bytes(legacy_guest_source())
                with self.assertRaisesRegex(ValueError, str(guest)):
                    host.candidates()
                candidate.write_bytes((baseline / candidate.name).read_bytes())
                guest.write_bytes(legacy_guest_source())
                recorded[str(guest)] = LEGACY_GUEST_SHA
                for victim in files.keys() - {host.targets[0]}:
                    old = recorded[str(victim)]
                    recorded[str(victim)] = r.sha(b'unknown but journal-recorded installation')
                    original = victim.read_bytes()
                    victim.write_bytes(b'unknown but journal-recorded installation')
                    with self.assertRaisesRegex(ValueError, str(victim)):
                        host.candidates()
                    recorded[str(victim)] = old
                    victim.write_bytes(original)
                guest.write_bytes(b'foreign bytes with the allowed old journal pin')
                with self.assertRaisesRegex(ValueError, str(guest)):
                    host.candidates()
                guest.write_bytes(legacy_guest_source())
                candidate.write_bytes(candidate.read_bytes() + b'\n# unknown candidate\n')
                with self.assertRaisesRegex(ValueError, str(guest)):
                    host.candidates()
                candidate.write_bytes((baseline / candidate.name).read_bytes())
                broker_unit[str(host.a4.UNIT)] = 'b' * 64
                with self.assertRaisesRegex(ValueError, str(host.a4.UNIT)):
                    host.candidates()

    def test_new_selected_owned_file_set_is_not_legacy_refresh_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);baseline=reviewed_legacy_package(root/'reviewed-pr724')
            host=r.Host.__new__(r.Host)
            host.a3=r.load('a3-install-supervisor',baseline);host.a4=r.load('a4-install-broker',baseline)
            host.vm='49592202-a8b0-45af-9ac6-5439761d73e4';host.protected=()
            a,b=host.a3,host.a4
            a.TARGET=root/'installed-supervisor';a.PUBLIC_KEY=root/'public.pem';a.UNIT=root/'a3.service'
            a.RENEW_SERVICE=root/'renew.service';a.RENEW_TIMER=root/'renew.timer'
            b.TARGET=root/'broker.py';b.UNIT=root/'a4.service'
            current=r.load('a3-install-supervisor',ROOT)
            self.assertFalse(hasattr(a,'SELECTED_SOURCES'))
            files={str(a.TARGET/name):'a'*64 for name in a.SOURCES}
            files.update({str(path):'a'*64 for path in (a.PUBLIC_KEY,a.UNIT,a.RENEW_SERVICE,a.RENEW_TIMER)})
            files.update({str(a.TARGET/name):'b'*64 for name in current.SELECTED_SOURCES})
            a.read_journal=lambda:dict(files=files,phase='installed',vm_uuid=host.vm)
            b.read_journal=lambda:dict(files={str(b.TARGET):'a'*64,str(b.UNIT):'a'*64},phase='installed',vm_uuid=host.vm)
            host.opted_in=lambda:True
            with patch.object(a,'verify_files',side_effect=AssertionError('Unknown identity must fail first')) as verified, \
                    patch.object(host,'stop',side_effect=AssertionError('No target service operation')) as stopped, \
                    patch.object(host,'write',side_effect=AssertionError('No target file operation')) as written:
                with self.assertRaisesRegex(ValueError,'Installation identity or owned file set is unknown'):
                    r.Refresh(host,root/'transaction').apply()
                verified.assert_not_called();stopped.assert_not_called();written.assert_not_called()
            self.assertFalse((root/'transaction').exists())
            self.assertEqual(r.GUEST_REVIEW_COMPATIBILITY,(LEGACY_GUEST_SHA,BASELINE_GUEST_SHA))

    def test_real_candidate_commit_pin_and_compile_not_just_shebang(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'scripts').mkdir()
            for name in ('a3-worker-supervisor.py', 'a4-credential-broker.py'):
                (root / 'scripts' / name).write_bytes((ROOT / name).read_bytes())
            host = r.Host.__new__(r.Host)
            host.source_sha, host.source, host.install = 'a' * 40, root, root
            host.targets = (root / 'installed-a3', root / 'installed-a4')
            host.secure = lambda _: None
            host.execute = lambda *_: 'b' * 40
            with self.assertRaisesRegex(ValueError, 'Checkout changed'):
                host.candidates()
            host.execute = lambda *_: 'a' * 40
            with patch.object(r.subprocess, 'run', lambda *_a, **_k: subprocess.CompletedProcess([], 0, b'wrong')):
                with self.assertRaisesRegex(ValueError, 'pinned checkout'):
                    host.candidates()

    def test_real_backend_stop_confirmation_and_no_service_enable_reinstall_or_key_generation(self):
        host = r.Host.__new__(r.Host)
        host.install = Path('/opt/proxypilot')
        host.execute = lambda argv, **kwargs: 'container' if 'ps' in argv else ''
        with self.assertRaisesRegex(ValueError, 'still running'):
            host.backend_stopped()
        text = (ROOT / 'review-runtime-refresh.py').read_text()
        for command in ('genpkey', "'reinstall'", "'enable'", "'daemon-reload'", "'provider_bind'", "'configure'"):
            self.assertNotIn(command, text)


if __name__ == '__main__':
    unittest.main()
