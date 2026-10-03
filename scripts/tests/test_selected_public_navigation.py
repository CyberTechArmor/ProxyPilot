"""Public runner capability/security cases; no installed boundary acceptance."""
import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import Mock,patch
import test_selected_browser_gateway as fixtures
import test_selected_browser_supervisor as supervisors
p,g=fixtures.p,fixtures.g
PUBLIC=json.loads((fixtures.SCRIPTS.parent/'contracts/browser-agent/fixtures/public-navigation.draft.json').read_text())

class PublicGatewayTests(unittest.TestCase):
    def gate(self,answers=None):
        c=copy.deepcopy(PUBLIC)
        policy=fixtures.policy(c)
        return g.AttemptGateway(policy,g.MemoryLedger(),clock=lambda:fixtures.NOW,
            resolver=Mock(return_value=answers or ['1.1.1.1']),connection_factory=Mock(),route_reader=lambda _:'b'*64)

    def meta(self,gate,url,method='GET',body=b''):
        meta=fixtures.metadata(gate.policy,method=method,body=body)
        meta['url']=url
        return meta

    def test_new_redirect_resource_origin_is_ticketed_without_dns_or_sessions(self):
        gate=self.gate()
        gate.check_connect('new.public.example:443')
        token=gate.review_request('new',self.meta(gate,'https://new.public.example/asset?cache=1'))
        self.assertEqual(token['decision'],'allow');gate.resolver.assert_not_called()
        record,parts=gate.admit('GET','https://new.public.example/asset?cache=1',{g.TICKET_HEADER:token['ticket'],'cookie':'private'},b'')
        self.assertEqual(record['destination']['session_headers'],'omit')
        self.assertEqual(parts['host'],'new.public.example')

    def test_protected_names_literals_and_body_methods_refused_without_contact(self):
        gate=self.gate()
        for i,url in enumerate(('https://controller.example/','http://localhost/','http://169.254.169.254/','http://127.0.0.1/')):
            with self.assertRaises(p.Denied):gate.review_request('deny'+str(i),self.meta(gate,url))
        with self.assertRaises(p.Denied) as error:gate.review_request('post',self.meta(gate,'https://selected.example/','POST',b'x'))
        self.assertEqual(error.exception.code,'PUBLIC_WRITE_DISABLED');self.assertEqual(gate.state,'running')
        gate.resolver.assert_not_called();gate.connection_factory.assert_not_called()

    def test_mixed_dns_and_protected_alias_refused_before_socket_with_retained_accounting(self):
        for answers in (['1.1.1.1','10.0.0.1'],['10.185.17.179'],['169.254.169.254'],['::1']):
            gate=self.gate(answers)
            url='https://new.public.example/';token=gate.review_request('new',self.meta(gate,url))
            with self.assertRaises(p.Denied):gate.forward('GET',url,{g.TICKET_HEADER:token['ticket']},b'')
            gate.connection_factory.assert_not_called();self.assertEqual(gate.status()['requests'],1)
            self.assertEqual(gate.status()['inflight'],0)

    def test_actual_peer_mismatch_closes_socket_before_tls_or_send(self):
        sock=Mock();sock.getpeername.return_value=('127.0.0.1',443)
        with patch.object(g.socket,'create_connection',return_value=sock):
            with self.assertRaises(p.Denied) as error:g.PinnedConnection(p.url_parts('https://selected.example/'),'1.1.1.1',1).connect()
        self.assertEqual(error.exception.code,'CONNECTION_TARGET_CHANGED');sock.close.assert_called_once()

    def test_stop_invalidates_tickets_and_cannot_replay(self):
        gate=self.gate();url='https://selected.example/';token=gate.review_request('stop',self.meta(gate,url));gate.revoke()
        with self.assertRaises(p.Denied):gate.admit('GET',url,{g.TICKET_HEADER:token['ticket']},b'')
        gate.resolver.assert_not_called();self.assertEqual(gate.status()['state'],'revoked')

class PublicSupervisorTests(unittest.TestCase):
    setUp=supervisors.SelectedSupervisorTests.setUp
    tearDown=supervisors.SelectedSupervisorTests.tearDown
    assertCode=supervisors.SelectedSupervisorTests.assertCode
    def public(self):
        self.c=copy.deepcopy(PUBLIC)
        self.spec.update(configuration_json=self.runtime.contract.canonical_json(self.c),guide_version_id=None,guide_hash=None,consent_hash=None)
        self.spec['configuration_sha256']=hashlib.sha256(self.spec['configuration_json'].encode()).hexdigest()
        self.ref['policy_sha256']=self.spec['configuration_sha256']
        self.host.public_navigation_inventory=lambda:dict(v=1,vm_uuid=supervisors.s.VM_UUID,protected_hosts=['controller.example'],protected_addresses=['10.185.17.1','10.185.17.179'])
        self.host.selected_managed_policy_hash=lambda:hashlib.sha256(supervisors.s.runner.live_policy_bytes()).hexdigest()
        self.supervisor.turn_credentials=lambda _:[]  # Fixture only; production reads protected TURN prerequisites.
        self.host.marker_missing=True

    def test_public_readiness_launch_and_active_status_do_not_require_acceptance_or_idle_guest_check(self):
        self.public();params={k:self.spec[k] for k in ('configuration_json','configuration_sha256')}
        status=self.runtime.status(params);self.assertTrue(status['available']);self.assertEqual(status['capabilities']['protected_inventory'],'verified')
        self.runtime.launch(self.spec)
        self.host.full_boundary=Mock(side_effect=AssertionError('Idle check during execution'))
        self.host.selected_managed_policy_hash=Mock(side_effect=AssertionError('Guest check during execution'))
        status=self.runtime.status(params);self.assertFalse(status['available']);self.assertEqual(status['code'],'ACTIVE_ATTEMPT')
        self.host.full_boundary.assert_not_called();self.host.selected_managed_policy_hash.assert_not_called()
        for method in ('selected_browser_takeover','selected_browser_stage','selected_browser_control','selected_browser_auth'):
            self.assertCode('PUBLIC_OPTIONAL_CAPABILITY_UNAVAILABLE',self.runtime.dispatch,method,self.ref)
        receipt=self.runtime.stop(dict(self.ref,fence=2,reason='cancelled'));self.assertTrue(all(receipt['closed'].values()))

    def test_public_policy_and_inventory_fail_before_dns_or_spawn(self):
        self.public();params={k:self.spec[k] for k in ('configuration_json','configuration_sha256')}
        self.host.selected_managed_policy_hash=lambda:'0'*64
        status=self.runtime.status(params);self.assertFalse(status['available']);self.assertEqual(status['code'],'BROWSER_CHROMIUM_POLICY_UNVERIFIED')
        self.assertEqual(self.host.spawns,0);self.assertEqual(self.host.trace,[])
