"""Local-only gateway proofs; these are not Incus/nft installation evidence."""
import copy
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import selected_browser_policy as p
import selected_browser_gateway as g

FIXTURE = json.loads((SCRIPTS.parent / 'contracts/browser-agent/fixtures/general-agent.draft.json').read_text())
RUN = '91e4d8f7-4f49-45f0-8b3d-74be5c840eed'
ATTEMPT = '748321ef-346a-45b5-90e5-5d211946ef07'
PROJECT = '591ab1ad-80ce-4278-b69c-f123356fcde7'
APPROVAL = 'c9c617cf-7a3b-48f1-9f93-eafaf3b16574'
NOW = 1800000000


def configuration(origin='https://site.example', session='this_origin_session'):
    c = copy.deepcopy(FIXTURE)
    c['destinations']['allowed_origins'] = [dict(id='site', origin=origin,
        roles=['navigation', 'resource'], session_headers=session)]
    c['destinations']['entry_urls'] = [origin + '/']
    c['destinations']['request_rules'] = [dict(id='read', destination_id='site', path_prefix='/',
        methods=['GET', 'HEAD'], query_keys=['q'], resource_types=list(p.RESOURCE_TYPES),
        effect='read', max_request_bytes=0), dict(id='change', destination_id='site', path_prefix='/save',
        methods=['POST'], query_keys=[], resource_types=['fetch', 'xhr'],
        effect='external_change', max_request_bytes=1024)]
    return c


def plan(c, address='1.1.1.1', scope='public', expires_at=NOW + 1000):
    return dict(schema='proxypilot.selected-browser.network-plan.v1', expires_at=expires_at,
        targets=[dict(origin=d['origin'], scope=scope, addresses=[address],
                      port=p.url_parts(d['origin'])['port'], route_sha256='b' * 64, reviewed=True)
                 for d in c['destinations']['allowed_origins']],
        protected_hosts=['controller.example', 'secure.example'], protected_addresses=['10.185.17.1', '10.185.17.179'])


def identity(c):
    return dict(project_id=PROJECT, run_id=RUN, attempt_id=ATTEMPT, fence=1, policy_sha256=p.digest(p.canonical(c)))


def policy(c=None, network=None, clock=lambda: NOW):
    c = c or configuration()
    return p.GatewayPolicy(c, network or plan(c), identity(c), clock=clock)


def metadata(pol, path='/', method='GET', body=b'', resource_type='document', role='navigation', action=None):
    return dict(url=next(iter(pol.origins)) + path, method=method, body_sha256=p.digest(body), body_bytes=len(body),
                resource_type=resource_type, role=role, run_id=RUN, attempt_id=ATTEMPT, fence=1,
                policy_sha256=pol.identity['policy_sha256'], current_action=action)


def effect_grant(gateway, reply, approval=APPROVAL, expires_at=None):
    return dict(schema='proxypilot.selected-browser.effect-grant.v1', id=approval, identity=gateway.policy.identity,
                request_ref=reply['request_ref'], binding_sha256=reply['binding_sha256'],
                expires_at=expires_at if expires_at is not None else int(gateway.clock() + 30), purpose_sha256='d' * 64)


