"""Real package bytes, SQLite writer barriers and durable timer latches; no live host."""
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_browser_runtime_operation import Host, m, p


class MaintenanceHost(Host):
    database_admission = p.Host.database_admission
    dashboard_idle = p.Host.dashboard_idle

    def identity(self, allow_work=False):
        return super().identity()

    def health(self, pins, key_id, selected, allow_work=False):
        return super().health(pins, key_id, selected)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.h = MaintenanceHost(Path(self.temp.name))
        self.op = m.Operation(p, self.h)
        self.op.run('install')
        self.dbpath = self.h.tree.path(p.SOURCE + '/data/db/proxypilot.db')
        self.dbpath.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.dbpath) as db:
            db.execute('PRAGMA journal_mode=WAL')
            for table in ('ops_agent_runs','ops_selected_browser_runs','ops_website_review_runs',
                          'ops_browser_conversions','ops_agent_model_calls','ops_selected_browser_model_reservations'):
                db.execute('CREATE TABLE ' + table + ' (state TEXT)')
        self.dbpath.chmod(0o600)
        self.h.docker.clear()
        self.h.events.clear()
        self.maintenance = m.Maintenance(p, self.h)
        self.maintenance.configure(True)

    def newer(self):
        self.h.source['a3-worker-supervisor.py'] += b'\n# New reviewed delivered generation\n'
        self.h.revision = '2' * 40

    def state(self):
        return p.strict(self.h.tree.read(m.MAINTENANCE_STATUS))

    def test_absent_preference_is_off_and_never_inspects_or_installs_runtime(self):
        self.h.tree.remove(m.MAINTENANCE_CONFIG)
        with patch.object(self.h, 'sources', side_effect=AssertionError('contact')):
            result = m.Maintenance(p, self.h).tick()
        self.assertEqual(result['status'], 'disabled')
        self.assertEqual(self.h.docker, [])
        self.assertEqual(self.h.events, [])

    def test_same_generation_ticks_do_not_restart_or_reinstall(self):
        before = self.op.transaction()['id']
        for _ in range(3):
            result = self.maintenance.tick()
            self.assertEqual(result['status'], 'up_to_date')
            self.assertEqual(result['installed_generation'], result['delivered_generation'])
            self.assertFalse(result['runtime_accepted'])
        self.assertEqual(self.op.transaction()['id'], before)
        self.assertEqual(self.h.docker, [])
        self.assertEqual(self.h.events, [])

    def test_new_idle_generation_commits_once_and_retains_acceptance_and_history(self):
        acceptance = b'fixture retained acceptance bytes, not usable target proof\n'
        self.h.put(p.ROOT + '/selected-browser-acceptance.json', acceptance, 0o600)
        history = self.h.tree.read(p.LEDGERS[1])
        self.newer()
        result = self.maintenance.tick()
        self.assertEqual(result['status'], 'up_to_date')
        self.assertEqual(result['delivered_revision'], '2' * 40)
        self.assertEqual(self.h.events, ['stop','start'])
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.h.tree.read(p.ROOT + '/selected-browser-acceptance.json'), acceptance)
        before = p.strict(history); after = p.strict(self.h.tree.read(p.LEDGERS[1]))
        before.pop('broker_sha256'); after.pop('broker_sha256')
        self.assertEqual(before, after)
        transaction = self.op.transaction()['id']
        self.maintenance.tick()
        self.assertEqual(self.op.transaction()['id'], transaction)
        self.assertEqual(self.h.events, ['stop','start'])

    def test_active_browser_and_provider_work_defer_before_dashboard_stop(self):
        self.newer()
        for table, state in (('ops_selected_browser_runs','running'), ('ops_browser_conversions','converting'),
                             ('ops_website_review_runs','reviewing'), ('ops_agent_model_calls','reserved')):
            with self.subTest(table=table):
                with sqlite3.connect(self.dbpath) as db:
                    db.execute('INSERT INTO ' + table + ' VALUES (?)', (state,))
                result = self.maintenance.tick()
                self.assertEqual(result['status'], 'deferred')
                self.assertEqual(self.h.docker, [])
                self.assertFalse(self.maintenance.journal()['blocked'])
                with sqlite3.connect(self.dbpath) as db:
                    db.execute('DELETE FROM ' + table)

    def test_database_writer_contention_defers_without_effect_or_failure_latch(self):
        self.newer()
        with sqlite3.connect(self.dbpath, timeout=0) as writer:
            writer.execute('BEGIN IMMEDIATE')
            self.assertEqual(self.maintenance.tick()['status'], 'deferred')
        self.assertEqual(self.h.docker, [])
        self.assertFalse(self.maintenance.journal()['blocked'])

    def test_atomic_admission_blocks_new_reservation_until_dashboard_is_stopped(self):
        self.newer()
        execute = self.h.execute
        observed = []
        def check(args, **kwargs):
            if args[:2] == ['docker','stop']:
                with sqlite3.connect(self.dbpath, timeout=0) as db:
                    with self.assertRaises(sqlite3.OperationalError):
                        db.execute("INSERT INTO ops_agent_runs VALUES ('starting')")
                observed.append('admission_locked')
            if args[:2] == ['docker','start']:
                with sqlite3.connect(self.dbpath, timeout=0) as db:
                    db.execute("INSERT INTO ops_agent_runs VALUES ('completed')")
                observed.append('admission_released')
            return execute(args, **kwargs)
        with patch.object(self.h, 'execute', side_effect=check):
            self.assertEqual(self.maintenance.tick()['status'], 'up_to_date')
        self.assertEqual(observed, ['admission_locked','admission_released'])

    def test_unknown_or_null_database_state_latches_before_any_effect(self):
        self.newer()
        for state in (None, 'foreign-state'):
            with self.subTest(state=state):
                with sqlite3.connect(self.dbpath) as db:
                    db.execute('DELETE FROM ops_selected_browser_runs')
                    db.execute('INSERT INTO ops_selected_browser_runs VALUES (?)', (state,))
                self.maintenance.attempt(False)
                with self.assertRaisesRegex(ValueError, 'state unknown'):
                    self.maintenance.tick()
                self.assertEqual(self.state()['status'], 'needs_repair')
                self.assertEqual(self.h.docker, [])

    def test_broker_reservation_defers_and_unknown_provider_state_requires_repair(self):
        self.newer()
        value = p.strict(self.h.tree.read(p.LEDGERS[1]))
        value['calls']['active'] = {'state':'reserved'}
        self.h.put(p.LEDGERS[1], p.encoded(value), 0o600)
        self.assertEqual(self.maintenance.tick()['status'], 'deferred')
        value['calls']['active']['state'] = 'foreign'
        self.h.put(p.LEDGERS[1], p.encoded(value), 0o600)
        with self.assertRaisesRegex(ValueError, 'state unknown'):
            self.maintenance.tick()
        self.assertEqual(self.h.docker, [])

    def test_failed_generation_never_replays_on_ticks_reboot_or_preference_toggle(self):
        self.newer()
        with patch.object(self.maintenance.pkg, 'commit', side_effect=ValueError('test failure')):
            with self.assertRaises(ValueError):
                self.maintenance.tick()
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.op.transaction()['phase'], 'rolled_back')
        self.assertEqual(self.state()['status'], 'needs_repair')
        events = self.h.events[:]
        self.h.boot = '00000000-0000-4000-8000-000000000002'
        self.h.source['a3-worker-supervisor.py'] += b'\n# Another delivered version\n'
        reloaded = m.Maintenance(p, self.h)
        reloaded.configure(False); reloaded.tick(); reloaded.configure(True)
        for _ in range(3):
            self.assertEqual(reloaded.tick()['status'], 'needs_repair')
        self.assertEqual(self.h.events, events)

    def test_distinct_explicit_successful_install_can_clear_failed_attempt(self):
        self.newer()
        self.maintenance.attempt(True, '11111111-1111-4111-8111-111111111111')
        self.op.request_id = '22222222-2222-4222-8222-222222222222'
        self.op.run('install')
        self.assertEqual(self.maintenance.tick()['status'], 'up_to_date')
        self.assertFalse(self.maintenance.journal()['blocked'])

    def test_no_transaction_or_corrupt_retained_generation_never_enrolls_or_stops(self):
        tx = self.op.transaction()
        staged = p.TRANSACTION + '/' + tx['id'] + '/new-0'
        self.h.put(staged, b'foreign bytes', 0o600)
        with self.assertRaisesRegex(ValueError, 'generation changed'):
            self.maintenance.tick()
        self.assertEqual(self.h.docker, [])
        self.maintenance.attempt(False)
        self.h.tree.remove(p.TRANSACTION + '/transaction.json')
        with self.assertRaisesRegex(ValueError, 'committed installed'):
            self.maintenance.tick()
        self.assertEqual(self.h.docker, [])

    def test_timer_and_installer_remain_passive_default_off_and_use_both_locks(self):
        root = Path(__file__).resolve().parents[2]
        service = (root / 'deploy/proxypilot-browser-maintenance.service').read_text()
        self.assertIn('/var/lock/proxypilot-update.lock', service)
        self.assertIn('ConditionPathExists=' + m.MAINTENANCE_CONFIG, service)
        self.assertIn('recover-if-needed', service)
        for script in ('install.sh','update.sh'):
            text = (root / script).read_text()
            self.assertIn('systemctl enable --now proxypilot-browser-maintenance.timer', text)
            self.assertNotIn('maintenance-enable\n', text)
        with self.h.tree.lock():
            with self.assertRaises(BlockingIOError):
                with self.h.tree.lock():
                    pass


if __name__ == '__main__':
    unittest.main()
