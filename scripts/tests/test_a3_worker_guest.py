import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOURCE = Path(__file__).resolve().parents[1] / 'a3-worker-guest.py'
spec = importlib.util.spec_from_file_location('worker_guest', SOURCE)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
ATTEMPT = '6f1c1d52-9f5e-4c0b-8a55-2b0f3e1c9a10'
SPKI = base64.b64encode(b'\0' * 32).decode()
LOCAL_CHROMIUM = os.environ.get('A3_TEST_CHROMIUM', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome')


class PolicyTests(unittest.TestCase):
    def test_request_policy_matches_the_broker_and_proxy(self):
        allowed = [('https://demo.fractionate.ai/', 'GET'), ('https://demo.fractionate.ai/workspace', 'GET'),
                   ('https://demo.fractionate.ai/api/session', 'GET'),
                   ('https://demo.fractionate.ai/assets/index-4f2a.js', 'GET'),
                   ('https://demo.fractionate.ai/api/logout', 'POST')]
        refused = [('https://demo.fractionate.ai/api/login', 'POST'), ('https://example.com/', 'GET'),
                   ('http://demo.fractionate.ai/', 'GET'), ('https://demo.fractionate.ai:8443/', 'GET'),
                   ('https://user@demo.fractionate.ai/', 'GET'), ('https://demo.fractionate.ai/?q=1', 'GET'),
                   ('https://demo.fractionate.ai/?', 'GET'), ('https://demo.fractionate.ai/%2e%2e/', 'GET'),
                   ('https://demo.fractionate.ai/api/files/sample-metrics/download', 'GET'),
                   ('https://demo.fractionate.ai/assets/../x', 'GET'), ('https://1.1.1.1/', 'GET'),
                   ('wss://demo.fractionate.ai/socket', 'GET'), ('https://demo.fractionate.ai/', 'PUT'),
                   ('https://demo.fractionate.ai/api/logout', 'GET'), (None, 'GET')]
        for url, method in allowed:
            self.assertTrue(g.permits(url, method), url)
        for url, method in refused:
            self.assertFalse(g.permits(url, method), url)

    def test_config_is_closed_and_fixed(self):
        good = {'attempt_id': ATTEMPT, 'workload': 'browser', 'spki': SPKI}
        self.assertEqual(g.validate_config(good), good)
        for bad in ({**good, 'url': 'https://example.com'}, {**good, 'workload': 'shell'},
                    {**good, 'attempt_id': 'x'}, {**good, 'spki': 'x'}, None, []):
            with self.assertRaises(g.Refused):
                g.validate_config(bad)

    def test_human_input_is_typed_and_bounded(self):
        for good in ({'kind': 'click', 'x': 1, 'y': 2}, {'kind': 'key', 'key': 'Escape'},
                     {'kind': 'text', 'text': 'demo@fractionate.ai'},
                     {'kind': 'scroll', 'x': 10, 'y': 10, 'dy': -300}):
            g.validate_input(good)
        for bad in ({'kind': 'click', 'x': 5000, 'y': 1}, {'kind': 'click', 'x': True, 'y': 1},
                    {'kind': 'key', 'key': 'F12'}, {'kind': 'text', 'text': 'a\nb'},
                    {'kind': 'text', 'text': 'x' * 257}, {'kind': 'eval', 'script': '1'},
                    {'kind': 'click', 'x': 1, 'y': 1, 'selector': 'button'}):
            with self.assertRaises(g.Refused):
                g.validate_input(bad)

    def test_launch_failure_fixture_reports_before_ready(self):
        lines = []

        class Sink:
            def write(self, text):
                lines.append(text)

            def flush(self):
                pass
        code = g.serve({'attempt_id': ATTEMPT, 'workload': 'proof:fail', 'spki': SPKI}, g.Channel(Sink()), iter(()))
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(lines[0])['event'], 'failed')

    def test_no_sandbox_bypass_or_debug_port_in_browser_argv(self):
        text = SOURCE.read_text()
        self.assertNotIn("'--no-sandbox'", text)
        self.assertNotIn('--remote-debugging-port', text)
        self.assertIn("'--remote-debugging-pipe'", text)
        self.assertNotIn('--disable-dev-shm-usage', text)


