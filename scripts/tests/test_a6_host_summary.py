import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('a6_host_summary', HERE.parent / 'a6-host-summary.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.dirs = {name: root / name for name in ('a3', 'a4', 'a5', 'a6')}
        for path in self.dirs.values():
            path.mkdir()
        (self.dirs['a5'] / 'stamp').mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, value, pretty=False):
        path.write_text(json.dumps(value, indent=2 if pretty else None) + '\n')

    def run_summary(self):
        return s.summary(**self.dirs)

    def test_every_verdict_and_case_is_reported(self):
        self.write(self.dirs['a3'] / 'worker-proof-1.json', {'worker_proof': 'passed', 'cases': [
            {'case': 'sessions', 'passed': True}, {'case': 'backend_view', 'passed': True}]})
        self.write(self.dirs['a4'] / 'a4-proof-1.json', {'a4_proof': 'passed', 'cases': [{'case': 'login', 'passed': True}]})
        self.write(self.dirs['a5'] / 'stamp' / 'a5-proof-1.json', {'a5_proof': 'passed', 'cases': [
            {'case': 'supervised_run', 'passed': True}]})
        clean = {'canary_scan': 'passed', 'sinks': {'a': {'scanned': True, 'matches': 0, 'marker_matches': 0}}}
        self.write(self.dirs['a6'] / 'canary-a4.json', clean, pretty=True)
        self.write(self.dirs['a6'] / 'canary-a5.json', clean, pretty=True)
        result = self.run_summary()
        self.assertTrue(result['all_passed'])
        self.assertEqual(result['a3']['case_names'], ['sessions', 'backend_view'])
        self.assertEqual([c['verdict'] for c in result['canary']], ['passed', 'passed'])

    def test_a_missing_report_a_failed_case_or_a_dirty_sink_fails(self):
        self.assertFalse(self.run_summary()['all_passed'])
        self.assertEqual(self.run_summary()['a3']['verdict'], 'missing')
        self.write(self.dirs['a3'] / 'worker-proof-1.json', {'worker_proof': 'failed', 'cases': [
            {'case': 'backend_view', 'passed': False}]})
        self.assertEqual(self.run_summary()['a3']['failed'], ['backend_view'])
        self.write(self.dirs['a6'] / 'canary-a4.json', {'canary_scan': 'passed', 'sinks': {
            'journal': {'scanned': False}}}, pretty=True)
        self.assertEqual(self.run_summary()['canary'][0]['unclean_sinks'], ['journal'])
        (self.dirs['a6'] / 'canary-a5.json').write_text('not json')
        self.assertEqual(self.run_summary()['canary'][1]['verdict'], 'unreadable')


if __name__ == '__main__':
    unittest.main()
