#!/usr/bin/env python3
"""Fixed-origin HTTPS proxy for the A3 proof VM; no generic tunnel.

The VM may reach this listener only through the installed bridge fence.
CONNECT terminates TLS on the host, then every decrypted HTTP request and
redirect is checked against the A3 synthetic read-only path policy. The
guest browser must pin the displayed self-signed certificate's SPKI hash.

A4 adds exactly one write: POST /api/login with a JSON content type and a
Content-Length of 1..1024 bytes, still one request per tunnel. Its body is
forwarded as-is and never logged, stored or inspected; this proxy logs
nothing per request at all. Every other POST keeps the A3 rule (only
POST /api/logout with an empty body).

A request reaches the origin at most once. Only a failure to establish the
connection (TCP or TLS, before any byte of the request is written) moves on
to the next public address; once the request is being sent, any failure
answers 502 and nothing is sent again, so the one sign-in POST is never
repeated after an upstream timeout.

The origin's public addresses are looked up at most once a minute and shared
by every request: on the proof host some DNS lookups take 1-2.5 s, and one per
request (several per page) could exceed the runner's 10 s page-load wait. A
failed lookup is never cached, and the cache is dropped when no cached address
connects, so a changed address is picked up by the next request.
"""
import argparse
import http.client
import ipaddress
from pathlib import Path
import re
import socket
import socketserver
import ssl
import sys
import threading
import time
from urllib.parse import urlsplit

ORIGIN = 'demo.fractionate.ai'
PEER = '10.185.17.179'
LISTEN = ('10.185.17.1', 18083)
CERT = Path('/etc/proxypilot-a3-proof/proxy-cert.pem')
KEY = Path('/etc/proxypilot-a3-proof/proxy-key.pem')
PATHS = frozenset(('/', '/workspace', '/api/config', '/api/session', '/api/files'))
ASSET = re.compile(r'/assets/[a-zA-Z0-9_.-]+\Z')
MAX_REQUEST = 16 * 1024
LOGIN = '/api/login'
MAX_LOGIN_BODY = 1024
LOGIN_TYPES = frozenset(('application/json', 'application/json; charset=utf-8'))
MAX_RESPONSE = 5 * 1024 * 1024
DNS_TTL = 60
_addresses = {'at': 0.0, 'list': None}
_addresses_lock = threading.Lock()
HOP = frozenset(('connection', 'proxy-connection', 'keep-alive',
                 'transfer-encoding', 'te', 'trailer', 'upgrade',
                 'proxy-authenticate', 'proxy-authorization'))


def permitted(method, target, headers):
    if method not in ('GET', 'POST') or not target.startswith('/') or target.startswith('//'):
        return False
    parts = urlsplit(target)
    if (parts.scheme or parts.netloc or parts.query or parts.fragment or '%' in target or '\\' in target
            or '?' in target or '#' in target):
        return False
    if method == 'GET' and parts.path not in PATHS and not ASSET.fullmatch(parts.path):
        return False
    if method == 'POST' and target not in ('/api/logout', LOGIN):
        return False
    if headers.get('host') != ORIGIN or headers.get('upgrade') or headers.get('connection', '').lower().find('upgrade') >= 0:
        return False
    if headers.get('transfer-encoding') or headers.get('expect') or headers.get('proxy-authorization'):
        return False
    if method == 'POST' and target == LOGIN:
        return login_length(headers) is not None
    if method == 'POST' and headers.get('content-length') != '0':
        return False
    if method == 'GET' and headers.get('content-length') not in (None, '0'):
        return False
    return True


def login_length(headers):
    """The only request body this proxy forwards: 1..1024 bytes of JSON."""
    value = headers.get('content-length') or ''
    if not re.fullmatch(r'[1-9][0-9]{0,3}', value) or int(value) > MAX_LOGIN_BODY:
        return None
    if (headers.get('content-type') or '').strip().lower() not in LOGIN_TYPES:
        return None
    return int(value)


def valid_location(value):
    if not value or '\r' in value or '\n' in value:
        return False
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        return parts.scheme == 'https' and parts.netloc == ORIGIN and not parts.query and not parts.fragment
    return value.startswith('/') and not value.startswith('//') and not parts.query and not parts.fragment


def public_addresses(clock=time.monotonic):
    """The approved origin's public addresses, looked up at most once per DNS_TTL."""
    with _addresses_lock:
        cached = _addresses['list']
        if cached and clock() - _addresses['at'] < DNS_TTL:
            return list(cached)
        fresh = lookup_addresses()
        _addresses.update(at=clock(), list=fresh)
        return list(fresh)


def forget_addresses():
    with _addresses_lock:
        _addresses.update(at=0.0, list=None)


def lookup_addresses():
    candidates = []
    for family, _, _, _, sockaddr in socket.getaddrinfo(ORIGIN, 443, type=socket.SOCK_STREAM):
        address = ipaddress.ip_address(sockaddr[0])
        if (address.is_global and not address.is_multicast and not address.is_reserved
                and not address.is_loopback and not address.is_link_local):
            candidates.append((family, str(address)))
    if not candidates:
        raise ValueError('Approved origin has no public address')
    return candidates


class FixedConnection(http.client.HTTPSConnection):
    def __init__(self, address):
        self.address = address
        super().__init__(ORIGIN, 443, timeout=8, context=ssl.create_default_context())

    def connect(self):
        sock = socket.create_connection((self.address, 443), timeout=self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=ORIGIN)


