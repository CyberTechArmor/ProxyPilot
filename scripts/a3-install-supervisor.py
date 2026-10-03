#!/usr/bin/env python3
"""Operator-only installer for the A3 worker supervisor on the proof host.

Copies the reviewed supervisor, guest runner and fence/proxy modules into
root-owned /etc/proxypilot-a3-proof/supervisor, creates the host-held Ed25519
receipt key, and installs one systemd unit that requires the installed fence.
It never starts, stops or reconfigures the VM, the fence, the proxy, Incus or
any other guest, and it never edits a firewall table or an Incus profile.
Every file is digest-recorded before activation and read back afterwards; a
failed activation is rolled back to the files present before this run.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location('a3_proxy_installer', Path(__file__).with_name('a3-install-proxy.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
i = proxy.i
SOURCES = ('a3-worker-supervisor.py', 'a3-worker-guest.py', 'a3-install-proxy.py',
           'a3-install-fence.py', 'a3-network-fence.py', 'a3-origin-proxy.py')
SELECTED_SOURCES = ('selected_browser_supervisor.py', 'selected_browser_policy.py', 'selected_browser_gateway.py',
                    'selected_browser_worker.py', 'selected_browser_contract.py', 'selected-browser-schemas.json',
                    'selected-browser-model.py')
TARGET = i.CONFIG / 'supervisor'
UNIT = Path('/etc/systemd/system/proxypilot-a3-supervisor.service')
KEY = i.CONFIG / 'supervisor-key.pem'
PUBLIC_KEY = i.CONFIG / 'supervisor-pub.pem'
JOURNAL = i.STATE / 'supervisor-install.json'
STATE_DIR = i.STATE / 'supervisor'
KEY_ARCHIVE = i.STATE / 'supervisor-keys'
OPERATOR_SOCKET = Path('/run/proxypilot-a3/operator.sock')
# The origin proxy's self-signed certificate lives 7 days; this timer runs the
# INSTALLED proxy installer's `renew` (re-issue when under 3 days remain and no
# attempt is live), so it never lapses unattended. It is installed with the
# supervisor because it runs the supervisor's reviewed copy of that installer.
RENEW_SERVICE = Path('/etc/systemd/system/proxypilot-a3-proxy-renew.service')
RENEW_TIMER = Path('/etc/systemd/system/proxypilot-a3-proxy-renew.timer')
RENEW_SERVICE_TEXT = '''[Unit]
Description=Renew the A3 origin proxy certificate when it is due
After=proxypilot-a3-fence.service proxypilot-a3-origin-proxy.service proxypilot-a3-supervisor.service
ConditionPathExists=/etc/proxypilot-a3-proof/supervisor/a3-install-proxy.py

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I /etc/proxypilot-a3-proof/supervisor/a3-install-proxy.py renew
TimeoutStartSec=180
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
'''
# No ProtectHome/ProtectSystem: renewal runs the same Incus and nft calls as the
# supervisor (whose unit has no ProtectHome; the incus client keeps its config
# under /root) and writes the certificate under /etc/proxypilot-a3-proof.
RENEW_TIMER_TEXT = '''[Unit]
Description=Check the A3 origin proxy certificate every six hours

[Timer]
OnBootSec=10min
OnCalendar=*-*-* 00/6:17:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
'''
UNIT_TEXT = '''[Unit]
Description=A3 worker supervisor for the proof VM
Requires=proxypilot-a3-fence.service
Wants=proxypilot-a3-origin-proxy.service network-online.target
After=proxypilot-a3-fence.service proxypilot-a3-origin-proxy.service incus.service network-online.target
RequiresMountsFor=/etc/proxypilot-a3-proof /var/lib/proxypilot-a3-proof

[Service]
Type=simple
ExecStart=/usr/bin/python3 -I /etc/proxypilot-a3-proof/supervisor/a3-worker-supervisor.py --serve
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=60
UMask=0077
RuntimeDirectory=proxypilot-a3 proxypilot-a3-backend
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes
MemoryMax=256M
TasksMax=128

[Install]
WantedBy=multi-user.target
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save_bytes(path, data, mode):
    """Atomic, fsynced, byte-exact replacement below root-owned directories."""
    i.secure(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def plan_files(source_dir=Path(__file__).resolve().parent):
    files = {}
    for name in SOURCES + SELECTED_SOURCES:
        data = (source_dir / name).read_bytes()
        if name.endswith('.json'):
            schemas = json.loads(data)
            if not isinstance(schemas, dict) or set(schemas) not in ({'configuration', 'action'},{'configuration','action','public_configuration'}):
                raise ValueError(f'Unreviewed schema bundle: {name}')
        elif not (data.startswith(b'#!/usr/bin/env python3\n') or
                  name in SELECTED_SOURCES and data.startswith(b'"""')):
            raise ValueError(f'Unreviewed source: {name}')
        files[TARGET / name] = data
    files[UNIT] = UNIT_TEXT.encode()
    files[RENEW_SERVICE] = RENEW_SERVICE_TEXT.encode()
    files[RENEW_TIMER] = RENEW_TIMER_TEXT.encode()
    return files


