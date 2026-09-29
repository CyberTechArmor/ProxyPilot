import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('a7_host_summary', HERE.parent / 'a7-host-summary.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)

CLEAN = {'canary_scan': 'passed', 'sinks': {'a': {'scanned': True, 'matches': 0, 'marker_matches': 0}}}


class A7SummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.dirs = {name: root / name for name in ('a3', 'a4', 'a5', 'a7')}
        for path in self.dirs.values():
            path.mkdir()
        (self.dirs['a5'] / 'stamp').mkdir()
        (self.dirs['a7'] / 'stamp').mkdir()
        self.journal, self.marker = root / 'live-install.json', root / 'live.json'
        self.enabled_at = time.time() - 3600
        self.write(self.journal, {'neko': {'commit': 'n', 'sha256': 'a' * 64}, 'probe': {'sha256': 'b' * 64},
                                  'vm_files': {'snapshot': 'pp-a7-pre-live-x', 'missing_libraries': []},
                                  'turn': {'hostname': 'turn.example.test', 'listen_ip': '192.0.2.10', 'conf_sha256': 'c'},
                                  'enabled': {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self.enabled_at))}})
        self.write(self.marker, {'version': 1})
        self.write(self.dirs['a3'] / 'worker-proof-1.json', {'worker_proof': 'passed', 'cases': [
            {'case': 'sessions', 'passed': True}]})
        self.write(self.dirs['a4'] / 'a4-proof-1.json', {'a4_proof': 'passed', 'cases': [{'case': 'login', 'passed': True}]})
        self.write(self.dirs['a5'] / 'stamp' / 'a5-proof-1.json', {'a5_proof': 'passed', 'cases': [
            {'case': 'supervised_run', 'passed': True}]})
        self.write(self.dirs['a7'] / 'stamp' / 'a7-proof-1.json', {
            'a7_proof': 'passed', 'supervisor': {'live': True, 'supervisor_sha256': 'd' * 64},
            'viewer_sha256': 'b' * 64, 'cases': [
                {'case': name, 'passed': True, 'observed': {'fps': 24.8, 'frames': 298} if name == 'live_view' else {}}
                for name in s.A7_CASES]})
        for name in s.CANARIES:
            self.write(self.dirs['a7'] / name, CLEAN)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, value):
        path.write_text(json.dumps(value) + '\n')

    def run_summary(self):
        return s.summary(a3=self.dirs['a3'], a4=self.dirs['a4'], a5=self.dirs['a5'], a7=self.dirs['a7'],
                         journal=self.journal, marker=self.marker)

    def test_every_verdict_is_reported_and_all_pass(self):
        result = self.run_summary()
        self.assertTrue(result['all_passed'], result)
        self.assertEqual(result['a7']['cases'], len(s.A7_CASES))
        self.assertTrue(result['a7']['all_cases'])
        self.assertEqual(result['a7']['live_view']['fps'], 24.8)
        self.assertTrue(result['a3']['after_live_enabled'])
        self.assertEqual(result['live_install']['turn']['hostname'], 'turn.example.test')
        self.assertEqual([c['verdict'] for c in result['canary']], ['passed'] * 3)

    def test_an_a3_proof_from_before_the_live_view_does_not_count(self):
        os.utime(self.dirs['a3'] / 'worker-proof-1.json', (self.enabled_at - 60, self.enabled_at - 60))
        result = self.run_summary()
        self.assertFalse(result['a3']['after_live_enabled'])
        self.assertFalse(result['all_passed'])

    def test_a_missing_case_a_failed_case_a_dirty_canary_or_no_marker_fails(self):
        report = json.loads((self.dirs['a7'] / 'stamp' / 'a7-proof-1.json').read_text())
        report['cases'] = report['cases'][:-1]
        self.write(self.dirs['a7'] / 'stamp' / 'a7-proof-1.json', report)
        self.assertFalse(self.run_summary()['all_passed'])
        self.setUp()
        report = json.loads((self.dirs['a7'] / 'stamp' / 'a7-proof-1.json').read_text())
        report['cases'][3]['passed'] = False
        report['a7_proof'] = 'failed'
        self.write(self.dirs['a7'] / 'stamp' / 'a7-proof-1.json', report)
        result = self.run_summary()
        self.assertEqual(result['a7']['failed'], [s.A7_CASES[3]])
        self.assertFalse(result['all_passed'])
        self.setUp()
        self.write(self.dirs['a7'] / 'canary-a7.json', {'canary_scan': 'failed', 'sinks': {'db': {'scanned': True, 'matches': 1}}})
        result = self.run_summary()
        self.assertEqual(result['canary'][2]['unclean_sinks'], ['db'])
        self.assertFalse(result['all_passed'])
        self.setUp()
        (self.dirs['a7'] / 'canary-a5.json').unlink()
        self.assertEqual(self.run_summary()['canary'][1]['verdict'], 'missing')
        self.setUp()
        self.marker.unlink()
        self.assertFalse(self.run_summary()['all_passed'])

    def test_nothing_secret_is_printed(self):
        text = json.dumps(self.run_summary())
        self.assertNotIn('credential', text)
        self.assertNotIn('secret', text)


if __name__ == '__main__':
    unittest.main()
