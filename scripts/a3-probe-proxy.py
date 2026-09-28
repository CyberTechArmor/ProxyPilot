#!/usr/bin/env python3
"""Host operator proof of the fixed A3/A4 proxy from the exact proof VM.

A4 extends it: one bounded JSON POST /api/login must reach the origin and
every other POST, path, content type, length and framing must still be refused.
"""
import importlib.util
import hashlib
import json
from pathlib import Path
import re
import ssl
import subprocess
import sys

spec = importlib.util.spec_from_file_location('proxy_install', Path(__file__).with_name('a3-install-proxy.py'))
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)
GUEST = r"""import hashlib, json, socket, ssl, sys
from pathlib import Path
if Path('/sys/class/net/enp5s0/address').read_text().strip() != '10:66:6a:55:f6:3f':
    raise SystemExit('Guest NIC identity mismatch')
expected = sys.argv[1]
results = []
def connect(authority):
    conn = socket.create_connection(('10.185.17.1', 18083), timeout=8)
    conn.settimeout(8)
    conn.sendall(('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n').encode())
    data = b''
    while b'\r\n\r\n' not in data and len(data) < 4096:
        part = conn.recv(4096)
        if not part: break
        data += part
    return conn, data.split(b'\r\n', 1)[0].decode('ascii', 'replace')
def request(case, method, path, host, headers, body=b''):
    conn, connect_status = connect('demo.fractionate.ai:443')
    if not connect_status.startswith('HTTP/1.1 200 '):
        raise SystemExit('Approved CONNECT failed: ' + connect_status)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    tls.check_hostname = False
    tls.verify_mode = ssl.CERT_NONE
    tls.set_alpn_protocols(['http/1.1'])
    with tls.wrap_socket(conn, server_hostname='demo.fractionate.ai') as secured:
        actual = hashlib.sha256(secured.getpeercert(binary_form=True)).hexdigest()
        if actual != expected:
            raise SystemExit('Proxy certificate changed')
        head = method + ' ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\n' + headers + 'Accept-Encoding: identity\r\n\r\n'
        try:
            secured.sendall(head.encode() + body)
        except OSError:
            pass
        data = b''
        try:
            while b'\r\n\r\n' not in data and len(data) < 8192:
                part = secured.recv(4096)
                if not part: break
                data += part
        except OSError:
            pass
        lines = data.split(b'\r\n\r\n', 1)[0].decode('latin-1').split('\r\n')
        fields = {l.split(':', 1)[0].strip().lower(): l.split(':', 1)[1].strip() for l in lines[1:] if ':' in l}
        # The proxy's own refusal is an empty 403; the demo origin sets nosniff on every answer.
        results.append(dict(case=case, status=lines[0], cert_sha256=actual,
                            origin_answered=fields.get('x-content-type-options') == 'nosniff'))
for authority in ('outside.invalid:443', '10.185.17.1:443'):
    conn, status = connect(authority)
    conn.close()
    results.append(dict(case='blocked_connect_' + authority, status=status))
for path, host, upgrade in (('/', 'demo.fractionate.ai', False),
                            ('/api/session', 'demo.fractionate.ai', False),
                            ('/api/login', 'demo.fractionate.ai', False),
                            ('/', 'outside.invalid', False),
                            ('/', 'demo.fractionate.ai', True)):
    headers = 'Upgrade: websocket\r\nConnection: Upgrade\r\n' if upgrade else 'Connection: close\r\n'
    request('request_' + path + '_' + host + ('_ws' if upgrade else ''), 'GET', path, host, headers)
JSON, ORIGIN = 'Content-Type: application/json\r\n', 'Origin: https://demo.fractionate.ai\r\nConnection: close\r\n'
def post(case, path, headers, body, method='POST', host='demo.fractionate.ai'):
    request(case, method, path, host, headers + ORIGIN + 'Content-Length: %d\r\n' % len(body), body)
# The one A4 addition: a bounded JSON sign-in body reaches the origin. '{' is
# invalid JSON, so the demo answers 400 without counting a failed sign-in.
post('login_json_reaches_origin', '/api/login', JSON, b'{')
post('login_text_plain', '/api/login', 'Content-Type: text/plain\r\n', b'{')
post('login_no_content_type', '/api/login', '', b'{')
post('login_empty_body', '/api/login', JSON, b'')
post('login_over_1024', '/api/login', JSON, b'{' * 1025)
request('login_chunked', 'POST', '/api/login', 'demo.fractionate.ai',
        JSON + ORIGIN + 'Transfer-Encoding: chunked\r\n', b'1\r\n{\r\n0\r\n\r\n')
post('login_query', '/api/login?next=1', JSON, b'{')
post('login_other_host', '/api/login', JSON, b'{', host='outside.invalid')
post('put_login', '/api/login', JSON, b'{', method='PUT')
post('post_session', '/api/session', JSON, b'{')
post('post_files', '/api/files', JSON, b'{')
post('post_root', '/', JSON, b'{')
post('logout_with_body', '/api/logout', JSON, b'{')
post('logout_empty_reaches_origin', '/api/logout', JSON, b'')
print(json.dumps(dict(boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                      cases=results)))
"""
# (case, status, answered by the origin?) in the guest's order. The first seven
# are the A3 proof unchanged; every POST except the two positives is the
# proxy's own empty 403.
EXPECTED = [('blocked_connect_outside.invalid:443', '403', None), ('blocked_connect_10.185.17.1:443', '403', None),
            ('request_/_demo.fractionate.ai', '200', True), ('request_/api/session_demo.fractionate.ai', '200', True),
            ('request_/api/login_demo.fractionate.ai', '403', False), ('request_/_outside.invalid', '403', False),
            ('request_/_demo.fractionate.ai_ws', '403', False),
            ('login_json_reaches_origin', '400', True), ('login_text_plain', '403', False),
            ('login_no_content_type', '403', False), ('login_empty_body', '403', False),
            ('login_over_1024', '403', False), ('login_chunked', '403', False), ('login_query', '403', False),
            ('login_other_host', '403', False), ('put_login', '403', False), ('post_session', '403', False),
            ('post_files', '403', False), ('post_root', '403', False), ('logout_with_body', '403', False),
            ('logout_empty_reaches_origin', '200', True)]