# Like the deployed demo SPA: a loading screen until its own reads return,
# then the Sign in button. The first target run failed on exactly this delay.
PAGE = b'''<!doctype html><html><body><div id="app">Preparing your workspace</div>
<script>
setTimeout(() => {
  document.getElementById('app').innerHTML = '<button id="s">Sign in</button>' +
    '<div id="dlg" role="dialog" aria-labelledby="t" style="display:none"><h2 id="t">Sign in to your workspace</h2></div>' +
    '<img src="https://outside.invalid/tracker.png">';
  document.getElementById('s').onclick = () => { document.getElementById('dlg').style.display = 'block'; };
}, 700);
document.addEventListener('keydown', e => {
  const dialog = document.getElementById('dlg');
  if (e.key === 'Escape' && dialog) dialog.style.display = 'none';
});
</script></body></html>'''


class Origin(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):
        pass

    def _send(self, status, body, kind, extra=()):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        for key, value in extra:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        Origin.seen.append(('GET', self.path, self.headers.get('Host')))
        if self.path == '/api/session':
            return self._send(200, b'{"authenticated":false,"email":null}', 'application/json')
        if self.path == '/api/files':
            return self._send(401, b'{"error":"Sign in"}', 'application/json')
        if self.path == '/workspace' and getattr(self.server, 'redirect', False):
            return self._send(302, b'', 'text/plain', [('Location', 'https://outside.invalid/escape')])
        return self._send(200, PAGE, 'text/html')

    def do_POST(self):  # noqa: N802
        Origin.seen.append(('POST', self.path, self.headers.get('Host')))
        return self._send(403, b'', 'text/plain')


def relay(left, right):
    try:
        while True:
            data = left.recv(65536)
            if not data:
                break
            right.sendall(data)
    except OSError:
        pass
    finally:
        for s in (left, right):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class Proxy(threading.Thread):
    """Local stand-in for the host origin proxy: only CONNECT to the demo."""

    def __init__(self, upstream):
        super().__init__(daemon=True)
        self.upstream = upstream
        self.refused = []
        self.server = socket.socket()
        self.server.bind(('127.0.0.1', 0))
        self.server.listen(32)
        self.port = self.server.getsockname()[1]

    def run(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(client,), daemon=True).start()

    def handle(self, client):
        data = b''
        while b'\r\n\r\n' not in data and len(data) < 8192:
            part = client.recv(4096)
            if not part:
                client.close()
                return
            data += part
        line = data.split(b'\r\n', 1)[0].decode('ascii', 'replace')
        if line != 'CONNECT demo.fractionate.ai:443 HTTP/1.1':
            self.refused.append(line)
            client.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
            client.close()
            return
        upstream = socket.create_connection(('127.0.0.1', self.upstream))
        client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        worker = threading.Thread(target=relay, args=(client, upstream), daemon=True)
        worker.start()
        relay(upstream, client)
        worker.join(5)
        client.close()
        upstream.close()


@unittest.skipUnless(Path(LOCAL_CHROMIUM).exists() and shutil.which('openssl'),
                     'local Chromium and openssl are required for the pipe-driven browser test')
