"""The A7 proof harness end to end, against the real supervisor and broker.

`a7-probe.mjs` (the candidate's coordinator and A7 agent-run service, a proof
SQLite database) runs as a separate Node process against the REAL A3 Supervisor
(with the live install record and a TURN secret) and A4 Broker classes served on
their real socket servers (uid 0 peers only), with a scripted guest runner that
speaks the live relay like the real one, a scripted provider, and a scripted
viewer in place of the WebRTC probe. The real WebRTC path (Neko, coturn, the
probe and the dashboard's client in Chromium) is test_a7_live_e2e.py; this test
proves the harness's own logic before it costs a host run. Every case must
pass, and nothing but typed fields may reach the report, the proof database or
the log.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


harness5 = load('a7h_a5_harness_tests', ROOT / 'tests' / 'test_a5_probe_harness.py')
cred_tests, broker_tests = harness5.cred_tests, harness5.broker_tests
s, b = harness5.s, harness5.b

# The A5 scripted runner (credential FIFO, fixture modes from a file; `slow`
# answers `timeout` like the real proxy after 8 s), plus the live relay: relay
# operations answered at once by a reader thread, control queued behind the
# current command like the real runner. Neko is emulated: input counts only
# from the viewer holding control (the scripted viewer writes what it sends).
FAKE_RUNNER = r'''
import json, os, queue, sys, threading, time
config = json.loads(sys.argv[1])
workspace, mode_file, input_file = os.environ['A5_FAKE_WORKSPACE'], os.environ['A5_FAKE_MODE'], os.environ['A7_FAKE_INPUT']
fifo = os.path.join(workspace, 'pp-a4-credential')
state = {'submitted': False, 'signed': False, 'controller': None, 'offset': 0}
OUTCOMES = {'normal': 'signed_in', 'expired': 'rejected', 'locked': 'rate_limited', 'challenge': 'challenge_required',
            'redirect': 'unexpected_origin', 'slow': 'timeout'}
lock = threading.Lock()
conns = set()
def emit(value):
    with lock:
        print(json.dumps(value), flush=True)
ready = {'event': 'ready', 'workload': config['workload'], 'workspace': {'device': '0:99', 'fstype': 'tmpfs', 'size_kib': 1024},
         'browser_pid': os.getpid(), 'browser_start_seconds': 0.1}
if config.get('live'):
    ready['live'] = {'udp_port': 18091, 'neko_sha256': 'e' * 64, 'policy_sha256': 'd' * 64}
emit(ready)
inbox = queue.Queue()
def counts(since, conn):
    out = {'key': 0, 'click': 0, 'scroll': 0}
    try:
        with open(input_file) as stream:
            stream.seek(since)
            for line in stream:
                who, kind, n = line.split()
                if who == conn:
                    out[kind] += int(n)
    except OSError:
        pass
    return out
def size():
    try:
        return os.path.getsize(input_file)
    except OSError:
        return 0
def reader():
    for line in sys.stdin:
        command = json.loads(line)
        op = command['op']
        if op == 'live_open':
            conns.add(command['conn'])
            emit({'id': command['id'], 'ok': True, 'result': {'conn': command['conn']}})
            emit({'event': 'live', 'conn': command['conn'], 'data': {'event': 'system/init', 'payload': {
                'session_id': command['conn'], 'control_host': {'has_host': False}, 'screen_size': {'width': 1280, 'height': 800},
                'sessions': {'someone': {}}}}})
        elif op == 'live_send':
            data = command.get('data') or {}
            if data.get('event') == 'signal/request':
                emit({'event': 'live', 'conn': command['conn'], 'data': {'event': 'signal/provide', 'payload': {
                    'sdp': 'v=0', 'iceservers': [{'urls': ['stun:inside.invalid']}]}}})
        elif op == 'live_close':
            conns.discard(command['conn'])
            emit({'id': command['id'], 'ok': True, 'result': {'closed': True}})
            emit({'event': 'live_closed', 'conn': command['conn'], 'reason': 'viewer_closed'})
        else:
            inbox.put(command)
    inbox.put(None)
threading.Thread(target=reader, daemon=True).start()
while True:
    command = inbox.get()
    if command is None:
        break
    op, reply = command['op'], {'id': command['id'], 'ok': True, 'result': {}}
    action = command.get('action')
    if op == 'action' and action == 'submit_bound_fixture':
        os.mkfifo(fifo, 0o600)
        fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
        emit({'event': 'credential_channel', 'binding_id': command['binding_id']})
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
        if not data:
            reply = {'id': command['id'], 'ok': False, 'error': 'CREDENTIAL_NOT_DELIVERED'}
        else:
            try:
                mode = json.load(open(mode_file))['mode']
            except (OSError, ValueError):
                mode = 'normal'
            time.sleep(0.5)
            state['submitted'], state['signed'] = True, mode == 'normal'
            reply['result'] = {'binding_id': command['binding_id'], 'outcome': OUTCOMES[mode], 'login_requests': 1,
                               'untrusted_page_claim_authenticated_as_bound_account': state['signed']}
    elif op == 'action':
        signed, submitted = state['signed'], state['submitted']
        reply['result'] = {
            'open_landing': {'at': 'landing'}, 'open_login': {'at': 'login_dialog'}, 'read_workspace': {'at': 'workspace'},
            'read_session': dict({'untrusted_page_claim_authenticated': False},
                                 **({'untrusted_page_claim_authenticated_as_bound_account': signed} if submitted else {})),
            'read_files': {'untrusted_page_claim_sample_present': signed},
            'sign_out': {'untrusted_page_claim_signed_out': True}}[action]
    elif op == 'live_give':
        state['controller'], state['offset'] = command['conn'], size()
        for conn in list(conns):
            emit({'event': 'live', 'conn': conn, 'data': {'event': 'control/host', 'payload': {'has_host': True, 'host_id': command['conn']}}})
        reply['result'] = {'controlling': True, 'uncontrolled_inputs': {'key': 0, 'click': 0, 'scroll': 0}, 'password_fields_empty': True}
    elif op == 'live_release':
        reply['result'] = {'inputs': counts(state['offset'], state['controller'])}
        state['controller'] = None
    elif op == 'view':
        reply['result'] = {'png_base64': 'iVBORw0KGgo=', 'width': 1280, 'height': 800}
    elif op == 'stop':
        reply['result'] = dict({'stopping': True}, **({'logout': 'done'} if state['submitted'] else {}))
        emit(reply)
        sys.exit(0)
    emit(reply)
'''

# The WebRTC probe's command line and JSON lines, without WebRTC: it opens the
# relay, answers the signalling, "connects", and (with -control) writes the
# input it sends for the scripted runner to count.
FAKE_VIEWER = r'''#!/usr/bin/env python3
import json, os, socket, sys, threading, time
args, flags = {}, set()
argv = sys.argv[1:]
i = 0
while i < len(argv):
    name = argv[i].lstrip('-')
    if name in ('control', 'force-input', 'bad-credential', 'verbose'):
        flags.add(name); i += 1
    else:
        args[name] = argv[i + 1]; i += 2
def out(value):
    print(json.dumps(value), flush=True)
s = socket.socket(socket.AF_UNIX)
s.connect(args['socket'])
f = s.makefile('rwb')
def send(value):
    f.write((json.dumps(value) + '\n').encode()); f.flush()
send({'method': 'live', 'params': {'run_id': args['run'], 'attempt_id': args['attempt'], 'fence': 1}})
first = json.loads(f.readline())
if not first.get('ok'):
    out({'event': 'refused', 'code': first.get('error')}); sys.exit(2)
opened = first['result']
server = opened['ice_servers'][0]
out({'event': 'opened', 'conn': opened['conn'], 'turn_url': [u for u in server['urls'] if u.endswith('transport=udp')][0],
     'ttl_seconds': opened['ttl_seconds'], 'username_expiry_and_viewer': server['username'].endswith(':' + opened['conn'])})
state = {'session': None, 'host': None, 'closed': None, 'provide': False}
def reader():
    for raw in f:
        line = json.loads(raw)
        if 'closed' in line:
            state['closed'] = line['closed']; return
        message = line.get('recv') or {}
        if message.get('event') == 'system/init':
            state['session'] = message['payload']['session_id']
        elif message.get('event') == 'signal/provide':
            state['provide'] = 'iceservers' not in message.get('payload', {})
            send({'send': {'event': 'signal/answer', 'payload': {'sdp': 'v=0'}}})
        elif message.get('event') == 'control/host':
            state['host'] = message['payload'].get('host_id')
    state['closed'] = state['closed'] or 'socket_closed'
threading.Thread(target=reader, daemon=True).start()
if 'relay-check' in args:
    peers = args['relay-check'].split(',')
    transport = args.get('relay-transport', 'udp')
    out({'event': 'relay_check', 'transport': transport, 'allocated': True,
         'tls': {'verified_name': 'turn.example.test'} if transport == 'tls' else None, 'peers': dict(
        [(peers[0], 'permitted')] + [(p, 'refused: CreatePermission error response (error 403: Forbidden IP)') for p in peers[1:]])})
    send({'close': True}); sys.exit(0)
if 'bad-credential' in flags:
    time.sleep(1)
    out({'event': 'report', 'connected': False, 'closed': 'timeout', 'transport': 'udp'})
    send({'close': True}); sys.exit(0)
send({'send': {'event': 'signal/request', 'payload': {'video': {}, 'audio': {'disabled': True}}}})
started = time.monotonic()
while not state['provide'] and time.monotonic() - started < 10:
    time.sleep(0.05)
pair = {'local': 'relay', 'local_protocol': 'udp', 'remote': 'host', 'remote_port': 18091}
out({'event': 'connected', 'after_ms': 120, 'pair': pair})
sent = {}
def record(kind, n):
    with open(os.environ['A7_FAKE_INPUT'], 'a') as stream:
        stream.write('%s %s %d\n' % (opened['conn'], kind, n))
if 'control' in flags:
    record('key', 2); record('click', 1)
    out({'event': 'ready_for_control', 'session_known': state['session'] is not None})
    for line in sys.stdin:
        if line.strip() == 'control':
            break
    deadline = time.monotonic() + 15
    while 'force-input' not in flags and state['host'] != opened['conn']:
        if time.monotonic() > deadline:
            out({'event': 'error', 'code': 'NOT_GIVEN_CONTROL'}); sys.exit(1)
        time.sleep(0.05)
    keys = int(args.get('keys', 5))
    record('key', keys); record('click', 1); record('scroll', 2)
    sent = {'key': keys, 'click': 1, 'scroll': 2}
    out({'event': 'input_sent', 'sent': sent, 'before_control': {'key': 2, 'click': 1}})
seconds = int(args.get('seconds', 10))
while time.monotonic() - started < seconds and not state['closed']:
    time.sleep(0.1)
out({'event': 'report', 'connected': True, 'transport': 'udp', 'pair': pair, 'frames': 25 * seconds, 'packets': 100,
     'bytes': 1000, 'seconds': seconds, 'input_sent': sent, 'fps': 25.0, **({'closed': state['closed']} if state['closed'] else {})})
try:
    send({'close': True})
except OSError:
    pass
'''


class HarnessHost(cred_tests.A4Host):
    def spawn(self, unit, properties, source, config):
        self.spawns += 1
        self.props[unit] = properties
        env = dict(os.environ, A5_FAKE_WORKSPACE=str(self.workspace), A5_FAKE_MODE=str(self.mode),
                   A7_FAKE_INPUT=str(self.input))
        process = subprocess.Popen([sys.executable, '-c', FAKE_RUNNER, json.dumps(config)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                   start_new_session=True, env=env)
        self.units[unit] = process
        return process


class ProviderHost(harness5.ProviderHost):
    """Answers the model steps as in A5, and a summary request with a sentence."""

    def provider(self, url, key, body):
        prompt = body['messages'][0]['content']
        if 'ALLOWED:' not in prompt:
            self.prompts.append(prompt)
            return broker_tests.completion(prompt=len(prompt) // 4, completion_tokens=12, choices=[
                {'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant',
                                                                   'content': 'The run signed in and was verified.'}}])
        return super().provider(url, key, body)


@unittest.skipUnless(shutil.which('openssl') and shutil.which('node') and os.geteuid() == 0,
                     'openssl, node and root (the sockets answer uid 0 peers only) are required')
class A7ProbeHarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        marker = self.root / 'live.json'
        marker.write_text(json.dumps({'version': 1, 'turn': {'urls': [
            'turn:turn.example.test:3478?transport=udp', 'turn:turn.example.test:3478?transport=tcp',
            'turns:turn.example.test:5349?transport=tcp']}}))
        secret = self.root / 'turn-secret'
        secret.write_text('s' * 64 + '\n')
        self.patches = [patch.object(s.installer, 'secure', lambda path: None), patch.object(b, 'secure', lambda path: None),
                        patch.object(s, 'ACTION_SECONDS', 10), patch.object(s, 'READY_SECONDS', 10),
                        patch.object(s, 'LIVE_MARKER', marker), patch.object(s, 'TURN_SECRET', secret)]
        for item in self.patches:
            item.start()
        self.host = HarnessHost(self.root)
        self.host.mode = self.root / 'mode.json'
        self.host.input = self.root / 'input.txt'
        self.provider = ProviderHost(self.host, str(self.host.workspace))
        self.broker = b.Broker(host=self.provider, vault=broker_tests.FakeVault(), journal=self.root / 'broker.json')
        self.broker.price_set(broker_tests.PRICE)
        self.broker.provider_bind({'vault_key': 'openai-api-key'})
        self.host.broker_object = self.broker
        self.sup = s.Supervisor(host=self.host, journal=self.root / 'state.json', runner_source='# fixture')
        self.sup.state['supervisor_sha256'] = 'c' * 64
        self.sockets = {name: self.root / (name + '.sock') for name in ('backend', 'operator', 'broker')}
        self.servers = [s.listen(self.sockets['backend'], self.sup, False),
                        s.listen(self.sockets['operator'], self.sup, True),
                        b.listen(self.sockets['broker'], self.broker)]
        viewer = self.root / 'viewer'
        viewer.write_text(FAKE_VIEWER)
        viewer.chmod(viewer.stat().st_mode | stat.S_IXUSR)
        self.env = dict(os.environ, A5_PROBE_BACKEND_SOCKET=str(self.sockets['backend']),
                        A5_PROBE_OPERATOR_SOCKET=str(self.sockets['operator']),
                        A5_PROBE_BROKER_SOCKET=str(self.sockets['broker']), A5_PROBE_PUBLIC_KEY=str(self.host.pub),
                        A5_PROBE_VAULT_KEY='a4-fixture-password', A5_PROBE_APPROVAL_SECONDS='60',
                        A7_PROBE_ROOT=str(self.root / 'proof'), A7_PROBE_VIEWER=str(viewer),
                        A7_PROBE_FIXTURES='file:%s' % self.host.mode, A7_FAKE_INPUT=str(self.host.input),
                        A7_PROBE_HELD_SECONDS='60')

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for unit in list(self.host.units):
            self.host.stop_unit(unit)
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    def run_harness(self, *args):
        result = subprocess.run(['node', str(ROOT / 'a7-probe.mjs'), *args], env=self.env, capture_output=True,
                                text=True, timeout=900)
        lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        return result, lines

    def test_every_case_passes_against_the_real_supervisor_and_broker(self):
        result, lines = self.run_harness()
        final = lines[-1] if lines else {}
        failed = [line for line in lines if line.get('passed') is False]
        self.assertEqual(final.get('a7_proof'), 'passed', (failed, result.stderr[-3000:]))
        self.assertEqual(result.returncode, 0)
        report = json.loads(Path(final['report']).read_text())
        self.assertEqual([c['case'] for c in report['cases']], [
            'live_view', 'live_refusals', 'dashboard_takeover', 'resume_new_run', 'takeover_during_submit',
            'grant_loss_while_holding', 'coordinator_killed_while_holding', 'timeout_is_a_decision',
            'model_proof_switches', 'model_summary'])
        observed = {c['case']: c['observed'] for c in report['cases']}
        self.assertEqual(observed['dashboard_takeover']['counted'], {'key': 5, 'click': 1, 'scroll': 2})
        self.assertEqual(observed['dashboard_takeover']['journal']['stop_reason'], 'taken_over')
        self.assertEqual(observed['resume_new_run']['result']['result_class'], 'verified_account')
        self.assertEqual(observed['coordinator_killed_while_holding']['end_reason'], 'coordinator_restart')
        self.assertEqual(observed['model_proof_switches']['reply_outside_set']['result']['result_class'], 'model_choice_invalid')
        self.assertEqual(observed['model_summary']['summary']['state'], 'written')
        # Typed fields only in the report and the log: no model text, no TURN
        # credential. The summary itself lives in the database by design (the
        # Review tab shows it), labelled as model text.
        proof_dir = Path(report['dir'])
        for path in proof_dir.iterdir():
            if path.is_file() and path.suffix in ('.json', '.log'):
                data = path.read_bytes()
                for needle in (b'The run signed in and was verified.', b'credential":"'):
                    self.assertNotIn(needle, data, (path.name, needle))
        self.assertTrue(all(self.broker.state['bindings'][i]['state'] == 'revoked' for i in report['bindings']))
        self.assertEqual(report['cleanup']['fixture'], 'normal')
        self.assertIsNone(self.sup.state['active'])


if __name__ == '__main__':
    unittest.main()
