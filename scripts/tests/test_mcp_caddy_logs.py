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
    def test_v1_upgrades_without_losing_mcp_or_header_redaction(self):
        for root in [False, True]:
            text = '{\n    log {\n        ' + logs.LEGACY_MARKER + '\n        ' + logs.LEGACY_FORMAT + '\n    }\n}\n'
            patched = logs.transform(text, root)
            self.assertIn(logs.MARKER, patched)
            self.assertIn('request>uri regexp "/api/mcp[^ ]*"', patched)
            for key in ['auth', 'rauth', 'login']:
                self.assertIn('delete ' + key, patched)
            for header in ['Referer', 'Authorization', 'Cookie']:
                self.assertIn('request>headers>' + header + ' delete', patched)
            self.assertEqual(logs.transform(patched, root), patched)
    def test_modified_or_debug_existing_filter_refused(self):
        for marker, fmt in [(logs.LEGACY_MARKER, logs.LEGACY_FORMAT), (logs.MARKER, logs.FORMAT)]:
            with self.assertRaises(ValueError):
                logs.transform('{\n' + marker + '\n' + fmt.replace('wrap json', 'wrap console') + '\n}')
            with self.assertRaises(ValueError):
                logs.transform('{\n debug\n' + marker + '\n        ' + fmt + '\n}')
if __name__ == '__main__': unittest.main()

