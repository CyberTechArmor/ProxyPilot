#!/usr/bin/env python3
"""Operator-only installer for the fixed A3 synthetic HTTPS proxy.

The proxy terminates the guest browser's TLS with its own self-signed
certificate (CN demo.fractionate.ai), which the browser trusts only by the
SPKI pin the supervisor passes at launch; no public CA and no Caddy key is
involved. The certificate lives CERT_DAYS. `renew` re-issues it when fewer than
RENEW_BEFORE seconds remain and no worker attempt is live; the supervisor's
installer runs it from a root timer, so it never lapses unattended.
"""
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
OPERATOR_SOCKET = Path('/run/proxypilot-a3/operator.sock')
CERT_DAYS = 7
# Launches refuse a certificate with under a day left (status); renewal starts
# three days out, so a timer that runs every six hours has twelve chances.
RENEW_BEFORE = 3 * 86400
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


def issue_certificate(directory):
    """A fresh self-signed key and certificate for the fixed origin, as text."""
    key_tmp, cert_tmp = directory / 'key.pem', directory / 'cert.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-sha256',
                    '-nodes', '-days', str(CERT_DAYS), '-subj', '/CN=demo.fractionate.ai',
                    '-addext', 'subjectAltName=DNS:demo.fractionate.ai',
                    '-keyout', str(key_tmp), '-out', str(cert_tmp)],
                   check=True, capture_output=True, timeout=30)
    i.execute(['openssl', 'verify', '-CAfile', str(cert_tmp), str(cert_tmp)])
    return key_tmp.read_text(), cert_tmp.read_text()


def certificate_due(seconds=None, cert=None):
    """True when the certificate expires within `seconds` (default RENEW_BEFORE) or cannot be read."""
    seconds = RENEW_BEFORE if seconds is None else seconds
    return subprocess.run(['openssl', 'x509', '-in', str(cert or CERT), '-checkend', str(seconds), '-noout'],
                          capture_output=True, timeout=20).returncode != 0


def not_after(cert=None):
    out = subprocess.run(['openssl', 'x509', '-in', str(cert or CERT), '-enddate', '-noout'],
                         check=True, capture_output=True, text=True, timeout=20).stdout
    return out.strip().partition('=')[2]


def live_attempt(path=None):
    """The supervisor's live attempt, or None. No socket means no supervisor, so
    nothing can be live; a socket that does not answer raises (renewal waits)."""
    path = path or OPERATOR_SOCKET
    if not path.exists():
        return None
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(15)
        client.connect(str(path))
        client.sendall((json.dumps({'method': 'status', 'params': {}}) + '\n').encode())
        reply = json.loads(client.makefile().readline() or '{}')
    if not reply.get('ok'):
        raise ValueError('Supervisor status refused; renewal waits')
    return reply['result'].get('active')


def spki(cert):
    pub = subprocess.run(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'],
                         check=True, capture_output=True, text=True, timeout=20).stdout
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'],
                         input=pub.encode('ascii'), check=True, capture_output=True, timeout=20).stdout
    return base64.b64encode(hashlib.sha256(der).digest()).decode('ascii')


def status(check_certificate=True):
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
    if check_certificate:
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
        reinstall = False
        if JOURNAL.exists():
            data = i.parse_json(JOURNAL.read_text(), str(JOURNAL))
            if data.get('phase') == 'installed':
                return status()
            # A completed removal (every owned file gone) may be reinstalled with a
            # fresh certificate; anything else needs review first.
            if data.get('phase') != 'removed':
                raise ValueError('Incomplete proxy installation; review journal before recovery')
            reinstall = True
        if any(path.exists() for path in (INSTALLED, CERT, KEY, UNIT)):
            raise ValueError('Unowned proxy file exists')
        with socket.socket() as test:
            test.bind(p.LISTEN)
        key, cert = issue_certificate(tmp)
        files = {str(path): i.digest(value) for path, value in
                 ((INSTALLED, source), (CERT, cert), (KEY, key), (UNIT, unit))}
        data = dict(version=1, phase='prepared', vm_uuid=i.fence.PROOF_UUID, files=files)
        # Only this installer's own `removed` journal is replaced; any other file refuses.
        i.save(JOURNAL, json.dumps(data, indent=2) + '\n', mode=0o600, replace=reinstall)
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
    # this proxy. The VM remains fenced when the listener is removed. An expiring
    # certificate does not block removal: removal then install re-issues it.
    status(check_certificate=False)
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


