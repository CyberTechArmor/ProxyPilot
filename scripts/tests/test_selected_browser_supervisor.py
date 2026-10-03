"""Local process/fake-host lifecycle proofs; never installed isolation acceptance."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('selected_supervisor_fixture_helpers', ROOT / 'tests/test_a3_worker_supervisor.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
s = helpers.s
PROJECT = 'b57f454a-12fa-45f2-b2ef-e9ff126818c3'
GUIDE = '2e5b6dfa-8b4b-4b21-a3f9-9a04b9fd1683'
SNAPSHOT = '04eaab58-d66e-4a4a-8c1d-7f5308020ea6'
CANDIDATE = 'f5fe4c2c-712d-4513-a7d9-08c7c56e4e24'
APPROVAL = '1b12f9f3-e9e8-4cbe-8993-70b6317a2f36'
SESSION = '91879474-4a50-4cf0-a22c-e739687442e1'

FAKE_SELECTED = r'''
import hashlib,json,sys,os
c=json.loads(sys.argv[1]);sel=c['selected_browser'];run=sel['run_id'];attempt=sel['attempt_id'];fence=sel['fence'];policy=sel['policy_sha256']
snapshot={'id':'04eaab58-d66e-4a4a-8c1d-7f5308020ea6','sha256':'a'*64};candidate={'id':'f5fe4c2c-712d-4513-a7d9-08c7c56e4e24','sha256':'b'*64}
pending=None
op={'kind':'navigate','destination_id':'site','url':'https://selected.example/'}
print(json.dumps({'event':'ready','workspace':{'device':'0:99','fstype':'tmpfs','size_kib':1024},'live':{'fixture':True}}),flush=True)
for raw in sys.stdin:
 v=json.loads(raw);name=v['op'];reply={'id':v['id'],'ok':True,'result':{}}
 if name=='selected_observe':reply['result']={'snapshot_ref':snapshot,'observation':'{"title":"fixture"}','candidates':[{'candidate_ref':candidate,'operation':op,'effect':'read','label':'Open selected site'}],'source_refs':[],'input_targets':[],'page':None}
 if name=='selected_action':
  env=v['envelope'];context={k:env[k] for k in ('ordinal','snapshot_ref','candidate_ref','approval_ref')}
  m={'url':'https://selected.example/save','method':'POST','body_sha256':hashlib.sha256(b'fixture').hexdigest(),'body_bytes':7,'resource_type':'fetch','role':'resource','run_id':run,'attempt_id':attempt,'fence':fence,'policy_sha256':policy,'current_action':context}
  print(json.dumps({'event':'selected_request','request_ref':'held_request_'+str(env['ordinal']),'metadata':m}),flush=True);pending=v;continue
 if name=='selected_request_decision' and pending:
  print(json.dumps({'id':pending['id'],'ok':True,'result':{'kind':'navigate','status':'done','untrusted':True}}),flush=True);pending=None
 if name=='selected_pause':reply['result']={'paused':True,'discarded_request_refs':[]}
 if name=='live_open':reply['result']={}
 if name=='live_give':reply['result']={'password_fields_empty':True,'uncontrolled_inputs':{'key':0,'click':0,'scroll':0}}
 if name=='live_release':reply['result']={'inputs':{'key':0,'click':0,'scroll':0}}
 if name=='stop':print(json.dumps(reply),flush=True);sys.exit(0)
 print(json.dumps(reply),flush=True)
'''


class SelectedHost(helpers.FakeHost):
    def __init__(self, root, clock):
        super().__init__(root)
        self.clock = clock
        self.trace = []
        self.marker_missing = False
        self.marker_tamper = None
        self.guest_program = FAKE_SELECTED
        self.gateway_module = s._module('pp_selected_test_gateway', 'selected_browser_gateway.py')
        self.registry = self.gateway_module.SelectedGatewayRegistry(root / 'gateway', require_root=False, clock=clock)

    def selected_acceptance(self):
        if self.marker_missing:
            raise FileNotFoundError('fixture marker absent')
        files = {f: hashlib.sha256((ROOT / f).read_bytes()).hexdigest() for f in
            ('selected_browser_supervisor.py', 'selected_browser_policy.py', 'selected_browser_gateway.py',
             'selected_browser_worker.py', 'selected_browser_contract.py', 'selected-browser-schemas.json', 'selected-browser-model.py')}
        marker = dict(v=1, accepted=True, vm_uuid=s.VM_UUID, boot_id=self.boot, fence_fingerprint='f' * 64,
            expires_at=self.clock() + 1000, files=files,
            proofs={k:'d' * 64 for k in ('incus_identity','nft_effective','chromium_managed_policy','gateway_before_contact','selected_browser_lifecycle')},
            managed_policy_sha256=hashlib.sha256(s.runner.live_policy_bytes()).hexdigest(),
            protected_hosts=['controller.example'], protected_addresses=['10.185.17.1','10.185.17.179'], internal_policies=[])
        if self.marker_tamper:
            self.marker_tamper(marker)
        return marker

    def selected_gateway(self, method, params):
        self.trace.append('gateway:' + method)
        try:
            return self.registry.dispatch(dict(v=1, method=method, params=params))
        except Exception as e:
            raise s.Refused(getattr(e, 'code', 'GATEWAY_FAILED')) from None

    def selected_resolve(self, parts):
        self.trace.append('resolve:' + parts['host'])
        return ['1.1.1.1']

    def selected_route_hash(self, _):
        self.trace.append('route')
        return 'b' * 64

    def spawn(self, unit, properties, source, config):
        self.trace.append('spawn')
        self.spawns += 1
        self.props[unit] = properties
        process = subprocess.Popen([sys.executable, '-c', self.guest_program, json.dumps(config)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
        self.units[unit] = process
        return process

    def stop_unit(self, unit):
        self.trace.append('stop_unit')
        return super().stop_unit(unit)


class SelectedSupervisorTests(unittest.TestCase):
    def setUp(self):
        # Same local fixture exemption as the existing A3 tests; installed
        # root ownership checks remain unchanged in production.
        self.ownership_patch = patch.object(s.installer, 'secure', lambda path: None)
        self.ownership_patch.start()
        self.tmp = tempfile.TemporaryDirectory(prefix='pp-selected-host-fixture-')
        self.root = Path(self.tmp.name)
        self.clock = helpers.Clock()
        self.host = SelectedHost(self.root, self.clock)
        self.supervisor = s.Supervisor(host=self.host, journal=self.root / 'state.json', clock=self.clock)
        self.supervisor.live_available = lambda: dict(version=1)
        self.runtime = self.supervisor._selected()
        self.c = json.loads((ROOT.parent / 'contracts/browser-agent/fixtures/general-agent.draft.json').read_text())
        self.c['work']['guide_ref'] = dict(id=GUIDE, sha256='c' * 64)
        self.c['destinations']['allowed_origins'] = [dict(id='site', origin='https://selected.example', roles=['navigation','resource','authentication'], session_headers='this_origin_session')]
        self.c['destinations']['entry_urls'] = ['https://selected.example/']
        self.c['destinations']['request_rules'] = [dict(id='read', destination_id='site', path_prefix='/', methods=['GET','HEAD'],query_keys=[],resource_types=['document','fetch','xhr'],effect='read',max_request_bytes=0)]
        text = self.runtime.contract.canonical_json(self.c)
        self.spec = dict(contract_version='selected-browser.v1', project_id=PROJECT, run_id=helpers.RUN,
            attempt_id=helpers.ATTEMPT, workspace_id=helpers.WORKSPACE, fence=1, project_limits_revision=1,
            project_limits=dict(cpu=1,memory_mib=1024,temporary_disk_mib=256,max_actions=10,max_seconds=600,max_tokens=10000,max_usd=.25),
            configuration_json=text, configuration_sha256=hashlib.sha256(text.encode()).hexdigest(),
            guide_version_id=GUIDE, guide_hash='c' * 64, consent_hash='d' * 64, deadline_at=s.stamp(self.clock() + 600))
        self.ref = dict(run_id=helpers.RUN, attempt_id=helpers.ATTEMPT, fence=1, policy_sha256=self.spec['configuration_sha256'])

    def tearDown(self):
        for a in list(self.supervisor._live()):
            self.supervisor._safe_teardown(a['attempt_id'], 'failed')
        for process in self.host.units.values():
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(3)
            for stream in (process.stdin,process.stdout,process.stderr):
                if stream is not None:
                    stream.close()
        if self.host.registry.gateway:
            self.host.registry.gateway.ledger.close()
        self.tmp.cleanup()
        self.ownership_patch.stop()

    def assertCode(self, code, fn, *args):
        with self.assertRaises(s.Refused) as e:
            fn(*args)
        self.assertEqual(e.exception.code, code)

    def decode(self, attestation):
        prefix, body, signature = attestation.split('.')
        self.assertEqual(prefix, 'sbr1')
        raw = base64.urlsafe_b64decode(body + '=' * (-len(body) % 4))
        sig = base64.urlsafe_b64decode(signature + '=' * (-len(signature) % 4))
        (self.root / 'message').write_bytes(raw)
        (self.root / 'sig').write_bytes(sig)
        result = subprocess.run(['openssl','pkeyutl','-verify','-pubin','-inkey',str(self.host.pub),'-rawin','-in',str(self.root/'message'),'-sigfile',str(self.root/'sig')], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(raw)

    def test_status_never_dns_or_grants_and_absent_acceptance_stays_unavailable(self):
        params = {k:self.spec[k] for k in ('configuration_json','configuration_sha256')}
        self.host.marker_missing = True
        out = self.runtime.status(params)
        self.assertFalse(out['available'])
        self.assertFalse(out['isolation'])
        self.assertEqual(self.host.trace, [])
        self.decode(out['attestation'])
        self.host.marker_missing = False
        out = self.runtime.status(params)
        self.assertTrue(out['available'])
        self.assertEqual(out['reachability'], 'pending_launch_check')
        self.assertEqual(self.host.trace, ['gateway:health'])
        self.assertEqual(self.host.spawns, 0)
        self.assertEqual(self.supervisor.state['attempts'], {})

    def test_helper_hash_boot_and_proof_expiry_blocks_before_resolve(self):
        for tamper in (lambda m:m['files'].update({'selected_browser_worker.py':'0'*64}),
                       lambda m:m.update(boot_id=helpers.ATTEMPT2), lambda m:m.update(expires_at=self.clock()-1)):
            self.host.marker_tamper = tamper
            with self.assertRaises(s.Refused):
                self.runtime.launch(self.spec)
            self.assertEqual(self.host.trace, [])
            self.assertEqual(self.host.spawns, 0)

    def test_launch_plan_registered_before_spawn_finite_caps_and_signed_identity(self):
        out = self.runtime.launch(self.spec)
        self.assertLess(self.host.trace.index('gateway:register'), self.host.trace.index('spawn'))
        self.assertEqual(out['limits_applied']['temporary_disk_mib'], 256)
        self.assertEqual(self.supervisor.state['runs'][helpers.RUN]['limits']['max_tokens'], 10000)
        signed = self.decode(out['attestation'])
        self.assertEqual(signed['kind'], 'selected-browser-launch')
        self.assertEqual(signed['policy_sha256'], self.ref['policy_sha256'])
        self.assertEqual(signed['original_fence'], 1)
        self.assertEqual(signed['workspace_id'], helpers.WORKSPACE)
        self.assertEqual(signed['vm_uuid'], s.VM_UUID)
        self.assertCode('ACTIVE_ATTEMPT', self.runtime.launch, self.spec)

    def test_selected_guest_bundle_is_fixed_compressed_modules_no_caller_code(self):
        source = self.runtime._source()
        self.assertLess(len(source.encode()), 131072)
        compile(source, '<fixture-owned-bundle>', 'exec')
        self.assertIn("types.ModuleType('selected_browser_contract')", source)
        self.assertIn("types.ModuleType('selected_browser_worker')", source)
        self.assertNotIn(self.c['work']['instructions'], source)
        self.assertNotIn(self.spec['configuration_json'], source)
        self.assertNotIn('PYTHONPATH', source)

    def test_reviewed_installer_packages_every_fixed_helper_without_acceptance(self):
        install=s._module('pp_selected_installer_fixture','a3-install-supervisor.py')
        files=install.plan_files()
        for name in install.SELECTED_SOURCES:
            self.assertIn(install.TARGET/name,files)
        self.assertFalse(any(path.name=='selected-browser-acceptance.json' for path in files))
        proxy=install.proxy.selected_profile_plan()
        self.assertFalse(proxy['installed']);self.assertFalse(proxy['acceptance_created'])
        self.assertEqual(proxy['proxy_listen'],['10.185.17.1',18083])
        self.assertIn('--serve --selected-control',proxy['unit'])
        self.assertIn('RuntimeDirectoryMode=0700',proxy['unit'])

    def test_schema_unknown_credential_bad_pins_and_project_minimum_fail(self):
        for changed in (dict(self.spec, credential={'value':'secret'}), dict(self.spec, guide_hash='b'*64),
                        dict(self.spec, project_limits=dict(memory_mib=256))):
            with self.assertRaises(s.Refused):
                self.runtime.launch(changed)
        self.assertEqual(self.host.trace, [])
        self.assertEqual(self.host.spawns, 0)

    def test_async_request_approval_does_not_deadlock_action_pipe_and_never_logs_body(self):
        self.runtime.launch(self.spec)
        observed = self.runtime.observe(self.ref)
        candidate = observed['candidates'][0]
        envelope = dict(schema='proxypilot.browser-action.proposal.v1',**self.ref,ordinal=1,
            snapshot_ref=observed['snapshot_ref'],candidate_ref=candidate['candidate_ref'],approval_ref=None,operation=candidate['operation'])
        out = self.runtime.action(dict(self.ref,envelope=envelope))
        self.assertEqual(out['kind'],'pending')
        deadline = time.monotonic()+3
        while time.monotonic()<deadline:
            pending = self.runtime.pending(self.ref)['pending']
            if pending:break
            time.sleep(.02)
        self.assertEqual(pending[0]['kind'],'network_effect')
        self.assertTrue(pending[0]['no_contact'])
        self.assertEqual(pending[0]['current_action']['ordinal'],1)
        grant = dict(schema='proxypilot.selected-browser.effect-grant.v1',id=APPROVAL,
            identity=self.host.registry.gateway.policy.identity,request_ref=pending[0]['request_ref'],
            binding_sha256=pending[0]['binding_sha256'],expires_at=int(self.clock()+30),purpose_sha256='e'*64)
        self.runtime.approve_request(dict(self.ref,request_ref=pending[0]['request_ref'],grant=grant))
        gate = self.host.registry.gateway
        # The synthetic process has no browser/network. Admit its exact wire
        # fixture locally so the host counters are truthful and no ticket
        # remains outstanding. Real upstream effects are tested separately.
        ticket = next(iter(gate.tickets))
        gate.admit('POST','https://selected.example/save',{'x-proxypilot-request-token':ticket},b'fixture')
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            result=self.runtime.poll_action(dict(self.ref,ordinal=1))
            if result['kind']!='pending':break
            time.sleep(.02)
        self.assertEqual(result['kind'],'done')
        self.assertEqual(result['usage'],dict(requests=1,response_bytes=0,artifact_bytes=0))
        self.assertIn(APPROVAL,self.host.registry.gateway.ledger._approvals)
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=1)),result)
        journal=json.loads(self.supervisor.journal_path.read_text())
        self.assertNotIn('bytes_base64',json.dumps(journal))
        self.assertNotIn('fixture body',json.dumps(journal))

    def test_cancel_advanced_fence_revokes_before_guest_stop_signed_closed_no_fallback(self):
        self.runtime.launch(self.spec)
        receipt=self.runtime.stop(dict(self.ref,fence=2,reason='cancelled'))
        self.assertLess(self.host.trace.index('gateway:revoke'),self.host.trace.index('stop_unit'))
        self.assertLess(self.host.trace.index('stop_unit'),self.host.trace.index('gateway:release'))
        self.assertEqual(receipt['fence'],2)
        self.assertEqual(receipt['closed'],dict(browser=True,network=True,session=True,temporary_files=True))
        signed=self.decode(receipt['attestation'])
        self.assertEqual(signed['original_fence'],1)
        self.assertEqual(signed['kind'],'selected-browser-teardown')
        self.assertEqual(signed['final_network'],receipt['final_network'])
        self.assertEqual(receipt['final_network'],dict(requests=0,response_bytes=0,effects_sent=0,effects_uncertain=0,
            auth_effects_acknowledged=0,inflight=0,pending_count=0,ledger_sha256=signed['gateway_ledger_sha256']))
        self.assertLess(self.host.trace.index('stop_unit'),self.host.trace.index('gateway:final_status'))
        self.assertLess(self.host.trace.index('gateway:final_status'),self.host.trace.index('gateway:release'))
        self.assertFalse(self.host.registry.selected()[0])
        self.assertEqual(self.runtime.stop(dict(self.ref,fence=2,reason='cancelled')),receipt)

    def test_cleanup_signs_write_after_last_pending_without_claiming_website_success(self):
        self.runtime.launch(self.spec)
        stale=self.runtime.pending(self.ref)
        self.assertEqual(stale['effects_sent'],0)
        original=self.host.selected_gateway
        def late_send(method,params):
            if method=='revoke':
                self.send_auth_wire_fixture('late-business',role='resource')
            return original(method,params)
        self.host.selected_gateway=late_send
        receipt=self.runtime.stop(dict(self.ref,fence=2,reason='completed'))
        final=receipt['final_network'];proof=self.decode(receipt['attestation'])
        self.assertEqual((final['requests'],final['effects_sent'],final['auth_effects_acknowledged']),(1,1,0))
        self.assertEqual(final['response_bytes'],len(b'fixture'))
        self.assertEqual((final['inflight'],final['pending_count']),(0,0))
        self.assertEqual(proof['final_network'],final)
        self.assertEqual(receipt['closed'],dict(browser=True,network=True,session=True,temporary_files=True))
        self.assertNotIn('website_success',proof)
        self.assertEqual(self.runtime.stop(dict(self.ref,fence=2,reason='completed')),receipt)

    def test_partial_cleanup_preserves_real_meters_and_fresh_retry_closes_without_replay(self):
        self.runtime.launch(self.spec)
        gate=self.host.registry.gateway
        gate.requests=1;gate.effects_sent=1;gate.inflight=1
        first=self.runtime.stop(dict(self.ref,fence=2,reason='cancelled'))
        proof=self.decode(first['attestation'])
        self.assertEqual(first['closed'],dict(browser=True,network=False,session=True,temporary_files=True))
        self.assertEqual(proof['final_network'],first['final_network'])
        self.assertEqual(first['final_network']['inflight'],1)
        self.assertTrue(self.host.registry.latch_path.exists())
        self.assertEqual(self.supervisor.state['attempts'][helpers.ATTEMPT]['state'],'stopping')
        self.assertNotIn(helpers.ATTEMPT,self.supervisor.workers)
        self.assertNotIn('gateway:release',self.host.trace)
        # Fixture of the already revoked response thread unwinding. No browser
        # is started, no new grant is issued and no request is replayed.
        gate.response_bytes=17;gate.effects_uncertain=1;gate.inflight=0
        gate._audit('request_uncertain',dict(request_ref='original',code='GATEWAY_REVOKED',sent=True,replay_allowed=False))
        second=self.runtime.stop(dict(self.ref,fence=3,reason='cancelled'))
        self.assertEqual(second['fence'],3)
        self.assertEqual(second['closed'],dict(browser=True,network=True,session=True,temporary_files=True))
        self.assertEqual((second['final_network']['response_bytes'],second['final_network']['effects_uncertain']),(17,1))
        self.assertNotEqual(first['attestation'],second['attestation'])
        self.assertEqual(self.host.spawns,1);self.assertFalse(self.host.registry.selected()[0])
        self.assertEqual(self.runtime.stop(dict(self.ref,fence=3,reason='cancelled')),second)

    def test_explicit_submit_cannot_complete_or_admit_next_action_or_model_without_wire_send(self):
        wire="print(json.dumps({'event':'selected_request','request_ref':'held_request_'+str(env['ordinal']),'metadata':m}),flush=True);pending=v;continue"
        self.host.guest_program=FAKE_SELECTED.replace(wire,"reply['result']={'effect':'unverified_until_gateway_and_site_readback'};print(json.dumps(reply),flush=True);continue")
        self.host.guest_program=self.host.guest_program.replace("op={'kind':'navigate','destination_id':'site','url':'https://selected.example/'}",
            "op={'kind':'submit','form_ref':'reviewed_form','field_set_sha256':'b'*64}")
        self.host.guest_program=self.host.guest_program.replace("'effect':'read','label':'Open selected site'","'effect':'external_change','label':'Submit reviewed form'")
        self.runtime.launch(self.spec)
        observation=self.runtime.observe(self.ref);candidate=observation['candidates'][0]
        envelope=dict(schema='proxypilot.browser-action.proposal.v1',**self.ref,ordinal=1,
            snapshot_ref=observation['snapshot_ref'],candidate_ref=candidate['candidate_ref'],
            approval_ref=dict(id=APPROVAL,sha256='d'*64),operation=candidate['operation'])
        self.runtime.action(dict(self.ref,envelope=envelope))
        sent=self.runtime.actions[(helpers.ATTEMPT,1)]
        # Fixture the DOM completion before a delayed/native Fetch was emitted.
        # No gateway request/effect exists; the worker still declares unverified.
        self.assertTrue(sent[1].wait(2))
        request=dict(purpose='decision',project_id=PROJECT,project_limits_revision=1,guide_version_id=GUIDE,
            guide_hash='c'*64,consent_hash='d'*64,run_id=helpers.RUN,attempt_id=helpers.ATTEMPT,
            fence=1,policy_hash=self.ref['policy_sha256'],input=dict(snapshot_ref=observation['snapshot_ref']))
        self.assertCode('BROWSER_MODEL_ACTION_BUSY',self.runtime._model_guard,request)
        result=self.runtime.poll_action(dict(self.ref,ordinal=1))
        self.assertEqual(result['kind'],'uncertain');self.assertEqual(result['code'],'SITE_EFFECT_READBACK_REQUIRED')
        self.assertEqual(result['usage']['requests'],0)
        self.assertCode('BROWSER_ACTION_UNCERTAIN',self.runtime.action,dict(self.ref,envelope=dict(envelope,ordinal=2)))
        self.assertCode('BROWSER_MODEL_ACTION_UNCERTAIN',self.runtime._model_guard,request)

    def test_sequential_local_dom_primitives_retain_unverified_effect_without_business_success(self):
        wire="print(json.dumps({'event':'selected_request','request_ref':'held_request_'+str(env['ordinal']),'metadata':m}),flush=True);pending=v;continue"
        self.host.guest_program=FAKE_SELECTED.replace(wire,"reply['result']={'kind':'click','status':'done','effect':'unverified_until_gateway_and_site_readback'};print(json.dumps(reply),flush=True);continue")
        self.host.guest_program=self.host.guest_program.replace("op={'kind':'navigate','destination_id':'site','url':'https://selected.example/'}",
            "op={'kind':'click','element_ref':'reviewed_button'}")
        self.host.guest_program=self.host.guest_program.replace("'effect':'read','label':'Open selected site'","'effect':'external_change','label':'Click reviewed button'")
        self.runtime.launch(self.spec)
        for ordinal in (1,2):
            observed=self.runtime.observe(self.ref);candidate=observed['candidates'][0]
            envelope=dict(schema='proxypilot.browser-action.proposal.v1',**self.ref,ordinal=ordinal,
                snapshot_ref=observed['snapshot_ref'],candidate_ref=candidate['candidate_ref'],
                approval_ref=dict(id=APPROVAL,sha256='d'*64),operation=candidate['operation'])
            self.runtime.action(dict(self.ref,envelope=envelope))
            self.assertTrue(self.runtime.actions[(helpers.ATTEMPT,ordinal)][1].wait(2))
            result=self.runtime.poll_action(dict(self.ref,ordinal=ordinal))
            self.assertEqual(result['kind'],'done');self.assertEqual(result['usage']['requests'],0)
            self.assertEqual(result['facts'],[dict(code='BROWSER_LOCAL_OPERATION_COMPLETED',source_ref=None)])
            self.assertEqual(result['result']['effect'],'unverified_until_gateway_and_site_readback')
        self.assertEqual(self.host.registry.gateway.effects_sent,0)

    def test_legacy_method_cannot_bypass_selected_policy_privacy(self):
        self.runtime.launch(self.spec)
        for method in ('action','view','live','takeover','renew'):
            self.assertCode('METHOD_NOT_ALLOWED',self.supervisor.dispatch,method,{k:self.ref[k] for k in ('run_id','attempt_id','fence')})

    def test_manual_auth_requires_controller_closes_viewers_blocks_model_and_capture(self):
        self.runtime.launch(self.spec)
        self.runtime.takeover(dict(self.ref,controller_id=PROJECT,session_id=SESSION,manual_auth=True,conn=None))
        a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        self.assertTrue(a['manual_auth'])
        self.assertEqual(a['selected_mode'],'human')
        self.assertCode('MANUAL_AUTH_CAPTURE_DISABLED',self.runtime.view,self.ref)
        self.assertCode('BROWSER_OBSERVATION_PAUSED',self.runtime.observe,self.ref)
        self.assertCode('MANUAL_AUTH_PRIVATE',self.runtime.live,dict(self.ref,viewer_id=GUIDE,session_id=SESSION,controller_id=None,manual_auth=True))
        self.assertCode('NOT_TAKEN_OVER',self.runtime.release,dict(self.ref,controller_id=GUIDE))
        self.runtime.release(dict(self.ref,controller_id=PROJECT))
        self.assertFalse(a['manual_auth'])
        self.assertEqual(a['selected_mode'],'paused')
        self.assertEqual(a['selected_native_inputs'],dict(key=0,click=0,scroll=0))
        self.assertTrue(a['selected_native_inputs_measured'])
        self.runtime.resume(self.ref)
        self.assertEqual(a['selected_mode'],'agent')

    def test_takeover_closes_existing_spectators_and_requires_exact_viewer_connection(self):
        self.runtime.launch(self.spec)
        worker=self.supervisor.workers[helpers.ATTEMPT]
        owner,old_owner,spectator='a'*16,'b'*16,'c'*16
        queues={conn:__import__('queue').Queue() for conn in (owner,old_owner,spectator)}
        worker.live_sinks.update(queues)
        for conn in (owner,old_owner):self.runtime.live_viewers[(helpers.ATTEMPT,conn)]=PROJECT
        for conn in (owner,old_owner):self.runtime.live_sessions[(helpers.ATTEMPT,conn)]=SESSION
        self.runtime.live_viewers[(helpers.ATTEMPT,spectator)]=GUIDE
        # A different user's connection cannot be selected before any state change.
        self.assertCode('LIVE_CONN_UNKNOWN',self.runtime.takeover,dict(self.ref,controller_id=PROJECT,session_id=SESSION,manual_auth=True,conn=spectator))
        self.assertEqual(self.supervisor.state['attempts'][helpers.ATTEMPT]['selected_mode'],'agent')
        self.runtime.takeover(dict(self.ref,controller_id=PROJECT,session_id=SESSION,manual_auth=True,conn=owner))
        self.assertEqual(set(worker.live_sinks),{owner})
        self.assertEqual(queues[spectator].get_nowait()['reason'],'manual_auth_private')
        self.assertEqual(queues[old_owner].get_nowait()['reason'],'manual_auth_private')
        self.runtime.control(dict(self.ref,controller_id=PROJECT,ordinal=1,input={'kind':'key','key':'Tab'}))
        self.assertEqual(self.supervisor.state['runs'][helpers.RUN]['action_count'],1)
        self.assertCode('ACTION_LIMIT_OR_ORDINAL_INVALID',self.runtime.control,
                        dict(self.ref,controller_id=PROJECT,ordinal=1,input={'kind':'key','key':'Tab'}))

    def test_pending_poll_surfaces_approval_before_action_done_and_pause_unblocks_queue(self):
        self.runtime.launch(self.spec)
        observed=self.runtime.observe(self.ref);candidate=observed['candidates'][0]
        envelope=dict(schema='proxypilot.browser-action.proposal.v1',**self.ref,ordinal=1,
            snapshot_ref=observed['snapshot_ref'],candidate_ref=candidate['candidate_ref'],approval_ref=None,operation=candidate['operation'])
        self.runtime.action(dict(self.ref,envelope=envelope))
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            result=self.runtime.poll_action(dict(self.ref,ordinal=1))
            if result['kind']=='request_approval':break
            time.sleep(.01)
        self.assertEqual(result['kind'],'request_approval')
        self.assertEqual(result['request']['role'],'resource')
        self.assertFalse(self.runtime.actions[(helpers.ATTEMPT,1)][1].is_set())
        self.runtime.pause(self.ref)
        self.assertEqual(self.runtime.pending(self.ref)['pending'],[])
        self.assertEqual(self.host.registry.gateway.pending,{})
        self.assertEqual(self.host.registry.gateway.status()['effects_sent'],0)

    def test_sent_effect_requires_readback_even_worker_success_and_counters_are_cumulative(self):
        self.runtime.launch(self.spec)
        a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        a['actions'].append(dict(ordinal=1,action='submit',state='started',usage_start=dict(requests=0,response_bytes=0,effects_sent=0,effects_uncertain=0)))
        done=__import__('threading').Event();done.set()
        self.runtime.actions[(helpers.ATTEMPT,1)]=(1,done,{'reply':{'ok':True,'result':{'status':'done'}}})
        gate=self.host.registry.gateway
        gate.requests,gate.response_bytes,gate.effects_sent=3,12,1
        out=self.runtime.poll_action(dict(self.ref,ordinal=1))
        self.assertEqual(out['kind'],'uncertain')
        self.assertEqual(out['code'],'SITE_EFFECT_READBACK_REQUIRED')
        self.assertEqual(out['usage'],dict(requests=3,response_bytes=12,artifact_bytes=0))
        self.assertEqual(out['usage_mode'],'cumulative')
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=1)),out)

    def begin_fixture_action(self):
        observed=self.runtime.observe(self.ref);candidate=observed['candidates'][0]
        envelope=dict(schema='proxypilot.browser-action.proposal.v1',**self.ref,
            ordinal=self.supervisor.state['runs'][helpers.RUN]['action_count']+1,
            snapshot_ref=observed['snapshot_ref'],candidate_ref=candidate['candidate_ref'],approval_ref=None,operation=candidate['operation'])
        self.runtime.action(dict(self.ref,envelope=envelope))
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            pending=self.runtime.pending(self.ref)['pending']
            if pending:return pending[0]
            time.sleep(.01)
        self.fail('fixture request never reached host')

    def test_deny_exact_held_request_pauses_durably_settles_no_effect_and_can_resume(self):
        self.runtime.launch(self.spec)
        pending=self.begin_fixture_action()
        self.assertCode('REQUEST_DENIAL_STALE',self.runtime.deny_request,dict(self.ref,request_ref='other'))
        denied=self.supervisor.dispatch('selected_browser_deny_request',dict(self.ref,request_ref=pending['request_ref']))
        self.assertTrue(denied['paused']);self.assertTrue(denied['no_contact'])
        proof=self.decode(denied['attestation'])
        self.assertEqual(proof['kind'],'selected-browser-request-denial')
        self.assertEqual(proof['request_ref'],pending['request_ref'])
        result=self.runtime.poll_action(dict(self.ref,ordinal=1))
        self.assertEqual((result['kind'],result['state'],result['code']),('done','blocked','BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT'))
        self.assertTrue(self.decode(result['attestation'])['no_effect_sent'])
        self.assertEqual(self.runtime.pending(self.ref)['pending'],[])
        self.assertEqual(self.host.registry.gateway.pending,{})
        self.assertEqual(self.supervisor.state['attempts'][helpers.ATTEMPT]['state'],'running')
        self.assertEqual(self.supervisor.dispatch('selected_browser_deny_request',dict(self.ref,request_ref=pending['request_ref'])),denied)
        self.runtime.pause(self.ref)  # service follows deny with an idempotent pause
        self.runtime.resume(self.ref)
        self.assertEqual(self.begin_fixture_action()['current_action']['ordinal'],2)
        self.assertEqual(self.host.registry.gateway.status()['effects_sent'],0)

    def test_offlist_poll_settles_before_grant_and_retains_exact_escalation_without_replay(self):
        self.host.guest_program=FAKE_SELECTED.replace('https://selected.example/save','https://other.example/new')
        self.runtime.launch(self.spec)
        pending=self.begin_fixture_action()
        self.assertEqual(pending['kind'],'off_list_destination')
        a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        sent=self.runtime.actions[(helpers.ATTEMPT,1)]
        self.assertTrue(sent[1].wait(3),'Real fixture guest never finished the blocked action')
        old=self.runtime.poll_action(dict(self.ref,ordinal=1))
        self.assertEqual(old['state'],'blocked')
        proof=self.decode(old['attestation'])
        self.assertEqual(proof['ordinal'],1);self.assertEqual(proof['request_refs'],[pending['request_ref']])
        self.assertFalse(proof['replay_allowed']);self.assertTrue(proof['no_effect_sent'])
        self.assertEqual(self.runtime.pending(self.ref)['pending'],[pending])
        self.assertEqual(self.supervisor.state['runs'][helpers.RUN]['action_count'],1)
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=1)),old)
        self.assertNotIn('resolve:other.example',self.host.trace)
        destination=dict(id='temporary',origin=pending['origin'],roles=[pending['role']],
                         session_headers='this_origin_session' if pending['role']=='authentication' else 'omit')
        grant=dict(schema='proxypilot.selected-browser.destination-grant.v1',id=APPROVAL,identity=a['selected_identity'],
            origin=destination['origin'],roles=destination['roles'],purpose_sha256=self.runtime.policy.digest(pending['purpose']),
            expires_at=int(self.clock()+60),persist_to_allowlist=False,wildcards=False)
        self.runtime.grant_destination(dict(self.ref,grant=grant,destination=destination))
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=1)),old)
        self.assertEqual(self.host.registry.gateway.status()['requests'],0)
        self.assertEqual(self.begin_fixture_action()['current_action']['ordinal'],2)

    def test_offlist_poll_keeps_unfinished_action_and_escalation_pending(self):
        self.host.guest_program=FAKE_SELECTED.replace('https://selected.example/save','https://other.example/new')
        self.runtime.launch(self.spec)
        pending=self.begin_fixture_action()
        key=(helpers.ATTEMPT,1);sent=self.runtime.actions[key]
        self.assertTrue(sent[1].wait(3))
        # Delay real completion delivery, not browser execution or wire facts.
        with patch.dict(self.runtime.actions,{key:(sent[0],threading.Event(),sent[2])}):
            out=self.runtime.poll_action(dict(self.ref,ordinal=1))
            self.assertEqual(out['kind'],'off_list')
            self.assertEqual(out['escalation']['request_ref'],pending['request_ref'])
            self.assertEqual(self.supervisor.state['attempts'][helpers.ATTEMPT]['actions'][0]['state'],'started')
            self.assertEqual(self.runtime.pending(self.ref)['pending'],[pending])
            self.assertNotIn('resolve:other.example',self.host.trace)
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=1))['state'],'blocked')

    def test_offlist_poll_with_changed_effects_is_uncertain_and_never_proves_no_effect(self):
        self.host.guest_program=FAKE_SELECTED.replace('https://selected.example/save','https://other.example/new')
        self.runtime.launch(self.spec)
        pending=self.begin_fixture_action()
        self.assertTrue(self.runtime.actions[(helpers.ATTEMPT,1)][1].wait(3))
        self.host.registry.gateway.effects_sent=1
        out=self.runtime.poll_action(dict(self.ref,ordinal=1))
        self.assertEqual(out['kind'],'uncertain')
        self.assertEqual(out['code'],'SITE_EFFECT_READBACK_REQUIRED')
        self.assertNotIn('attestation',out)
        self.assertEqual(self.supervisor.state['attempts'][helpers.ATTEMPT]['actions'][0]['state'],'uncertain')
        self.assertEqual(self.runtime.pending(self.ref)['pending'],[pending])
        self.assertNotIn('resolve:other.example',self.host.trace)
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=1)),out)
        self.assertCode('BROWSER_ACTION_UNCERTAIN',self.runtime.grant_destination,self.destination_grant(pending))
        self.assertNotIn('resolve:other.example',self.host.trace)

    def destination_grant(self,pending):
        a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        destination=dict(id='temporary',origin=pending['origin'],roles=[pending['role']],
                         session_headers='this_origin_session' if pending['role']=='authentication' else 'omit')
        grant=dict(schema='proxypilot.selected-browser.destination-grant.v1',id=APPROVAL,identity=a['selected_identity'],
            origin=destination['origin'],roles=destination['roles'],purpose_sha256=self.runtime.policy.digest(pending['purpose']),
            expires_at=int(self.clock()+60),persist_to_allowlist=False,wildcards=False)
        return dict(self.ref,grant=grant,destination=destination)

    def test_offlist_poll_transport_uncertainty_is_durable_and_refuses_grant_before_resolution(self):
        self.host.guest_program=FAKE_SELECTED.replace('https://selected.example/save','https://other.example/new')
        self.runtime.launch(self.spec)
        pending=self.begin_fixture_action()
        self.assertTrue(self.runtime.actions[(helpers.ATTEMPT,1)][1].wait(3))
        self.host.registry.gateway.effects_uncertain=1
        out=self.runtime.poll_action(dict(self.ref,ordinal=1))
        self.assertEqual(out['kind'],'uncertain')
        self.assertEqual(out['code'],'SITE_EFFECT_READBACK_REQUIRED')
        self.assertNotIn('attestation',out)
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=1)),out)
        self.assertEqual(self.runtime.pending(self.ref)['pending'],[pending])
        self.assertCode('BROWSER_ACTION_UNCERTAIN',self.runtime.grant_destination,self.destination_grant(pending))
        self.assertNotIn('resolve:other.example',self.host.trace)

    def test_offlist_poll_cannot_sign_no_effect_while_network_is_inflight(self):
        self.host.guest_program=FAKE_SELECTED.replace('https://selected.example/save','https://other.example/new')
        self.runtime.launch(self.spec)
        pending=self.begin_fixture_action()
        self.assertTrue(self.runtime.actions[(helpers.ATTEMPT,1)][1].wait(3))
        self.host.registry.gateway.inflight=1
        out=self.runtime.poll_action(dict(self.ref,ordinal=1))
        self.assertEqual(out['kind'],'off_list')
        self.assertEqual(out['escalation']['request_ref'],pending['request_ref'])
        self.assertNotIn('attestation',out)
        self.assertEqual(self.supervisor.state['attempts'][helpers.ATTEMPT]['actions'][0]['state'],'started')
        self.host.registry.gateway.inflight=0
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=1))['state'],'blocked')

    def test_offlist_after_sent_effect_refuses_grant_before_destination_resolution(self):
        self.host.guest_program=FAKE_SELECTED.replace('https://selected.example/save','https://other.example/new')
        self.runtime.launch(self.spec)
        pending=self.begin_fixture_action();a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        self.host.registry.gateway.effects_sent=1
        destination=dict(id='temporary',origin=pending['origin'],roles=[pending['role']],session_headers='omit')
        grant=dict(schema='proxypilot.selected-browser.destination-grant.v1',id=APPROVAL,identity=a['selected_identity'],
            origin=destination['origin'],roles=destination['roles'],purpose_sha256=self.runtime.policy.digest(pending['purpose']),
            expires_at=int(self.clock()+60),persist_to_allowlist=False,wildcards=False)
        before=list(self.host.trace)
        self.assertCode('BROWSER_ACTION_UNCERTAIN',self.runtime.grant_destination,dict(self.ref,grant=grant,destination=destination))
        self.assertNotIn('resolve:other.example',self.host.trace[len(before):])
        self.assertEqual(a['actions'][0]['state'],'started')

    def test_blocked_proof_refuses_more_than64_refs_without_dropping_or_signing(self):
        self.host.guest_program=FAKE_SELECTED.replace('https://selected.example/save','https://other.example/new')
        self.runtime.launch(self.spec)
        pending=self.begin_fixture_action();a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        a['actions'][0]['blocked_request_refs']=[pending['request_ref']]+['ref'+str(i) for i in range(64)]
        self.assertCode('BROWSER_BLOCKED_ACTION_PROOF_INVALID',self.runtime._settle_blocked_actions,a,[pending['request_ref']])
        self.assertEqual(a['actions'][0]['state'],'started')
        self.assertEqual(len(a['actions'][0]['blocked_request_refs']),65)

    def test_manual_denial_preserves_sole_controller_and_auth_without_replaying_request(self):
        self.runtime.launch(self.spec)
        self.runtime.takeover(dict(self.ref,controller_id=PROJECT,session_id=SESSION,manual_auth=True,conn=None))
        a=self.supervisor.state['attempts'][helpers.ATTEMPT];gate=self.host.registry.gateway
        meta=dict(url='https://selected.example/save',method='POST',body_sha256=hashlib.sha256(b'x').hexdigest(),
            body_bytes=1,resource_type='fetch',role='resource',current_action=None,**self.ref)
        reply=gate.review_request('manual-save',meta)
        a['selected_pending']['manual-save']=dict(kind='network_effect',request_ref='manual-save',binding_sha256=reply['binding_sha256'])
        a['selected_mode']='paused'
        out=self.runtime.deny_request(dict(self.ref,request_ref='manual-save'))
        self.assertEqual((out['state'],out['manual_auth'],out['paused']),('human_control',True,False))
        proof=self.decode(out['attestation'])
        self.assertEqual(proof['boot_id'],a['boot_id']);self.assertEqual(proof['original_fence'],1)
        self.assertEqual(a['selected_controller'],PROJECT);self.assertTrue(a['manual_auth'])
        self.assertEqual(a['selected_mode'],'human');self.assertEqual(gate.state,'running')
        self.assertIn('manual-save',a['selected_discarded_requests'])
        self.assertEqual(gate.pending,{});self.assertEqual(gate.status()['effects_sent'],0)
        self.assertCode('MANUAL_AUTH_CAPTURE_DISABLED',self.runtime.view,self.ref)
        new=gate.review_request('fresh-save',meta)
        self.assertEqual(new['decision'],'approval_required')

    def test_late_pre_pause_request_event_is_tombstoned_without_ticket_or_new_contact(self):
        self.runtime.launch(self.spec)
        a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        self.runtime._remember_discarded(a,['already-failed'])
        before=list(self.host.trace)
        self.runtime.event_queues[helpers.ATTEMPT].put(dict(event='selected_request',request_ref='already-failed',metadata={}))
        deadline=time.monotonic()+1
        while time.monotonic()<deadline and not self.runtime.event_queues[helpers.ATTEMPT].empty():time.sleep(.01)
        self.assertEqual(self.host.trace,before)
        self.assertEqual(self.host.registry.gateway.tickets,{})

    def test_model_admission_checks_actual_gateway_not_cached_pending(self):
        self.runtime.launch(self.spec);observation=self.runtime.observe(self.ref)
        params=dict(purpose='decision',project_id=PROJECT,project_limits_revision=1,guide_version_id=GUIDE,
                    guide_hash='c'*64,consent_hash='d'*64,run_id=helpers.RUN,attempt_id=helpers.ATTEMPT,
                    fence=1,policy_hash=self.ref['policy_sha256'],input=dict(snapshot_ref=observation['snapshot_ref']))
        self.host.registry.gateway.inflight=1
        self.assertCode('BROWSER_MODEL_NETWORK_UNSETTLED',self.runtime._model_guard,params)
        self.host.registry.gateway.inflight=0
        self.host.registry.gateway.effects_sent=1
        self.assertCode('BROWSER_MODEL_NETWORK_UNSETTLED',self.runtime._model_guard,params)

    def live_controller(self):
        conn='a'*32
        worker=self.supervisor.workers[helpers.ATTEMPT]
        worker.live_sinks[conn]=__import__('queue').Queue()
        self.runtime.live_viewers[(helpers.ATTEMPT,conn)]=PROJECT
        self.runtime.live_sessions[(helpers.ATTEMPT,conn)]=SESSION
        self.runtime.takeover(dict(self.ref,controller_id=PROJECT,session_id=SESSION,manual_auth=True,conn=conn))
        return conn

    def send_auth_wire_fixture(self,ref='auth',role='authentication'):
        gate=self.host.registry.gateway
        conn=Mock();response=Mock(status=200);response.getheaders.return_value=[]
        response.read.side_effect=[b'fixture',b'']
        conn.getresponse.return_value=response;gate.connection_factory=Mock(return_value=conn)
        gate.resolver=lambda _:['1.1.1.1'];gate.route_reader=lambda _:'b'*64
        body=b'password=local-only'
        meta=dict(url='https://selected.example/api/login?token=private',method='POST',body_sha256=hashlib.sha256(body).hexdigest(),
            body_bytes=len(body),resource_type='fetch',role=role,current_action=None,**self.ref)
        review=gate.review_request(ref,meta)
        context='Review this exact authentication request'
        grant=dict(schema='proxypilot.selected-browser.effect-grant.v1',id=str(__import__('uuid').uuid4()),
            identity=gate.policy.identity,request_ref=ref,binding_sha256=review['binding_sha256'],
            expires_at=int(self.clock()+30),purpose_sha256=self.runtime.policy.digest(context),human_context=context)
        grant['approval_ref']=dict(id=grant['id'],sha256=review['binding_sha256'])
        allowed=gate.approve_request(ref,grant)
        gate.forward('POST',meta['url'],{self.host.gateway_module.TICKET_HEADER:allowed['ticket']},body)
        return grant

    def confirmation(self,inventory,requests=None):
        packet=dict(schema='selected-browser-auth-confirmation.v1',**self.ref,controller_id=PROJECT,session_id=SESSION,
            viewer_conn_sha256=inventory['viewer_conn_sha256'],inventory_sha256=inventory['inventory_sha256'],
            ledger_sha256=inventory['ledger_sha256'],request_refs=inventory['requests'] if requests is None else requests,
            reviewed_statement=self.host.gateway_module.AUTH_STATEMENT,expires_at=s.stamp(self.clock()+30))
        packet['confirmation_ref']=dict(id=str(__import__('uuid').uuid4()),sha256=self.runtime.policy.digest(self.runtime.policy.canonical(packet)))
        return packet

    def test_manual_next_auth_origin_requires_current_live_controller_and_keeps_readback_pending(self):
        self.runtime.launch(self.spec);conn=self.live_controller();self.send_auth_wire_fixture()
        meta=dict(url='https://other.example/mfa',method='GET',body_sha256=hashlib.sha256(b'').hexdigest(),
            body_bytes=0,resource_type='document',role='authentication',current_action=None,**self.ref)
        self.runtime.event_queues[helpers.ATTEMPT].put(dict(event='selected_request',request_ref='manual-next-auth',metadata=meta))
        deadline=time.monotonic()+3
        while time.monotonic()<deadline and not self.runtime.pending(self.ref)['pending']:time.sleep(.01)
        pending=self.runtime.pending(self.ref)['pending'][0]
        self.assertEqual(pending['role'],'authentication');self.assertTrue(pending['no_contact'])
        worker=self.supervisor.workers[helpers.ATTEMPT];sink=worker.live_sinks.pop(conn)
        self.assertCode('AUTH_READBACK_CONTROLLER_MISMATCH',self.runtime.grant_destination,self.destination_grant(pending))
        self.assertNotIn('resolve:other.example',self.host.trace)
        worker.live_sinks[conn]=sink
        self.host.registry.gateway.effects_uncertain=1
        self.assertCode('BROWSER_ACTION_UNCERTAIN',self.runtime.grant_destination,self.destination_grant(pending))
        self.assertNotIn('resolve:other.example',self.host.trace)
        self.host.registry.gateway.effects_uncertain=0
        self.runtime.grant_destination(self.destination_grant(pending))
        a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        self.assertEqual(a['selected_mode'],'human');self.assertTrue(a['manual_auth'])
        status=self.runtime.pending(self.ref)
        self.assertEqual(status['effects_sent'],1);self.assertEqual(status['auth_effects_acknowledged'],0)
        self.assertCode('AUTH_READBACK_REQUIRED',self.runtime.release,dict(self.ref,controller_id=PROJECT))
        self.assertCode('MANUAL_AUTH_CAPTURE_DISABLED',self.runtime.view,self.ref)

    def test_confirmed_auth_baseline_does_not_block_a_fresh_automated_destination_grant(self):
        self.host.guest_program=FAKE_SELECTED.replace('https://selected.example/save','https://other.example/new')
        self.runtime.launch(self.spec);conn=self.live_controller();self.send_auth_wire_fixture()
        inventory=self.runtime.auth_inventory(dict(self.ref,controller_id=PROJECT,session_id=SESSION,conn=conn))
        self.runtime.confirm_authentication(dict(self.ref,packet=self.confirmation(inventory),conn=conn))
        self.runtime.release(dict(self.ref,controller_id=PROJECT));self.runtime.resume(self.ref)
        pending=self.begin_fixture_action()
        self.assertTrue(self.runtime.actions[(helpers.ATTEMPT,1)][1].wait(3))
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=1))['state'],'blocked')
        self.runtime.grant_destination(self.destination_grant(pending))
        status=self.runtime.pending(self.ref)
        self.assertEqual(status['effects_sent'],1);self.assertEqual(status['auth_effects_acknowledged'],1)
        self.assertEqual(status['pending'],[]);self.assertEqual(status['mode'],'agent')

    def test_authentication_independent_confirm_then_giveback_pause_resume_read(self):
        self.runtime.launch(self.spec);conn=self.live_controller();self.send_auth_wire_fixture()
        self.assertCode('AUTH_READBACK_REQUIRED',self.runtime.release,dict(self.ref,controller_id=PROJECT))
        self.assertCode('AUTH_READBACK_REQUIRED',self.runtime.auth,dict(self.ref,active=False))
        a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        self.assertTrue(a['manual_auth']);self.assertEqual(a['selected_controller_session'],SESSION)
        inventory=self.supervisor.dispatch('selected_browser_auth_inventory',dict(self.ref,controller_id=PROJECT,session_id=SESSION,conn=conn))
        proof=self.decode(inventory['attestation'])
        self.assertEqual(proof['kind'],'selected-browser-auth-inventory');self.assertEqual(proof['requests'],inventory['requests'])
        self.assertEqual(proof['original_fence'],1);self.assertEqual(proof['viewer_conn_sha256'],hashlib.sha256(conn.encode()).hexdigest())
        packet=self.confirmation(inventory)
        ack=self.supervisor.dispatch('selected_browser_confirm_authentication',dict(self.ref,packet=packet,conn=conn))
        self.assertEqual(ack['auth_effects_acknowledged'],1);self.assertFalse(ack['replay_allowed'])
        self.assertEqual(self.decode(ack['attestation'])['request_sha256'],self.runtime.policy.digest(self.runtime.policy.canonical(packet)))
        self.assertEqual(self.runtime.confirm_authentication(dict(self.ref,packet=packet,conn=conn)),ack)
        self.assertTrue(a['manual_auth'])  # Confirmation itself grants no capture/control transition.
        self.runtime.release(dict(self.ref,controller_id=PROJECT))
        self.assertEqual(a['selected_mode'],'paused');self.assertFalse(a['manual_auth'])
        self.runtime.resume(self.ref);observation=self.runtime.observe(self.ref)
        candidate=observation['candidates'][0]
        request=dict(purpose='decision',project_id=PROJECT,project_limits_revision=1,guide_version_id=GUIDE,
            guide_hash='c'*64,consent_hash='d'*64,run_id=helpers.RUN,attempt_id=helpers.ATTEMPT,
            fence=1,policy_hash=self.ref['policy_sha256'],limits=dict(max_tokens=10000,max_usd=.25,max_calls=20,max_output_tokens=128),
            input=dict(snapshot_ref=observation['snapshot_ref'],candidates=[dict(id=candidate['candidate_ref']['id'],
                sha256=candidate['candidate_ref']['sha256'],operation=candidate['operation']['kind'],effect=candidate['effect'],label=candidate['label'])]))
        self.runtime._model_guard(request)
        self.assertEqual(self.runtime.pending(self.ref)['auth_effects_acknowledged'],1)

    def test_authentication_wrong_session_disconnected_viewer_forged_or_stale_request_refused(self):
        self.runtime.launch(self.spec);conn=self.live_controller();self.send_auth_wire_fixture()
        params=dict(self.ref,controller_id=PROJECT,session_id=SESSION,conn=conn)
        self.assertCode('AUTH_READBACK_CONTROLLER_MISMATCH',self.runtime.auth_inventory,dict(params,session_id=GUIDE))
        inventory=self.runtime.auth_inventory(params);packet=self.confirmation(inventory)
        before=list(self.host.trace)
        malformed=copy.deepcopy(packet);malformed['confirmation_ref']=[]
        self.assertCode('AUTH_CONFIRMATION_INVALID',self.runtime.confirm_authentication,dict(self.ref,packet=malformed,conn=conn))
        self.assertEqual(self.host.trace,before)
        self.runtime.live_sessions[(helpers.ATTEMPT,conn)]=GUIDE
        self.assertCode('AUTH_READBACK_CONTROLLER_MISMATCH',self.runtime.confirm_authentication,dict(self.ref,packet=packet,conn=conn))
        self.runtime.live_sessions[(helpers.ATTEMPT,conn)]=SESSION
        forged=copy.deepcopy(packet);forged['request_refs'][0]['body_sha256']='0'*64
        forged['confirmation_ref']['sha256']=self.runtime.policy.digest(self.runtime.policy.canonical({k:v for k,v in forged.items() if k!='confirmation_ref'}))
        self.assertCode('AUTH_CONFIRMATION_SCOPE_INVALID',self.runtime.confirm_authentication,dict(self.ref,packet=forged,conn=conn))
        self.send_auth_wire_fixture('new')
        self.assertCode('AUTH_INVENTORY_STALE_OR_UNSETTLED',self.runtime.confirm_authentication,dict(self.ref,packet=packet,conn=conn))
        self.assertEqual(self.host.registry.gateway.auth_effects_acknowledged,0)
        self.assertTrue(self.supervisor.state['attempts'][helpers.ATTEMPT]['manual_auth'])

    def test_authentication_ack_never_reconciles_business_or_new_unselected_write(self):
        self.runtime.launch(self.spec);conn=self.live_controller();self.send_auth_wire_fixture()
        inventory=self.runtime.auth_inventory(dict(self.ref,controller_id=PROJECT,session_id=SESSION,conn=conn))
        self.runtime.confirm_authentication(dict(self.ref,packet=self.confirmation(inventory),conn=conn))
        self.send_auth_wire_fixture('business',role='resource')
        self.assertCode('AUTH_READBACK_REQUIRED',self.runtime.release,dict(self.ref,controller_id=PROJECT))
        self.assertEqual(self.host.registry.gateway.auth_effects_acknowledged,1)
        self.assertTrue(self.supervisor.state['attempts'][helpers.ATTEMPT]['manual_auth'])
        self.assertEqual(self.host.registry.gateway.auth_inventory()['requests'],[])

    def test_model_forged_candidate_target_or_budget_refused_before_bridge(self):
        self.runtime.launch(self.spec)
        observation=self.runtime.observe(self.ref)
        limits=dict(max_tokens=10000,max_usd=.25,max_calls=20,max_output_tokens=128)
        candidate=observation['candidates'][0]
        mapped=dict(id=candidate['candidate_ref']['id'],sha256=candidate['candidate_ref']['sha256'],
                    operation=candidate['operation']['kind'],label=candidate['label'],effect=candidate['effect'])
        request=dict(purpose='decision',project_id=PROJECT,project_limits_revision=1,guide_version_id=GUIDE,
                     guide_hash='c'*64,consent_hash='d'*64,run_id=helpers.RUN,attempt_id=helpers.ATTEMPT,
                     fence=1,policy_hash=self.ref['policy_sha256'],limits=limits,
                     input=dict(snapshot_ref=observation['snapshot_ref'],candidates=[mapped]))
        self.runtime._model_guard(request)
        forged=copy.deepcopy(request);forged['input']['candidates'][0]['id']=APPROVAL
        self.assertCode('BROWSER_MODEL_CANDIDATE_PIN_MISMATCH',self.runtime._model_guard,forged)
        forged=copy.deepcopy(request);forged['limits']['max_tokens']=50000
        self.assertCode('BROWSER_MODEL_BUDGET_PIN_MISMATCH',self.runtime._model_guard,forged)
        forged=copy.deepcopy(request);forged['purpose']='draft_input';forged['limits']['max_output_tokens']=1500
        self.assertCode('BROWSER_MODEL_CANDIDATE_PIN_MISMATCH',self.runtime._model_guard,forged)

    def test_invalid_offlist_grant_cannot_resolve_or_expand_scope(self):
        self.runtime.launch(self.spec)
        a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        a['selected_pending']['blocked']=dict(kind='off_list_destination',origin='https://other.example',role='resource',
            purpose='Review resource access',request_ref='blocked',method='GET',url_sha256='a'*64,request_sha256='b'*64,no_contact=True)
        destination=dict(id='temporary',origin='https://other.example',roles=['navigation'],session_headers='omit')
        grant=dict(schema='proxypilot.selected-browser.destination-grant.v1',id=APPROVAL,identity=a['selected_identity'],
            origin=destination['origin'],roles=destination['roles'],purpose_sha256=self.runtime.policy.digest('Review resource access'),
            expires_at=int(self.clock()+60),persist_to_allowlist=False,wildcards=False)
        before=list(self.host.trace)
        self.assertCode('DESTINATION_GRANT_SCOPE_MISMATCH',self.runtime.grant_destination,dict(self.ref,grant=grant,destination=destination))
        self.assertEqual(self.host.trace,before+['gateway:health'])

    def test_model_cancel_is_durable_after_gateway_revocation_before_guest_stop(self):
        self.runtime.launch(self.spec)
        self.supervisor.state['selected_browser_model_runs']={helpers.RUN:{'state':'active','reserved_tokens':42,'calls':{'accepted':{'state':'reserved'}}}}
        def cancel(params):
            self.host.trace.append('model:cancel')
            self.supervisor.state['selected_browser_model_runs'][params['run_id']]['state']='cancelled'
            self.supervisor._save()
            return dict(cancelled=True,broker_confirmed=True,provider_already_accepted=True)
        self.runtime.model.cancel=cancel
        self.runtime.stop(dict(self.ref,fence=2,reason='cancelled'))
        self.assertLess(self.host.trace.index('gateway:revoke'),self.host.trace.index('model:cancel'))
        self.assertLess(self.host.trace.index('model:cancel'),self.host.trace.index('stop_unit'))
        ledger=self.supervisor.state['selected_browser_model_runs'][helpers.RUN]
        self.assertEqual(ledger['state'],'cancelled');self.assertEqual(ledger['reserved_tokens'],42)


    def test_absent_attempt_cleanup_is_signed_and_permanent_across_restart(self):
        receipt = self.runtime.stop(dict(self.ref, fence=2, reason='cancelled'))
        proof = self.decode(receipt['attestation'])
        self.assertTrue(proof['no_launch'])
        self.assertTrue(proof['gateway_never_registered'])
        self.assertFalse(proof['evidence']['launched'])
        self.assertEqual(proof['original_fence'], 1)
        self.assertEqual(proof['workspace_id'], helpers.ATTEMPT)
        self.assertIsNone(proof['boot_id'])
        self.assertIsNone(proof['network_plan_sha256'])
        self.assertTrue(all(receipt['closed'].values()))
        self.assertEqual(receipt['final_network']['ledger_sha256'], '0' * 64)
        self.assertEqual(self.host.spawns, 0)
        self.assertEqual(self.host.trace, ['gateway:never_registered', 'gateway:health'])
        restored = s.Supervisor(host=self.host, journal=self.root / 'state.json', clock=self.clock)
        runtime = restored._selected()
        self.assertCode('ATTEMPT_EXISTS', runtime.launch, self.spec)
        self.clock.value += 1
        again = runtime.stop(dict(self.ref, fence=3, reason='cancelled'))
        newer = self.decode(again['attestation'])
        self.assertEqual(newer['fence'], 3)
        self.assertEqual(newer['stopped_at'], proof['stopped_at'])
        self.assertEqual(newer['evidence'], proof['evidence'])
        self.assertEqual(again['final_network'], receipt['final_network'])
        self.assertEqual(restored.state['runs'][helpers.RUN]['attempts'], [helpers.ATTEMPT])
        self.assertCode('INVALID_REQUEST', runtime.stop, dict(self.ref, fence=3, reason='cancelled', policy_sha256='0' * 64))
        self.assertCode('INVALID_REQUEST', runtime.stop, dict(self.ref, fence=3, reason='cancelled', attempt_id=PROJECT))

    def test_absence_cleanup_serializes_with_a_delayed_launch(self):
        entered, proceed = threading.Event(), threading.Event()
        original = self.host.selected_gateway
        def gateway(method, params):
            if method == 'never_registered':
                entered.set()
                if not proceed.wait(3):
                    raise AssertionError('Test did not release absence proof')
            return original(method, params)
        self.host.selected_gateway = gateway
        result, failures = [], []
        def stop():
            try: result.append(self.runtime.stop(dict(self.ref, fence=2, reason='cancelled')))
            except Exception as error: failures.append(error)
        def launch():
            try: self.runtime.launch(self.spec)
            except s.Refused as error: failures.append(error)
        stopper = threading.Thread(target=stop)
        stopper.start()
        self.assertTrue(entered.wait(3))
        launcher = threading.Thread(target=launch)
        launcher.start()
        proceed.set()
        stopper.join(4)
        launcher.join(4)
        self.assertFalse(stopper.is_alive())
        self.assertFalse(launcher.is_alive())
        self.assertEqual(len(result), 1)
        self.assertEqual([e.code for e in failures], ['ATTEMPT_EXISTS'])
        self.assertEqual(self.host.spawns, 0)
        self.assertTrue(self.decode(result[0]['attestation'])['no_launch'])

    def test_absence_receipt_refuses_retained_ledger_or_active_gateway(self):
        ledger = self.host.registry.directory / ('selected-' + helpers.ATTEMPT + '.ledger')
        ledger.write_text('')
        ledger.chmod(0o600)
        self.assertCode('GATEWAY_ADMISSION_ABSENCE_UNVERIFIED', self.runtime.stop, dict(self.ref, fence=2, reason='cancelled'))
        self.assertNotIn('receipt', self.supervisor.state['attempts'][helpers.ATTEMPT])
        self.assertEqual(self.host.spawns, 0)
        self.assertTrue(ledger.exists())
        ledger.unlink()  # Local fixture only: production never deletes admission history.
        self.host.registry.latched_identity = dict(self.ref)
        self.assertCode('GATEWAY_ADMISSION_ABSENCE_UNVERIFIED', self.runtime.stop, dict(self.ref, fence=2, reason='cancelled'))
        self.host.registry.latched_identity = None

    def test_terminal_launched_receipt_rebinds_fence_without_new_contact(self):
        self.runtime.launch(self.spec)
        receipt = self.runtime.stop(dict(self.ref, fence=2, reason='cancelled'))
        proof = self.decode(receipt['attestation'])
        before = list(self.host.trace)
        newer = self.runtime.stop(dict(self.ref, fence=3, reason='cancelled'))
        signed = self.decode(newer['attestation'])
        self.assertEqual(signed['fence'], 3)
        self.assertEqual(signed['original_fence'], 1)
        self.assertEqual(signed['stopped_at'], proof['stopped_at'])
        self.assertEqual(signed['evidence'], proof['evidence'])
        self.assertEqual(newer['final_network'], receipt['final_network'])
        self.assertEqual(self.host.trace, before)
        self.assertNotIn('no_launch', signed)

    def test_negative_readiness_retains_signed_identity_and_specific_reason(self):
        self.c['destinations']['allowed_origins'][0]['origin'] = 'https://controller.example'
        self.c['destinations']['entry_urls'] = ['https://controller.example/']
        raw = self.runtime.contract.canonical_json(self.c)
        out = self.runtime.status(dict(configuration_json=raw, configuration_sha256=hashlib.sha256(raw.encode()).hexdigest()))
        self.assertEqual(out['code'], 'PROTECTED_DESTINATION')
        self.assertFalse(out['available'])
        proof = self.decode(out['attestation'])
        self.assertEqual(proof['vm_uuid'], s.VM_UUID)
        self.assertEqual(proof['valid_until'], s.stamp(self.clock() + 30))

if __name__=='__main__':
    unittest.main()
