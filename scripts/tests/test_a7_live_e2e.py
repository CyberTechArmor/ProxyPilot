"""A7 live view end to end on one machine, with the real pieces.

The runner's own LiveDesktop (real Xvfb, the Neko server built from the pinned
source with ProxyPilot's Unix-socket patch, real Chromium in kiosk mode), a
small bridge that speaks the supervisor's live stream protocol on a Unix socket
(the real supervisor's LiveStream is covered by test_a7_host.py), coturn with
the configuration a7-install-live.py renders, and two viewers, relay candidates
only: the A7 host probe (cmd/a7-live-probe, pion WebRTC like Neko itself; UDP
TURN only, see its package comment) and the dashboard's own client
(live-client.js, live-input.js) in real Chromium behind the real live WebSocket
route (a7_live_browser_e2e.mjs). It proves locally what the host proof repeats
on the proof VM: the video arrives through the TURN relay over UDP, and in the
browser over TCP and TLS too; a wrong credential gets nothing; and input over
Neko's data channel reaches the X display only after the viewer was given
control, counted by kind.

Needs A7_TEST_NEKO (the built Neko), A7_TEST_PROBE (the built probe), Xvfb,
xinput, Chromium, turnserver and a non-loopback IPv4 address; skipped otherwise.
"""
import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


live_tests = load('a7_e2e_live_tests', HERE / 'test_a7_live.py')
g, helpers = live_tests.g, live_tests.helpers
installer = load('a7_e2e_installer', ROOT / 'a7-install-live.py')
PROBE = os.environ.get('A7_TEST_PROBE', '')
TURN_NAME = 'turn.a7.test'


def local_ipv4():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(('10.255.255.255', 1))
            address = s.getsockname()[0]
        except OSError:
            return None
    return None if address.startswith('127.') else address


def record(name, value):
    # A7_E2E_REPORT names a directory for the measured numbers (the evidence).
    folder = os.environ.get('A7_E2E_REPORT')
    if folder:
        Path(folder).mkdir(parents=True, exist_ok=True)
        (Path(folder) / ('%s.json' % name)).write_text(json.dumps(value, indent=1, sort_keys=True) + '\n')


def ready():
    return (live_tests.tools_present() and os.path.isfile(PROBE) and shutil.which('turnserver')
            and shutil.which('openssl') and local_ipv4())


class Router:
    """The runner's channel: live events go to the viewer they name."""

    def __init__(self):
        self.queues = {}

    def emit(self, value):
        q = self.queues.get(value.get('conn'))
        if q is not None:
            q.put(value)


class Bridge:
    """The supervisor's live protocol, for one LiveDesktop: `live` streams,
    `takeover` gives control, `release` takes it back with the input counts."""

    def __init__(self, path, live, router, secret, urls):
        self.path, self.live, self.router, self.secret, self.urls = path, live, router, secret, urls
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(path)
        self.server.listen(8)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()

    def credential(self, viewer):
        username = '%d:%s' % (int(time.time()) + 3600, viewer)
        return username, base64.b64encode(hmac.new(self.secret, username.encode(), hashlib.sha1).digest()).decode()

    def handle(self, sock):
        rfile, wfile = sock.makefile('rb'), sock.makefile('wb')
        write_lock = threading.Lock()

        def write(value):
            with write_lock:
                wfile.write((json.dumps(value) + '\n').encode())
                wfile.flush()
        try:
            request = json.loads(rfile.readline())
            method, params = request['method'], request.get('params', {})
            if method == 'takeover':
                write({'ok': True, 'result': dict(self.live.give(params['conn']), state='human')})
                return
            if method == 'release':
                write({'ok': True, 'result': self.live.release()})
                return
            viewer = secrets.token_hex(8)
            q = queue.Queue()
            self.router.queues[viewer] = q
            self.live.open(viewer)
            username, credential = self.credential(viewer)
            write({'ok': True, 'result': {'conn': viewer, 'ttl_seconds': 3600,
                                          'ice_servers': [{'urls': self.urls, 'username': username, 'credential': credential}]}})

            def pump():
                # A viewer that has gone (the relay check closes at once) ends it.
                try:
                    while True:
                        item = q.get()
                        if item.get('event') == 'live':
                            write({'recv': item['data']})
                        elif item.get('event') == 'live_closed':
                            write({'closed': item.get('reason', 'closed')})
                            return
                except OSError:
                    return
            threading.Thread(target=pump, daemon=True).start()
            for raw in rfile:
                message = json.loads(raw)
                if message.get('close'):
                    break
                self.live.send(viewer, message.get('send'))
            self.live.close_conn(viewer)
        except (OSError, ValueError, g.Refused):
            pass
        finally:
            sock.close()

    def call(self, method, params):
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(self.path)
            s.sendall((json.dumps({'method': method, 'params': params}) + '\n').encode())
            return json.loads(s.makefile().readline())

    def close(self):
        self.server.close()


