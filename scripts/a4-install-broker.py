#!/usr/bin/env python3
"""Operator-only installer for the A4 credential and provider broker.

Copies the reviewed broker into root-owned /etc/proxypilot-a4/broker and
installs one systemd unit. It never touches the A3 fence, proxy, supervisor,
the proof VM, Incus configuration or any other guest. Every file is
digest-recorded before activation and read back afterwards; a failed
activation is rolled back to the files present before this run.

`configure` records the OpenBao address, mount names and agent name, and asks
for the AppRole role ID and secret ID without echo (issued once by Platform
Setup -> Agents and machines; never passed on a command line, never printed).
The file is root-only (0600). `remove` deletes it too; issue a new secret ID in
the dashboard afterwards so the removed one is dead.
"""
import argparse
import getpass
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

spec = importlib.util.spec_from_file_location('a4_broker_module', Path(__file__).with_name('a4-credential-broker.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
SOURCE = Path(__file__).with_name('a4-credential-broker.py')
TARGET = broker.INSTALL_DIR / 'a4-credential-broker.py'
UNIT = broker.UNIT
JOURNAL = broker.INSTALL_JOURNAL
STATE_DIR = broker.JOURNAL.parent
UNIT_TEXT = '''[Unit]
Description=A4 credential and provider broker for the A3 proof VM
Wants=network-online.target
After=network-online.target incus.service docker.service
RequiresMountsFor=/etc/proxypilot-a4 /var/lib/proxypilot-a4

[Service]
Type=simple
ExecStart=/usr/bin/python3 -I /etc/proxypilot-a4/broker/a4-credential-broker.py --serve
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=30
UMask=0077
RuntimeDirectory=proxypilot-a4
RuntimeDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes
MemoryMax=128M
TasksMax=64

[Install]
WantedBy=multi-user.target
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save_bytes(path, data, mode):
    broker.secure(path)
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


def execute(argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=90).stdout


def plan_files(source=SOURCE):
    data = source.read_bytes()
    if not data.startswith(b'#!/usr/bin/env python3\n'):
        raise ValueError('Unreviewed broker source')
    compile(data.decode('utf-8'), source.name, 'exec')
    return {TARGET: data, UNIT: UNIT_TEXT.encode()}


def read_journal():
    broker.secure(JOURNAL)
    data = json.loads(JOURNAL.read_text())
    if data.get('version') != 1 or data.get('vm_uuid') != broker.VM_UUID:
        raise ValueError('Invalid broker installation journal')
    return data


def write_journal(data):
    broker.save(JOURNAL, json.dumps(data, indent=2) + '\n')


def call(method, params=None, timeout=30):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(timeout)
        client.connect(str(broker.SOCKET))
        client.sendall((json.dumps({'method': method, 'params': params or {}}) + '\n').encode())
        return json.loads(client.makefile().readline())


def verify_files(data):
    for path, want in data['files'].items():
        path = Path(path)
        broker.secure(path)
        if digest(path.read_bytes()) != want:
            raise ValueError(f'Broker-owned file changed: {path}')


def unit_checks():
    execute(['systemctl', 'is-active', UNIT.name])
    execute(['systemctl', 'is-enabled', UNIT.name])
    show = lambda prop: execute(['systemctl', 'show', UNIT.name, f'--property={prop}', '--value']).strip()  # noqa: E731
    if show('FragmentPath') != str(UNIT) or show('DropInPaths') or show('NeedDaemonReload') != 'no':
        raise ValueError('Loaded broker unit does not match the installed file')


def wait_status(expected_sha):
    deadline, last = time.monotonic() + 30, None
    while time.monotonic() < deadline:
        try:
            reply = call('status')
            if reply.get('ok') and reply['result']['broker']['broker_sha256'] == expected_sha:
                return reply['result']
            last = reply
        except (OSError, ValueError) as error:
            last = str(error)
        time.sleep(1)
    raise ValueError(f'Broker did not answer with the installed bytes: {last}')


def status():
    data = read_journal()
    if data.get('phase') != 'installed':
        raise ValueError(f"Broker installation phase is {data.get('phase')}")
    verify_files(data)
    unit_checks()
    reply = call('status')
    if not reply.get('ok'):
        raise ValueError(f'Broker status refused: {reply}')
    result = reply['result']
    return dict(installed=True, service='active/enabled', files=data['files'], socket=str(broker.SOCKET),
                config_present=broker.CONFIG.is_file(), vault_healthy=result['vault_healthy'],
                routes=result['routes'], bindings=result['bindings'], prices=result['prices'],
                provider=result['provider'],
                notice='Broker installed; A4 proof needs configure, bind, provider, price and a4-probe.py')


def rollback(written, previous):
    subprocess.run(['systemctl', 'disable', '--now', UNIT.name], capture_output=True, timeout=90)
    for path in written:
        if path in previous:
            save_bytes(path, previous[path], 0o644)
        else:
            path.unlink(missing_ok=True)
    subprocess.run(['systemctl', 'daemon-reload'], capture_output=True, timeout=60)


def install():
    for path in (TARGET, UNIT, JOURNAL, STATE_DIR, broker.CONFIG):
        broker.secure(path)
    files = plan_files()
    with tempfile.TemporaryDirectory(prefix='pp-a4-broker-') as temp:
        candidate = Path(temp) / UNIT.name
        candidate.write_text(UNIT_TEXT)
        execute(['systemd-analyze', 'verify', str(candidate)])
    if JOURNAL.exists():
        data = read_journal()
        if data.get('phase') == 'installed':
            return status()
        if data.get('phase') not in ('removed', 'rolled_back'):
            raise ValueError('Incomplete broker installation; review the journal before recovery')
    if subprocess.run(['systemctl', 'is-active', UNIT.name], capture_output=True).returncode == 0:
        raise ValueError('An unowned broker unit is active')
    previous = {p: p.read_bytes() for p in files if p.exists()}
    if previous and not JOURNAL.exists():
        raise ValueError('Unowned broker file exists; refusing overwrite')
    data = dict(version=1, phase='prepared', vm_uuid=broker.VM_UUID,
                files={str(p): digest(d) for p, d in files.items()},
                prepared_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    write_journal(data)
    written = []
    try:
        broker.INSTALL_DIR.mkdir(mode=0o755, parents=True, exist_ok=True)
        STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        for path, content in files.items():
            written.append(path)
            save_bytes(path, content, 0o644)
        verify_files(data)
        data['phase'] = 'installed'
        write_journal(data)
        execute(['systemctl', 'daemon-reload'])
        execute(['systemctl', 'enable', '--now', UNIT.name])
        wait_status(data['files'][str(TARGET)])
        return status()
    except BaseException:
        rollback(written, previous)
        data['phase'] = 'rolled_back'
        write_journal(data)
        raise


def remove():
    data = read_journal()
    if data.get('phase') != 'installed':
        raise ValueError('Broker is not installed')
    verify_files(data)
    execute(['systemctl', 'disable', '--now', UNIT.name])
    if subprocess.run(['systemctl', 'is-active', UNIT.name], capture_output=True).returncode == 0:
        raise ValueError('Broker unit is still active')
    for path in [Path(p) for p in data['files']]:
        broker.secure(path)
        path.unlink()
    config_removed = False
    if broker.CONFIG.exists():
        broker.secure(broker.CONFIG)
        broker.CONFIG.unlink()
        config_removed = True
    execute(['systemctl', 'daemon-reload'])
    data['phase'] = 'removed'
    write_journal(data)
    return dict(removed=True, state_journal_retained=str(broker.JOURNAL), approle_config_removed=config_removed,
                notice='Issue a new OpenBao secret ID for the agent in the dashboard so the removed one is dead.')


def build_config(address, approle_mount, kv_mount, agent, prompt=None):
    """The AppRole credentials are typed without echo; nothing is printed back."""
    prompt = prompt or getpass.getpass
    config = {'address': address, 'approle_mount': approle_mount, 'kv_mount': kv_mount, 'agent': agent,
              'role_id': prompt('OpenBao role ID for agent %s: ' % agent).strip(),
              'secret_id': prompt('OpenBao secret ID (shown once in the dashboard): ').strip()}
    broker.Vault(config)   # Validates every field before anything is written.
    return config


def configure(args):
    broker.secure(broker.CONFIG)
    config = build_config(args.address, args.approle_mount, args.kv_mount, args.agent)
    vault = broker.Vault(config)
    try:
        vault._token()
        login = 'ok'
    except broker.Refused as error:
        login = error.code
    if login != 'ok':
        raise ValueError(f'AppRole login refused ({login}); nothing was written')
    broker.save(broker.CONFIG, json.dumps(config) + '\n', mode=0o600)
    return dict(configured=True, config=str(broker.CONFIG), mode='0600', address=config['address'],
                approle_mount=config['approle_mount'], kv_mount=config['kv_mount'], agent=config['agent'],
                approle_login=login, restart='systemctl restart proxypilot-a4-broker.service (if installed)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for name in ('install', 'status', 'remove', 'reinstall'):
        sub.add_parser(name)
    conf = sub.add_parser('configure')
    conf.add_argument('--address', default='http://127.0.0.1:18200')
    conf.add_argument('--approle-mount', required=True)
    conf.add_argument('--kv-mount', required=True)
    conf.add_argument('--agent', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    if args.action == 'configure':
        result = configure(args)
    elif args.action == 'reinstall':
        removed = None
        if JOURNAL.exists() and read_journal().get('phase') == 'installed':
            # Keep the AppRole config across a code reinstall.
            saved = broker.CONFIG.read_bytes() if broker.CONFIG.exists() else None
            removed = remove()
            if saved is not None:
                save_bytes(broker.CONFIG, saved, 0o600)
                removed['approle_config_removed'] = False
        result = dict(install(), previous_removed=removed)
    else:
        result = {'install': install, 'status': status, 'remove': remove}[args.action]()
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, broker.Refused) as error:
        detail = getattr(error, 'stderr', None) or getattr(error, 'code', None) or str(error)
        print('A4 broker operation refused: ' + str(detail).strip(), file=sys.stderr)
        sys.exit(1)
