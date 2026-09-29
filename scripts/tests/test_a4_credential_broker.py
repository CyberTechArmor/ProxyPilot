import base64
import copy
import decimal
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('a4_broker', ROOT / 'a4-credential-broker.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
fence_spec = importlib.util.spec_from_file_location('a4_fence', ROOT / 'a3-network-fence.py')
fence = importlib.util.module_from_spec(fence_spec)
fence_spec.loader.exec_module(fence)

PROJECT = '11111111-1111-4111-8111-111111111111'
PROFILE = '22222222-2222-4222-8222-222222222222'
BINDING = '33333333-3333-4333-8333-333333333333'
RUN = '44444444-4444-4444-8444-444444444444'
RUN2 = '55555555-5555-4555-8555-555555555555'
ATTEMPT = '66666666-6666-4666-8666-666666666666'
CALL = '77777777-7777-4777-8777-777777777777'
USERNAME = 'a4-fixture@demo.fractionate.ai'
SECRET = 'A4-canary-Kq7vX2mP9wLr'
PROVIDER_SECRET = 'sk-test-a4-capped-000111'
PRICE = {'model': 'gpt-6-luna', 'input': '0.10', 'cached_input': '0.01', 'cache_write': '0.125', 'output': '0.50'}


class FakeVault:
    def __init__(self):
        self.config = {'kv_mount': 'pp-kv', 'agent': 'a4-broker'}
        self.values = {'a4-fixture-password': [SECRET], 'openai-api-key': [PROVIDER_SECRET]}
        self.reads = 0
        self.on_read = None
        self.handed_out = []

    def path(self, key):
        return 'agents/a4-broker/' + key

    def current_version(self, key):
        if key not in self.values:
            raise b.Refused('VAULT_KEY_MISSING')
        return len(self.values[key])

    def read(self, key, version):
        self.reads += 1
        if self.on_read:
            self.on_read()
        if self.current_version(key) != version:
            raise b.Refused('VAULT_VERSION_MISMATCH')
        value = bytearray(self.values[key][version - 1].encode())
        self.handed_out.append(value)
        return value

    def healthy(self):
        return True


class FakeHost:
    def __init__(self):
        self.frames = []
        self.pid_error = None
        self.write_error = None
        self.responses = []
        self.requests = []
        self.keys = []

    def guest_main_pid(self, unit):
        if self.pid_error:
            raise b.Refused(self.pid_error)
        self.unit = unit
        return 4321

    def write_credential(self, pid, unit, data):
        if self.write_error:
            raise b.Refused(self.write_error)
        self.frames.append((pid, unit, bytes(data)))

    def provider(self, url, key, body):
        self.requests.append((url, json.loads(json.dumps(body))))
        self.keys.append(key)
        self.seen_key = bytes(key)
        answer = self.responses.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer


def completion(prompt=12, completion_tokens=5, cached=0, model='gpt-6-luna-2026-09-23', tier='default', **extra):
    body = {'id': 'chatcmpl-a4proof', 'object': 'chat.completion', 'model': model, 'service_tier': tier,
            'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': 'OK'}}],
            'usage': {'prompt_tokens': prompt, 'completion_tokens': completion_tokens,
                      'total_tokens': prompt + completion_tokens,
                      'prompt_tokens_details': {'cached_tokens': cached},
                      'completion_tokens_details': {'reasoning_tokens': 0}}}
    body.update(extra)
    return 200, body


