#!/usr/bin/env python3
"""Operator-run A4 target proof against the INSTALLED supervisor and broker.

Root only, from the staged candidate's scripts/ directory. Every case goes
through the real sockets: the supervisor's operator socket for launches,
actions and stops, and the broker socket for bindings and the model route.
This harness never reads, receives or prints a credential value; the canary
check is the separate a4-canary-scan.py.

Cases (in order; `revocation` ends the binding, so it runs last):
  proxy_policy  the extended fixed-origin proxy proof (a3-probe-proxy.py)
  login         bound sign-in on the real origin, session readback, logout at
                stop, verified receipt, and no profile or cookie file left in
                the guest afterwards
  egress        guest root cannot reach the provider or the vault; the fence
                counters move
  budget        reservation and settlement of one real allowed call, an
                idempotent retry, and refusals: budget exhausted (tokens and
                dollars), unknown price, model not allowlisted, revision
                mismatch, provider error
  rotation      a new binding revision refuses the old one at the next submit
                and at launch; the new revision signs in
  revocation    the broker refuses at once, the running attempt's next submit
                is refused (timed), and a new launch is refused
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import traceback
import uuid

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


op = load('a4_probe_operator', 'a3-worker-operator.py')
sup = load('a4_probe_supervisor', 'a3-worker-supervisor.py')
bop = load('a4_probe_broker_operator', 'a4-broker-operator.py')
installer = sup.installer
VM = sup.VM
OUT = Path('/var/lib/proxypilot-a4-proof')
POLICY = hashlib.sha256(b'a4-proof-policy-v1').hexdigest()
CASES = ('proxy_policy', 'login', 'egress', 'budget', 'rotation', 'revocation')
MODEL = 'gpt-6-luna'
PROMPT = 'This is a bounded billing proof. Reply with exactly the single word: OK'
PROFILE_ARTIFACTS = ('Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal', 'Web Data',
                     'Local State', 'Network Persistent State', 'Preferences', 'History')
# Walks the guest's writable trees after a stop; names only, never contents.
GUEST_PROFILE_SCAN = r'''import json, os, sys
names = set(json.loads(sys.argv[1]))
found = []
for top in ('/tmp', '/var/tmp', '/dev/shm', '/home', '/root', '/var/lib', '/nonexistent', '/run/user'):
    for root, dirs, files in os.walk(top):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
        for name in files:
            if name in names or name.startswith('pp-a4-credential'):
                found.append(os.path.join(root, name))
mounts = [l.split()[4] for l in open('/proc/self/mountinfo') if ' - tmpfs ' in l]
print(json.dumps({'found': found[:50], 'tmpfs_mounts': mounts}))
'''
EGRESS = r'''import json, socket, sys, threading
targets = json.loads(sys.argv[1])
out = {}
def tcp(name, family, address):
    try:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.settimeout(4); s.connect(tuple(address))
        out[name] = 'connected'
    except OSError as e:
        out[name] = 'refused:%s' % (e.errno if e.errno is not None else 'timeout')
def dns(name, address):
    query = bytes.fromhex('a4a4010000010000000000000361706906' + 'openai'.encode().hex() + '03636f6d0000010001')
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(4); s.sendto(query, tuple(address)); s.recvfrom(512)
        out[name] = 'answered'
    except OSError as e:
        out[name] = 'refused:%s' % (e.errno if e.errno is not None else 'timeout')
jobs = [threading.Thread(target=tcp, args=(t['name'], socket.AF_INET6 if ':' in t['address'][0] else socket.AF_INET,
                                           t['address'])) for t in targets['tcp']]
jobs += [threading.Thread(target=dns, args=(t['name'], t['address'])) for t in targets['dns']]
[j.start() for j in jobs]; [j.join() for j in jobs]
print(json.dumps(out, sort_keys=True))
'''


def new_ids():
    return str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())


def call(method, params=None, timeout=180):
    return op.call(method, params, path=op.OPERATOR_SOCKET, timeout=timeout)


def broker(method, params=None, timeout=180):
    return bop.call(method, params, timeout=timeout)


def refused(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except (op.CallFailed, bop.CallFailed) as error:
        return error.code
    return None


def guest(argv, timeout=60, check=False):
    return subprocess.run(['incus', 'exec', VM, '--', *argv], capture_output=True, text=True, timeout=timeout,
                          check=check)


def counters():
    document = installer.table()
    return {row['counter']['name']: row['counter'].get('packets', 0) for row in document['nftables']
            if 'counter' in row}


def receipt_ok(receipt):
    valid, payload = op.verify_receipt(receipt)
    assert valid and receipt['descendants_gone'] is True and receipt['workspace_removed'] is True, receipt
    return payload


def worst_case_tokens(prompt_bytes, max_output_tokens):
    """The broker's worst-case token reservation (mirrors a4-credential-broker.worst_case)."""
    return prompt_bytes + 16 + 32 + max_output_tokens


