import importlib.util
import base64
import hashlib
import io
import json
import shutil
from pathlib import Path
import unittest
from unittest.mock import patch
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('proxy', root / 'a3-origin-proxy.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
spec2 = importlib.util.spec_from_file_location('proxy_install', root / 'a3-install-proxy.py')
i = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(i)
spec3 = importlib.util.spec_from_file_location('proxy_probe', root / 'a3-probe-proxy.py')
probe = importlib.util.module_from_spec(spec3)
spec3.loader.exec_module(probe)


class OriginPolicyTests(unittest.TestCase):
    def headers(self):
        return {'host': 'demo.fractionate.ai'}

    def test_fixed_allowed_paths(self):
        for path in ['/', '/workspace', '/api/config', '/api/session', '/api/files',
                     '/assets/app-1.css']:
            with self.subTest(path=path):
                self.assertTrue(p.permitted('GET', path, self.headers()))
        self.assertTrue(p.permitted('POST', '/api/logout', self.headers() | {'content-length': '0'}))

    def test_a4_sign_in_is_the_only_post_with_a_body(self):
        json_headers = self.headers() | {'content-type': 'application/json', 'content-length': '64'}
        self.assertTrue(p.permitted('POST', '/api/login', json_headers))
        self.assertTrue(p.permitted('POST', '/api/login', json_headers | {'content-type': 'Application/JSON; charset=UTF-8'}))
        self.assertTrue(p.permitted('POST', '/api/login', json_headers | {'content-length': '1024'}))
        self.assertEqual(p.login_length(json_headers), 64)
        for change in ({'content-length': '0'}, {'content-length': '1025'}, {'content-length': '01'},
                       {'content-length': '-1'}, {'content-length': '1e3'}, {'content-type': 'text/plain'},
                       {'content-type': 'application/json; charset=latin-1'}, {'content-type': ''},
                       {'transfer-encoding': 'chunked'}, {'expect': '100-continue'}, {'host': 'outside.invalid'},
                       {'upgrade': 'websocket'}):
            with self.subTest(change=change):
                self.assertFalse(p.permitted('POST', '/api/login', json_headers | change))
        self.assertFalse(p.permitted('POST', '/api/login', {k: v for k, v in json_headers.items() if k != 'content-length'}))
        for method, target in (('POST', '/api/login?next=/'), ('POST', '/api/login?'), ('POST', '/api/login#x'),
                               ('POST', '/api/login/'), ('POST', '/API/login'), ('POST', '/api/session'),
                               ('POST', '/api/files'), ('POST', '/'), ('POST', '/workspace'), ('PUT', '/api/login'),
                               ('PATCH', '/api/login'), ('GET', '/api/login'), ('GET', '/workspace?'),
                               ('POST', '/api/logout?')):
            with self.subTest(method=method, target=target):
                self.assertFalse(p.permitted(method, target, json_headers))
        self.assertFalse(p.permitted('POST', '/api/logout', json_headers))

    def test_origin_methods_paths_and_bypasses_denied(self):
        cases = [('GET', '/', {'host': 'outside.invalid'}),
                 ('GET', '/', {'host': 'demo.fractionate.ai:443'}),
                 ('GET', '//outside.invalid/x', self.headers()),
                 ('GET', 'https://outside.invalid/', self.headers()),
                 ('GET', '/workspace?next=outside', self.headers()),
                 ('GET', '/assets/%2e%2e/admin', self.headers()),
                 ('GET', '/assets/app/x.js', self.headers()),
                 ('GET', '/api/login', self.headers()),
                 ('POST', '/api/session', self.headers()),
                 ('POST', '/api/logout', self.headers() | {'content-length': '1'}),
                 ('DELETE', '/', self.headers()),
                 ('GET', '/', self.headers() | {'upgrade': 'websocket'}),
                 ('GET', '/', self.headers() | {'connection': 'keep-alive, Upgrade'}),
                 ('GET', '/', self.headers() | {'transfer-encoding': 'chunked'}),
                 ('GET', '/', self.headers() | {'proxy-authorization': 'Basic x'})]
        for method, path, headers in cases:
            with self.subTest(method=method, path=path, headers=headers):
                self.assertFalse(p.permitted(method, path, headers))

    def test_redirects_only_same_origin(self):
        for location in ['/', '/workspace', 'https://demo.fractionate.ai/workspace']:
            self.assertTrue(p.valid_location(location))
        for location in ['', '//outside.invalid', 'http://demo.fractionate.ai/',
                         'https://outside.invalid/', 'https://demo.fractionate.ai.evil/',
                         '/workspace?to=outside', 'javascript:alert(1)', '/x\r\ny']:
            with self.subTest(location=location):
                self.assertFalse(p.valid_location(location))

    def test_http_parser_rejects_duplicate_and_folded_headers(self):
        for raw in [b'GET / HTTP/1.1\r\nHost: demo.fractionate.ai\r\n\r\n',
                    b'POST /api/logout HTTP/1.1\r\nHost: demo.fractionate.ai\r\nContent-Length: 0\r\n\r\n']:
            method, path, headers = p.read_request(io.BytesIO(raw))
            self.assertTrue(p.permitted(method, path, headers))
        for raw in [b'GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n',
                    b'GET / HTTP/1.1\r\nHost: a\r\n  b\r\n\r\n',
                    b'GET / HTTP/2.0\r\n\r\n',
                    b'GET / HTTP/1.1\r\nX_Bad: y\r\n\r\n']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                p.read_request(io.BytesIO(raw))

    def test_dns_rebinding_to_private_or_management_refused(self):
        p.forget_addresses()
        with patch.object(p.socket, 'getaddrinfo', return_value=[
            (p.socket.AF_INET, p.socket.SOCK_STREAM, 6, '', ('10.185.17.1', 443)),
            (p.socket.AF_INET, p.socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaisesRegex(ValueError, 'no public address'):
                p.public_addresses()

    def test_the_origin_is_looked_up_at_most_once_a_minute_and_failures_are_not_kept(self):
        # Some DNS lookups on the proof host take 1-2.5 s; one per request could
        # exceed the runner's 10 s page-load wait.
        p.forget_addresses()
        public = [(p.socket.AF_INET, p.socket.SOCK_STREAM, 6, '', ('96.88.158.118', 443))]
        now = [1000.0]
        clock = lambda: now[0]
        with patch.object(p.socket, 'getaddrinfo', return_value=public) as lookup:
            self.assertEqual(p.public_addresses(clock), [(p.socket.AF_INET, '96.88.158.118')])
            now[0] += 59
            p.public_addresses(clock)
            self.assertEqual(lookup.call_count, 1)
            now[0] += 2
            p.public_addresses(clock)
            self.assertEqual(lookup.call_count, 2)
            p.forget_addresses()
            p.public_addresses(clock)
            self.assertEqual(lookup.call_count, 3)
        p.forget_addresses()
        with patch.object(p.socket, 'getaddrinfo', side_effect=p.socket.gaierror('temporary failure')):
            with self.assertRaises(OSError):
                p.public_addresses(clock)
        with patch.object(p.socket, 'getaddrinfo', return_value=[
                (p.socket.AF_INET, p.socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaisesRegex(ValueError, 'no public address'):
                p.public_addresses(clock)
        with patch.object(p.socket, 'getaddrinfo', return_value=public) as lookup:
            p.public_addresses(clock)
            self.assertEqual(lookup.call_count, 1, 'a failed or refused lookup was cached')
        p.forget_addresses()

    def test_installer_does_not_write_when_fence_missing(self):
        with patch.object(i.i, 'status', side_effect=ValueError('missing fence')), \
                patch.object(i.i, 'save') as save, patch.object(i.i, 'execute') as execute:
            with self.assertRaises(ValueError):
                i.install()
            save.assert_not_called()
            execute.assert_not_called()

    def run_install(self, root, journal_data):
        """install() end to end on temp paths: real openssl and real journal writes."""
        paths = {name: root / name for name in ('script', 'cert', 'key', 'unit')}
        journal = root / 'proxy-install.json'
        if journal_data is not None:
            journal.write_text(json.dumps(journal_data, indent=2) + '\n')
        commands = []

        def execute(argv, **options):
            commands.append(argv)
            return ''
        with patch.object(i, 'INSTALLED', paths['script']), patch.object(i, 'CERT', paths['cert']), \
                patch.object(i, 'KEY', paths['key']), patch.object(i, 'UNIT', paths['unit']), \
                patch.object(i, 'JOURNAL', journal), patch.object(i, 'validate_target', return_value={}), \
                patch.object(i, 'status', return_value={'installed': True}), \
                patch.object(i.p, 'LISTEN', ('127.0.0.1', 0)), \
                patch.object(i.i, 'secure'), patch.object(i.i, 'execute', side_effect=execute):
            result = i.install()
        return result, journal, paths, commands

    @unittest.skipUnless(shutil.which('openssl'), 'openssl is required to issue the proxy certificate')
    def test_install_after_a_completed_removal_reissues_instead_of_refusing(self):
        # The first host reinstall stopped here: "Refusing to replace unrelated file:
        # .../proxy-install.json" after remove() had left phase `removed`.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            removed = {'version': 1, 'phase': 'removed', 'vm_uuid': i.i.fence.PROOF_UUID,
                       'files': {'/etc/proxypilot-a3-proof/origin-proxy.py': 'a' * 64}}
            result, journal, paths, commands = self.run_install(root, removed)
            self.assertEqual(result, {'installed': True})
            data = json.loads(journal.read_text())
            self.assertEqual((data['phase'], data['vm_uuid']), ('installed', i.i.fence.PROOF_UUID))
            self.assertEqual(set(data['files']), {str(path) for path in paths.values()})
            for path in paths.values():
                self.assertEqual(i.i.digest(path.read_text()), data['files'][str(path)])
            self.assertIn('BEGIN CERTIFICATE', paths['cert'].read_text())
            self.assertIn(['systemctl', 'enable', '--now', paths['unit'].name], commands)
        # A fresh host (no journal) installs as before.
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(self.run_install(Path(temp), None)[0], {'installed': True})
        # Anything but a completed removal still needs review, and nothing is replaced.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            prepared = {'version': 1, 'phase': 'prepared', 'files': {}}
            with self.assertRaisesRegex(ValueError, 'review journal'):
                self.run_install(root, prepared)
            self.assertEqual(json.loads((root / 'proxy-install.json').read_text()), prepared)

    def test_reinstall_skips_removal_when_the_proxy_is_already_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            journal = Path(temp) / 'proxy-install.json'
            for phase, removes in (('removed', False), ('installed', True)):
                journal.write_text(json.dumps({'version': 1, 'phase': phase}))
                with patch.object(i, 'JOURNAL', journal), \
                        patch.object(i, 'remove', return_value={'removed': True}) as remove, \
                        patch.object(i, 'install', return_value={'installed': True}):
                    result = i.reinstall()
                self.assertEqual(remove.called, removes)
                self.assertEqual(result['previous_removed'], {'removed': True} if removes else None)

    def test_removal_does_not_require_a_certificate_that_is_about_to_expire(self):
        with patch.object(i, 'status') as status, patch.object(i.i, 'parse_json', side_effect=ValueError('stop')), \
                patch.object(i, 'JOURNAL') as journal:
            journal.read_text.return_value = '{}'
            with self.assertRaises(ValueError):
                i.remove()
            status.assert_called_once_with(check_certificate=False)

    def test_proxy_unit_requires_installed_fence(self):
        self.assertIn('Requires=proxypilot-a3-fence.service', i.UNIT_TEXT)
        self.assertIn('After=proxypilot-a3-fence.service', i.UNIT_TEXT)
        self.assertIn('ProtectSystem=strict', i.UNIT_TEXT)
        self.assertIn('ExecStart=/usr/bin/python3 /etc/proxypilot-a3-proof/origin-proxy.py --serve', i.UNIT_TEXT)

    def test_removal_disables_owned_proxy_before_unlinking_files(self):
        with tempfile.TemporaryDirectory() as temp:
            paths = [Path(temp) / name for name in ('script', 'cert', 'key', 'unit')]
            for path in paths:
                path.write_text(path.name)
            data = {'version': 1, 'phase': 'installed',
                    'files': {str(path): i.i.digest(path.read_text()) for path in paths}}
            commands = []
            def execute(argv):
                if argv[1] == 'disable':
                    self.assertTrue(all(path.exists() for path in paths))
                commands.append(argv)
                return ''
            with patch.object(i, 'INSTALLED', paths[0]), patch.object(i, 'CERT', paths[1]), \
                    patch.object(i, 'KEY', paths[2]), patch.object(i, 'UNIT', paths[3]), \
                    patch.object(i, 'JOURNAL', Path(temp) / 'journal'), \
                    patch.object(i, 'status', return_value={'installed': True}), \
                    patch.object(i.i, 'secure'), patch.object(i.i, 'execute', side_effect=execute), \
                    patch.object(i.i, 'save') as save:
                (Path(temp) / 'journal').write_text(json.dumps(data))
                self.assertTrue(i.remove()['fence_retained'])
                self.assertEqual(commands[0], ['systemctl', 'disable', '--now', 'unit'])
                self.assertEqual(commands[1], ['systemctl', 'daemon-reload'])
                self.assertTrue(all(not path.exists() for path in paths))
                self.assertEqual(json.loads(save.call_args.args[1])['phase'], 'removed')

    def test_live_probe_requires_every_expected_positive_and_negative(self):
        report = {'boot_id': 'boot', 'cases': [
            {'case': name, 'status': 'HTTP/1.1 ' + code + ' test', 'origin_answered': bool(answered)}
            for name, code, answered in probe.EXPECTED]}
        codes = probe.evaluate(report)
        self.assertEqual(codes[:7], ['403', '403', '200', '200', '403', '403', '403'])
        # Exactly three answers reach the origin in A4: two A3 GETs and one bounded
        # sign-in POST, plus the empty logout; everything else is the proxy's 403.
        self.assertEqual([name for name, code, answered in probe.EXPECTED if answered],
                         ['request_/_demo.fractionate.ai', 'request_/api/session_demo.fractionate.ai',
                          'login_json_reaches_origin', 'logout_empty_reaches_origin'])
        with self.assertRaises(ValueError):
            probe.evaluate(report | {'cases': report['cases'][:-1]})
        for index in (5, 7, 8):
            changed = json.loads(json.dumps(report))
            changed['cases'][index]['status'] = 'HTTP/1.1 200 unexpected'
            with self.assertRaises(ValueError):
                probe.evaluate(changed)
        # A 403 that the ORIGIN produced is not a proxy refusal.
        changed = json.loads(json.dumps(report))
        changed['cases'][9]['origin_answered'] = True
        with self.assertRaisesRegex(ValueError, 'mismatch at login_no_content_type'):
            probe.evaluate(changed)
        changed = json.loads(json.dumps(report))
        changed['cases'][5]['status'] = ''
        with self.assertRaisesRegex(ValueError, 'Malformed proxy response for request_/_outside.invalid'):
            probe.evaluate(changed)
        compile(probe.GUEST, 'fixed-guest-proxy-probe', 'exec')

    def test_proxy_probe_hashes_the_certificate_wire_encoding(self):
        der = b'\x30\x03\x02\x01\x01'
        pem = '-----BEGIN CERTIFICATE-----\n' + base64.b64encode(der).decode() + \
              '\n-----END CERTIFICATE-----\n'
        with tempfile.TemporaryDirectory() as temp:
            cert = Path(temp) / 'cert.pem'
            cert.write_text(pem)
            self.assertEqual(probe.certificate_der_sha256(cert), hashlib.sha256(der).hexdigest())
            self.assertNotEqual(probe.certificate_der_sha256(cert),
                                hashlib.sha256(cert.read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()


REAL_RUN = subprocess.run


@unittest.skipUnless(shutil.which('openssl'), 'openssl is required to issue the proxy certificate')
class CertificateRenewalTests(unittest.TestCase):
    """`renew` re-issues the proxy's self-signed certificate in place, with real
    openssl and real journal writes; only systemctl and the VM are stubbed."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.commands = []
        self.vm_status = 'Running'
        self.paths = {name: self.root / name for name in ('script', 'cert', 'key', 'unit')}
        self.journal = self.root / 'proxy-install.json'
        self.patches = [patch.object(i, 'INSTALLED', self.paths['script']), patch.object(i, 'CERT', self.paths['cert']),
                        patch.object(i, 'KEY', self.paths['key']), patch.object(i, 'UNIT', self.paths['unit']),
                        patch.object(i, 'JOURNAL', self.journal), patch.object(i, 'validate_target', return_value={}),
                        patch.object(i.p, 'LISTEN', ('127.0.0.1', 0)), patch.object(i.i, 'secure'),
                        patch.object(i.i, 'execute', side_effect=self.execute),
                        patch.object(i.i, 'status', side_effect=lambda: {'vm_status': self.vm_status})]
        for item in self.patches:
            item.start()
        # An installed proxy exactly as install() leaves it.
        with patch.object(i, 'status', return_value={'installed': True}):
            i.install()
        self.commands.clear()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def execute(self, argv, **options):
        if argv[0] == 'openssl':
            return REAL_RUN(argv, check=True, capture_output=True, text=True, **options).stdout
        self.commands.append(argv)
        return ''

    def snapshot(self):
        return {name: path.read_text() for name, path in self.paths.items()}, json.loads(self.journal.read_text())

    def renew(self, **options):
        with patch.object(i, 'status', side_effect=lambda check_certificate=True: {'installed': True}):
            return i.renew(**options)

    def test_a_fresh_certificate_is_not_renewed(self):
        before = self.snapshot()
        result = self.renew(attempt=lambda: None)
        self.assertEqual((result['renewed'], result['reason']), (False, 'not_due'))
        self.assertEqual(result['renew_within_seconds'], 3 * 86400)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.commands, [])

    def test_a_due_certificate_is_reissued_in_place_and_the_proxy_restarted(self):
        before_files, before_journal = self.snapshot()
        previous = i.spki(self.paths['cert'])
        with patch.object(i, 'RENEW_BEFORE', 8 * 86400):   # a 7-day certificate is now inside the window
            result = self.renew(attempt=lambda: None)
        after_files, journal = self.snapshot()
        self.assertTrue(result['renewed'])
        self.assertEqual(result['previous_spki_sha256'], previous)
        self.assertNotEqual(i.spki(self.paths['cert']), previous)
        self.assertNotEqual(after_files['cert'], before_files['cert'])
        self.assertNotEqual(after_files['key'], before_files['key'])
        # Source and unit untouched; the journal records exactly the new pair.
        self.assertEqual((after_files['script'], after_files['unit']), (before_files['script'], before_files['unit']))
        self.assertNotIn('renewal', journal)
        self.assertEqual(journal['phase'], 'installed')
        for name, path in self.paths.items():
            self.assertEqual(journal['files'][str(path)], i.i.digest(after_files[name]))
        self.assertEqual(oct(self.paths['key'].stat().st_mode & 0o777), '0o600')
        self.assertEqual(self.commands, [['systemctl', 'restart', self.paths['unit'].name]])
        self.assertFalse(i.certificate_due())
        self.assertEqual(REAL_RUN(['openssl', 'x509', '-in', str(self.paths['cert']), '-noout', '-subject'],
                                  capture_output=True, text=True).stdout.strip().replace(' ', ''),
                         'subject=CN=demo.fractionate.ai')

    def test_nothing_changes_while_an_attempt_is_live_or_the_vm_is_stopped(self):
        before = self.snapshot()
        result = self.renew(force=True, attempt=lambda: {'attempt_id': 'a1'})
        self.assertEqual((result['renewed'], result['reason'], result['attempt_id']), (False, 'attempt_live', 'a1'))
        self.vm_status = 'Stopped'
        self.assertEqual(self.renew(force=True, attempt=lambda: None), {'renewed': False, 'reason': 'vm_not_running'})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.commands, [])

    def test_an_interrupted_renewal_is_finished_and_tampering_is_refused(self):
        _, journal = self.snapshot()
        # Crash after the journal recorded the new pair and only the key was written.
        with tempfile.TemporaryDirectory() as temp:
            key, cert = i.issue_certificate(Path(temp))
        journal['renewal'] = {str(self.paths['cert']): i.i.digest(cert), str(self.paths['key']): i.i.digest(key)}
        self.journal.write_text(json.dumps(journal))
        self.paths['key'].write_text(key)
        result = self.renew(attempt=lambda: None)   # not forced: a pending renewal always completes
        self.assertTrue(result['renewed'])
        files, done = self.snapshot()
        self.assertNotIn('renewal', done)
        for name, path in self.paths.items():
            self.assertEqual(done['files'][str(path)], i.i.digest(files[name]))
        # A certificate that is neither the recorded one nor the pending one is refused, untouched.
        done['renewal'] = {str(self.paths['cert']): 'a' * 64, str(self.paths['key']): 'b' * 64}
        self.journal.write_text(json.dumps(done))
        self.paths['cert'].write_text(cert)
        with self.assertRaisesRegex(ValueError, 'outside a renewal'):
            self.renew(attempt=lambda: None)
        self.assertEqual(self.paths['cert'].read_text(), cert)

    def test_live_attempt_reads_the_supervisor_operator_socket(self):
        import socket as socket_module
        import threading
        self.assertIsNone(i.live_attempt(self.root / 'absent.sock'))
        path = self.root / 'operator.sock'
        for reply, expected in (({'ok': True, 'result': {'active': {'attempt_id': 'a2'}}}, {'attempt_id': 'a2'}),
                                ({'ok': True, 'result': {'active': None}}, None),
                                ({'ok': False, 'error': 'X'}, ValueError)):
            server = socket_module.socket(socket_module.AF_UNIX)
            server.bind(str(path))
            server.listen(1)

            def answer():
                conn, _ = server.accept()
                request = json.loads(conn.makefile().readline())
                assert request == {'method': 'status', 'params': {}}, request
                conn.sendall((json.dumps(reply) + '\n').encode())
                conn.close()
            thread = threading.Thread(target=answer)
            thread.start()
            try:
                if expected is ValueError:
                    with self.assertRaises(ValueError):
                        i.live_attempt(path)
                else:
                    self.assertEqual(i.live_attempt(path), expected)
            finally:
                thread.join()
                server.close()
                path.unlink()
