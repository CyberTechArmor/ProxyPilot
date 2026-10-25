import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'installer', Path(__file__).resolve().parents[1] / 'a3-install-fence.py')
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)


class InstallTests(unittest.TestCase):
    def envelope(self, metadata):
        return json.dumps(dict(type='sync', status_code=200, error_code=0, error='', metadata=metadata))

    def test_empty_operations_metadata_is_valid_only_in_success_envelope(self):
        path = '/1.0/operations?recursion=1'
        with patch.object(i, 'execute', return_value=self.envelope({})) as execute:
            self.assertEqual(i.query(path), {})
            execute.assert_called_once_with(['incus', 'query', '--raw', path])

    def test_missing_malformed_and_error_responses_fail_with_source(self):
        path = '/1.0/operations?recursion=1'
        values = ['', '   ', 'not json', '{}', 'null', self.envelope(None),
                  self.envelope([]), json.dumps(dict(type='error', status_code=403,
                  error_code=403, error='denied', metadata={}))]
        for value in values:
            with self.subTest(value=value), patch.object(i, 'execute', return_value=value), \
                    self.assertRaisesRegex(ValueError, 'incus query --raw /1.0/operations'):
                i.query(path)

    def test_raw_query_preserves_snapshot_list_and_instance_metadata(self):
        for path, data in [('/1.0/instances/' + i.fence.VM, self.target()),
                           ('/1.0/instances/' + i.fence.VM + '/snapshots', self.snapshots())]:
            with patch.object(i, 'execute', return_value=self.envelope(data)):
                self.assertEqual(i.query(path), data)

    def test_install_with_empty_operations_reaches_syntax_check_without_writes(self):
        calls = []
        data = [self.target(), self.network(), self.snapshots(), {}]
        def execute(argv, **kwargs):
            calls.append(argv)
            if argv[:3] == ['incus', 'query', '--raw']:
                return self.envelope(data.pop(0))
            self.assertEqual(argv, ['nft', '--check', '--file', '-'])
            raise subprocess.CalledProcessError(1, argv, stderr='test stop before writes')
        with patch.object(i, 'execute', side_effect=execute), patch.object(i, 'secure'), \
                patch.object(i, 'save') as save, patch.object(i, 'write_journal') as journal:
            with self.assertRaises(subprocess.CalledProcessError):
                i.install()
            self.assertEqual(len(calls), 5)
            save.assert_not_called()
            journal.assert_not_called()

    def test_invalid_operations_never_reach_mutation(self):
        for operations in [{'running': 'unexpected'}, {'running': [{}]},
                           {'running': [{'status': 'Running', 'resources': {'instances': 'bad'}}]}]:
            with patch.object(i, 'query', side_effect=[self.target(), self.network(), self.snapshots(), operations]), \
                    self.assertRaisesRegex(ValueError, 'invalid'):
                i.inspect()

    def target(self):
        nic = dict(type='nic', network='incusbr0', **{'ipv4.address': '10.185.17.179'})
        return dict(name=i.fence.VM, type='virtual-machine', status='Stopped',
                    config={'volatile.uuid': i.fence.PROOF_UUID, 'boot.autostart': 'false',
                            'security.guestapi': 'false', 'security.nesting': 'false'},
                    devices={'eth0': nic}, expanded_devices={'eth0': nic.copy()})

    def network(self):
        return {'config': {'ipv4.address': '10.185.17.1/24',
                           'ipv6.address': 'fd42:53c1:d5e6:16b0::1/64'}}

    def snapshots(self):
        return ['/1.0/instances/' + i.fence.VM + '/snapshots/' + i.SNAPSHOT]

    def test_exact_stopped_target_accepted(self):
        self.assertIsNone(i.validate_target(self.target(), self.network(), self.snapshots()))

    def test_identity_running_autostart_and_extra_nic_refused(self):
        targets = []
        for field, value in [('name', 'pp-nodus'), ('type', 'container'), ('status', 'Running')]:
            target = self.target()
            target[field] = value
            targets.append(target)
        for field in ['volatile.uuid', 'boot.autostart', 'security.guestapi', 'security.nesting']:
            target = self.target()
            target['config'][field] = 'unexpected'
            targets.append(target)
        target = self.target()
        target['expanded_devices']['eth1'] = {'type': 'nic', 'network': 'incusbr0'}
        targets.append(target)
        for target in targets:
            with self.subTest(target=target), self.assertRaises(ValueError):
                i.validate_target(target, self.network(), self.snapshots())

    def test_missing_reservation_snapshot_or_wrong_gateway_refused(self):
        target = self.target()
        target['devices'] = {}
        cases = [(target, self.network(), self.snapshots()),
                 (self.target(), self.network(), []),
                 (self.target(), self.network(), {'unexpected': self.snapshots()}),
                 (self.target(), {'config': {'ipv4.address': '10.185.17.1/24'}}, self.snapshots())]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(ValueError):
                i.validate_target(*args)

    def test_active_operation_blocks_change(self):
        replies = [self.target(), self.network(), self.snapshots(),
                   {'running': [{'status': 'Running', 'resources': {
                       'instances': ['/1.0/instances/' + i.fence.VM]}}]}]
        with patch.object(i, 'query', side_effect=replies), self.assertRaisesRegex(ValueError, 'holds'):
            i.inspect()

    def test_counter_and_handle_changes_do_not_mask_rule_changes(self):
        doc = {'nftables': [{'metainfo': {'version': '1'}}, {'counter': {
            'name': 'denied_ipv4', 'packets': 1, 'bytes': 60, 'handle': 2}},
            {'rule': {'expr': [{'drop': None}], 'handle': 3}}]}
        changed = copy.deepcopy(doc)
        changed['nftables'][1]['counter'].update(packets=100, bytes=6000, handle=42)
        self.assertEqual(i.fingerprint(doc), i.fingerprint(changed))
        changed['nftables'][2]['rule']['expr'] = [{'accept': None}]
        self.assertNotEqual(i.fingerprint(doc), i.fingerprint(changed))

    def test_kernel_check_failure_writes_nothing(self):
        error = subprocess.CalledProcessError(1, ['nft'], stderr='syntax rejected')
        with patch.object(i, 'inspect', return_value=self.target()), patch.object(i, 'secure'), \
                patch.object(i, 'execute', side_effect=error) as execute, \
                patch.object(i, 'save') as save, patch.object(i, 'write_journal') as journal:
            with self.assertRaises(subprocess.CalledProcessError):
                i.install()
            save.assert_not_called()
            journal.assert_not_called()
            self.assertEqual(execute.call_args.args[0], ['nft', '--check', '--file', '-'])

    def test_unit_verify_failure_writes_nothing(self):
        with patch.object(i, 'inspect', return_value=self.target()), patch.object(i, 'secure'), \
                patch.object(i, 'execute', side_effect=['', subprocess.CalledProcessError(1, ['systemd-analyze'])]), \
                patch.object(i, 'save') as save, patch.object(i, 'write_journal') as journal:
            with self.assertRaises(subprocess.CalledProcessError):
                i.install()
            save.assert_not_called()
            journal.assert_not_called()

    def test_incomplete_journal_cannot_flush_uncertain_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal_path = Path(tmp) / 'journal.json'
            journal_path.write_text('{}')
            with patch.object(i, 'JOURNAL', journal_path), patch.object(i, 'inspect', return_value=self.target()), \
                    patch.object(i, 'secure'), patch.object(i, 'execute', return_value='') as execute, \
                    patch.object(i, 'read_journal', return_value={'phase': 'fenced'}), \
                    patch.object(i, 'save') as save:
                with self.assertRaisesRegex(ValueError, 'Incomplete'):
                    i.install()
                save.assert_not_called()
                self.assertEqual(len(execute.call_args_list), 2)
                self.assertEqual(execute.call_args_list[0].args[0][1], '--check')

    def test_running_vm_cannot_remove_fence(self):
        with patch.object(i, 'inspect', side_effect=ValueError('running')), \
                patch.object(i, 'execute') as execute:
            with self.assertRaises(ValueError):
                i.remove()
            execute.assert_not_called()

    def test_rollback_restores_nic_before_deleting_own_table(self):
        before = self.target()
        before['devices']['eth0']['host_name'] = i.fence.TAP
        after = self.target()
        with tempfile.TemporaryDirectory() as tmp:
            rules, unit = Path(tmp) / 'rules', Path(tmp) / 'unit'
            rules.write_text('rules')
            unit.write_text('unit')
            data = {'table_fingerprint': i.fingerprint({}), 'previous_host_name': None}
            with patch.object(i, 'RULES', rules), patch.object(i, 'UNIT', unit), \
                    patch.object(i, 'inspect', side_effect=[before, after]), \
                    patch.object(i, 'read_journal', return_value=data), patch.object(i, 'verify_files'), \
                    patch.object(i, 'table', return_value={}), patch.object(i, 'write_journal'), \
                    patch.object(i, 'execute', return_value='') as execute:
                self.assertTrue(i.remove()['removed'])
                commands = [call.args[0] for call in execute.call_args_list]
                self.assertEqual(commands[0], ['incus', 'config', 'device', 'unset', i.fence.VM, 'eth0', 'host_name'])
                self.assertEqual(commands[2], ['nft', 'delete', 'table', 'bridge', i.fence.TABLE])
                self.assertFalse(rules.exists())
                self.assertFalse(unit.exists())


    def reattest_world(self, tmp, live=True, recorded='old'):
        rules = Path(tmp) / 'fence.nft'
        rules.write_text(i.fence.render(i.MANIFEST, live=live))
        data = {'phase': 'installed', 'live_relay': live, 'table_fingerprint': recorded,
                'files': {str(rules): i.digest(rules.read_text())}}
        return rules, data

    def test_reattest_records_only_an_output_change(self):
        doc = {'nftables': [{'table': {'family': 'bridge', 'name': i.fence.TABLE}}]}
        with tempfile.TemporaryDirectory() as tmp:
            rules, data = self.reattest_world(tmp)
            with patch.object(i, 'RULES', rules), patch.object(i, 'inspect'), \
                    patch.object(i, 'read_journal', return_value=data), patch.object(i, 'verify_files'), \
                    patch.object(i, 'table', return_value=doc), patch.object(i, 'scratch_table', return_value=doc), \
                    patch.object(i, 'write_journal') as journal, patch.object(i, 'status', return_value='ok'):
                self.assertEqual(i.reattest(), 'ok')
            written = journal.call_args.args[0]
            self.assertEqual(written['table_fingerprint'], i.fingerprint(doc))
            self.assertEqual(written['reattested'][-1]['previous'], 'old')
            self.assertEqual(written['reattested'][-1]['current'], i.fingerprint(doc))

    def test_reattest_never_records_a_rule_change(self):
        live = {'nftables': [{'rule': {'expr': [{'accept': None}]}}]}
        reviewed = {'nftables': [{'rule': {'expr': [{'drop': None}]}}]}
        with tempfile.TemporaryDirectory() as tmp:
            rules, data = self.reattest_world(tmp)
            with patch.object(i, 'RULES', rules), patch.object(i, 'inspect'), \
                    patch.object(i, 'read_journal', return_value=data), patch.object(i, 'verify_files'), \
                    patch.object(i, 'table', return_value=live), patch.object(i, 'scratch_table', return_value=reviewed), \
                    patch.object(i, 'write_journal') as journal:
                with self.assertRaisesRegex(ValueError, 'differs from the reviewed rules'):
                    i.reattest()
            journal.assert_not_called()

    def test_reattest_refuses_rules_that_are_not_the_reviewed_rendering(self):
        with tempfile.TemporaryDirectory() as tmp:
            rules, data = self.reattest_world(tmp, live=False)
            data['live_relay'] = True  # recorded relay state no longer matches the file
            with patch.object(i, 'RULES', rules), patch.object(i, 'inspect'), \
                    patch.object(i, 'read_journal', return_value=data), patch.object(i, 'verify_files'), \
                    patch.object(i, 'table') as table, patch.object(i, 'write_journal') as journal:
                with self.assertRaisesRegex(ValueError, 'reviewed rendering'):
                    i.reattest()
            table.assert_not_called()
            journal.assert_not_called()

    def test_reattest_refuses_an_incomplete_fence(self):
        for phase in ('prepared', 'fenced', 'relay_pending', 'removed'):
            with self.subTest(phase=phase), patch.object(i, 'inspect'), \
                    patch.object(i, 'read_journal', return_value={'phase': phase}), \
                    patch.object(i, 'write_journal') as journal, self.assertRaisesRegex(ValueError, 'not installed'):
                i.reattest()
            journal.assert_not_called()

    def test_reattest_is_a_no_op_when_the_fingerprint_still_matches(self):
        doc = {'nftables': []}
        with tempfile.TemporaryDirectory() as tmp:
            rules, data = self.reattest_world(tmp, recorded=i.fingerprint(doc))
            with patch.object(i, 'RULES', rules), patch.object(i, 'inspect'), \
                    patch.object(i, 'read_journal', return_value=data), patch.object(i, 'verify_files'), \
                    patch.object(i, 'table', return_value=doc), patch.object(i, 'scratch_table') as scratch, \
                    patch.object(i, 'write_journal') as journal, patch.object(i, 'status', return_value='ok'):
                self.assertEqual(i.reattest(), 'ok')
            scratch.assert_not_called()
            journal.assert_not_called()

    def test_scratch_table_runs_in_a_new_namespace_without_a_shell(self):
        with patch.object(i, 'execute', return_value='{"nftables": []}') as execute:
            self.assertEqual(i.scratch_table(), {'nftables': []})
        argv = execute.call_args.args[0]
        self.assertEqual(argv[:3], ['unshare', '--net', '--'])
        self.assertEqual(argv[-2:], [str(i.RULES), i.fence.TABLE])
        self.assertNotIn('sh', [Path(a).name for a in argv])

    def test_scratch_load_of_the_rendered_rules_matches_itself(self):
        nft, unshare = shutil.which('nft'), shutil.which('unshare')
        if os.geteuid() != 0 or not nft or not unshare or \
                subprocess.run([unshare, '--net', '--', 'true'], capture_output=True).returncode:
            self.skipTest('needs root, nft and network namespaces')
        with tempfile.TemporaryDirectory() as tmp:
            rules = Path(tmp) / 'fence.nft'
            rules.write_text(i.fence.render(i.MANIFEST, live=True))
            with patch.object(i, 'RULES', rules):
                first, second = i.scratch_table(), i.scratch_table()
        names = [r['table']['name'] for r in first['nftables'] if 'table' in r]
        self.assertEqual(names, [i.fence.TABLE])
        self.assertEqual(i.fingerprint(first), i.fingerprint(second))


if __name__ == '__main__':
    unittest.main()
