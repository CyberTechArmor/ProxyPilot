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
    def test_unknown_operation_never_contacts_docker(self):
        with self.assertRaises(ValueError): self.op.run('shell')
        self.assertEqual(self.h.docker, [])

if __name__ == '__main__': unittest.main()
