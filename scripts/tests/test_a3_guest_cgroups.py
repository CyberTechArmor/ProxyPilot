import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'cgroup_probe', Path(__file__).resolve().parents[1] / 'a3-probe-guest-cgroups.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class GuestCgroupProbeTests(unittest.TestCase):
    def test_every_case_is_a_fixed_workload_and_negative_limit(self):
        self.assertEqual(set(p.CASES), {'cpu', 'memory', 'process', 'time', 'disk'})
        for name, (properties, code, marker, success) in p.CASES.items():
            with self.subTest(name=name):
                compile(code, name, 'exec')
                self.assertFalse(any('ExecStart=' in value for value in properties))
                self.assertTrue(marker)
                self.assertIs(type(success), bool)

    def test_host_timeout_stops_exact_transient_unit(self):
        name = 'time'
        states = [dict(ActiveState='unknown', ControlGroup='', Result='unknown'),
                  dict(ActiveState='inactive', ControlGroup='', Result='success')]
        calls = []

        def guest(argv, **kwargs):
            calls.append(argv)
            if argv[0] == 'systemd-run':
                raise subprocess.TimeoutExpired(argv, 30)
            return subprocess.CompletedProcess(argv, 0, '', '')

        with patch.object(p, 'unit_state', side_effect=states), \
             patch.object(p, 'guest', side_effect=guest):
            with self.assertRaises(subprocess.TimeoutExpired):
                p.probe(name, *p.CASES[name])
        unit = p.PREFIX + name + '-' + str(p.os.getpid())
        self.assertEqual(calls[-1], ['systemctl', 'stop', unit])

    def test_wrong_exit_or_missing_enforcement_refuses(self):
        states = [dict(ActiveState='unknown', ControlGroup='', Result='unknown'),
                  dict(ActiveState='inactive', ControlGroup='', Result='success')]

        def guest(argv, **kwargs):
            # Memory exhaustion must fail. A successful process exit is a
            # breached cap even if it printed its initial marker.
            if argv[0] == 'systemd-run':
                return subprocess.CompletedProcess(argv, 0, 'ALLOCATING\nMEMORY_LIMIT_FAILED\n', '')
            return subprocess.CompletedProcess(argv, 0, '', '')

        with patch.object(p, 'unit_state', side_effect=states), \
             patch.object(p, 'guest', side_effect=guest):
            with self.assertRaisesRegex(ValueError, 'memory cgroup proof failed'):
                p.probe('memory', *p.CASES['memory'])

    def test_surviving_cgroup_descendant_refuses_cleanup(self):
        name = p.PREFIX + 'process-42'
        state = dict(ActiveState='failed', ControlGroup='/system.slice/' + name + '.service',
                     Result='exit-code')
        with patch.object(p, 'guest', return_value=subprocess.CompletedProcess([], 1, '', 'populated 1')):
            with self.assertRaisesRegex(ValueError, 'descendants survived'):
                p.assert_unit_empty(name, state)
        with self.assertRaisesRegex(ValueError, 'Unexpected guest cgroup'):
            p.assert_unit_empty(name, state | {'ControlGroup': '/other.slice/x.service'})


if __name__ == '__main__':
    unittest.main()
