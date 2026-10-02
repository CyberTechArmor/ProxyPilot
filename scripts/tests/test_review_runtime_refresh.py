"""Real fixed-file transactions with simulated service/VM/socket operations."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('refresh_test', ROOT / 'review-runtime-refresh.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


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
            host.a3 = r.load('a3-install-supervisor', ROOT)
            host.a4 = r.load('a4-install-broker', ROOT)
            host.a8 = r.load('a8-wire-dashboard', ROOT)
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
                shutil.copyfile(ROOT / name, root / 'scripts' / name)
            shutil.copyfile(ROOT / 'a4-credential-broker.py', root / 'scripts/a4-credential-broker.py')
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
                before = {p: (p.read_bytes(), p.stat().st_mode & 0o777) for p in host.targets + host.protected}
                self.assertEqual(host.identity(), key)
                refresh.apply()
                self.assertEqual(host.identity(), key)
                for p in host.protected:
                    self.assertEqual((p.read_bytes(), p.stat().st_mode & 0o777), before[p])
                refresh.rollback()
                for p in host.targets + host.protected:
                    self.assertEqual((p.read_bytes(), p.stat().st_mode & 0o777), before[p])
            finally:
                listener.close()

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