def evaluate_receipt_credential(payload, binding, revision, outcomes, logout='done'):
    """The receipt names the binding, revision and outcomes only (pure; tested)."""
    credential = payload.get('credential')
    assert credential is not None, 'receipt has no credential block'
    assert set(credential) == {'binding_id', 'binding_revision', 'submits', 'logout'}, credential
    assert (credential['binding_id'], credential['binding_revision']) == (binding, revision), credential
    assert [s['outcome'] for s in credential['submits']] == outcomes, credential
    assert all(set(s) == {'ordinal', 'outcome'} for s in credential['submits']), credential
    assert credential['logout'] == logout, credential
    return credential


def evaluate_budget(found):
    """Every required refusal code and a settled, replayed real call (pure; tested)."""
    expected = {'retry_replayed': True, 'budget_tokens': 'BUDGET_EXHAUSTED', 'budget_usd': 'BUDGET_EXHAUSTED',
                'not_allowlisted': 'MODEL_NOT_ALLOWED', 'revision_mismatch': 'REVISION_MISMATCH',
                'unknown_price': 'PRICE_UNKNOWN', 'provider_error': 'PROVIDER_ERROR'}
    wrong = {k: found.get(k) for k, v in expected.items() if found.get(k) != v}
    assert not wrong, wrong
    call_ = found['allowed_call']
    assert call_['state'] == 'settled' and call_['provider_response_id'], call_
    assert call_['model'] == MODEL or call_['model'].startswith(MODEL + '-'), call_
    assert call_['usage']['total_tokens'] > 0 and isinstance(call_['price_table_revision'], int), call_
    assert float(call_['settled_usd']) <= float(call_['reserved_usd']), call_
    # One real request; the retry and the exhausted call sent nothing more.
    assert found['provider_requests_before_refusals'] == 1, found
    assert found['provider_requests_after_refusals'] == found['provider_requests_before_refusals'], found
    return True


