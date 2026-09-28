"""A4 bound-credential submission in the guest runner, against real Chromium.

The value reaches the runner only through the one-shot FIFO on its workspace
(standing in for the host broker's guest writer), never through the JSON
channel, and the channel carries the binding ID and outcome only.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('a4_worker_guest', ROOT / 'a3-worker-guest.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
helpers_spec = importlib.util.spec_from_file_location('a4_guest_helpers', ROOT / 'tests' / 'test_a3_worker_guest.py')
helpers = importlib.util.module_from_spec(helpers_spec)
helpers_spec.loader.exec_module(helpers)

ATTEMPT = '6f1c1d52-9f5e-4c0b-8a55-2b0f3e1c9a10'
BINDING = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
USERNAME = 'a4-fixture@demo.fractionate.ai'


def frame(username, password):
    user, secret = username.encode(), password.encode()
    return g.FRAME_MAGIC + len(user).to_bytes(2, 'big') + user + len(secret).to_bytes(2, 'big') + secret


def deliver(path, data, seconds=10):
    """What the broker's guest writer does, minus the /proc and cgroup checks."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        except (FileNotFoundError, OSError):
            time.sleep(0.05)
            continue
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        return True
    return False


class FrameTests(unittest.TestCase):
    def test_frame_is_exact_and_printable(self):
        user, secret = g.parse_frame(frame(USERNAME, 'Correct horse 7!'))
        self.assertEqual((bytes(user), bytes(secret)), (USERNAME.encode(), b'Correct horse 7!'))
        good = frame(USERNAME, 'x')
        for bad in (b'', b'PPA4', good + b'!', good[:-1], b'XXXX' + good[4:], frame(USERNAME, 'a\nb'),
                    frame('', 'x'), frame(USERNAME, 'x' * 257), frame(USERNAME, 'café')):
            with self.assertRaises(g.Refused) as caught:
                g.parse_frame(bytearray(bad))
            self.assertEqual(caught.exception.code, 'CREDENTIAL_FRAME_INVALID')

    def test_fifo_is_one_shot_private_and_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = os.path.join(temp, g.CREDENTIAL_FIFO)
            writer = threading.Thread(target=deliver, args=(path, frame(USERNAME, 'pw-1')))
            writer.start()
            user, secret = g.receive_credential(path, seconds=5)
            writer.join()
            self.assertEqual(bytes(secret), b'pw-1')
            self.assertFalse(os.path.exists(path))
            with self.assertRaises(g.Refused) as caught:
                g.receive_credential(path, seconds=0.3)
            self.assertEqual(caught.exception.code, 'CREDENTIAL_NOT_DELIVERED')
            self.assertFalse(os.path.exists(path))
            os.mkfifo(path, 0o600)
            with self.assertRaises(g.Refused) as caught:
                g.receive_credential(path, seconds=0.3)
            self.assertEqual(caught.exception.code, 'CREDENTIAL_CHANNEL_BUSY')

    def test_login_is_never_in_the_standing_policy(self):
        self.assertFalse(g.permits('https://demo.fractionate.ai/api/login', 'POST'))
        self.assertTrue(g.permits('https://demo.fractionate.ai/api/logout', 'POST'))


# A login page shaped like the demo's: a dialog named by its title, one
# username field, one password field and one submit button in one form.
PAGE = b'''<!doctype html><html><body>
<button id="s">Sign in</button>
<div id="dlg" role="dialog" aria-labelledby="t" style="display:none"><h2 id="t">Sign in to your workspace</h2>
<form id="f"><input id="em" type="email" autocomplete="username"><input id="pw" type="password"
 autocomplete="current-password"><button type="submit">Sign in</button></form></div>
<div id="ws" style="display:none">Workspace <button id="out">Sign out</button></div>
<script>
const $ = id => document.getElementById(id);
$('s').onclick = () => { $('dlg').style.display = 'block'; };
$('f').onsubmit = async e => {
  e.preventDefault();
  const r = await fetch('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email: $('em').value, password: $('pw').value})});
  if (r.ok) { $('dlg').style.display = 'none'; $('ws').style.display = 'block'; }
};
window.rogue = () => fetch('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
  body: '{"email":"x","password":"y"}'}).then(() => 'reached', () => 'refused');
</script></body></html>'''


