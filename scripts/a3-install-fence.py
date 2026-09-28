#!/usr/bin/env python3
"""Operator-only installer for the single reviewed A3 proof VM.

No guest start/stop, no force, no shell, no shared Incus profile changes,
no global firewall flush and no Incus daemon restart. MCP stops the guest
first. This installs only the network prerequisite, never a worker launcher.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location('a3_fence', Path(__file__).with_name('a3-network-fence.py'))
fence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fence)
CONFIG = Path('/etc/proxypilot-a3-proof')
STATE = Path('/var/lib/proxypilot-a3-proof')
JOURNAL = STATE / 'fence-install.json'
RULES = CONFIG / 'fence.nft'
UNIT = Path('/etc/systemd/system/proxypilot-a3-fence.service')
SNAPSHOT = 'pp-mcp-pre-network-20260927-222658'
MANIFEST = dict(vm_name=fence.VM, vm_uuid=fence.PROOF_UUID, tap=fence.TAP,
                guest_ipv4='10.185.17.179', gateway_ipv4='10.185.17.1')


def execute(argv, **options):
    return subprocess.run(argv, check=True, capture_output=True, text=True,
                          timeout=60, **options).stdout


def parse_json(value, source):
    try:
        return json.loads(value)
    except json.JSONDecodeError as error:
        detail = 'empty output' if not value.strip() else f'invalid JSON at line {error.lineno}, column {error.colno}'
        raise ValueError(f'{source}: {detail}; refusing to assume an empty result') from error


def query(path):
    # incus query suppresses empty metadata objects without --raw. Request
    # the envelope so an empty operations map is distinct from missing output.
    source = 'incus query --raw ' + path
    response = parse_json(execute(['incus', 'query', '--raw', path]), source)
    if (not isinstance(response, dict) or response.get('type') != 'sync'
            or response.get('status_code') != 200 or response.get('error_code', 0) != 0
            or response.get('error') or 'metadata' not in response):
        raise ValueError(f'{source}: unsuccessful or malformed response envelope')
    metadata = response['metadata']
    expected = list if path.endswith('/snapshots') else dict
    if not isinstance(metadata, expected):
        raise ValueError(f'{source}: unexpected metadata type')
    return metadata


def validate_target(instance, network, snapshots, stopped=True):
    cfg = instance.get('config', {})
    if (instance.get('name') != fence.VM or instance.get('type') != 'virtual-machine'
            or cfg.get('volatile.uuid') != fence.PROOF_UUID):
        raise ValueError('VM identity mismatch')
    if stopped and instance.get('status') != 'Stopped':
        raise ValueError('Stop only the proof VM through MCP before this operation')
    for key in ('boot.autostart', 'security.guestapi', 'security.nesting'):
        if cfg.get(key) != 'false':
            raise ValueError(f'{key} must remain false')
    devices = instance.get('expanded_devices', {})
    nics = {k: v for k, v in devices.items() if v.get('type') == 'nic'}
    if set(nics) != {'eth0'} or nics['eth0'].get('network') != 'incusbr0':
        raise ValueError('Expected one NIC on incusbr0')
    local = instance.get('devices', {}).get('eth0')
    if not local or local.get('ipv4.address') != MANIFEST['guest_ipv4']:
        raise ValueError('MCP address reservation/local NIC is missing')
    if network.get('config', {}).get('ipv4.address') != '10.185.17.1/24':
        raise ValueError('Bridge IPv4 configuration changed')
    if network.get('config', {}).get('ipv6.address') != 'fd42:53c1:d5e6:16b0::1/64':
        raise ValueError('Bridge IPv6 configuration differs from the guest static route')
    if (not isinstance(snapshots, list) or not all(isinstance(s, str) for s in snapshots)
            or not any(s.rstrip('/').endswith('/' + SNAPSHOT) for s in snapshots)):
        raise ValueError('Required pre-network snapshot is missing')
    return local.get('host_name')


def inspect(stopped=True):
    instance = query('/1.0/instances/' + fence.VM)
    network = query('/1.0/networks/incusbr0')
    snapshots = query('/1.0/instances/' + fence.VM + '/snapshots')
    validate_target(instance, network, snapshots, stopped)
    operations = query('/1.0/operations?recursion=1')
    for group in operations.values():
        if not isinstance(group, list):
            raise ValueError('Incus operations response has an invalid group')
        for op in group:
            if (not isinstance(op, dict) or not isinstance(op.get('status'), str)
                    or not isinstance(op.get('resources'), dict)
                    or any(not isinstance(values, list) or not all(isinstance(r, str) for r in values)
                           for values in op['resources'].values())):
                raise ValueError('Incus operations response has an invalid operation')
            resources = [r for values in op.get('resources', {}).values() for r in values]
            if op.get('status') in ('Running', 'Pending', 'Cancelling') and any(
                    r.endswith('/' + fence.VM) for r in resources):
                raise ValueError('An Incus operation holds the proof VM')
    return instance


def secure(path):
    """Refuse symlinks or writable-by-others ownership on every ancestor."""
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError(f'Refusing symlink: {part}')
        if part.exists():
            info = part.stat()
            if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                raise ValueError(f'Not exclusively root-owned: {part}')


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def save(path, content, mode=0o644, replace=False):
    secure(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and not replace:
        if path.read_text() != content:
            raise ValueError(f'Refusing to replace unrelated file: {path}')
        return
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), mode)
            stream.write(content)
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


def fingerprint(document):
    def clean(value):
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items() if k not in ('handle', 'packets', 'bytes')}
        if isinstance(value, list):
            return [clean(v) for v in value if not (isinstance(v, dict) and 'metainfo' in v)]
        return value
    return digest(json.dumps(clean(document), sort_keys=True, separators=(',', ':')))


def table():
    return parse_json(execute(['nft', '--json', 'list', 'table', 'bridge', fence.TABLE]),
                      'nft list bridge ' + fence.TABLE)


def read_journal():
    secure(JOURNAL)
    data = parse_json(JOURNAL.read_text(), str(JOURNAL))
    if data.get('vm_uuid') != fence.PROOF_UUID or data.get('version') != 1:
        raise ValueError('Invalid A3 installation journal')
    return data


def write_journal(data):
    save(JOURNAL, json.dumps(data, indent=2) + '\n', mode=0o600, replace=True)


def verify_files(data):
    for path in (RULES, UNIT):
        secure(path)
        if digest(path.read_text()) != data['files'][str(path)]:
            raise ValueError(f'Owned file changed: {path}')


def install():
    instance = inspect()
    for path in (CONFIG, STATE, UNIT):
        secure(path)
    rules, unit = fence.render(MANIFEST), fence.unit()
    execute(['nft', '--check', '--file', '-'], input=rules)
    # Verify the unit on Linux before any durable file or VM change.
    with tempfile.TemporaryDirectory(prefix='pp-a3-unit-') as tmp:
        candidate = Path(tmp) / UNIT.name
        candidate.write_text(unit)
        execute(['systemd-analyze', 'verify', str(candidate)])
    if JOURNAL.exists():
        data = read_journal()
        if data.get('phase') == 'removed':
            raise ValueError('Previous installation removed; explicit new review required')
        if data.get('phase') == 'installed':
            return status()
        raise ValueError('Incomplete installation; keep VM stopped and review journal before recovery')
    else:
        if RULES.exists() or UNIT.exists():
            raise ValueError('Unowned A3 file exists; refusing overwrite')
        tables = parse_json(execute(['nft', '--json', 'list', 'tables']), 'nft list tables')
        if any(row.get('table', {}).get('family') == 'bridge' and
               row.get('table', {}).get('name') == fence.TABLE for row in tables['nftables']):
            raise ValueError('Unowned A3 nft table exists')
        if Path('/sys/class/net', fence.TAP).exists():
            raise ValueError('Planned TAP name is already occupied')
        data = dict(version=1, phase='prepared', vm_uuid=fence.PROOF_UUID,
                    previous_host_name=instance['devices']['eth0'].get('host_name'),
                    snapshot=SNAPSHOT, files={str(RULES): digest(rules), str(UNIT): digest(unit)})
        write_journal(data)
    if data['files'] != {str(RULES): digest(rules), str(UNIT): digest(unit)}:
        raise ValueError('Installer source differs from the recorded transaction')
    save(RULES, rules)
    save(UNIT, unit)
    # Apply the drop boundary first. Never start the VM here, even on success.
    execute(['nft', '--file', str(RULES)])
    data['table_fingerprint'] = fingerprint(table())
    data['phase'] = 'fenced'
    write_journal(data)
    inspect()  # Recheck stopped identity immediately before the NIC change.
    execute(['incus', 'config', 'device', 'set', fence.VM, 'eth0', 'host_name', fence.TAP])
    bound = inspect()
    if bound['devices']['eth0'].get('host_name') != fence.TAP:
        raise ValueError('Fixed host interface was not read back')
    execute(['systemctl', 'daemon-reload'])
    execute(['systemctl', 'enable', '--now', UNIT.name])
    data['phase'] = 'installed'
    write_journal(data)
    return status()


def status():
    instance = inspect(stopped=False)
    data = read_journal()
    verify_files(data)
    if data.get('phase') != 'installed' or fingerprint(table()) != data.get('table_fingerprint'):
        raise ValueError('A3 table is missing, changed, or incomplete')
    if instance['devices']['eth0'].get('host_name') != fence.TAP:
        raise ValueError('VM interface is not bound to the fence')
    for action in ('is-enabled', 'is-active'):
        execute(['systemctl', action, UNIT.name])
    if execute(['systemctl', 'show', UNIT.name, '--property=DropInPaths', '--value']).strip():
        raise ValueError('Unexpected override on owned fence service')
    if execute(['systemctl', 'show', UNIT.name, '--property=NeedDaemonReload', '--value']).strip() != 'no':
        raise ValueError('Loaded fence unit does not match disk')
    if execute(['systemctl', 'show', UNIT.name, '--property=FragmentPath', '--value']).strip() != str(UNIT):
        raise ValueError('Unexpected loaded fence unit path')
    return dict(installed=True, vm_uuid=fence.PROOF_UUID, vm_status=instance['status'],
                tap=fence.TAP, service='active/enabled', counters=[r['counter'] for r in
                table()['nftables'] if 'counter' in r], worker_ready=False,
                notice='Network prerequisite only; proxy, supervisor and live proofs remain open')


def remove():
    instance = inspect()  # Never remove a fence from a running VM.
    data = read_journal()
    verify_files(data)
    if fingerprint(table()) != data.get('table_fingerprint'):
        raise ValueError('A3 table changed; refusing automatic removal')
    if instance['devices']['eth0'].get('host_name') != fence.TAP:
        raise ValueError('VM binding changed; refusing automatic rollback')
    old = data['previous_host_name']
    argv = ['incus', 'config', 'device', 'set' if old else 'unset', fence.VM, 'eth0', 'host_name']
    if old:
        argv.append(old)
    execute(argv)
    after = inspect()
    if after['devices']['eth0'].get('host_name') != old:
        raise ValueError('Previous NIC setting was not restored')
    execute(['systemctl', 'disable', '--now', UNIT.name])
    # Rule deletion is last, after stopped identity and NIC rollback readback.
    execute(['nft', 'delete', 'table', 'bridge', fence.TABLE])
    RULES.unlink()
    UNIT.unlink()
    execute(['systemctl', 'daemon-reload'])
    data['phase'] = 'removed'
    write_journal(data)
    return dict(removed=True, vm_status='Stopped', guest_static_file_retained=True,
                notice='Restore guest networking through MCP before any later unfenced boot')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'status', 'remove'))
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    import fcntl
    lock = Path('/run/proxypilot-a3-fence.lock')
    secure(lock)
    with lock.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps({'install': install, 'status': status, 'remove': remove}[args.action](), indent=2))


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print((error.stderr or str(error)).strip(), file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(f'A3 fence operation refused: {error}', file=sys.stderr)
        sys.exit(1)
