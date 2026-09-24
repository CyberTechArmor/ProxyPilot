import importlib.util
import pathlib
import unittest
spec = importlib.util.spec_from_file_location('logs', pathlib.Path(__file__).parents[1] / 'secure-mcp-caddy-logs.py')
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)
class Logs(unittest.TestCase):
    def test_standard_and_idempotent(self):
        for value, root in [('site {\n    log {\n        output file /tmp/access.log\n    }\n}\n', False), ('{\n    email admin@example.com\n}\nimport sites/*\n', True)]:
            patched = logs.transform(value, root)
            self.assertIn('request>uri regexp', patched)
            self.assertIn('request>headers>Authorization delete', patched)
            self.assertEqual(logs.transform(patched, root), patched)
    def test_custom_configuration_refused(self):
        for value, root in [('site {\nlog {\nformat json\n}\n}', False), ('{\nlog custom {\n}\n}', True), ('{\ndebug\n}', True), ('site {}', False)]:
            with self.assertRaises(ValueError): logs.transform(value, root)
if __name__ == '__main__': unittest.main()