def reinstall():
    """A reviewed proxy change or a certificate re-issue: remove, then install fresh.

    A proxy already removed (for example by an interrupted earlier reinstall) is
    installed without a second removal.
    """
    removed = None
    if not JOURNAL.exists() or i.parse_json(JOURNAL.read_text(), str(JOURNAL)).get('phase') != 'removed':
        removed = remove()
    return dict(install(), previous_removed=removed)


def renew(force=False, attempt=live_attempt):
    """Re-issue the certificate in place when it is due, then restart the proxy.

    Only the certificate and key change; the proxy source and unit are verified
    unchanged. Nothing happens while a worker attempt is live, because its
    browser pinned the current key; the timer tries again later. A renewal
    interrupted between the two file writes is recorded in the journal first,
    so the next run finishes it with a fresh pair instead of refusing.
    """
    if i.status()['vm_status'] != 'Running':
        # No launch can happen while the proof VM is stopped; the timer renews
        # once it runs again (a lapsed certificate only refuses launches meanwhile).
        return dict(renewed=False, reason='vm_not_running')
    validate_target()
    data = i.parse_json(JOURNAL.read_text(), str(JOURNAL))
    if data.get('version') != 1 or data.get('phase') != 'installed' or data.get('vm_uuid') != i.fence.PROOF_UUID:
        raise ValueError('Proxy journal is not complete')
    pending = data.get('renewal')
    if pending:
        for path in (INSTALLED, UNIT):
            i.secure(path)
            if i.digest(path.read_text()) != data['files'][str(path)]:
                raise ValueError(f'Proxy-owned file changed: {path}')
        for path in (CERT, KEY):
            i.secure(path)
            if i.digest(path.read_text()) not in (data['files'][str(path)], pending[str(path)]):
                raise ValueError(f'Proxy certificate changed outside a renewal: {path}')
    else:
        status(check_certificate=False)
        if not force and not certificate_due():
            return dict(renewed=False, reason='not_due', not_after=not_after(),
                        renew_within_seconds=RENEW_BEFORE, certificate_spki_sha256=spki(CERT))
    live = attempt()
    if live:
        return dict(renewed=False, reason='attempt_live', attempt_id=live.get('attempt_id'),
                    not_after=not_after(), notice='The timer retries; the current certificate stays in use.')
    previous = spki(CERT)
    with tempfile.TemporaryDirectory(prefix='pp-a3-proxy-renew-') as tmp:
        key, cert = issue_certificate(Path(tmp))
    data['renewal'] = {str(CERT): i.digest(cert), str(KEY): i.digest(key)}
    i.save(JOURNAL, json.dumps(data, indent=2) + '\n', mode=0o600, replace=True)
    i.save(KEY, key, mode=0o600, replace=True)
    i.save(CERT, cert, replace=True)
    data['files'].update(data.pop('renewal'))
    i.save(JOURNAL, json.dumps(data, indent=2) + '\n', mode=0o600, replace=True)
    i.execute(['systemctl', 'restart', UNIT.name])
    result = status()
    return dict(result, renewed=True, previous_spki_sha256=previous, not_after=not_after(),
                notice='New certificate in place; the supervisor pins it at the next launch.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=('install', 'status', 'remove', 'reinstall', 'renew'))
    parser.add_argument('--force', action='store_true', help='renew: re-issue even when not due')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    if args.force and args.action != 'renew':
        parser.error('--force applies to renew only')
    import fcntl
    lock = Path('/run/proxypilot-a3-fence.lock')
    i.secure(lock)
    with lock.open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if args.action != 'renew':
                raise
            # Another installer holds the lock; the timer simply tries again.
            print(json.dumps({'renewed': False, 'reason': 'installer_busy'}, indent=2))
            return
        if args.action == 'renew':
            print(json.dumps(renew(force=args.force), indent=2))
            return
        print(json.dumps({'install': install, 'status': status, 'remove': remove,
                          'reinstall': reinstall}[args.action](), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('A3 proxy operation refused: ' + (getattr(error, 'stderr', None) or str(error)).strip(), file=sys.stderr)
        sys.exit(1)
