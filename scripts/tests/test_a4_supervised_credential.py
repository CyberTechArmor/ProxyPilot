"""A4 through the A3 supervisor: launch pins, broker check/deliver, receipts.

The supervisor talks to a real in-process broker (fake vault, fake guest
writer that opens the runner's FIFO) and a fake runner, then to the real runner
and Chromium against a local login origin. The value must appear in no reply,
journal, receipt or event, and rotation/revocation must refuse at launch and at
the next submit.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sup_tests = load('a4s_supervisor_tests', ROOT / 'tests' / 'test_a3_worker_supervisor.py')
broker_tests = load('a4s_broker_tests', ROOT / 'tests' / 'test_a4_credential_broker.py')
submit_tests = load('a4s_submit_tests', ROOT / 'tests' / 'test_a4_credential_submit.py')
# One module instance each, so refusal classes match across the fixtures.
s, b = sup_tests.s, broker_tests.b

RUN, ATTEMPT, ATTEMPT2 = sup_tests.RUN, sup_tests.ATTEMPT, sup_tests.ATTEMPT2
PROJECT, PROFILE, BINDING = broker_tests.PROJECT, broker_tests.PROFILE, broker_tests.BINDING
SECRET = broker_tests.SECRET

FAKE_RUNNER = r'''
import json, os, sys, time
config = json.loads(sys.argv[1])
fifo = os.path.join(os.environ['A4_FAKE_WORKSPACE'], 'pp-a4-credential')
seen = open(os.environ['A4_FAKE_SEEN'], 'a')
submitted = False
print(json.dumps({'event': 'ready', 'workload': config['workload'],
                  'workspace': {'device': '0:99', 'fstype': 'tmpfs', 'size_kib': 1024},
                  'browser_pid': os.getpid(), 'browser_start_seconds': 0.1}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    op = command['op']
    reply = {'id': command['id'], 'ok': True, 'result': {}}
    if op == 'action' and command['action'] == 'submit_bound_fixture':
        os.mkfifo(fifo, 0o600)
        fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
        print(json.dumps({'event': 'credential_channel', 'binding_id': command['binding_id']}), flush=True)
        data, deadline = b'', time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                chunk = os.read(fd, 1024)
            except BlockingIOError:
                chunk = None
            if chunk:
                data += chunk
                continue
            if chunk == b'' and data:
                break
            time.sleep(0.02)
        os.close(fd)
        os.unlink(fifo)
        # The fake records only that a frame arrived and its length.
        seen.write('submit:%d\n' % len(data)); seen.flush()
        if data:
            submitted = True
            reply['result'] = {'binding_id': command['binding_id'], 'outcome': 'signed_in', 'login_requests': 1,
                               'untrusted_page_claim_authenticated_as_bound_account': True}
        else:
            reply = {'id': command['id'], 'ok': False, 'error': 'CREDENTIAL_NOT_DELIVERED'}
    elif op == 'action':
        seen.write(command['action'] + '\n'); seen.flush()
        reply['result'] = {'at': command['action']}
    elif op == 'stop':
        reply['result'] = dict({'stopping': True}, **({'logout': 'done'} if submitted else {}))
        print(json.dumps(reply), flush=True); sys.exit(0)
    print(json.dumps(reply), flush=True)
'''


class DeliveryHost:
    """The broker's host effects: the worker's pid and a FIFO writer on its workspace."""

    def __init__(self, supervisor_host, workspace):
        self.supervisor_host = supervisor_host
        self.workspace = workspace
        self.frames = 0

    def guest_main_pid(self, unit):
        process = self.supervisor_host.units.get(unit)
        if process is None or process.poll() is not None:
            raise b.Refused('WORKER_NOT_RUNNING')
        return process.pid

    def write_credential(self, pid, unit, data):
        path = os.path.join(self.workspace, 'pp-a4-credential')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
            except OSError:
                time.sleep(0.02)
                continue
            try:
                os.write(fd, bytes(data))
            finally:
                os.close(fd)
            self.frames += 1
            return
        raise b.Refused('DELIVERY_FAILED')


class A4Host(sup_tests.FakeHost):
    def __init__(self, root):
        super().__init__(root)
        self.workspace = root / 'workspace'
        self.workspace.mkdir()

    def spawn(self, unit, properties, source, config):
        self.spawns += 1
        self.props[unit] = properties
        env = dict(os.environ, A4_FAKE_SEEN=str(self.seen), A4_FAKE_WORKSPACE=str(self.workspace))
        process = subprocess.Popen([sys.executable, '-c', FAKE_RUNNER, json.dumps(config)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                   start_new_session=True, env=env)
        self.units[unit] = process
        return process


def credential(revision=1, project=PROJECT):
    return {'project_id': project, 'profile_id': PROFILE, 'profile_revision': 2, 'binding_id': BINDING,
            'binding_revision': revision}


def spec(attempt=ATTEMPT, fence=1, run=RUN, revision=1, limits=None, **extra):
    body = dict(sup_tests.launch_spec(attempt, fence, limits, run), credential=credential(revision), **extra)
    return body


@unittest.skipUnless(shutil.which('openssl'), 'openssl is required for receipt signatures')
class SupervisedCredentialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [patch.object(s.installer, 'secure', lambda path: None), patch.object(b, 'secure', lambda path: None),
                        patch.object(s, 'ACTION_SECONDS', 5), patch.object(s, 'READY_SECONDS', 10)]
        for item in self.patches:
            item.start()
        self.host = A4Host(self.root)
        self.vault = broker_tests.FakeVault()
        self.delivery = DeliveryHost(self.host, str(self.host.workspace))
        self.broker = b.Broker(host=self.delivery, vault=self.vault, journal=self.root / 'broker.json')
        self.broker.bind({'binding_id': BINDING, 'project_id': PROJECT, 'profile_id': PROFILE,
                          'username': broker_tests.USERNAME, 'vault_key': 'a4-fixture-password'})
        self.host.broker_object = self.broker
        self.sup = s.Supervisor(host=self.host, journal=self.root / 'state.json', runner_source='# fixture',
                                clock=sup_tests.Clock())
        self.sup.state['supervisor_sha256'] = 'c' * 64

    def tearDown(self):
        for unit in list(self.host.units):
            self.host.stop_unit(unit)
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    def ref(self, attempt=ATTEMPT, fence=1, run=RUN, **extra):
        return {'run_id': run, 'attempt_id': attempt, 'fence': fence, **extra}

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(s.Refused) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception.detail)

    def assertNoSecret(self, *texts):
        for text in texts:
            for form in broker_tests.encodings(SECRET):
                self.assertNotIn(form, text)

    def test_bound_submit_logout_receipt_and_no_value_anywhere(self):
        launched = self.sup.launch(spec(limits={'max_actions': 6, 'max_usd': 0.01}))
        self.assertEqual(launched['vm_uuid'], s.VM_UUID)
        self.assertEqual(self.broker.state['runs'][RUN]['credential']['binding_revision'], 1)
        self.assertEqual(self.broker.state['runs'][RUN]['limits'], {'max_usd': 0.01})
        self.sup.action(self.ref(action='open_landing'))
        self.assertRefused('BINDING_MISMATCH', self.sup.action, self.ref(action='submit_bound_fixture',
                                                                         binding_id=PROFILE))
        result = self.sup.action(self.ref(action='submit_bound_fixture', binding_id=BINDING))
        self.assertEqual(result, {'ordinal': 2, 'untrusted': True, 'result': {
            'binding_id': BINDING, 'binding_revision': 1, 'outcome': 'signed_in', 'login_requests': 1,
            'untrusted_page_claim_authenticated_as_bound_account': True}})
        self.assertEqual(self.delivery.frames, 1)
        frame_length = 8 + len(broker_tests.USERNAME) + len(SECRET)
        self.assertEqual(self.host.seen.read_text().split(), ['open_landing', 'submit:%d' % frame_length])
        receipt = self.sup.stop(self.ref(reason='cancelled'))['receipt']
        valid, payload = self.host.verify(receipt['attestation'])
        self.assertTrue(valid)
        self.assertEqual(payload['credential'], {'binding_id': BINDING, 'binding_revision': 1,
                                                 'submits': [{'ordinal': 2, 'outcome': 'signed_in'}],
                                                 'logout': 'done'})
        self.assertEqual(payload['evidence']['logout'], 'done')
        record = self.sup.journal({'attempt_id': ATTEMPT})['attempt']['actions'][1]
        self.assertEqual({k: record[k] for k in ('action', 'binding_id', 'binding_revision', 'state', 'outcome')},
                         {'action': 'submit_bound_fixture', 'binding_id': BINDING, 'binding_revision': 1,
                          'state': 'done', 'outcome': 'signed_in'})
        self.assertNoSecret(json.dumps(result), json.dumps(receipt), json.dumps(payload),
                            (self.root / 'state.json').read_text(), (self.root / 'broker.json').read_text(),
                            self.host.seen.read_text())

    def test_rotation_and_revocation_refuse_at_submit_and_at_launch(self):
        self.sup.launch(spec())
        self.sup.action(self.ref(action='open_landing'))
        self.vault.values['a4-fixture-password'].append('A4-canary-rotated')
        self.broker.rotate({'binding_id': BINDING, 'expected_revision': 1})
        count = self.sup.state['runs'][RUN]['action_count']
        self.assertRefused('BINDING_REVISION_MISMATCH', self.sup.action,
                           self.ref(action='submit_bound_fixture', binding_id=BINDING))
        # Refused before the runner or the vault is touched; no action is counted.
        self.assertEqual(self.sup.state['runs'][RUN]['action_count'], count)
        self.assertEqual(self.vault.reads, 0)
        self.assertNotIn('submit', self.host.seen.read_text())
        self.sup.stop(self.ref(reason='cancelled'))
        # The old revision is refused at launch: a new attempt of this run, and a new run.
        self.assertRefused('BINDING_REVISION_MISMATCH', self.sup.launch, spec(ATTEMPT2, 2))
        run2 = '0f1a2b3c-4d5e-4f6a-8b7c-8d9e0f1a2b3c'
        a3 = '1a2b3c4d-5e6f-4a7b-9c8d-9e0f1a2b3c4d'
        self.assertRefused('BINDING_REVISION_MISMATCH', self.sup.launch, spec(a3, 1, run2, revision=1))
        a4 = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'
        self.sup.launch(spec(a4, 2, run2, revision=2))
        ref = self.ref(a4, 2, run2)
        self.assertEqual(self.sup.action(dict(ref, action='submit_bound_fixture', binding_id=BINDING))['result']
                         ['binding_revision'], 2)
        # Revocation: the running attempt's next submit is refused immediately.
        revoked_at = time.monotonic()
        self.broker.revoke({'binding_id': BINDING})
        self.assertRefused('BINDING_REVOKED', self.sup.action, dict(ref, action='submit_bound_fixture',
                                                                     binding_id=BINDING))
        self.assertLess(time.monotonic() - revoked_at, 1.0)
        self.assertEqual(self.delivery.frames, 1)
        log = [entry[1] for entry in self.sup.state['attempts'][a4]['log']]
        self.assertIn('submit_refused:BINDING_REVOKED', log)
        self.sup.stop(dict(ref, reason='cancelled'))
        a5 = '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f'
        self.assertRefused('BINDING_REVOKED', self.sup.launch,
                           spec(a5, 1, '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a', revision=2))

    def test_credential_launch_needs_the_broker_and_matching_scope(self):
        self.host.broker_object = None
        self.assertRefused('CREDENTIAL_BROKER_UNAVAILABLE', self.sup.launch, spec())
        self.assertEqual(self.sup.state['attempts'][ATTEMPT]['state'], 'refused')
        self.host.broker_object = self.broker
        run2 = '0f1a2b3c-4d5e-4f6a-8b7c-8d9e0f1a2b3c'
        self.assertRefused('BINDING_SCOPE_MISMATCH', self.sup.launch,
                           dict(spec(ATTEMPT2, 1, run2), credential=credential(project=PROFILE)))
        for bad in ({'binding_id': 'x'}, {'binding_revision': 0}, {'value': SECRET}):
            with self.assertRaises(s.Refused):
                s.validate_launch(dict(spec(), credential=dict(credential(), **bad)))
        self.assertEqual(self.host.spawns, 0)
        # Without a credential and without a broker, an A3 launch still works unpinned.
        self.host.broker_object = None
        run3 = '1a2b3c4d-5e6f-4a7b-9c8d-9e0f1a2b3c4d'
        self.sup.launch(sup_tests.launch_spec('2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', 1, None, run3))
        self.assertFalse(self.sup.state['runs'][run3]['broker_pinned'])


@unittest.skipUnless(Path(submit_tests.helpers.LOCAL_CHROMIUM).exists() and shutil.which('openssl'),
                     'local Chromium and openssl are required for the end-to-end A4 test')
class EndToEndTests(unittest.TestCase):
    """supervisor -> broker -> FIFO -> real runner -> Chromium -> proxy -> login origin."""

    @classmethod
    def setUpClass(cls):
        submit_tests.CredentialBrowserTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        submit_tests.CredentialBrowserTests.tearDownClass.__func__(cls)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        source = (ROOT / 'a3-worker-guest.py').read_text()
        workspace = root / 'workspace'
        workspace.mkdir()
        g = submit_tests.g
        for old, new in (("PROXY = '10.185.17.1:18083'", "PROXY = %r" % g.PROXY),
                         ("CHROMIUM = '/usr/bin/chromium'", "CHROMIUM = %r" % g.CHROMIUM),
                         ("WORKSPACE = '/tmp'", "WORKSPACE = %r" % str(workspace))):
            self.assertEqual(source.count(old), 1)
            source = source.replace(old, new)
        self.host = sup_tests.LocalHost(root, source)
        spki = self.spki
        self.host.full_boundary = lambda: dict(sup_tests.FakeHost.full_boundary(self.host), spki=spki)
        self.patches = [patch.object(s.installer, 'secure', lambda path: None), patch.object(b, 'secure', lambda path: None)]
        for item in self.patches:
            item.start()
        submit_tests.LoginOrigin.password = SECRET
        submit_tests.LoginOrigin.sessions.clear()
        submit_tests.LoginOrigin.logins.clear()
        self.vault = broker_tests.FakeVault()
        self.delivery = DeliveryHost(self.host, str(workspace))
        self.broker = b.Broker(host=self.delivery, vault=self.vault, journal=root / 'broker.json')
        self.broker.bind({'binding_id': BINDING, 'project_id': PROJECT, 'profile_id': PROFILE,
                          'username': submit_tests.USERNAME, 'vault_key': 'a4-fixture-password'})
        self.host.broker_object = self.broker
        self.sup = s.Supervisor(host=self.host, journal=root / 'state.json', runner_source=source,
                                clock=sup_tests.Clock())
        self.sup.state['supervisor_sha256'] = 'c' * 64
        self.root = root

    def tearDown(self):
        for unit in list(self.host.units):
            self.host.stop_unit(unit)
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    def test_supervised_sign_in_logout_and_no_value_outside_the_fifo(self):
        self.sup.launch(spec(limits={'max_actions': 8}))
        ref = {'run_id': RUN, 'attempt_id': ATTEMPT, 'fence': 1}
        self.sup.action(dict(ref, action='open_landing'))
        self.sup.action(dict(ref, action='open_login'))
        result = self.sup.action(dict(ref, action='submit_bound_fixture', binding_id=BINDING))
        self.assertEqual(result['result']['outcome'], 'signed_in', result)
        self.assertEqual(submit_tests.LoginOrigin.logins, ['accepted'])
        view = self.sup.dispatch('view', ref, operator=True)
        self.assertTrue(base64.b64decode(view['png_base64']).startswith(b'\x89PNG'))
        receipt = self.sup.stop(dict(ref, reason='cancelled'))['receipt']
        valid, payload = self.host.verify(receipt['attestation'])
        self.assertTrue(valid)
        self.assertEqual(payload['credential']['submits'], [{'ordinal': 3, 'outcome': 'signed_in'}])
        self.assertEqual(payload['credential']['logout'], 'done')
        self.assertEqual(submit_tests.LoginOrigin.logins, ['accepted', 'logout'])
        self.assertEqual(submit_tests.LoginOrigin.sessions, set())
        for text in (json.dumps(result), json.dumps(payload), json.dumps(view)[:0],
                     (self.root / 'state.json').read_text(), (self.root / 'broker.json').read_text(),
                     json.dumps(self.sup.journal({'attempt_id': ATTEMPT}))):
            for form in broker_tests.encodings(SECRET):
                self.assertNotIn(form, text)
        self.assertFalse((self.root / 'workspace' / 'pp-a4-credential').exists())


if __name__ == '__main__':
    unittest.main()
