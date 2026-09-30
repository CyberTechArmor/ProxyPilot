#!/usr/bin/env python3
"""Operator-run A3 worker proof against the INSTALLED production supervisor.

Every case goes through the supervisor's real sockets, the same transient
guest unit builder and the same teardown/receipt path the backend will use.
Proof workloads (CPU, memory, process, disk, time, escape, descendant,
launch-failure fixtures) are selectable only on the root operator socket.
Receipts are verified independently with the host public key. The guest
crash case reboots the disposable proof VM's guest kernel (sync, then an
immediate sysrq reboot); pass --skip-guest-crash to leave the boot as is.
A host reboot is not performed here and stays an open proof.

--human-session is not a case: it launches one browser attempt, serves the
operator's human page on loopback for a real person, keeps the lease alive
only until they take over, and records the verified receipt.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import statistics
import subprocess
import sys
import threading
import time
import traceback
import uuid

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


op = load('a3_probe_operator', 'a3-worker-operator.py')
sup = load('a3_probe_supervisor', 'a3-worker-supervisor.py')
installer = sup.installer
VM = sup.VM
OUT = installer.STATE / 'proof'
POLICY = hashlib.sha256(b'a3-worker-proof-policy-v1').hexdigest()
CASES = ('sessions', 'minimums', 'human_takeover', 'origin_refusals', 'escape', 'guest_root_egress', 'cpu', 'memory',
         'tasks', 'disk', 'runtime', 'actions', 'descendant', 'lease_expiry', 'stale_fence', 'launch_failure',
         'backend_refusals', 'backend_view', 'supervisor_crash', 'guest_crash')


def new_ids():
    return str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())


def spec(run, attempt, workspace, fence=1, limits=None):
    limits = limits or {}
    return {'run_id': run, 'attempt_id': attempt, 'workspace_id': workspace, 'fence': fence,
            'policy_digest': POLICY, 'project_limits_revision': 1, 'origin': sup.ORIGIN, 'target': sup.TARGET,
            'limits': limits, 'install': sup.install_shape(limits)}


def call(method, params=None, backend=False, timeout=180):
    return op.call(method, params, path=op.BACKEND_SOCKET if backend else op.OPERATOR_SOCKET, timeout=timeout)


def refused(method, params, backend=False):
    try:
        call(method, params, backend)
    except op.CallFailed as error:
        return error.code
    return None


def guest(argv, timeout=60, check=False):
    return subprocess.run(['incus', 'exec', VM, '--', *argv], capture_output=True, text=True, timeout=timeout,
                          check=check)


def counters():
    document = installer.table()
    return {row['counter']['name']: row['counter'].get('packets', 0) for row in document['nftables']
            if 'counter' in row}


def wait_terminal(attempt, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        record = call('journal', {'attempt_id': attempt})['attempt']
        if record['state'] in ('stopped', 'lost', 'refused'):
            return record
        time.sleep(1)
    raise AssertionError('attempt did not reach a terminal state in %ss' % seconds)


def receipt_ok(receipt):
    valid, payload = op.verify_receipt(receipt)
    assert valid and receipt['descendants_gone'] is True and receipt['workspace_removed'] is True, receipt
    return payload


def stop(ref, reason='proof'):
    return receipt_ok(call('stop', dict(ref, reason=reason))['receipt'])


def unit_journal(unit):
    result = guest(['journalctl', '-u', unit + '.service', '--no-pager', '-o', 'cat', '-n', '15'], timeout=30)
    return [line for line in result.stdout.splitlines() if 'result' in line.lower() or 'killed' in line.lower()][-5:]


def mib(value):
    return None if value in (None, '') else round(int(value) / 1048576, 1)


def counters_of(text):
    """cgroup key/value files such as memory.events and cpu.stat."""
    return {k: int(v) for k, v in (line.split() for line in (text or '').splitlines() if len(line.split()) == 2)}


def pressure(value):
    if not value:
        return None
    first = value.splitlines()[0].split()
    return {k: float(v) for k, v in (field.split('=') for field in first[1:4])}


class Proof:
    def __init__(self, skip_guest_crash):
        self.skip_guest_crash = skip_guest_crash
        self.results = []
        self.measurements = {'sessions': []}
        OUT.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())

    def save_png(self, name, view):
        path = OUT / ('%s-%s.png' % (self.stamp, name))
        path.write_bytes(base64.b64decode(view['png_base64']))
        os.chmod(path, 0o600)
        return {'file': str(path), 'bytes': path.stat().st_size,
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

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
        print(json.dumps({k: v for k, v in entry.items() if k != 'trace'}, default=str)[:1800], flush=True)

    # ------------------------------------------------------------- cases

    def launch(self, limits=None, workload=None, fence=1, ids=None, backend=False):
        run, attempt, workspace = ids or new_ids()
        body = spec(run, attempt, workspace, fence, limits)
        if workload:
            body['workload'] = workload
        result = call('launch', body, backend=backend)
        return {'run_id': run, 'attempt_id': attempt, 'fence': fence}, result, (run, attempt, workspace)

    def session(self, label, limits=None, sustain=0):
        """One measured browser session; `sustain` adds model reads plus human screenshots."""
        started = time.monotonic()
        ref, launched, _ = self.launch(limits)
        launch_seconds = round(time.monotonic() - started, 3)
        latencies, results = {}, {}
        for action in ('open_landing', 'open_login', 'read_session', 'read_workspace', 'open_landing'):
            begin = time.monotonic()
            results[action] = call('action', dict(ref, action=action))['result']
            latencies.setdefault(action, []).append(int((time.monotonic() - begin) * 1000))
        for _ in range(sustain):
            begin = time.monotonic()
            assert call('action', dict(ref, action='read_session'))['result'] == {
                'untrusted_page_claim_authenticated': False}
            latencies.setdefault('read_session', []).append(int((time.monotonic() - begin) * 1000))
            call('view', ref)
            time.sleep(1)
        view = call('view', ref)
        stats = call('unit_stats', {'attempt_id': ref['attempt_id']})
        record = call('journal', {'attempt_id': ref['attempt_id']})['attempt']
        payload = stop(ref)
        assert results['open_login'] == {'at': 'login_dialog'}, results
        assert results['read_session'] == {'untrusted_page_claim_authenticated': False}, results
        assert results['read_workspace'] == {'at': 'workspace'}, results
        events, cpu = counters_of(stats.get('memory.events')), counters_of(stats.get('cpu.stat'))
        memory_stat = {k: mib(v) for k, v in (stats.get('memory.stat') or {}).items()}
        return {'launch_seconds': launch_seconds, 'browser_start_seconds': record.get('browser_start_seconds'),
                'seconds': round(time.monotonic() - started, 1), 'action_latency_ms': latencies,
                'screenshot': self.save_png(label, view),
                'unit_memory_peak_mib': mib(stats.get('memory.peak')),
                'unit_memory_current_mib': mib(stats.get('memory.current')),
                'unit_memory_stat_mib': memory_stat, 'unit_shmem_mib': memory_stat.get('shmem'),
                'unit_memory_events': events, 'unit_oom_kills': events.get('oom_kill'),
                'unit_pids_peak': stats.get('pids.peak'), 'unit_cpu_stat': cpu,
                'unit_cpu_throttled_usec': cpu.get('throttled_usec'),
                'unit_memory_pressure': pressure(stats.get('memory.pressure')),
                'unit_cpu_pressure': pressure(stats.get('cpu.pressure')),
                'guest_mem_available_mib': (stats.get('guest_mem_available_kib') or 0) // 1024,
                'guest_mem_total_mib': (stats.get('guest_mem_total_kib') or 0) // 1024,
                'guest_cpu_pressure': pressure(stats.get('guest_pressure_cpu')),
                'guest_memory_pressure': pressure(stats.get('guest_pressure_memory')),
                'root_free_mib': stats.get('root_free_mib'), 'root_total_mib': stats.get('root_total_mib'),
                'var_log_mib': stats.get('var_log_mib'), 'apt_cache_mib': stats.get('apt_cache_mib'),
                'host_qemu_tree_rss_kib': stats.get('host_qemu_tree_rss_kib'),
                'limits_applied': launched['limits_applied'], 'boot_id': launched['boot_id'],
                'receipt_reason': payload['reason']}

    @staticmethod
    def brief(samples):
        keys = ('launch_seconds', 'browser_start_seconds', 'seconds', 'unit_memory_peak_mib', 'unit_shmem_mib',
                'unit_oom_kills', 'unit_pids_peak', 'unit_cpu_throttled_usec', 'host_qemu_tree_rss_kib',
                'guest_mem_available_mib')
        return [{k: v for k, v in item.items() if k in keys} for item in samples]

    def sessions(self):
        observed = [self.session('session-%d' % index) for index in range(3)]
        self.measurements['sessions'] = observed
        return self.brief(observed)

    def minimums(self):
        """The browser and a human view must work AT the worker minimums, not only above them."""
        limits = dict(sup.WORKER_MINIMUM)
        observed = [self.session('minimums-%d' % index, limits, sustain=15) for index in range(2)]
        for sample in observed:
            applied = sample['limits_applied']
            assert (applied['cpu_quota_percent'], applied['memory_mib'], applied['temporary_disk_mib']) == (
                100, limits['memory_mib'], limits['temporary_disk_mib']), applied
            assert sample['unit_oom_kills'] == 0, sample['unit_memory_events']
            assert sample['unit_memory_peak_mib'] <= limits['memory_mib'], sample['unit_memory_peak_mib']
        self.measurements['minimums'] = observed
        return {'limits': limits, 'samples': self.brief(observed)}

    def human_takeover(self):
        ref, _, ids = self.launch()
        call('action', dict(ref, action='open_landing'))
        before = self.save_png('human-before', call('view', ref))
        assert refused('input', dict(ref, input={'kind': 'key', 'key': 'Tab'})) == 'ATTEMPT_NOT_ACTIVE'
        assert call('takeover', ref)['state'] == 'human'
        assert refused('action', dict(ref, action='read_session'), backend=True) == 'TAKEN_OVER'
        point = call('locate', dict(ref, target='sign_in_button'))
        assert call('observe', ref)['untrusted_dialog_open'] is False
        call('input', dict(ref, input={'kind': 'click', 'x': point['x'], 'y': point['y']}))
        time.sleep(0.5)
        opened = call('observe', ref)['untrusted_dialog_open']
        dialog = self.save_png('human-dialog', call('view', ref))
        call('input', dict(ref, input={'kind': 'key', 'key': 'Escape'}))
        time.sleep(0.5)
        closed = call('observe', ref)['untrusted_dialog_open']
        assert opened is True and closed is False, (opened, closed)
        assert refused('input', dict(ref, input={'kind': 'text', 'text': 'x\n'})) == 'INVALID_INPUT'
        payload = stop(ref, 'taken_over')
        assert refused('launch', spec(*ids)) == 'ATTEMPT_EXISTS'
        assert refused('action', dict(ref, action='read_session')) == 'ATTEMPT_NOT_ACTIVE'
        return {'click': point, 'dialog_opened_by_human_click': opened, 'dialog_open_after_escape': closed,
                'model_action_after_takeover': 'TAKEN_OVER', 'screenshots': [before, dialog],
                'receipt_reason': payload['reason']}

    def origin_refusals(self):
        ref, _, _ = self.launch()
        call('action', dict(ref, action='open_landing'))
        probe = call('egress_probe', ref)
        stop(ref)
        attempts, navigations = probe['page_attempts'], probe['navigation_attempts']
        assert attempts and set(attempts.values()) == {'refused'}, attempts
        # The page's own CSP may refuse cross-origin requests first; top-level
        # navigations are outside that CSP and must be refused by the runner.
        assert 'reached' not in navigations.values(), navigations
        assert all(navigations[k] == 'refused' for k in ('cross_origin', 'raw_ip', 'alternate_port')), navigations
        hosts = sorted({row.get('host') for row in probe['browser_layer_refusals']})
        assert {'example.com', '1.1.1.1'} <= set(hosts), hosts
        return {'page_attempts': attempts, 'navigation_attempts': navigations,
                'browser_layer_refused_hosts': hosts,
                'browser_layer_refusals': len(probe['browser_layer_refusals'])}

    def proof_workload(self, workload, limits=None, send=True):
        ref, launched, ids = self.launch(limits, workload)
        result = call('proof', ref, timeout=120) if send else None
        return ref, launched, ids, result

    def escape(self):
        ref, launched, _, result = self.proof_workload('proof:escape')
        stop(ref)
        found = [e for e in result['events'] if e.get('case') == 'escape'][0]['results']
        assert found['proxy_listener'] == 'connected', found
        allowed = {'proxy_listener', 'capabilities_effective', 'no_new_privs', 'uid'}
        leaks = {k: v for k, v in found.items() if k not in allowed and not str(v).startswith('refused')}
        assert not leaks, leaks
        assert found['capabilities_effective'] == '0000000000000000' and found['no_new_privs'] == '1'
        assert found['uid'] == 65534
        # EPERM: no CAP_NET_RAW (EPROTONOSUPPORT would not test privilege).
        assert found['raw_ipv4_socket'] == 'refused:1', found['raw_ipv4_socket']
        return found

    def guest_root_egress(self):
        code = r'''import json, socket, threading
out = {}
def tcp(name, family, address):
    try:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.settimeout(4); s.connect(address)
        out[name] = 'connected'
    except OSError as e:
        out[name] = 'refused:%s' % (e.errno if e.errno is not None else 'timeout')
def udp(name, address):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(4); s.sendto(bytes.fromhex('abcd01000001000000000000076578616d706c6503636f6d0000010001'), address); s.recvfrom(512)
        out[name] = 'answered'
    except OSError as e:
        out[name] = 'refused:%s' % (e.errno if e.errno is not None else 'timeout')
jobs = [threading.Thread(target=tcp, args=a) for a in (
    ('proxy', socket.AF_INET, ('10.185.17.1', 18083)), ('host_incus_api', socket.AF_INET, ('10.185.17.1', 8443)),
    ('host_ssh', socket.AF_INET, ('10.185.17.1', 22)), ('host_backend', socket.AF_INET, ('10.185.17.1', 3001)),
    ('host_https', socket.AF_INET, ('10.185.17.1', 443)), ('public_ipv4', socket.AF_INET, ('1.1.1.1', 443)),
    ('public_ipv4_http', socket.AF_INET, ('93.184.215.14', 80)),
    ('host_ipv6', socket.AF_INET6, ('fd42:53c1:d5e6:16b0::1', 8443)),
    ('public_ipv6', socket.AF_INET6, ('2606:4700:4700::1111', 443)))]
jobs += [threading.Thread(target=udp, args=a) for a in (('host_dns_udp', ('10.185.17.1', 53)), ('public_dns_udp', ('1.1.1.1', 53)))]
[j.start() for j in jobs]; [j.join() for j in jobs]
print(json.dumps(out, sort_keys=True))'''
        before = counters()
        result = guest(['/usr/bin/python3', '-I', '-c', code], timeout=60)
        after = counters()
        found = json.loads(result.stdout)
        delta = {k: after.get(k, 0) - before.get(k, 0) for k in after}
        assert found.pop('proxy') == 'connected', found
        assert all(v.startswith('refused') for v in found.values()), found
        assert delta.get('denied_ipv4', 0) > 0 and delta.get('denied_ipv6', 0) > 0 and delta.get('allowed_proxy', 0) > 0, delta
        return {'guest_root_results': found, 'fence_counter_delta': delta}

    def cpu(self):
        ref, launched, _, result = self.proof_workload('proof:cpu', {'cpu': 1})
        stop(ref)
        event = [e for e in result['events'] if e.get('case') == 'cpu'][0]
        ratio = event['usage_usec'] / event['wall_usec']
        assert launched['limits_applied']['cpu_quota_percent'] == 100
        assert event['nr_throttled'] > 0 and ratio <= 1.2, event
        return {'cpu_quota_percent': 100, 'usage_to_wall': round(ratio, 3), **event}

    def memory(self):
        ref, launched, _, result = self.proof_workload('proof:memory', {'memory_mib': 1024})
        record = wait_terminal(ref['attempt_id'], 60)
        payload = receipt_ok(record['receipt'])
        allocated = max([e.get('allocated_mib', 0) for e in result['events']] or [0])
        exit_state = (record.get('exit') or {})
        journal = unit_journal(record['unit'])
        oom = exit_state.get('result') == 'oom-kill' or any('oom' in line.lower() for line in journal)
        assert launched['limits_applied']['memory_mib'] == 1024 and oom and allocated <= 1024, (exit_state, journal, allocated)
        return {'memory_max_mib': 1024, 'allocated_before_kill_mib': allocated, 'exit': exit_state,
                'unit_journal': journal, 'receipt_reason': payload['reason']}

    def tasks(self):
        ref, _, _, result = self.proof_workload('proof:tasks')
        stop(ref)
        event = [e for e in result['events'] if e.get('case') == 'tasks'][0]
        assert event.get('pids_max') == str(sup.TASKS_MAX) and 0 < event.get('denied_after_threads', 10 ** 9) < sup.TASKS_MAX, event
        return event

    def disk(self):
        ref, launched, _, result = self.proof_workload('proof:disk', {'temporary_disk_mib': 64})
        stop(ref)
        event = [e for e in result['events'] if e.get('case') == 'disk'][0]
        assert event['enospc'] is True and event['written_mib'] <= 64, event
        return {'temporary_disk_mib': 64, **event}

    def runtime(self):
        started = time.monotonic()
        ref, launched, ids, _ = self.proof_workload('proof:time', {'max_seconds': 15}, send=False)
        deadline = time.monotonic() + 40
        record = None
        while time.monotonic() < deadline:
            record = call('journal', {'attempt_id': ref['attempt_id']})['attempt']
            if record['state'] in ('stopped', 'lost'):
                break
            try:
                call('renew', ref)
            except op.CallFailed:
                pass
            time.sleep(2)
        elapsed = round(time.monotonic() - started, 1)
        payload = receipt_ok(record['receipt'])
        assert record['state'] == 'stopped' and 10 <= elapsed <= 30, (record['state'], elapsed)
        assert launched['runtime_max_seconds'] <= 15
        run, _, workspace = ids
        relaunch = refused('launch', spec(run, str(uuid.uuid4()), workspace, 2, {'max_seconds': 15}))
        assert relaunch == 'DEADLINE', relaunch
        return {'runtime_max_seconds': launched['runtime_max_seconds'], 'terminated_after_seconds': elapsed,
                'stop_reason': payload['reason'], 'exit': record.get('exit'), 'relaunch_same_run': relaunch}

    def actions(self):
        ref, _, ids = self.launch({'max_actions': 3})
        for action in ('open_landing', 'read_session', 'read_session'):
            call('action', dict(ref, action=action))
        fourth = refused('action', dict(ref, action='read_session'))
        stop(ref)
        run, _, workspace = ids
        relaunch = refused('launch', spec(run, str(uuid.uuid4()), workspace, 2, {'max_actions': 3}))
        assert fourth == 'ACTION_LIMIT' and relaunch == 'ACTION_LIMIT', (fourth, relaunch)
        return {'max_actions': 3, 'fourth_action': fourth, 'new_attempt_same_run': relaunch}

    def descendant(self):
        ref, _, _, result = self.proof_workload('proof:descendant')
        event = [e for e in result['events'] if e.get('case') == 'descendant'][0]
        payload = stop(ref)
        alive = guest(['test', '-d', '/proc/%d' % event['detached_pid']], timeout=20).returncode == 0
        assert event['same_cgroup'] is True and not alive, (event, alive)
        return {'detached_pid': event['detached_pid'], 'same_cgroup': True, 'alive_after_stop': alive,
                'evidence': payload['evidence']}

    def lease_expiry(self):
        ref, _, _ = self.launch()
        call('action', dict(ref, action='open_landing'))
        record = wait_terminal(ref['attempt_id'], sup.LEASE_SECONDS + 30)
        payload = receipt_ok(record['receipt'])
        after = refused('renew', ref)
        assert payload['reason'] == 'lease_expired' and after == 'ATTEMPT_NOT_ACTIVE', (payload['reason'], after)
        return {'stop_reason': payload['reason'], 'renew_after_expiry': after}

    def stale_fence(self):
        ref, _, ids = self.launch(fence=5)
        older = refused('action', dict(ref, fence=4, action='open_landing'))
        stop(ref)
        run, _, workspace = ids
        same = refused('launch', spec(run, str(uuid.uuid4()), workspace, 5))
        ref2, _, _ = self.launch(fence=6, ids=(run, str(uuid.uuid4()), workspace))
        stop(ref2)
        assert older == 'STALE_FENCE' and same == 'STALE_FENCE', (older, same)
        return {'older_fence_action': older, 'same_fence_new_attempt': same, 'higher_fence_launch': 'ok'}

    def launch_failure(self):
        run, attempt, workspace = new_ids()
        code = refused('launch', dict(spec(run, attempt, workspace), workload='proof:fail'))
        ref = {'run_id': run, 'attempt_id': attempt, 'fence': 1}
        payload = stop(ref)
        again = refused('launch', spec(run, attempt, workspace))
        assert code == 'LAUNCH_FAILED' and payload['reason'] == 'launch_failed' and again == 'ATTEMPT_EXISTS'
        return {'launch': code, 'receipt_reason': payload['reason'], 'relaunch': again}

    def backend_refusals(self):
        run, attempt, workspace = new_ids()
        body = spec(run, attempt, workspace)
        found = {
            'journal': refused('journal', {'attempt_id': attempt}, True),
            'takeover': refused('takeover', {'run_id': run, 'attempt_id': attempt, 'fence': 1}, True),
            'input': refused('input', {'run_id': run, 'attempt_id': attempt, 'fence': 1,
                                       'input': {'kind': 'key', 'key': 'Tab'}}, True),
            'proof_workload': refused('launch', dict(body, workload='proof:cpu'), True),
            'argv_field': refused('launch', dict(body, argv=['/bin/sh']), True),
            'other_origin': refused('launch', dict(body, origin='https://example.com'), True),
            'below_minimum': refused('launch', spec(run, attempt, workspace, 1, {'memory_mib': 256}), True),
        }
        ref, _, _ = self.launch(ids=(run, attempt, workspace), backend=True)
        call('action', dict(ref, action='open_landing'), backend=True)
        found.update({
            # A8 read is exact and never renews or changes an attempt.
            'record_extra_field': refused('step_record', dict(ref, ordinal=1, action='open_landing', page=True), True),
            'record_wrong_fence': refused('step_record', dict(ref, fence=2, ordinal=1, action='open_landing'), True),
            # A4: submit needs the binding ID field, and this run pinned no binding.
            'credential_action': refused('action', dict(ref, action='submit_bound_fixture', binding_id=workspace), True),
            'credential_action_without_binding': refused('action', dict(ref, action='submit_bound_fixture'), True),
            'unknown_action': refused('action', dict(ref, action='download'), True),
            'url_field': refused('action', dict(ref, action='open_landing', url='https://example.com'), True),
            'operator_stop_reason': refused('stop', dict(ref, reason='taken_over'), True),
            # A7: the backend's takeover hands control only to an open live viewer of this attempt.
            'takeover_unknown_viewer': refused('takeover', dict(ref, conn='0' * 16), True),
            # A5: model_step is bound to the pinned policy bytes; the proof flag is operator-only.
            'model_step_foreign_policy': refused('model_step', dict(ref, call_id=str(uuid.uuid4()), policy='{}',
                                                                    guide='{}', observations=[],
                                                                    allowed=['read_files', 'read_workspace']), True),
            'model_step_proof_flag': refused('model_step', dict(ref, call_id=str(uuid.uuid4()), policy='{}', guide='{}',
                                                                observations=[], allowed=['read_files', 'read_workspace'],
                                                                proof='provider_error'), True)})
        live = call('status', {}, backend=True).get('live') is True
        receipt = call('stop', dict(ref, reason='cancelled'), backend=True)['receipt']
        receipt_ok(receipt)
        record = call('step_record', dict(ref, ordinal=1, action='open_landing'), backend=True)['record']
        assert set(record) <= {'ordinal', 'action', 'state', 'at', 'latency_ms', 'error'}
        assert (record['ordinal'], record['action'], record['state']) == (1, 'open_landing', 'done')
        assert call('step_record', dict(ref, ordinal=2, action='open_landing'), backend=True) == {'record': None}
        # A7 made `takeover` a backend method (the dashboard's, which needs a
        # viewer connection); the operator's takeover and input stay operator-only.
        expected = {'journal': 'METHOD_NOT_ALLOWED', 'takeover': 'INVALID_REQUEST', 'input': 'METHOD_NOT_ALLOWED',
                    'proof_workload': 'INVALID_LAUNCH', 'argv_field': 'INVALID_LAUNCH', 'other_origin': 'INVALID_LAUNCH',
                    'below_minimum': 'PROJECT_LIMIT_BELOW_WORKER_MINIMUM',
                    'credential_action': 'CREDENTIAL_NOT_BOUND', 'credential_action_without_binding': 'INVALID_REQUEST',
                    'unknown_action': 'INVALID_BROWSER_ACTION',
                    'url_field': 'INVALID_REQUEST', 'operator_stop_reason': 'INVALID_REQUEST',
                    'model_step_foreign_policy': 'RUN_POLICY_MISMATCH', 'model_step_proof_flag': 'INVALID_REQUEST',
                    'takeover_unknown_viewer': 'LIVE_CONN_UNKNOWN' if live else 'LIVE_UNAVAILABLE'}
        expected.update(record_extra_field='INVALID_REQUEST', record_wrong_fence='STALE_FENCE')
        assert found == expected, found
        return found

    def backend_view(self):
        """A6: the backend socket's view is one bounded frame of the model's attempt, pixels only."""
        ref, _, _ = self.launch(backend=True)
        call('action', dict(ref, action='open_landing'), backend=True)
        lease = call('journal', {'attempt_id': ref['attempt_id']})['attempt']['lease']
        frame = call('view', ref, backend=True)
        assert set(frame) == {'png_base64', 'width', 'height'}, sorted(frame)
        assert base64.b64decode(frame['png_base64']).startswith(b'\x89PNG\r\n\x1a\n')
        assert (frame['width'], frame['height']) == (1280, 800), (frame['width'], frame['height'])
        busy = refused('view', ref, backend=True)
        time.sleep(1.2)
        again = call('view', ref, backend=True)
        assert set(again) == {'png_base64', 'width', 'height'}
        # Watching never renews: the journal lease moves only with the coordinator's renew.
        after = call('journal', {'attempt_id': ref['attempt_id']})['attempt']['lease']
        extra = refused('view', dict(ref, url='https://example.com'), backend=True)
        operator_url = 'untrusted_page_url' in call('view', ref)
        assert call('takeover', ref)['state'] == 'human'
        time.sleep(1.2)
        during_takeover = refused('view', ref, backend=True)
        backend_input = refused('input', dict(ref, input={'kind': 'key', 'key': 'Tab'}), True)
        payload = stop(ref, 'taken_over')
        after_stop = refused('view', ref, backend=True)
        found = {'busy': busy, 'lease_renewed_by_view': after != lease, 'extra_field': extra,
                 'operator_view_has_url': operator_url, 'during_takeover': during_takeover,
                 'backend_input': backend_input, 'after_stop': after_stop}
        expected = {'busy': 'VIEW_BUSY', 'lease_renewed_by_view': False, 'extra_field': 'INVALID_REQUEST',
                    'operator_view_has_url': True, 'during_takeover': 'TAKEN_OVER',
                    'backend_input': 'METHOD_NOT_ALLOWED', 'after_stop': 'ATTEMPT_NOT_ACTIVE'}
        assert found == expected, found
        return dict(found, screenshot=self.save_png('backend-view', frame), receipt_reason=payload['reason'])

    def supervisor_crash(self):
        restarts = lambda: int(installer.execute(['systemctl', 'show', 'proxypilot-a3-supervisor.service',  # noqa: E731
                                                  '--property=NRestarts', '--value']).strip() or 0)
        before = restarts()
        ref, _, _ = self.launch()
        call('action', dict(ref, action='open_landing'))
        try:
            call('proof_crash_mid_action', dict(ref, action='read_session'), timeout=30)
            raise AssertionError('supervisor answered instead of crashing')
        except (op.CallFailed, OSError, ValueError):
            pass
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                call('status')
                break
            except (op.CallFailed, OSError):
                time.sleep(1)
        record = wait_terminal(ref['attempt_id'], 60)
        payload = receipt_ok(record['receipt'])
        states = [(a['action'], a['state']) for a in record['actions']]
        unit = guest(['systemctl', 'is-active', record['unit'] + '.service'], timeout=20).stdout.strip()
        assert restarts() > before and record['state'] == 'lost', (before, record['state'])
        assert states == [('open_landing', 'done'), ('read_session', 'uncertain')], states
        assert payload['uncertain_actions'] == [2] and unit in ('inactive', 'unknown', 'failed'), (payload, unit)
        return {'restarts': [before, restarts()], 'actions': states, 'receipt_reason': payload['reason'],
                'uncertain_actions': payload['uncertain_actions'], 'guest_unit_after': unit}

    def guest_crash(self):
        if self.skip_guest_crash:
            raise AssertionError('skipped by --skip-guest-crash; guest crash recovery remains unproved')
        old_boot = guest(['cat', '/proc/sys/kernel/random/boot_id'], check=True).stdout.strip()
        ref, launched, _ = self.launch()
        call('action', dict(ref, action='open_landing'))
        try:
            guest(['/bin/sh', '-c', 'echo s > /proc/sysrq-trigger; sleep 1; echo b > /proc/sysrq-trigger'], timeout=15)
        except subprocess.TimeoutExpired:
            pass
        deadline, new_boot = time.monotonic() + 240, None
        while time.monotonic() < deadline:
            try:
                value = guest(['cat', '/proc/sys/kernel/random/boot_id'], timeout=15).stdout.strip()
                if value and value != old_boot:
                    new_boot = value
                    break
            except subprocess.TimeoutExpired:
                pass
            time.sleep(3)
        assert new_boot, 'guest did not come back with a new boot id'
        record = wait_terminal(ref['attempt_id'], 90)
        payload = receipt_ok(record['receipt'])
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and not call('status')['accepting_launch']:
            time.sleep(3)
        ref2, relaunched, _ = self.launch()
        call('action', dict(ref2, action='open_landing'))
        stop(ref2)
        assert relaunched['boot_id'] == new_boot and payload['bound_boot_id'] == old_boot
        egress = self.guest_root_egress()
        return {'old_boot': old_boot, 'new_boot': new_boot, 'receipt_reason': payload['reason'],
                'receipt_evidence': payload['evidence'], 'relaunch_bound_boot': relaunched['boot_id'],
                'post_reboot_fence': egress}

    # ------------------------------------------------------ human session

    def human_session(self, listen, minutes):
        """A real person uses the human page on one live browser attempt. Not an automated case."""
        ref, launched, _ = self.launch()
        call('action', dict(ref, action='open_landing'))
        token = secrets.token_urlsafe(24)
        server = op.human_server(ref, listen, token)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(json.dumps({'human_session': ref, 'boot_id': launched['boot_id']}), flush=True)
        print('From your workstation:  ssh -L %d:127.0.0.1:%d root@<this host>' % (listen[1], listen[1]))
        print('Then open  http://127.0.0.1:%d/%s/  within %d minutes: Take over, click Sign in, type into the '
              'dialog, press Esc, then Stop and tear down.' % (listen[1], token, minutes), flush=True)
        seen, model_after, deadline = [], None, time.monotonic() + minutes * 60
        record = None
        try:
            while time.monotonic() < deadline:
                record = call('journal', {'attempt_id': ref['attempt_id']})['attempt']
                if not seen or seen[-1] != record['state']:
                    seen.append(record['state'])
                if record['state'] in sup.TERMINAL:
                    break
                if record['state'] == 'running':
                    # Stands in for the coordinator until the person takes over; from
                    # then on only their page keeps the attempt alive.
                    try:
                        call('renew', ref)
                    except op.CallFailed:
                        pass
                elif record['state'] == 'human' and model_after is None:
                    model_after = refused('action', dict(ref, action='read_session'), backend=True)
                time.sleep(5)
        except KeyboardInterrupt:
            pass
        finally:
            server.shutdown()
            server.server_close()
        record = call('journal', {'attempt_id': ref['attempt_id']})['attempt']
        if record['state'] in sup.TERMINAL:
            receipt = record['receipt']
        else:
            reason = 'taken_over' if record['state'] == 'human' else 'proof'
            receipt = call('stop', dict(ref, reason=reason))['receipt']
            record = call('journal', {'attempt_id': ref['attempt_id']})['attempt']
        payload = receipt_ok(receipt)
        log = [entry[1] for entry in record.get('log', [])]
        result = {'human_session': 'taken_over' if 'takeover' in log else 'not_taken_over', 'ref': ref,
                  'states_seen': seen, 'model_action_after_takeover': model_after, 'log': record.get('log'),
                  'receipt_reason': payload['reason'], 'receipt_verified': True,
                  'actions_performed': payload['actions_performed'], 'bound_boot_id': payload['bound_boot_id']}
        path = OUT / ('human-session-%s.json' % self.stamp)
        path.write_text(json.dumps(result, indent=2, default=str) + '\n')
        os.chmod(path, 0o600)
        result['report'] = str(path)
        return result

    # --------------------------------------------------------------- run

    def preflight(self):
        status = call('status')
        pub = subprocess.run(['openssl', 'pkey', '-pubin', '-in', str(op.PUBLIC_KEY), '-outform', 'DER'],
                             check=True, capture_output=True).stdout
        preflight = {'accepting_launch': status['accepting_launch'], 'blockers': status['blockers'],
                     'boundary': status['boundary'], 'key_id_matches': status['supervisor']['key_id'] ==
                     hashlib.sha256(pub).hexdigest(), 'active': status['active']}
        print(json.dumps({'preflight': preflight}), flush=True)
        return preflight, status['accepting_launch'] and preflight['key_id_matches']

    def run(self, only):
        preflight, ready = self.preflight()
        if not ready:
            return {'worker_proof': 'blocked', 'preflight': preflight}
        state = sup.Host().vm_state()
        self.measurements['qemu_tree_rss_kib_idle'] = sup.process_tree_rss_kib(state['pid'])[0]
        for name in CASES:
            if not only or name in only:
                self.run_case(name, getattr(self, name))
        passed = all(r['passed'] for r in self.results)
        report = {'worker_proof': 'passed' if passed else 'failed', 'preflight': preflight,
                  'cases': self.results, 'measurements': self.measurements,
                  'open': ['host reboot persistence of fence/proxy/supervisor ordering (not exercised here)',
                           'backend container socket mount (activation stays off)'] +
                  ([] if passed else ['every failed case above'])}
        path = OUT / ('worker-proof-%s.json' % self.stamp)
        path.write_text(json.dumps(report, indent=2, default=str) + '\n')
        os.chmod(path, 0o600)
        sessions = self.measurements.get('sessions') or []

        def spread(key, samples=None):
            values = [s[key] for s in (sessions if samples is None else samples)
                      if isinstance(s.get(key), (int, float))]
            return None if not values else {'min': min(values), 'median': statistics.median(values), 'max': max(values)}
        minimum_runs = self.measurements.get('minimums') or []
        return {'worker_proof': report['worker_proof'], 'report': str(path),
                'passed': [r['case'] for r in self.results if r['passed']],
                'failed': [r['case'] for r in self.results if not r['passed']],
                'sizing': {'browser_start_seconds': spread('browser_start_seconds'),
                           'launch_seconds': spread('launch_seconds'),
                           'unit_memory_peak_mib': spread('unit_memory_peak_mib'),
                           'host_qemu_tree_rss_kib': spread('host_qemu_tree_rss_kib'),
                           'qemu_tree_rss_kib_idle': self.measurements.get('qemu_tree_rss_kib_idle'),
                           'guest_mem_available_mib': spread('guest_mem_available_mib'),
                           'root_free_mib': spread('root_free_mib'),
                           'at_minimums_unit_memory_peak_mib': spread('unit_memory_peak_mib', minimum_runs),
                           'at_minimums_unit_shmem_mib': spread('unit_shmem_mib', minimum_runs),
                           'at_minimums_cpu_throttled_usec': spread('unit_cpu_throttled_usec', minimum_runs),
                           'at_minimums_oom_kills': [s.get('unit_oom_kills') for s in minimum_runs]},
                'open': report['open']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', nargs='*', choices=CASES)
    parser.add_argument('--skip-guest-crash', action='store_true')
    parser.add_argument('--human-session', action='store_true',
                        help='launch one browser attempt and serve the human page for a real person')
    parser.add_argument('--listen', type=op.parse_listen, default=('127.0.0.1', 18090))
    parser.add_argument('--minutes', type=int, default=15)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    if args.human_session:
        proof = Proof(args.skip_guest_crash)
        preflight, ready = proof.preflight()
        if not ready:
            print(json.dumps({'human_session': 'blocked', 'preflight': preflight}))
            sys.exit(1)
        result = proof.human_session(args.listen, max(1, min(args.minutes, 60)))
        print(json.dumps(result, indent=2, default=str))
        sys.exit(0 if result['human_session'] == 'taken_over' else 1)
    result = Proof(args.skip_guest_crash).run(args.only)
    print(json.dumps(result, indent=2, default=str))
    sys.exit(0 if result['worker_proof'] == 'passed' else 1)


if __name__ == '__main__':
    main()
