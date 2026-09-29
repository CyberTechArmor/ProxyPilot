import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('worker_supervisor', ROOT / 'a3-worker-supervisor.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)

RUN = '0b6f7c1e-2a8d-4c1b-9e3f-5a7d9c1b3e5f'
ATTEMPT = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
ATTEMPT2 = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'
WORKSPACE = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b'
DIGEST = 'a' * 64
BOOT = 'b08210f9-fe81-4e86-9362-926f5ee21e59'

FAKE_RUNNER = r'''
import json, os, sys, time
config = json.loads(sys.argv[1])
if config['workload'] == 'proof:fail':
    print(json.dumps({'event': 'failed', 'code': 'PROOF_LAUNCH_FAILURE'}), flush=True); sys.exit(3)
seen = open(os.environ['A3_FAKE_SEEN'], 'a')
print(json.dumps({'event': 'ready', 'workload': config['workload'],
                  'workspace': {'device': '0:99', 'fstype': 'tmpfs', 'size_kib': 1024},
                  'browser_pid': os.getpid(), 'browser_start_seconds': 0.1}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    op = command['op']
    reply = {'id': command['id'], 'ok': True, 'result': {}}
    if op == 'action':
        seen.write(command['action'] + '\n'); seen.flush()
        if command['action'] == 'read_files':
            time.sleep(60)
        reply['result'] = {'at': command['action']}
    elif op == 'view':
        # The real runner also reports the page URL; the backend view must drop it.
        reply['result'] = {'png_base64': 'iVBORw0KGgo=', 'width': 1280, 'height': 800,
                           'untrusted_page_url': 'https://demo.fractionate.ai/?token=fixture'}
    elif op == 'stop':
        print(json.dumps(reply), flush=True); sys.exit(0)
    elif op == 'proof':
        print(json.dumps({'event': 'proof', 'case': config['workload']}), flush=True)
    print(json.dumps(reply), flush=True)
'''


class Clock:
    def __init__(self):
        self.value = 1_800_000_000.0

    def __call__(self):
        return self.value


class FakeHost:
    def __init__(self, root):
        self.root = root
        self.key = root / 'key.pem'
        self.pub = root / 'pub.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', str(self.key)], check=True,
                       capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(self.key), '-pubout', '-out', str(self.pub)], check=True,
                       capture_output=True)
        self.seen = root / 'seen.txt'
        self.seen.write_text('')
        self.boundary_error = None
        self.boot = BOOT
        self.status = 'Running'
        self.units = {}
        self.props = {}
        self.tamper = None
        self.spawns = 0

    def full_boundary(self):
        if self.boundary_error:
            raise s.Refused(self.boundary_error, 'fixture')
        return {'vm_uuid': s.VM_UUID, 'pid': 4242, 'boot_id': self.boot, 'mem_total_kib': 3845 * 1024,
                'guest_cpus': 2, 'vm_cpus': 2, 'vm_memory_mib': 4096, 'root_disk_gib': 12,
                'spki': base64.b64encode(b'\1' * 32).decode(), 'fence_fingerprint': 'f' * 64}

    def verify_install(self, own):
        return None

    def light_boundary(self, pid, fingerprint):
        return None

    def vm_state(self):
        return {'status': self.status, 'pid': 4242}

    def boot_id(self):
        return self.boot

    def spawn(self, unit, properties, source, config):
        self.spawns += 1
        self.props[unit] = properties
        env = dict(os.environ, A3_FAKE_SEEN=str(self.seen))
        process = subprocess.Popen([sys.executable, '-c', FAKE_RUNNER, json.dumps(config)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                   start_new_session=True, env=env)
        self.units[unit] = process
        return process

    def readback(self, unit):
        props = dict(p.split('=', 1) for p in self.props[unit])
        memory = int(props['MemoryMax'][:-1]) * 1024 * 1024
        quota = props.get('CPUQuota')
        values = {'ActiveState': 'active', 'User': props['User'], 'NoNewPrivileges': 'yes',
                  'ProtectSystem': 'strict', 'PrivateDevices': 'yes', 'CapabilityBoundingSet': '',
                  'IPAddressDeny': '0.0.0.0/0 ::/0', 'IPAddressAllow': props['IPAddressAllow'],
                  'OOMPolicy': 'kill', 'KillMode': 'control-group',
                  'RuntimeMaxUSec': props.get('RuntimeMaxSec', 'infinity'),
                  'RestrictAddressFamilies': props['RestrictAddressFamilies'],
                  'ControlGroup': '/system.slice/%s.service' % unit,
                  'cgroup': {'memory.max': str(memory), 'memory.swap.max': '0', 'pids.max': props['TasksMax'],
                             'cpu.max': ('%d 100000' % (int(quota[:-1]) * 1000)) if quota else 'max 100000'}}
        if self.tamper:
            values['cgroup']['memory.max'] = 'max'
        return values

    def alive(self, unit):
        process = self.units.get(unit)
        return process is not None and process.poll() is None

    def stop_unit(self, unit):
        process = self.units.get(unit)
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(5)

    def unit_state(self, unit):
        return {'LoadState': 'loaded' if self.alive(unit) else 'not-found',
                'ActiveState': 'active' if self.alive(unit) else 'inactive', 'Result': 'success'}

    def gone(self, unit, device):
        alive = self.alive(unit)
        return {'boot_id': self.boot, 'members': [1] if alive else [], 'nobody': [], 'mounted': [],
                'cgroup_exists': alive, 'cgroup_populated': True if alive else None}

    def stats(self, unit):
        return {'memory.peak': '1'}

    def worker_units(self):
        return [u for u in self.units if self.alive(u)]

    def broker_available(self):
        return getattr(self, 'broker_object', None) is not None

    def broker(self, method, params, timeout=30):
        if not self.broker_available():
            raise s.Refused('CREDENTIAL_BROKER_UNAVAILABLE')
        # Through JSON, as over the socket: nothing but the typed fields and a code cross.
        try:
            result = self.broker_object.dispatch(method, json.loads(json.dumps(params)))
        except Exception as error:  # noqa: BLE001 - the broker's own Refused class
            raise s.Refused(getattr(error, 'code', 'INTERNAL')) from None
        return json.loads(json.dumps(result))

    def sign(self, payload):
        message = self.root / 'message'
        message.write_bytes(payload)
        return subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(self.key), '-rawin', '-in', str(message)],
                              check=True, capture_output=True).stdout

    def key_id(self):
        der = subprocess.run(['openssl', 'pkey', '-pubin', '-in', str(self.pub), '-outform', 'DER'], check=True,
                             capture_output=True).stdout
        return hashlib.sha256(der).hexdigest()

    def verify(self, attestation):
        _, body, signature = attestation.split('.')
        pad = lambda v: base64.urlsafe_b64decode(v + '=' * (-len(v) % 4))  # noqa: E731
        (self.root / 'm').write_bytes(pad(body))
        (self.root / 's').write_bytes(pad(signature))
        result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(self.pub), '-rawin',
                                 '-in', str(self.root / 'm'), '-sigfile', str(self.root / 's')], capture_output=True)
        return result.returncode == 0, json.loads(pad(body))


