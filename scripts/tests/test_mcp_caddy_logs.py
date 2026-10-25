import copy
import contextlib
import importlib.util
import io
import json
import shutil
import tempfile
from unittest import mock
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

class Verification(unittest.TestCase):
    def setUp(self):
        self.encoder = {'format': 'filter', 'wrap': {'format': 'filter', 'wrap': {'format': 'json'},
                        'fields': {'request>uri': {'filter': 'query'}}},
                        'fields': {'request>uri': {'filter': 'regexp'},
                                   'request>headers>Referer': {'filter': 'delete'}}}
        self.config = {'logging': {'logs': {'default': {'encoder': self.encoder}}}}

    def test_failed_caddy_command_preserves_safe_phase(self):
        logs.stage('fixture')
        with mock.patch.object(logs.subprocess, 'run', side_effect=logs.subprocess.CalledProcessError(1, ['caddy'])):
            with self.assertRaises(logs.subprocess.CalledProcessError):
                logs.run_caddy('validate', '--config', '/private')
        self.assertEqual(logs.STAGE, 'caddy_validate')

    def test_active_global_proof(self):
        self.assertTrue(logs.prove_config(self.config, self.encoder)['global_default_encoder'])
        self.config['logging']['logs']['access'] = {'include': ['http.log.access.log0']}
        self.assertTrue(logs.prove_config(self.config, self.encoder)['debug_disabled'])

    def test_rejects_missing_or_changed_global(self):
        for value in [{}, {'logging': {'logs': {'default': {'encoder': {'format': 'json'}}}}}]:
            with self.assertRaises(ValueError): logs.prove_config(value, self.encoder)

    def test_rejects_debug_and_runtime_bypass(self):
        variants = [
            {'level': 'DEBUG', 'encoder': self.encoder},
            {'level': 'trace', 'encoder': self.encoder},
            {'include': ['http.log.error'], 'encoder': self.encoder},
            {'exclude': ['http.log.error'], 'encoder': self.encoder},
        ]
        for default in variants:
            config = copy.deepcopy(self.config)
            config['logging']['logs']['default'] = default
            with self.assertRaises(ValueError): logs.prove_config(config, self.encoder)
        for extra in [{}, {'include': ['http.log.error']}, {'include': ['http.log.access.a', 'http.log.error']}]:
            config = copy.deepcopy(self.config)
            config['logging']['logs']['other'] = extra
            with self.assertRaises(ValueError): logs.prove_config(config, self.encoder)

    def test_rejects_log_credentials(self):
        self.config['apps'] = {'http': {'servers': {'s': {'logs': {'should_log_credentials': True}}}}}
        with self.assertRaises(ValueError): logs.prove_config(self.config, self.encoder)

    def test_json_parser_rejects_wrong_shape_malformed_or_oversize(self):
        for raw in [b'[]', b'incomplete', b'x' * (logs.LIMIT + 1)]:
            with self.assertRaises((ValueError, json.JSONDecodeError)): logs.parse_json(raw)
        self.assertEqual(logs.parse_json(b'{"ok": true}'), {'ok': True})

    def record(self, uri='/__pp_normal?keep=visible', status=200):
        return {'request': {'uri': uri}, 'status': status, 'msg': 'handled request'}

    def test_record_evidence_requires_status_path_and_keep(self):
        expected = [('/__pp_normal', 200, False)]
        self.assertEqual(logs.prove_records([self.record()], ['SENTINEL'], expected), 1)
        for record in [self.record(status=502), self.record('/wrong?keep=visible'),
                       self.record('/__pp_normal'), self.record('/__pp_normal?keep=visible&auth=other')]:
            with self.assertRaises(ValueError): logs.prove_records([record], ['SENTINEL'], expected)
        with self.assertRaises(ValueError): logs.prove_records([], ['SENTINEL'], expected)
        with self.assertRaises(ValueError): logs.prove_records([self.record(), self.record()], ['SENTINEL'], expected)

    def test_sentinel_rejected_anywhere_including_msg_error_nested_and_encoding(self):
        for field in ['msg', 'error', 'other']:
            for value in ['SENTINEL', '%53ENTINEL', '%2553ENTINEL', {'nested': ['SENTINEL']}]:
                record = self.record()
                record[field] = value
                with self.assertRaises(ValueError):
                    logs.prove_records([record], ['SENTINEL'], [('/__pp_normal', 200, False)])

    def test_mcp_evidence_requires_exact_mask(self):
        expected = [('/api/mcp/probe', 200, True)]
        self.assertEqual(logs.prove_records([self.record('[redacted MCP URL]')], ['SENTINEL'], expected), 1)
        with self.assertRaises(ValueError): logs.prove_records([self.record('/api/mcp/probe')], ['SENTINEL'], expected)

    def test_read_records_does_not_ignore_malformed_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'log'
            self.assertEqual(logs.read_records(path), [])
            path.write_text('{"ok": true}\nnot json\n')
            with self.assertRaises(ValueError): logs.read_records(path)

    def test_active_config_refuses_remote_disabled_and_redirects(self):
        for admin in [{'disabled': True}, {'listen': 'public.example:2019'}, {'listen': 'unix//run/caddy.sock'}]:
            with self.assertRaises(ValueError): logs.active_config({'admin': admin})
        conn = mock.Mock()
        conn.getresponse.return_value.status = 302
        with mock.patch.object(logs.http.client, 'HTTPConnection', return_value=conn):
            with self.assertRaises(ValueError): logs.active_config({})
        conn.close.assert_called_once()

    def test_receipt_contains_only_sanitized_proof_and_hashes(self):
        fixture = {'fixture_verified': True, 'requests': 5}
        with mock.patch.object(logs, 'verify_fixture', return_value=(self.encoder, fixture)), \
             mock.patch.object(logs, 'adapt', return_value=self.config), \
             mock.patch.object(logs, 'active_config', return_value=self.config), \
             mock.patch.object(logs, 'run_caddy', return_value=b'v2.test'):
            receipt = logs.verify('/unused')
            self.assertEqual(receipt['result'], 'verified')
            self.assertTrue(receipt['active_global_verified'])
            self.assertEqual(len(receipt['active_config_sha256']), 64)
            self.assertNotIn('request>uri', json.dumps(receipt))
            self.assertNotIn('v2.test', json.dumps(receipt))
            self.assertEqual(receipt['caddy_version'], 'custom')

    def test_no_reload_explicitly_pending_and_never_reads_active(self):
        with mock.patch.object(logs, 'verify_fixture', return_value=(self.encoder, {})), \
             mock.patch.object(logs, 'adapt', return_value=self.config), \
             mock.patch.object(logs, 'active_config') as active, \
             mock.patch.object(logs, 'run_caddy', return_value=b'v2.test'):
            receipt = logs.verify('/unused', True)
            self.assertEqual(receipt['result'], 'pending_reload')
            self.assertFalse(receipt['active_global_verified'])
            active.assert_not_called()

    def test_active_failure_is_closed(self):
        with mock.patch.object(logs, 'verify_fixture', return_value=(self.encoder, {})), \
             mock.patch.object(logs, 'adapt', return_value=self.config), \
             mock.patch.object(logs, 'active_config', return_value={}), \
             mock.patch.object(logs, 'run_caddy', return_value=b'v2.test'):
            with self.assertRaises(ValueError): logs.verify('/unused')

    def test_child_cleanup_only_terminates_owned_child(self):
        child = mock.Mock()
        child.poll.return_value = None
        child.wait.side_effect = [logs.subprocess.TimeoutExpired('caddy', 3), 0]
        logs.stop_child(child)
        child.terminate.assert_called_once()
        child.kill.assert_called_once()
        self.assertEqual(child.wait.call_count, 2)

    def test_main_restores_files_and_reloads_original_after_failed_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'sites').mkdir()
            global_path = root / 'Caddyfile'
            site = root / 'sites' / 'dashboard.caddy'
            original = '{\n email admin@example.invalid\n}\n'
            original_site = '# ProxyPilot Admin Dashboard\nsite {\n log {\n output file /tmp/access\n }\n}\n'
            global_path.write_text(original)
            site.write_text(original_site)
            with mock.patch.object(logs.pathlib, 'Path', return_value=root), \
                 mock.patch.object(logs, 'safe_version', return_value=('v2.11.2', 'hash')), \
                 mock.patch.object(logs, 'verify', side_effect=ValueError('fail')), \
                 mock.patch.object(logs, 'run_caddy') as run, \
                 mock.patch.object(logs.sys, 'argv', ['script']):
                with self.assertRaises(ValueError): logs.main()
            self.assertEqual(global_path.read_text(), original)
            self.assertEqual(site.read_text(), original_site)
            self.assertEqual([c.args[0] for c in run.call_args_list], ['validate', 'reload', 'reload'])

    def test_idempotent_main_still_verifies_and_emits_one_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'sites').mkdir()
            (root / 'Caddyfile').write_text(logs.transform('{\n}\n', True))
            (root / 'sites' / 'dashboard').write_text(logs.transform('# ProxyPilot Admin Dashboard\ns {\n log {\n }\n}\n'))
            out = io.StringIO()
            with mock.patch.object(logs.pathlib, 'Path', return_value=root), \
                 mock.patch.object(logs, 'safe_version', return_value=('v2.11.2', 'hash')), \
                 mock.patch.object(logs, 'verify', return_value={'result': 'verified'}) as verify, \
                 mock.patch.object(logs, 'run_caddy') as run, contextlib.redirect_stdout(out):
                logs.main()
            verify.assert_called_once()
            run.assert_not_called()
            self.assertEqual(json.loads(out.getvalue()), {'result': 'verified'})

    def test_service_fixture_format_matches_actual_js_renderer(self):
        renderer = pathlib.Path(__file__).parents[2] / 'admin/backend/src/lib/caddy-site-file.js'
        if not renderer.is_file() or not shutil.which('node'):
            self.skipTest('Full repository and Node required for renderer parity check')
        result = logs.subprocess.run(['node', '--input-type=module', '-e',
            "import { siteAccessLogFilterLines } from " + json.dumps(renderer.as_uri()) +
            "; process.stdout.write(siteAccessLogFilterLines('').join('\\n'));"],
            capture_output=True, check=True, timeout=10)
        self.assertEqual(' '.join(result.stdout.decode().split()), ' '.join(logs.SERVICE_FORMAT.split()))

    def domain_config(self, mapping=None):
        domain = 'app.example.test'
        return {'logging': {'logs': {
            'default': {'encoder': copy.deepcopy(logs.GLOBAL_ENCODER), 'exclude': ['http.log.access']},
            'log0': {'encoder': copy.deepcopy(logs.SERVICE_ENCODER), 'include': ['http.log.access.log0'],
                     'writer': {'output': 'file', 'filename': '/var/log/caddy/' + domain + '.log'}}}},
            'apps': {'http': {'servers': {'srv0': {
                'logs': {'logger_names': mapping or {domain: ['log0']}},
                'routes': [{'match': [{'host': [domain]}], 'handle': [{'handler': 'reverse_proxy'}]}]
            }}}}}

    def test_domain_proof_exact_mapping_and_legacy_string(self):
        domain = 'app.example.test'
        for mapping in [{domain: ['log0']}, {domain: 'log0'}]:
            self.assertEqual(logs.prove_domain(self.domain_config(mapping), domain), ['log0'])

    def test_domain_proof_rejects_unfiltered_duplicate_access_sink(self):
        config = self.domain_config()
        config['logging']['logs']['bypass'] = {'encoder': {'format': 'json'}, 'include': ['http.log.access.log0']}
        with self.assertRaises(ValueError): logs.prove_domain(config, 'app.example.test')

    def test_domain_proof_rejects_missing_mapping_skip_and_dynamic_logging(self):
        variants = []
        config = self.domain_config()
        config['logging']['logs']['log0']['writer']['filename'] = '/wrong/file.log'
        variants.append(config)
        config = self.domain_config()
        config['apps']['http']['servers']['srv0']['logs'] = {}
        variants.append(config)
        config = self.domain_config()
        config['apps']['http']['servers']['srv0']['logs']['skip_hosts'] = ['*.example.test']
        variants.append(config)
        config = self.domain_config()
        config['apps']['http']['servers']['srv0']['routes'][0]['handle'].append({'handler': 'log_append', 'key': 'uri'})
        variants.append(config)
        config = self.domain_config()
        config['apps']['http']['servers']['srv0']['errors'] = {'routes': [{'handle': [{'handler': 'log_name'}]}]}
        variants.append(config)
        config = self.domain_config()
        config['apps']['http']['servers']['other'] = {'logs': {}, 'routes': [{'match': [{'host': ['app.example.test']}]}]}
        variants.append(config)
        for config in variants:
            with self.assertRaises(ValueError): logs.prove_domain(config, 'app.example.test')

    def test_disabled_access_logging_on_other_servers_is_safe(self):
        for with_null in (False, True):
            config = self.domain_config()
            other = {'routes': [{'handle': [{'handler': 'respond'}]}]}
            if with_null:
                other['logs'] = None
            config['apps']['http']['servers']['redirect'] = other
            self.assertEqual(logs.prove_domain(config, 'app.example.test'), ['log0'])
        config['apps']['http']['servers']['redirect']['logs'] = {}
        with self.assertRaises(ValueError):
            logs.prove_domain(config, 'app.example.test')

    def test_domain_proof_default_and_unique_wildcard_bindings(self):
        config = self.domain_config()
        settings = config['apps']['http']['servers']['srv0']['logs']
        settings['logger_names'] = {}
        settings['default_logger_name'] = 'log0'
        self.assertEqual(logs.prove_domain(config, 'app.example.test'), ['log0'])
        settings['skip_unmapped_hosts'] = True
        with self.assertRaises(ValueError): logs.prove_domain(config, 'app.example.test')
        settings['logger_names'] = {'*.example.test': 'log0'}
        self.assertEqual(logs.prove_domain(config, 'app.example.test'), ['log0'])

    def test_wildcard_mapped_server_is_checked_without_explicit_host_route(self):
        config = self.domain_config()
        config['apps']['http']['servers']['other'] = {
            'logs': {'logger_names': {'*.example.test': 'log1'}},
            'routes': [{'handle': [{'handler': 'respond'}]}]}
        with self.assertRaises(ValueError): logs.prove_domain(config, 'app.example.test')

    def test_domain_proof_rejects_direct_log_vars_and_named_route_invocation(self):
        for handler in [{'handler': 'vars', 'log_skip': True}, {'handler': 'invoke', 'name': 'indirect'}]:
            config = self.domain_config()
            config['apps']['http']['servers']['srv0']['routes'][0]['handle'].append(handler)
            with self.assertRaises(ValueError): logs.prove_domain(config, 'app.example.test')

    def test_catch_all_server_default_cannot_bypass_domain_proof(self):
        config = self.domain_config()
        config['apps']['http']['servers']['catchall'] = {
            'logs': {'logger_names': {}, 'default_logger_name': 'unfiltered'},
            'routes': [{'handle': [{'handler': 'reverse_proxy'}]}]}
        with self.assertRaises(ValueError): logs.prove_domain(config, 'app.example.test')
        config['apps']['http']['servers']['catchall']['routes'][0]['match'] = [{'host': ['other.example.test']}]
        self.assertEqual(logs.prove_domain(config, 'app.example.test'), ['log0'])

    def test_active_domain_cli_read_only_and_sanitized(self):
        config = self.domain_config()
        with mock.patch.object(logs, 'active_config', return_value=config), \
             mock.patch.object(logs, 'safe_version', return_value=('v2.11.2', 'hash')), \
             mock.patch.object(logs, 'verify_fixture') as fixture, \
             mock.patch.object(logs, 'main') as mutate:
            result = logs.active_proof('app.example.test')
            self.assertTrue(result['verified'])
            self.assertEqual(result['service']['loggerNames'], ['log0'])
            self.assertNotIn('filename', json.dumps(result))
            fixture.assert_not_called()
            mutate.assert_not_called()
        output = io.StringIO()
        with mock.patch.object(logs, 'active_proof', side_effect=ValueError('SECRET')), contextlib.redirect_stdout(output):
            self.assertEqual(logs.active_proof_cli(['app.example.test']), 1)
        self.assertNotIn('SECRET', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['code'], 'verification_failed')

    def test_domain_validation_and_topic_selection(self):
        for value in ['../secret', 'APP.example.test', 'host:443', '', 'x' * 254]:
            self.assertFalse(logs.valid_domain(value))
        self.assertTrue(logs.valid_domain('app.example.test'))
        self.assertTrue(logs.matches_host('APP.EXAMPLE.TEST', 'app.example.test'))
        self.assertTrue(logs.logger_selects({'include': ['http.log.access']}, 'http.log.access.log0'))
        self.assertFalse(logs.logger_selects({'include': ['http.log.access.log1']}, 'http.log.access.log0'))
        self.assertFalse(logs.logger_selects({'exclude': ['http.log.access']}, 'http.log.access.log0'))

    @unittest.skipUnless(shutil.which('caddy'), 'Caddy not installed; host fixture verification pending')
    def test_installed_caddy_integration(self):
        _encoder, receipt = logs.verify_fixture()
        self.assertTrue(receipt['fixture_verified'])
        self.assertEqual(receipt['requests'], 5)
        self.assertEqual(receipt['runtime_errors'], 2)

if __name__ == '__main__': unittest.main()