def encodings(value):
    raw = value.encode()
    return [value, json.dumps(value)[1:-1], base64.b64encode(raw).decode(), base64.urlsafe_b64encode(raw).decode(),
            hashlib.sha256(raw).hexdigest()]


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patch = patch.object(b, 'secure', lambda path: None)
        self.patch.start()
        self.vault, self.host = FakeVault(), FakeHost()
        self.broker = b.Broker(host=self.host, vault=self.vault, journal=self.root / 'state.json')

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(b.Refused) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception.detail)

    def bind(self):
        return self.broker.bind({'binding_id': BINDING, 'project_id': PROJECT, 'profile_id': PROFILE,
                                 'username': USERNAME, 'vault_key': 'a4-fixture-password'})

    def credential(self, revision=1):
        return {'project_id': PROJECT, 'profile_id': PROFILE, 'profile_revision': 2, 'binding_id': BINDING,
                'binding_revision': revision}

    def pin(self, run=RUN, revision=1, limits=None, credential=True):
        return self.broker.pin_run({'run_id': run, 'project_limits_revision': 3, 'limits': limits or {},
                                    'credential': self.credential(revision) if credential else None})

    def journal_text(self):
        return (self.root / 'state.json').read_text()

    def assertNoSecret(self, text):
        for secret in (SECRET, PROVIDER_SECRET):
            for form in encodings(secret):
                self.assertNotIn(form, text)

    def test_constants_match_the_installed_a3_proof_vm(self):
        self.assertEqual((b.VM, b.VM_UUID), (fence.VM, fence.PROOF_UUID))
        self.assertEqual(sorted(b.MODEL_ROUTES), ['gpt-6-luna'])
        self.assertEqual(b.MODEL_ROUTES['gpt-6-luna']['url'], 'https://api.openai.com/v1/chat/completions')

    def test_binding_stores_path_and_version_never_a_value(self):
        record = self.bind()
        self.assertEqual(record['vault'], {'mount': 'pp-kv', 'path': 'agents/a4-broker/a4-fixture-password',
                                           'key': 'a4-fixture-password', 'version': 1})
        self.assertEqual((record['revision'], record['state']), (1, 'active'))
        self.assertRefused('BINDING_EXISTS', self.bind)
        for bad in ({'username': 'Not An Email'}, {'binding_id': 'x'}, {'vault_key': '../x'}, {'value': SECRET}):
            params = {'binding_id': BINDING, 'project_id': PROJECT, 'profile_id': PROFILE, 'username': USERNAME,
                      'vault_key': 'a4-fixture-password', **bad}
            with self.assertRaises(b.Refused):
                self.broker.bind(params)
        self.assertEqual(self.vault.reads, 0)
        self.assertNoSecret(self.journal_text())

    def test_pinning_rotation_and_revocation_at_launch_and_submit(self):
        self.bind()
        self.assertRefused('RUN_NOT_PINNED', self.broker.check, {'run_id': RUN, 'binding_id': BINDING})
        self.assertRefused('BINDING_REVISION_MISMATCH', self.pin, RUN, 2)
        self.assertEqual(self.pin(), {'pinned': True, 'existing': False})
        self.assertEqual(self.pin(), {'pinned': True, 'existing': True})
        self.assertRefused('RUN_POLICY_MISMATCH', self.pin, RUN, 1, {'max_usd': 1})
        wrong_scope = dict(self.credential(), project_id=PROFILE)
        self.assertRefused('BINDING_SCOPE_MISMATCH', self.broker.pin_run,
                           {'run_id': RUN2, 'project_limits_revision': 3, 'limits': {}, 'credential': wrong_scope})
        self.assertEqual(self.broker.check({'run_id': RUN, 'binding_id': BINDING})['binding_revision'], 1)
        # Delivery: fetched at delivery time, written once to the worker's FIFO, never returned.
        result = self.broker.deliver({'run_id': RUN, 'attempt_id': ATTEMPT, 'binding_id': BINDING})
        self.assertEqual(result, {'delivered': True, 'binding_id': BINDING, 'binding_revision': 1})
        pid, unit, data = self.host.frames[0]
        self.assertEqual((pid, unit), (4321, b.UNIT_PREFIX + ATTEMPT))
        user, secret = USERNAME.encode(), SECRET.encode()
        self.assertEqual(data, b'PPA4' + len(user).to_bytes(2, 'big') + user + len(secret).to_bytes(2, 'big') + secret)
        self.assertEqual(self.vault.handed_out[-1], bytearray(len(secret)))   # wiped after use
        self.assertNotIn(SECRET, json.dumps(result))
        # Rotation: a new vault version and binding revision refuse the old revision
        # at the next submit and at launch; a run pinned to the new revision works.
        self.vault.values['a4-fixture-password'].append('A4-canary-rotated-2')
        self.assertRefused('VAULT_VERSION_MISMATCH', self.broker.deliver,
                           {'run_id': RUN, 'attempt_id': ATTEMPT, 'binding_id': BINDING})
        self.assertRefused('BINDING_REVISION_MISMATCH', self.broker.rotate, {'binding_id': BINDING,
                                                                            'expected_revision': 9})
        rotated = self.broker.rotate({'binding_id': BINDING, 'expected_revision': 1})
        self.assertEqual((rotated['revision'], rotated['vault']['version']), (2, 2))
        self.assertRefused('BINDING_REVISION_MISMATCH', self.broker.check, {'run_id': RUN, 'binding_id': BINDING})
        self.assertRefused('BINDING_REVISION_MISMATCH', self.broker.deliver,
                           {'run_id': RUN, 'attempt_id': ATTEMPT, 'binding_id': BINDING})
        self.assertRefused('BINDING_REVISION_MISMATCH', self.pin)   # relaunch of the old run
        self.assertRefused('BINDING_REVISION_MISMATCH', self.pin, RUN2, 1)
        self.pin(RUN2, 2)
        self.broker.deliver({'run_id': RUN2, 'attempt_id': ATTEMPT, 'binding_id': BINDING})
        self.assertTrue(self.host.frames[-1][2].endswith(b'A4-canary-rotated-2'))
        # Revocation refuses immediately, at submit and at launch.
        self.assertEqual(self.broker.revoke({'binding_id': BINDING})['state'], 'revoked')
        self.assertRefused('BINDING_REVOKED', self.broker.check, {'run_id': RUN2, 'binding_id': BINDING})
        self.assertRefused('BINDING_REVOKED', self.broker.deliver,
                           {'run_id': RUN2, 'attempt_id': ATTEMPT, 'binding_id': BINDING})
        self.assertRefused('BINDING_REVOKED', self.pin, '88888888-8888-4888-8888-888888888888', 2)
        self.assertRefused('BINDING_REVOKED', self.broker.rotate, {'binding_id': BINDING, 'expected_revision': 2})
        self.assertEqual(len(self.host.frames), 2)
        ledger = self.broker.ledger({})
        self.assertEqual([d['outcome'] for d in ledger['deliveries']],
                         ['delivered', 'refused:VAULT_VERSION_MISMATCH', 'refused:BINDING_REVISION_MISMATCH',
                          'delivered', 'refused:BINDING_REVOKED'])
        self.assertNoSecret(self.journal_text())
        self.assertNotIn('A4-canary-rotated-2', self.journal_text())

    def test_revocation_while_fetching_wins_and_unbound_runs_are_refused(self):
        self.bind()
        self.pin()
        self.pin(RUN2, credential=False)
        self.assertRefused('CREDENTIAL_NOT_BOUND', self.broker.check, {'run_id': RUN2, 'binding_id': BINDING})
        self.assertRefused('BINDING_MISMATCH', self.broker.check, {'run_id': RUN, 'binding_id': PROJECT})
        self.vault.on_read = lambda: self.broker.revoke({'binding_id': BINDING})
        self.assertRefused('BINDING_REVOKED', self.broker.deliver,
                           {'run_id': RUN, 'attempt_id': ATTEMPT, 'binding_id': BINDING})
        self.assertEqual(self.host.frames, [])
        self.assertEqual(self.vault.handed_out[-1], bytearray(len(SECRET)))

    def test_unprintable_values_and_worker_errors_refuse_without_detail(self):
        self.bind()
        self.pin()
        self.host.pid_error = 'WORKER_NOT_RUNNING'
        self.assertRefused('WORKER_NOT_RUNNING', self.broker.deliver,
                           {'run_id': RUN, 'attempt_id': ATTEMPT, 'binding_id': BINDING})
        self.assertEqual(self.vault.reads, 0)
        self.host.pid_error = None
        self.vault.values['a4-fixture-password'][0] = 'line\nbreak'
        with self.assertRaises(b.Refused) as caught:
            self.broker.deliver({'run_id': RUN, 'attempt_id': ATTEMPT, 'binding_id': BINDING})
        self.assertEqual((caught.exception.code, caught.exception.detail), ('VALUE_UNSUPPORTED', None))

    # ----------------------------------------------------------- model route

    def ready(self, limits=None, run=RUN):
        self.broker.price_set(PRICE)
        self.broker.provider_bind({'vault_key': 'openai-api-key'})
        self.pin(run, limits=limits or {'max_tokens': 5000, 'max_usd': 0.01}, credential=False)

    def call(self, call_id=CALL, run=RUN, **changes):
        params = {'run_id': run, 'call_id': call_id, 'project_limits_revision': 3, 'model': 'gpt-6-luna',
                  'max_output_tokens': 32, 'prompt': 'Reply with the single word OK.', **changes}
        return self.broker.model_call(params)

    def test_reserve_then_settle_actual_usage_and_idempotent_retry(self):
        self.ready()
        self.host.responses.append(completion(prompt=14, completion_tokens=2))
        result = self.call()
        prompt_bytes = len('Reply with the single word OK.')
        worst_tokens = prompt_bytes + b.MESSAGE_OVERHEAD_TOKENS + b.REQUEST_OVERHEAD_TOKENS
        reserved = b.nano_cost(worst_tokens, '0.125') + b.nano_cost(32, '0.50')
        actual = b.nano_cost(14, '0.125') + b.nano_cost(2, '0.50')
        self.assertEqual(result['state'], 'settled')
        self.assertEqual(result['provider_response_id'], 'chatcmpl-a4proof')
        self.assertEqual(result['model'], 'gpt-6-luna-2026-09-23')
        self.assertEqual(result['reserved_usd'], b.usd(reserved))
        self.assertEqual(result['settled_usd'], b.usd(actual))
        self.assertEqual(result['price_table_revision'], 1)
        self.assertEqual(result['usage']['total_tokens'], 16)
        self.assertFalse(result['replayed'])
        url, body = self.host.requests[0]
        self.assertEqual(url, 'https://api.openai.com/v1/chat/completions')
        self.assertEqual({k: body[k] for k in ('model', 'max_completion_tokens', 'reasoning_effort', 'service_tier',
                                                'store', 'n')},
                         {'model': 'gpt-6-luna', 'max_completion_tokens': 32, 'reasoning_effort': 'none',
                          'service_tier': 'default', 'store': False, 'n': 1})
        self.assertEqual(self.host.seen_key, PROVIDER_SECRET.encode())
        self.assertEqual(self.host.keys[0], bytearray(len(PROVIDER_SECRET)))   # wiped after the call
        run = self.broker.ledger({'run_id': RUN})['runs'][RUN]
        self.assertEqual(run['tokens'], {'reserved': 0, 'settled': 16})
        self.assertEqual(run['nano_usd'], {'reserved': 0, 'settled': actual})
        # The same call ID never spends twice: the recorded result, no new request.
        again = self.call()
        self.assertTrue(again['replayed'])
        self.assertEqual(again['provider_response_id'], 'chatcmpl-a4proof')
        self.assertEqual(len(self.host.requests), 1)
        self.assertNoSecret(self.journal_text())

    def test_refusals_before_any_provider_request(self):
        self.assertRefused('RUN_NOT_PINNED', self.call)
        self.ready(limits={'max_tokens': 1000, 'max_usd': 0.01})
        self.assertRefused('MODEL_NOT_ALLOWED', self.call, '88888888-8888-4888-8888-000000000001',
                           model='gpt-6-sol')
        self.assertRefused('REVISION_MISMATCH', self.call, '88888888-8888-4888-8888-000000000002',
                           project_limits_revision=4)
        self.broker.price_clear({'model': 'gpt-6-luna'})
        self.assertRefused('PRICE_UNKNOWN', self.call, '88888888-8888-4888-8888-000000000003')
        self.broker.price_set(PRICE)
        # Budget by tokens and by dollars, both before anything is sent.
        self.assertRefused('BUDGET_EXHAUSTED', self.call, '88888888-8888-4888-8888-000000000004',
                           max_output_tokens=4096, run=RUN)
        self.pin(RUN2, limits={'max_usd': 0.000001}, credential=False)
        self.assertRefused('BUDGET_EXHAUSTED', self.call, '88888888-8888-4888-8888-000000000005', run=RUN2)
        for bad in ({'max_output_tokens': 0}, {'max_output_tokens': 4097}, {'prompt': ''},
                    {'prompt': 'x' * 4001}, {'call_id': 'x'}, {'extra': 1}):
            params = {'run_id': RUN, 'call_id': '88888888-8888-4888-8888-000000000006',
                      'project_limits_revision': 3, 'model': 'gpt-6-luna', 'max_output_tokens': 32,
                      'prompt': 'OK?', **bad}
            with self.assertRaises(b.Refused):
                self.broker.model_call(params)
        self.assertEqual(self.host.requests, [])
        # A refused call ID stays refused; it is never sent later.
        self.assertRefused('MODEL_NOT_ALLOWED', self.call, '88888888-8888-4888-8888-000000000001')
        ledger = self.broker.ledger({})
        self.assertEqual(ledger['runs'][RUN]['tokens']['reserved'], 0)
        self.assertEqual({c['refusal'] for c in ledger['calls']},
                         {'RUN_NOT_PINNED', 'MODEL_NOT_ALLOWED', 'REVISION_MISMATCH', 'PRICE_UNKNOWN',
                          'BUDGET_EXHAUSTED'})

    def test_budget_counts_settled_spend_and_outstanding_reservations(self):
        self.ready(limits={'max_tokens': 200})
        self.host.responses.append(completion(prompt=40, completion_tokens=10))
        self.call(max_output_tokens=64)
        # 50 settled; a worst case of 30+48+100 would pass alone but not on top.
        self.assertRefused('BUDGET_EXHAUSTED', self.call, '88888888-8888-4888-8888-000000000007',
                           max_output_tokens=100)
        self.host.responses.append(completion(prompt=20, completion_tokens=3))
        self.call('88888888-8888-4888-8888-000000000008', max_output_tokens=64)
        self.assertEqual(len(self.host.requests), 2)

    def test_unknown_usage_price_or_outcome_fails_closed_and_is_never_resent(self):
        self.ready()
        cases = [
            ('88888888-8888-4888-8888-000000000011', (200, {'id': 'chatcmpl-x', 'model': 'gpt-6-luna'}),
             'USAGE_MISSING', 'settled_at_reservation'),
            ('88888888-8888-4888-8888-000000000012', completion(tier='priority'), 'PRICE_UNKNOWN',
             'settled_at_reservation'),
            ('88888888-8888-4888-8888-000000000013', completion(model='gpt-6-sol'), 'MODEL_MISMATCH',
             'settled_at_reservation'),
            ('88888888-8888-4888-8888-000000000014', (200, None), 'USAGE_MISSING', 'settled_at_reservation'),
            ('88888888-8888-4888-8888-000000000015', (400, {'error': {'type': 'invalid_request_error',
                                                                      'code': 'x', 'message': 'long text'}}),
             'PROVIDER_ERROR', 'provider_error'),
            ('88888888-8888-4888-8888-000000000016', (503, {}), 'PROVIDER_ERROR', 'uncertain'),
            ('88888888-8888-4888-8888-000000000017', TimeoutError(), 'PROVIDER_ERROR', 'uncertain')]
        for call_id, response, code, state in cases:
            with self.subTest(state=state, code=code):
                self.host.responses.append(response)
                self.assertRefused(code, self.call, call_id)
                record = self.broker.state['calls'][call_id]
                self.assertEqual(record['state'], state)
        calls = self.broker.state['calls']
        self.assertEqual(calls['88888888-8888-4888-8888-000000000015']['provider_error'],
                         {'type': 'invalid_request_error', 'code': 'x'})
        self.assertEqual(calls['88888888-8888-4888-8888-000000000015']['settled_nano_usd'], 0)
        retained = [calls[c]['reserved_nano_usd'] for c in calls if calls[c]['state'] == 'settled_at_reservation']
        run = self.broker.state['runs'][RUN]
        uncertain = sum(calls[c]['reserved_nano_usd'] for c in calls if calls[c]['state'] == 'uncertain')
        self.assertEqual(run['nano_usd'], {'reserved': uncertain, 'settled': sum(retained)})
        sent = len(self.host.requests)
        self.assertRefused('CALL_UNCERTAIN', self.call, '88888888-8888-4888-8888-000000000016')
        self.assertRefused('USAGE_MISSING', self.call, '88888888-8888-4888-8888-000000000011')
        self.assertEqual(len(self.host.requests), sent)

    def test_restart_marks_sent_calls_uncertain_and_releases_unsent(self):
        self.ready()
        with self.broker.lock:
            run = self.broker.state['runs'][RUN]
            for call_id, state in (('88888888-8888-4888-8888-000000000021', 'sent'),
                                   ('88888888-8888-4888-8888-000000000022', 'reserved')):
                self.broker.state['calls'][call_id] = {'call_id': call_id, 'run_id': RUN, 'state': state,
                                                       'reserved_tokens': 100, 'reserved_nano_usd': 1000}
                run['tokens']['reserved'] += 100
                run['nano_usd']['reserved'] += 1000
            self.broker._save()
        restarted = b.Broker(host=self.host, vault=self.vault, journal=self.root / 'state.json')
        restarted.recover()
        calls = restarted.state['calls']
        self.assertEqual(calls['88888888-8888-4888-8888-000000000021']['state'], 'uncertain')
        self.assertEqual(calls['88888888-8888-4888-8888-000000000022']['state'], 'abandoned')
        self.assertEqual(restarted.state['runs'][RUN]['nano_usd']['reserved'], 1000)

    def test_provider_error_proof_sends_an_invalid_request_and_releases(self):
        self.ready()
        self.host.responses.append((400, {'error': {'type': 'invalid_request_error'}}))
        self.assertRefused('PROVIDER_ERROR', self.call, proof='provider_error')
        self.assertEqual(self.host.requests[0][1]['max_completion_tokens'], 0)
        self.assertRefused('INVALID_REQUEST', self.call, '88888888-8888-4888-8888-000000000031', proof='other')

    def test_prices_are_exact_decimal_nano_usd(self):
        self.assertEqual(b.nano_cost(1, '0.10'), 100)
        self.assertEqual(b.nano_cost(3, '0.000001'), 1)   # rounded up, never down to zero
        self.assertEqual(b.budget_nano(0.01), 10_000_000)
        self.assertEqual(b.usd(1234), '0.000001234')
        with decimal.localcontext() as context:
            context.prec = 5
            self.assertEqual(b.nano_cost(1_000_000, '0.125'), 125_000_000)
        for bad in ('-1', '1e3', '0.1234567', 'NaN', '99999'):
            params = dict(PRICE, output=bad)
            with self.assertRaises(b.Refused):
                self.broker.price_set(params)


