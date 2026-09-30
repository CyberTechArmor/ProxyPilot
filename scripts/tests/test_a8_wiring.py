import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('a8_wiring', ROOT / 'a8-wire-dashboard.py')
a8 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a8)
COMPOSE = '''services:
  proxypilot:
    privileged: true
    pid: host
    volumes:
      - ./data:/data
      - /run/proxypilot-agent:/run/proxypilot-agent
    env_file:
      - .env
    environment:
      - NODE_ENV=production
  other:
    image: example
networks:
  proxypilot-net:
    driver: bridge
'''


class WiringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.install = self.root / 'install'
        self.install.mkdir()
        self.env = self.install / '.env'
        self.compose = self.install / 'docker-compose.yml'
        self.env.write_bytes(b'JWT_SECRET=fixture-do-not-log\nOTHER="keep $dollars"\n')
        self.compose.write_text(COMPOSE)
        self.keydir = self.root / 'keydir'
        self.source = self.root / 'public.pem'
        self.sockdir = self.root / 'backend'
        self.sockdir.mkdir(mode=0o700)
        self.socket = socket.socket(socket.AF_UNIX)
        self.sock = self.sockdir / 'supervisor.sock'
        self.socket.bind(str(self.sock))
        self.sock.chmod(0o600)
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', str(self.root / 'private.pem')],
                       check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(self.root / 'private.pem'), '-pubout', '-out', str(self.source)],
                       check=True, capture_output=True)
        self.patches = [patch.object(a8, 'secure', lambda p: None), patch.object(a8.os, 'geteuid', return_value=0),
                        patch.object(a8, 'installed_checks', return_value={}), patch.object(a8, 'KEY_DIR', self.keydir),
                        patch.object(a8, 'KEY', self.keydir / 'supervisor-pub.pem'),
                        patch.object(a8, 'SOURCE_KEY', self.source), patch.object(a8, 'SOCKET', self.sock)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        self.socket.close()
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_default_install_is_byte_exact_and_does_not_probe_or_make_directories(self):
        before = {p.name: p.read_bytes() for p in self.install.iterdir()}
        with patch.object(a8, 'wiring_checks', side_effect=AssertionError('must not probe')):
            self.assertEqual(a8.run('patch', self.install), {'configured': False, 'changed': False})
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.install.iterdir()})
        self.assertFalse(self.keydir.exists())

    def test_configure_and_reinstall_are_idempotent_with_private_backups(self):
        result = a8.run('configure', self.install)
        self.assertTrue(result['changed'])
        self.assertNotIn('fixture-do-not-log', json.dumps(result))
        self.assertTrue(self.env.read_text().startswith('JWT_SECRET=fixture-do-not-log\nOTHER="keep $dollars"\n'))
        self.assertEqual(a8.read_settings(self.env.read_text()), a8.SETTINGS)
        self.assertEqual((self.keydir / 'supervisor-pub.pem').read_bytes(), self.source.read_bytes())
        self.assertEqual(self.compose.read_text().count(a8.BLOCK), 1)
        self.assertEqual(a8.run('patch', self.install)['changed'], False)
        self.assertEqual(a8.run('status', self.install)['mounts'], 'backend-directory/public-key-only')
        backup = Path(result['backup'])
        inventory = json.loads((backup / 'inventory.json').read_text())
        self.assertEqual(next((backup / p['file']).read_bytes() for p in inventory if p['path'] == str(self.env)),
                         b'JWT_SECRET=fixture-do-not-log\nOTHER="keep $dollars"\n')
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in backup.iterdir()))
        # Installer regeneration must restore the reviewed mounts too.
        self.compose.write_text(COMPOSE)
        self.assertTrue(a8.run('patch', self.install)['changed'])

    def test_partial_pins_bad_key_or_socket_and_unrelated_directory_refuse(self):
        self.env.write_text('OPERATIONS_AGENT_SUPERVISOR_SOCKET=/wrong\n')
        with self.assertRaises(ValueError):
            a8.run('patch', self.install)
        self.env.write_text('')
        self.sock.chmod(0o666)
        with self.assertRaises(ValueError):
            a8.run('configure', self.install)
        self.assertEqual(self.env.read_bytes(), b'')
        self.assertEqual(self.compose.read_text(), COMPOSE)
        self.sock.chmod(0o600)
        a8.run('configure', self.install)
        (self.keydir / 'supervisor-key.pem').write_text('never mount a private key')
        with self.assertRaises(ValueError):
            a8.run('patch', self.install)
        (self.keydir / 'supervisor-key.pem').unlink()
        (self.keydir / 'supervisor-pub.pem').write_bytes((self.root / 'private.pem').read_bytes())
        with self.assertRaises(ValueError):
            a8.run('patch', self.install)

    def test_public_key_bundles_refuse_before_configuration_writes(self):
        public = self.source.read_bytes()
        private = (self.root / 'private.pem').read_bytes()
        before = self.env.read_bytes(), self.compose.read_bytes()
        try:
            for appended in (private, public, b'ignored trailing content\n'):
                with self.subTest(appended=appended[:24]):
                    self.source.write_bytes(public + appended)
                    with self.assertRaises(ValueError):
                        a8.run('configure', self.install)
                    self.assertEqual((self.env.read_bytes(), self.compose.read_bytes()), before)
                    self.assertFalse(self.keydir.exists())
        finally:
            self.source.write_bytes(public)

    def test_ambiguous_custom_and_conflicting_compose_refuse_before_writes(self):
        for text in (COMPOSE.replace('    privileged: true', '    privileged: false'),
                     COMPOSE.replace('    pid: host', '    pid: host\n    user: 1000'),
                     COMPOSE.replace('      - ./data:/data', '      - /run/proxypilot-a3:/run/proxypilot-a3'),
                     COMPOSE.replace('      - ./data:/data', '      - /etc/proxypilot-a3-proof:/keys'),
                     COMPOSE.replace('      - .env', '      - custom.env'),
                     COMPOSE.replace('    volumes:', '    volumes: &shared'),
                     COMPOSE.replace('      - NODE_ENV=production', '      - OPERATIONS_AGENT_VM_UUID=wrong'),
                     a8.compose_text(COMPOSE).replace('read_only: true', 'read_only: false')):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    a8.compose_text(text)

    def test_postwrite_validation_failure_restores_prior_files(self):
        before = self.env.read_bytes(), self.compose.read_bytes()
        with patch.object(a8, 'wiring_checks', side_effect=ValueError('fixture key changed')):
            with self.assertRaises(ValueError):
                a8.run('configure', self.install)
        self.assertEqual((self.env.read_bytes(), self.compose.read_bytes()), before)
        self.assertFalse(a8.KEY.exists())

    def test_write_failure_restores_bytes_and_source_has_restart_preservation(self):
        before = self.env.read_bytes(), self.compose.read_bytes()
        real = a8.atomic
        def fail_compose(path, data, mode):
            if path == self.compose and data != COMPOSE.encode():
                raise OSError('fixture write failure')
            return real(path, data, mode)
        with patch.object(a8, 'atomic', side_effect=fail_compose):
            with self.assertRaises(OSError):
                a8.run('configure', self.install)
        self.assertEqual((self.env.read_bytes(), self.compose.read_bytes()), before)
        self.assertFalse(a8.KEY.exists())
        unit = (ROOT / 'a3-install-supervisor.py').read_text()
        self.assertIn('RuntimeDirectory=proxypilot-a3 proxypilot-a3-backend', unit)
        self.assertIn('RuntimeDirectoryPreserve=yes', unit)
        for name in ('install.sh', 'update.sh'):
            self.assertIn('a8-wire-dashboard.py" patch --install-dir', (ROOT.parent / name).read_text())


if __name__ == '__main__':
    unittest.main()