class LocalBrowserTests(unittest.TestCase):
    """Real Chromium over the private pipe against a local pinned origin."""

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
        cls.origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))
        cls.origin.socket = context.wrap_socket(cls.origin.socket, server_side=True)
        threading.Thread(target=cls.origin.serve_forever, daemon=True).start()
        cls.proxy = Proxy(cls.origin.server_address[1])
        cls.proxy.start()
        wrapper = root / 'chromium'
        # Root in this sandbox cannot use Chromium's namespace sandbox; the
        # production runner never passes --no-sandbox (tested above).
        wrapper.write_text('#!/bin/sh\nexec %s --no-sandbox "$@"\n' % LOCAL_CHROMIUM)
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

    def start(self):
        commands, replies = queue.Queue(), queue.Queue()

        class Sink:
            def __init__(self):
                self.buffer = ''

            def write(self, text):
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
        ready = replies.get(timeout=60)
        self.assertEqual(ready.get('event'), 'ready', ready)
        counter = iter(range(1, 1000))

        def send(op, **fields):
            ident = next(counter)
            commands.put({'id': ident, 'op': op, **fields})
            while True:
                reply = replies.get(timeout=90)
                if reply.get('id') == ident:
                    return reply
        return ready, send, commands, thread, result

    def test_typed_actions_human_view_and_origin_refusals(self):
        Origin.seen.clear()
        self.origin.redirect = False
        ready, send, commands, thread, result = self.start()
        try:
            self.assertTrue(ready['browser_pid'] > 0)
            self.assertEqual(send('action', action='open_landing'), {'id': 1, 'ok': True, 'result': {'at': 'landing'}})
            view = send('view')
            png = base64.b64decode(view['result']['png_base64'])
            self.assertTrue(png.startswith(b'\x89PNG'))
            point = send('locate', target='sign_in_button')['result']
            self.assertEqual(send('observe')['result']['untrusted_dialog_open'], False)
            self.assertTrue(send('input', input={'kind': 'click', 'x': point['x'], 'y': point['y']})['ok'])
            self.assertEqual(send('observe')['result']['untrusted_dialog_open'], True)
            self.assertTrue(send('input', input={'kind': 'key', 'key': 'Escape'})['ok'])
            self.assertEqual(send('observe')['result']['untrusted_dialog_open'], False)
            self.assertEqual(send('action', action='open_login')['result'], {'at': 'login_dialog'})
            self.assertEqual(send('action', action='read_session')['result'],
                             {'untrusted_page_claim_authenticated': False})
            self.assertEqual(send('action', action='read_files')['error'], 'BROWSER_READBACK_FAILED')
            # A4: the binding ID is required on the channel, and a page without the
            # typed login form refuses before any credential channel is opened.
            self.assertEqual(send('action', action='submit_bound_fixture')['error'], 'INVALID_COMMAND')
            self.assertEqual(send('action', action='submit_bound_fixture', binding_id=ATTEMPT)['error'],
                             'LOGIN_FORM_MISSING')
            self.assertFalse((self.workspace / g.CREDENTIAL_FIFO).exists())
            self.assertEqual(send('action', action='shell')['error'], 'INVALID_BROWSER_ACTION')
            self.assertEqual(send('input', input={'kind': 'eval'})['error'], 'INVALID_INPUT')
            self.assertEqual(send('action', action='open_landing', url='https://x')['error'], 'INVALID_COMMAND')
            probe = send('egress_probe')['result']
            self.assertEqual(set(probe['page_attempts'].values()), {'refused'}, probe)
            self.assertNotIn('reached', probe['navigation_attempts'].values(), probe)
            self.assertEqual({k: v for k, v in probe['navigation_attempts'].items() if k != 'plain_http'},
                             {'cross_origin': 'refused', 'raw_ip': 'refused', 'alternate_port': 'refused'})
            refused_hosts = {row.get('host') for row in probe['browser_layer_refusals']}
            self.assertTrue({'example.com', '1.1.1.1', 'outside.invalid'} <= refused_hosts, refused_hosts)
            self.assertEqual(send('observe')['result']['untrusted_page_url'], 'https://demo.fractionate.ai/')
            self.assertEqual(send('action', action='read_workspace')['result'], {'at': 'workspace'})
            self.origin.redirect = True
            self.assertEqual(send('action', action='read_workspace')['error'], 'BROWSER_NAVIGATION_FAILED')
            # Nothing but the approved origin reached the local origin server.
            self.assertTrue(all(host == 'demo.fractionate.ai' for _, _, host in Origin.seen), Origin.seen)
            self.assertNotIn(('POST', '/api/login', 'demo.fractionate.ai'), Origin.seen)
            self.assertEqual(send('stop')['result'], {'stopping': True})
        finally:
            commands.put(None)
            thread.join(30)
        self.assertEqual(result.get('code'), 0)
        self.assertFalse(Path('/proc', str(ready['browser_pid'])).exists())


if __name__ == '__main__':
    unittest.main()
