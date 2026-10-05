"""Actual package transactions with temporary files and simulated Docker/services."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_selected_runtime_package import FixtureHost, p

spec = importlib.util.spec_from_file_location('runtime_operation', Path(__file__).resolve().parents[1] / 'browser-runtime-operation.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Host(FixtureHost):
    def __init__(self, path):
        super().__init__(path)
        self.backend_active = True
        self.cid = 'a' * 64
        self.docker = []
    def execute(self, args, **kwargs):
        self.docker.append(args)
        if args[:2] == ['docker', 'inspect']:
            return json.dumps({'Id': self.cid, 'Name': '/proxypilot-admin',
                'Config': {'Labels': {'com.docker.compose.service': 'proxypilot'}},
                'State': {'Running': self.backend_active}}).encode()
        if args[:2] == ['docker', 'stop']:
            self.backend_active = False
        elif args[:2] == ['docker', 'start']:
            self.backend_active = True
        elif args[:2] != ['docker', 'exec']:
            raise AssertionError(args)
        return b''

class OperationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.h = Host(Path(self.temp.name))
        self.op = m.Operation(p, self.h)
    def state(self):
        return p.strict(self.h.tree.read(m.STATE))
    def test_install_commits_and_restarts_same_dashboard_without_acceptance(self):
        self.op.run('install')
        self.assertEqual(self.op.transaction()['phase'], 'committed')
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'completed')
        self.assertEqual(self.state()['authority'], 'authenticated-host-runner')
        self.assertIsNone(self.h.tree.read(p.ROOT + '/selected-browser-acceptance.json', missing=True))
    def test_planning_failure_restores_dashboard_and_preserves_prior_bytes(self):
        before = {v: self.h.tree.pin(v, missing=True) for v in p.OWNED}
        with patch.object(self.op.pkg, 'plan', side_effect=ValueError('planned refusal')):
            with self.assertRaises(ValueError): self.op.run('install')
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'failed_recovered')
        self.assertFalse(self.h.tree.path(p.TRANSACTION).exists())
        self.assertEqual(before, {v: self.h.tree.pin(v, missing=True) for v in p.OWNED})
    def test_post_apply_failure_rolls_back_new_generation(self):
        before = {v: self.h.tree.pin(v, missing=True) for v in p.OWNED}
        with patch.object(self.op.pkg, 'commit', side_effect=ValueError('commit refused')):
            with self.assertRaises(ValueError): self.op.run('install')
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.op.transaction()['phase'], 'rolled_back')
        self.assertEqual(before, {v: self.h.tree.pin(v, missing=True) for v in p.OWNED})
    def test_recovery_after_dashboard_stop_survives_without_ui(self):
        self.h.tree.mkdir(m.OPERATION_ROOT, 0o700)
        self.h.tree.write(m.STATE, p.encoded({'phase':'dashboard_stopped', 'container_id':self.h.cid}), 0o600)
        self.h.backend_active = False
        self.op.run('recover')
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'completed')
    def test_interrupted_applied_generation_is_recovered(self):
        self.h.backend_active = False
        self.h.tree.mkdir(m.OPERATION_ROOT, 0o700)
        self.op.record = {'operation':'install', 'container_id':self.h.cid}
        self.op.pkg.apply(self.op.authorize('install'))
        self.op.save('package_install')
        m.Operation(p, self.h).run('recover')
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.op.transaction()['phase'], 'rolled_back')
    def test_recovery_rejects_replacement_dashboard(self):
        self.h.tree.mkdir(m.OPERATION_ROOT, 0o700)
        self.h.tree.write(m.STATE, p.encoded({'phase':'dashboard_stopped', 'container_id':'b'*64}), 0o600)
        with self.assertRaisesRegex(ValueError, 'identity differs'): self.op.run('recover')
        self.assertFalse(any(v[1] in {'start', 'stop'} for v in self.h.docker))
    def replacement(self):
        self.op.run('install')
        self.op.record['request_id'] = '11111111-1111-1111-1111-111111111111'
        self.op.save('recovery_required')
        previous = self.h.cid
        self.h.cid = 'b' * 64
        self.h.docker.clear()
        self.h.events.clear()
        return previous
    def test_fresh_recovery_after_update_rebinds_only_verified_running_dashboard(self):
        old = self.replacement()
        before = self.op.owned_pins()
        transaction = self.op.transaction()
        recovery = m.Operation(p, self.h, request_id='22222222-2222-2222-2222-222222222222')
        recovery.run('recover')
        self.assertEqual(self.state()['container_id'], self.h.cid)
        self.assertEqual(self.state()['rebound_from_container_id'], old)
        self.assertEqual(self.state()['phase'], 'completed')
        self.assertEqual(recovery.owned_pins(), before)
        self.assertEqual(recovery.transaction(), transaction)
        self.assertEqual(self.h.events, [])
        self.assertTrue(self.h.backend_active)
    def test_automatic_cleanup_and_stopped_replacement_cannot_rebind(self):
        self.replacement()
        for running, request in ((True, None), (True, '11111111-1111-1111-1111-111111111111'),
                                 (False, '22222222-2222-2222-2222-222222222222')):
            self.h.backend_active = running
            with self.subTest(running=running, request=request):
                recovery = m.Operation(p, self.h, request_id=request)
                with self.assertRaisesRegex(ValueError, 'identity differs'):recovery.run('recover')
        self.assertFalse(any(v[1] in {'start', 'stop'} for v in self.h.docker))
    def test_replacement_recovery_verifies_package_identity_and_health_before_stop(self):
        self.replacement()
        for method in ('verify_transaction', 'current_identity'):
            recovery = m.Operation(p, self.h, request_id='22222222-2222-2222-2222-222222222222')
            with self.subTest(method=method), patch.object(recovery.pkg, method, side_effect=ValueError('unverified')):
                with self.assertRaisesRegex(ValueError, 'unverified'):recovery.run('recover')
        recovery = m.Operation(p, self.h, request_id='22222222-2222-2222-2222-222222222222')
        with patch.object(self.h, 'health', side_effect=ValueError('unhealthy')):
            with self.assertRaisesRegex(ValueError, 'unhealthy'):recovery.run('recover')
        tx = self.op.transaction()
        tx['phase'] = 'applied'
        self.op.pkg.save('transaction.json', tx)
        with self.assertRaisesRegex(ValueError, 'identity differs'):recovery.run('recover')
        self.assertTrue(self.h.backend_active)
        self.assertFalse(any(v[1] in {'start', 'stop'} for v in self.h.docker))
    def test_authorized_pretransaction_failure_retains_staging_outside_package(self):
        with patch.object(self.op.pkg, 'apply', side_effect=ValueError('pre-staging drift')):
            with self.assertRaises(ValueError): self.op.run('install')
        self.assertTrue(self.h.backend_active)
        self.assertFalse(self.h.tree.path(p.TRANSACTION).exists())
        archives = list(self.h.tree.path(m.OPERATION_ROOT).glob('preparation-*'))
        self.assertEqual(len(archives), 1)
        self.assertTrue((archives[0] / 'review.json').exists())
    def test_interrupted_status_only_updates_own_request(self):
        path = '/var/lib/proxypilot/update/state.json'
        rid = '12345678-1234-1234-1234-123456789abc'
        state = {'id':rid, 'status':'running', 'action':'browser-runtime-install'}
        self.h.tree.write(path, p.encoded(state), 0o644)
        m.finish_interrupted_status(p, self.h, 'unrelated')
        self.assertEqual(p.strict(self.h.tree.read(path))['status'], 'running')
        m.finish_interrupted_status(p, self.h, rid)
        self.assertEqual(p.strict(self.h.tree.read(path))['status'], 'failed')
        self.assertEqual(p.strict(self.h.tree.read('/var/lib/proxypilot/update/state.'+rid+'.json'))['status'], 'failed')
    def test_unowned_stopped_dashboard_is_not_started(self):
        self.h.backend_active = False
        with self.assertRaisesRegex(ValueError, 'already stopped'): self.op.run('install')
        self.assertFalse(self.h.backend_active)
        self.assertFalse(any(v[1] == 'start' for v in self.h.docker))
    def test_source_failure_precedes_dashboard_stop(self):
        with patch.object(self.h, 'sources', side_effect=ValueError('source drift')):
            with self.assertRaises(ValueError): self.op.run('install')
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.h.docker, [])
    def test_failed_serving_unit_refuses_before_dashboard_stop(self):
        self.h.unit_states[p.SUP_UNIT]['active'] = 'failed'
        with self.assertRaises(ValueError):self.op.run('install')
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'failed_recovered')
        self.assertFalse(any(v[1] in {'start', 'stop'} for v in self.h.docker))
        self.assertEqual(self.h.events, [])
    def test_idle_failed_renewal_is_handled_by_the_owned_package_stop(self):
        self.h.unit_states[p.RENEW_SERVICE]['active'] = 'failed'
        self.op.run('install')
        self.assertEqual(self.op.transaction()['units'][p.RENEW_SERVICE]['active'], 'failed')
        self.assertEqual(self.h.unit_states[p.RENEW_SERVICE]['active'], 'failed')
        self.assertEqual(self.op.transaction()['phase'], 'committed')
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'completed')
        self.assertIsNone(self.h.tree.read(p.ROOT + '/selected-browser-acceptance.json', missing=True))
        self.h.backend_active = False
        self.op.save('dashboard_stopped')
        m.Operation(p, self.h).run('recover')
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'completed')
        self.assertEqual(self.h.unit_states[p.RENEW_SERVICE]['active'], 'failed')
    def test_committed_readonly_recovery_failure_restores_ui_without_rollback(self):
        self.op.run('install')
        before = self.op.owned_pins()
        transaction = self.op.transaction()
        self.h.events.clear()
        self.h.backend_active = False
        self.op.save('dashboard_stopped')
        recovery = m.Operation(p, self.h)
        with patch.object(self.h, 'health', side_effect=ValueError('runtime unhealthy')), \
                patch.object(recovery.pkg, 'restore', side_effect=AssertionError('prior package must stay installed')) as restore:
            with self.assertRaisesRegex(ValueError, 'runtime unhealthy'):recovery.run('recover')
        restore.assert_not_called()
        self.assertEqual(before, recovery.owned_pins())
        self.assertEqual(transaction, recovery.transaction())
        self.assertEqual(self.h.events, [])
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'failed_recovered')
    def test_partial_recovery_failure_keeps_runtime_unclaimed(self):
        self.h.backend_active = False
        self.h.tree.mkdir(m.OPERATION_ROOT, 0o700)
        self.op.record = {'operation':'install', 'container_id':self.h.cid}
        self.op.pkg.apply(self.op.authorize('install'))
        self.op.save('package_install')
        recovery = m.Operation(p, self.h)
        with patch.object(recovery.pkg, 'restore', side_effect=ValueError('cannot restore')):
            with self.assertRaisesRegex(ValueError, 'cannot restore'):recovery.run('recover')
        self.assertFalse(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'recovery_required')
    def test_new_owned_drift_after_planning_refusal_does_not_restart_dashboard(self):
        def refused(_):
            self.h.put(p.PROXY_UNIT, b'foreign unit', 0o644)
            raise ValueError('changed during planning')
        with patch.object(self.op.pkg, 'plan', side_effect=refused):
            with self.assertRaisesRegex(ValueError, 'changed during planning'):self.op.run('install')
        self.assertFalse(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'recovery_required')
    def test_failed_dashboard_start_can_be_recovered_without_reinstalling(self):
        execute = self.h.execute
        def failed_start(args, **kwargs):
            if args[:2] == ['docker', 'start']:raise OSError('start failed')
            return execute(args, **kwargs)
        with patch.object(self.h, 'execute', side_effect=failed_start):
            with self.assertRaises(OSError):self.op.run('install')
        self.assertEqual(self.state()['phase'], 'restarting_dashboard')
        transaction = self.op.transaction()
        self.h.events.clear()
        m.Operation(p, self.h).run('recover')
        self.assertEqual(self.op.transaction(), transaction)
        self.assertEqual(self.h.events, [])
        self.assertTrue(self.h.backend_active)
        self.assertEqual(self.state()['phase'], 'completed')
    def test_unknown_operation_never_contacts_docker(self):
        with self.assertRaises(ValueError): self.op.run('shell')
        self.assertEqual(self.h.docker, [])

if __name__ == '__main__': unittest.main()
