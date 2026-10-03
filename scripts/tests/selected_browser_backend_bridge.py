"""Test-only JSONL transport: real Node lifecycle to signed host and Chromium.

Only the model provider and installed Incus/nft/Neko boundary are fixtures.
Browser commands, pending requests, blocked proofs and destination grants are
dispatched unchanged to the reviewed supervisor. All websites are local TLS.
"""
import json
import os
import signal
import sys
import threading
import time

from test_selected_browser_composition import BrowserCompositionTests, Origin, s


def tail(path,limit):
    try:
        with path.open('rb') as stream:
            stream.seek(0,2)
            stream.seek(max(0,stream.tell()-limit))
            return stream.read(limit).decode('utf-8','replace')
    except (FileNotFoundError,OSError):
        return ''


def diagnostics(fixture):
    """Bounded local-fixture evidence, including failed/released launch state."""
    try:
        gate=fixture.host.registry.gateway
        attempts=list(fixture.supervisor.state['attempts'].values())
        workers=list(fixture.supervisor.workers.items())
        value=dict(browser_version=fixture.chromium_version,
            gateway=gate.status() if gate else None,
            attempts=[dict(attempt_id=a['attempt_id'],state=a['state'],selected_mode=a.get('selected_mode'),
                selected_code=a.get('selected_code'),stop_reason=a.get('stop_reason'),exit=a.get('exit'),
                spawned=a.get('spawned'),gateway_registered=a.get('gateway_registered')) for a in attempts[:4]],
            workers=[dict(attempt_id=aid,ready=w.ready.is_set(),ended=w.ended.is_set(),
                stderr=w.stderr_tail.decode('utf-8','replace')[-3000:]) for aid,w in workers[:4]],
            browser_process=fixture.host.browser_identity(),service_requests=fixture.browser_service_requests(),
            chromium_log=tail(fixture.root/'guest/chromium.log',3000),
            fetch_log=tail(fixture.root/'guest/fetch-fixture.log',1500),
            received=[dict(method=m[:16],host=h[:128],path=p[:160],body_bytes=len(b)) for m,h,p,b in Origin.received[-10:]],
            upstream=fixture.upstream[-10:],contacts=fixture.host.contacts[-10:],trace=fixture.host.trace[-20:])
        if len(json.dumps(value).encode())>16000:
            value['chromium_log']=value['chromium_log'][-1000:]
            value['fetch_log']=value['fetch_log'][-512:]
            for worker in value['workers']:worker['stderr']=worker['stderr'][-1000:]
            value['trace']=value['trace'][-10:]
        if len(json.dumps(value).encode())>16000:
            return dict(browser_version=fixture.chromium_version[:256],diagnostic_truncated=True,
                attempts=[dict(attempt_id=a['attempt_id'],state=a['state']) for a in attempts[:4]],
                workers=[dict(attempt_id=aid,ready=w.ready.is_set(),ended=w.ended.is_set(),
                    stderr=w.stderr_tail.decode('utf-8','replace')[-256:]) for aid,w in workers[:4]],
                chromium_log=value['chromium_log'][-512:],fetch_log=value['fetch_log'][-256:])
        return value
    except Exception as error:
        return dict(browser_version=fixture.chromium_version,diagnostic_error=type(error).__name__,detail=str(error)[:1000])


class HeldCompletion:
    """Delay delivery of a real guest completion, never invent a completed action."""
    def __init__(self, actual):
        self.actual, self.released = actual, threading.Event()

    def is_set(self):
        return self.actual.is_set() and self.released.is_set()

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.monotonic()+timeout
        return self.actual.wait(timeout) and self.released.wait(None if deadline is None else max(0,deadline-time.monotonic()))


