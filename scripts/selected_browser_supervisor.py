#!/usr/bin/env python3
"""Installed selected-browser lifecycle, composed with the proven A3 supervisor.

No checkout/host browser fallback. Installed acceptance is operator-owned and
cannot be supplied over the backend socket. Guest code is a fixed reviewed,
compressed bundle, never caller code. Requests remain CDP-paused while a separate
host pump checks exact gateway authority, so a navigation cannot deadlock its own
request approvals. No secret values or private body bytes are journalled.
"""
import base64
import copy
import datetime
import hashlib
import importlib.util
import ipaddress
import json
import math
from pathlib import Path
import queue
import re
import socket
import threading
import time
import zlib

CONTRACT = 'selected-browser.v1'
METHODS = frozenset('selected_browser_status selected_browser_launch selected_browser_observe selected_browser_action selected_browser_poll_action selected_browser_pending selected_browser_approve_request selected_browser_deny_request selected_browser_grant_destination selected_browser_auth selected_browser_auth_inventory selected_browser_confirm_authentication selected_browser_pause selected_browser_resume selected_browser_takeover selected_browser_release selected_browser_view selected_browser_stage selected_browser_offer_input selected_browser_renew selected_browser_stop selected_browser_live selected_browser_control'.split())
MODEL_METHODS = frozenset(('selected_browser_model_status', 'selected_browser_model', 'cancel_selected_browser_model'))
FILES = ('selected_browser_supervisor.py', 'selected_browser_policy.py', 'selected_browser_gateway.py',
         'selected_browser_worker.py', 'selected_browser_contract.py', 'selected-browser-schemas.json', 'selected-browser-model.py')
ROOT_MARKER = 'selected-browser-acceptance.json'
MAX_DISCARDED_REFS = 4096
PROOFS = ('incus_identity', 'nft_effective', 'chromium_managed_policy', 'gateway_before_contact', 'selected_browser_lifecycle')


def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_deadline(value, refused):
    try:
        t = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if t.utcoffset() is None:
            raise ValueError()
        return t.timestamp()
    except (ValueError, TypeError, AttributeError):
        raise refused('INVALID_REQUEST') from None


