import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


inst = load('supervisor_installer', 'a3-install-supervisor.py')
op = load('worker_operator', 'a3-worker-operator.py')
probe = load('worker_probe', 'a3-probe-worker.py')
REAL_RUN = subprocess.run


@unittest.skipUnless(shutil.which('openssl'), 'openssl is required for the receipt key')
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.paths = {'TARGET': root / 'etc' / 'supervisor', 'UNIT': root / 'systemd' / 'proxypilot-a3-supervisor.service',
                      'KEY': root / 'etc' / 'supervisor-key.pem', 'PUBLIC_KEY': root / 'etc' / 'supervisor-pub.pem',
                      'JOURNAL': root / 'state' / 'supervisor-install.json', 'STATE_DIR': root / 'state' / 'supervisor',
                      'KEY_ARCHIVE': root / 'state' / 'supervisor-keys'}
        self.commands = []
        self.active = False
        self.fail_enable = False
        self.status_active = None
        self.patches = [patch.object(inst, name, value) for name, value in self.paths.items()]
        self.patches += [patch.object(inst.i, 'secure', lambda path: None),
                         patch.object(inst.proxy, 'status', lambda: {'installed': True}),
                         patch.object(inst.i, 'execute', self.execute),
                         patch.object(inst.subprocess, "run", self.fake_run),
                         patch.object(inst, 'call', self.call),
                         patch.object(inst.time, 'sleep', lambda _: None)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    def execute(self, argv, **options):
        self.commands.append(argv)
        if argv[0] == 'openssl':
            return REAL_RUN(argv, check=True, capture_output=True, text=True, **options).stdout
        if argv[:2] == ['systemctl', 'enable']:
            if self.fail_enable:
                raise subprocess.CalledProcessError(1, argv, stderr='enable failed')
            self.active = True
        if argv[:2] == ['systemctl', 'disable']:
            self.active = False
        if argv[:2] == ['systemctl', 'show']:
            prop = argv[3].split('=', 1)[1]
            return {'FragmentPath': str(inst.UNIT), 'DropInPaths': '', 'NeedDaemonReload': 'no',
                    'Requires': 'proxypilot-a3-fence.service system.slice',
                    'After': 'proxypilot-a3-fence.service proxypilot-a3-origin-proxy.service'}[prop] + '\n'
        if argv[:2] == ['systemctl', 'is-active'] and not self.active:
            raise subprocess.CalledProcessError(3, argv, stderr='inactive')
        return ''

    def fake_run(self, argv, **options):
        if argv[0] == 'systemctl':
            self.commands.append(argv)
            return subprocess.CompletedProcess(argv, 0 if (argv[1] == 'is-active' and self.active) else 3, b'', b'')
        return REAL_RUN(argv, **options)

    def call(self, method, params=None, **options):
        kid = json.loads(inst.JOURNAL.read_text())['key_id']
        return {'ok': True, 'result': {'supervisor': {'key_id': kid}, 'accepting_launch': True, 'blockers': [],
                                       'active': self.status_active, 'boundary': {'vm_uuid': inst.i.fence.PROOF_UUID}}}

    def test_install_records_exact_files_then_activates_and_reads_back(self):
        result = inst.install()
        journal = json.loads(inst.JOURNAL.read_text())
        self.assertEqual(journal['phase'], 'installed')
        for name in inst.SOURCES:
            installed = inst.TARGET / name
            self.assertEqual(installed.read_bytes(), (ROOT / name).read_bytes())
            self.assertEqual(journal['files'][str(installed)], hashlib.sha256(installed.read_bytes()).hexdigest())
        self.assertEqual(oct(inst.KEY.stat().st_mode & 0o777), '0o600')
        self.assertIn('Requires=proxypilot-a3-fence.service', inst.UNIT.read_text())
        self.assertIn('--serve', inst.UNIT.read_text())
        self.assertNotIn(str(ROOT), inst.UNIT.read_text())
        self.assertEqual(result['key_id'], journal['key_id'])
        self.assertIn(['systemctl', 'enable', '--now', inst.UNIT.name], self.commands)
        self.assertFalse(any('nft' in c or 'incus' in c for c in self.commands))
        self.assertEqual(inst.install()['key_id'], journal['key_id'])  # idempotent readback
        (inst.TARGET / 'a3-worker-guest.py').write_text('#!/usr/bin/env python3\nprint(1)\n')
        with self.assertRaisesRegex(ValueError, 'changed'):
            inst.status()

    def test_failed_activation_rolls_back_every_written_file(self):
        self.fail_enable = True
        with self.assertRaises(subprocess.CalledProcessError):
            inst.install()
        self.assertEqual(json.loads(inst.JOURNAL.read_text())['phase'], 'rolled_back')
        self.assertFalse(inst.UNIT.exists() or inst.KEY.exists() or inst.PUBLIC_KEY.exists())
        self.assertFalse(any((inst.TARGET / n).exists() for n in inst.SOURCES))
        self.fail_enable = False
        self.assertTrue(inst.install()['installed'])

    def test_remove_refuses_live_attempt_and_archives_public_key(self):
        installed = inst.install()
        self.status_active = {'attempt_id': 'x'}
        with self.assertRaisesRegex(ValueError, 'live'):
            inst.remove()
        self.status_active = None
        result = inst.remove()
        self.assertTrue(Path(result['key_archived']).exists())
        self.assertFalse(inst.KEY.exists() or inst.UNIT.exists())
        self.assertEqual(json.loads(inst.JOURNAL.read_text())['phase'], 'removed')
        self.assertNotEqual(inst.install()['key_id'], installed['key_id'])


class OperatorPageTests(unittest.TestCase):
    def test_loopback_token_host_and_typed_relay_only(self):
        calls = []

        def caller(method, params):
            calls.append((method, params))
            if method == 'input' and params['input'].get('kind') == 'eval':
                raise op.CallFailed({'error': 'INVALID_INPUT'})
            return {'png_base64': 'iVBORw0KGgo=', 'width': 1280, 'height': 800} if method == 'view' else {'ok': 1}
        ref = {'run_id': 'r', 'attempt_id': 'a', 'fence': 1}
        server = op.human_server(ref, ('127.0.0.1', 0), 'tok', caller)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:%d' % port

        def request(path, body=None, host=None):
            req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                         headers={'Content-Type': 'application/json', **({'Host': host} if host else {})})
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()
        try:
            status, body = request('/tok/')
            self.assertEqual(status, 200)
            self.assertIn(b'Take over', body)
            self.assertEqual(request('/wrong/')[0], 404)
            self.assertEqual(request('/tokX/')[0], 404)
            self.assertEqual(request('/tok/', host='evil.example:%d' % port)[0], 404)
            self.assertEqual(json.loads(request('/tok/frame')[1])['result']['width'], 1280)
            self.assertTrue(json.loads(request('/tok/takeover', {})[1])['ok'])
            self.assertEqual(json.loads(request('/tok/input', {'kind': 'eval'})[1])['error'], 'INVALID_INPUT')
            self.assertTrue(json.loads(request('/tok/stop', {})[1])['ok'])
            self.assertEqual([c[0] for c in calls], ['view', 'takeover', 'input', 'stop'])
            self.assertEqual(calls[-1][1]['reason'], 'taken_over')
        finally:
            server.shutdown()
            server.server_close()
        with self.assertRaises(Exception):
            op.parse_listen('0.0.0.0:18090')

    def test_page_has_no_script_or_url_input(self):
        self.assertNotIn('eval(', op.PAGE)
        self.assertNotIn('type="url"', op.PAGE)
        self.assertIn('maxlength="256"', op.PAGE)