def main():
    # Local diagnostic controls, absent in normal/CI runs. They cannot relax
    # policy or request limits, and never enter the supervisor protocol.
    launch_fault=os.environ.get('PROXYPILOT_TEST_BROWSER_LAUNCH_FAULT')
    if launch_fault not in (None,'refuse','stall'):
        raise AssertionError('Unknown local browser diagnostic control')
    BrowserCompositionTests.setUpClass()
    fixture = BrowserCompositionTests('test_navigation_escalation_grant_settles_unsent_action_and_offers_new_exact_path')
    fixture.setUp()
    decision_count = 0
    calls = []
    held = []
    failures = []
    output_lock=threading.Lock()
    def emit(value):
        with output_lock:
            print(json.dumps(value),flush=True)
    def evidence(phase):
        emit(dict(event='fixture_diagnostics',phase=phase,evidence=diagnostics(fixture)))
    model_digest = s._module('backend_bridge_model_digest','selected-browser-model.py').request_digest
    # Node owns this disposable child. TERM still runs the harness's pinned,
    # unconditional Chromium-session cleanup when a test deadline expires.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    try:
        for raw in sys.stdin:
            message = json.loads(raw)
            method, params = message['method'], message.get('params', {})
            try:
                if method == 'fixture_bootstrap':
                    out = dict(public_key_path=str(fixture.host.pub), vm_uuid=s.VM_UUID,
                               configuration=fixture.c)
                elif method == 'fixture_inspect':
                    attempts = list(fixture.supervisor.state['attempts'].values())
                    out = dict(calls=calls, contacts=fixture.host.contacts, upstream=fixture.upstream,
                               received=[dict(method=m, host=h, path=p, body_bytes=len(b)) for m,h,p,b in Origin.received],
                               attempts=[dict(actions=a['actions'], pending=list(a['selected_pending'].values()),
                                              guest_action_done={str(r['ordinal']):bool(fixture.runtime.actions.get((a['attempt_id'],r['ordinal'])) and fixture.runtime.actions[(a['attempt_id'],r['ordinal'])][1].is_set()) for r in a['actions']},
                                              configuration_json=a['configuration_json']) for a in attempts])
                elif method == 'fixture_diagnostics':
                    out=dict(evidence=diagnostics(fixture),failures=failures[-8:])
                elif method == 'fixture_hold_completion':
                    worker = next(iter(fixture.supervisor.workers.values()))
                    original_send = worker.send
                    def delay_completion(op, **fields):
                        sent = original_send(op, **fields)
                        if op == 'selected_action':
                            worker.send = original_send
                            completion = HeldCompletion(sent[1])
                            held.append(completion)
                            return sent[0], completion, sent[2]
                        return sent
                    worker.send = delay_completion
                    out = dict(held=True)
                elif method == 'fixture_release_completion':
                    if len(held) != 1:
                        raise AssertionError('Exactly one delayed guest completion required')
                    held[0].released.set()
                    out = dict(released=True, real_guest_done=held[0].actual.is_set())
                elif method == 'fixture_close':
                    out = dict(closed=True)
                else:
                    calls.append(dict(method=method, params=params if method in
                        ('selected_browser_action','selected_browser_poll_action','selected_browser_grant_destination') else {}))
                    if method == 'selected_browser_model_status':
                        value = dict(contract_version='selected-browser-model.v1', available=True,
                                     price_table_revision=1, prices=dict(input=.2, output=1, cache_write=.2),
                                     valid_until=s.stamp(time.time()+30))
                        out = dict(value, attestation=fixture.runtime.model._attest(dict(kind='selected-browser-model-status', **value)))
                    elif method == 'selected_browser_model':
                        # No vault, credential or provider is contacted. Keep the
                        # real host admission/output rules and receipt digest.
                        fixture.runtime._model_guard(params)
                        fixture.runtime.model._validate(params)
                        if params['purpose'] != 'decision':
                            raise AssertionError('Unexpected provider purpose in browser continuation proof')
                        candidates = params['input']['candidates']
                        if decision_count == 0:
                            chosen = next(c for c in candidates if c['operation']=='navigate' and 'selected.example/navigation' in c['label'])
                        elif decision_count in (1,3):
                            chosen = next(c for c in candidates if c['operation']=='navigate' and 'frame.example/visit' in c['label'])
                        else:
                            chosen = next(c for c in candidates if c['operation']=='read')
                        decision_count += 1
                        text = json.dumps(dict(kind='candidate', candidate_id=chosen['id']))
                        fixture.runtime.model._output(params, text)
                        usage = dict(prompt_tokens=100, completion_tokens=10)
                        keys = ('run_id','attempt_id','fence','call_id','project_id','project_revision',
                                'project_limits_revision','purpose','policy_hash','guide_version_id','guide_hash','consent_hash')
                        body = dict(kind='selected-browser-model', **{k:params[k] for k in keys},
                                    request_hash=model_digest(params),
                                    response_hash=fixture.runtime.policy.digest(text), usage=usage,
                                    settled_usd='0.0001', price_table_revision=1)
                        out = dict(text=text, usage=usage, settled_usd='0.0001', price_table_revision=1,
                                   attestation=fixture.runtime.model._attest(body))
                    elif method == 'cancel_selected_browser_model':
                        out = dict(cancelled=True, broker_confirmed=True, provider_already_accepted=False)
                    else:
                        if method=='selected_browser_launch':
                            done=threading.Event()
                            evidence('launch_started')
                            def launch_progress():
                                while not done.wait(2):evidence('launch_waiting')
                            observer=threading.Thread(target=launch_progress,daemon=True)
                            observer.start()
                            try:
                                if launch_fault=='refuse':raise s.Refused('BROWSER_START_FAILED')
                                out=fixture.runtime.dispatch(method,params)
                                if launch_fault=='stall':
                                    # The real guest/browser is running. Hold its
                                    # response past the unchanged Node deadline;
                                    # SIGTERM must clean that exact owned browser.
                                    evidence('launch_response_held')
                                    threading.Event().wait(60)
                            finally:
                                done.set()
                                evidence('launch_finished')
                        else:
                            if method=='selected_browser_stop':evidence('before_stop')
                            out = fixture.runtime.dispatch(method, params)
                emit(dict(id=message['id'], result=out))
                if method == 'fixture_close':
                    break
            except Exception as error:
                failure=dict(method=method,code=getattr(error,'code',type(error).__name__),detail=str(error)[:2000])
                failures.append(failure)
                if len(failures)>8:failures.pop(0)
                snapshot=diagnostics(fixture)
                emit(dict(event='fixture_diagnostics',phase='request_failed',evidence=snapshot))
                emit(dict(id=message['id'],error=dict(code=failure['code'],detail=failure['detail'],
                    diagnostics=json.dumps(snapshot)[:12000])))
    finally:
        fixture.tearDown()


if __name__ == '__main__':
    main()