class SelectedBrowserSupervisor:
    def __init__(self, supervisor, refused, helpers):
        self.s, self.refused, self.h = supervisor, refused, helpers
        self.contract = sibling('pp_selected_contract_host', 'selected_browser_contract.py')
        self.policy = sibling('pp_selected_policy_host', 'selected_browser_policy.py')
        self.gateway = sibling('pp_selected_gateway_host', 'selected_browser_gateway.py')
        self.model = sibling('pp_selected_model_host', 'selected-browser-model.py').SelectedBrowserModelBridge(supervisor, refused)
        self.actions = {}
        self.results = {}
        self.controllers = {}
        self.live_viewers = {}
        self.live_sessions = {}
        self.event_queues = {}
        self.pumps = {}
        self._bundle = None
        self.loaded_files = {path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in self._files()}

    def fail(self, code):
        raise self.refused(code)

    def _configuration(self, params):
        if not self.h.exact(params, ('configuration_json', 'configuration_sha256')):
            self.fail('INVALID_REQUEST')
        text, pin = params['configuration_json'], params['configuration_sha256']
        if (not isinstance(text, str) or not 1 <= len(text.encode('utf-8')) <= 200000 or
                not isinstance(pin, str) or not self.h.HEX64.fullmatch(pin) or
                hashlib.sha256(text.encode()).hexdigest() != pin):
            self.fail('BROWSER_POLICY_HASH_MISMATCH')
        try:
            c = self.policy.strict_json(text)
            self.contract.validate_configuration(c)
            if self.contract.canonical_json(c) != text:
                self.fail('BROWSER_POLICY_NONCANONICAL')
            return c
        except Exception as e:
            self.fail(getattr(e, 'code', 'BROWSER_DRAFT_INVALID'))

    def _files(self):
        return tuple(self.h.HERE / f for f in FILES)

    def _acceptance(self, boundary=None):
        """Fresh root proof inventory. Never create or update this marker."""
        self.s.host.verify_install(self.s.own_files)
        if hasattr(self.s.host, 'selected_acceptance'):
            # Dependency injection is Python-only; no wire field invokes it.
            marker = self.s.host.selected_acceptance()
        else:
            path = self.h.installer.CONFIG / ROOT_MARKER
            self.h.installer.secure(path)
            marker = self.policy.strict_json(path.read_text())
        fields = ('v', 'accepted', 'vm_uuid', 'boot_id', 'fence_fingerprint', 'expires_at', 'files', 'proofs',
                  'managed_policy_sha256', 'protected_hosts', 'protected_addresses', 'internal_policies')
        if (not self.h.exact(marker, fields) or marker['v'] != 1 or marker['accepted'] is not True or
                marker['vm_uuid'] != self.h.VM_UUID or not self.h.UUID.fullmatch(str(marker['boot_id'])) or
                not self.h.HEX64.fullmatch(str(marker['fence_fingerprint'])) or
                type(marker['expires_at']) not in (float, int) or marker['expires_at'] <= self.s.clock() or
                not self.h.exact(marker['proofs'], PROOFS) or
                any(not isinstance(v, str) or not self.h.HEX64.fullmatch(v) for v in marker['proofs'].values()) or
                marker['managed_policy_sha256'] != hashlib.sha256(self.h.runner.live_policy_bytes()).hexdigest() or
                not marker['protected_hosts'] or not marker['protected_addresses']):
            self.fail('BROWSER_INSTALLED_ACCEPTANCE_UNVERIFIED')
        for path in self._files():
            if (marker['files'].get(path.name) != hashlib.sha256(path.read_bytes()).hexdigest() or
                    marker['files'].get(path.name) != self.loaded_files[path.name]):
                self.fail('BROWSER_INSTALLED_HELPER_CHANGED')
        if hashlib.sha256(self.s.source.encode()).hexdigest() != hashlib.sha256((self.h.HERE/'a3-worker-guest.py').read_bytes()).hexdigest():
            self.fail('BROWSER_INSTALLED_HELPER_CHANGED')
        boundary = boundary or self.s.host.full_boundary()
        if boundary['boot_id'] != marker['boot_id'] or boundary['fence_fingerprint'] != marker['fence_fingerprint']:
            self.fail('BROWSER_INSTALLED_ACCEPTANCE_STALE')
        if self.s.live_available() is None:
            self.fail('BROWSER_LIVE_INSTALL_UNVERIFIED')
        health = self.s.host.selected_gateway('health', {})
        expected = {name:hashlib.sha256((self.h.HERE/name).read_bytes()).hexdigest() for name in
                    ('selected_browser_gateway.py','selected_browser_policy.py','a3-origin-proxy.py')}
        if (not self.h.exact(health,('contract_version','protocol','active','files')) or
                health['contract_version'] != CONTRACT or health['protocol'] != 'selected-gateway.v1' or
                health['files'] != expected or type(health['active']) is not bool):
            self.fail('BROWSER_GATEWAY_HELPER_UNVERIFIED')
        if health['active'] and not self.s._live():
            self.fail('BROWSER_GATEWAY_UNAVAILABLE_OR_ACTIVE')
        return marker, boundary

    def _sign(self, payload):
        body = self.h.canonical(payload)
        return 'sbr1.%s.%s' % (self.h.b64url(body), self.h.b64url(self.s.host.sign(body)))

    def status(self, params):
        c = self._configuration(params)
        out = dict(contract_version=CONTRACT, supervisor_version=CONTRACT,
                   policy_sha256=params['configuration_sha256'], available=False, verified_supervisor=False,
                   isolation=False, destinations=False, site_policy=False, reachability='pending_launch_check')
        try:
            marker, boundary = self._acceptance()
            # Validate destinations against protected inventory without target
            # DNS. Dummy public pins are NOT installed or returned as authority.
            for d in c['destinations']['allowed_origins']:
                parts = self.policy.url_parts(d['origin'], origin_only=True)
                if (self.policy.PROTECTED_NAMES.search(parts['host']) or
                        any(parts['host'] == h or parts['host'].endswith('.' + h) for h in marker['protected_hosts'])):
                    self.fail('PROTECTED_DESTINATION')
                try:
                    a = str(ipaddress.ip_address(parts['host']))
                except ValueError:
                    a = None
                if a is not None and (a in marker['protected_addresses'] or self.policy.address_scope(a) not in ('public', 'internal')):
                    self.fail('PROTECTED_DESTINATION')
            out.update(available=not self.s.stopping and not self.s._live(), verified_supervisor=True,
                       isolation=True, destinations=True, site_policy=True, vm_uuid=boundary['vm_uuid'],
                       valid_until=self.h.stamp(min(marker['expires_at'], self.s.clock() + 30)),
                       code=None if not self.s._live() else 'ACTIVE_ATTEMPT')
        except Exception as e:
            out['code'] = getattr(e, 'code', 'BROWSER_INSTALLED_ACCEPTANCE_UNVERIFIED')
        out['attestation'] = self._sign(dict(kind='selected-browser-status', **out))
        return out

    def _limits(self, c, project):
        project = self.h.validate_limits(project)
        limits = {k: c['budgets'][k] for k in self.h.LIMIT_KEYS}
        for k, cap in project.items():
            limits[k] = min(limits[k], cap)
        for k, minimum in self.h.WORKER_MINIMUM.items():
            if limits[k] < minimum:
                self.fail('PROJECT_LIMIT_BELOW_WORKER_MINIMUM')
        return limits

    def _network_plan(self, c, marker, deadline):
        targets = []
        for d in c['destinations']['allowed_origins']:
            parts = self.policy.url_parts(d['origin'], origin_only=True)
            # Name denies happen BEFORE DNS. No target fetch or TLS handshake.
            if (self.policy.PROTECTED_NAMES.search(parts['host']) or parts['host'] == 'localhost' or
                    parts['host'].endswith('.localhost') or
                    any(parts['host'] == h or parts['host'].endswith('.' + h) for h in marker['protected_hosts'])):
                self.fail('PROTECTED_DESTINATION')
            answers = self.s.host.selected_resolve(parts)
            scopes = {self.policy.address_scope(a) for a in answers}
            if scopes == {'public'}:
                route_sha = self.s.host.selected_route_hash(answers)
                target = self.policy.build_public_target(d['origin'], answers, route_sha,
                    marker['protected_hosts'], marker['protected_addresses'])
            elif scopes == {'internal'}:
                selected = [r for r in marker['internal_policies'] if r.get('ref') == c['destinations']['network_policy_ref']
                            and r.get('target', {}).get('origin') == d['origin']]
                if len(selected) != 1:
                    self.fail('INTERNAL_EXACT_POLICY_REQUIRED')
                target = selected[0]['target']
                if (set(answers) != set(target['addresses']) or
                        self.s.host.selected_route_hash(answers) != target['route_sha256']):
                    self.fail('INTERNAL_EXACT_POLICY_STALE')
            else:
                self.fail('DNS_ADDRESS_CHANGED')
            targets.append(target)
        return dict(schema='proxypilot.selected-browser.network-plan.v1', expires_at=int(min(marker['expires_at'], deadline)),
                    targets=targets, protected_hosts=marker['protected_hosts'], protected_addresses=marker['protected_addresses'])

    def _source(self):
        if self._bundle is None:
            blobs = dict(contract=(self.h.HERE / 'selected_browser_contract.py').read_text(),
                         schemas=json.loads((self.h.HERE / 'selected-browser-schemas.json').read_text()),
                         worker=(self.h.HERE / 'selected_browser_worker.py').read_text(), guest=self.s.source)
            blob = base64.b64encode(zlib.compress(json.dumps(blobs).encode(), 9)).decode()
            self._bundle = "import base64,json,sys,types,zlib\nb=json.loads(zlib.decompress(base64.b64decode(%r)))\nm=types.ModuleType('selected_browser_contract');m.SCHEMAS=b['schemas'];m.__file__='<owned-contract>';sys.modules[m.__name__]=m\nexec(compile(b['contract'],'<owned-contract>','exec'),m.__dict__)\nw=types.ModuleType('selected_browser_worker');w.__file__='<owned-worker>';sys.modules[w.__name__]=w\nexec(compile(b['worker'],'<owned-worker>','exec'),w.__dict__)\nexec(compile(b['guest'],'<owned-guest>','exec'),globals())\n" % blob
        return self._bundle

    def launch(self, params):
        fields = ('contract_version', 'project_id', 'run_id', 'attempt_id', 'workspace_id', 'fence',
                  'project_limits_revision', 'project_limits', 'configuration_json', 'configuration_sha256',
                  'guide_version_id', 'guide_hash', 'consent_hash', 'deadline_at')
        optional = ('project_revision', 'configuration_id', 'configuration_revision')
        if (not isinstance(params, dict) or set(params) - set(fields + optional) or not set(fields) <= set(params) or
                params['contract_version'] != CONTRACT or
                any(not isinstance(params[k], str) or not self.h.UUID.fullmatch(params[k])
                    for k in ('project_id', 'run_id', 'attempt_id', 'workspace_id', 'guide_version_id')) or
                any(not isinstance(params[k], str) or not self.h.HEX64.fullmatch(params[k]) for k in ('guide_hash', 'consent_hash')) or
                not self.h.safe_int(params['fence'], 1) or not self.h.safe_int(params['project_limits_revision'], 1)):
            self.fail('INVALID_REQUEST')
        if (any(k in params and not self.h.safe_int(params[k], 1) for k in ('project_revision', 'configuration_revision')) or
                ('configuration_id' in params and (not isinstance(params['configuration_id'], str) or not self.h.UUID.fullmatch(params['configuration_id'])))):
            self.fail('INVALID_REQUEST')
        c = self._configuration({k: params[k] for k in ('configuration_json', 'configuration_sha256')})
        if c['work']['guide_ref'] != dict(id=params['guide_version_id'], sha256=params['guide_hash']):
            self.fail('BROWSER_GUIDE_PIN_MISMATCH')
        limits = self._limits(c, params['project_limits'])
        supplied_deadline = parse_deadline(params['deadline_at'], self.refused)
        if supplied_deadline <= self.s.clock():
            self.fail('DEADLINE')
        with self.s.launch_lock:
            with self.s.lock:
                if self.s.stopping or self.s._live():
                    self.fail('ACTIVE_ATTEMPT')
                if params['attempt_id'] in self.s.state['attempts'] or params['run_id'] in self.s.state['runs']:
                    self.fail('ATTEMPT_EXISTS')
            marker, boundary = self._acceptance()
            deadline = min(supplied_deadline, self.s.clock() + limits['max_seconds'])
            network = self._network_plan(c, marker, deadline)
            ident = dict(project_id=params['project_id'], run_id=params['run_id'], attempt_id=params['attempt_id'],
                         fence=params['fence'], policy_sha256=params['configuration_sha256'])
            plan = self.h.worker_plan(limits, boundary['mem_total_kib'], boundary['guest_cpus'])
            runtime = max(1, math.ceil(deadline - self.s.clock()))
            attempt = dict(attempt_id=params['attempt_id'], run_id=params['run_id'], fence=params['fence'],
                original_fence=params['fence'], selected_identity=ident, policy_sha256=params['configuration_sha256'],
                workspace_id=params['workspace_id'], state='launching', spawned=False,
                unit=self.h.UNIT_PREFIX + params['attempt_id'], workload='selected_browser_v1', boot_id=boundary['boot_id'],
                qemu_pid=boundary['pid'], fence_fingerprint=boundary['fence_fingerprint'], plan=plan,
                runtime_max_seconds=runtime, actions=[], launched_at=self.h.stamp(self.s.clock()),
                lease=self.s.clock() + self.h.LEASE_SECONDS, selected_mode='agent', selected_pending={},
                configuration_json=params['configuration_json'], gateway_registered=False)
            with self.s.lock:
                self.s.state['runs'][params['run_id']] = dict(policy_digest=params['configuration_sha256'],
                    configuration_sha256=params['configuration_sha256'], project_id=params['project_id'],
                    project_limits_revision=params['project_limits_revision'], limits=limits, credential=None,
                    guide_hash=params['guide_hash'], consent_hash=params['consent_hash'], action_count=0,
                    guide_version_id=params['guide_version_id'],
                    max_actions=limits['max_actions'], deadline=deadline, max_fence=params['fence'],
                    attempts=[params['attempt_id']], first_launch_at=self.h.stamp(self.s.clock()))
                self.s.state['runs'][params['run_id']].update({k:params[k] for k in optional if k in params})
                self.s.state['attempts'][params['attempt_id']] = attempt
                self.s.state['active'] = params['attempt_id']
                self.s._save()
            try:
                gateway = self.s.host.selected_gateway('register', dict(configuration=c, configuration_json=params['configuration_json'],
                                                                      network_plan=network, identity=ident))
                with self.s.lock:
                    attempt['gateway_registered'] = True
                    attempt['network_plan_sha256'] = gateway['network_plan_sha256']
                    attempt['spawned'] = True
                    self.s._save()
                events = queue.Queue(maxsize=64)
                self.event_queues[params['attempt_id']] = events
                def sink(event):
                    if event.get('event', '').startswith('selected_'):
                        try:
                            events.put_nowait(event)
                        except queue.Full:
                            threading.Thread(target=self.s._safe_teardown, args=(params['attempt_id'], 'selected_event_overflow'), daemon=True).start()
                config = dict(attempt_id=params['attempt_id'], workload='browser', spki=boundary['spki'], live=True,
                              selected_browser=dict(run_id=params['run_id'], attempt_id=params['attempt_id'], fence=params['fence'],
                                  policy_sha256=params['configuration_sha256'], configuration=c))
                worker = self.h.Worker(self.s.host.spawn(attempt['unit'], self.h.unit_properties(plan, runtime), self._source(), config), event_sink=sink)
                self.s.workers[params['attempt_id']] = worker
                pump = threading.Thread(target=self._pump, args=(params['attempt_id'], worker, events), daemon=True)
                self.pumps[params['attempt_id']] = pump
                pump.start()
                worker.ready.wait(self.h.READY_SECONDS)
                first = worker.first or {}
                if first.get('event') != 'ready':
                    self.fail('BROWSER_START_FAILED')
                self.s._check_readback(attempt['unit'], plan, runtime)
                with self.s.lock:
                    attempt.update(state='running', workspace=first.get('workspace'), live=first.get('live'),
                                   lease=self.s._next_lease(self.s.state['runs'][params['run_id']]))
                    self.s._save()
                out = dict(contract_version=CONTRACT, **{k: ident[k] for k in ('run_id', 'attempt_id', 'fence', 'policy_sha256')},
                            limits_applied=plan, deadline_at=self.h.stamp(deadline),
                            lease_expires_at=self.h.stamp(attempt['lease']), network_plan_sha256=gateway['network_plan_sha256'],
                            vm_uuid=boundary['vm_uuid'], boot_id=boundary['boot_id'], workspace_id=params['workspace_id'],
                            original_fence=params['fence'])
                out['attestation'] = self._sign(dict(kind='selected-browser-launch', **out))
                return out
            except Exception as e:
                self.s._safe_teardown(params['attempt_id'], 'launch_failed')
                self.fail(getattr(e, 'code', 'LAUNCH_FAILED'))

    def _ref(self, params, extras=(), allow_stopped=False):
        names = ('run_id', 'attempt_id', 'fence', 'policy_sha256', *extras)
        if (not self.h.exact(params, names) or
                any(not isinstance(params[k], str) or not self.h.UUID.fullmatch(params[k]) for k in ('run_id', 'attempt_id')) or
                not self.h.safe_int(params['fence'], 1) or not isinstance(params['policy_sha256'], str) or
                not self.h.HEX64.fullmatch(params['policy_sha256'])):
            self.fail('INVALID_REQUEST')
        with self.s.lock:
            a = self.s._attempt(params)
            if a.get('workload') != 'selected_browser_v1' or a.get('policy_sha256') != params['policy_sha256']:
                self.fail('BROWSER_POLICY_HASH_MISMATCH')
            if not allow_stopped:
                self.s._usable(a)
                if a['state'] not in ('running', 'human'):
                    self.fail('ATTEMPT_NOT_ACTIVE')
            return a

    def _request(self, attempt, op, **fields):
        worker = self.s.workers.get(attempt['attempt_id'])
        if worker is None:
            self.fail('CHANNEL_CLOSED')
        reply = worker.request(op, self.h.ACTION_SECONDS, **fields)
        if reply.get('ok') is not True:
            self.fail(reply.get('error', 'BROWSER_PROTOCOL_INVALID'))
        return reply.get('result')

    def _pump(self, attempt_id, worker, events):
        while not worker.ended.is_set():
            try:
                event = events.get(timeout=0.2)
            except queue.Empty:
                continue
            a = self.s.state['attempts'].get(attempt_id)
            if a is None or a['state'] == 'stopping' or a['state'] in self.h.TERMINAL:
                continue
            if event.get('event') != 'selected_request':
                if event.get('event') == 'selected_popup':
                    # Informational only; the independent request gate enforces
                    # every popup request before upstream contact.
                    continue
                with self.s.lock:
                    a['selected_mode'] = 'paused'
                    a['selected_code'] = str(event.get('code', 'BROWSER_REQUEST_BLOCKED'))[:64]
                    self.s._save()
                continue
            ref = event.get('request_ref')
            if ref in a.get('selected_discarded_requests', ()):
                worker.fire('selected_request_decision', request_ref=ref, decision='block', code='REQUEST_ALREADY_DISCARDED')
                continue
            try:
                with self.s.lock:
                    if event.get('metadata', {}).get('current_action') is not None:
                        context = event['metadata']['current_action']
                        record = next((r for r in a['actions'] if r['ordinal'] == context.get('ordinal')), None)
                        if not record or record.get('context') != context:
                            self.fail('REQUEST_ACTION_CONTEXT_MISMATCH')
                    a['selected_pending'][ref] = dict(state='reviewing', current_action=event['metadata'].get('current_action'),
                        metadata_sha256=self.policy.digest(self.policy.canonical(event['metadata'])))
                    self.s._save()
                with self.s.lock:
                    if a.get('selected_mode') == 'paused' and a.get('selected_code') == 'USER_PAUSED':
                        self.fail('GATEWAY_PAUSED')
                    out = self.s.host.selected_gateway('request', dict(identity=a['selected_identity'], request_ref=ref, metadata=event['metadata']))
                    if out['decision'] == 'approval_required':
                        meta = event['metadata']
                        public = dict(kind='network_effect', request_ref=ref, binding_sha256=out['binding_sha256'],
                            origin=out['origin'], role=meta['role'], method=meta['method'], body_sha256=meta['body_sha256'], body_bytes=meta['body_bytes'],
                            purpose='Review this %s request to %s' % (meta['method'], out['origin']),
                            request_sha256=self.policy.digest(self.policy.canonical(meta)),url_sha256=self.policy.digest(meta['url']),no_contact=True)
                        if meta['current_action'] is not None:
                            public['current_action'] = {k: meta['current_action'][k] for k in ('ordinal', 'snapshot_ref', 'candidate_ref')}
                        a['selected_pending'][ref] = public
                        a['selected_mode'] = 'paused'
                        a['selected_code'] = out['code']
                    self.s._save()
                    if out['decision'] == 'allow':
                        worker.fire('selected_request_decision', request_ref=ref, decision='allow', ticket=out['ticket'])
                        a['selected_pending'].pop(ref, None)
                        self.s._save()
            except Exception as e:
                with self.s.lock:
                    a['selected_mode'], a['selected_code'] = 'paused', getattr(e, 'code', 'BROWSER_GATEWAY_UNAVAILABLE')
                    if getattr(e, 'code', None) in ('OFF_LIST_DESTINATION', 'DESTINATION_ROLE_DENIED'):
                        meta = event['metadata']
                        parts = self.policy.url_parts(meta['url'])
                        a['selected_pending'][ref] = dict(kind='off_list_destination', origin=parts['origin'], role=meta['role'],
                            purpose='Review %s access for this %s request' % (meta['role'], meta['method']), request_ref=ref,
                            method=meta['method'], url_sha256=hashlib.sha256(meta['url'].encode()).hexdigest(),
                            request_sha256=self.policy.digest(self.policy.canonical(meta)), no_contact=True)
                        a.setdefault('selected_escalations', {})[ref] = dict(metadata=meta, state='blocked')
                    else:
                        a['selected_pending'].pop(ref, None)
                    self._mark_blocked_request(a, ref, event.get('metadata', {}).get('current_action'))
                    self.s._save()
                try:
                    worker.fire('selected_request_decision', request_ref=ref, decision='block', code=a['selected_code'])
                except Exception:
                    pass

    def observe(self, params):
        a = self._ref(params)
        if a.get('selected_mode') != 'agent':
            self.fail('BROWSER_OBSERVATION_PAUSED')
        usage = self.s.host.selected_gateway('status',dict(identity=a['selected_identity']))
        if usage['effects_sent'] != usage['auth_effects_acknowledged'] or usage['effects_uncertain']:
            self.fail('AUTH_READBACK_REQUIRED')
        out = self._request(a, 'selected_observe')
        if not isinstance(out, dict) or not self.h.exact(out, ('snapshot_ref', 'observation', 'candidates', 'source_refs', 'input_targets', 'page')):
            self.fail('BROWSER_OBSERVATION_INVALID')
        with self.s.lock:
            a['selected_snapshot'] = out['snapshot_ref']
            a['selected_candidates'] = out['candidates']
            a['selected_input_targets'] = out['input_targets']
            self.s._save()
        return out

    def action(self, params):
        a = self._ref(params, ('envelope',))
        envelope = params['envelope']
        try:
            self.contract.validate_action(envelope)
        except Exception:
            self.fail('BROWSER_ACTION_INVALID')
        with self.s.lock:
            if a.get('selected_mode') != 'agent' or any(r['state'] == 'started' for r in a['actions']):
                self.fail('BROWSER_ACTION_PAUSED_OR_BUSY')
            if any(r['state'] == 'uncertain' for r in a['actions']):
                self.fail('BROWSER_ACTION_UNCERTAIN')
            if any(envelope[k] != params[k] for k in ('run_id', 'attempt_id', 'fence', 'policy_sha256')):
                self.fail('BROWSER_ACTION_IDENTITY_MISMATCH')
            candidates = a.get('selected_candidates', [])
            candidate = next((c for c in candidates if c['candidate_ref'] == envelope['candidate_ref']), None)
            if (candidate is None or candidate['operation'] != envelope['operation'] or
                    envelope['snapshot_ref'] != a.get('selected_snapshot')):
                self.fail('BROWSER_ACTION_STALE')
            run = self.s._usable(a)
            if run['action_count'] >= run['max_actions'] or envelope['ordinal'] != run['action_count'] + 1:
                self.fail('ACTION_LIMIT_OR_ORDINAL_INVALID')
            if candidate['effect'] in ('external_change', 'unknown') and envelope['approval_ref'] is None:
                self.fail('BROWSER_ACTION_APPROVAL_REQUIRED')
            context = {k: envelope[k] for k in ('ordinal', 'candidate_ref', 'snapshot_ref', 'approval_ref')}
            record = dict(ordinal=envelope['ordinal'], action=envelope['operation']['kind'], state='started', context=context,
                          envelope_sha256=self.policy.digest(self.policy.canonical(envelope)), at=self.h.stamp(self.s.clock()))
            usage = self.s.host.selected_gateway('status', dict(identity=a['selected_identity']))
            record['usage_start'] = {k: usage[k] for k in ('requests', 'response_bytes', 'effects_sent', 'effects_uncertain')}
            run['action_count'] += 1
            a['actions'].append(record)
            self.s._save()
            worker = self.s.workers.get(a['attempt_id'])
            if worker is None:
                self.fail('CHANNEL_CLOSED')
            sent = worker.send('selected_action', envelope=envelope)
            self.actions[(a['attempt_id'], envelope['ordinal'])] = sent
        return dict(kind='pending', state='started', ordinal=envelope['ordinal'])

    def _mark_blocked_request(self, a, ref, context):
        if context is not None:
            record = next((r for r in a['actions'] if r.get('context') == context), None)
            if record and record['state'] == 'started':
                refs = record.setdefault('blocked_request_refs', [])
                if ref not in refs:
                    refs.append(ref)

    def _remember_discarded(self, a, refs):
        if (not isinstance(refs, (list,tuple)) or len(refs) > MAX_DISCARDED_REFS or
                any(not isinstance(ref,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',ref) for ref in refs)):
            self.fail('BROWSER_PAUSE_PROOF_INVALID')
        with self.s.lock:
            previous = a.setdefault('selected_discarded_requests', [])
            new = list(dict.fromkeys([*previous,*refs]))
            if len(new) > MAX_DISCARDED_REFS:
                self.fail('BROWSER_REQUEST_REFERENCE_LIMIT')
            a['selected_discarded_requests'] = new
            self.s._save()

    def _guest_pause(self, a):
        out = self._request(a, 'selected_pause')
        if (not self.h.exact(out, ('paused','discarded_request_refs')) or out.get('paused') is not True or
                not isinstance(out.get('discarded_request_refs'),list) or len(out['discarded_request_refs']) > 64):
            self.fail('BROWSER_PAUSE_PROOF_INVALID')
        self._remember_discarded(a, out['discarded_request_refs'])
        return out

    def _blocked_result(self, a, record, usage):
        refs = record.get('blocked_request_refs', [])
        if (not 1 <= len(refs) <= 64 or len(set(refs)) != len(refs) or
                any(not isinstance(ref,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',ref) for ref in refs)):
            self.fail('BROWSER_BLOCKED_ACTION_PROOF_INVALID')
        self._remember_discarded(a, record['blocked_request_refs'])
        proof = dict(kind='selected-browser-blocked-action', contract_version=CONTRACT,
                     vm_uuid=self.h.VM_UUID, boot_id=a['boot_id'], workspace_id=a['workspace_id'],
                     network_plan_sha256=a['network_plan_sha256'], original_fence=a['original_fence'],
                     **{k:a[k] for k in ('run_id','attempt_id')},
                     fence=a['selected_identity']['fence'], policy_sha256=a['selected_identity']['policy_sha256'],
                     ordinal=record['ordinal'], envelope_sha256=record['envelope_sha256'],
                     request_refs=record['blocked_request_refs'], no_effect_sent=True, replay_allowed=False,
                     ledger_sha256=usage['ledger_sha256'], usage={k:usage[k] for k in ('requests','response_bytes')})
        result = dict(kind='done', state='blocked', ordinal=record['ordinal'],
                      code='BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT',
                      usage=dict(proof['usage'], artifact_bytes=0), usage_mode='cumulative',
                      facts=[dict(code='BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT', source_ref=None)],
                      attestation=self._sign(proof))
        record['state'], record['blocked_proof'] = 'blocked', result
        self.s._save()
        self.actions.pop((a['attempt_id'], record['ordinal']), None)
        self.results[(a['attempt_id'], record['ordinal'])] = result
        return result

    def _settle_blocked_actions(self, a, refs):
        records = [r for r in a['actions'] if r['state'] == 'started' and
                   set(r.get('blocked_request_refs', ())) & set(refs)]
        deadline = time.monotonic() + self.h.ACTION_SECONDS
        for record in records:
            sent = self.actions.get((a['attempt_id'], record['ordinal']))
            if sent is None or not sent[1].wait(max(0, deadline - time.monotonic())):
                self.fail('BROWSER_BLOCKED_ACTION_UNSETTLED')
            usage = self.s.host.selected_gateway('status', dict(identity=a['selected_identity']))
            with self.s.lock:
                if (usage['inflight'] or usage['outstanding_requests'] or
                        usage['effects_sent'] != record['usage_start']['effects_sent'] or
                        usage['effects_uncertain'] != record['usage_start']['effects_uncertain']):
                    self.fail('BROWSER_ACTION_UNCERTAIN')
                self._blocked_result(a, record, usage)

    def poll_action(self, params):
        a = self._ref(params, ('ordinal',))
        if not self.h.safe_int(params['ordinal'], 1):
            self.fail('INVALID_REQUEST')
        record = next((r for r in a['actions'] if r['ordinal'] == params['ordinal']), None)
        if record is None:
            self.fail('UNKNOWN_ACTION')
        if record.get('blocked_proof'):
            return record['blocked_proof']
        if record['state'] in ('completed','uncertain'):
            # A retained destination review is independent of action outcome.
            # Never hide a durable uncertainty behind that review on later polls.
            return self.results.get((a['attempt_id'],params['ordinal']),
                dict(kind='uncertain',state=record['state'],ordinal=params['ordinal']))
        sent = self.actions.get((a['attempt_id'], params['ordinal']))
        pending = self.pending({k:params[k] for k in ('run_id','attempt_id','fence','policy_sha256')})['pending']
        current_usage = None
        # A before-contact destination block finishes the original guest action,
        # but deliberately retains its escalation for human review. Return the
        # measured action settlement before that retained escalation: the backend
        # cannot authorize a grant while the original action is still reserved.
        # Completion alone is insufficient; fresh wire counters must also be idle.
        blocked_finished_idle = False
        if record.get('blocked_request_refs') and sent is not None and sent[1].is_set():
            current_usage = self.s.host.selected_gateway('status', dict(identity=a['selected_identity']))
            blocked_finished_idle = not current_usage['inflight'] and not current_usage['outstanding_requests']
        if pending and not blocked_finished_idle:
            request = pending[0]
            if request['kind'] == 'network_effect':
                return dict(kind='request_approval', request=request)
            return dict(kind='off_list', escalation={k:v for k,v in request.items() if k != 'kind'})
        if sent is None:
            return self.results.get((a['attempt_id'], params['ordinal']), record.get('blocked_proof',
                dict(kind='uncertain', state=record['state'], ordinal=params['ordinal'])))
        if not sent[1].is_set():
            return dict(kind='pending', state='started', ordinal=params['ordinal'])
        reply = sent[2].get('reply', {})
        if current_usage is None:
            current_usage = self.s.host.selected_gateway('status', dict(identity=a['selected_identity']))
        if current_usage['inflight'] or current_usage['outstanding_requests']:
            return dict(kind='pending', state='started', ordinal=params['ordinal'])
        usage = {k: current_usage[k] for k in ('requests', 'response_bytes')}
        artifact = (reply.get('result') or {}).get('artifact') if isinstance(reply.get('result'), dict) else None
        usage['artifact_bytes'] = artifact.get('byte_count', 0) if isinstance(artifact, dict) else 0
        with self.s.lock:
            # HTTP success and DOM click completion do not prove a site saved a
            # write. No generic readback can claim a business effect succeeded.
            effect_counters_changed = any(current_usage[k] != record['usage_start'][k]
                                          for k in ('effects_sent','effects_uncertain'))
            local_dom_only = (isinstance(reply.get('result'),dict) and
                reply['result'].get('effect') == 'unverified_until_gateway_and_site_readback')
            # Local field/click completion is useful for preparing a form. It
            # confirms no business effect. Explicit submit intent remains
            # uncertain even if Chromium has emitted no attributable Fetch yet.
            declared_unverified = record['action'] == 'submit'
            if (record.get('blocked_request_refs') and current_usage['effects_sent'] == record['usage_start']['effects_sent'] and
                    current_usage['effects_uncertain'] == record['usage_start']['effects_uncertain']):
                return self._blocked_result(a, record, current_usage)
            unverified_effect = effect_counters_changed or declared_unverified
            uncertain = not reply.get('ok') or unverified_effect or current_usage['state'] != 'running'
            record['state'] = 'uncertain' if uncertain else 'completed'
            record['result_sha256'] = self.policy.digest(self.policy.canonical(reply.get('result')))
            self.s._save()
            self.actions.pop((a['attempt_id'], params['ordinal']), None)
            result = dict(kind='uncertain' if uncertain else 'done', state=record['state'], ordinal=params['ordinal'],
                          result=reply.get('result'), code='SITE_EFFECT_READBACK_REQUIRED' if unverified_effect else reply.get('error'), usage=usage,usage_mode='cumulative',
                          facts=[dict(code='BROWSER_OPERATION_UNCERTAIN' if uncertain else
                              'BROWSER_LOCAL_OPERATION_COMPLETED' if local_dom_only else 'BROWSER_OPERATION_COMPLETED', source_ref=None)])
            self.results[(a['attempt_id'], params['ordinal'])] = result
        return result

    def pending(self, params):
        a = self._ref(params)
        usage = self.s.host.selected_gateway('status', dict(identity=a['selected_identity']))
        return dict(mode=a['selected_mode'], code=a.get('selected_code'), pending=[v for v in a['selected_pending'].values()
                    if v.get('kind') in ('network_effect', 'off_list_destination')],
                    usage={k:usage[k] for k in ('requests','response_bytes')},
                    cumulativeusage={k:usage[k] for k in ('requests','response_bytes')},
                    inflight=usage['inflight'], effects_sent=usage['effects_sent'], effects_uncertain=usage['effects_uncertain'],
                    auth_effects_acknowledged=usage['auth_effects_acknowledged'])

    def _auth_controller(self,a,controller_id,session_id,conn):
        if (not isinstance(controller_id,str) or not self.h.UUID.fullmatch(controller_id) or
                not isinstance(session_id,str) or not self.h.UUID.fullmatch(session_id) or
                not isinstance(conn,str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,128}',conn) or
                not a.get('manual_auth') or a.get('selected_controller') != controller_id or
                a.get('selected_controller_session') != session_id or a.get('selected_live_conn') != conn or
                a.get('selected_mode') not in ('human','paused') or
                self.live_viewers.get((a['attempt_id'],conn)) != controller_id or
                self.live_sessions.get((a['attempt_id'],conn)) != session_id or
                conn not in self.s.workers[a['attempt_id']].live_sinks):
            self.fail('AUTH_READBACK_CONTROLLER_MISMATCH')

    def _auth_sign(self,a,kind,out,inventory=False):
        proof = dict(kind=kind,contract_version=CONTRACT,vm_uuid=self.h.VM_UUID,boot_id=a['boot_id'],
            workspace_id=a['workspace_id'],network_plan_sha256=a['network_plan_sha256'],original_fence=a['original_fence'],**out)
        if inventory:
            proof['replay_allowed'] = False
            if len(self.h.canonical(proof)) > 196000:
                self.fail('AUTH_INVENTORY_PROOF_LIMIT')
        return self._sign(proof)

    def auth_inventory(self,params):
        a = self._ref(params,('controller_id','session_id','conn'))
        with self.s.lock:
            self._auth_controller(a,params['controller_id'],params['session_id'],params['conn'])
            inventory = self.s.host.selected_gateway('auth_inventory',dict(identity=a['selected_identity']))
            if inventory['inflight'] or inventory['pending_count'] or inventory['effects_uncertain']:
                self.fail('AUTH_READBACK_NETWORK_UNSETTLED')
            out = dict(schema='selected-browser-auth-inventory.v1',
                **{k:params[k] for k in ('run_id','attempt_id','fence','policy_sha256','controller_id','session_id')},
                viewer_conn_sha256=self.policy.digest(params['conn']),**inventory)
            out['attestation'] = self._auth_sign(a,'selected-browser-auth-inventory',out,inventory=True)
            return out

    def confirm_authentication(self,params):
        a = self._ref(params,('packet','conn'))
        packet = params['packet']
        if (not isinstance(packet,dict) or any(packet.get(k) != params[k] for k in ('run_id','attempt_id','fence','policy_sha256')) or
                not isinstance(params['conn'],str) or
                packet.get('viewer_conn_sha256') != self.policy.digest(params['conn'])):
            self.fail('AUTH_CONFIRMATION_INVALID')
        pin = packet.get('confirmation_ref')
        if (not self.h.exact(pin,('id','sha256')) or not isinstance(pin['id'],str) or
                not self.h.UUID.fullmatch(pin['id']) or not isinstance(pin['sha256'],str) or
                not self.h.HEX64.fullmatch(pin['sha256'])):
            self.fail('AUTH_CONFIRMATION_INVALID')
        with self.s.lock:
            self._auth_controller(a,packet.get('controller_id'),packet.get('session_id'),params['conn'])
            # Persist the admission pin before the gateway can consume authority.
            # A lost reply can retrieve only this same signed request's receipt;
            # it cannot acknowledge a different set or replay any network effect.
            digest = self.policy.digest(self.policy.canonical(packet))
            prior = a.get('selected_auth_confirmations',{}).get(pin['id'])
            if prior:
                if prior['request_sha256'] != digest:
                    self.fail('AUTH_CONFIRMATION_REPLAY')
                return prior
            a['selected_auth_confirmation_pending_sha256'] = digest
            self.s._save()
            out = self.s.host.selected_gateway('auth_confirm',dict(identity=a['selected_identity'],packet=packet))
            self._auth_controller(a,packet['controller_id'],packet['session_id'],params['conn'])
            out['attestation'] = self._auth_sign(a,'selected-browser-auth-confirmation',out)
            a.setdefault('selected_auth_confirmations',{})[packet['confirmation_ref']['id']] = out
            a['selected_auth_effects_acknowledged'] = out['auth_effects_acknowledged']
            a.pop('selected_auth_confirmation_pending_sha256',None)
            self.s._save()
            return out

    def approve_request(self, params):
        a = self._ref(params, ('request_ref', 'grant'))
        out = self.s.host.selected_gateway('approve', dict(identity=a['selected_identity'], request_ref=params['request_ref'], grant=params['grant']))
        with self.s.lock:
            a['selected_pending'].pop(params['request_ref'], None)
            a['selected_mode'] = 'human' if a.get('manual_auth') and a.get('selected_controller') else 'agent'
            a['selected_code'] = None
            self.s._save()
        self.s.workers[a['attempt_id']].fire('selected_request_decision', request_ref=params['request_ref'], decision='allow', ticket=out['ticket'])
        return dict(approved=True, request_ref=params['request_ref'])

    def _block_held_requests(self, a, code):
        worker = self.s.workers.get(a['attempt_id'])
        with self.s.lock:
            refs = tuple(a['selected_pending'])
            for ref in refs:
                p = a['selected_pending'][ref]
                context = p.get('current_action')
                if context is not None:
                    record = next((r for r in a['actions'] if r['ordinal'] == context['ordinal']), None)
                    if record:
                        context = record.get('context')
                self._mark_blocked_request(a, ref, context)
            a['selected_mode'], a['selected_code'] = 'paused', code
            a['selected_pending'] = {}
            self.s._save()
        self._remember_discarded(a, refs)
        if worker is not None:
            for ref in refs:
                worker.fire('selected_request_decision', request_ref=ref, decision='block', code=code)
        return refs

    def deny_request(self, params):
        a = self._ref(params, ('request_ref',))
        ref = params['request_ref']
        if not isinstance(ref, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', ref):
            self.fail('INVALID_REQUEST')
        with self.s.lock:
            prior = a.get('selected_denials', {}).get(ref)
            if prior:
                if a.get('selected_mode') != ('human' if prior['manual_auth'] else 'paused'):
                    self.fail('REQUEST_DENIAL_STALE')
                return prior
            if a['selected_pending'].get(ref, {}).get('kind') != 'network_effect':
                self.fail('REQUEST_DENIAL_STALE')
        proof = self.s.host.selected_gateway('deny', dict(identity=a['selected_identity'], request_ref=ref))
        refs = self._block_held_requests(a, 'USER_PAUSED')
        self._guest_pause(a)
        self._settle_blocked_actions(a, refs)
        usage = self.s.host.selected_gateway('status', dict(identity=a['selected_identity']))
        if usage['inflight'] or usage['outstanding_requests'] or usage['effects_uncertain']:
            self.fail('REQUEST_DENIAL_UNVERIFIED')
        manual = a.get('manual_auth') is True and bool(a.get('selected_controller'))
        if manual:
            self.s.host.selected_gateway('resume', dict(identity=a['selected_identity']))
            self._request(a, 'selected_resume')
            with self.s.lock:
                a['selected_mode'], a['selected_code'] = 'human', None
                self.s._save()
        out = dict(denied=True, paused=not manual, state='human_control' if manual else 'paused',
                   manual_auth=manual, no_contact=True, request_ref=ref,
                   **{k:params[k] for k in ('run_id','attempt_id','fence','policy_sha256')})
        out['attestation'] = self._sign(dict(kind='selected-browser-request-denial', contract_version=CONTRACT,
                                            vm_uuid=self.h.VM_UUID, boot_id=a['boot_id'], workspace_id=a['workspace_id'],
                                            network_plan_sha256=a['network_plan_sha256'], original_fence=a['original_fence'], **out,
                                            ledger_sha256=proof['ledger_sha256'], replay_allowed=False))
        with self.s.lock:
            a.setdefault('selected_denials', {})[ref] = out
            self.s._save()
        return out

    def grant_destination(self, params):
        a = self._ref(params, ('grant', 'destination'))
        marker, _ = self._acceptance()
        c = self.policy.strict_json(a['configuration_json'])
        destination = params['destination']
        grant = params['grant']
        if (not self.h.exact(destination, ('id','origin','roles','session_headers')) or
                not isinstance(destination['id'], str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', destination['id']) or
                destination['session_headers'] not in ('omit','this_origin_session') or not isinstance(grant, dict)):
            self.fail('DESTINATION_GRANT_INVALID')
        grant_fields = ('schema','id','identity','origin','roles','purpose_sha256','expires_at','persist_to_allowlist','wildcards')
        if (not self.h.exact(grant,grant_fields) or grant['schema'] != 'proxypilot.selected-browser.destination-grant.v1' or
                not isinstance(grant['id'],str) or not self.h.UUID.fullmatch(grant['id']) or
                grant['identity'] != a['selected_identity'] or grant['origin'] != destination['origin'] or
                grant['roles'] != destination['roles'] or grant['persist_to_allowlist'] is not False or grant['wildcards'] is not False or
                not isinstance(grant['purpose_sha256'],str) or not self.h.HEX64.fullmatch(grant['purpose_sha256']) or
                not self.h.safe_int(grant['expires_at'],1) or grant['expires_at'] <= self.s.clock() or
                grant['expires_at'] > self.s.state['runs'][a['run_id']]['deadline']):
            self.fail('DESTINATION_GRANT_INVALID')
        parts = self.policy.url_parts(destination['origin'], origin_only=True)
        matching = [p for p in a['selected_pending'].values() if p.get('kind') == 'off_list_destination' and
                    p['origin'] == destination['origin'] and self.policy.digest(p['purpose']) == grant.get('purpose_sha256')]
        if not matching or destination['roles'] != [matching[0]['role']]:
            self.fail('DESTINATION_GRANT_SCOPE_MISMATCH')
        if ((destination['roles'] == ['resource'] and destination['session_headers'] != 'omit') or
                (parts['scheme'] == 'http' and ('authentication' in destination['roles'] or destination['session_headers'] != 'omit'))):
            self.fail('DESTINATION_GRANT_INVALID')
        if any(r['state'] == 'uncertain' for r in a['actions']):
            self.fail('BROWSER_ACTION_UNCERTAIN')
        self._settle_blocked_actions(a, [p['request_ref'] for p in matching])
        if any(r['state'] == 'started' for r in a['actions']):
            self.fail('BROWSER_BLOCKED_ACTION_UNSETTLED')
        status = self.s.host.selected_gateway('status',dict(identity=a['selected_identity']))
        # Grant planning may resolve the new destination. Refuse known unsafe
        # effects before that contact, even after an uncertain action settled.
        # The current manual controller may continue an explicitly reviewed
        # sign-in sequence; model work still awaits separate auth readback.
        manual = bool(a.get('manual_auth'))
        if manual:
            self._auth_controller(a,a.get('selected_controller'),a.get('selected_controller_session'),a.get('selected_live_conn'))
        if status['effects_uncertain'] or (not manual and status['effects_sent'] != status['auth_effects_acknowledged']):
            self.fail('BROWSER_ACTION_UNCERTAIN')
        if status['inflight'] or status['outstanding_requests']:
            self.fail('BROWSER_BLOCKED_ACTION_UNSETTLED')
        if grant['expires_at'] <= self.s.clock():
            self.fail('DESTINATION_GRANT_INVALID')
        scoped = copy.deepcopy(c)
        scoped['destinations']['allowed_origins'] = [destination]
        target = self._network_plan(scoped, marker, self.s.state['runs'][a['run_id']]['deadline'])['targets'][0]
        self.s.host.selected_gateway('destination_grant', dict(identity=a['selected_identity'], grant=params['grant'], destination=destination, target=target))
        self._request(a, 'selected_grant_destination', destination=destination, expires_at=self.h.stamp(grant['expires_at']))
        self._request(a, 'selected_resume')
        with self.s.lock:
            for p in matching:
                a['selected_pending'].pop(p['request_ref'], None)
            a['selected_mode'], a['selected_code'] = 'human' if a.get('manual_auth') else 'agent', None
            a.pop('selected_snapshot', None)
            a.pop('selected_candidates', None)
            self.s._save()
        # The previously blocked CDP request is never replayed. A fresh explicit
        # navigation/observation is required after the host reviewed exact grant.
        return dict(granted=True, persisted_to_allowlist=False)

    def auth(self, params):
        a = self._ref(params, ('active',))
        if type(params['active']) is not bool or (params['active'] and a.get('selected_mode') != 'human'):
            self.fail('AUTH_REQUIRES_TAKEOVER')
        if not params['active']:
            usage = self.s.host.selected_gateway('status',dict(identity=a['selected_identity']))
            if usage['effects_sent'] != usage['auth_effects_acknowledged'] or usage['effects_uncertain']:
                self.fail('AUTH_READBACK_REQUIRED')
        out = self._request(a, 'selected_auth', active=params['active'])
        with self.s.lock:
            a['manual_auth'] = params['active']
            a.pop('selected_snapshot', None)
            a.pop('selected_candidates', None)
            self.s._save()
        return out

    def pause(self, params):
        a = self._ref(params)
        self.s.host.selected_gateway('pause', dict(identity=a['selected_identity']))
        refs = self._block_held_requests(a, 'USER_PAUSED')
        out = self._guest_pause(a)
        self._settle_blocked_actions(a, refs)
        return out

    def resume(self, params):
        a = self._ref(params)
        self.s.host.selected_gateway('resume', dict(identity=a['selected_identity']))
        out = self._request(a, 'selected_resume')
        with self.s.lock:
            a['selected_mode'], a['selected_code'] = 'agent', None
            self.s._save()
        return out

    def takeover(self, params):
        a = self._ref(params, ('controller_id', 'session_id', 'manual_auth', 'conn'))
        if (not isinstance(params['controller_id'], str) or not self.h.UUID.fullmatch(params['controller_id']) or
                not isinstance(params['session_id'],str) or not self.h.UUID.fullmatch(params['session_id']) or
                params['manual_auth'] is not True or a.get('selected_controller') or
                any(r['state'] == 'started' for r in a['actions'])):
            self.fail('TAKEOVER_UNAVAILABLE')
        conn = params['conn']
        if conn is not None and (self.live_viewers.get((a['attempt_id'], conn)) != params['controller_id'] or
                self.live_sessions.get((a['attempt_id'],conn)) != params['session_id']):
            self.fail('LIVE_CONN_UNKNOWN')
        with self.s.lock:
            a['state'] = 'human'
            a['selected_mode'] = 'human'
            a['selected_controller'] = params['controller_id']
            a['selected_controller_session'] = params['session_id']
            a['dashboard_takeover'] = dict(state='giving', at=self.h.stamp(self.s.clock()))
            self.s._save()
        worker = self.s.workers.get(a['attempt_id'])
        if worker is None:
            self.fail('CHANNEL_CLOSED')
        # Close guest WebRTC members before any credential entry is enabled.
        # Refusing only new viewers leaves existing spectator transports alive.
        for other in tuple(worker.live_sinks):
            if other == conn:
                continue
            self._request(a, 'live_close', conn=other)
            sink = worker.live_sinks.pop(other, None)
            if sink is not None:
                try:
                    sink.put_nowait(dict(event='live_closed', reason='manual_auth_private'))
                except queue.Full:
                    pass
        self._request(a, 'selected_auth', active=True)
        # Block old pending requests; takeover must not replay an abandoned
        # request or silently consume a model action's old grant.
        self.s.host.selected_gateway('pause', dict(identity=a['selected_identity']))
        self._block_held_requests(a, 'USER_PAUSED')
        self._guest_pause(a)
        self.s.host.selected_gateway('resume', dict(identity=a['selected_identity']))
        self._request(a, 'selected_resume')
        with self.s.lock:
            a['manual_auth'] = True
            a['selected_mode'], a['selected_code'] = 'human', None
            a['selected_pending'] = {}
            a.pop('selected_snapshot', None)
            a.pop('selected_candidates', None)
            self.s._save()
        if conn is not None:
            self._give_control(a, conn)
        return dict(state='human', manual_auth=True, controlling=conn is not None,
                    awaiting_live_connection=conn is None)

    def _give_control(self, a, conn):
        worker = self.s.workers.get(a['attempt_id'])
        if worker is None or conn not in worker.live_sinks:
            self.fail('LIVE_CONN_UNKNOWN')
        out = self._request(a, 'live_give', conn=conn)
        uncontrolled = out.get('uncontrolled_inputs') if isinstance(out, dict) else None
        if (out.get('password_fields_empty') is not True or not self.h.exact(uncontrolled, ('key', 'click', 'scroll')) or
                any(not self.h.safe_int(n) for n in uncontrolled.values())):
            self.fail('LIVE_PROTOCOL')
        with self.s.lock:
            a['dashboard_takeover'].update(state='holding', uncontrolled_inputs=uncontrolled)
            a['selected_live_conn'] = conn
            self.s._save()

    def release(self, params):
        a = self._ref(params, ('controller_id',))
        if params['controller_id'] != a.get('selected_controller'):
            self.fail('NOT_TAKEN_OVER')
        status = self.s.host.selected_gateway('status',dict(identity=a['selected_identity']))
        if (status['effects_sent'] != status['auth_effects_acknowledged'] or status['effects_uncertain'] or
                status['inflight'] or status['outstanding_requests']):
            self.fail('AUTH_READBACK_REQUIRED')
        self.s.host.selected_gateway('pause', dict(identity=a['selected_identity']))
        self._block_held_requests(a, 'USER_PAUSED')
        out = self._request(a, 'live_release') if a.get('selected_live_conn') else dict(inputs=dict(key=0, click=0, scroll=0))
        self._native_inputs(a,out)
        self._guest_pause(a)
        status = self.s.host.selected_gateway('status',dict(identity=a['selected_identity']))
        if (status['effects_sent'] != status['auth_effects_acknowledged'] or status['effects_uncertain'] or
                status['inflight'] or status['outstanding_requests']):
            self.fail('AUTH_READBACK_REQUIRED')
        self._request(a, 'selected_auth', active=False)
        # Continuation must observe fresh state after human input.
        with self.s.lock:
            a['state'], a['selected_mode'], a['selected_code'] = 'running', 'paused', 'USER_PAUSED'
            a['manual_auth'] = False
            a.pop('selected_controller', None)
            a.pop('selected_controller_session',None)
            a.pop('selected_live_conn', None)
            a['dashboard_takeover']['state'] = 'released'
            a.pop('selected_snapshot', None)
            a.pop('selected_candidates', None)
            self.s._save()
        return out

    def _native_inputs(self,a,out):
        counts = out.get('inputs') if isinstance(out,dict) else None
        if not self.h.exact(counts,('key','click','scroll')) or any(not self.h.safe_int(v) for v in counts.values()):
            self.fail('LIVE_PROTOCOL')
        with self.s.lock:
            total = a.setdefault('selected_native_inputs',dict(key=0,click=0,scroll=0))
            for k,v in counts.items():
                total[k] += v
            a['selected_native_inputs_measured'] = True
            self.s._save()

    def live(self, params):
        a = self._ref(params, ('viewer_id', 'session_id', 'controller_id', 'manual_auth'))
        if (not isinstance(params['viewer_id'], str) or not self.h.UUID.fullmatch(params['viewer_id']) or
                not isinstance(params['session_id'],str) or not self.h.UUID.fullmatch(params['session_id']) or
                type(params['manual_auth']) is not bool or params['manual_auth'] != bool(a.get('manual_auth')) or
                (params['controller_id'] is not None and params['controller_id'] != params['viewer_id'])):
            self.fail('LIVE_IDENTITY_INVALID')
        if a.get('manual_auth') and (params['viewer_id'] != a.get('selected_controller') or
                params['session_id'] != a.get('selected_controller_session')):
            self.fail('MANUAL_AUTH_PRIVATE')
        stream = self.s.live_open({k: params[k] for k in ('run_id', 'attempt_id', 'fence')})
        self.controllers[(a['attempt_id'], params['viewer_id'])] = stream.conn
        self.live_viewers[(a['attempt_id'], stream.conn)] = params['viewer_id']
        self.live_sessions[(a['attempt_id'],stream.conn)] = params['session_id']
        if a.get('selected_controller') == params['viewer_id']:
            self._give_control(a, stream.conn)
        return stream

    def control(self, params):
        a = self._ref(params, ('controller_id', 'ordinal', 'input'))
        if params['controller_id'] != a.get('selected_controller') or a.get('selected_mode') != 'human':
            self.fail('NOT_TAKEN_OVER')
        if not self.h.safe_int(params['ordinal'], 1):
            self.fail('INVALID_REQUEST')
        worker = self.s.workers.get(a['attempt_id'])
        if worker is None or a.get('selected_live_conn') not in worker.live_sinks:
            self.fail('LIVE_CONN_UNKNOWN')
        with self.s.lock:
            run = self.s._usable(a)
            if run['action_count'] >= run['max_actions'] or params['ordinal'] != run['action_count'] + 1:
                self.fail('ACTION_LIMIT_OR_ORDINAL_INVALID')
            record = dict(ordinal=params['ordinal'],action='human_input',state='started',at=self.h.stamp(self.s.clock()))
            run['action_count'] += 1
            a['actions'].append(record)
            self.s._save()
        # The application's authenticated controller is the only source of
        # this typed input. Password text stays in the private live browser and
        # is never a model observation, receipt or journal entry.
        try:
            out = self._request(a, 'selected_control', input=params['input'])
        except Exception:
            with self.s.lock:
                record['state'] = 'uncertain'
                self.s._save()
            raise
        with self.s.lock:
            record['state'] = 'completed'
            self.s._save()
        return out

    def view(self, params):
        a = self._ref(params)
        if a.get('manual_auth'):
            self.fail('MANUAL_AUTH_CAPTURE_DISABLED')
        return self.h.frame_only(self._request(a, 'view'))

    def stage(self, params):
        a = self._ref(params, ('kind', 'ref', 'mime_type', 'bytes_base64'))
        if a.get('manual_auth') or a.get('selected_mode') != 'agent':
            self.fail('BROWSER_INPUT_STAGING_PAUSED')
        return self._request(a, 'selected_stage', **{k: params[k] for k in ('kind', 'ref', 'mime_type', 'bytes_base64')})

    def offer_input(self, params):
        a = self._ref(params, ('snapshot_ref','target_ref','input_ref'))
        if a.get('manual_auth') or a.get('selected_mode') not in ('agent','paused'):
            self.fail('BROWSER_INPUT_STAGING_PAUSED')
        if params['snapshot_ref'] != a.get('selected_snapshot'):
            self.fail('BROWSER_INPUT_SNAPSHOT_STALE')
        out = self._request(a, 'selected_offer_input', **{k:params[k] for k in ('snapshot_ref','target_ref','input_ref')})
        # Newly composed candidates remain bound to the same private snapshot.
        if not isinstance(out, dict) or not isinstance(out.get('candidate_ref'), dict):
            self.fail('BROWSER_INPUT_CANDIDATE_INVALID')
        with self.s.lock:
            a.setdefault('selected_candidates', []).append(out)
            self.s._save()
        return out

    def renew(self, params):
        self._ref(params)
        return self.s.renew({k: params[k] for k in ('run_id', 'attempt_id', 'fence')})

    def stop(self, params):
        if not self.h.exact(params, ('run_id', 'attempt_id', 'fence', 'policy_sha256', 'reason')):
            self.fail('INVALID_REQUEST')
        with self.s.lock:
            a = self.s.state['attempts'].get(params['attempt_id'])
            if (a is None or a.get('workload') != 'selected_browser_v1' or a['run_id'] != params['run_id'] or
                    a['policy_sha256'] != params['policy_sha256'] or not self.h.safe_int(params['fence'], a['fence']) or
                    params['reason'] not in self.h.BACKEND_STOP_REASONS):
                self.fail('INVALID_REQUEST')
            if a['state'] in self.h.TERMINAL:
                return a['receipt']
            a['fence'] = params['fence']
            self.s.state['runs'][a['run_id']]['max_fence'] = params['fence']
            self.s._save()
        return self.s._teardown(a['attempt_id'], params['reason'])

    def before_teardown(self, a):
        if not a.get('gateway_registered') or a.get('gateway_released'):
            return
        try:
            out = self.s.host.selected_gateway('revoke', dict(identity=a['selected_identity']))
            a['gateway_revoked'] = out.get('state') == 'revoked'
            a['gateway_ledger_sha256'] = out.get('ledger_sha256')
        except Exception:
            a['gateway_revoked'] = False
        self.s._save()
        if not a.get('selected_model_cancelled'):
            # Install the cancellation latch even before a first model record
            # exists. A call can pass its guard, then queue behind this fence;
            # it must not open a fresh provider namespace afterwards.
            try:
                result = self.model.cancel(dict(run_id=a['run_id']))
                a['selected_model_cancelled'] = True
                a['selected_model_cancel_result'] = {k:result[k] for k in
                    ('cancelled','broker_confirmed','provider_already_accepted')}
            except Exception:
                # The helper journals cancellation before the bounded broker
                # request. A lost provider reply does not reverse used spend.
                a['selected_model_cancelled'] = True
                a['selected_model_cancel_result'] = dict(cancelled=True,broker_confirmed=False,provider_already_accepted=None)
            self.s._save()
        if a.get('selected_live_conn'):
            try:
                worker = self.s.workers.get(a['attempt_id'])
                if worker is not None:
                    for ref in tuple(a['selected_pending']):
                        worker.fire('selected_request_decision',request_ref=ref,decision='block',code='GATEWAY_REVOKED')
                self._native_inputs(a,self._request(a,'live_release'))
                a.pop('selected_live_conn',None)
            except Exception:
                a['selected_native_inputs_measured'] = False
            self.s._save()

    def after_teardown(self, a, descendants, workspace):
        if a.get('gateway_registered') and not a.get('gateway_released'):
            if not a.get('gateway_revoked'):
                self.fail('TEARDOWN_UNVERIFIED')
            # Authority is already revoked and the guest is closed. Capture
            # actual settled counters before releasing the registry/ledger;
            # socket closure itself does not confirm any website effect.
            status = self.s.host.selected_gateway('final_status',dict(identity=a['selected_identity']))
            fields = ('requests','response_bytes','effects_sent','effects_uncertain','auth_effects_acknowledged','inflight')
            if (status.get('state') != 'revoked' or any(not self.h.safe_int(status.get(k)) for k in fields) or
                    not self.h.safe_int(status.get('outstanding_requests')) or
                    status['auth_effects_acknowledged'] > status['effects_sent'] or
                    status['effects_uncertain'] > status['effects_sent'] or
                    not isinstance(status.get('ledger_sha256'),str) or not self.h.HEX64.fullmatch(status['ledger_sha256'])):
                self.fail('TEARDOWN_NETWORK_UNVERIFIED')
            a['selected_final_network'] = {k:status[k] for k in fields}
            a['selected_final_network'].update(pending_count=status['outstanding_requests'],ledger_sha256=status['ledger_sha256'])
            a['gateway_ledger_sha256'] = status['ledger_sha256']
            self.s._save()
            if status['inflight'] or status['outstanding_requests']:
                # Sign known final meters with network closure explicitly
                # false. Keep the latch/ledger so a fresh cleanup retry can
                # drain and attest later bytes without restarting a browser.
                self._forget_attempt_memory(a)
                return False
            # Read the effective installed fence again after guest cleanup,
            # before releasing the durable selected-mode latch.
            self.s.host.light_boundary(a['qemu_pid'], a['fence_fingerprint'])
            self.s.host.selected_gateway('release', dict(identity=a['selected_identity'],
                cleanup=dict(descendants_gone=descendants, workspace_gone=workspace, fence_still_installed=True)))
            a['gateway_released'] = True
            self.s._save()
        if not a.get('gateway_registered'):
            # Registration may have failed after the proxy installed its latch.
            # An unregistered flag alone is insufficient proof of no authority.
            health = self.s.host.selected_gateway('health',{})
            if health.get('active') is not False:
                self.fail('TEARDOWN_NETWORK_UNVERIFIED')
            a['selected_final_network'] = dict(requests=0,response_bytes=0,effects_sent=0,effects_uncertain=0,
                auth_effects_acknowledged=0,inflight=0,pending_count=0,ledger_sha256='0'*64)
            a['gateway_ledger_sha256'] = '0'*64
            self.s._save()
        self._forget_attempt_memory(a)
        return True

    def _forget_attempt_memory(self,a):
        # Private artifact bytes live only in in-memory transport results until
        # staged into F1. They are not a resumable post-cleanup session cache.
        attempt_id = a['attempt_id']
        for mapping in (self.actions,self.results,self.controllers,self.live_viewers,self.live_sessions):
            for key in tuple(mapping):
                if key[0] == attempt_id:
                    mapping.pop(key,None)
        self.event_queues.pop(attempt_id,None)
        self.pumps.pop(attempt_id,None)

    def receipt(self, a, reason, evidence, descendants, workspace):
        if not a.get('selected_final_network'):
            self.fail('TEARDOWN_NETWORK_UNVERIFIED')
        out = dict(contract_version=CONTRACT, run_id=a['run_id'], attempt_id=a['attempt_id'], fence=a['fence'],
                   policy_sha256=a['policy_sha256'], final_network=a['selected_final_network'],
                   closed=dict(browser=descendants, network=bool(a.get('gateway_released') or not a.get('gateway_registered')),
                                                                session=workspace, temporary_files=workspace))
        payload = dict(kind='selected-browser-teardown', **out, original_fence=a['original_fence'], reason=reason,
                       vm_uuid=self.h.VM_UUID, boot_id=a.get('boot_id'), workspace_id=a.get('workspace_id'),
                       network_plan_sha256=a.get('network_plan_sha256'), gateway_ledger_sha256=a.get('gateway_ledger_sha256'),
                       evidence=evidence, uncertain_ordinals=[r['ordinal'] for r in a['actions'] if r['state'] == 'uncertain'],
                       native_inputs=dict(counts=a.get('selected_native_inputs',dict(key=0,click=0,scroll=0)),
                                          measured=a.get('selected_native_inputs_measured',not a.get('manual_auth'))),
                       action_budget_unit='automated_and_typed_browser_primitives',
                       stopped_at=self.h.stamp(self.s.clock()))
        out['attestation'] = self._sign(payload)
        return out

    def dispatch(self, method, params):
        if method in MODEL_METHODS:
            if method == 'selected_browser_model' and params.get('purpose') != 'conversion':
                self._model_guard(params)
            return {'selected_browser_model_status': self.model.status, 'selected_browser_model': self.model.model,
                    'cancel_selected_browser_model': self.model.cancel}[method](params)
        suffix = method.removeprefix('selected_browser_')
        return getattr(self, suffix)(params)

    def _model_guard(self, params):
        if not isinstance(params, dict) or params.get('purpose') not in ('decision', 'draft_input', 'report'):
            self.fail('BROWSER_MODEL_REQUEST_INVALID')
        ref = dict(run_id=params.get('run_id'), attempt_id=params.get('attempt_id'), fence=params.get('fence'),
                   policy_sha256=params.get('policy_hash'))
        a = self._ref(ref, allow_stopped=params['purpose'] == 'report')
        if any(record['state']=='uncertain' for record in a['actions']):
            self.fail('BROWSER_MODEL_ACTION_UNCERTAIN')
        if any(record['state']=='started' for record in a['actions']):
            self.fail('BROWSER_MODEL_ACTION_BUSY')
        run = self.s.state['runs'][a['run_id']]
        if (params.get('project_id') != run['project_id'] or params.get('project_limits_revision') != run['project_limits_revision'] or
                params.get('guide_hash') != run['guide_hash'] or params.get('guide_version_id') != run['guide_version_id'] or
                params.get('consent_hash') != run['consent_hash'] or a.get('manual_auth') or
                ('project_revision' in run and params.get('project_revision') != run['project_revision'])):
            self.fail('BROWSER_MODEL_DISCLOSURE_PIN_MISMATCH')
        receipt = a.get('receipt', {})
        terminal_report = (params['purpose'] == 'report' and a['state'] in self.h.TERMINAL and
                           isinstance(receipt.get('attestation'), str) and
                           receipt.get('closed') == dict(browser=True, network=True, session=True, temporary_files=True))
        if not terminal_report and (a.get('selected_mode') != 'agent' or a['state'] != 'running' or a.get('selected_pending')):
            self.fail('BROWSER_MODEL_INSPECTION_PAUSED')
        if not terminal_report:
            network = self.s.host.selected_gateway('status', dict(identity=a['selected_identity']))
            if (network.get('state') != 'running' or
                    any(not self.h.safe_int(network.get(k), 0) for k in
                        ('inflight','outstanding_requests','effects_sent','effects_uncertain','auth_effects_acknowledged')) or
                    any(network[k] for k in ('inflight','outstanding_requests','effects_uncertain')) or
                    network['effects_sent'] != network['auth_effects_acknowledged']):
                self.fail('BROWSER_MODEL_NETWORK_UNSETTLED')
        if not terminal_report and params.get('input', {}).get('snapshot_ref') != a.get('selected_snapshot'):
            self.fail('BROWSER_MODEL_SNAPSHOT_STALE')
        c = self.policy.strict_json(a['configuration_json'])
        lim = params.get('limits', {})
        ceilings = dict(max_tokens=run['limits']['max_tokens'],max_usd=run['limits']['max_usd'],
                        max_calls=c['budgets']['max_model_calls'],max_output_tokens=c['model'][
                            'max_decision_output_tokens' if params['purpose']=='decision' else 'max_report_output_tokens'])
        if (not isinstance(lim,dict) or set(lim) != set(ceilings) or
                any(type(lim.get(k)) not in (float,int) or not math.isfinite(lim[k]) or lim[k] <= 0 or lim[k] > ceiling
                    for k,ceiling in ceilings.items())):
            self.fail('BROWSER_MODEL_BUDGET_PIN_MISMATCH')
        if params['purpose'] in ('decision','draft_input'):
            targets = [dict(id=p['target_ref']['id'],sha256=p['target_ref']['sha256'],
                            operation=p['kind'],label=p['label'],effect='external_change')
                       for p in a.get('selected_input_targets', [])]
            if params['purpose'] == 'decision':
                trusted = [dict(id=p['candidate_ref']['id'],sha256=p['candidate_ref']['sha256'],
                                operation=p['operation']['kind'],label=p.get('label') or p['operation']['kind'],effect=p['effect'])
                           for p in a.get('selected_candidates', [])] + targets
            else:
                trusted = targets
            supplied = params.get('input',{}).get('candidates')
            if not isinstance(supplied,list) or any(p not in trusted for p in supplied):
                self.fail('BROWSER_MODEL_CANDIDATE_PIN_MISMATCH')