class Proof:
    def __init__(self, binding):
        self.binding_id = binding
        self.results = []
        OUT.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())

    # ------------------------------------------------------------ helpers

    def binding(self):
        for record in broker('bindings')['bindings']:
            if record['binding_id'] == self.binding_id:
                return record
        raise AssertionError('binding %s is not authorized in the broker' % self.binding_id)

    def credential(self, record, revision=None):
        return {'project_id': record['project_id'], 'profile_id': record['profile_id'], 'profile_revision': 1,
                'binding_id': record['binding_id'],
                'binding_revision': record['revision'] if revision is None else revision}

    def launch(self, limits=None, credential=None, ids=None, fence=1):
        run, attempt, workspace = ids or new_ids()
        limits = limits or {}
        body = {'run_id': run, 'attempt_id': attempt, 'workspace_id': workspace, 'fence': fence,
                'policy_digest': POLICY, 'project_limits_revision': 1, 'origin': sup.ORIGIN, 'target': sup.TARGET,
                'limits': limits, 'install': sup.install_shape(limits)}
        if credential is not None:
            body['credential'] = credential
        result = call('launch', body)
        return {'run_id': run, 'attempt_id': attempt, 'fence': fence}, result, body

    def stop(self, ref, reason='proof'):
        return receipt_ok(call('stop', dict(ref, reason=reason))['receipt'])

    def cleanup(self):
        try:
            active = call('status')['active']
            if active:
                call('stop', {'run_id': active['run_id'], 'attempt_id': active['attempt_id'],
                              'fence': active['fence'], 'reason': 'proof'})
        except (op.CallFailed, OSError):
            pass

    def run_case(self, name, fn):
        started = time.monotonic()
        entry = {'case': name}
        try:
            entry['observed'] = fn()
            entry['passed'] = True
        except Exception as error:  # noqa: BLE001 - every case is reported.
            entry['passed'] = False
            entry['error'] = '%s: %s' % (type(error).__name__, str(error)[:600])
            entry['trace'] = traceback.format_exc()[-1500:]
            self.cleanup()
        entry['seconds'] = round(time.monotonic() - started, 1)
        self.results.append(entry)
        print(json.dumps({k: v for k, v in entry.items() if k != 'trace'}, default=str)[:2400], flush=True)

    def sign_in(self, record, limits=None):
        """One launch pinned to the binding, the real login form, a bound submit."""
        ref, launched, body = self.launch(limits or {'max_actions': 12}, self.credential(record))
        call('action', dict(ref, action='open_landing'))
        call('action', dict(ref, action='open_login'))
        begin = time.monotonic()
        submitted = call('action', dict(ref, action='submit_bound_fixture', binding_id=record['binding_id']))
        latency = int((time.monotonic() - begin) * 1000)
        return ref, launched, body, submitted, latency

    # --------------------------------------------------------------- cases

    def proxy_policy(self):
        probe = load('a4_probe_proxy', 'a3-probe-proxy.py')
        result = probe.run()
        return {'status_codes': result['status_codes'], 'cases': len(result['cases']), 'boot_id': result['boot_id']}

    def login(self):
        record = self.binding()
        ref, launched, _, submitted, latency = self.sign_in(record)
        result = submitted['result']
        assert result['outcome'] == 'signed_in' and result['login_requests'] == 1, result
        assert result['untrusted_page_claim_authenticated_as_bound_account'] is True, result
        assert (result['binding_id'], result['binding_revision']) == (record['binding_id'], record['revision'])
        files = call('action', dict(ref, action='read_files'))['result']
        assert files == {'untrusted_page_claim_sample_present': True}, files
        journal = call('journal', {'attempt_id': ref['attempt_id']})['attempt']
        submit = [a for a in journal['actions'] if a['action'] == 'submit_bound_fixture'][0]
        assert set(submit) <= {'ordinal', 'action', 'binding_id', 'binding_revision', 'state', 'at', 'outcome',
                               'latency_ms'}, submit
        payload = self.stop(ref)
        credential = evaluate_receipt_credential(payload, record['binding_id'], record['revision'], ['signed_in'])
        assert payload['evidence']['logout'] == 'done', payload['evidence']
        scan = json.loads(guest(['/usr/bin/python3', '-I', '-c', GUEST_PROFILE_SCAN, json.dumps(PROFILE_ARTIFACTS)],
                                timeout=120, check=True).stdout)
        assert scan['found'] == [], scan['found']
        unit = guest(['systemctl', 'is-active', sup.UNIT_PREFIX + ref['attempt_id'] + '.service'], timeout=20)
        deliveries = [d for d in broker('ledger', {'run_id': ref['run_id']})['deliveries']]
        assert [d['outcome'] for d in deliveries] == ['delivered'], deliveries
        return {'submit': result, 'submit_latency_ms': latency, 'read_files': files, 'journal_submit': submit,
                'receipt_credential': credential, 'receipt_reason': payload['reason'],
                'logout': payload['evidence']['logout'], 'guest_profile_or_cookie_files_after_stop': scan['found'],
                'unit_after_stop': unit.stdout.strip(), 'broker_deliveries': deliveries,
                'boot_id': launched['boot_id']}

    def egress(self):
        tcp, dns = [], [{'name': 'dns_gateway', 'address': ['10.185.17.1', 53]},
                        {'name': 'dns_public', 'address': ['1.1.1.1', 53]}]
        seen = set()
        for family, _, _, _, sockaddr in socket.getaddrinfo('api.openai.com', 443, type=socket.SOCK_STREAM):
            if sockaddr[0] in seen or len(seen) >= 4:
                continue
            seen.add(sockaddr[0])
            tcp.append({'name': 'provider_%s' % sockaddr[0], 'address': [sockaddr[0], 443]})
        assert tcp, 'api.openai.com did not resolve on the host'
        tcp += [{'name': 'vault_bridge_18200', 'address': ['10.185.17.1', 18200]},
                {'name': 'vault_route_443', 'address': ['10.185.17.1', 443]},
                {'name': 'proxy', 'address': ['10.185.17.1', 18083]}]
        before = counters()
        result = guest(['/usr/bin/python3', '-I', '-c', EGRESS, json.dumps({'tcp': tcp, 'dns': dns})], timeout=90,
                       check=True)
        after = counters()
        found = json.loads(result.stdout)
        delta = {k: after.get(k, 0) - before.get(k, 0) for k in after}
        assert found.pop('proxy') == 'connected', found
        assert all(v.startswith('refused') for v in found.values()), found
        assert delta.get('denied_ipv4', 0) > 0 and delta.get('allowed_proxy', 0) > 0, delta
        if any(':' in t['address'][0] for t in tcp):
            assert delta.get('denied_ipv6', 0) > 0, delta
        return {'guest_root_results': found, 'fence_counter_delta': delta}

    def budget(self):
        prices = broker('status')['prices']
        price = prices['models'].get(MODEL)
        assert price is not None, 'confirm the price first: a4-broker-operator.py price set ...'
        worst_tokens = worst_case_tokens(len(PROMPT.encode()), 16)
        found = {}

        def model(run_id, call_id, **changes):
            params = {'run_id': run_id, 'call_id': call_id, 'project_limits_revision': 1, 'model': MODEL,
                      'max_output_tokens': 16, 'prompt': PROMPT, **changes}
            return broker('model_call', params)

        def sent(run_id):
            return len([c for c in broker('ledger', {'run_id': run_id})['calls'] if c.get('http_status')])
        # Run A: room for exactly one worst case. One real call spends, its retry
        # replays without a second request, and the next call finds the budget spent.
        ref_a, _, _ = self.launch({'max_tokens': worst_tokens + 10, 'max_usd': 0.001})
        call_id = str(uuid.uuid4())
        found['allowed_call'] = model(ref_a['run_id'], call_id)
        found['provider_requests_before_refusals'] = sent(ref_a['run_id'])
        retry = model(ref_a['run_id'], call_id)
        found['retry_replayed'] = retry.get('replayed') is True and \
            retry['provider_response_id'] == found['allowed_call']['provider_response_id']
        found['budget_tokens'] = refused(model, ref_a['run_id'], str(uuid.uuid4()))
        found['provider_requests_after_refusals'] = sent(ref_a['run_id'])
        # Run B: policy refusals before any request, then one real provider error.
        ref_b, _, _ = self.launch({'max_tokens': 2000, 'max_usd': 0.001})
        found['not_allowlisted'] = refused(model, ref_b['run_id'], str(uuid.uuid4()), model='gpt-6-sol')
        found['revision_mismatch'] = refused(model, ref_b['run_id'], str(uuid.uuid4()), project_limits_revision=2)
        broker('price_clear', {'model': MODEL})
        try:
            found['unknown_price'] = refused(model, ref_b['run_id'], str(uuid.uuid4()))
        finally:
            restored = broker('price_set', dict(price, model=MODEL))
        found['price_table_restored_revision'] = restored['revision']
        before_error = sent(ref_b['run_id'])
        found['provider_error'] = refused(model, ref_b['run_id'], str(uuid.uuid4()), proof='provider_error')
        found['provider_error_requests'] = sent(ref_b['run_id']) - before_error
        # Run C: a dollar budget below one worst case refuses before any request.
        ref_c, _, _ = self.launch({'max_usd': 0.000001})
        found['budget_usd'] = refused(model, ref_c['run_id'], str(uuid.uuid4()))
        found['budget_usd_requests'] = sent(ref_c['run_id'])
        ledger = broker('ledger', {})
        for ref in (ref_a, ref_b, ref_c):
            self.stop(ref)
        evaluate_budget(found)
        assert found['provider_error_requests'] == 1 and found['budget_usd_requests'] == 0, found
        runs = {name: ledger['runs'][ref['run_id']] for name, ref in (('a', ref_a), ('b', ref_b), ('c', ref_c))}
        calls = [c for c in ledger['calls'] if c['run_id'] in {ref_a['run_id'], ref_b['run_id'], ref_c['run_id']}]
        return {'allowed_call': found['allowed_call'],
                'refusals': {k: v for k, v in found.items() if k != 'allowed_call'},
                'worst_case_tokens_per_call': worst_tokens,
                'runs': {name: {'limits': r['limits'], 'tokens': r['tokens'], 'usd': r['usd'],
                                'project_limits_revision': r['project_limits_revision']} for name, r in runs.items()},
                'calls': [{k: c.get(k) for k in ('call_id', 'state', 'refusal', 'reserved_usd', 'settled_usd',
                                                 'provider_response_id', 'model', 'http_status',
                                                 'price_table_revision')} for c in calls],
                'price_table': prices}

    def rotation(self):
        record = self.binding()
        old = record['revision']
        ref, _, body = self.launch({'max_actions': 12}, self.credential(record))
        call('action', dict(ref, action='open_landing'))
        call('action', dict(ref, action='open_login'))
        rotated = broker('rotate', {'binding_id': record['binding_id'], 'expected_revision': old})
        begin = time.monotonic()
        next_submit = refused(call, 'action', dict(ref, action='submit_bound_fixture', binding_id=record['binding_id']))
        refusal_ms = int((time.monotonic() - begin) * 1000)
        self.stop(ref)
        same_run = refused(self.launch, {'max_actions': 12}, self.credential(record, old),
                           (ref['run_id'], str(uuid.uuid4()), str(uuid.uuid4())), 2)
        new_run_old_revision = refused(self.launch, {'max_actions': 12}, self.credential(record, old))
        fixture = load('a4_probe_fixture', 'a4-fixture-account.py')
        provisioned = fixture.provision(record['binding_id'])
        ref2, _, _, submitted, latency = self.sign_in(self.binding())
        payload = self.stop(ref2)
        assert next_submit == 'BINDING_REVISION_MISMATCH', next_submit
        assert same_run == 'BINDING_REVISION_MISMATCH' and new_run_old_revision == 'BINDING_REVISION_MISMATCH'
        assert submitted['result']['outcome'] == 'signed_in' and submitted['result']['binding_revision'] == old + 1
        evaluate_receipt_credential(payload, record['binding_id'], old + 1, ['signed_in'])
        return {'old_revision': old, 'new_revision': rotated['revision'], 'rotation_history': rotated['vault'],
                'next_submit_old_revision': next_submit, 'next_submit_refusal_ms': refusal_ms,
                'relaunch_same_run_old_revision': same_run, 'new_run_old_revision': new_run_old_revision,
                'fixture_reprovisioned': {k: provisioned[k] for k in ('binding_revision', 'vault_version')},
                'new_revision_sign_in': submitted['result'], 'new_revision_submit_ms': latency}

    def revocation(self):
        record = self.binding()
        ref, _, _ = self.launch({'max_actions': 12}, self.credential(record))
        call('action', dict(ref, action='open_landing'))
        call('action', dict(ref, action='open_login'))
        begin = time.monotonic()
        revoked = broker('revoke', {'binding_id': record['binding_id']})
        revoke_ms = int((time.monotonic() - begin) * 1000)
        begin = time.monotonic()
        check = refused(broker, 'check', {'run_id': ref['run_id'], 'binding_id': record['binding_id']})
        broker_ms = int((time.monotonic() - begin) * 1000)
        begin = time.monotonic()
        next_submit = refused(call, 'action', dict(ref, action='submit_bound_fixture', binding_id=record['binding_id']))
        submit_ms = int((time.monotonic() - begin) * 1000)
        journal = call('journal', {'attempt_id': ref['attempt_id']})['attempt']
        self.stop(ref)
        relaunch = refused(self.launch, {'max_actions': 12}, self.credential(record))
        assert check == 'BINDING_REVOKED' and next_submit == 'BINDING_REVOKED' and relaunch == 'BINDING_REVOKED', \
            (check, next_submit, relaunch)
        assert not [a for a in journal['actions'] if a['action'] == 'submit_bound_fixture'], journal['actions']
        return {'revoked_at': revoked['revoked_at'], 'revoke_call_ms': revoke_ms, 'broker_check': check,
                'broker_check_ms': broker_ms, 'next_submit': next_submit, 'next_submit_refusal_ms': submit_ms,
                'new_launch': relaunch, 'notice': 'The binding is terminal; authorize a new binding UUID to rerun.'}

    # ----------------------------------------------------------------- run

    def preflight(self):
        status = call('status')
        broker_status = broker('status')
        pub = subprocess.run(['openssl', 'pkey', '-pubin', '-in', str(op.PUBLIC_KEY), '-outform', 'DER'],
                             check=True, capture_output=True).stdout
        preflight = {'accepting_launch': status['accepting_launch'], 'blockers': status['blockers'],
                     'boundary': status['boundary'], 'credential_broker': status.get('credential_broker'),
                     'key_id_matches': status['supervisor']['key_id'] == hashlib.sha256(pub).hexdigest(),
                     'broker_sha256': broker_status['broker']['broker_sha256'],
                     'vault_healthy': broker_status['vault_healthy'], 'routes': broker_status['routes'],
                     'provider': broker_status['provider'], 'prices': broker_status['prices'],
                     'binding': next((b for b in broker_status['bindings'] if b['binding_id'] == self.binding_id), None)}
        print(json.dumps({'preflight': preflight}), flush=True)
        ready = (preflight['accepting_launch'] and preflight['key_id_matches'] and
                 preflight['credential_broker'] == 'available' and preflight['vault_healthy'] and
                 (preflight['binding'] or {}).get('state') == 'active')
        return preflight, ready

    def run(self, only):
        preflight, ready = self.preflight()
        if not ready:
            return {'a4_proof': 'blocked', 'preflight': preflight}
        for name in CASES:
            if not only or name in only:
                self.run_case(name, getattr(self, name))
        passed = all(r['passed'] for r in self.results)
        report = {'a4_proof': 'passed' if passed else 'failed', 'preflight': preflight, 'cases': self.results,
                  'open': ['a4-canary-scan.py (0 matches in every sink) is a separate required step',
                           'the full A3 proof (a3-probe-worker.py) after the supervisor/runner change'] +
                  ([] if passed else ['every failed case above'])}
        path = OUT / ('a4-proof-%s.json' % self.stamp)
        path.write_text(json.dumps(report, indent=2, default=str) + '\n')
        os.chmod(path, 0o600)
        return {'a4_proof': report['a4_proof'], 'report': str(path),
                'passed': [r['case'] for r in self.results if r['passed']],
                'failed': [r['case'] for r in self.results if not r['passed']], 'open': report['open']}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--binding', required=True, help='the authorized binding UUID (a4-broker-operator.py bind)')
    parser.add_argument('--only', nargs='*', choices=CASES)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    result = Proof(args.binding).run(args.only)
    print(json.dumps(result, indent=2, default=str))
    sys.exit(0 if result['a4_proof'] == 'passed' else 1)


if __name__ == '__main__':
    main()