class PolicyTests(unittest.TestCase):
    def assertDenied(self, code, fn, *args):
        with self.assertRaises(p.Denied) as e:
            fn(*args)
        self.assertEqual(e.exception.code, code)

    def test_canonical_url_origin_path_and_fragment(self):
        self.assertEqual(p.url_parts('https://site.example/search?q=a%20b#tab')['target'], '/search?q=a%20b')
        self.assertEqual(p.url_parts('http://portal:8080/a')['origin'], 'http://portal:8080')
        self.assertEqual(p.url_parts('https://[fd00::4]:8443/a')['host'], 'fd00::4')
        for url in ('HTTPS://site.example/', 'https://SITE.example/', 'https://site.example.:443/',
                    'https://site.example:443/', 'https://user:secret@site.example/', 'https://@site.example/',
                    'https://%73ite.example/', 'https://site.example\\evil/', 'https://127.1/',
                    'https://2130706433/', 'https://0177.0.0.1/', 'https://0x7f000001/',
                    'https://site.example:0/', 'https://site.example:65536/', 'https://site.example/%zz',
                    'file:///tmp/x', 'https://site.example/é'):
            with self.subTest(url=url), self.assertRaises(p.Denied):
                p.url_parts(url)
        for path in ('/../secret', '/%2e%2e/secret', '/x%2fy', '/x%5cy', '/x%252fy', '/%00x', '//elsewhere'):
            with self.subTest(path=path), self.assertRaises(p.Denied):
                p.url_parts('https://site.example' + path)

    def test_policy_hash_exact_bytes_and_defensive_copy(self):
        c = configuration()
        pol = policy(c)
        c['destinations']['allowed_origins'][0]['origin'] = 'https://attacker.example'
        exposed = pol.configuration
        exposed['destinations']['allowed_origins'].clear()
        self.assertEqual(set(pol.origins), {'https://site.example'})
        self.assertEqual(len(pol.configuration['destinations']['allowed_origins']), 1)
        changed = configuration()
        changed['name'] = 'another'
        with self.assertRaises(p.Denied):
            p.GatewayPolicy(changed, plan(changed), pol.identity)
        # The server's exact bytes are verified without Python/JS number coercion.
        text = p.canonical(configuration()).replace('"max_usd":1', '"max_usd":1.0')
        ident = identity(configuration())
        ident['policy_sha256'] = p.digest(text)
        self.assertEqual(p.GatewayPolicy(configuration(), plan(configuration()), ident, text,
                                        clock=lambda: NOW).identity['policy_sha256'], p.digest(text))

    def test_url_reference_and_boolean_do_not_grant_network(self):
        c = configuration()
        c['destinations']['network_policy_ref'] = dict(id=APPROVAL, sha256='f' * 64, revision=1)
        self.assertDenied('NETWORK_TARGET_MISMATCH', p.GatewayPolicy, c,
                          dict(plan(c), targets=[]), identity(c), None, lambda: NOW)
        bad = plan(c)
        bad['targets'][0]['reviewed'] = False
        self.assertDenied('NETWORK_TARGET_UNVERIFIED', p.GatewayPolicy, c, bad, identity(c), None, lambda: NOW)
        bad = plan(c)
        bad['targets'][0]['addresses'] = ['10.9.0.4/32']
        with self.assertRaises(p.Denied):
            policy(c, bad)

    def test_exact_internal_name_port_and_ipv6_are_supported_only_by_plan(self):
        for origin, address in (('https://portal:8443', '10.9.0.4'), ('https://[fd00::4]:8443', 'fd00::4')):
            c = configuration(origin)
            pol = policy(c, plan(c, address, 'internal'))
            self.assertEqual(pol.screen_answers(p.url_parts(origin + '/'), [address]), [address])
            other = '10.9.0.5' if ':' not in address else 'fd00::5'
            self.assertDenied('DNS_ADDRESS_CHANGED', pol.screen_answers, p.url_parts(origin + '/'), [other])
        c = configuration('http://portal:8080', 'omit')
        self.assertEqual(policy(c, plan(c, '10.9.0.4', 'internal')).origins['http://portal:8080']['session_headers'], 'omit')

    def test_protected_infrastructure_never_granted(self):
        for origin in ('https://metadata.google.internal', 'https://vault.example', 'https://openbao.example',
                       'https://controller.example', 'https://sub.secure.example', 'https://127.0.0.1',
                       'https://[::1]', 'https://169.254.169.254', 'https://10.185.17.1'):
            with self.subTest(origin=origin), self.assertRaises(p.Denied):
                c = configuration(origin)
                policy(c, plan(c, '10.9.0.4', 'internal'))
        pol = policy()
        for path in ('/v1/sys/health', '/%76%31/sys/health', '/api/setup/start', '/api/mcp'):
            self.assertDenied('PROTECTED_DESTINATION', pol.protected_url, p.url_parts('https://site.example' + path))
        for address in ('127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1',
                        '::ffff:10.9.0.4', '2002:a09:4::1', '64:ff9b::a09:4'):
            with self.subTest(address=address), self.assertRaises(p.Denied):
                p.address_scope(address)

    def test_every_dns_answer_must_match_scope_and_exact_pins(self):
        pol = policy()
        for values in ([], ['1.1.1.1', '10.9.0.4'], ['1.1.1.1', '8.8.8.8'], ['10.185.17.1']):
            with self.subTest(values=values), self.assertRaises(p.Denied):
                pol.screen_answers(p.url_parts('https://site.example/'), values)

    def test_public_plan_helper_does_not_require_operator_enrollment(self):
        public = p.build_public_target('https://site.example', ['1.1.1.1', '1.1.1.1'], 'b' * 64,
                                      ['controller.example'], ['10.185.17.1'])
        self.assertEqual(public['addresses'], ['1.1.1.1'])
        self.assertEqual(public['scope'], 'public')
        for values in (['1.1.1.1', '10.9.0.4'], ['127.0.0.1'], ['10.9.0.4'], []):
            with self.subTest(values=values), self.assertRaises(p.Denied):
                p.build_public_target('https://site.example', values, 'b' * 64,
                                      ['controller.example'], ['10.185.17.1'])
        with self.assertRaises(p.Denied):
            p.build_public_target('https://controller.example', ['1.1.1.1'], 'b' * 64,
                                  ['controller.example'], ['10.185.17.1'])

    def test_roles_session_rules_overlap_query_and_methods(self):
        c = configuration()
        c['destinations']['allowed_origins'].append(dict(id='asset', origin='https://assets.example',
            roles=['resource'], session_headers='omit'))
        pol = policy(c)
        self.assertDenied('DESTINATION_ROLE_DENIED', pol.destination, p.url_parts('https://assets.example/'), 'navigation')
        dest = pol.destination(p.url_parts('https://site.example/a'), 'navigation')
        self.assertEqual(pol.classify(p.url_parts('https://site.example/?q=a'), dest, 'GET', 'document', 0), 'read')
        self.assertEqual(pol.classify(p.url_parts('https://site.example/?secret=a'), dest, 'GET', 'document', 0), 'unclassified')
        c['destinations']['request_rules'].append(dict(c['destinations']['request_rules'][0],
            id='get-may-write', path_prefix='/change', effect='external_change'))
        pol = policy(c)
        self.assertEqual(pol.classify(p.url_parts('https://site.example/change'), dest, 'GET', 'document', 0), 'external_change')
        c['destinations']['request_rules'][0]['methods'] = ['POST']
        with self.assertRaises(p.Denied):
            policy(c)
        for origin, roles, session in (('http://site.example', ['navigation'], 'this_origin_session'),
                                      ('http://site.example', ['authentication'], 'omit'),
                                      ('https://site.example', ['resource'], 'this_origin_session')):
            c = configuration(origin, session)
            c['destinations']['allowed_origins'][0]['roles'] = roles
            with self.subTest(origin=origin, roles=roles), self.assertRaises(p.Denied):
                policy(c)