class LoginOrigin(BaseHTTPRequestHandler):
    password = None
    sessions = set()
    logins = []

    def log_message(self, *args):
        pass

    def _send(self, status, body, kind='application/json', extra=()):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        for key, value in extra:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _session(self):
        cookie = self.headers.get('Cookie') or ''
        return next((part.split('=', 1)[1] for part in cookie.split('; ') if part.startswith('sid=')), None)

    def do_GET(self):  # noqa: N802
        if self.path == '/api/session':
            signed_in = self._session() in LoginOrigin.sessions
            body = {'authenticated': signed_in, 'email': USERNAME if signed_in else None}
            return self._send(200, json.dumps(body).encode())
        return self._send(200, PAGE, 'text/html')

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if self.path == '/api/logout':
            LoginOrigin.sessions.discard(self._session())
            LoginOrigin.logins.append('logout')
            return self._send(200, b'{"authenticated":false}', extra=[('Set-Cookie', 'sid=; Max-Age=0')])
        if self.path == '/api/login':
            try:
                data = json.loads(body)
            except ValueError:
                data = {}
            ok = data.get('email') == USERNAME and data.get('password') == LoginOrigin.password
            # Records the outcome only, never the submitted value.
            LoginOrigin.logins.append('accepted' if ok else 'rejected')
            if not ok:
                return self._send(401, b'{"error":"no"}')
            sid = secrets.token_hex(8)
            LoginOrigin.sessions.add(sid)
            return self._send(200, b'{"authenticated":true}', extra=[('Set-Cookie', 'sid=%s; Path=/' % sid)])
        return self._send(404, b'{}')


@unittest.skipUnless(Path(helpers.LOCAL_CHROMIUM).exists() and shutil.which('openssl'),
                     'local Chromium and openssl are required for the credential submission test')
class CredentialBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        key, cert = root / 'key.pem', root / 'cert.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=demo.fractionate.ai', '-addext', 'subjectAltName=DNS:demo.fractionate.ai',
                        '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
        pub = subprocess.run(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'],
                             check=True, capture_output=True).stdout
        der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=pub,
                             check=True, capture_output=True).stdout
        cls.spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
        cls.origin = ThreadingHTTPServer(('127.0.0.1', 0), LoginOrigin)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))
        cls.origin.socket = context.wrap_socket(cls.origin.socket, server_side=True)
        threading.Thread(target=cls.origin.serve_forever, daemon=True).start()
        cls.proxy = helpers.Proxy(cls.origin.server_address[1])
        cls.proxy.start()
        wrapper = root / 'chromium'
        wrapper.write_text('#!/bin/sh\nexec %s --no-sandbox "$@"\n' % helpers.LOCAL_CHROMIUM)
        wrapper.chmod(0o755)
        cls.saved = (g.PROXY, g.CHROMIUM, g.WORKSPACE)
        cls.workspace = root / 'workspace'
        cls.workspace.mkdir()
        g.PROXY, g.CHROMIUM, g.WORKSPACE = '127.0.0.1:%d' % cls.proxy.port, str(wrapper), str(cls.workspace)

    @classmethod
    def tearDownClass(cls):
        g.PROXY, g.CHROMIUM, g.WORKSPACE = cls.saved
        cls.origin.shutdown()
        cls.proxy.server.close()
        cls.temp.cleanup()

    def setUp(self):
        LoginOrigin.password = 'A4-canary-' + secrets.token_urlsafe(18)
        LoginOrigin.sessions.clear()
        LoginOrigin.logins.clear()
        self.fifo = str(self.workspace / g.CREDENTIAL_FIFO)

    def serve(self):
        commands, replies, lines = queue.Queue(), queue.Queue(), []

        class Sink:
            def __init__(self):
                self.buffer = ''

            def write(self, text):
                lines.append(text)
                self.buffer += text
                while '\n' in self.buffer:
                    line, self.buffer = self.buffer.split('\n', 1)
                    replies.put(json.loads(line))

            def flush(self):
                pass

        def stream():
            while True:
                item = commands.get()
                if item is None:
                    return
                yield json.dumps(item) + '\n'
        result = {}
        config = {'attempt_id': ATTEMPT, 'workload': 'browser', 'spki': self.spki}
        thread = threading.Thread(target=lambda: result.setdefault('code', g.serve(config, g.Channel(Sink()), stream())),
                                  daemon=True)
        thread.start()
        self.assertEqual(replies.get(timeout=60).get('event'), 'ready')
        counter = iter(range(1, 1000))

        def send(op, **fields):
            ident = next(counter)
            commands.put({'id': ident, 'op': op, **fields})
            while True:
                reply = replies.get(timeout=90)
                if reply.get('id') == ident:
                    return reply
        return send, commands, thread, result, lines

    def test_bound_value_signs_in_through_the_fifo_only_and_logout_runs_at_stop(self):
        send, commands, thread, result, lines = self.serve()
        writer = None
        try:
            self.assertTrue(send('action', action='open_landing')['ok'])
            self.assertEqual(send('action', action='open_login')['result'], {'at': 'login_dialog'})
            # The page itself cannot post a sign-in: the gate is closed until armed.
            self.assertEqual(send('action', action='read_session')['result'],
                             {'untrusted_page_claim_authenticated': False})
            writer = threading.Thread(target=deliver, args=(self.fifo, frame(USERNAME, LoginOrigin.password)))
            writer.start()
            reply = send('action', action='submit_bound_fixture', binding_id=BINDING)
            self.assertTrue(reply['ok'], reply)
            self.assertEqual(reply['result'], {'binding_id': BINDING, 'outcome': 'signed_in', 'login_requests': 1,
                                               'untrusted_page_claim_authenticated_as_bound_account': True})
            self.assertEqual(LoginOrigin.logins, ['accepted'])
            self.assertFalse(os.path.exists(self.fifo))
            self.assertEqual(send('action', action='read_session')['result'],
                             {'untrusted_page_claim_authenticated': False})
            stopped = send('stop')
            self.assertEqual(stopped['result'], {'stopping': True, 'logout': 'done'})
            self.assertEqual(LoginOrigin.logins, ['accepted', 'logout'])
            self.assertEqual(LoginOrigin.sessions, set())
        finally:
            if writer:
                writer.join(5)
            commands.put(None)
            thread.join(30)
        self.assertEqual(result.get('code'), 0)
        channel = ''.join(lines)
        # The command/response channel never carried the value, in any encoding.
        for form in (LoginOrigin.password, json.dumps(LoginOrigin.password)[1:-1],
                     base64.b64encode(LoginOrigin.password.encode()).decode()):
            self.assertNotIn(form, channel)
        self.assertIn(BINDING, channel)

    def test_rejected_value_is_cleared_and_unarmed_posts_are_refused(self):
        channel = g.Channel(open(os.devnull, 'w'))
        browser = g.Browser(self.spki, channel)
        try:
            browser.action('open_landing')
            browser.action('open_login')
            self.assertEqual(browser.main_world('window.rogue()', 20), 'refused')
            writer = threading.Thread(target=deliver, args=(self.fifo, frame(USERNAME, 'wrong-value-123')))
            writer.start()
            result = browser.action('submit_bound_fixture', BINDING)
            writer.join(5)
            self.assertEqual(result['outcome'], 'rejected')
            self.assertEqual(LoginOrigin.logins, ['rejected'])
            # The rejected value does not stay in the form, and no field value is ever returned.
            self.assertEqual(browser.isolated("document.getElementById('pw').value"), '')
            self.assertEqual(browser.isolated("document.getElementById('em').value"), '')
            self.assertEqual(browser.main_world('window.rogue()', 20), 'refused')
            with patch.object(g, 'DELIVERY_SECONDS', 1):
                with self.assertRaises(g.Refused) as caught:
                    browser.submit_bound_fixture(BINDING)
            self.assertEqual(caught.exception.code, 'CREDENTIAL_NOT_DELIVERED')
            self.assertEqual(LoginOrigin.logins, ['rejected'])
            self.assertEqual(browser.login_armed, 0)
            with self.assertRaises(g.Refused) as caught:
                browser.action('submit_bound_fixture', 'not-a-uuid')
            self.assertEqual(caught.exception.code, 'INVALID_COMMAND')
            browser.action('open_landing')
            with self.assertRaises(g.Refused) as caught:
                browser.action('submit_bound_fixture', BINDING)
            self.assertEqual(caught.exception.code, 'LOGIN_FORM_MISSING')
        finally:
            browser.close()



proxy_spec = importlib.util.spec_from_file_location('a4_submit_origin_proxy', ROOT / 'a3-origin-proxy.py')
origin_proxy = importlib.util.module_from_spec(proxy_spec)
proxy_spec.loader.exec_module(origin_proxy)


@unittest.skipUnless(Path(helpers.LOCAL_CHROMIUM).exists() and shutil.which('openssl'),
                     'local Chromium and openssl are required for the real-proxy test')
