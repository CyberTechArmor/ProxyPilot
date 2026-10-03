"""Real committed package bytes and metadata; host effects are simulated."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_selected_runtime_package import FixtureHost, p, ROOT

spec = importlib.util.spec_from_file_location('selected_refresh_tests', ROOT / 'review-runtime-refresh.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class PackageHost(FixtureHost):
    def identity(self, allow_work=False):
        return dict(super().identity(), proxy_spki_sha256=p.sha(self.tree.read(p.ROOT + "/proxy-cert.pem")))

    def health(self, pins, key_id, selected, allow_work=False):
        return super().health(pins, key_id, selected)


class UpdaterHost:
    def __init__(self, host):
        self.host = host
        self.db_busy = False

    def source_profile(self, require_legacy=True):
        if require_legacy:
            raise ValueError('Legacy preservation must reject an expanded package')
        return dict(source_sha=self.host.revision, source_checkout='/reviewed-checkout',
                    files={k:r.sha(v) for k,v in self.host.source.items()})

    def preservation_db_idle(self):
        if self.db_busy:
            raise ValueError('Active dashboard work')


class SelectedPreservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.host = PackageHost(Path(self.temp.name))
        self.package = p.Package(self.host, lambda:self.host.now)
        for operation in ('install', 'commit'):
            plan = self.package.plan(operation)
            self.package.review(operation, plan['plan_sha256'])
            if operation == 'install':
                self.package.apply(plan['plan_sha256'])
            else:
                self.package.commit(plan['plan_sha256'])
        self.host.events.clear()
        self.updater = UpdaterHost(self.host)
        self.refresh = r.SelectedRefresh(self.updater, self.package, p)

    def runtime_bytes(self):
        return {path:self.host.tree.inventory(path, missing=True)
                for path in p.OWNED + p.PROTECTED + p.LEDGERS}

    def test_preserves_completed_install_across_normal_source_revision_update(self):
        before = self.runtime_bytes()
        self.host.revision = '2' * 40
        self.refresh.preflight()
        result = self.refresh.apply()
        self.assertFalse(result['runtime_changed'])
        self.host.backend_active = True
        self.assertTrue(self.refresh.commit()['committed'])
        self.assertEqual(self.runtime_bytes(), before)
        self.assertEqual(self.host.events, [])
        self.assertFalse(result['acceptance_created'])
        self.assertNotIn('selected_browser_available', result)

    def test_changed_runtime_source_refuses_without_effects(self):
        before = self.runtime_bytes()
        self.host.source['selected_browser_gateway.py'] += b'\n# changed protocol implementation\n'
        with self.assertRaisesRegex(ValueError, 'separately reviewed'):
            self.refresh.apply()
        self.assertEqual(before, self.runtime_bytes())
        self.assertEqual(self.host.events, [])

    def test_incomplete_package_never_admitted(self):
        transaction = self.package.tx()
        for phase in ('prepared', 'stopped', 'replacing', 'applied', 'restoring', 'rolled_back'):
            with self.subTest(phase=phase):
                transaction['phase'] = phase
                self.package.save('transaction.json', transaction)
                with self.assertRaises(ValueError):
                    self.refresh.preflight()
        self.assertEqual(self.host.events, [])

    def test_busy_dashboard_and_gateway_latch_refuse(self):
        self.updater.db_busy = True
        with self.assertRaises(ValueError):
            self.refresh.preflight()
        self.updater.db_busy = False
        self.host.put(p.GATEWAY_STATE + '/selected-gateway-latch.json', b'{}\n', 0o600)
        with self.assertRaises(ValueError):
            self.refresh.preflight()
        self.assertEqual(self.host.events, [])

    def test_apply_requires_stopped_dashboard(self):
        self.host.backend_active = True
        with self.assertRaises(ValueError):
            self.refresh.apply()

    def test_incomplete_preservation_requires_metadata_only_rollback(self):
        self.refresh.apply()
        before = self.runtime_bytes()
        with self.assertRaises(ValueError):
            self.refresh.preflight()
        self.assertTrue(self.refresh.rollback()['rolled_back'])
        self.assertEqual(before, self.runtime_bytes())
        self.assertEqual(self.host.events, [])
        self.refresh.apply()
        self.refresh.commit()

    def test_commit_accepts_new_work_without_restoring_history(self):
        self.refresh.apply()
        state = p.strict(self.host.tree.read(p.LEDGERS[0]))
        state['selected_browser_model_runs'] = {'new':{'state':'active','calls':{'x':{'state':'reserved'}}}}
        self.host.put(p.LEDGERS[0], p.encoded(state), 0o600)
        self.updater.db_busy = True
        before = self.runtime_bytes()
        self.refresh.commit()
        self.assertEqual(before, self.runtime_bytes())
        self.assertEqual(self.host.events, [])

    def test_acceptance_drift_refuses_commit(self):
        self.refresh.apply()
        self.host.put(p.ROOT + '/selected-browser-acceptance.json', b'{"fixture_only":true}\n', 0o600)
        with self.assertRaisesRegex(ValueError, 'drift'):
            self.refresh.commit()
        self.assertEqual(self.host.events, [])

    def renew_proxy(self):
        journal = p.strict(self.host.tree.read(p.JOURNALS[1]))
        for name, mode in (('proxy-cert.pem', 0o644), ('proxy-key.pem', 0o600)):
            path = p.ROOT + '/' + name
            self.host.put(path, b'fixture renewed pair\n', mode)
            journal['files'][path] = self.host.tree.pin(path)['sha256']
        self.host.put(p.JOURNALS[1], p.encoded(journal), 0o600)

    def test_certificate_renewal_during_update_allows_commit_and_rollback(self):
        for operation in ('commit', 'rollback'):
            self.refresh.apply()
            self.renew_proxy()
            before = self.runtime_bytes()
            getattr(self.refresh, operation)()
            self.assertEqual(before, self.runtime_bytes())

    def test_reboot_recovery_keeps_completed_new_history(self):
        self.refresh.apply()
        self.host.boot = '00000000-0000-4000-8000-000000000099'
        state = p.strict(self.host.tree.read(p.LEDGERS[0]))
        state['selected_browser_model_runs'] = {'new':{'state':'active','calls':{'x':{'state':'completed'}}}}
        self.host.put(p.LEDGERS[0], p.encoded(state), 0o600)
        before = self.runtime_bytes()
        self.refresh.rollback()
        self.assertEqual(before, self.runtime_bytes())
        self.refresh.preflight()

    def test_exact_setup_policy_enrollment_allowed_but_other_env_edits_refuse(self):
        path = p.SOURCE + '/.env'
        original = self.host.tree.read(path)
        mode = self.host.tree.pin(path)['mode']
        suffix = '\n# Who executes setup jobs (docs/features/setup-engine.md § "Who executes").\nSETUP_EXECUTOR_POLICY=runner-required\n'.encode()
        self.refresh.apply()
        self.host.put(path, original + suffix, mode)
        self.refresh.commit()
        self.assertEqual(self.host.tree.read(path), original + suffix)
        self.refresh.apply()
        self.host.put(path, original + suffix + b'UNREVIEWED=value\n', mode)
        with self.assertRaisesRegex(ValueError, 'drift'):
            self.refresh.rollback()

    def test_no_package_enrollment_or_acceptance_created(self):
        self.assertIsNone(self.host.tree.pin(p.ROOT + '/selected-browser-acceptance.json', missing=True))
        self.refresh.apply()
        self.refresh.commit()
        self.assertIsNone(self.host.tree.pin(p.ROOT + '/selected-browser-acceptance.json', missing=True))
        self.assertEqual(self.package.tx()['phase'], 'committed')

    def test_foreign_mutually_consistent_installed_code_refused(self):
        path = p.SUPERVISOR + '/selected_browser_gateway.py'
        self.host.put(path, self.host.tree.read(path)+b'\n# foreign\n', 0o644)
        journal = p.strict(self.host.tree.read(p.JOURNALS[0]))
        journal['files'][path] = self.host.tree.pin(path)['sha256']
        self.host.put(p.JOURNALS[0], p.encoded(journal), 0o600)
        with self.assertRaises(ValueError):
            self.refresh.preflight()

    def test_owned_certificate_renewal_preserves_updated_journal(self):
        path = p.ROOT + '/proxy-cert.pem'
        self.host.put(path, b'fixture certificate renewed\n', 0o644)
        journal = p.strict(self.host.tree.read(p.JOURNALS[1]))
        journal['files'][path] = self.host.tree.pin(path)['sha256']
        self.host.put(p.JOURNALS[1], p.encoded(journal), 0o600)
        before = self.runtime_bytes()
        self.refresh.apply()
        self.refresh.commit()
        self.assertEqual(before, self.runtime_bytes())

    def test_unowned_installation_metadata_change_refuses(self):
        journal = p.strict(self.host.tree.read(p.JOURNALS[1]))
        journal['retained_custom'] = {'changed':'not certificate renewal'}
        self.host.put(p.JOURNALS[1], p.encoded(journal), 0o600)
        with self.assertRaisesRegex(ValueError, 'metadata changed'):
            self.refresh.preflight()

    def test_completed_upgrade_rollback_preserves_previous_selected_generation(self):
        original = self.host.source['selected_browser_gateway.py']
        self.host.source['selected_browser_gateway.py'] += b'\n# reviewed upgrade\n'
        plan = self.package.plan('update')
        self.package.review('update', plan['plan_sha256'])
        self.package.apply(plan['plan_sha256'])
        plan = self.package.plan('rollback')
        self.package.review('rollback', plan['plan_sha256'])
        self.package.restore('rollback', plan['plan_sha256'])
        with self.assertRaisesRegex(ValueError, 'separately reviewed'):
            self.refresh.preflight()
        self.host.source['selected_browser_gateway.py'] = original
        before = self.runtime_bytes()
        self.host.events.clear()
        self.refresh.apply()
        self.refresh.commit()
        self.assertEqual(before, self.runtime_bytes())
        self.assertEqual(self.host.events, [])
        self.assertEqual(self.package.tx()['phase'], 'rolled_back')

    def test_completed_package_rollback_can_be_recognized_without_deleting_history(self):
        plan = self.package.plan('rollback')
        self.package.review('rollback', plan['plan_sha256'])
        self.package.restore('rollback', plan['plan_sha256'])
        before = self.runtime_bytes()
        r.verify_rolled_back_package(self.package, p)
        self.assertEqual(before, self.runtime_bytes())
        self.assertEqual(self.package.tx()['phase'], 'rolled_back')
        path = p.SUPERVISOR + '/a3-worker-guest.py'
        self.host.put(path, self.host.tree.read(path)+b'\n# drift\n', 0o644)
        with self.assertRaises(ValueError):
            r.verify_rolled_back_package(self.package, p)


class ServingHealthTests(unittest.TestCase):
    def test_post_restart_work_keeps_serving_identity_checks(self):
        host = p.Host()
        paths = (p.SUPERVISOR + '/a3-worker-supervisor.py', p.SUPERVISOR + '/a3-worker-guest.py',
                 p.BROKER, p.ROOT + '/selected_browser_gateway.py',
                 p.ROOT + '/selected_browser_policy.py', p.ROOT + '/origin-proxy.py')
        pins = {path:{'sha256':str(i) * 64} for i,path in enumerate(paths)}
        supervisor = dict(active={'attempt_id':'live'}, blockers=[], accepting_launch=False,
                          vm_uuid=p.VM_UUID, supervisor=dict(key_id='key',
                          supervisor_sha256=pins[paths[0]]['sha256'], runner_sha256=pins[paths[1]]['sha256']))
        broker = dict(vm_uuid=p.VM_UUID, broker=dict(broker_sha256=pins[p.BROKER]['sha256']))
        gateway = dict(active=True, protocol='selected-gateway.v1', files={
            'selected_browser_gateway.py':pins[paths[3]]['sha256'],
            'selected_browser_policy.py':pins[paths[4]]['sha256'],
            'a3-origin-proxy.py':pins[paths[5]]['sha256']})
        def rpc(path, method, gateway_request=False):
            return gateway if gateway_request else broker if 'a4' in path else supervisor
        with patch.object(host, 'wiring'), patch.object(host, 'unit_check'), patch.object(host, 'rpc', side_effect=rpc):
            with self.assertRaises(ValueError):
                host.health(pins, 'key', True)
            host.health(pins, 'key', True, allow_work=True)
            supervisor['supervisor']['key_id'] = 'foreign'
            with self.assertRaises(ValueError):
                host.health(pins, 'key', True, allow_work=True)
            supervisor['supervisor']['key_id'] = 'key'
            gateway['files']['selected_browser_gateway.py'] = 'foreign'
            with self.assertRaises(ValueError):
                host.health(pins, 'key', True, allow_work=True)


if __name__ == '__main__':
    unittest.main()
