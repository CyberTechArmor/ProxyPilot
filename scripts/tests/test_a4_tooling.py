"""A4 host tooling: broker installer, operator CLI and the fixture-account tool."""
import argparse
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load('a4_installer', 'a4-install-broker.py')
operator = load('a4_operator', 'a4-broker-operator.py')
fixture = load('a4_fixture', 'a4-fixture-account.py')
SECRET = 'A4-canary-Zt8pQ3wLm2Vx'
UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
         '33333333-3333-4333-8333-333333333333']


class InstallerTests(unittest.TestCase):
    def test_unit_runs_only_the_installed_copy_as_root_with_a_private_runtime_dir(self):
        self.assertIn('ExecStart=/usr/bin/python3 -I /etc/proxypilot-a4/broker/a4-credential-broker.py --serve',
                      installer.UNIT_TEXT)
        for line in ('RuntimeDirectory=proxypilot-a4', 'RuntimeDirectoryMode=0700', 'NoNewPrivileges=yes',
                     'ProtectSystem=full', 'UMask=0077'):
            self.assertIn(line, installer.UNIT_TEXT)
        self.assertNotIn('/home/', installer.UNIT_TEXT)
        self.assertNotIn('candidate', installer.UNIT_TEXT)
        files = installer.plan_files()
        self.assertEqual(set(files), {installer.TARGET, installer.UNIT})
        self.assertEqual(files[installer.TARGET], (ROOT / 'a4-credential-broker.py').read_bytes())
        with tempfile.TemporaryDirectory() as temp:
            bad = Path(temp) / 'broker.py'
            bad.write_text('print(1)\n')
            with self.assertRaises(ValueError):
                installer.plan_files(bad)

    def test_configure_prompts_without_echo_validates_and_writes_0600(self):
        answers = iter(['role-123', 'secret-456'])
        prompts = []

        def prompt(text):
            prompts.append(text)
            return next(answers)
        config = installer.build_config('http://127.0.0.1:18200', 'pp-approle', 'pp-kv', 'a4-broker', prompt)
        self.assertEqual((config['role_id'], config['secret_id']), ('role-123', 'secret-456'))
        self.assertEqual(len(prompts), 2)
        with self.assertRaises(installer.broker.Refused):
            installer.build_config('http://10.0.0.5:18200', 'pp-approle', 'pp-kv', 'a4-broker', lambda _: 'x')
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'broker-config.json'
            args = argparse.Namespace(address='http://127.0.0.1:18200', approle_mount='pp-approle', kv_mount='pp-kv',
                                      agent='a4-broker')
            answers = iter(['role-123', 'secret-456'])
            with patch.object(installer.broker, 'CONFIG', target), patch.object(installer.broker, 'secure', lambda p: None), \
                    patch.object(installer.broker.Vault, '_token', lambda self: 'tok'), \
                    patch.object(installer.getpass, 'getpass', lambda _: next(answers)):
                result = installer.configure(args)
            self.assertEqual(oct(target.stat().st_mode & 0o777), '0o600')
            self.assertNotIn('secret-456', json.dumps(result))
            self.assertEqual(json.loads(target.read_text())['secret_id'], 'secret-456')
            answers = iter(['role-123', 'wrong'])

            def refuse(self):
                raise installer.broker.Refused('VAULT_UNAVAILABLE')
            target.unlink()
            with patch.object(installer.broker, 'CONFIG', target), patch.object(installer.broker, 'secure', lambda p: None), \
                    patch.object(installer.broker.Vault, '_token', refuse), \
                    patch.object(installer.getpass, 'getpass', lambda _: next(answers)):
                with self.assertRaisesRegex(ValueError, 'nothing was written'):
                    installer.configure(args)
            self.assertFalse(target.exists())