def evaluate(report):
    cases = report['cases']
    brief = json.dumps([{key: item.get(key) for key in ('case', 'status', 'origin_answered')} for item in cases])
    if len(cases) != len(EXPECTED):
        raise ValueError('Missing proxy cases: ' + brief)
    codes = []
    for entry, (name, code, answered) in zip(cases, EXPECTED):
        status = entry.get('status', '')
        match = re.fullmatch(r'HTTP/1\.1 ([0-9]{3}) [^\r\n]*', status)
        if not match:
            raise ValueError('Malformed proxy response for ' + str(entry.get('case', 'unknown')) +
                             ': ' + repr(status[:100]) + '; all cases: ' + brief)
        if entry.get('case') != name or match.group(1) != code or (
                answered is not None and entry.get('origin_answered') is not answered):
            raise ValueError('Proxy positive/negative status mismatch at ' + name + ': ' + brief)
        codes.append(match.group(1))
    if not report.get('boot_id'):
        raise ValueError('Missing guest boot identity')
    return codes


def certificate_der_sha256(path):
    # getpeercert(binary_form=True) returns DER, not the PEM file bytes.
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(path.read_text())).hexdigest()


def run():
    status = i.status()
    cert_hash = certificate_der_sha256(i.CERT)
    raw = i.i.execute(['incus', 'exec', i.i.fence.VM, '--', 'python3', '-c', GUEST, cert_hash])
    report = i.i.parse_json(raw, 'A3 guest proxy probe')
    codes = evaluate(report)
    after = i.status()
    if after['vm_uuid'] != status['vm_uuid'] or after['service'] != 'active/enabled':
        raise ValueError('Proxy service or VM identity changed during proof')
    return dict(proxy_checks='passed', vm_uuid=status['vm_uuid'], boot_id=report['boot_id'],
                status_codes=codes, cases=report['cases'], worker_ready=False,
                notice='Origin proxy checks only; browser, supervisor and lifecycle remain open')


if __name__ == '__main__':
    try:
        print(json.dumps(run(), indent=2))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('A3 proxy proof stopped: ' + (getattr(error, 'stderr', None) or str(error)).strip(), file=sys.stderr)
        sys.exit(1)