class RealProxyBrowserTests(unittest.TestCase):
    """Chromium -> the REAL origin-proxy policy (TLS terminated, SPKI pinned) -> a local origin.

    Proves the runner's own sign-in and logout requests pass the exact A4
    proxy policy (JSON body with Content-Length; empty logout), not only a relay.
    """

    @classmethod
    def setUpClass(cls):
        import http.client
        import socket
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        certs = {}
        for name in ('origin', 'proxy'):
            key, cert = root / (name + '.key'), root / (name + '.pem')
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                            '-subj', '/CN=demo.fractionate.ai', '-addext', 'subjectAltName=DNS:demo.fractionate.ai',
                            '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
            certs[name] = (cert, key)
        pub = subprocess.run(['openssl', 'x509', '-in', str(certs['proxy'][0]), '-pubkey', '-noout'],
                             check=True, capture_output=True).stdout
        der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=pub,
                             check=True, capture_output=True).stdout
        cls.spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
        cls.origin = ThreadingHTTPServer(('127.0.0.1', 0), LoginOrigin)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(certs['origin'][0]), str(certs['origin'][1]))
        cls.origin.socket = context.wrap_socket(cls.origin.socket, server_side=True)
        threading.Thread(target=cls.origin.serve_forever, daemon=True).start()
        port = cls.origin.server_address[1]
        trusted = ssl.create_default_context(cafile=str(certs['origin'][0]))

        class LocalConnection(http.client.HTTPSConnection):
            def __init__(self, address):
                super().__init__(origin_proxy.ORIGIN, 443, timeout=8, context=trusted)

            def connect(self):
                self.sock = self._context.wrap_socket(socket.create_connection(('127.0.0.1', port), timeout=8),
                                                      server_hostname=origin_proxy.ORIGIN)
        cls.patches = [patch.object(origin_proxy, 'PEER', '127.0.0.1'),
                       patch.object(origin_proxy, 'FixedConnection', LocalConnection),
                       patch.object(origin_proxy, 'public_addresses', lambda: [(socket.AF_INET, '127.0.0.1')])]
        for item in cls.patches:
            item.start()
        cls.proxy = origin_proxy.Server(('127.0.0.1', 0), origin_proxy.Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.set_alpn_protocols(['http/1.1'])
        tls.load_cert_chain(str(certs['proxy'][0]), str(certs['proxy'][1]))
        cls.proxy.tls = tls
        threading.Thread(target=cls.proxy.serve_forever, daemon=True).start()
        wrapper = root / 'chromium'
        wrapper.write_text('#!/bin/sh\nexec %s --no-sandbox "$@"\n' % helpers.LOCAL_CHROMIUM)
        wrapper.chmod(0o755)
        cls.saved = (g.PROXY, g.CHROMIUM, g.WORKSPACE)
        cls.workspace = root / 'workspace'
        cls.workspace.mkdir()
        g.PROXY = '127.0.0.1:%d' % cls.proxy.server_address[1]
        g.CHROMIUM, g.WORKSPACE = str(wrapper), str(cls.workspace)

    @classmethod
    def tearDownClass(cls):
        g.PROXY, g.CHROMIUM, g.WORKSPACE = cls.saved
        cls.proxy.shutdown()
        cls.proxy.server_close()
        cls.origin.shutdown()
        for item in cls.patches:
            item.stop()
        cls.temp.cleanup()

    def test_sign_in_and_logout_pass_the_exact_proxy_policy(self):
        LoginOrigin.password = 'A4-canary-' + secrets.token_urlsafe(18)
        LoginOrigin.sessions.clear()
        LoginOrigin.logins.clear()
        channel = g.Channel(open(os.devnull, 'w'))
        browser = g.Browser(self.spki, channel)
        try:
            browser.action('open_landing')
            browser.action('open_login')
            fifo = str(self.workspace / g.CREDENTIAL_FIFO)
            writer = threading.Thread(target=deliver, args=(fifo, frame(USERNAME, LoginOrigin.password)))
            writer.start()
            result = browser.action('submit_bound_fixture', BINDING)
            writer.join(5)
            self.assertEqual(result['outcome'], 'signed_in', result)
            self.assertEqual(browser.logout(), 'done')
            self.assertEqual(LoginOrigin.logins, ['accepted', 'logout'])
            self.assertEqual(LoginOrigin.sessions, set())
        finally:
            browser.close()


if __name__ == '__main__':
    unittest.main()
