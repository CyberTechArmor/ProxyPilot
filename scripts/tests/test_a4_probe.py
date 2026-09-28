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