def read_request(reader):
    line = reader.readline(MAX_REQUEST + 1)
    if not line or len(line) > MAX_REQUEST or not line.endswith(b'\r\n'):
        raise ValueError('Missing or long request line')
    try:
        method, target, version = line[:-2].decode('ascii').split(' ')
    except (UnicodeError, ValueError) as error:
        raise ValueError('Malformed request line') from error
    if version != 'HTTP/1.1':
        raise ValueError('Only HTTP/1.1 accepted')
    headers = {}
    total = len(line)
    while True:
        line = reader.readline(MAX_REQUEST + 1)
        total += len(line)
        if not line or total > MAX_REQUEST:
            raise ValueError('Missing or long headers')
        if line == b'\r\n':
            break
        if line[:1] in (b' ', b'\t') or not line.endswith(b'\r\n') or b':' not in line:
            raise ValueError('Malformed header')
        name, value = line[:-2].split(b':', 1)
        if not re.fullmatch(rb'[A-Za-z0-9-]+', name):
            raise ValueError('Malformed header name')
        name = name.decode('ascii').lower()
        if name in headers:
            raise ValueError('Duplicate header')
        headers[name] = value.decode('latin-1').strip()
    return method, target, headers


def send_error(writer, code):
    phrase = {400: 'Bad Request', 403: 'Forbidden', 502: 'Bad Gateway'}[code]
    writer.write(f'HTTP/1.1 {code} {phrase}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'.encode())
    writer.flush()


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if self.client_address[0] != PEER:
            return
        self.request.settimeout(10)
        reader = self.request.makefile('rb')
        try:
            method, target, headers = read_request(reader)
            if method != 'CONNECT' or target != ORIGIN + ':443' or headers.get('host') != target:
                send_error(self.request.makefile('wb'), 403)
                return
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            with self.server.tls.wrap_socket(self.request, server_side=True) as client:
                self.serve_tls(client)
        except (ValueError, OSError, ssl.SSLError):
            return
        finally:
            reader.close()

    def serve_tls(self, client):
        client.settimeout(10)
        reader = client.makefile('rb')
        writer = client.makefile('wb')
        try:
            method, target, headers = read_request(reader)
            if not permitted(method, target, headers):
                send_error(writer, 403)
                return
            body = b''
            if method == 'POST' and target == LOGIN:
                length = login_length(headers)
                body = reader.read(length)
                if len(body) != length:
                    raise ValueError('Short sign-in body')
            upstream = None
            for _, address in public_addresses():
                candidate = FixedConnection(address)
                try:
                    # Nothing of the request is written yet, so trying the next
                    # address cannot repeat it.
                    candidate.connect()
                except (OSError, ssl.SSLError):
                    candidate.close()
                    continue
                upstream = candidate
                break
            if upstream is None:
                forget_addresses()   # the next request looks the origin up again
                send_error(writer, 502)
                return
            forward = {k: v for k, v in headers.items() if k not in HOP
                       and k not in ('host', 'content-length', 'accept-encoding')}
            forward['Host'] = ORIGIN
            forward['Accept-Encoding'] = 'identity'
            forward['Connection'] = 'close'
            try:
                upstream.request(method, target, body=body if method == 'POST' else None, headers=forward)
                response = upstream.getresponse()
            except (OSError, ssl.SSLError, http.client.HTTPException):
                # The request may already have reached the origin: never send it
                # again, to this address or another.
                upstream.close()
                send_error(writer, 502)
                return
            try:
                if 300 <= response.status < 400 and not valid_location(response.getheader('Location')):
                    send_error(writer, 403)
                    return
                if response.status == 101 or response.getheader('Content-Encoding', 'identity').lower() != 'identity':
                    send_error(writer, 502)
                    return
                body = response.read(MAX_RESPONSE + 1)
                if len(body) > MAX_RESPONSE:
                    send_error(writer, 502)
                    return
                response_headers = [(k, v) for k, v in response.getheaders()
                                    if k.lower() not in HOP and k.lower() not in
                                    ('content-length', 'content-encoding', 'location')]
                if 300 <= response.status < 400:
                    response_headers.append(('Location', response.getheader('Location')))
                writer.write(f'HTTP/1.1 {response.status} {response.reason}\r\n'.encode())
                for key, value in response_headers:
                    if '\r' in value or '\n' in value:
                        raise ValueError('Invalid upstream header')
                    writer.write(f'{key}: {value}\r\n'.encode('latin-1'))
                writer.write(f'Content-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode())
                writer.write(body)
                writer.flush()
            finally:
                upstream.close()
        except (ValueError, OSError, ssl.SSLError, http.client.HTTPException):
            return
        finally:
            reader.close()
            writer.close()


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 16


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true', required=True)
    args = parser.parse_args()
    if not args.serve or not CERT.is_file() or not KEY.is_file():
        parser.error('Host certificate/key missing')
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.set_alpn_protocols(['http/1.1'])
    tls.load_cert_chain(str(CERT), str(KEY))
    with Server(LISTEN, Handler) as server:
        server.tls = tls
        server.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print(f'A3 origin proxy refused: {error}', file=sys.stderr)
        sys.exit(1)
