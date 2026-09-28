#!/usr/bin/env python3
"""Operator-only cgroup enforcement probe on the single disposable A3 VM.

Each workload is a fixed Python fixture in a transient guest systemd service.
The host observes exit status and tears down the exact unit on every path.
This is a prerequisite measurement, not an A3 worker launcher.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

source = Path(__file__).with_name('a3-install-proxy.py')
spec = importlib.util.spec_from_file_location('a3_proxy_install', source)
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

PREFIX = 'pp-a3-cgroup-proof-'
CASES = {
    'cpu': (
        ['CPUQuota=25%', 'CPUQuotaPeriodSec=100ms'],
        """import pathlib,time
p=pathlib.Path('/sys/fs/cgroup'+pathlib.Path('/proc/self/cgroup').read_text().strip().split(':')[-1])
def throttled():
 return int(dict(line.split() for line in (p/'cpu.stat').read_text().splitlines())['nr_throttled'])
before=throttled(); end=time.monotonic()+2
while time.monotonic()<end: pass
print('THROTTLED='+str(throttled()-before),flush=True)
""", 'THROTTLED=', True),
    'memory': (
        ['MemoryMax=64M', 'MemorySwapMax=0'],
        """print('ALLOCATING',flush=True)
blocks=[bytearray(1024*1024) for _ in range(192)]
print('MEMORY_LIMIT_FAILED',flush=True)
""", 'ALLOCATING', False),
    'process': (
        ['TasksMax=8'],
        """import subprocess
children=[]
try:
 for _ in range(32): children.append(subprocess.Popen(['/usr/bin/sleep','10']))
 print('PROCESS_LIMIT_FAILED',flush=True)
except OSError as error:
 print('PROCESS_DENIED='+str(error.errno),flush=True)
finally:
 for child in children: child.kill()
 for child in children: child.wait()
""", 'PROCESS_DENIED=', True),
    'time': (
        ['RuntimeMaxSec=2s'],
        """import time
print('SLEEPING',flush=True);time.sleep(10);print('TIME_LIMIT_FAILED',flush=True)
""", 'SLEEPING', False),
    'disk': (
        ['TemporaryFileSystem=/tmp:rw,nosuid,nodev,size=16M,mode=1777'],
        """import errno
try:
 with open('/tmp/a3-quota-test','wb') as stream:
  for _ in range(32): stream.write(b'x'*1024*1024)
 print('DISK_LIMIT_FAILED',flush=True)
except OSError as error:
 if error.errno!=errno.ENOSPC: raise
 print('DISK_DENIED=ENOSPC',flush=True)
""", 'DISK_DENIED=ENOSPC', True),
}


def guest(argv, timeout=35, check=False):
    result = subprocess.run(['incus', 'exec', proxy.i.fence.VM, '--', *argv],
                            capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise ValueError('Guest command failed: ' + result.stderr[-700:])
    return result


def unit_state(name):
    result = guest(['systemctl', 'show', name, '--property=ActiveState',
                    '--property=ControlGroup', '--property=Result', '--no-pager'])
    if result.returncode:
        return {'ActiveState': 'unknown', 'ControlGroup': '', 'Result': 'unknown'}
    values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if not {'ActiveState', 'ControlGroup', 'Result'} <= values.keys():
        raise ValueError('Incomplete guest unit readback')
    return values


def assert_unit_empty(name, state):
    group = state['ControlGroup']
    if not group:
        return
    if group != '/system.slice/' + name + '.service':
        raise ValueError('Unexpected guest cgroup for ' + name)
    code = """import pathlib,sys
p=pathlib.Path('/sys/fs/cgroup')/sys.argv[1].lstrip('/')
if p.exists() and 'populated 1' in (p/'cgroup.events').read_text().splitlines():
 raise SystemExit('Guest unit still has live descendants')
"""
    result = guest(['/usr/bin/python3', '-c', code, group], timeout=10)
    if result.returncode:
        raise ValueError('Guest unit descendants survived cleanup: ' + name)


def probe(name, properties, code, marker, success):
    unit = PREFIX + name + '-' + str(os.getpid())
    if not re.fullmatch(r'[a-z0-9-]+', unit):
        raise ValueError('Invalid fixed unit name')
    state = unit_state(unit)
    if state['ActiveState'] not in ('inactive', 'unknown'):
        raise ValueError('An A3 proof unit already exists: ' + unit)
    props = ['User=nobody', 'Group=nogroup', 'NoNewPrivileges=yes',
             'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateDevices=yes',
             'KillMode=control-group', *properties]
    argv = ['systemd-run', '--wait', '--pipe', '--unit=' + unit,
            *['--property=' + value for value in props],
            '/usr/bin/python3', '-c', code]
    started = time.monotonic()
    try:
        result = guest(argv, timeout=30)
    finally:
        # A host timeout or transport failure must not leave a guest workload.
        guest(['systemctl', 'stop', unit], timeout=15)
        cleanup = unit_state(unit)
        if cleanup['ActiveState'] not in ('inactive', 'failed', 'unknown'):
            raise ValueError('Guest proof unit survived forced cleanup: ' + unit)
        assert_unit_empty(unit, cleanup)
    elapsed = round(time.monotonic() - started, 3)
    state = cleanup
    if marker not in result.stdout or (result.returncode == 0) != success:
        raise ValueError(name + ' cgroup proof failed: ' + json.dumps({
            'exit_code': result.returncode, 'stdout_tail': result.stdout[-400:],
            'stderr_tail': result.stderr[-400:], 'state': state}))
    if name == 'cpu':
        match = re.search(r'THROTTLED=(\d+)', result.stdout)
        if not match or int(match.group(1)) == 0:
            raise ValueError('CPU quota showed no throttling')
    return {'case': name, 'exit_code': result.returncode,
            'seconds': elapsed, 'unit_result': state['Result'],
            'unit_active': state['ActiveState'], 'enforced': True}


def run():
    proxy.status()
    proxy.i.inspect(stopped=False)
    before = proxy.i.query('/1.0/instances/' + proxy.i.fence.VM + '/state')
    if before.get('status') != 'Running':
        raise ValueError('Proof VM is not running')
    identity = guest(['/usr/bin/python3', '-c',
                      "import json,pathlib;print(json.dumps({'boot_id':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'controllers':pathlib.Path('/sys/fs/cgroup/cgroup.controllers').read_text().strip()}))"],
                     check=True)
    guest_info = proxy.i.parse_json(identity.stdout, 'guest cgroup identity')
    if not {'cpu', 'memory', 'pids'} <= set(guest_info.get('controllers', '').split()):
        raise ValueError('Required unified cgroup controllers unavailable')
    results = [probe(name, *args) for name, args in CASES.items()]
    after = proxy.i.query('/1.0/instances/' + proxy.i.fence.VM + '/state')
    if after.get('pid') != before.get('pid') or after.get('status') != 'Running':
        raise ValueError('Proof VM changed during resource tests')
    return {'vm_uuid': proxy.i.fence.PROOF_UUID,
            'boot_id': guest_info['boot_id'], 'cases': results,
            'worker_ready': False,
            'notice': 'Guest cgroup enforcement only; broker and supervisor remain open'}


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise ValueError('Run in the host root terminal')
        print(json.dumps(run(), indent=2))
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print('A3 guest cgroup proof stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