def read_journal():
    i.secure(JOURNAL)
    data = i.parse_json(JOURNAL.read_text(), str(JOURNAL))
    if data.get('version') != 1 or data.get('vm_uuid') != i.fence.PROOF_UUID:
        raise ValueError('Invalid supervisor installation journal')
    return data


def write_journal(data):
    i.save(JOURNAL, json.dumps(data, indent=2) + '\n', mode=0o600, replace=True)


def key_id(public_key):
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-in', str(public_key), '-outform', 'DER'],
                         check=True, capture_output=True, timeout=20).stdout
    return digest(der)


def call(method, params=None, path=OPERATOR_SOCKET, timeout=30):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(timeout)
        client.connect(str(path))
        client.sendall((json.dumps({'method': method, 'params': params or {}}) + '\n').encode())
        return json.loads(client.makefile().readline())


def wait_status(expected_key):
    deadline = time.monotonic() + 30
    last = None
    while time.monotonic() < deadline:
        try:
            reply = call('status')
            if reply.get('ok') and reply['result']['supervisor']['key_id'] == expected_key:
                return reply['result']
            last = reply
        except (OSError, ValueError) as error:
            last = str(error)
        time.sleep(1)
    raise ValueError(f'Supervisor did not answer with the installed key: {last}')


def renew_timer_checks(data):
    """The certificate renewal timer, for an installation that recorded it."""
    if str(RENEW_TIMER) not in data['files']:
        return None
    i.execute(['systemctl', 'is-enabled', RENEW_TIMER.name])
    i.execute(['systemctl', 'is-active', RENEW_TIMER.name])
    for unit, path in ((RENEW_TIMER.name, RENEW_TIMER), (RENEW_SERVICE.name, RENEW_SERVICE)):
        show = lambda prop: i.execute(['systemctl', 'show', unit, f'--property={prop}', '--value']).strip()  # noqa: E731
        if show('FragmentPath') != str(path) or show('DropInPaths') or show('NeedDaemonReload') != 'no':
            raise ValueError(f'Loaded {unit} does not match the installed file')
    return {'timer': RENEW_TIMER.name, 'state': 'active/enabled'}


def unit_checks():
    i.execute(['systemctl', 'is-active', UNIT.name])
    i.execute(['systemctl', 'is-enabled', UNIT.name])
    show = lambda prop: i.execute(['systemctl', 'show', UNIT.name, f'--property={prop}', '--value']).strip()  # noqa: E731
    if show('FragmentPath') != str(UNIT) or show('DropInPaths') or show('NeedDaemonReload') != 'no':
        raise ValueError('Loaded supervisor unit does not match the installed file')
    requires, after = show('Requires').split(), show('After').split()
    if 'proxypilot-a3-fence.service' not in requires or not {
            'proxypilot-a3-fence.service', 'proxypilot-a3-origin-proxy.service'} <= set(after):
        raise ValueError('Supervisor boot dependency on the fence/proxy is missing')
    return {'requires': [u for u in requires if u.startswith('proxypilot-a3')],
            'after': [u for u in after if u.startswith('proxypilot-a3')]}


def verify_files(data):
    for path, want in data['files'].items():
        path = Path(path)
        i.secure(path)
        if digest(path.read_bytes()) != want:
            raise ValueError(f'Supervisor-owned file changed: {path}')


def status():
    data = read_journal()
    if data.get('phase') != 'installed':
        raise ValueError(f"Supervisor installation phase is {data.get('phase')}")
    verify_files(data)
    dependencies = unit_checks()
    renewal = renew_timer_checks(data)
    if key_id(PUBLIC_KEY) != data['key_id']:
        raise ValueError('Receipt public key changed')
    reply = call('status')
    if not reply.get('ok'):
        raise ValueError(f'Supervisor status refused: {reply}')
    result = reply['result']
    return dict(installed=True, vm_uuid=i.fence.PROOF_UUID, service='active/enabled', dependencies=dependencies,
                files=data['files'], key_id=data['key_id'], public_key=str(PUBLIC_KEY),
                accepting_launch=result['accepting_launch'], blockers=result['blockers'], active=result['active'],
                boundary=result['boundary'], certificate_renewal=renewal,
                notice='Supervisor installed; worker_ready requires the lifecycle proof (a3-probe-worker.py)')


def rollback(written, previous):
    subprocess.run(['systemctl', 'disable', '--now', RENEW_TIMER.name], capture_output=True, timeout=90)
    subprocess.run(['systemctl', 'disable', '--now', UNIT.name], capture_output=True, timeout=90)
    for path in written:
        if path in previous:
            save_bytes(path, previous[path], 0o644)
        else:
            path.unlink(missing_ok=True)
    subprocess.run(['systemctl', 'daemon-reload'], capture_output=True, timeout=60)