class VaultTests(unittest.TestCase):
    """The real Vault client against a local OpenBao-shaped API."""

    @classmethod
    def setUpClass(cls):
        class Api(BaseHTTPRequestHandler):
            logins, versions, tokens = [], {'a4-fixture-password': 2}, set()

            def log_message(self, *args):
                pass

            def reply(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path == '/v1/auth/pp-approle/login' and body == {'role_id': 'r', 'secret_id': 's'}:
                    Api.logins.append(1)
                    Api.tokens.add('tok')
                    return self.reply(200, {'auth': {'client_token': 'tok', 'lease_duration': 3600}})
                return self.reply(400, {'errors': ['bad']})

            def do_GET(self):  # noqa: N802
                if self.headers.get('X-Vault-Token') not in Api.tokens:
                    return self.reply(403, {'errors': ['denied']})
                current = Api.versions['a4-fixture-password']
                if self.path == '/v1/pp-kv/metadata/agents/a4-broker/a4-fixture-password':
                    return self.reply(200, {'data': {'current_version': current, 'versions': {
                        str(current): {'deletion_time': '', 'destroyed': False}}}})
                if self.path.startswith('/v1/pp-kv/data/agents/a4-broker/a4-fixture-password?version='):
                    version = int(self.path.rsplit('=', 1)[1])
                    return self.reply(200, {'data': {'data': {'value': 'value-%d' % version, 'description': ''},
                                                     'metadata': {'version': version}}})
                return self.reply(404, {'errors': []})
        cls.api = Api
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Api)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def config(self, **changes):
        return {'address': 'http://127.0.0.1:%d' % self.server.server_address[1], 'approle_mount': 'pp-approle',
                'kv_mount': 'pp-kv', 'agent': 'a4-broker', 'role_id': 'r', 'secret_id': 's', **changes}

    def test_approle_versioned_reads_and_config_validation(self):
        vault = b.Vault(self.config())
        self.assertEqual(vault.current_version('a4-fixture-password'), 2)
        self.assertEqual(vault.read('a4-fixture-password', 2), bytearray(b'value-2'))
        self.assertEqual(len(self.api.logins), 1)   # the token is cached
        with self.assertRaises(b.Refused) as caught:
            vault.read('a4-fixture-password', 1)
        self.assertEqual(caught.exception.code, 'VAULT_VERSION_MISMATCH')
        with self.assertRaises(b.Refused) as caught:
            vault.current_version('missing-key')
        self.assertEqual(caught.exception.code, 'VAULT_KEY_MISSING')
        with self.assertRaises(b.Refused):
            vault.path('../../sys')
        with self.assertRaises(b.Refused) as caught:
            b.Vault(self.config(secret_id='wrong')).current_version('a4-fixture-password')
        self.assertEqual(caught.exception.code, 'VAULT_UNAVAILABLE')
        for bad in ({'address': 'http://10.0.0.1:18200'}, {'address': 'file:///etc'}, {'agent': 'X'},
                    {'kv_mount': '../x'}, {'role_id': ''}):
            with self.assertRaises(b.Refused):
                b.Vault(self.config(**bad))