def launch_spec(attempt=ATTEMPT, fence=1, limits=None, run=RUN):
    limits = limits or {}
    return {'run_id': run, 'attempt_id': attempt, 'workspace_id': WORKSPACE, 'fence': fence,
            'policy_digest': DIGEST, 'project_limits_revision': 3, 'origin': s.ORIGIN, 'target': s.TARGET,
            'limits': limits, 'install': s.install_shape(limits)}


@unittest.skipUnless(shutil.which('openssl'), 'openssl is required for receipt signatures')
class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [patch.object(s.installer, 'secure', lambda path: None),
                        patch.object(s, 'ACTION_SECONDS', 2), patch.object(s, 'READY_SECONDS', 10)]
        for item in self.patches:
            item.start()
        self.host = FakeHost(self.root)
        self.clock = Clock()
        self.sup = self.make()

    def make(self):
        sup = s.Supervisor(host=self.host, journal=self.root / 'state.json', runner_source='# fixture', clock=self.clock)
        sup.state['supervisor_sha256'] = 'c' * 64
        return sup

    def tearDown(self):
        for unit in list(self.host.units):
            self.host.stop_unit(unit)
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    def ref(self, attempt=ATTEMPT, fence=1, **extra):
        return {'run_id': RUN, 'attempt_id': attempt, 'fence': fence, **extra}

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(s.Refused) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception.detail)

    def assertReceipt(self, receipt, reason, attempt=ATTEMPT, fence=1):
        self.assertEqual({k: receipt[k] for k in ('run_id', 'attempt_id', 'fence', 'descendants_gone',
                                                  'workspace_removed')},
                         {'run_id': RUN, 'attempt_id': attempt, 'fence': fence, 'descendants_gone': True,
                          'workspace_removed': True})
        valid, payload = self.host.verify(receipt['attestation'])
        self.assertTrue(valid)
        self.assertEqual(payload['reason'], reason)
        self.assertEqual(payload['vm_uuid'], s.VM_UUID)
        self.assertEqual(payload['key_id'], self.host.key_id())
        tampered = receipt['attestation'][:-4] + ('AAAA' if not receipt['attestation'].endswith('AAAA') else 'BBBB')
        self.assertFalse(self.host.verify(tampered)[0])
        return payload

    def test_pure_contract_and_unit_plan(self):
        self.assertEqual(s.install_shape({}), {'cpu': 2, 'memory_mib': 4096, 'root_disk_gib': 12})
        self.assertEqual(s.install_shape({'cpu': 4, 'memory_mib': 6000}), {'cpu': 4, 'memory_mib': 7024, 'root_disk_gib': 12})
        s.validate_launch(launch_spec())
        for bad in ({**launch_spec(), 'argv': ['sh']}, {**launch_spec(), 'origin': 'https://example.com'},
                    {**launch_spec(), 'fence': 0}, {**launch_spec(), 'install': {'cpu': 1, 'memory_mib': 1, 'root_disk_gib': 1}},
                    {**launch_spec(), 'limits': {'shell': 1}}, {**launch_spec(), 'limits': {'max_actions': True}},
                    {**launch_spec(), 'attempt_id': ATTEMPT.upper()}):
            self.assertRaises(s.Refused, s.validate_launch, bad)
        self.assertRefused('PROJECT_LIMIT_BELOW_WORKER_MINIMUM', s.validate_launch, launch_spec(limits={'memory_mib': 512}))
        plan = s.worker_plan({}, 3845 * 1024, 2)
        self.assertEqual((plan['memory_mib'], plan['temporary_disk_mib'], plan['cpu_quota_percent']), (3077, 512, None))
        plan = s.worker_plan({'cpu': 1, 'memory_mib': 1024, 'temporary_disk_mib': 64}, 3845 * 1024, 2)
        props = s.unit_properties(plan, 20)
        for required in ('User=nobody', 'NoNewPrivileges=yes', 'PrivateDevices=yes', 'MemoryMax=1024M',
                         'MemorySwapMax=0', 'TasksMax=512', 'CPUQuota=100%', 'RuntimeMaxSec=20s',
                         'IPAddressDeny=any', 'IPAddressAllow=10.185.17.1/32', 'CapabilityBoundingSet=',
                         'TemporaryFileSystem=/tmp:rw,nosuid,nodev,size=64M,mode=0700,uid=65534,gid=65534'):
            self.assertIn(required, props)
        self.assertFalse(any('no-sandbox' in p or 'Privileged' in p for p in props))
        self.assertEqual(s.expected_cgroup(plan)['cpu.max'], '100000 100000')
        self.assertRefused('VM_CAPACITY_INSUFFICIENT', s.worker_plan, {'memory_mib': 3500}, 3845 * 1024, 2)
        self.assertRefused('VM_CAPACITY_INSUFFICIENT', s.worker_plan, {'cpu': 3}, 3845 * 1024, 2)
        self.assertRefused('TEMPORARY_DISK_EXCEEDS_WORKER_MEMORY', s.worker_plan,
                           {'memory_mib': 1024, 'temporary_disk_mib': 1024}, 3845 * 1024, 2)
        self.assertEqual(s.parse_timespan('1min 30s'), 90)
        self.assertIsNone(s.parse_timespan('infinity'))
        self.assertEqual(s.summary(b'Finished with result: oom-kill\nMain processes terminated with: code=killed, status=9/KILL\n'),
                         {'result': 'oom-kill', 'main_exit': 'code=killed, status=9/KILL'})
        self.assertEqual(s.size_mib('12GiB'), 12288)

    def test_launch_actions_stop_receipt_and_no_revival(self):
        result = self.sup.launch(launch_spec(limits={'max_actions': 5}))
        self.assertEqual((result['vm_uuid'], result['boot_id'], result['unit']),
                         (s.VM_UUID, BOOT, s.UNIT_PREFIX + ATTEMPT))
        self.assertEqual(result['workspace']['kind'], 'unit-private-tmpfs')
        self.assertEqual(self.sup.action(self.ref(action='open_landing'))['ordinal'], 1)
        # A4: the binding ID is required, and a run launched without a binding has none.
        self.assertRefused('INVALID_REQUEST', self.sup.action, self.ref(action='submit_bound_fixture'))
        self.assertRefused('CREDENTIAL_NOT_BOUND', self.sup.action,
                           self.ref(action='submit_bound_fixture', binding_id=WORKSPACE))
        self.assertRefused('INVALID_BROWSER_ACTION', self.sup.action, self.ref(action='run_shell'))
        self.assertRefused('INVALID_REQUEST', self.sup.action, self.ref(action='open_landing', url='https://x'))
        self.assertRefused('STALE_FENCE', self.sup.action, self.ref(fence=2, action='open_landing'))
        self.assertRefused('ACTIVE_ATTEMPT', self.sup.launch, launch_spec(attempt=ATTEMPT2, fence=2))
        self.clock.value += 10
        self.sup.renew(self.ref())
        receipt = self.sup.stop(self.ref(reason='cancelled'))['receipt']
        payload = self.assertReceipt(receipt, 'cancelled')
        self.assertEqual(payload['actions_performed'], 1)
        self.assertEqual(payload['bound_boot_id'], BOOT)
        self.assertFalse(self.host.alive(s.UNIT_PREFIX + ATTEMPT))
        self.assertEqual(self.sup.stop(self.ref(reason='failed'))['receipt'], receipt)
        self.assertRefused('ATTEMPT_EXISTS', self.sup.launch, launch_spec())
        self.assertRefused('ATTEMPT_NOT_ACTIVE', self.sup.action, self.ref(action='open_landing'))
        self.assertRefused('ATTEMPT_NOT_ACTIVE', self.sup.renew, self.ref())
        self.assertEqual(self.host.seen.read_text().split(), ['open_landing'])

    def test_budgets_are_pinned_across_attempts_and_stale_fences_refused(self):
        self.sup.launch(launch_spec(limits={'max_actions': 2, 'max_seconds': 100}))
        props = dict(p.split('=', 1) for p in self.host.props[s.UNIT_PREFIX + ATTEMPT])
        self.assertEqual(props['RuntimeMaxSec'], '100s')
        self.sup.action(self.ref(action='open_landing'))
        self.sup.action(self.ref(action='read_session'))
        self.assertRefused('ACTION_LIMIT', self.sup.action, self.ref(action='read_session'))
        self.sup.stop(self.ref(reason='cancelled'))
        self.assertRefused('ACTION_LIMIT', self.sup.launch, launch_spec(attempt=ATTEMPT2, fence=2,
                                                                        limits={'max_actions': 2, 'max_seconds': 100}))
        # The refused attempt is terminal with its own receipt; it cannot start later.
        receipt = self.sup.stop({**self.ref(ATTEMPT2, 2), 'reason': 'failed'})['receipt']
        self.assertEqual(self.host.verify(receipt['attestation'])[1]['evidence'], {'launched': False, 'exit': None})
        self.assertRefused('ATTEMPT_EXISTS', self.sup.launch, launch_spec(attempt=ATTEMPT2, fence=3))
        third = '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c'
        self.assertRefused('STALE_FENCE', self.sup.launch, launch_spec(attempt=third, fence=1,
                                                                       limits={'max_actions': 2, 'max_seconds': 100}))
        fourth = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'
        self.assertRefused('RUN_POLICY_MISMATCH', self.sup.launch, launch_spec(attempt=fourth, fence=9,
                                                                               limits={'max_actions': 50}))
        self.assertEqual(self.host.spawns, 1)

    def test_deadline_and_lease_expiry_tear_down_without_renewal_reset(self):
        self.sup.launch(launch_spec(limits={'max_seconds': 40}))
        self.clock.value += 25
        self.sup.renew(self.ref())
        self.clock.value += 20
        self.assertRefused('DEADLINE', self.sup.renew, self.ref())
        self.sup.tick()
        attempt = self.sup.state['attempts'][ATTEMPT]
        self.assertEqual(attempt['state'], 'stopped')
        self.assertReceipt(attempt['receipt'], 'deadline')
        self.assertRefused('DEADLINE', self.sup.launch, launch_spec(attempt=ATTEMPT2, fence=2, limits={'max_seconds': 40}))
        run2 = '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e'
        self.sup.launch(launch_spec(attempt='7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f', run=run2))
        self.clock.value += s.LEASE_SECONDS + 1
        self.sup.tick()
        self.assertEqual(self.sup.state['attempts']['7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f']['stop_reason'], 'lease_expired')

    def test_takeover_fences_model_and_operator_only_controls(self):
        self.sup.launch(launch_spec())
        self.assertRefused('METHOD_NOT_ALLOWED', self.sup.dispatch, 'takeover', self.ref())
        self.assertRefused('METHOD_NOT_ALLOWED', self.sup.dispatch, 'input',
                           self.ref(input={'kind': 'key', 'key': 'Tab'}))
        self.assertRefused('METHOD_NOT_ALLOWED', self.sup.dispatch, 'observe', self.ref())
        # A6: the backend view is pixels only; a later frame waits a second.
        self.assertEqual(self.sup.dispatch('view', self.ref()),
                         {'png_base64': 'iVBORw0KGgo=', 'width': 1280, 'height': 800})
        self.assertRefused('VIEW_BUSY', self.sup.dispatch, 'view', self.ref())
        # The backend socket cannot select a proof workload or any other field.
        self.assertRefused('INVALID_LAUNCH', self.sup.dispatch, 'launch', {**launch_spec(ATTEMPT2, 2), 'workload': 'proof:cpu'})
        self.assertEqual(self.host.spawns, 1)
        self.assertTrue(self.sup.dispatch('view', self.ref(), operator=True)['png_base64'])
        self.assertRefused('ATTEMPT_NOT_ACTIVE', self.sup.dispatch, 'input',
                           self.ref(input={'kind': 'click', 'x': 1, 'y': 1}), operator=True)
        self.assertEqual(self.sup.dispatch('takeover', self.ref(), operator=True)['state'], 'human')
        self.assertRefused('TAKEN_OVER', self.sup.action, self.ref(action='read_session'))
        # A takeover is the host operator's: the backend cannot watch it.
        self.sup.views.clear()
        self.assertRefused('TAKEN_OVER', self.sup.dispatch, 'view', self.ref())
        self.assertIn('untrusted_page_url', self.sup.dispatch('view', self.ref(), operator=True))
        self.assertRefused('INVALID_INPUT', self.sup.dispatch, 'input', self.ref(input={'kind': 'eval'}), operator=True)
        self.sup.dispatch('input', self.ref(input={'kind': 'key', 'key': 'Escape'}), operator=True)
        receipt = self.sup.dispatch('stop', self.ref(reason='taken_over'), operator=True)['receipt']
        self.assertReceipt(receipt, 'taken_over')
        self.assertRefused('INVALID_REQUEST', self.sup.dispatch, 'stop', self.ref(reason='taken_over'))

    def test_launch_failure_boundary_refusal_and_readback_mismatch_fail_closed(self):
        with self.assertRaises(s.Refused) as caught:
            self.sup.launch(launch_spec(), workload='proof:fail')
        self.assertEqual(caught.exception.code, 'LAUNCH_FAILED')
        failed = self.sup.state['attempts'][ATTEMPT]
        self.assertEqual(failed['state'], 'stopped')
        self.assertReceipt(failed['receipt'], 'launch_failed')
        self.host.boundary_error = 'BOUNDARY_UNVERIFIED'
        self.assertRefused('BOUNDARY_UNVERIFIED', self.sup.launch, launch_spec(ATTEMPT2, 2))
        self.assertEqual(self.sup.state['attempts'][ATTEMPT2]['state'], 'refused')
        self.host.boundary_error = None
        third = '8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a'
        self.host.tamper = True
        self.assertRefused('LAUNCH_FAILED', self.sup.launch, launch_spec(third, 3))
        self.assertFalse(self.host.alive(s.UNIT_PREFIX + third))
        self.assertIsNone(self.sup.state['active'])
        self.assertRefused('VM_CAPACITY_INSUFFICIENT', self.sup.launch,
                           launch_spec('9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b', 4, limits={'memory_mib': 3500},
                                       run='2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'))
        self.assertEqual(self.host.spawns, 2)

    def test_restart_recovery_marks_uncertain_and_never_replays(self):
        self.sup.launch(launch_spec())
        with self.assertRaises(s.Refused):
            self.sup.action(self.ref(action='read_files'))   # the fixture hangs: channel uncertain
        time.sleep(0.5)
        for _ in range(50):
            if self.sup.state['attempts'][ATTEMPT]['state'] in s.TERMINAL:
                break
            time.sleep(0.1)
        attempt = self.sup.state['attempts'][ATTEMPT]
        self.assertEqual(attempt['actions'][0]['state'], 'uncertain')
        self.assertEqual(self.assertReceipt(attempt['receipt'], 'channel_lost')['uncertain_actions'], [1])
        # A crash between the durable reservation and delivery: a new process recovers.
        run2 = '0f1a2b3c-4d5e-4f6a-8b7c-8d9e0f1a2b3c'
        a2 = '1a2b3c4d-5e6f-4a7b-9c8d-9e0f1a2b3c4d'
        self.sup.launch(launch_spec(attempt=a2, run=run2))
        with self.sup.lock:
            run = self.sup.state['runs'][run2]
            run['action_count'] += 1
            self.sup.state['attempts'][a2]['actions'].append({'ordinal': 1, 'action': 'open_landing', 'state': 'started'})
            self.sup._save()
        restarted = self.make()
        self.assertEqual(restarted.recover(), [a2])
        recovered = restarted.state['attempts'][a2]
        self.assertEqual((recovered['state'], recovered['actions'][0]['state']), ('lost', 'uncertain'))
        payload = self.host.verify(recovered['receipt']['attestation'])[1]
        self.assertEqual((payload['reason'], payload['uncertain_actions']), ('supervisor_recovery', [1]))
        self.assertFalse(self.host.alive(s.UNIT_PREFIX + a2))
        self.assertEqual(self.host.seen.read_text().split(), ['read_files'])
        self.assertIsNone(restarted.state['active'])

    def test_guest_reboot_and_unknown_attempt_receipts(self):
        self.sup.launch(launch_spec())
        self.host.stop_unit(s.UNIT_PREFIX + ATTEMPT)
        self.host.boot = '11111111-2222-4333-8444-555555555555'
        for _ in range(50):
            self.sup.tick()
            if self.sup.state['attempts'][ATTEMPT]['state'] in s.TERMINAL:
                break
            time.sleep(0.1)
        payload = self.host.verify(self.sup.state['attempts'][ATTEMPT]['receipt']['attestation'])[1]
        self.assertTrue(payload['evidence']['guest_rebooted'])
        self.assertEqual(payload['bound_boot_id'], BOOT)
        never = self.sup.stop(self.ref(ATTEMPT2, 7, reason='failed'))['receipt']
        self.assertEqual(self.host.verify(never['attestation'])[1]['reason'], 'launch_refused')
        self.assertRefused('ATTEMPT_EXISTS', self.sup.launch, launch_spec(ATTEMPT2, 8))

    def test_teardown_unverified_keeps_attempt_live(self):
        self.sup.launch(launch_spec())
        stuck = {'boot_id': BOOT, 'members': [77], 'nobody': [77], 'mounted': [77],
                 'cgroup_exists': True, 'cgroup_populated': True}
        with patch.object(self.host, 'gone', lambda unit, device: stuck), \
                patch.object(s.time, 'sleep', lambda _: None):
            self.assertRefused('TEARDOWN_UNVERIFIED', self.sup.stop, self.ref(reason='cancelled'))
        self.assertEqual(self.sup.state['attempts'][ATTEMPT]['state'], 'stopping')
        self.assertRefused('ACTIVE_ATTEMPT', self.sup.launch, launch_spec(ATTEMPT2, 2))
        self.assertReceipt(self.sup.stop(self.ref(reason='cancelled'))['receipt'], 'cancelled')

    def test_orphan_units_are_stopped_on_recovery(self):
        self.host.spawn(s.UNIT_PREFIX + ATTEMPT2, ['User=nobody'], '', {'attempt_id': ATTEMPT2, 'workload': 'browser'})
        self.assertTrue(self.host.alive(s.UNIT_PREFIX + ATTEMPT2))
        self.sup.recover()
        time.sleep(0.2)
        self.assertFalse(self.host.alive(s.UNIT_PREFIX + ATTEMPT2))

    def test_backend_view_is_bounded_pixels_that_never_renew_the_lease(self):
        self.sup.launch(launch_spec())
        lease = self.sup.state['attempts'][ATTEMPT]['lease']
        self.clock.value += 5
        frame = self.sup.dispatch('view', self.ref())
        self.assertEqual(set(frame), {'png_base64', 'width', 'height'})
        # Watching never keeps an attempt alive; only the coordinator's renew does.
        self.assertEqual(self.sup.state['attempts'][ATTEMPT]['lease'], lease)
        self.assertRefused('VIEW_BUSY', self.sup.dispatch, 'view', self.ref())
        with patch.object(s.time, 'monotonic', lambda: 10 ** 9):
            self.assertEqual(self.sup.dispatch('view', self.ref())['width'], 1280)
        self.assertRefused('STALE_FENCE', self.sup.dispatch, 'view', self.ref(fence=2))
        self.assertRefused('INVALID_REQUEST', self.sup.dispatch, 'view', self.ref(url='https://example.com'))
        self.assertRefused('UNKNOWN_ATTEMPT', self.sup.dispatch, 'view', self.ref(attempt=ATTEMPT2))
        for bad in ({'png_base64': 'aGVsbG8=', 'width': 1280, 'height': 800},
                    {'png_base64': 'not base64!', 'width': 1280, 'height': 800},
                    {'png_base64': 'iVBORw0KGgo=', 'width': 0, 'height': 800},
                    {'png_base64': 'iVBORw0KGgo=' + 'A' * s.MAX_VIEW_BASE64, 'width': 1280, 'height': 800},
                    {'width': 1280, 'height': 800}, None):
            self.assertRefused('VIEW_INVALID', s.frame_only, bad)
        self.clock.value = self.sup.state['attempts'][ATTEMPT]['lease'] + 1
        self.sup.views.clear()
        self.assertRefused('LEASE_EXPIRED', self.sup.dispatch, 'view', self.ref())

    def test_socket_methods_are_separated_and_root_only(self):
        backend = self.root / 'b.sock'
        operator = self.root / 'o.sock'
        servers = [s.listen(backend, self.sup, False), s.listen(operator, self.sup, True)]
        try:
            def silent(path):
                with socket.socket(socket.AF_UNIX) as client:
                    client.connect(str(path))
                    client.sendall(b'{"method":"status"}\n')
                    try:
                        return client.makefile().readline()
                    except ConnectionResetError:
                        return ''
            # Production accepts uid 0 only: any other local user gets no answer.
            for server in servers:
                server.peer_uid = os.getuid() + 1
            self.assertEqual(silent(backend), '')
            for server in servers:
                server.peer_uid = os.getuid()
            def call(path, method, params=None, raw=None):
                with socket.socket(socket.AF_UNIX) as client:
                    client.connect(str(path))
                    client.sendall(raw or (json.dumps({'method': method, 'params': params or {}}) + '\n').encode())
                    return json.loads(client.makefile().readline())
            self.assertEqual(oct(os.stat(backend).st_mode & 0o777), '0o600')
            self.assertEqual(call(backend, 'journal', {'attempt_id': ATTEMPT})['error'], 'METHOD_NOT_ALLOWED')
            self.assertEqual(call(backend, 'x', raw=b'not json\n')['error'], 'INVALID_REQUEST')
            self.assertEqual(call(operator, 'journal', {'attempt_id': ATTEMPT})['error'], 'UNKNOWN_ATTEMPT')
            launched = call(backend, 'launch', launch_spec())
            self.assertTrue(launched['ok'], launched)
            self.assertEqual(call(backend, 'status')['result']['active']['attempt_id'], ATTEMPT)
            self.assertTrue(call(operator, 'journal', {'attempt_id': ATTEMPT})['ok'])
            self.assertTrue(call(backend, 'stop', self.ref(reason='cancelled'))['ok'])
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()


