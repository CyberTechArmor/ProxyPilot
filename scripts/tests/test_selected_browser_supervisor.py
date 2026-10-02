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
import time
import unittest
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
  print(json.dumps({'event':'selected_request','request_ref':'held_request','metadata':m}),flush=True);pending=v;continue
 if name=='selected_request_decision' and pending:
  print(json.dumps({'id':pending['id'],'ok':True,'result':{'kind':'navigate','status':'done','untrusted':True}}),flush=True);pending=None
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
        process = subprocess.Popen([sys.executable, '-c', FAKE_SELECTED, json.dumps(config)], stdin=subprocess.PIPE,
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
        self.assertFalse(self.host.registry.selected()[0])
        self.assertEqual(self.runtime.stop(dict(self.ref,fence=2,reason='cancelled')),receipt)

    def test_legacy_method_cannot_bypass_selected_policy_privacy(self):
        self.runtime.launch(self.spec)
        for method in ('action','view','live','takeover','renew'):
            self.assertCode('METHOD_NOT_ALLOWED',self.supervisor.dispatch,method,{k:self.ref[k] for k in ('run_id','attempt_id','fence')})

    def test_manual_auth_requires_controller_closes_viewers_blocks_model_and_capture(self):
        self.runtime.launch(self.spec)
        self.runtime.takeover(dict(self.ref,controller_id=PROJECT,manual_auth=True,conn=None))
        a=self.supervisor.state['attempts'][helpers.ATTEMPT]
        self.assertTrue(a['manual_auth'])
        self.assertEqual(a['selected_mode'],'human')
        self.assertCode('MANUAL_AUTH_CAPTURE_DISABLED',self.runtime.view,self.ref)
        self.assertCode('BROWSER_OBSERVATION_PAUSED',self.runtime.observe,self.ref)
        self.assertCode('MANUAL_AUTH_PRIVATE',self.runtime.live,dict(self.ref,viewer_id=GUIDE,controller_id=None,manual_auth=True))
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
        self.runtime.live_viewers[(helpers.ATTEMPT,spectator)]=GUIDE
        # A different user's connection cannot be selected before any state change.
        self.assertCode('LIVE_CONN_UNKNOWN',self.runtime.takeover,dict(self.ref,controller_id=PROJECT,manual_auth=True,conn=spectator))
        self.assertEqual(self.supervisor.state['attempts'][helpers.ATTEMPT]['selected_mode'],'agent')
        self.runtime.takeover(dict(self.ref,controller_id=PROJECT,manual_auth=True,conn=owner))
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
        a['actions'].append(dict(ordinal=1,state='started',usage_start=dict(requests=0,response_bytes=0,effects_sent=0,effects_uncertain=0)))
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


if __name__=='__main__':
    unittest.main()