def install():
    proxy.status()  # Fence, proxy and the running proof VM, exactly as installed.
    for path in (TARGET, UNIT, KEY, PUBLIC_KEY, JOURNAL, STATE_DIR, KEY_ARCHIVE):
        i.secure(path)
    files = plan_files()
    with tempfile.TemporaryDirectory(prefix='pp-a3-supervisor-') as temp:
        for path, text in ((UNIT, UNIT_TEXT), (RENEW_SERVICE, RENEW_SERVICE_TEXT), (RENEW_TIMER, RENEW_TIMER_TEXT)):
            (Path(temp) / path.name).write_text(text)
        i.execute(['systemd-analyze', 'verify', *(str(Path(temp) / p.name) for p in (UNIT, RENEW_SERVICE, RENEW_TIMER))])
        for name in SOURCES + tuple(n for n in SELECTED_SOURCES if n.endswith('.py')):
            compile(files[TARGET / name].decode('utf-8'), name, 'exec')  # Syntax only; nothing is written.
        if JOURNAL.exists():
            data = read_journal()
            if data.get('phase') == 'installed':
                return status()
            if data.get('phase') not in ('removed', 'rolled_back'):
                raise ValueError('Incomplete supervisor installation; review the journal before recovery')
        if subprocess.run(['systemctl', 'is-active', UNIT.name], capture_output=True).returncode == 0:
            raise ValueError('An unowned supervisor unit is active')
        previous = {p: p.read_bytes() for p in files if p.exists()}
        if any(p.exists() for p in (KEY, PUBLIC_KEY)) or (previous and not JOURNAL.exists()):
            raise ValueError('Unowned supervisor file exists; refusing overwrite')
        key_tmp, pub_tmp = Path(temp) / 'key.pem', Path(temp) / 'pub.pem'
        i.execute(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', str(key_tmp)])
        i.execute(['openssl', 'pkey', '-in', str(key_tmp), '-pubout', '-out', str(pub_tmp)])
        key, pub = key_tmp.read_text(), pub_tmp.read_text()
        kid = key_id(pub_tmp)
    recorded = {str(p): digest(d) for p, d in files.items()}
    recorded[str(PUBLIC_KEY)] = digest(pub.encode())
    data = dict(version=1, phase='prepared', vm_uuid=i.fence.PROOF_UUID, key_id=kid, files=recorded,
                prepared_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    write_journal(data)
    written = []
    try:
        TARGET.mkdir(mode=0o755, parents=True, exist_ok=True)
        STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        for path, content in files.items():
            written.append(path)
            save_bytes(path, content, 0o644)
        written.append(KEY)
        save_bytes(KEY, key.encode(), 0o600)
        written.append(PUBLIC_KEY)
        save_bytes(PUBLIC_KEY, pub.encode(), 0o644)
        verify_files(data)
        # The daemon refuses to serve unless this journal records its exact files.
        data['phase'] = 'installed'
        write_journal(data)
        i.execute(['systemctl', 'daemon-reload'])
        i.execute(['systemctl', 'enable', '--now', UNIT.name])
        wait_status(kid)
        i.execute(['systemctl', 'enable', '--now', RENEW_TIMER.name])
        return status()
    except BaseException:
        rollback(written, previous)
        data['phase'] = 'rolled_back'
        write_journal(data)
        raise


def remove():
    data = read_journal()
    if data.get('phase') != 'installed':
        raise ValueError('Supervisor is not installed')
    verify_files(data)
    try:
        reply = call('status')
    except OSError:
        reply = None
    if reply and reply.get('ok') and reply['result']['active']:
        raise ValueError('A worker attempt is live; stop it through the operator socket first')
    if str(RENEW_TIMER) in data['files']:
        i.execute(['systemctl', 'disable', '--now', RENEW_TIMER.name])
    i.execute(['systemctl', 'disable', '--now', UNIT.name])
    if subprocess.run(['systemctl', 'is-active', UNIT.name], capture_output=True).returncode == 0:
        raise ValueError('Supervisor unit is still active')
    KEY_ARCHIVE.mkdir(mode=0o700, exist_ok=True)
    # Past receipts stay verifiable with the archived public key.
    save_bytes(KEY_ARCHIVE / f"{data['key_id']}.pem", PUBLIC_KEY.read_bytes(), 0o644)
    for path in [Path(p) for p in data['files']] + [KEY]:
        i.secure(path)
        path.unlink()
    i.execute(['systemctl', 'daemon-reload'])
    data['phase'] = 'removed'
    write_journal(data)
    return dict(removed=True, key_archived=str(KEY_ARCHIVE / f"{data['key_id']}.pem"),
                state_journal_retained=str(STATE_DIR / 'state.json'), fence_retained=True, proxy_retained=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'status', 'remove', 'reinstall'))
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    import fcntl
    lock = Path('/run/proxypilot-a3-fence.lock')
    i.secure(lock)
    with lock.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'reinstall':
            removed = remove() if JOURNAL.exists() and read_journal().get('phase') == 'installed' else None
            result = dict(install(), previous_removed=removed)
        else:
            result = {'install': install, 'status': status, 'remove': remove}[args.action]()
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print('A3 supervisor operation refused: ' + (getattr(error, 'stderr', None) or str(error)).strip(),
              file=sys.stderr)
        sys.exit(1)