guest_spec = importlib.util.spec_from_file_location('worker_guest_tests', ROOT / 'tests' / 'test_a3_worker_guest.py')
guest_tests = importlib.util.module_from_spec(guest_spec)
guest_spec.loader.exec_module(guest_tests)


class LocalHost(FakeHost):
    """The real guest runner and Chromium as a local process instead of a unit."""

    def __init__(self, root, source):
        super().__init__(root)
        self.source = source

    def spawn(self, unit, properties, source, config):
        self.spawns += 1
        self.props[unit] = properties
        process = subprocess.Popen([sys.executable, '-I', '-c', self.source, json.dumps(config)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   bufsize=0, start_new_session=True)
        self.units[unit] = process
        return process


@unittest.skipUnless(Path(guest_tests.LOCAL_CHROMIUM).exists() and shutil.which('openssl'),
                     'local Chromium and openssl are required for the end-to-end supervisor test')
class SupervisorBrowserTests(unittest.TestCase):
    """Supervisor -> runner -> Chromium -> CONNECT proxy -> pinned origin, locally."""

    @classmethod
    def setUpClass(cls):
        guest_tests.LocalBrowserTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        guest_tests.LocalBrowserTests.tearDownClass.__func__(cls)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        source = (ROOT / 'a3-worker-guest.py').read_text()
        workspace = root / 'workspace'
        workspace.mkdir()
        for old, new in (("PROXY = '10.185.17.1:18083'", "PROXY = %r" % guest_tests.g.PROXY),
                         ("CHROMIUM = '/usr/bin/chromium'", "CHROMIUM = %r" % guest_tests.g.CHROMIUM),
                         ("WORKSPACE = '/tmp'", "WORKSPACE = %r" % str(workspace))):
            self.assertEqual(source.count(old), 1)
            source = source.replace(old, new)
        self.host = LocalHost(root, source)
        spki = self.spki
        self.host.full_boundary = lambda: dict(FakeHost.full_boundary(self.host), spki=spki)
        self.patches = [patch.object(s.installer, 'secure', lambda path: None)]
        for item in self.patches:
            item.start()
        self.sup = s.Supervisor(host=self.host, journal=root / 'state.json', runner_source=source, clock=Clock())
        self.sup.state['supervisor_sha256'] = 'c' * 64

    def tearDown(self):
        for unit in list(self.host.units):
            self.host.stop_unit(unit)
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    def test_supervised_browser_actions_takeover_and_receipt(self):
        guest_tests.Origin.seen.clear()
        self.origin.redirect = False
        launched = self.sup.launch(launch_spec(limits={'max_actions': 6}))
        self.assertEqual(launched['workspace']['kind'], 'unit-private-tmpfs')
        ref = {'run_id': RUN, 'attempt_id': ATTEMPT, 'fence': 1}
        self.assertEqual(self.sup.action(dict(ref, action='open_landing'))['result'], {'at': 'landing'})
        self.assertEqual(self.sup.action(dict(ref, action='open_login'))['result'], {'at': 'login_dialog'})
        self.assertEqual(self.sup.action(dict(ref, action='read_session'))['result'],
                         {'untrusted_page_claim_authenticated': False})
        with self.assertRaises(s.Refused) as caught:
            self.sup.action(dict(ref, action='submit_bound_fixture', binding_id=WORKSPACE))
        self.assertEqual(caught.exception.code, 'CREDENTIAL_NOT_BOUND')
        probe = self.sup.dispatch('egress_probe', ref, operator=True)
        self.assertEqual(set(probe['page_attempts'].values()), {'refused'})
        self.assertTrue(base64.b64decode(self.sup.dispatch('view', ref, operator=True)['png_base64']).startswith(b'\x89PNG'))
        self.sup.dispatch('takeover', ref, operator=True)
        with self.assertRaises(s.Refused) as caught:
            self.sup.action(dict(ref, action='read_session'))
        self.assertEqual(caught.exception.code, 'TAKEN_OVER')
        self.sup.dispatch('input', dict(ref, input={'kind': 'key', 'key': 'Escape'}), operator=True)
        self.assertFalse(self.sup.dispatch('observe', ref, operator=True)['untrusted_dialog_open'])
        point = self.sup.dispatch('locate', dict(ref, target='sign_in_button'), operator=True)
        self.sup.dispatch('input', dict(ref, input={'kind': 'click', 'x': point['x'], 'y': point['y']}), operator=True)
        self.assertTrue(self.sup.dispatch('observe', ref, operator=True)['untrusted_dialog_open'])
        receipt = self.sup.dispatch('stop', dict(ref, reason='taken_over'), operator=True)['receipt']
        valid, payload = self.host.verify(receipt['attestation'])
        self.assertTrue(valid)
        self.assertEqual((payload['reason'], payload['actions_performed']), ('taken_over', 3))
        self.assertFalse(self.host.alive(s.UNIT_PREFIX + ATTEMPT))
        self.assertTrue(all(host == 'demo.fractionate.ai' for _, _, host in guest_tests.Origin.seen))
