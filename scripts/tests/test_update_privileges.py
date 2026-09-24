import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'check-update-privileges.py'
spec = importlib.util.spec_from_file_location('preflight', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def baseline():
    return {'services': {'proxypilot': {'privileged': True, 'pid': 'host',
        'volumes': [{'type': 'bind', 'source': '/var/run/docker.sock',
                     'target': '/var/run/docker.sock', 'read_only': False}]}}}


class Privileges(unittest.TestCase):
    def test_actual_updater_stops_before_checkout_or_deployment_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'bin').mkdir()
            shutil.copyfile(SCRIPT, root / 'scripts' / SCRIPT.name)
            shutil.copyfile(SCRIPT.parents[1] / 'update.sh', root / 'update.sh')
            compose = root / 'docker-compose.yml'
            compose.write_text('services:\n  proxypilot:\n    privileged: false\n')
            original = compose.read_bytes()
            envfile = root / '.env'
            envfile.write_text('TOKEN=SECRET-SENTINEL\n')
            marker = root / 'mutation-attempted'
            normalized = baseline()
            normalized['services']['proxypilot']['privileged'] = False
            docker = root / 'bin/docker'
            docker.write_text('#!/usr/bin/env python3\nprint(' + repr(json.dumps(normalized)) + ')\n')
            docker.chmod(0o755)
            for name in ['git', 'npm', 'systemctl', 'apt-get']:
                stub = root / 'bin' / name
                stub.write_text('#!/usr/bin/env python3\nfrom pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\nraise SystemExit(99)\n')
                stub.chmod(0o755)
            # Reproduce an old host Node without ever invoking it: privilege
            # preflight must still refuse before runtime download/package work.
            node = root / 'bin/node'
            node.write_text('#!/bin/sh\nexit 1\n')
            node.chmod(0o755)
            env = dict(os.environ, PATH=str(root / 'bin') + os.pathsep + os.environ['PATH'])
            result = subprocess.run(['bash', str(root / 'update.sh'), '--yes', '--rebuild'], env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn('Privilege preflight refused', result.stderr)
            self.assertFalse(marker.exists(), 'updater reached a mutation command')
            self.assertEqual(compose.read_bytes(), original)
            self.assertEqual(envfile.read_text(), 'TOKEN=SECRET-SENTINEL\n')
            self.assertNotIn('SECRET-SENTINEL', result.stdout + result.stderr)

    def test_legacy_baseline_and_stricter_postures(self):
        module.check(baseline())
        changes = [{'privileged': False}, {'pid': ''}, {'user': '1000:1000'},
                   {'read_only': True}, {'cap_drop': ['ALL']},
                   {'security_opt': ['no-new-privileges:true']},
                   {'volumes': []}, {'userns_mode': 'private'}]
        for change in changes:
            document = baseline()
            document['services']['proxypilot'].update(change)
            original = copy.deepcopy(document)
            with self.assertRaises(ValueError):
                module.check(document)
            self.assertEqual(document, original)
        document = baseline()
        document['services']['proxypilot']['volumes'][0]['read_only'] = True
        with self.assertRaises(ValueError):
            module.check(document)

    def test_read_only_cli_never_exposes_config_or_modifies_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'compose.json'
            document = baseline()
            document['services']['proxypilot']['privileged'] = False
            document['services']['proxypilot']['environment'] = {'TOKEN': 'SECRET-SENTINEL'}
            contents = json.dumps(document)
            path.write_text(contents)
            result = subprocess.run([sys.executable, str(SCRIPT), '--check-json', str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn('SECRET-SENTINEL', result.stdout + result.stderr)
            self.assertEqual(path.read_text(), contents)


if __name__ == '__main__':
    unittest.main()
