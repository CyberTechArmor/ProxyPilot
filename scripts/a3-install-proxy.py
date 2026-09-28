#!/usr/bin/env python3
"""Operator-only installer for the fixed A3 synthetic HTTPS proxy."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location('fence_installer', Path(__file__).with_name('a3-install-fence.py'))
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)
spec2 = importlib.util.spec_from_file_location('origin_proxy', Path(__file__).with_name('a3-origin-proxy.py'))
p = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(p)
SOURCE = Path(__file__).with_name('a3-origin-proxy.py')
INSTALLED = i.CONFIG / 'origin-proxy.py'
CERT = i.CONFIG / 'proxy-cert.pem'
KEY = i.CONFIG / 'proxy-key.pem'
UNIT = Path('/etc/systemd/system/proxypilot-a3-origin-proxy.service')
JOURNAL = i.STATE / 'proxy-install.json'
UNIT_TEXT = '''[Unit]
Description=A3 fixed-origin proxy for the proof VM
Requires=proxypilot-a3-fence.service
After=proxypilot-a3-fence.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /etc/proxypilot-a3-proof/origin-proxy.py --serve
Restart=on-failure
RestartSec=1
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictNamespaces=yes
MemoryMax=256M
TasksMax=32

[Install]
WantedBy=multi-user.target
'''


def source_and_unit():
    source = SOURCE.read_text()
    if not source.startswith('#!/usr/bin/env python3\n'):
        raise ValueError('Unreviewed proxy source')
    return source, UNIT_TEXT


def validate_target():
    status = i.status()
    if status['vm_status'] != 'Running' or status['tap'] != i.fence.TAP:
        raise ValueError('Running proof VM and active fence required')
    return status


def spki(cert):
    pub = subprocess.run(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'],
                         check=True, capture_output=True, text=True, timeout=20).stdout
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'],
                         input=pub.encode('ascii'), check=True, capture_output=True, timeout=20).stdout
    return base64.b64encode(hashlib.sha256(der).digest()).decode('ascii')


def status():
    validate_target()
    data = i.parse_json(JOURNAL.read_text(), str(JOURNAL))
    if data.get('version') != 1 or data.get('phase') != 'installed' or data.get('vm_uuid') != i.fence.PROOF_UUID:
        raise ValueError('Proxy journal is not complete')
    for path in (INSTALLED, CERT, KEY, UNIT):
        i.secure(path)
        if i.digest(path.read_text()) != data['files'][str(path)]:
            raise ValueError(f'Proxy-owned file changed: {path}')
    i.execute(['systemctl', 'is-active', UNIT.name])
    i.execute(['systemctl', 'is-enabled', UNIT.name])
    if i.execute(['systemctl', 'show', UNIT.name, '--property=FragmentPath', '--value']).strip() != str(UNIT):
        raise ValueError('Unexpected proxy unit path')
    if i.execute(['systemctl', 'show', UNIT.name, '--property=DropInPaths', '--value']).strip():
        raise ValueError('Unexpected proxy unit override')
    if i.execute(['systemctl', 'show', UNIT.name, '--property=NeedDaemonReload', '--value']).strip() != 'no':
        raise ValueError('Proxy unit requires reload')
    i.execute(['openssl', 'x509', '-in', str(CERT), '-checkend', '86400', '-noout'])
    return dict(installed=True, vm_uuid=i.fence.PROOF_UUID, listen='10.185.17.1:18083',
                allowed_origin='https://demo.fractionate.ai',
                certificate_spki_sha256=spki(CERT), service='active/enabled',
                worker_ready=False,
                notice='Proxy installed; positive/negative guest proof and supervisor remain open')


def install():
    validate_target()
    for path in (INSTALLED, CERT, KEY, UNIT, JOURNAL):
        i.secure(path)
    source, unit = source_and_unit()
    with tempfile.TemporaryDirectory(prefix='pp-a3-proxy-') as tmp:
        tmp = Path(tmp)
        candidate_unit = tmp / UNIT.name
        candidate_unit.write_text(unit)
        i.execute(['systemd-analyze', 'verify', str(candidate_unit)])
        if JOURNAL.exists():
            data = i.parse_json(JOURNAL.read_text(), str(JOURNAL))
            if data.get('phase') == 'installed':
                return status()
            raise ValueError('Incomplete proxy installation; review journal before recovery')
        if any(path.exists() for path in (INSTALLED, CERT, KEY, UNIT)):
            raise ValueError('Unowned proxy file exists')
        with socket.socket() as test:
            test.bind(p.LISTEN)
        key_tmp, cert_tmp = tmp / 'key.pem', tmp / 'cert.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-sha256',
                        '-nodes', '-days', '7', '-subj', '/CN=demo.fractionate.ai',
                        '-addext', 'subjectAltName=DNS:demo.fractionate.ai',
                        '-keyout', str(key_tmp), '-out', str(cert_tmp)],
                       check=True, capture_output=True, timeout=30)
        key = key_tmp.read_text()
        cert = cert_tmp.read_text()
        i.execute(['openssl', 'verify', '-CAfile', str(cert_tmp), str(cert_tmp)])
        files = {str(path): i.digest(value) for path, value in
                 ((INSTALLED, source), (CERT, cert), (KEY, key), (UNIT, unit))}
        data = dict(version=1, phase='prepared', vm_uuid=i.fence.PROOF_UUID, files=files)
        i.save(JOURNAL, json.dumps(data, indent=2) + '\n', mode=0o600)
        i.save(INSTALLED, source)
        i.save(CERT, cert)
        i.save(KEY, key, mode=0o600)
        i.save(UNIT, unit)
    validate_target()
    i.execute(['systemctl', 'daemon-reload'])
    i.execute(['systemctl', 'enable', '--now', UNIT.name])
    data['phase'] = 'installed'
    i.save(JOURNAL, json.dumps(data, indent=2) + '\n', mode=0o600, replace=True)
    return status()


def remove():
    # Verify every owned artifact and the exact service before removing only
    # this proxy. The VM remains fenced when the listener is removed.
    status()
    data = i.parse_json(JOURNAL.read_text(), str(JOURNAL))
    i.execute(['systemctl', 'disable', '--now', UNIT.name])
    for path in (UNIT, INSTALLED, CERT, KEY):
        i.secure(path)
        if i.digest(path.read_text()) != data['files'][str(path)]:
            raise ValueError('Proxy artifact changed during removal')
        path.unlink()
    i.execute(['systemctl', 'daemon-reload'])
    data['phase'] = 'removed'
    i.save(JOURNAL, json.dumps(data, indent=2) + '\n', mode=0o600, replace=True)
    return dict(removed=True, fence_retained=True, vm_uuid=i.fence.PROOF_UUID)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'status', 'remove'))
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    import fcntl
    lock = Path('/run/proxypilot-a3-fence.lock')
    i.secure(lock)
    with lock.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps({'install': install, 'status': status, 'remove': remove}[args.action](), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('A3 proxy operation refused: ' + (getattr(error, 'stderr', None) or str(error)).strip(), file=sys.stderr)
        sys.exit(1)
