"""Test-only JSONL transport: real Node lifecycle to signed host and Chromium.

Only the model provider and installed Incus/nft/Neko boundary are fixtures.
Browser commands, pending requests, blocked proofs and destination grants are
dispatched unchanged to the reviewed supervisor. All websites are local TLS.
"""
import json
import signal
import sys
import threading
import time

from test_selected_browser_composition import BrowserCompositionTests, Origin, s


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
    BrowserCompositionTests.setUpClass()
    fixture = BrowserCompositionTests('test_navigation_escalation_grant_settles_unsent_action_and_offers_new_exact_path')
    fixture.setUp()
    decision_count = 0
    calls = []
    held = []
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
                        out = fixture.runtime.dispatch(method, params)
                print(json.dumps(dict(id=message['id'], result=out)), flush=True)
                if method == 'fixture_close':
                    break
            except Exception as error:
                print(json.dumps(dict(id=message['id'], error=dict(code=getattr(error,'code',type(error).__name__),
                    detail=str(error)[:2000], diagnostics=fixture.diagnostics()[-6000:]))), flush=True)
    finally:
        fixture.tearDown()


if __name__ == '__main__':
    main()