class GatewayTests(unittest.TestCase):
    def assertDenied(self, code, fn, *args):
        with self.assertRaises(p.Denied) as e:
            fn(*args)
        self.assertEqual(e.exception.code, code)

    def make(self, c=None, resolve=None, factory=None, clock=lambda: NOW):
        pol = policy(c, clock=clock)
        return g.AttemptGateway(pol, g.MemoryLedger(), resolver=resolve or Mock(return_value=['1.1.1.1']),
                                connection_factory=factory or Mock(), clock=clock, route_reader=lambda _: 'b' * 64)

    def test_offlist_connect_and_requests_stop_before_dns_and_contact(self):
        gate = self.make()
        self.assertEqual(gate.check_connect('site.example:443')['origin'], 'https://site.example')
        self.assertDenied('OFF_LIST_DESTINATION', gate.check_connect, 'other.example:443')
        self.assertEqual(gate.state, 'paused')
        gate.resolver.assert_not_called()
        gate.connection_factory.assert_not_called()
        gate = self.make()
        meta = metadata(gate.policy)
        meta['url'] = 'https://other.example/?secret=hidden'
        self.assertDenied('OFF_LIST_DESTINATION', gate.review_request, 'request1', meta)
        self.assertNotIn('hidden', p.canonical(gate.ledger.rows))
        self.assertNotIn('other.example', p.canonical(gate.ledger.rows))
        gate.resolver.assert_not_called()
        gate.connection_factory.assert_not_called()

    def test_request_without_one_shot_ticket_or_wire_hash_never_resolves(self):
        gate = self.make()
        self.assertDenied('REQUEST_TICKET_REQUIRED', gate.forward, 'GET', 'https://site.example/', {}, b'')
        gate.resolver.assert_not_called()
        gate = self.make()
        reply = gate.review_request('read', metadata(gate.policy))
        self.assertDenied('REQUEST_WIRE_MISMATCH', gate.forward, 'POST', 'https://site.example/',
                          {g.TICKET_HEADER: reply['ticket']}, b'')
        gate.resolver.assert_not_called()

    def test_autosave_unknown_get_and_write_need_exact_durable_approval(self):
        for meta in (dict(path='/save', method='POST', body=b'secret', resource_type='fetch', role='resource'),
                     dict(path='/?secret=hidden')):
            gate = self.make()
            reply = gate.review_request('autosave', metadata(gate.policy, **meta))
            self.assertEqual(reply['decision'], 'approval_required')
            self.assertEqual(gate.state, 'paused')
            gate.resolver.assert_not_called()
            wrong = effect_grant(gate, reply)
            wrong['binding_sha256'] = 'e' * 64
            self.assertDenied('EFFECT_GRANT_INVALID', gate.approve_request, 'autosave', wrong)
            allowed = gate.approve_request('autosave', effect_grant(gate, reply))
            self.assertEqual(allowed['decision'], 'allow')
            self.assertIn(APPROVAL, gate.ledger._approvals)
            self.assertDenied('REQUEST_APPROVAL_STALE', gate.approve_request, 'autosave', effect_grant(gate, reply))
            self.assertNotIn('hidden', p.canonical(gate.ledger.rows))
            self.assertNotIn('secret', p.canonical(gate.ledger.rows))

    def test_approval_can_wait_for_human_then_ticket_expires_quickly(self):
        now = [NOW]
        gate = self.make(clock=lambda: now[0])
        reply = gate.review_request('save', metadata(gate.policy, '/save', 'POST', b'x', 'fetch', 'resource'))
        now[0] += 60
        allowed = gate.approve_request('save', effect_grant(gate, reply))
        now[0] += 16
        self.assertDenied('REQUEST_TICKET_STALE', gate.admit, 'POST', 'https://site.example/save',
                          {g.TICKET_HEADER: allowed['ticket']}, b'x')

    def test_old_attempt_fence_action_and_resource_headers_cannot_grant(self):
        for field, value in (('attempt_id', APPROVAL), ('fence', 2), ('policy_sha256', 'a' * 64)):
            gate = self.make()
            meta = metadata(gate.policy)
            meta[field] = value
            self.assertDenied('REQUEST_IDENTITY_MISMATCH', gate.review_request, 'x', meta)
        gate = self.make()
        meta = metadata(gate.policy)
        meta['current_action'] = dict(ordinal=1, candidate_ref=dict(id=APPROVAL, sha256='b' * 64),
                                      snapshot_ref=dict(id=APPROVAL, sha256='c' * 64), approval_ref=None, approval=True)
        self.assertDenied('REQUEST_ACTION_INVALID', gate.review_request, 'x', meta)

    def test_pause_revoke_budget_and_ledger_failures_fail_closed(self):
        gate = self.make()
        reply = gate.review_request('x', metadata(gate.policy))
        gate.pause()
        self.assertDenied('GATEWAY_PAUSED', gate.admit, 'GET', 'https://site.example/',
                          {g.TICKET_HEADER: reply['ticket']}, b'')
        gate.resume()
        self.assertDenied('REQUEST_TICKET_STALE', gate.admit, 'GET', 'https://site.example/',
                          {g.TICKET_HEADER: reply['ticket']}, b'')
        gate.revoke()
        self.assertDenied('GATEWAY_REVOKED', gate.review_request, 'new', metadata(gate.policy))
        gate = self.make()
        reply = gate.review_request('write', metadata(gate.policy, '/save', 'POST', b'x', 'fetch', 'resource'))
        gate.ledger._write = Mock(side_effect=OSError('disk full'))
        self.assertDenied('LEDGER_WRITE_FAILED', gate.approve_request, 'write', effect_grant(gate, reply))
        self.assertEqual(gate.state, 'revoked')
        gate.resolver.assert_not_called()

    def test_temporary_grant_exact_purpose_attempt_no_permanent_mutation(self):
        gate = self.make()
        original = gate.policy.configuration_json
        destination = dict(id='temporary', origin='https://other.example', roles=['navigation'], session_headers='this_origin_session')
        target = dict(origin=destination['origin'], scope='public', addresses=['8.8.8.8'], port=443,
                      route_sha256='b' * 64, reviewed=True)
        grant = dict(schema='proxypilot.selected-browser.destination-grant.v1', id=APPROVAL,
                     identity=gate.policy.identity, origin=destination['origin'], roles=destination['roles'],
                     purpose_sha256='c' * 64, expires_at=NOW + 120, persist_to_allowlist=False, wildcards=False)
        for key, value in (('persist_to_allowlist', True), ('wildcards', True), ('identity', dict(gate.policy.identity, fence=2))):
            self.assertDenied('DESTINATION_GRANT_INVALID', gate.grant_destination, dict(grant, **{key: value}), destination, target)
        gate.grant_destination(grant, destination, target)
        self.assertEqual(gate.policy.configuration_json, original)
        self.assertEqual(set(gate.policy.origins), {'https://site.example'})
        self.assertEqual(gate.check_connect('other.example:443')['origin'], 'https://other.example')
        meta = metadata(gate.policy)
        meta['url'] = destination['origin'] + '/'
        self.assertEqual(gate.review_request('temp', meta)['decision'], 'approval_required')
        self.assertEqual(gate.ledger.rows[-1]['kind'], 'escalation')

    def test_dns_rebinding_has_zero_socket_contacts(self):
        gate = self.make(resolve=Mock(return_value=['1.1.1.1', '10.9.0.4']))
        reply = gate.review_request('read', metadata(gate.policy))
        with self.assertRaises(p.Denied):
            gate.forward('GET', 'https://site.example/', {g.TICKET_HEADER: reply['ticket']}, b'')
        gate.connection_factory.assert_not_called()
        self.assertEqual(gate.state, 'paused')

    def test_route_changed_after_authorized_launch_has_zero_socket_contacts(self):
        gate = self.make()
        gate.route_reader = Mock(return_value='c' * 64)
        ticket = gate.review_request('read',metadata(gate.policy))['ticket']
        self.assertDenied('NETWORK_ROUTE_CHANGED',gate.forward,'GET','https://site.example/',{g.TICKET_HEADER:ticket},b'')
        gate.connection_factory.assert_not_called()
        self.assertEqual(gate.status()['effects_sent'],0)

    def test_preconnect_freeze_still_surfaces_exact_offlist_event_without_dns(self):
        gate = self.make()
        self.assertDenied('OFF_LIST_DESTINATION',gate.check_connect,'other.example:443')
        meta = dict(metadata(gate.policy),url='https://other.example/')
        self.assertDenied('OFF_LIST_DESTINATION',gate.review_request,'fresh',meta)
        gate.resolver.assert_not_called()
        gate.connection_factory.assert_not_called()

    def test_cancel_while_dns_pending_cannot_open_socket_after_lookup_returns(self):
        entered,release=threading.Event(),threading.Event()
        def resolver(_):
            entered.set();release.wait(2);return ['1.1.1.1']
        gate=self.make(resolve=resolver);ticket=gate.review_request('read',metadata(gate.policy))['ticket'];errors=[]
        def forward():
            try:gate.forward('GET','https://site.example/',{g.TICKET_HEADER:ticket},b'')
            except p.Denied as e:errors.append(e.code)
        thread=threading.Thread(target=forward);thread.start();self.assertTrue(entered.wait(1))
        gate.revoke();release.set();thread.join(2)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,['GATEWAY_REVOKED'])
        gate.connection_factory.assert_not_called();self.assertEqual(gate.status()['effects_sent'],0)

    def test_auth_role_grant_is_exact_temporary_and_leaves_base_resource_policy(self):
        gate = self.make()
        original = gate.policy.configuration_json
        destination = dict(id='temporary-auth',origin='https://site.example',roles=['authentication'],session_headers='this_origin_session')
        grant = dict(schema='proxypilot.selected-browser.destination-grant.v1',id=APPROVAL,identity=gate.policy.identity,
                     origin=destination['origin'],roles=destination['roles'],purpose_sha256='c'*64,
                     expires_at=NOW+120,persist_to_allowlist=False,wildcards=False)
        gate.grant_destination(grant,destination,gate.policy.targets[destination['origin']])
        auth = metadata(gate.policy,role='authentication')
        self.assertEqual(gate.review_request('auth',auth)['decision'],'approval_required')
        self.assertEqual(gate.policy.configuration_json,original)
        self.assertEqual(gate.policy.destination(p.url_parts('https://site.example/'),'resource',gate.additions)['id'],'site')
        wrong = dict(destination,roles=['authentication','resource'])
        self.assertDenied('DESTINATION_GRANT_INVALID',gate.grant_destination,dict(grant,roles=wrong['roles']),wrong,gate.policy.targets[destination['origin']])


class LocalTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='pp-selected-gateway-local-')
        cls.directory = Path(cls.tmp.name)
        cls.cert, cls.key = cls.directory / 'cert.pem', cls.directory / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=site.example', '-addext', 'subjectAltName=DNS:site.example',
                        '-keyout', str(cls.key), '-out', str(cls.cert)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.received = []
        received = self.received
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def respond(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                received.append((self.command, self.path, dict(self.headers), body))
                if self.path == '/lost':
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.send_response(302 if self.path == '/redirect' else 200)
                if self.path == '/redirect':
                    self.send_header('Location', 'https://outside.example/private?secret=hidden')
                self.send_header('Content-Type', 'text/plain')
                self.send_header('Set-Cookie', 'private-session=secret')
                self.send_header('Alt-Svc', 'h3=":443"')
                self.end_headers()
                self.wfile.write(b'fixture response')
            do_GET = respond
            do_POST = respond
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(str(self.cert), str(self.key))
        self.server.socket = self.tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        fixture_port, cafile = self.server.server_address[1], str(self.cert)
        self.connected = []
        connected = self.connected
        class LocalPinned(g.PinnedConnection):
            def connect(inner):
                # TEST ONLY mapping: policy screens 1.1.1.1; fixture transport
                # targets an ephemeral local server and retains hostname checks.
                connected.append((inner.address, inner.parts['host'], inner.parts['port']))
                sock = socket.create_connection(('127.0.0.1', fixture_port), timeout=inner.timeout)
                context = ssl.create_default_context(cafile=cafile)
                try:
                    inner.sock = context.wrap_socket(sock, server_hostname=inner.parts['host'])
                except Exception:
                    sock.close()
                    raise
        self.factory = LocalPinned

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def gate(self, c=None):
        return g.AttemptGateway(policy(c), g.MemoryLedger(), resolver=lambda _: ['1.1.1.1'],
                                connection_factory=self.factory, clock=lambda: NOW, route_reader=lambda _: 'b' * 64)

    def test_real_tls_upstream_verifies_host_pinned_ip_and_strips_private_resource_headers(self):
        c = configuration()
        c['destinations']['allowed_origins'][0]['session_headers'] = 'omit'
        gate = self.gate(c)
        reply = gate.review_request('read', metadata(gate.policy))
        status, headers, body = gate.forward('GET', 'https://site.example/',
            {g.TICKET_HEADER: reply['ticket'], 'cookie': 'secret', 'authorization': 'Bearer secret',
             'x-custom-session': 'secret', 'referer': 'https://private.example/?secret=x',
             'accept': 'text/plain', 'origin': 'https://private.example'}, b'')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'fixture response')
        self.assertEqual(self.connected, [('1.1.1.1', 'site.example', 443)])
        actual = {k.lower(): v for k, v in self.received[0][2].items()}
        for key in ('cookie', 'authorization', 'x-custom-session', 'referer', 'origin', g.TICKET_HEADER):
            self.assertNotIn(key, actual)
        self.assertEqual(actual['accept'], 'text/plain')
        self.assertFalse(any(k.lower() in ('set-cookie', 'alt-svc') for k, _ in headers))
        self.assertNotIn('secret', p.canonical(gate.ledger.rows))
        with self.assertRaises(p.Denied):
            gate.forward('GET', 'https://site.example/', {g.TICKET_HEADER: reply['ticket']}, b'')
        self.assertEqual(len(self.received), 1)

    def test_wrong_upstream_tls_hostname_has_zero_http_effects(self):
        gate = self.gate(configuration('https://other.example'))
        reply = gate.review_request('read', metadata(gate.policy))
        with self.assertRaises(p.Denied):
            gate.forward('GET', 'https://other.example/', {g.TICKET_HEADER: reply['ticket']}, b'')
        self.assertEqual(self.received, [])
        self.assertEqual(len(self.connected), 1)

    def test_effect_timeout_is_uncertain_consumed_once_never_retried(self):
        gate = self.gate()
        reply = gate.review_request('write', metadata(gate.policy, '/lost', 'POST', b'private', 'fetch', 'resource'))
        allowed = gate.approve_request('write', effect_grant(gate, reply))
        with self.assertRaises(p.Denied):
            gate.forward('POST', 'https://site.example/lost', {g.TICKET_HEADER: allowed['ticket']}, b'private')
        self.assertEqual(len(self.received), 1)
        self.assertEqual(len(self.connected), 1)
        self.assertEqual(self.received[0][3], b'private')
        self.assertEqual(gate.ledger.rows[-1]['kind'], 'request_uncertain')
        self.assertFalse(gate.ledger.rows[-1]['data']['replay_allowed'])
        self.assertIn(APPROVAL, gate.ledger._approvals)

    def test_offlist_redirect_blocked_without_second_target_dns_or_contact(self):
        gate = self.gate()
        reply = gate.review_request('read', metadata(gate.policy, '/redirect'))
        with self.assertRaises(p.Denied):
            gate.forward('GET', 'https://site.example/redirect', {g.TICKET_HEADER: reply['ticket']}, b'')
        self.assertEqual(len(self.received), 1)
        self.assertEqual(len(self.connected), 1)
        self.assertEqual(gate.state, 'paused')
        self.assertNotIn('hidden', p.canonical(gate.ledger.rows))

    def test_connect_mitm_socket_has_real_policy_and_wire_body_check(self):
        gate = self.gate()
        reply = gate.review_request('read', metadata(gate.policy))
        host, client = socket.socketpair()
        thread = threading.Thread(target=g.serve_selected_socket, args=(host, gate, self.tls), daemon=True)
        thread.start()
        client.sendall(b'CONNECT site.example:443 HTTP/1.1\r\nHost: site.example:443\r\n\r\n')
        response = client.recv(1024)
        self.assertIn(b'200 Connection Established', response)
        context = ssl.create_default_context(cafile=str(self.cert))
        with context.wrap_socket(client, server_hostname='site.example') as tls_client:
            tls_client.sendall(('GET / HTTP/1.1\r\nHost: site.example\r\nX-ProxyPilot-Request-Token: ' +
                                reply['ticket'] + '\r\n\r\n').encode())
            response = http.client.HTTPResponse(tls_client)
            response.begin()
            actual_status, actual = response.status, response.read()
        thread.join(timeout=3)
        host.close()
        self.assertEqual(actual_status, 200)
        self.assertIn(b'fixture response', actual)
        self.assertEqual(len(self.received), 1)


    def test_plain_http_proxy_exact_ticket_with_real_local_upstream(self):
        plain=ThreadingHTTPServer(('127.0.0.1',0),self.server.RequestHandlerClass)
        server_thread=threading.Thread(target=plain.serve_forever,daemon=True);server_thread.start()
        fixture_port=plain.server_address[1]
        class LocalPlain(g.PinnedConnection):
            def connect(inner):
                inner.sock=socket.create_connection(('127.0.0.1',fixture_port),timeout=inner.timeout)
        c=configuration(origin='http://site.example',session='omit')
        gate=g.AttemptGateway(policy(c),g.MemoryLedger(),resolver=lambda _:['1.1.1.1'],connection_factory=LocalPlain,
                              clock=lambda:NOW,route_reader=lambda _:'b'*64)
        token=gate.review_request('plain',metadata(gate.policy))['ticket']
        client,proxy=socket.socketpair()
        thread=threading.Thread(target=g.serve_selected_socket,args=(proxy,gate,self.tls));thread.start()
        try:
            client.sendall(('GET http://site.example/ HTTP/1.1\r\nHost: site.example\r\n'+
                            g.TICKET_HEADER+': '+token+'\r\nCookie: private-session=secret\r\n\r\n').encode())
            reply=http.client.HTTPResponse(client);reply.begin()
            self.assertEqual(reply.status,200);self.assertEqual(reply.read(),b'fixture response')
            self.assertNotIn('Cookie',self.received[0][2]);self.assertIsNone(reply.getheader('Set-Cookie'))
            self.assertEqual(gate.status()['requests'],1);self.assertEqual(gate.status()['response_bytes'],16)
            reply.close()
        finally:
            client.close();thread.join(3);proxy.close()
            plain.shutdown();plain.server_close();server_thread.join(3)

    def test_real_upstream_request_and_response_budgets_cannot_reset(self):
        c=configuration();c['budgets']['max_requests']=1
        gate=self.gate(c)
        token=gate.review_request('first',metadata(gate.policy))['ticket']
        gate.forward('GET','https://site.example/',{g.TICKET_HEADER:token},b'')
        gate.pause();gate.resume()
        token=gate.review_request('second',metadata(gate.policy))['ticket']
        with self.assertRaises(p.Denied) as caught:
            gate.forward('GET','https://site.example/',{g.TICKET_HEADER:token},b'')
        self.assertEqual(caught.exception.code,'REQUEST_BUDGET_EXHAUSTED')
        self.assertEqual(len(self.received),1)
        c=configuration();c['budgets']['max_response_bytes']=15;gate=self.gate(c)
        token=gate.review_request('bounded',metadata(gate.policy))['ticket']
        with self.assertRaises(p.Denied) as caught:
            gate.forward('GET','https://site.example/',{g.TICKET_HEADER:token},b'')
        self.assertEqual(caught.exception.code,'RESPONSE_BUDGET_EXHAUSTED')
        self.assertEqual(gate.status()['response_bytes'],16)