class ProofRunnerTests(unittest.TestCase):
    def test_every_case_is_implemented_and_uses_the_installed_sockets(self):
        self.assertEqual(len(probe.CASES), len(set(probe.CASES)))
        for name in probe.CASES:
            self.assertTrue(callable(getattr(probe.Proof, name)), name)
        text = (ROOT / 'a3-probe-worker.py').read_text()
        self.assertIn("op.BACKEND_SOCKET if backend else op.OPERATOR_SOCKET", text)
        self.assertNotIn('--no-sandbox', text)
        spec = probe.spec('0b6f7c1e-2a8d-4c1b-9e3f-5a7d9c1b3e5f', '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
                          '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b', 1, {'cpu': 1})
        self.assertEqual(probe.sup.validate_launch(spec)['limits'], {'cpu': 1})

    def test_human_session_renews_only_until_takeover_and_keeps_the_page_receipt(self):
        states = iter(['running', 'running', 'human', 'human', 'stopped', 'stopped'])
        calls = []
        receipt = {'attestation': 'a3r1.x.y'}

        def fake_call(method, params=None, backend=False, timeout=180):
            calls.append((method, backend))
            if method == 'launch':
                return {'boot_id': 'boot-1'}
            if method == 'journal':
                state = next(states)
                log = [['t', 'takeover'], ['t', 'stopping:taken_over'], ['t', 'receipt']] if state == 'stopped' else []
                return {'attempt': {'state': state, 'log': log, 'receipt': receipt}}
            if method == 'action' and backend:
                raise probe.op.CallFailed({'error': 'TAKEN_OVER'})
            return {}

        class Server:
            def serve_forever(self):
                pass

            def shutdown(self):
                calls.append(('page_closed', False))

            def server_close(self):
                pass

        with tempfile.TemporaryDirectory() as temp, \
                patch.object(probe, 'call', fake_call), patch.object(probe, 'OUT', Path(temp)), \
                patch.object(probe.op, 'human_server', lambda ref, listen, token: Server()), \
                patch.object(probe.time, 'sleep', lambda _: None), \
                patch.object(probe, 'receipt_ok', lambda r: {'reason': 'taken_over', 'actions_performed': 1,
                                                             'bound_boot_id': 'boot-1'}), \
                patch('builtins.print'):
            result = probe.Proof(True).human_session(('127.0.0.1', 18090), 1)
            self.assertTrue(Path(result['report']).exists())
        methods = [m for m, _ in calls]
        self.assertEqual(result['human_session'], 'taken_over')
        self.assertEqual(result['states_seen'], ['running', 'human', 'stopped'])
        self.assertEqual(result['model_action_after_takeover'], 'TAKEN_OVER')
        self.assertEqual(methods.count('renew'), 2)
        self.assertNotIn('stop', methods)
        self.assertLess(methods.index('page_closed'), len(methods) - 1)
        self.assertEqual(result['receipt_reason'], 'taken_over')


if __name__ == '__main__':
    unittest.main()