class GuestWriterTests(unittest.TestCase):
    """The guest writer's checks, with its /proc paths redirected to fixtures."""

    def run_writer(self, fifo, cgroup_text, uid, owner, data=b'frame-bytes', unit=b.UNIT_PREFIX + ATTEMPT):
        root = Path(fifo).parent
        (root / 'cgroup').write_text(cgroup_text)
        (root / 'status').write_text('Name:\tpython3\nUid:\t%s\t%s\t%s\t%s\n' % ((uid,) * 4))
        code = (b.GUEST_WRITER.replace("'/proc/%s/cgroup' % pid", repr(str(root / 'cgroup')))
                .replace("'/proc/%s/status' % pid", repr(str(root / 'status')))
                .replace("'/proc/%s/root/tmp/pp-a4-credential' % pid", repr(fifo))
                .replace('info.st_uid != 65534', 'info.st_uid != %d' % owner)
                .replace('time.monotonic() + 15', 'time.monotonic() + 2'))
        result = subprocess.run([sys.executable, '-I', '-c', code, '4321', unit], input=data, capture_output=True,
                                timeout=30)
        return json.loads(result.stdout)

    def test_writes_only_into_the_named_workers_fifo(self):
        with tempfile.TemporaryDirectory() as temp:
            fifo = os.path.join(temp, 'fifo')
            good_cgroup = '0::/system.slice/%s%s.service\n' % (b.UNIT_PREFIX, ATTEMPT)
            os.mkfifo(fifo, 0o600)
            received = {}

            def reader():
                with open(fifo, 'rb') as stream:
                    received['data'] = stream.read()
            thread = threading.Thread(target=reader)
            thread.start()
            self.assertEqual(self.run_writer(fifo, good_cgroup, '65534', os.getuid()), {'ok': True})
            thread.join(5)
            self.assertEqual(received['data'], b'frame-bytes')
            self.assertEqual(self.run_writer(fifo, '0::/system.slice/other.service\n', '65534', os.getuid()),
                             {'ok': False, 'error': 'TARGET_MISMATCH'})
            self.assertEqual(self.run_writer(fifo, good_cgroup, '0', os.getuid()),
                             {'ok': False, 'error': 'TARGET_MISMATCH'})
            self.assertEqual(self.run_writer(fifo, good_cgroup, '65534', os.getuid(), unit='sshd'),
                             {'ok': False, 'error': 'TARGET_MISMATCH'})
            # No reader: the FIFO is not open, so nothing is written anywhere.
            self.assertEqual(self.run_writer(fifo, good_cgroup, '65534', os.getuid()),
                             {'ok': False, 'error': 'CHANNEL_NOT_OPEN'})
            os.unlink(fifo)
            os.symlink('/etc/hostname', fifo)
            self.assertEqual(self.run_writer(fifo, good_cgroup, '65534', os.getuid()),
                             {'ok': False, 'error': 'CHANNEL_NOT_OPEN'})
            os.unlink(fifo)
            Path(fifo).write_text('')
            self.assertEqual(self.run_writer(fifo, good_cgroup, '65534', os.getuid()),
                             {'ok': False, 'error': 'CHANNEL_MISMATCH'})
            self.assertEqual(Path(fifo).read_text(), '')


