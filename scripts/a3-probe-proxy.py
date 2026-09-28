#!/usr/bin/env python3
"""Host operator proof of the fixed A3 proxy from the exact proof VM."""
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
GUEST = '''import hashlib, json, socket, ssl, sys
from pathlib import Path
if Path('/sys/class/net/enp5s0/address').read_text().strip() != '10:66:6a:55:f6:3f':
    raise SystemExit('Guest NIC identity mismatch')
expected = sys.argv[1]
results = []
def connect(authority):
    conn = socket.create_connection(('10.185.17.1', 18083), timeout=8)
    conn.settimeout(8)
    conn.sendall(('CONNECT ' + authority + ' HTTP/1.1\\r\\nHost: ' + authority + '\\r\\n\\r\\n').encode())
    data = b''
    while b'\\r\\n\\r\\n' not in data and len(data) < 4096:
        part = conn.recv(4096)
        if not part: break
        data += part
    return conn, data.split(b'\\r\\n', 1)[0].decode('ascii', 'replace')
for authority in ('outside.invalid:443', '10.185.17.1:443'):
    conn, status = connect(authority)
    conn.close()
    results.append(dict(case='blocked_connect_' + authority, status=status))
for path, host, upgrade in (('/', 'demo.fractionate.ai', False),
                            ('/api/session', 'demo.fractionate.ai', False),
                            ('/api/login', 'demo.fractionate.ai', False),
                            ('/', 'outside.invalid', False),
                            ('/', 'demo.fractionate.ai', True)):
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
        headers = ('Upgrade: websocket\\r\\nConnection: Upgrade\\r\\n' if upgrade
                   else 'Connection: close\\r\\n')
        secured.sendall(('GET ' + path + ' HTTP/1.1\\r\\nHost: ' + host +
                         '\\r\\n' + headers + 'Accept-Encoding: identity\\r\\n\\r\\n').encode())
        data = b''
        while b'\\r\\n\\r\\n' not in data and len(data) < 4096:
            part = secured.recv(4096)
            if not part: break
            data += part
        status = data.split(b'\\r\\n', 1)[0].decode('ascii', 'replace')
        results.append(dict(case='request_' + path + '_' + host + ('_ws' if upgrade else ''),
                            status=status, cert_sha256=actual))
print(json.dumps(dict(boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                      cases=results)))
'''


def evaluate(report):
    cases = report['cases']
    if len(cases) != 7:
        raise ValueError('Missing proxy cases')
    codes = []
    for entry in cases:
        status = entry.get('status', '')
        match = re.fullmatch(r'HTTP/1\.1 ([0-9]{3}) [^\r\n]*', status)
        if not match:
            raise ValueError('Malformed proxy response for ' + str(entry.get('case', 'unknown')) +
                             ': ' + repr(status[:100]) + '; all cases: ' +
                             json.dumps([{key: item.get(key) for key in ('case', 'status')}
                                         for item in cases]))
        codes.append(match.group(1))
    if codes != ['403', '403', '200', '200', '403', '403', '403']:
        raise ValueError('Proxy positive/negative status mismatch: ' +
                         json.dumps([{key: item.get(key) for key in ('case', 'status')}
                                     for item in cases]))
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