class OperatorTests(unittest.TestCase):
    def parse(self, *argv):
        return operator.request(operator.parser().parse_args(list(argv)))

    def test_commands_map_to_typed_requests_and_take_no_value(self):
        self.assertEqual(self.parse('bind', '--binding', UUIDS[0], '--project', UUIDS[1], '--profile', UUIDS[2],
                                    '--username', 'a4-fixture@demo.fractionate.ai', '--vault-key', 'a4-fixture-password'),
                         ('bind', {'binding_id': UUIDS[0], 'project_id': UUIDS[1], 'profile_id': UUIDS[2],
                                   'username': 'a4-fixture@demo.fractionate.ai', 'vault_key': 'a4-fixture-password'}))
        self.assertEqual(self.parse('rotate', '--binding', UUIDS[0], '--expected-revision', '1'),
                         ('rotate', {'binding_id': UUIDS[0], 'expected_revision': 1}))
        self.assertEqual(self.parse('revoke', '--binding', UUIDS[0]), ('revoke', {'binding_id': UUIDS[0]}))
        self.assertEqual(self.parse('provider', '--vault-key', 'openai-api-key'),
                         ('provider_bind', {'vault_key': 'openai-api-key'}))
        self.assertEqual(self.parse('price', 'set', '--model', 'gpt-6-luna', '--input', '0.10', '--cached-input', '0.01',
                                    '--cache-write', '0.125', '--output', '0.50'),
                         ('price_set', {'model': 'gpt-6-luna', 'input': '0.10', 'cached_input': '0.01',
                                        'cache_write': '0.125', 'output': '0.50'}))
        self.assertEqual(self.parse('ledger'), ('ledger', {}))
        text = (ROOT / 'a4-broker-operator.py').read_text()
        for word in ('--value', '--password', '--secret', 'getpass'):
            self.assertNotIn(word, text)

    def test_call_speaks_the_broker_socket_protocol(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 's.sock'
            server = socket.socket(socket.AF_UNIX)
            server.bind(str(path))
            server.listen(1)

            def answer():
                conn, _ = server.accept()
                request = json.loads(conn.makefile().readline())
                conn.sendall((json.dumps({'ok': False, 'error': 'BINDING_REVOKED', 'echo': request}) + '\n').encode())
                conn.close()
            import threading
            thread = threading.Thread(target=answer)
            thread.start()
            with self.assertRaises(operator.CallFailed) as caught:
                operator.call('revoke', {'binding_id': UUIDS[0]}, path=path)
            thread.join()
            server.close()
            self.assertEqual(caught.exception.code, 'BINDING_REVOKED')
            self.assertEqual(caught.exception.reply['echo'], {'method': 'revoke', 'params': {'binding_id': UUIDS[0]}})


class FakeBroker:
    def __init__(self):
        self.handed = []

    def bound_value(self, binding_id):
        value = bytearray(SECRET.encode())
        self.handed.append(value)
        return ({'username': 'a4-fixture@demo.fractionate.ai', 'revision': 3,
                 'vault': {'version': 5}}, value)

    @staticmethod
    def wipe(buffer):
        buffer[:] = b'\0' * len(buffer)


class FixtureTests(unittest.TestCase):
    def test_provision_pushes_only_an_scrypt_verifier_and_wipes_the_value(self):
        pushed = []
        broker = FakeBroker()
        with patch.object(fixture, 'push', lambda data, path, instance='x', mode='0644': pushed.append((data, path))):
            result = fixture.provision(UUIDS[0], broker=broker)
        data, path = pushed[0]
        self.assertEqual(path, '/opt/app/demo/synthetic-account.json')
        document = json.loads(data)
        self.assertEqual(document['email'], 'a4-fixture@demo.fractionate.ai')
        k = document['scrypt']
        derived = hashlib.scrypt(SECRET.encode(), salt=base64.b64decode(k['salt']), n=k['N'], r=k['r'], p=k['p'],
                                 dklen=k['dklen'], maxmem=128 * 1024 * 1024)
        self.assertEqual(base64.b64decode(k['hash']), derived)
        for text in (data.decode(), json.dumps(result)):
            self.assertNotIn(SECRET, text)
            self.assertNotIn(base64.b64encode(SECRET.encode()).decode(), text)
            self.assertNotIn(hashlib.sha256(SECRET.encode()).hexdigest(), text)
        self.assertEqual(broker.handed[0], bytearray(len(SECRET)))
        self.assertEqual((result['binding_revision'], result['vault_version']), (3, 5))

    @unittest.skipUnless(shutil.which('node') and (ROOT.parent / 'admin' / 'frontend' / 'dist-demo' / 'index.html').exists(),
                         'node and a built demo (npm run demo:build) are required for the cross-language check')
    def test_the_demo_server_accepts_the_python_verifier(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'synthetic-account.json'
            path.write_text(fixture.verifier('a4-fixture@demo.fractionate.ai', bytearray(SECRET.encode())))
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            origin = 'http://127.0.0.1:%d' % port
            env = dict(os.environ, DEMO_PORT=str(port), DEMO_PUBLIC_ORIGIN=origin,
                       DEMO_SYNTHETIC_ACCOUNT_FILE=str(path))
            server = subprocess.Popen(['node', str(fixture.REVIEWED_SERVER)], env=env, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE)
            try:
                server.stdout.readline()

                def login(password):
                    request = urllib.request.Request(origin + '/api/login', method='POST', data=json.dumps(
                        {'email': 'a4-fixture@demo.fractionate.ai', 'password': password}).encode(),
                        headers={'Content-Type': 'application/json', 'Origin': origin})
                    try:
                        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as r:
                            return r.status, json.loads(r.read())
                    except urllib.error.HTTPError as error:
                        return error.code, None
                self.assertEqual(login(SECRET), (200, {'authenticated': True, 'email': 'a4-fixture@demo.fractionate.ai'}))
                self.assertEqual(login(SECRET + 'x')[0], 401)
            finally:
                server.kill()
                server.wait(10)
                server.stdout.close()
                server.stderr.close()


if __name__ == '__main__':
    unittest.main()
