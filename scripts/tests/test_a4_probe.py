"""Pure parts of the A4 target proof and the canary scan."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = load('a4_probe_under_test', 'a4-probe.py')
canary = load('a4_canary_under_test', 'a4-canary-scan.py')
broker = load('a4_probe_broker', 'a4-credential-broker.py')
BINDING = '33333333-3333-4333-8333-333333333333'
SECRET = 'A4-canary-"q\\7/x+y=z%w'


class ProbeTests(unittest.TestCase):
    def test_worst_case_tokens_mirror_the_broker(self):
        price = {'input': '0.10', 'cached_input': '0.01', 'cache_write': '0.125', 'output': '0.50'}
        self.assertEqual(probe.worst_case_tokens(71, 16), broker.worst_case(71, 16, price)[0])
        self.assertEqual(probe.MODEL, 'gpt-6-luna')
        self.assertIn(probe.MODEL, broker.MODEL_ROUTES)
        self.assertEqual(probe.CASES[-1], 'revocation')   # it ends the binding

    def test_receipt_credential_block_is_ids_revision_and_outcomes_only(self):
        good = {'credential': {'binding_id': BINDING, 'binding_revision': 2, 'logout': 'done',
                               'submits': [{'ordinal': 3, 'outcome': 'signed_in'}]}}
        probe.evaluate_receipt_credential(good, BINDING, 2, ['signed_in'])
        for bad in ({'credential': dict(good['credential'], value='x')},
                    {'credential': dict(good['credential'], binding_revision=1)},
                    {'credential': dict(good['credential'], logout='not_run')},
                    {'credential': dict(good['credential'], submits=[{'ordinal': 3, 'outcome': 'signed_in',
                                                                       'sha256': 'ab'}])},
                    {}):
            with self.assertRaises(AssertionError):
                probe.evaluate_receipt_credential(bad, BINDING, 2, ['signed_in'])

    def test_budget_evidence_requires_every_refusal_and_one_real_request(self):
        good = {'allowed_call': {'state': 'settled', 'provider_response_id': 'chatcmpl-1',
                                 'model': 'gpt-6-luna-2026-09-23', 'usage': {'total_tokens': 30},
                                 'price_table_revision': 1, 'settled_usd': '0.000004250',
                                 'reserved_usd': '0.000022750'},
                'retry_replayed': True, 'budget_tokens': 'BUDGET_EXHAUSTED', 'budget_usd': 'BUDGET_EXHAUSTED',
                'not_allowlisted': 'MODEL_NOT_ALLOWED', 'revision_mismatch': 'REVISION_MISMATCH',
                'unknown_price': 'PRICE_UNKNOWN', 'provider_error': 'PROVIDER_ERROR',
                'provider_requests_before_refusals': 1, 'provider_requests_after_refusals': 1}
        self.assertTrue(probe.evaluate_budget(good))
        for change in ({'retry_replayed': False}, {'unknown_price': None}, {'provider_error': 'BUDGET_EXHAUSTED'},
                       {'provider_requests_after_refusals': 2},
                       {'allowed_call': dict(good['allowed_call'], model='gpt-6-sol')},
                       {'allowed_call': dict(good['allowed_call'], settled_usd='1.0')}):
            with self.assertRaises(AssertionError):
                probe.evaluate_budget(dict(good, **change))

    def test_guest_scripts_compile_and_the_profile_scan_finds_cookie_files(self):
        compile(probe.EGRESS, 'egress', 'exec')
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / 'profile' / 'Default').mkdir(parents=True)
            (Path(temp) / 'profile' / 'Default' / 'Cookies').write_text('')
            (Path(temp) / 'pp-a4-credential').write_text('')
            code = probe.GUEST_PROFILE_SCAN.replace(
                "('/tmp', '/var/tmp', '/dev/shm', '/home', '/root', '/var/lib', '/nonexistent', '/run/user')",
                repr((temp,)))
            out = json.loads(subprocess.run([sys.executable, '-I', '-c', code, json.dumps(probe.PROFILE_ARTIFACTS)],
                                            capture_output=True, check=True, text=True).stdout)
            self.assertEqual(sorted(Path(p).name for p in out['found']), ['Cookies', 'pp-a4-credential'])



PROJECT = '11111111-1111-4111-8111-111111111111'
PROFILE = '22222222-2222-4222-8222-222222222222'


class FlowVault:
    config = {'kv_mount': 'pp-kv', 'agent': 'a4-broker'}

    def path(self, key):
        return 'agents/a4-broker/' + key

    def current_version(self, key):
        return 1

    def read(self, key, version):
        return bytearray(b'sk-test-a4-flow-000111' if key == 'openai-api-key' else b'A4-flow-canary-Zt8pQ3')

    def healthy(self):
        return True


class FlowHost:
    """The provider as the broker sees it: one completion, or a 400 for the error proof."""

    def __init__(self):
        self.requests = 0

    def provider(self, url, key, body):
        self.requests += 1
        if body['max_completion_tokens'] == 0:
            return 400, {'error': {'type': 'invalid_request_error'}}
        return 200, {'id': 'chatcmpl-flow-%d' % self.requests, 'model': 'gpt-6-luna-2026-09-23',
                     'service_tier': 'default',
                     'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {'content': 'OK'}}],
                     'usage': {'prompt_tokens': 30, 'completion_tokens': 1, 'total_tokens': 31,
                               'prompt_tokens_details': {'cached_tokens': 0}}}


class FlowSupervisor:
    """The installed supervisor's rules that the proof depends on: ONE live attempt
    at a time (ACTIVE_ATTEMPT), pinning at the broker at launch, and a broker
    `check` before a bound submit."""

    def __init__(self, real_broker):
        self.broker = real_broker
        self.live = None
        self.actions = {}

    def fail(self, code):
        raise probe.op.CallFailed({'ok': False, 'error': code})

    def __call__(self, method, params=None, timeout=180):
        params = params or {}
        if method == 'launch':
            if self.live is not None:
                self.fail('ACTIVE_ATTEMPT')
            spend = {k: params['limits'][k] for k in ('max_tokens', 'max_usd') if k in params['limits']}
            try:
                self.broker.pin_run({'run_id': params['run_id'], 'project_limits_revision':
                                     params['project_limits_revision'], 'limits': spend,
                                     'credential': params.get('credential')})
            except broker.Refused as error:
                self.fail(error.code)
            self.live = dict(params)
            self.actions[params['attempt_id']] = []
            return {'boot_id': 'boot-flow'}
        if method == 'action':
            if self.live is None or self.live['attempt_id'] != params['attempt_id']:
                self.fail('ATTEMPT_NOT_ACTIVE')
            if params['action'] == 'submit_bound_fixture':
                try:
                    self.broker.check({'run_id': params['run_id'], 'binding_id': params['binding_id']})
                except broker.Refused as error:
                    self.fail(error.code)
            self.actions[params['attempt_id']].append({'action': params['action'], 'state': 'done'})
            return {'result': {}}
        if method == 'journal':
            return {'attempt': {'actions': self.actions[params['attempt_id']]}}
        if method == 'stop':
            if self.live is None or self.live['attempt_id'] != params['attempt_id']:
                self.fail('ATTEMPT_NOT_ACTIVE')
            self.live = None
            return {'receipt': {'payload': {}}}
        if method == 'status':
            return {'active': None if self.live is None else {k: self.live[k] for k in
                                                              ('run_id', 'attempt_id', 'fence')}}
        raise AssertionError(method)


class ProofFlowTests(unittest.TestCase):
    """The budget and revocation cases run end to end against the REAL broker
    (its reply shapes and refusal codes) and a supervisor that allows one live
    attempt, which is what the host run on 2026-09-28 exposed."""

    def setUp(self):
        from unittest.mock import patch
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.patches = [patch.object(broker, 'secure', lambda path: None)]
        for item in self.patches:
            item.start()
        self.host = FlowHost()
        self.real = broker.Broker(host=self.host, vault=FlowVault(), journal=root / 'state.json')
        self.real.price_set({'model': 'gpt-6-luna', 'input': '0.10', 'cached_input': '0.01', 'cache_write': '0.125',
                             'output': '0.50'})
        self.real.provider_bind({'vault_key': 'openai-api-key'})
        self.real.bind({'binding_id': BINDING, 'project_id': PROJECT, 'profile_id': PROFILE,
                        'username': 'a4-fixture@demo.fractionate.ai', 'vault_key': 'a4-fixture-password'})
        self.supervisor = FlowSupervisor(self.real)

        def via_broker(method, params=None, timeout=180):
            try:
                return self.real.dispatch(method, params or {})
            except broker.Refused as error:
                raise probe.bop.CallFailed({'ok': False, 'error': error.code})
        for target, value in (('call', self.supervisor), ('broker', via_broker), ('OUT', root / 'out'),
                              ('receipt_ok', lambda receipt: receipt['payload'])):
            item = patch.object(probe, target, value)
            item.start()
            self.patches.append(item)
        self.proof = probe.Proof(BINDING)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_budget_runs_one_attempt_at_a_time_and_proves_every_refusal(self):
        observed = self.proof.budget()
        self.assertIsNone(self.supervisor.live)
        self.assertEqual(observed['refusals']['budget_tokens'], 'BUDGET_EXHAUSTED')
        self.assertEqual(observed['refusals']['budget_usd'], 'BUDGET_EXHAUSTED')
        self.assertEqual(observed['refusals']['provider_error'], 'PROVIDER_ERROR')
        self.assertEqual(observed['allowed_call']['state'], 'settled')
        self.assertEqual(self.host.requests, 2)   # the allowed call and the provider-error proof, nothing else
        self.assertEqual(self.real.status({})['prices']['revision'], 3)   # cleared, then restored

    def test_revocation_reports_its_timings(self):
        observed = self.proof.revocation()
        self.assertIsNone(self.supervisor.live)
        self.assertEqual((observed['broker_check'], observed['next_submit'], observed['new_launch']),
                         ('BINDING_REVOKED',) * 3)
        self.assertIsInstance(observed['revoked_at_epoch'], (int, float))
        self.assertEqual(observed['binding_state'], 'revoked')
        for key in ('revoke_call_ms', 'broker_check_ms', 'next_submit_refusal_ms'):
            self.assertIsInstance(observed[key], int)

    def test_a_failed_case_leaves_no_live_attempt(self):
        self.proof.run_case('budget', lambda: (self.proof.launch({'max_usd': 0.001}), 1 / 0))
        self.assertFalse(self.proof.results[-1]['passed'])
        self.assertIsNone(self.supervisor.live)

class CanaryTests(unittest.TestCase):
    def test_every_encoding_and_alignment_is_found(self):
        value = bytearray(SECRET.encode())
        needles = canary.patterns(value)
        self.assertTrue(all(len(n) >= 8 for n in needles))
        samples = [SECRET.encode(), json.dumps({'k': SECRET}).encode(), quote(SECRET, safe='').encode()]
        for prefix in (b'', b'a', b'ab', b'abc'):
            samples.append(base64.b64encode(prefix + SECRET.encode() + b'tail'))
            samples.append(base64.urlsafe_b64encode(b'{"x":1,' + prefix + SECRET.encode() + b'}'))
        for sample in samples:
            with self.subTest(sample=sample[:30]):
                self.assertGreaterEqual(canary.count(b'noise ' + sample + b' noise', needles), 1)
        self.assertEqual(canary.count(b'nothing to see here' * 100, needles), 0)
        with self.assertRaises(ValueError):
            canary.patterns(bytearray(b'short'))

    def test_signed_receipts_are_decoded_and_unread_sinks_fail(self):
        body = base64.urlsafe_b64encode(json.dumps({'x': 'prefix' + SECRET}).encode()).rstrip(b'=')
        attestation = b'{"attestation":"a3r1.' + body + b'.c2lnbmF0dXJl"}'
        needles = canary.patterns(bytearray(SECRET.encode()))
        self.assertGreaterEqual(canary.scan_bytes(attestation, needles), 1)

        def unreadable():
            raise OSError('journal unavailable')
        result = canary.scan(bytearray(SECRET.encode()), {'clean': lambda: b'receipt with ids only',
                                                          'leaky': lambda: b'x' + SECRET.encode(),
                                                          'unread': unreadable})
        self.assertEqual(result['canary_scan'], 'failed')
        self.assertEqual(result['sinks']['clean'], {'scanned': True, 'bytes': 21, 'matches': 0})
        self.assertEqual(result['sinks']['leaky']['matches'], 1)
        self.assertFalse(result['sinks']['unread']['scanned'])
        self.assertNotIn(SECRET, json.dumps(result))
        clean = canary.scan(bytearray(SECRET.encode()), {'clean': lambda: b'receipt with ids only'})
        self.assertEqual(clean['canary_scan'], 'passed')

    def test_every_required_sink_is_listed(self):
        names = set(canary.sink_sources(database='/nonexistent.db'))
        self.assertTrue({'supervisor_journal', 'broker_journal', 'proxy_journal', 'host_journal_all',
                         'guest_unit_journals', 'backend_logs', 'database_files', 'database_dump', 'mcp_ledger',
                         'receipts_and_supervisor_journal', 'broker_journal_and_model_records',
                         'page_reads_and_proof_reports'} <= names, names)

    def test_database_dump_and_ledger_read_a_real_sqlite_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = os.path.join(temp, 'proxypilot.db')
            import sqlite3
            connection = sqlite3.connect(path)
            connection.execute('CREATE TABLE mcp_ledger (id INTEGER PRIMARY KEY, detail TEXT)')
            connection.execute('INSERT INTO mcp_ledger(detail) VALUES (?)', ('binding ' + BINDING,))
            connection.commit()
            connection.close()
            needles = canary.patterns(bytearray(SECRET.encode()))
            self.assertEqual(canary.count(canary.database_dump(path), needles), 0)
            self.assertIn(BINDING.encode(), canary.mcp_ledger(path))


if __name__ == '__main__':
    unittest.main()