class DurableControlTests(unittest.TestCase):
    def test_single_attempt_restart_latch_no_demo_fallback_and_verified_release(self):
        with tempfile.TemporaryDirectory(prefix='pp-selected-control-') as tmp:
            registry = g.SelectedGatewayRegistry(tmp, require_root=False)
            c = configuration()
            params = dict(configuration=c, configuration_json=p.canonical(c), network_plan=plan(c, expires_at=int(time.time()) + 900),
                          identity=identity(c))
            registry.register(params)
            with self.assertRaises(p.Denied):
                registry.register(params)
            recovered = g.SelectedGatewayRegistry(tmp, require_root=False)
            self.assertEqual(recovered.selected(), (True, None))
            with self.assertRaises(p.Denied):
                recovered.register(params)
            with self.assertRaises(p.Denied):
                recovered.release(dict(identity=identity(c), cleanup={'descendants_gone': True}))
            registry.gateway.revoke()
            recovered.release(dict(identity=identity(c), cleanup=dict(descendants_gone=True,
                workspace_gone=True, fence_still_installed=True)))
            self.assertEqual(recovered.selected(), (False, None))
            registry.gateway.ledger.close()

    def test_durable_approval_cannot_be_consumed_after_reopen_or_corrupt_tail(self):
        with tempfile.TemporaryDirectory(prefix='pp-selected-ledger-') as tmp:
            path = Path(tmp) / 'journal'
            ledger = g.FileLedger(path, require_root=False)
            ledger.consume(APPROVAL, 'b' * 64)
            ledger.close()
            ledger = g.FileLedger(path, require_root=False)
            with self.assertRaises(p.Denied):
                ledger.consume(APPROVAL, 'b' * 64)
            self.assertEqual(len(ledger.rows), 1)
            ledger.close()
            with path.open('ab') as stream:
                stream.write(b'{"broken":true}')
            with self.assertRaises(p.Denied):
                g.FileLedger(path, require_root=False)

    def test_control_actual_unix_socket_mode_identity_and_peer_uid(self):
        with tempfile.TemporaryDirectory(prefix='pp-selected-control-') as tmp:
            registry = g.SelectedGatewayRegistry(tmp, require_root=False)
            path = Path(tmp) / 'control.sock'
            server = g.start_control(registry, path, peer_uid=os.getuid())
            try:
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                c = configuration()
                params = dict(configuration=c, configuration_json=p.canonical(c),
                              network_plan=plan(c, expires_at=int(time.time()) + 900), identity=identity(c))
                self.assertEqual(g.control_call(path, 'register', params)['state'], 'running')
                with self.assertRaises(p.Denied):
                    g.control_call(path, 'status', dict(identity=dict(identity(c), fence=2)))
                self.assertEqual(g.control_call(path, 'revoke', dict(identity=identity(c)))['state'], 'revoked')
                self.assertEqual(g.control_call(path, 'release', dict(identity=identity(c),
                    cleanup=dict(descendants_gone=True, workspace_gone=True, fence_still_installed=True)))['released'], True)
                server.peer_uid = os.getuid() + 1
                with self.assertRaises((p.Denied, ConnectionResetError)):
                    g.control_call(path, 'status', dict(identity=identity(c)))
            finally:
                server.shutdown()
                server.server_close()
            # Recover a proven dead private socket; refuse a live listener.
            recovered = g.start_control(registry, path, peer_uid=os.getuid())
            try:
                with self.assertRaises(p.Denied):
                    g.start_control(registry, path, peer_uid=os.getuid())
            finally:
                recovered.shutdown()
                recovered.server_close()

    def test_parser_duplicate_folding_smuggling_and_unsupported_transport(self):
        for raw in (b'GET / HTTP/1.1\r\nHost: x\r\nHost: y\r\n\r\n',
                    b'GET / HTTP/1.1\r\n folded: x\r\n\r\n',
                    b'GET / HTTP/2.0\r\n\r\n',
                    b'GET / HTTP/1.1\r\nX-A: x\x00y\r\n\r\n'):
            with self.subTest(raw=raw), self.assertRaises(p.Denied):
                g.read_request(io.BytesIO(raw))


if __name__ == '__main__':
    unittest.main()
