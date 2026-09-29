"""a6-reboot-check.py: record before a host reboot, then check that the host and
the proof VM really rebooted and that every part of the agent stack came back by
itself. Commands are scripted; nothing touches a real host."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('a6_reboot_check', ROOT / 'a6-reboot-check.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

HEALTHY = {
    'a3-install-fence.py': json.dumps({'installed': True, 'service': 'active/enabled'}, indent=2),
    'a3-install-proxy.py': json.dumps({'installed': True, 'service': 'active/enabled'}, indent=2),
    'a3-install-supervisor.py': json.dumps({'installed': True, 'accepting_launch': True, 'blockers': [],
                                            'active': None, 'key_id': 'k'}, indent=2),
    'a4-install-broker.py': '    "/etc/proxypilot-a4/broker/a4-credential-broker.py": "790a",\n'
                            + json.dumps({'installed': True, 'vault_healthy': True, 'approle_login': 'ok'}, indent=2),
    'a3-probe-proxy.py': json.dumps({'proxy_checks': 'passed', 'status_codes': ['403']}, indent=2),
}


class Host:
    """Scripted commands: each call answers from `answers`, keyed by what is run."""

    def __init__(self, vm_boot='vm-after', **overrides):
        self.answers = {**{name: (0, out) for name, out in HEALTHY.items()}, 'vm': (0, vm_boot + '\n'),
                        'timer-active': (0, 'active'), 'timer-enabled': (0, 'enabled'),
                        'docker': (0, 'true healthy\n'), **overrides}
        self.calls = []

    def __call__(self, argv, timeout=180):
        self.calls.append(argv)
        if argv[0] == 'incus':
            return self.answers['vm']
        if argv[0] == 'systemctl':
            return self.answers['timer-active' if argv[1] == 'is-active' else 'timer-enabled']
        if argv[0] == 'docker':
            return self.answers['docker']
        return self.answers[Path(argv[1]).name]


class RebootCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.boot = root / 'boot_id'
        self.record_path = root / 'proof' / 'reboot-before.json'
        self.boot.write_text('host-before\n')
        r.record(run=Host(vm_boot='vm-before'), host_boot=self.boot, path=self.record_path, clock=lambda: 1)

    def tearDown(self):
        self.temp.cleanup()

    def check(self, host, host_boot='host-after'):
        self.boot.write_text(host_boot + '\n')
        return r.check(run=host, host_boot=self.boot, path=self.record_path)

    def failed(self, result):
        return {c['check']: c.get('reason') for c in result['checks'] if not c['passed']}

    def test_record_keeps_only_the_two_boot_ids(self):
        saved = json.loads(self.record_path.read_text())
        self.assertEqual(saved, {'version': 1, 'host_boot_id': 'host-before', 'vm_boot_id': 'vm-before',
                                 'recorded_at_epoch': 1})
        self.assertEqual(self.record_path.stat().st_mode & 0o777, 0o600)

    def test_a_clean_reboot_passes_every_check(self):
        host = Host()
        result = self.check(host)
        self.assertEqual(result['reboot_check'], 'passed', self.failed(result))
        self.assertEqual([c['check'] for c in result['checks']],
                         ['host_rebooted', 'vm_running', 'vm_rebooted', 'fence', 'origin_proxy', 'supervisor',
                          'broker', 'renewal_timer', 'proxy_path', 'dashboard'])
        # Only status and probe actions run: nothing is installed, restarted or removed.
        scripts = [call[2:] for call in host.calls if call[0] == 'python3']
        self.assertEqual(scripts, [['status'], ['status'], ['status'], ['status'], []])

    def test_no_reboot_since_record_fails(self):
        result = self.check(Host(vm_boot='vm-before'), host_boot='host-before')
        self.assertEqual(result['reboot_check'], 'failed')
        self.assertEqual(set(self.failed(result)), {'host_rebooted', 'vm_rebooted'})

    def test_a_vm_that_did_not_start_with_the_host_fails(self):
        result = self.check(Host(vm=(1, '')))
        self.assertIn('vm_running', self.failed(result))
        self.assertIn('vm_rebooted', self.failed(result))

    def test_each_component_that_did_not_come_back_is_named(self):
        cases = {
            'fence': {'a3-install-fence.py': (1, '')},
            'origin_proxy': {'a3-install-proxy.py': (1, 'A3 proxy refused: unit inactive')},
            'supervisor': {'a3-install-supervisor.py': (0, json.dumps({'accepting_launch': False,
                                                                        'blockers': ['vm stopped'], 'active': None}))},
            'broker': {'a4-install-broker.py': (0, json.dumps({'vault_healthy': True, 'approle_login': 'failed'}))},
            'renewal_timer': {'timer-enabled': (1, 'disabled')},
            'proxy_path': {'a3-probe-proxy.py': (1, json.dumps({'proxy_checks': 'failed'}))},
            'dashboard': {'docker': (0, 'true unhealthy\n')},
        }
        for name, override in cases.items():
            with self.subTest(name):
                result = self.check(Host(**override))
                self.assertEqual(result['reboot_check'], 'failed')
                self.assertEqual(list(self.failed(result)), [name])

    def test_a_live_attempt_after_the_reboot_fails_the_supervisor_check(self):
        busy = json.dumps({'accepting_launch': True, 'blockers': [], 'active': {'attempt_id': 'a'}})
        result = self.check(Host(**{'a3-install-supervisor.py': (0, busy)}))
        self.assertEqual(list(self.failed(result)), ['supervisor'])
        self.assertIn('active an attempt', self.failed(result)['supervisor'])

    def test_without_a_record_the_check_says_to_record_first(self):
        self.record_path.unlink()
        result = self.check(Host())
        self.assertEqual(result['reboot_check'], 'failed')
        self.assertIn('run record first', result['checks'][0]['reason'])

    def test_output_carries_no_status_body(self):
        result = self.check(Host())
        text = json.dumps(result)
        for body in ('790a', 'key_id', 'status_codes'):
            self.assertNotIn(body, text)


if __name__ == '__main__':
    unittest.main()
