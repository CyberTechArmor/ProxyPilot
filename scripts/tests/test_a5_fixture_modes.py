"""A5 outcome fixtures on the demo origin: the host tool writes a non-secret mode
file, the demo applies it to the synthetic account only, and deploy/rollback
keep both the pre-A4 original and the file each deploy replaced."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('a5_fixture', ROOT / 'a4-fixture-account.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
VALUE = 'A5-fixture-value-Qm3'


class FixtureModeTests(unittest.TestCase):
    def test_mode_document_is_typed_and_pushed_to_the_fixture_path(self):
        self.assertEqual(json.loads(fixture.fixture_document('locked', True)), {'v': 1, 'mode': 'locked',
                                                                                'injection': True})
        for bad in (('shell', False), ('normal', 'yes')):
            with self.assertRaises(ValueError):
                fixture.fixture_document(*bad)
        pushed = []
        with patch.object(fixture, 'push', lambda data, path, instance: pushed.append((data, path, instance))):
            result = fixture.set_mode('challenge', False, 'pp-fractionate-demo')
        self.assertEqual(pushed[0][1:], ('/opt/app/demo/a5-fixture.json', 'pp-fractionate-demo'))
        self.assertEqual(result['sha256'], hashlib.sha256(pushed[0][0]).hexdigest())

    def test_deploy_keeps_the_replaced_server_and_rollback_can_return_to_it(self):
        guest = {fixture.SERVER: b'a4-server', fixture.BACKUP: b'original'}
        commands = []

        def sha(path, instance='x'):
            return hashlib.sha256(guest[path]).hexdigest() if path in guest else None

        def run(argv, data=None, timeout=60):
            commands.append(argv)
            if argv[4:6] == ['cp', '-p']:
                guest[argv[7]] = guest[argv[6]]

        def push(data, path, instance):
            guest[path] = data
        with patch.object(fixture, 'guest_sha256', sha), patch.object(fixture, 'run', run), \
                patch.object(fixture, 'push', push), \
                patch.object(fixture, 'REVIEWED_SERVER', Path(tempfile.mkstemp()[1])) as source:
            source.write_bytes(b'a5-server')
            result = fixture.deploy_server('pp-fractionate-demo', source)
            self.assertEqual((guest[fixture.SERVER], guest[fixture.PREVIOUS], guest[fixture.BACKUP]),
                             (b'a5-server', b'a4-server', b'original'))
            self.assertEqual(result['previous_sha256'], hashlib.sha256(b'a4-server').hexdigest())
            # Re-deploying the same bytes does not overwrite the kept previous file.
            fixture.deploy_server('pp-fractionate-demo', source)
            self.assertEqual(guest[fixture.PREVIOUS], b'a4-server')
            fixture.rollback_server('pp-fractionate-demo', 'previous')
            self.assertEqual(guest[fixture.SERVER], b'a4-server')
            fixture.rollback_server('pp-fractionate-demo')
            self.assertEqual(guest[fixture.SERVER], b'original')
            source.unlink()

    @unittest.skipUnless(shutil.which('node') and (ROOT.parent / 'admin' / 'frontend' / 'dist-demo' / 'index.html').exists(),
                         'node and a built demo (npm run demo:build) are required for the cross-language check')
    def test_the_demo_server_applies_the_python_mode_document(self):
        with tempfile.TemporaryDirectory() as temp:
            account, modes = Path(temp) / 'synthetic-account.json', Path(temp) / 'a5-fixture.json'
            account.write_text(fixture.verifier('a4-fixture@demo.fractionate.ai', bytearray(VALUE.encode())))
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            origin = 'http://127.0.0.1:%d' % port
            env = dict(os.environ, DEMO_PORT=str(port), DEMO_PUBLIC_ORIGIN=origin,
                       DEMO_SYNTHETIC_ACCOUNT_FILE=str(account), DEMO_A5_FIXTURE_FILE=str(modes))
            server = subprocess.Popen(['node', str(fixture.REVIEWED_SERVER)], env=env, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def login():
                request = urllib.request.Request(origin + '/api/login', method='POST', data=json.dumps(
                    {'email': 'a4-fixture@demo.fractionate.ai', 'password': VALUE}).encode(),
                    headers={'Content-Type': 'application/json', 'Origin': origin})
                try:
                    with opener.open(request, timeout=10) as r:
                        return r.status
                except urllib.error.HTTPError as error:
                    return error.code
            try:
                server.stdout.readline()
                for index, (mode, status) in enumerate((('expired', 401), ('locked', 429), ('normal', 200))):
                    modes.write_bytes(fixture.fixture_document(mode, False))
                    os.utime(modes, ns=(0, (index + 1) * 10 ** 9))   # a distinct mtime per write
                    self.assertEqual(login(), status, mode)
            finally:
                server.kill()
                server.wait(10)
                server.stdout.close()
                server.stderr.close()


if __name__ == '__main__':
    unittest.main()


canary_spec = importlib.util.spec_from_file_location('a5_canary', ROOT / 'a4-canary-scan.py')
canary = importlib.util.module_from_spec(canary_spec)
canary_spec.loader.exec_module(canary)


class A5CanaryTests(unittest.TestCase):
    def test_the_proof_database_log_and_reports_are_sinks_and_the_marker_is_counted(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db = sqlite3.connect(root / 'proof.db')
            db.execute('CREATE TABLE t(x)')
            db.execute("INSERT INTO t VALUES('typed claims only')")
            db.commit()
            db.close()
            (root / 'harness.log').write_text('{"event":"step_done","claims":{"sample_present":true}}\n')
            (root / 'a5-proof-x.json').write_text('{"a5_proof":"passed"}\n')
            readers = canary.a5_sources(root)
            self.assertEqual(set(readers), {'a5_proof_database_files', 'a5_proof_database_dump',
                                            'a5_harness_log_and_reports'})
            clean = canary.scan(bytearray(VALUE.encode()), readers, canary.A5_MARKER)
            self.assertEqual(clean['canary_scan'], 'passed', clean)
            self.assertTrue(all(r['marker_matches'] == 0 for r in clean['sinks'].values()))
            (root / 'harness.log').write_text('PPA5-INJECT-5b7e1d93 leaked\n')
            dirty = canary.scan(bytearray(VALUE.encode()), canary.a5_sources(root), canary.A5_MARKER)
            self.assertEqual(dirty['canary_scan'], 'failed')
            self.assertEqual(dirty['sinks']['a5_harness_log_and_reports']['marker_matches'], 1)
            # The canary's marker is the one the demo server serves.
            server = (ROOT.parent / 'admin' / 'frontend' / 'demo' / 'server.mjs').read_text()
            self.assertIn(canary.A5_MARKER, server)
            missing = canary.scan(bytearray(VALUE.encode()), canary.a5_sources(root / 'absent'))
            self.assertEqual(missing['canary_scan'], 'failed')
