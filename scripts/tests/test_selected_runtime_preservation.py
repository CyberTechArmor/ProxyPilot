"""Real committed package bytes and metadata; host effects are simulated."""
import copy
import importlib.util
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_selected_runtime_package import FixtureHost, p, ROOT

spec = importlib.util.spec_from_file_location('selected_refresh_tests', ROOT / 'review-runtime-refresh.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class PackageHost(FixtureHost):
    def execute(self, argv):
        unit = p.UNIT_ROOT + argv[2]
        state = self.unit_states[unit]
        prop = argv[3].split('=', 1)[1]
        return str(state.get(prop, {
            'FragmentPath':unit, 'DropInPaths':'', 'NeedDaemonReload':'no',
            'ActiveState':state['active'], 'UnitFileState':state['enabled'],
            'SubState':'failed' if state['active'] == 'failed' else 'dead',
            'MainPID':'0', 'ControlPID':'0', 'Job':'',
        }[prop])).encode() + b'\n'

    unit_inventory = p.Host.unit_inventory
    unit_check = p.Host.unit_check

    def identity(self, allow_work=False):
        return dict(super().identity(), proxy_spki_sha256=p.sha(self.tree.read(p.ROOT + "/proxy-cert.pem")))

    def health(self, pins, key_id, selected, allow_work=False, allow_failed_renewal=False):
        units = self.unit_check(allow_failed_renewal=allow_failed_renewal)
        with patch.object(self, 'unit_check', return_value=units):
            return super().health(pins, key_id, selected, allow_failed_renewal=allow_failed_renewal)


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

    def test_idle_failed_renewal_is_preserved_without_runtime_effects(self):
        self.host.unit_states[p.RENEW_SERVICE]['active'] = 'failed'
        before = self.runtime_bytes()
        for operation in ('commit', 'rollback'):
            self.refresh.preflight()
            self.assertIn('retained failure', self.refresh.apply()['warnings'][0])
            result = getattr(self.refresh, operation)()
            self.assertTrue(result[{'commit':'committed', 'rollback':'rolled_back'}[operation]])
            self.assertIn('warnings', result)
            self.assertEqual(self.host.unit_states[p.RENEW_SERVICE]['active'], 'failed')
            self.assertEqual(self.runtime_bytes(), before)
        self.assertEqual(self.host.events, [])
        # The default serving boundary stays strict. A reviewed package update
        # may measure the idle failure for its owned stop/start operation.
        with self.assertRaises(ValueError):
            self.host.unit_check()
        self.assertEqual(self.package.plan('update')['plan']['units'][p.RENEW_SERVICE]['active'], 'failed')

    def test_renewal_terminal_result_can_change_during_dashboard_build(self):
        for before, after in (('inactive', 'failed'), ('failed', 'inactive')):
            for operation in ('commit', 'rollback'):
                with self.subTest(before=before, after=after, operation=operation):
                    self.host.unit_states[p.RENEW_SERVICE]['active'] = before
                    self.refresh.apply()
                    self.host.unit_states[p.RENEW_SERVICE]['active'] = after
                    result = getattr(self.refresh, operation)()
                    self.assertEqual('warnings' in result, after == 'failed')
                    self.assertEqual(self.host.unit_states[p.RENEW_SERVICE]['active'], after)
        self.assertEqual(self.host.events, [])

    def test_failed_renewal_never_bypasses_identity_health_or_idle_checks(self):
        self.host.unit_states[p.RENEW_SERVICE]['active'] = 'failed'
        for method in ('identity', 'health'):
            with self.subTest(method=method), patch.object(self.host, method, side_effect=ValueError('fixture unhealthy')):
                with self.assertRaisesRegex(ValueError, 'fixture unhealthy'):
                    self.refresh.preflight()
        for unit, prop, value in ((p.RENEW_SERVICE, 'MainPID', '100'),
                                  (p.RENEW_SERVICE, 'ControlPID', '100'),
                                  (p.RENEW_SERVICE, 'Job', '24'),
                                  (p.RENEW_SERVICE, 'active', 'activating'),
                                  (p.SUP_UNIT, 'active', 'failed'),
                                  (p.RENEW_TIMER, 'active', 'failed')):
            state = copy.deepcopy(self.host.unit_states[unit])
            with self.subTest(unit=unit, prop=prop):
                self.host.unit_states[unit][prop] = value
                with self.assertRaises(ValueError):
                    self.refresh.preflight()
            self.host.unit_states[unit] = state
        self.assertEqual(self.host.events, [])

    def test_renewal_unit_enablement_drift_still_blocks_completion(self):
        self.host.unit_states[p.RENEW_SERVICE]['active'] = 'failed'
        self.refresh.apply()
        self.host.unit_states[p.RENEW_SERVICE]['enabled'] = 'disabled'
        with self.assertRaisesRegex(ValueError, 'drift'):
            self.refresh.commit()
        self.assertEqual(self.refresh.read()['phase'], 'applied')
        self.assertEqual(self.host.events, [])

    def test_new_runtime_delivery_preserves_installed_generation_until_package_update(self):
        before = self.runtime_bytes()
        self.host.source['selected_browser_gateway.py'] += b'\n# changed protocol implementation\n'
        self.host.revision = '2' * 40
        self.refresh.apply()
        self.refresh.commit()
        self.assertEqual(before, self.runtime_bytes())
        self.assertEqual(self.host.events, [])
        plan = self.package.plan('update')
        self.package.review('update', plan['plan_sha256'])
        self.package.apply(plan['plan_sha256'])
        plan = self.package.plan('commit')
        self.package.review('commit', plan['plan_sha256'])
        self.package.commit(plan['plan_sha256'])
        path = p.SUPERVISOR + '/selected_browser_gateway.py'
        self.assertEqual(self.host.tree.read(path), self.host.source['selected_browser_gateway.py'])
        self.refresh.preflight()

    def test_retained_generation_tampering_refuses_even_when_installed_journal_matches(self):
        tx = self.package.tx()
        path = p.SUPERVISOR + '/selected_browser_gateway.py'
        staged = p.TRANSACTION + '/' + tx['id'] + '/new-' + str(list(p.OWNED).index(path))
        self.host.put(staged, b'foreign retained source\n', 0o600)
        with self.assertRaisesRegex(ValueError, 'committed package generation'):
            self.refresh.preflight()
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

    def test_verified_turn_renewal_during_update_is_narrowly_preserved(self):
        paths = ('/etc/proxypilot-a7/turn-cert.pem', '/etc/proxypilot-a7/turn-key.pem')
        for path in paths:
            self.host.put(path, b'fixture original TURN pair\n', 0o640)
        for operation in ('commit', 'rollback'):
            self.refresh.apply()
            for path in paths:
                self.host.put(path, b'fixture changed TURN pair ' + operation.encode(), 0o640)
            pair = {path:self.host.tree.pin(path) for path in paths}
            # Production cryptographic/service validation is tested separately.
            with patch.object(self.host, 'verified_turn_pair', create=True, return_value=pair) as verify:
                before = self.runtime_bytes()
                getattr(self.refresh, operation)()
                verify.assert_called_once()
                self.assertEqual(before, self.runtime_bytes())
        self.refresh.apply()
        self.host.put('/etc/proxypilot-a7/turnserver.conf', b'foreign config\n', 0o640)
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
        # The delivered upgrade may remain newer than the restored generation.
        self.refresh.preflight()
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


class TurnCertificateTests(unittest.TestCase):
    def test_real_turn_chain_hostname_key_and_service_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trust = root / 'trust'; trust.mkdir()
            run = lambda args: subprocess.run(['openssl', *args], check=True, capture_output=True)
            ca_key, ca_cert, key, csr, leaf = [root / n for n in ('ca.key', 'trust/ca.pem', 'leaf.key', 'leaf.csr', 'leaf.pem')]
            run(['req', '-x509', '-newkey', 'ed25519', '-nodes', '-days', '3', '-subj', '/CN=Fixture CA',
                 '-keyout', str(ca_key), '-out', str(ca_cert)])
            run(['req', '-newkey', 'ed25519', '-nodes', '-subj', '/CN=streamview.example.test',
                 '-addext', 'subjectAltName=DNS:streamview.example.test', '-keyout', str(key), '-out', str(csr)])
            run(['x509', '-req', '-in', str(csr), '-CA', str(ca_cert), '-CAkey', str(ca_key), '-CAcreateserial',
                 '-days', '2', '-copy_extensions', 'copy', '-out', str(leaf)])
            run(['rehash', str(trust)])
            (root / 'host/etc').mkdir(parents=True)
            (root / 'host/var/lib').mkdir(parents=True)
            host = p.Host(); host.tree = p.Tree(root / 'host', os.geteuid())
            cert_path, key_path = '/etc/proxypilot-a7/turn-cert.pem', '/etc/proxypilot-a7/turn-key.pem'
            host.tree.mkdir('/etc/proxypilot-a7', 0o750)
            host.tree.mkdir('/var/lib/proxypilot-a7', 0o700)
            host.tree.write(cert_path, leaf.read_bytes() + ca_cert.read_bytes(), 0o640)
            host.tree.write(key_path, key.read_bytes(), 0o640)
            journal = '/var/lib/proxypilot-a7/live-install.json'
            host.tree.write(journal, p.encoded({'turn':{'hostname':'streamview.example.test'}}), 0o600)
            renewal_active = False
            def execute(args, timeout=30, input=None):
                if args[0] == 'systemctl':
                    unit, field = args[2], args[3].split('=', 1)[1]
                    state = 'inactive' if 'cert.service' in unit and not renewal_active else 'active'
                    return {'FragmentPath':'/etc/systemd/system/' + unit, 'DropInPaths':'',
                            'NeedDaemonReload':'no', 'ActiveState':state}[field].encode()
                fixed = [str(trust) if a == '/etc/ssl/certs' else str(host.tree.path(a)) if a in (cert_path, key_path) else a for a in args]
                return subprocess.run(fixed, input=input, check=True, capture_output=True, timeout=timeout).stdout
            host.execute = execute
            self.assertEqual(host.verified_turn_pair()[cert_path], host.tree.pin(cert_path))
            renewal_active = True
            with self.assertRaises(ValueError): host.verified_turn_pair()
            renewal_active = False
            host.tree.write(journal, p.encoded({'turn':{'hostname':'wrong.example.test'}}), 0o600)
            with self.assertRaises(subprocess.CalledProcessError): host.verified_turn_pair()
            host.tree.write(journal, p.encoded({'turn':{'hostname':'streamview.example.test'}}), 0o600)
            host.tree.write(key_path, ca_key.read_bytes(), 0o640)
            with self.assertRaises(ValueError): host.verified_turn_pair()
            host.tree.write(key_path, key.read_bytes(), 0o640)
            ca_cert.unlink(); run(['rehash', str(trust)])
            with self.assertRaises(subprocess.CalledProcessError): host.verified_turn_pair()


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
        with patch.object(host, 'wiring'), patch.object(host, 'unit_check') as unit_check, patch.object(host, 'rpc', side_effect=rpc):
            with self.assertRaises(ValueError):
                host.health(pins, 'key', True)
            host.health(pins, 'key', True, allow_work=True, allow_failed_renewal=True)
            unit_check.assert_called_with(allow_failed_renewal=True)
            supervisor['supervisor']['key_id'] = 'foreign'
            with self.assertRaises(ValueError):
                host.health(pins, 'key', True, allow_work=True, allow_failed_renewal=True)
            supervisor['supervisor']['key_id'] = 'key'
            gateway['files']['selected_browser_gateway.py'] = 'foreign'
            with self.assertRaises(ValueError):
                host.health(pins, 'key', True, allow_work=True, allow_failed_renewal=True)


if __name__ == '__main__':
    unittest.main()
