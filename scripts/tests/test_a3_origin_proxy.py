import importlib.util
import base64
import hashlib
import io
import json
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
        with patch.object(p.socket, 'getaddrinfo', return_value=[
            (p.socket.AF_INET, p.socket.SOCK_STREAM, 6, '', ('10.185.17.1', 443)),
            (p.socket.AF_INET, p.socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaisesRegex(ValueError, 'no public address'):
                p.public_addresses()

    def test_installer_does_not_write_when_fence_missing(self):
        with patch.object(i.i, 'status', side_effect=ValueError('missing fence')), \
                patch.object(i.i, 'save') as save, patch.object(i.i, 'execute') as execute:
            with self.assertRaises(ValueError):
                i.install()
            save.assert_not_called()
            execute.assert_not_called()

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

    def test_live_probe_requires_two_positive_and_five_negative_results(self):
        report = {'boot_id': 'boot', 'cases': [{'status': 'HTTP/1.1 ' + code + ' test'}
                  for code in ('403', '403', '200', '200', '403', '403', '403')]}
        self.assertEqual(probe.evaluate(report), ['403', '403', '200', '200', '403', '403', '403'])
        with self.assertRaises(ValueError):
            probe.evaluate(report | {'cases': report['cases'][:-1]})
        changed = json.loads(json.dumps(report))
        changed['cases'][5]['status'] = 'HTTP/1.1 200 unexpected'
        with self.assertRaises(ValueError):
            probe.evaluate(changed)
        changed['cases'][5]['status'] = ''
        changed['cases'][5]['case'] = 'request_/api/login_demo.fractionate.ai'
        with self.assertRaisesRegex(ValueError, 'Malformed proxy response for request_/api/login'):
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
