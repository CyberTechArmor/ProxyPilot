"""The real origin proxy handler, end to end on loopback: one bounded JSON
POST /api/login reaches the origin byte-exact; every other body-bearing
request is refused before the origin is contacted; nothing is logged."""
import contextlib
import http.client
import importlib.util
import io
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('a4_origin_proxy', ROOT / 'a3-origin-proxy.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class Origin(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):
        pass

    def _answer(self, status):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')

    def do_GET(self):  # noqa: N802
        Origin.seen.append(('GET', self.path, b''))
        self._answer(200)

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        Origin.seen.append(('POST', self.path, body, self.headers.get('Content-Type')))
        self._answer(401 if self.path == '/api/login' else 200)


def certificate(root, name):
    key, cert = root / (name + '.key'), root / (name + '.pem')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-subj', '/CN=demo.fractionate.ai', '-addext', 'subjectAltName=DNS:demo.fractionate.ai',
                    '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
    return cert, key


class ProxyLoginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        origin_cert, origin_key = certificate(root, 'origin')
        proxy_cert, proxy_key = certificate(root, 'proxy')
        cls.origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(str(origin_cert), str(origin_key))
        cls.origin.socket = server_context.wrap_socket(cls.origin.socket, server_side=True)
        threading.Thread(target=cls.origin.serve_forever, daemon=True).start()
        port = cls.origin.server_address[1]
        trusted = ssl.create_default_context(cafile=str(origin_cert))

        class LocalConnection(http.client.HTTPSConnection):
            def __init__(self, address):
                super().__init__(p.ORIGIN, 443, timeout=8, context=trusted)

            def connect(self):
                self.sock = self._context.wrap_socket(socket.create_connection(('127.0.0.1', port), timeout=8),
                                                      server_hostname=p.ORIGIN)
        cls.patches = [patch.object(p, 'PEER', '127.0.0.1'), patch.object(p, 'FixedConnection', LocalConnection),
                       patch.object(p, 'public_addresses', lambda: [(socket.AF_INET, '127.0.0.1')])]
        for item in cls.patches:
            item.start()
        cls.proxy = p.Server(('127.0.0.1', 0), p.Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(str(proxy_cert), str(proxy_key))
        cls.proxy.tls = tls
        threading.Thread(target=cls.proxy.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.proxy.shutdown()
        cls.proxy.server_close()
        cls.origin.shutdown()
        for item in cls.patches:
            item.stop()
        cls.temp.cleanup()

    def request(self, raw):
        conn = socket.create_connection(self.proxy.server_address, timeout=10)
        conn.sendall(b'CONNECT demo.fractionate.ai:443 HTTP/1.1\r\nHost: demo.fractionate.ai:443\r\n\r\n')
        data = b''
        while b'\r\n\r\n' not in data:
            data += conn.recv(4096)
        self.assertTrue(data.startswith(b'HTTP/1.1 200 '), data)
        client = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        client.check_hostname = False
        client.verify_mode = ssl.CERT_NONE
        with client.wrap_socket(conn, server_hostname='demo.fractionate.ai') as secured:
            secured.sendall(raw)
            answer = b''
            with contextlib.suppress(OSError):
                while True:
                    part = secured.recv(4096)
                    if not part:
                        break
                    answer += part
        return answer.split(b'\r\n', 1)[0].decode()

    def post(self, target, body, content_type='application/json', length=None, extra=b''):
        head = ('POST %s HTTP/1.1\r\nHost: demo.fractionate.ai\r\nContent-Type: %s\r\nContent-Length: %d\r\n'
                % (target, content_type, len(body) if length is None else length)).encode()
        return self.request(head + extra + b'\r\n' + body)

    def test_one_bounded_json_sign_in_reaches_the_origin_exactly(self):
        Origin.seen.clear()
        body = b'{"email":"a4-fixture@demo.fractionate.ai","password":"A4-canary-value"}'
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stderr):
            self.assertEqual(self.post('/api/login', body), 'HTTP/1.1 401 Unauthorized')
        self.assertEqual(Origin.seen, [('POST', '/api/login', body, 'application/json')])
        self.assertEqual(stderr.getvalue(), '')   # the proxy never prints a request or body
        self.assertEqual(self.post('/api/login', b'{' * 1024), 'HTTP/1.1 401 Unauthorized')
        self.assertEqual(len(Origin.seen[-1][2]), 1024)
        self.assertEqual(self.post('/api/logout', b''), 'HTTP/1.1 200 OK')
        self.assertEqual(Origin.seen[-1][:3], ('POST', '/api/logout', b''))

    def test_every_other_body_or_path_is_refused_before_the_origin(self):
        Origin.seen.clear()
        refused = 'HTTP/1.1 403 Forbidden'
        for target, body, kind, length, extra in (
                ('/api/login', b'{', 'text/plain', None, b''),
                ('/api/login', b'', 'application/json', None, b''),
                ('/api/login', b'{' * 1025, 'application/json', None, b''),
                ('/api/login', b'{', 'application/json', None, b'Transfer-Encoding: chunked\r\n'),
                ('/api/login', b'{', 'application/json', None, b'Expect: 100-continue\r\n'),
                ('/api/login?next=1', b'{', 'application/json', None, b''),
                ('/api/session', b'{', 'application/json', None, b''),
                ('/api/files', b'{', 'application/json', None, b''),
                ('/', b'{', 'application/json', None, b''),
                ('/api/logout', b'{', 'application/json', None, b'')):
            with self.subTest(target=target, kind=kind, length=len(body), extra=extra):
                self.assertEqual(self.post(target, body, kind, length, extra), refused)
        self.assertEqual(self.request(b'PUT /api/login HTTP/1.1\r\nHost: demo.fractionate.ai\r\n'
                                      b'Content-Type: application/json\r\nContent-Length: 1\r\n\r\n{'), refused)
        self.assertEqual(Origin.seen, [])
        # A short body (the client promised more than it sent) is dropped, not forwarded.
        self.assertEqual(self.post('/api/login', b'{', length=10), '')
        self.assertEqual(Origin.seen, [])


class Silent(BaseHTTPRequestHandler):
    """An origin that takes the request and never answers (an upstream timeout)."""
    seen = []

    def log_message(self, *args):
        pass

    def do_POST(self):  # noqa: N802
        Silent.seen.append(('POST', self.path, self.rfile.read(int(self.headers.get('Content-Length') or 0))))
        threading.Event().wait(3)
        self.close_connection = True


class ProxyAtMostOnceTests(unittest.TestCase):
    """A request reaches the origin at most once: only a failed connection moves on
    to the next public address; a request already sent is never sent again."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        origin_cert, origin_key = certificate(root, 'origin')
        proxy_cert, proxy_key = certificate(root, 'proxy')
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(str(origin_cert), str(origin_key))
        cls.origins = []
        for handler in (Origin, Silent):
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            server.socket = server_context.wrap_socket(server.socket, server_side=True)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            cls.origins.append(server)
        closed = socket.socket()
        closed.bind(('127.0.0.1', 0))
        dead = closed.getsockname()[1]
        closed.close()
        ports = {'answering': cls.origins[0].server_address[1], 'silent': cls.origins[1].server_address[1],
                 'dead': dead}
        trusted = ssl.create_default_context(cafile=str(origin_cert))

        class AddressConnection(http.client.HTTPSConnection):
            def __init__(self, address):
                self.address = address
                super().__init__(p.ORIGIN, 443, timeout=1, context=trusted)

            def connect(self):
                self.sock = self._context.wrap_socket(
                    socket.create_connection(('127.0.0.1', ports[self.address]), timeout=self.timeout),
                    server_hostname=p.ORIGIN)
        cls.patches = [patch.object(p, 'PEER', '127.0.0.1'), patch.object(p, 'FixedConnection', AddressConnection)]
        for item in cls.patches:
            item.start()
        cls.proxy = p.Server(('127.0.0.1', 0), p.Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(str(proxy_cert), str(proxy_key))
        cls.proxy.tls = tls
        threading.Thread(target=cls.proxy.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.proxy.shutdown()
        cls.proxy.server_close()
        for server in cls.origins:
            server.shutdown()
        for item in cls.patches:
            item.stop()
        cls.temp.cleanup()

    request = ProxyLoginTests.request
    post = ProxyLoginTests.post

    def test_a_sign_in_that_timed_out_upstream_is_not_sent_again(self):
        Origin.seen.clear()
        Silent.seen.clear()
        body = b'{"email":"a4-fixture@demo.fractionate.ai","password":"A4-canary-value"}'
        with patch.object(p, 'public_addresses', lambda: [(socket.AF_INET, 'silent'), (socket.AF_INET, 'answering')]):
            self.assertEqual(self.post('/api/login', body), 'HTTP/1.1 502 Bad Gateway')
        self.assertEqual(Silent.seen, [('POST', '/api/login', body)])
        self.assertEqual(Origin.seen, [], 'the sign-in was sent again to the next address')

    def test_an_address_that_cannot_connect_still_fails_over_before_anything_is_sent(self):
        Origin.seen.clear()
        body = b'{"email":"a4-fixture@demo.fractionate.ai","password":"A4-canary-value"}'
        with patch.object(p, 'public_addresses', lambda: [(socket.AF_INET, 'dead'), (socket.AF_INET, 'answering')]):
            self.assertEqual(self.post('/api/login', body), 'HTTP/1.1 401 Unauthorized')
        self.assertEqual(Origin.seen, [('POST', '/api/login', body, 'application/json')])
        with patch.object(p, 'public_addresses', lambda: [(socket.AF_INET, 'dead')]), \
                patch.object(p, 'forget_addresses') as forget:
            self.assertEqual(self.post('/api/login', body), 'HTTP/1.1 502 Bad Gateway')
        self.assertEqual(len(Origin.seen), 1)
        forget.assert_called_once_with()   # no cached address connects: look the origin up again


if __name__ == '__main__':
    unittest.main()
