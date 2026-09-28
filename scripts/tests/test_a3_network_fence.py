import importlib.util
from pathlib import Path
import unittest
import json
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    'a3_network_fence', Path(__file__).resolve().parents[1] / 'a3-network-fence.py')
fence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fence)


class A3FencePlanTests(unittest.TestCase):
    def manifest(self):
        return dict(vm_name=fence.VM, vm_uuid='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                    tap=fence.TAP, guest_ipv4='10.185.17.179', gateway_ipv4='10.185.17.1')

    def test_wrong_target_or_unreviewed_fields_refused(self):
        for change in ({'vm_name': 'pp-nodus'}, {'tap': 'eth0'},
                       {'allow_dns': True}, {'vm_uuid': 'invalid'},
                       {'vm_uuid': '00000000-0000-0000-0000-000000000000'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                fence.render(self.manifest() | change)

    def test_invalid_or_injected_addresses_refused(self):
        for value in ('127.0.0.1', '0.0.0.0', '::1', '224.0.0.1',
                      '1.1.1.1', '169.254.1.1', '10.185.17.1', '10.0.0.1; accept'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fence.render(self.manifest() | {'guest_ipv4': value})

    def test_interface_boundary_covers_routing_and_spoofing(self):
        rules = fence.render(self.manifest())
        self.assertIn('type filter hook prerouting priority -300', rules)
        self.assertIn('iifname "ppa3proof0" jump from_worker', rules)
        self.assertIn('ether type ip counter name denied_ipv4 drop', rules)
        self.assertIn('ether type ip6 counter name denied_ipv6 drop', rules)
        self.assertIn('counter name denied_other drop', rules)
        self.assertNotIn('ct state', rules)  # No previously-established escape.
        self.assertNotIn('udp', rules)  # No raw DNS/DHCP/QUIC bypass.
        self.assertNotIn('flush ruleset', rules)
        self.assertEqual(rules.count('tcp dport'), 1)

    def test_boot_ordering_and_no_stop_cleanup(self):
        unit = fence.unit()
        self.assertIn('Before=incus.service incus-startup.service', unit)
        self.assertLess(unit.index('--check --file'), unit.index('ExecStart=/usr/sbin/nft --file'))
        self.assertNotIn('ExecStop', unit)

    def test_host_check_only_reads_and_checks_exact_identity(self):
        calls = []
        replies = [
            dict(type='virtual-machine', config={'volatile.uuid': fence.PROOF_UUID,
                 'volatile.eth0.host_name': 'tap-before'},
                 expanded_devices={'eth0': {'type': 'nic', 'network': 'incusbr0'}}),
            dict(config={'ipv4.address': '10.185.17.1/24'}),
            dict(network={'enp5s0': {'addresses': [
                {'family': 'inet', 'address': '10.185.17.179'}]}}),
        ]
        def run(argv, **options):
            calls.append(argv)
            if argv[0] == 'incus':
                self.assertEqual(argv[1], 'query')
                return SimpleNamespace(stdout=json.dumps(replies.pop(0)))
            self.assertEqual(argv, ['nft', '--check', '--file', '-'])
            self.assertIn('iifname "ppa3proof0"', options['input'])
            return SimpleNamespace(stdout='')
        result = fence.check_host(run)
        self.assertEqual(result['nft_syntax'], 'passed')
        self.assertFalse(result['installed'])
        self.assertEqual(len(calls), 4)

    def test_host_identity_change_stops_before_nft(self):
        calls = []
        def run(argv, **options):
            calls.append(argv)
            return SimpleNamespace(stdout=json.dumps(dict(type='virtual-machine',
                                   config={'volatile.uuid': 'another-vm'})))
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            fence.check_host(run)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