class SocketTests(unittest.TestCase):
    def test_root_only_socket_and_no_data_in_errors(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(b, 'secure', lambda path: None):
            broker = b.Broker(host=FakeHost(), vault=FakeVault(), journal=Path(temp) / 'state.json')
            path = Path(temp) / 'broker.sock'
            server = b.listen(path, broker)
            try:
                def call(raw):
                    with socket.socket(socket.AF_UNIX) as client:
                        client.connect(str(path))
                        client.sendall(raw)
                        try:
                            line = client.makefile().readline()
                        except ConnectionResetError:
                            return ''
                    return json.loads(line) if line else ''
                server.peer_uid = os.getuid() + 1
                self.assertEqual(call(b'{"method":"status"}\n'), '')
                server.peer_uid = os.getuid()
                self.assertEqual(oct(os.stat(path).st_mode & 0o777), '0o600')
                self.assertEqual(call(b'{"method":"shell","params":{}}\n')['error'], 'METHOD_NOT_ALLOWED')
                self.assertEqual(call(b'nope\n')['error'], 'INVALID_REQUEST')
                self.assertTrue(call(b'{"method":"status"}\n')['ok'])
                reply = call(json.dumps({'method': 'bind', 'params': {'value': SECRET}}).encode() + b'\n')
                self.assertEqual(reply, {'ok': False, 'error': 'INVALID_REQUEST'})
            finally:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()