@unittest.skipUnless(ready(), 'needs A7_TEST_NEKO, A7_TEST_PROBE, Xvfb, xinput, Chromium, turnserver and a LAN IPv4')
class LiveEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='pp-a7-e2e-'))
        cls.address = local_ipv4()
        # The relay, exactly as rendered by the installer, pointed at this machine.
        cert, key = cls.root / 'turn-cert.pem', cls.root / 'turn-key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
                        '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=' + TURN_NAME,
                        '-addext', 'subjectAltName=DNS:' + TURN_NAME], check=True, capture_output=True)
        cls.secret = secrets.token_hex(32).encode()
        saved = {k: getattr(installer, k) for k in ('GATEWAY_IPV4', 'GUEST_IPV4', 'TURN_CERT', 'TURN_KEY')}
        installer.GATEWAY_IPV4 = installer.GUEST_IPV4 = cls.address
        installer.TURN_CERT, installer.TURN_KEY = cert, key
        try:
            config = installer.render_turn(TURN_NAME, cls.address, cls.secret.decode())
        finally:
            for k, v in saved.items():
                setattr(installer, k, v)
        config = config.replace('/run/proxypilot-a7-turn/', str(cls.root) + '/').replace('log-file=syslog', 'log-file=stdout')
        (cls.root / 'turnserver.conf').write_text(config)
        cls.turn_log = open(cls.root / 'turn.log', 'wb')
        cls.turn = subprocess.Popen(['turnserver', '-c', str(cls.root / 'turnserver.conf')], stdout=cls.turn_log,
                                    stderr=subprocess.STDOUT)
        # The live desktop, as the runner starts it in the worker unit.
        workspace = cls.root / 'workspace'
        workspace.mkdir(mode=0o700)
        policy = cls.root / 'policy.json'
        policy.write_bytes(g.live_policy_bytes())
        wrapper = cls.root / 'chromium'
        wrapper.write_text('#!/bin/sh\nexec %s --no-sandbox "$@"\n' % helpers.LOCAL_CHROMIUM)
        wrapper.chmod(0o755)
        cls.saved = {k: getattr(g, k) for k in ('WORKSPACE', 'NEKO_BINARY', 'LIVE_POLICY_PATH', 'LIVE_DISPLAY', 'CHROMIUM',
                                                 'PROXY', 'XVFB', 'XINPUT')}
        g.WORKSPACE, g.NEKO_BINARY, g.LIVE_POLICY_PATH = str(workspace), live_tests.NEKO, str(policy)
        g.LIVE_DISPLAY, g.CHROMIUM, g.PROXY = ':95', str(wrapper), '127.0.0.1:9'
        g.XVFB, g.XINPUT = shutil.which('Xvfb'), shutil.which('xinput')
        cls.router = Router()
        cls.live = g.LiveDesktop(cls.router).start()
        cls.browser = g.Browser(live_tests.SPKI, live_tests.Sink(), cls.live)
        cls.bridge = Bridge(str(cls.root / 'backend.sock'), cls.live, cls.router, cls.secret,
                            installer.turn_urls(TURN_NAME))
        time.sleep(1)

    @classmethod
    def tearDownClass(cls):
        cls.bridge.close()
        cls.browser.close()
        cls.live.close()
        for k, v in cls.saved.items():
            setattr(g, k, v)
        cls.turn.terminate()
        cls.turn.wait(10)
        cls.turn_log.close()
        shutil.rmtree(cls.root, ignore_errors=True)

    def probe(self, *args, stdin=None, env=None):
        argv = [PROBE, '-socket', str(self.root / 'backend.sock'), '-turn-address', self.address,
                '-run', '00000000-0000-4000-8000-000000000001', '-attempt', '00000000-0000-4000-8000-000000000002', *args]
        return subprocess.Popen(argv, stdin=subprocess.PIPE if stdin else subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env={**os.environ, **(env or {})})

    def lines(self, process, timeout=60):
        out, err = process.communicate(timeout=timeout)
        events = [json.loads(line) for line in out.splitlines() if line.strip()]
        return events, err

    def report(self, events):
        found = [e for e in events if e.get('event') == 'report']
        self.assertEqual(len(found), 1, events)
        return found[0]

    def assert_streamed(self, transport, env=None):
        events, err = self.lines(self.probe('-transport', transport, '-seconds', '6', env=env))
        report = self.report(events)
        self.assertTrue(report['connected'], (events, err[-2000:]))
        self.assertEqual(report['pair']['local'], 'relay', report)
        self.assertEqual(report['pair']['remote_port'], g.LIVE_UDP_PORT, report)
        self.assertGreaterEqual(report['fps'], 10, report)
        self.assertTrue(any(e.get('event') == 'track' and e.get('codec') == 'video/VP8' for e in events), events)
        opened = [e for e in events if e.get('event') == 'opened'][0]
        self.assertTrue(opened['username_expiry_and_viewer'])
        self.assertNotIn(self.secret.decode(), json.dumps(events) + err)
        record('probe_' + transport, report)
        return report

    def test_video_through_the_relay_over_udp(self):
        self.assert_streamed('udp')

    def test_the_relay_reaches_only_the_vm(self):
        peers = ['%s:%d' % (self.address, g.LIVE_UDP_PORT), '127.0.0.1:%d' % g.LIVE_UDP_PORT, '8.8.8.8:53', '10.185.17.1:22']
        events, _ = self.lines(self.probe('-relay-check', ','.join(peers)))
        check = [e for e in events if e.get('event') == 'relay_check'][0]
        record('relay_check', check)
        self.assertTrue(check['allocated'], check)
        self.assertEqual(check['peers'][peers[0]], 'permitted', check)
        for peer in peers[1:]:
            self.assertIn('403', check['peers'][peer], (peer, check))

    def test_the_tcp_and_tls_listeners_allocate_with_the_same_scope(self):
        # What the host proof checks on 3478/TCP and 5349/TLS: the viewer's
        # credential allocates, the certificate verifies for the TURN name, and
        # the relay still reaches only the VM's Neko port.
        peers = ['%s:%d' % (self.address, g.LIVE_UDP_PORT), '8.8.8.8:53']
        for transport in ('tcp', 'tls'):
            events, err = self.lines(self.probe('-relay-check', ','.join(peers), '-relay-transport', transport,
                                                '-tls-ca', str(self.root / 'turn-cert.pem')))
            check = [e for e in events if e.get('event') == 'relay_check'][0]
            record('relay_check_' + transport, check)
            self.assertEqual(check['transport'], transport, check)
            self.assertTrue(check['allocated'], (check, err[-1000:]))
            self.assertEqual(check['peers'][peers[0]], 'permitted', check)
            self.assertIn('403', check['peers'][peers[1]], check)
            if transport == 'tls':
                self.assertEqual(check['tls']['verified_name'], TURN_NAME, check)
            else:
                self.assertIsNone(check['tls'], check)
        # Without the CA the certificate is not trusted, and nothing is allocated.
        events, _ = self.lines(self.probe('-relay-check', peers[0], '-relay-transport', 'tls'))
        check = [e for e in events if e.get('event') == 'relay_check'][0]
        self.assertEqual((check['allocated'], check['code']), (False, 'TLS_UNVERIFIED'), check)

    def test_the_probe_refuses_tcp_and_tls(self):
        events, _ = self.lines(self.probe('-transport', 'tcp', '-seconds', '2'))
        self.assertEqual(events[-1].get('code'), 'TRANSPORT_UNSUPPORTED', events)

    @unittest.skipUnless(shutil.which('node') and os.path.exists(os.environ.get('BROWSER_EXE', '/opt/pw-browsers/chromium')),
                         'needs node and Chromium')
    def test_the_dashboard_client_in_chromium_over_udp_tcp_and_tls(self):
        result = subprocess.run(['node', str(HERE / 'a7_live_browser_e2e.mjs'), '--bridge', str(self.root / 'backend.sock'),
                                 '--turn-address', self.address], capture_output=True, text=True, timeout=240)
        self.assertEqual(result.returncode, 0, result.stderr[-3000:])
        out = json.loads(result.stdout.strip().splitlines()[-1])
        record('browser', out)
        for name in ('udp', 'tcp', 'tls'):
            entry = out['transports'][name]
            self.assertTrue(entry['live'], (name, entry))
            self.assertEqual(entry['policy'], 'relay', entry)
            self.assertEqual(len(entry['urls']), 1, entry)
            self.assertEqual(entry['pair']['local'], 'relay', (name, entry))
            self.assertEqual(entry['pair']['relay_protocol'], name, (name, entry))
            self.assertEqual(entry['pair']['remote_port'], g.LIVE_UDP_PORT, (name, entry))
            self.assertGreaterEqual(entry['fps'], 10, (name, entry))
            self.assertEqual(entry['errors'], [], entry)
        found = out['input']
        self.assertEqual(found['before'], {'key': 0, 'click': 0, 'scroll': 0}, found)
        self.assertTrue(found['control_seen'], found)
        self.assertEqual((found['after']['key'], found['after']['click']), (4, 1), found)
        self.assertGreaterEqual(found['after']['scroll'], 2, found)

    def test_a_wrong_credential_gets_nothing(self):
        events, _ = self.lines(self.probe('-transport', 'udp', '-seconds', '6', '-bad-credential'))
        report = self.report(events)
        self.assertFalse(report['connected'], report)

    def test_input_reaches_the_browser_only_after_control_is_given(self):
        process = self.probe('-transport', 'udp', '-seconds', '8', '-control', '-keys', '5', stdin=True)
        events = []

        def read_until(name):
            for raw in process.stdout:
                event = json.loads(raw)
                events.append(event)
                if event.get('event') in (name, 'error', 'report'):
                    return event
            return None
        opened = read_until('opened')
        self.assertEqual(opened['event'], 'opened', events)
        ready_event = read_until('ready_for_control')
        self.assertEqual(ready_event['event'], 'ready_for_control', (events, process.stderr.read()[-2000:] if process.poll() is not None else ''))
        time.sleep(1)
        # The input sent before control never reached X.
        self.assertEqual(self.live.counter.take(), {'key': 0, 'click': 0, 'scroll': 0})
        given = self.bridge.call('takeover', {'conn': opened['conn']})
        # The runner reports what reached X before control was given: nothing.
        self.assertEqual(given['result'], {'controlling': True, 'state': 'human',
                                           'uncontrolled_inputs': {'key': 0, 'click': 0, 'scroll': 0}})
        process.stdin.write('control\n')
        process.stdin.flush()
        sent = read_until('input_sent')
        self.assertEqual(sent['event'], 'input_sent', events)
        time.sleep(1)
        released = self.bridge.call('release', {})['result']
        self.assertEqual(released['inputs']['key'], 5, released)
        self.assertEqual(released['inputs']['click'], 1, released)
        self.assertGreaterEqual(released['inputs']['scroll'], 2, released)
        report = read_until('report')
        process.wait(30)
        self.assertTrue(report['connected'], report)
        self.assertEqual(report['input_sent'], {'key': 5, 'click': 1, 'scroll': 2})


if __name__ == '__main__':
    unittest.main()
