#!/usr/bin/env python3
"""Host-owned A3 worker supervisor for the single reviewed proof VM.

Root only. a3-install-supervisor.py installs reviewed copies of this file,
the guest runner and the fence/proxy modules under
/etc/proxypilot-a3-proof/supervisor; the git checkout is never executed.

The ProxyPilot backend (and, later, the agent coordinator) may ask only for
status, a typed launch, lease renewal, one fixed browser action, or stop. It
never passes argv, a URL, a path, a unit property, an Incus/Docker call or a
browser endpoint. A launch requires the installed fence and origin proxy, the
exact VM UUID and a readable boot generation, and this supervisor's own
reviewed files. Each attempt is one transient guest unit: one cgroup, one
private tmpfs workspace and one Chromium tree, with the configured CPU,
memory, temporary-disk and run-time limits plus fixed OS limits. Budgets are
pinned per run in this host journal, so a new attempt, lease renewal or a
backend restart cannot reset them. Every stop ends with host readback that
the unit, its descendants and its workspace are gone, and a receipt signed by
a host-held Ed25519 key that the backend never sees. An uncertain browser
effect is recorded and never replayed. Human view and control exist only on
the root operator socket, after takeover fences the model's attempt.

A4: a launch may pin one credential binding (project, profile and binding
UUIDs with the profile and binding revisions). The pin is registered with the
host credential broker (a separate root daemon, a4-credential-broker.py) and
the run's token/spending limits are pinned there too. `submit_bound_fixture`
carries only the binding ID: this supervisor asks the broker to check the
binding, sends the runner the action with the binding ID, and asks the broker
to deliver; the broker writes the value to the runner's one-shot FIFO itself.
This process never holds the value. Results, the journal and receipts carry the
binding ID, revision and outcome only. A browser attempt that submitted a
credential signs out (POST /api/logout) before teardown.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent


def _module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _module('a3_supervisor_proxy_install', 'a3-install-proxy.py')
installer = proxy.i
fence = installer.fence
runner = _module('a3_supervisor_worker_guest', 'a3-worker-guest.py')

VM = fence.VM
VM_UUID = fence.PROOF_UUID
MAC = '10:66:6a:55:f6:3f'
GUEST_NIC = 'enp5s0'
ORIGIN = 'https://demo.fractionate.ai'
TARGET = 'incus-disposable-vm-browser-v1'
PROXY_ADDRESS = '10.185.17.1'
STATE_DIR = installer.STATE / 'supervisor'
JOURNAL = STATE_DIR / 'state.json'
INSTALL_JOURNAL = installer.STATE / 'supervisor-install.json'
KEY = installer.CONFIG / 'supervisor-key.pem'
PUBLIC_KEY = installer.CONFIG / 'supervisor-pub.pem'
UNIT = Path('/etc/systemd/system/proxypilot-a3-supervisor.service')
RUN_DIR = Path('/run/proxypilot-a3')
BACKEND_SOCKET = RUN_DIR / 'supervisor.sock'
OPERATOR_SOCKET = RUN_DIR / 'operator.sock'
BROKER_SOCKET = Path('/run/proxypilot-a4/broker.sock')
CREDENTIAL_FIELDS = ('project_id', 'profile_id', 'profile_revision', 'binding_id', 'binding_revision')
DELIVERY_SECONDS = 40
STOP_SECONDS = 12
UNIT_PREFIX = 'pp-a3-worker-'
LEASE_SECONDS = 30
READY_SECONDS = 60
ACTION_SECONDS = 30
HEALTH_SECONDS = 10
PING_SECONDS = 5
# The installed VM is capacity, not a project quota. Project CPU, memory and
# temporary-disk limits apply to the worker unit inside it. The minimums are
# provisional until the lifecycle proof's measured browser peak confirms them.
INSTALL_BASELINE = {'cpu': 2, 'memory_mib': 4096, 'root_disk_gib': 12}
INSTALL_RESERVE_MIB = 1024
WORKER_MINIMUM = {'cpu': 1, 'memory_mib': 1024, 'temporary_disk_mib': 64}
GUEST_RESERVE_MIB = 768
DEFAULT_TEMPORARY_DISK_MIB = 512
SHM_MIB = 128
TASKS_MAX = 512
LIMIT_KEYS = frozenset(('cpu', 'memory_mib', 'temporary_disk_mib', 'max_seconds', 'max_actions',
                        'max_tokens', 'max_usd'))
MAX_SAFE = 2 ** 53 - 1
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
HEX64 = re.compile(r'[0-9a-f]{64}\Z')
BACKEND_METHODS = frozenset(('status', 'launch', 'renew', 'action', 'stop'))
OPERATOR_METHODS = BACKEND_METHODS | frozenset(('takeover', 'view', 'input', 'observe', 'locate',
                                                'egress_probe', 'proof', 'unit_stats', 'journal',
                                                'proof_crash_mid_action'))
BACKEND_STOP_REASONS = frozenset(('cancelled', 'blocked', 'failed'))
OPERATOR_STOP_REASONS = BACKEND_STOP_REASONS | frozenset(('taken_over', 'proof'))
TERMINAL = frozenset(('stopped', 'lost', 'refused'))
LIVE = frozenset(('launching', 'running', 'human', 'stopping'))


class Refused(Exception):
    """A typed refusal. Only the code and a short detail leave the process."""

    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code = code
        self.detail = None if detail is None else str(detail)[:300]


def now():
    return time.time()


def stamp(value=None):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now() if value is None else value))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def exact(value, names):
    return isinstance(value, dict) and set(value) == set(names)


def safe_int(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_SAFE


def validate_limits(value):
    if not isinstance(value, dict) or not set(value) <= LIMIT_KEYS:
        raise Refused('INVALID_LAUNCH', 'limits')
    for key, item in value.items():
        if key == 'max_usd':
            if type(item) not in (int, float) or not math.isfinite(item) or item <= 0:
                raise Refused('INVALID_LAUNCH', key)
        elif not safe_int(item, 1):
            raise Refused('INVALID_LAUNCH', key)
    return dict(value)


def install_shape(limits):
    """Mirror of workerInstallResources in operational-worker-boundary.js."""
    return {'cpu': max(INSTALL_BASELINE['cpu'], limits.get('cpu', 0)),
            'memory_mib': max(INSTALL_BASELINE['memory_mib'], limits.get('memory_mib', 0) + INSTALL_RESERVE_MIB),
            'root_disk_gib': INSTALL_BASELINE['root_disk_gib']}


def validate_credential(value):
    """A4 launch pin: operator-authorized UUIDs and revisions, never a value."""
    if (not exact(value, CREDENTIAL_FIELDS) or not all(isinstance(value[k], str) and UUID.fullmatch(value[k])
                                                        for k in ('project_id', 'profile_id', 'binding_id'))
            or not safe_int(value['profile_revision'], 1) or not safe_int(value['binding_revision'], 1)):
        raise Refused('INVALID_LAUNCH', 'credential')
    return dict(value)


def validate_launch(value):
    names = ('run_id', 'attempt_id', 'workspace_id', 'fence', 'policy_digest', 'project_limits_revision',
             'origin', 'target', 'limits', 'install')
    if not exact(value, names) and not exact(value, names + ('credential',)):
        raise Refused('INVALID_LAUNCH', 'fields')
    if (not all(isinstance(value[k], str) and UUID.fullmatch(value[k]) for k in ('run_id', 'attempt_id', 'workspace_id'))
            or not safe_int(value['fence'], 1) or not isinstance(value['policy_digest'], str)
            or not HEX64.fullmatch(value['policy_digest']) or not safe_int(value['project_limits_revision'], 0)
            or value['origin'] != ORIGIN or value['target'] != TARGET):
        raise Refused('INVALID_LAUNCH')
    limits = validate_limits(value['limits'])
    for key, minimum in WORKER_MINIMUM.items():
        if key in limits and limits[key] < minimum:
            raise Refused('PROJECT_LIMIT_BELOW_WORKER_MINIMUM', key)
    if value['install'] != install_shape(limits):
        raise Refused('INVALID_LAUNCH', 'install')
    credential = None if 'credential' not in value else validate_credential(value['credential'])
    return dict(value, limits=limits, credential=credential)


def validate_ref(value, extra=()):
    names = ('run_id', 'attempt_id', 'fence', *extra)
    if (not exact(value, names) or not all(isinstance(value[k], str) and UUID.fullmatch(value[k])
                                            for k in ('run_id', 'attempt_id'))
            or not safe_int(value['fence'], 1)):
        raise Refused('INVALID_REQUEST')
    return value


def worker_plan(limits, guest_memory_kib, vm_cpus):
    """Derive the unit limits. A configured limit is never silently raised."""
    for key, minimum in WORKER_MINIMUM.items():
        if key in limits and limits[key] < minimum:
            raise Refused('PROJECT_LIMIT_BELOW_WORKER_MINIMUM', key)
    ceiling = guest_memory_kib // 1024 - GUEST_RESERVE_MIB
    memory = limits.get('memory_mib', ceiling)
    if ceiling < WORKER_MINIMUM['memory_mib'] or memory > ceiling:
        raise Refused('VM_CAPACITY_INSUFFICIENT', 'memory')
    disk = limits.get('temporary_disk_mib', min(DEFAULT_TEMPORARY_DISK_MIB, memory // 2))
    if disk >= memory:
        raise Refused('TEMPORARY_DISK_EXCEEDS_WORKER_MEMORY')
    cpu = limits.get('cpu')
    if cpu is not None and cpu > vm_cpus:
        raise Refused('VM_CAPACITY_INSUFFICIENT', 'cpu')
    return {'memory_mib': memory, 'memory_source': 'project' if 'memory_mib' in limits else 'vm_ceiling',
            'temporary_disk_mib': disk,
            'temporary_disk_source': 'project' if 'temporary_disk_mib' in limits else 'safe_default',
            'cpu_quota_percent': cpu * 100 if cpu is not None else None, 'shm_mib': SHM_MIB,
            'tasks_max': TASKS_MAX}


def unit_properties(plan, runtime_seconds):
    props = [
        'User=nobody', 'Group=nogroup', 'NoNewPrivileges=yes', 'UMask=0077',
        'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateDevices=yes', 'PrivateIPC=yes',
        'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes',
        'ProtectControlGroups=yes', 'ProtectClock=yes', 'ProtectHostname=yes',
        'ProtectProc=invisible', 'RestrictSUIDSGID=yes', 'RestrictRealtime=yes',
        'LockPersonality=yes', 'CapabilityBoundingSet=', 'AmbientCapabilities=',
        'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
        'IPAddressDeny=any', 'IPAddressAllow=%s/32' % PROXY_ADDRESS,
        'TemporaryFileSystem=/tmp:rw,nosuid,nodev,size=%dM,mode=0700,uid=65534,gid=65534'
        % plan['temporary_disk_mib'],
        'TemporaryFileSystem=/dev/shm:rw,nosuid,nodev,noexec,size=%dM,mode=1777' % plan['shm_mib'],
        'TemporaryFileSystem=/run:ro', 'TemporaryFileSystem=/var:ro',
        'InaccessiblePaths=-/srv -/opt -/mnt -/media -/boot',
        'WorkingDirectory=/tmp', 'Environment=LANG=C.UTF-8 PATH=/usr/bin:/bin',
        'MemoryMax=%dM' % plan['memory_mib'], 'MemorySwapMax=0', 'TasksMax=%d' % plan['tasks_max'],
        'CPUWeight=50', 'OOMPolicy=kill', 'KillMode=control-group', 'TimeoutStopSec=5s',
        'SendSIGKILL=yes', 'LimitCORE=0']
    if plan['cpu_quota_percent'] is not None:
        props.append('CPUQuota=%d%%' % plan['cpu_quota_percent'])
    if runtime_seconds is not None:
        props.append('RuntimeMaxSec=%ds' % runtime_seconds)
    return props


def expected_cgroup(plan):
    quota = plan['cpu_quota_percent']
    return {'memory.max': str(plan['memory_mib'] * 1024 * 1024), 'memory.swap.max': '0',
            'pids.max': str(plan['tasks_max']),
            'cpu.max': ('%d 100000' % (quota * 1000)) if quota is not None else 'max 100000'}


TIMESPAN = {'us': 1e-6, 'ms': 1e-3, 's': 1, 'min': 60, 'h': 3600, 'd': 86400, 'w': 604800}


def parse_timespan(value):
    """systemd `show` timespans such as '1min 30s'; 'infinity' is None."""
    if value == 'infinity':
        return None
    total = 0.0
    for number, unit in re.findall(r'(\d+(?:\.\d+)?)\s*(us|ms|min|s|h|d|w)', value):
        total += float(number) * TIMESPAN[unit]
    if not re.fullmatch(r'(\s*\d+(?:\.\d+)?\s*(us|ms|min|s|h|d|w))+\s*', value):
        raise Refused('UNIT_READBACK_FAILED', 'timespan')
    return total


def size_mib(value):
    match = re.fullmatch(r'(\d+)(MiB|GiB|MB|GB|)', str(value or ''))
    if not match:
        raise Refused('BOUNDARY_UNVERIFIED', 'size %r' % value)
    number, unit = int(match.group(1)), match.group(2)
    factor = {'MiB': 1, 'GiB': 1024, 'MB': 1e6 / 1048576, 'GB': 1e9 / 1048576, '': 1 / 1048576}[unit]
    return int(number * factor)


def summary(stderr_tail):
    """systemd-run --wait summary lines, when present."""
    text = stderr_tail.decode('utf-8', 'replace') if isinstance(stderr_tail, bytes) else stderr_tail
    found = {}
    for key, pattern in (('result', r'Finished with result: (\S+)'),
                         ('main_exit', r'Main processes terminated with: (code=\S+, status=\S+)'),
                         ('runtime', r'Service runtime: ([^\n]+)'),
                         ('cpu_time', r'CPU time consumed: ([^\n]+)'),
                         ('memory_peak', r'Memory peak: ([^\n]+)')):
        match = re.search(pattern, text)
        if match:
            found[key] = match.group(1).strip()
    return found


def process_tree_rss_kib(pid, proc_root=Path('/proc')):
    """Host QEMU plus every descendant; a lost root is a refusal."""
    processes = {}
    for directory in proc_root.iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            text = (directory / 'status').read_text()
        except (OSError, UnicodeError):
            continue
        fields = {}
        for line in text.splitlines():
            if line.startswith(('PPid:', 'VmRSS:')):
                key, value = line.split(':', 1)
                fields[key] = int(value.strip().split()[0])
        if 'PPid' in fields:
            processes[int(directory.name)] = (fields['PPid'], fields.get('VmRSS', 0))
    if pid not in processes:
        raise Refused('BOUNDARY_UNVERIFIED', 'QEMU process disappeared')
    selected = {pid}
    while True:
        more = {child for child, (parent, _) in processes.items() if parent in selected}
        if more <= selected:
            break
        selected |= more
    return sum(processes[p][1] for p in selected), len(selected)


GUEST_IDENTITY = '''import json, os
mem = [l for l in open('/proc/meminfo') if l.startswith('MemTotal:')][0].split()[1]
print(json.dumps({'boot_id': open('/proc/sys/kernel/random/boot_id').read().strip(),
                  'mac': open('/sys/class/net/%s/address').read().strip(),
                  'mem_total_kib': int(mem), 'cpus': os.cpu_count()}))
''' % GUEST_NIC
GUEST_READBACK = '''import json, sys
base = '/sys/fs/cgroup/system.slice/' + sys.argv[1] + '.service/'
out = {}
for name in ('memory.max', 'memory.swap.max', 'pids.max', 'cpu.max', 'cgroup.procs'):
    try:
        out[name] = open(base + name).read().strip()
    except OSError:
        out[name] = None
print(json.dumps(out))
'''
GUEST_GONE = '''import json, os, sys
unit, device = sys.argv[1], sys.argv[2]
group = '/system.slice/' + unit + '.service'
members, nobody, mounted = [], [], []
for entry in os.scandir('/proc'):
    if not entry.name.isdigit():
        continue
    pid = entry.name
    try:
        path = open('/proc/%s/cgroup' % pid).read().strip().split(':')[-1]
        if path == group or path.startswith(group + '/'):
            members.append(int(pid))
        for line in open('/proc/%s/status' % pid):
            if line.startswith('Uid:'):
                if '65534' in line.split()[1:]:
                    nobody.append(int(pid))
                break
        if device:
            for line in open('/proc/%s/mountinfo' % pid):
                fields = line.split()
                if len(fields) > 2 and fields[2] == device:
                    mounted.append(int(pid))
                    break
    except (OSError, IndexError):
        continue
directory = '/sys/fs/cgroup' + group
populated = None
if os.path.isdir(directory):
    events = open(directory + '/cgroup.events').read().split()
    populated = events[events.index('populated') + 1] == '1'
print(json.dumps({'boot_id': open('/proc/sys/kernel/random/boot_id').read().strip(),
                  'members': members, 'nobody': nobody, 'mounted': mounted,
                  'cgroup_exists': os.path.isdir(directory), 'cgroup_populated': populated}))
'''
GUEST_STATS = '''import json, os, sys
base = '/sys/fs/cgroup/system.slice/' + sys.argv[1] + '.service/'
out = {}
def read(path):
    try:
        return open(path).read().strip()
    except OSError:
        return None
for name in ('memory.current', 'memory.peak', 'memory.events', 'pids.current', 'pids.peak',
             'cpu.stat', 'cpu.pressure', 'memory.pressure', 'io.pressure'):
    out[name] = read(base + name)
stat = read(base + 'memory.stat') or ''
out['memory.stat'] = {k: int(v) for k, v in (l.split() for l in stat.splitlines())
                      if k in ('anon', 'file', 'shmem', 'kernel', 'sock')}
mem = {l.split(':')[0]: int(l.split()[1]) for l in open('/proc/meminfo') if l.split()[1].isdigit()}
out['guest_mem_available_kib'] = mem.get('MemAvailable')
out['guest_mem_total_kib'] = mem.get('MemTotal')
for name in ('cpu', 'memory', 'io'):
    out['guest_pressure_' + name] = read('/proc/pressure/' + name)
fs = os.statvfs('/')
out['root_free_mib'] = fs.f_bavail * fs.f_frsize // 1048576
out['root_total_mib'] = fs.f_blocks * fs.f_frsize // 1048576
def tree(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total // 1048576
out['var_log_mib'] = tree('/var/log')
out['apt_cache_mib'] = tree('/var/cache/apt')
out['boot_id'] = open('/proc/sys/kernel/random/boot_id').read().strip()
print(json.dumps(out))
'''
GUEST_UNITS = '''import json, os
names = sorted(n for n in os.listdir('/sys/fs/cgroup/system.slice') if n.startswith(%r) and n.endswith('.service'))
print(json.dumps([n[:-len('.service')] for n in names]))
''' % UNIT_PREFIX


class Host:
    """Every external effect; tests replace this object."""

    def __init__(self):
        self.sign_lock = threading.Lock()

    def run(self, argv, timeout=30, check=True, data=None):
        result = subprocess.run(argv, input=data, capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise Refused('HOST_COMMAND_FAILED', '%s: %s' % (argv[0], result.stderr.decode('utf-8', 'replace')[-200:]))
        return result

    def guest(self, code, *args, timeout=30):
        result = self.run(['incus', 'exec', VM, '--', '/usr/bin/python3', '-I', '-c', code, *args],
                          timeout=timeout)
        try:
            return json.loads(result.stdout)
        except ValueError as error:
            raise Refused('GUEST_READBACK_FAILED') from error

    def query(self, path):
        try:
            return installer.query(path)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            raise Refused('BOUNDARY_UNVERIFIED', error) from error

    def vm_state(self):
        state = self.query('/1.0/instances/' + VM + '/state')
        return {'status': state.get('status'), 'pid': state.get('pid')}

    def full_boundary(self):
        """Installed fence, proxy and identity; only while no guest exec runs."""
        try:
            proxied = proxy.status()
        except (ValueError, OSError, subprocess.SubprocessError, KeyError) as error:
            raise Refused('BOUNDARY_UNVERIFIED', error) from error
        instance = self.query('/1.0/instances/' + VM)
        config = instance.get('expanded_config') or instance.get('config', {})
        state = self.vm_state()
        if (instance.get('config', {}).get('volatile.uuid') != VM_UUID or state['status'] != 'Running'
                or type(state['pid']) is not int or state['pid'] <= 0):
            raise Refused('BOUNDARY_UNVERIFIED', 'VM identity or state')
        root = (instance.get('expanded_devices') or {}).get('root', {})
        if not re.fullmatch(r'[1-9][0-9]*', str(config.get('limits.cpu', ''))):
            raise Refused('BOUNDARY_UNVERIFIED', 'limits.cpu must be a vCPU count')
        identity = self.guest(GUEST_IDENTITY)
        if identity.get('mac') != MAC or not UUID.fullmatch(str(identity.get('boot_id'))):
            raise Refused('BOUNDARY_UNVERIFIED', 'guest NIC or boot identity')
        return {'vm_uuid': VM_UUID, 'pid': state['pid'], 'boot_id': identity['boot_id'],
                'mem_total_kib': identity['mem_total_kib'], 'guest_cpus': identity['cpus'],
                'vm_cpus': int(config['limits.cpu']), 'vm_memory_mib': size_mib(config.get('limits.memory')),
                'root_disk_gib': size_mib(root.get('size')) // 1024,
                'spki': proxied['certificate_spki_sha256'],
                'fence_fingerprint': installer.read_journal()['table_fingerprint']}

    def light_boundary(self, expected_pid, fingerprint):
        """Health while a worker runs: no guest exec and no operations check."""
        try:
            if installer.fingerprint(installer.table()) != fingerprint:
                raise Refused('BOUNDARY_LOST', 'fence table changed')
            for unit in ('proxypilot-a3-fence.service', 'proxypilot-a3-origin-proxy.service'):
                installer.execute(['systemctl', 'is-active', unit])
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            raise Refused('BOUNDARY_LOST', error) from error
        instance = self.query('/1.0/instances/' + VM)
        state = self.vm_state()
        if instance.get('config', {}).get('volatile.uuid') != VM_UUID or state != {'status': 'Running', 'pid': expected_pid}:
            raise Refused('BOUNDARY_LOST', 'VM identity or QEMU process changed')

    def boot_id(self):
        return self.guest(GUEST_IDENTITY)['boot_id']

    def spawn(self, unit, properties, source, config):
        argv = ['incus', 'exec', VM, '--', 'systemd-run', '--unit=' + unit, '--wait', '--pipe', '--collect',
                '--service-type=exec', '--description=A3 worker attempt',
                *['--property=' + value for value in properties],
                '/usr/bin/python3', '-I', '-c', source, json.dumps(config, separators=(',', ':'))]
        return subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                bufsize=0, start_new_session=True)

    def readback(self, unit):
        show = self.run(['incus', 'exec', VM, '--', 'systemctl', 'show', unit + '.service', '--no-pager',
                         *['--property=' + p for p in (
                             'ActiveState', 'User', 'NoNewPrivileges', 'ProtectSystem', 'PrivateDevices',
                             'CapabilityBoundingSet', 'IPAddressDeny', 'IPAddressAllow', 'OOMPolicy',
                             'KillMode', 'RuntimeMaxUSec', 'RestrictAddressFamilies', 'ControlGroup')]],
                        timeout=30).stdout.decode()
        values = dict(line.split('=', 1) for line in show.splitlines() if '=' in line)
        values['cgroup'] = self.guest(GUEST_READBACK, unit)
        return values

    def stop_unit(self, unit):
        self.run(['incus', 'exec', VM, '--', 'systemctl', 'stop', unit + '.service'], timeout=30, check=False)

    def unit_state(self, unit):
        out = self.run(['incus', 'exec', VM, '--', 'systemctl', 'show', unit + '.service', '--no-pager',
                        '--property=LoadState', '--property=ActiveState', '--property=Result'],
                       timeout=30).stdout.decode()
        return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)

    def gone(self, unit, device):
        return self.guest(GUEST_GONE, unit, device or '')

    def stats(self, unit):
        out = self.guest(GUEST_STATS, unit)
        state = self.vm_state()
        if type(state.get('pid')) is int:
            out['host_qemu_tree_rss_kib'], out['host_qemu_tree_processes'] = process_tree_rss_kib(state['pid'])
        return out

    def worker_units(self):
        return self.guest(GUEST_UNITS)

    def sign(self, payload):
        with self.sign_lock, tempfile.TemporaryDirectory(prefix='pp-a3-sign-') as temp:
            message = Path(temp) / 'receipt'
            message.write_bytes(payload)
            result = self.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(KEY), '-rawin', '-in', str(message)],
                              timeout=20)
            if len(result.stdout) != 64:
                raise Refused('ATTESTATION_UNAVAILABLE')
            return result.stdout

    def key_id(self):
        der = self.run(['openssl', 'pkey', '-pubin', '-in', str(PUBLIC_KEY), '-outform', 'DER'], timeout=20).stdout
        return hashlib.sha256(der).hexdigest()

    def broker_available(self):
        return BROKER_SOCKET.is_socket()

    def broker(self, method, params, timeout=30):
        """One request to the root-only A4 credential broker; never carries a value."""
        try:
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(timeout)
                client.connect(str(BROKER_SOCKET))
                client.sendall((json.dumps({'method': method, 'params': params}) + '\n').encode())
                line = client.makefile().readline(65536)
            reply = json.loads(line)
        except (OSError, ValueError) as error:
            raise Refused('CREDENTIAL_BROKER_UNAVAILABLE') from error
        if not isinstance(reply, dict) or reply.get('ok') is not True:
            code = reply.get('error') if isinstance(reply, dict) else None
            raise Refused(code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', code)
                          else 'CREDENTIAL_BROKER_UNAVAILABLE')
        return reply.get('result')

    def verify_install(self, own_files):
        """The daemon runs only from its reviewed, root-owned installed copies."""
        try:
            installer.secure(INSTALL_JOURNAL)
            data = json.loads(INSTALL_JOURNAL.read_text())
        except (OSError, ValueError) as error:
            raise Refused('BOUNDARY_UNVERIFIED', 'supervisor install journal') from error
        if data.get('version') != 1 or data.get('phase') != 'installed' or data.get('vm_uuid') != VM_UUID:
            raise Refused('BOUNDARY_UNVERIFIED', 'supervisor install incomplete')
        for path in own_files:
            try:
                installer.secure(path)
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except (OSError, ValueError) as error:
                raise Refused('BOUNDARY_UNVERIFIED', path) from error
            if data.get('files', {}).get(str(path)) != digest:
                raise Refused('BOUNDARY_UNVERIFIED', 'supervisor file changed: %s' % path)


class Worker:
    """The host end of one attempt's line-delimited JSON channel."""

    def __init__(self, process):
        self.process = process
        self.write_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.counter = 0
        self.pending = {}
        self.events = []
        self.first = None
        self.ready = threading.Event()
        self.ended = threading.Event()
        self.credential_channel = threading.Event()
        self.stderr_tail = b''
        threading.Thread(target=self._stdout, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()

    def _stdout(self):
        try:
            for raw in self.process.stdout:
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if 'id' in message:
                    with self.state_lock:
                        slot = self.pending.pop(message.get('id'), None)
                    if slot:
                        slot[1]['reply'] = message
                        slot[0].set()
                    continue
                with self.state_lock:
                    if len(self.events) < 500:
                        self.events.append(message)
                if message.get('event') == 'credential_channel':
                    self.credential_channel.set()
                if message.get('event') in ('ready', 'failed') and self.first is None:
                    self.first = message
                    self.ready.set()
        except (OSError, ValueError):
            pass
        finally:
            self.ended.set()
            self.ready.set()
            with self.state_lock:
                slots, self.pending = list(self.pending.values()), {}
            for done, box in slots:
                box['reply'] = {'ok': False, 'error': 'CHANNEL_CLOSED'}
                done.set()

    def _stderr(self):
        try:
            while True:
                chunk = self.process.stderr.read(4096)
                if not chunk:
                    return
                self.stderr_tail = (self.stderr_tail + chunk)[-8192:]
        except (OSError, ValueError):
            return

    def _write(self, message):
        line = (json.dumps(message, separators=(',', ':')) + '\n').encode()
        with self.write_lock:
            try:
                self.process.stdin.write(line)
                self.process.stdin.flush()
            except (OSError, ValueError) as error:
                raise Refused('CHANNEL_CLOSED') from error

    def send(self, op, **fields):
        """Write one request; the reply is collected later with `wait`."""
        with self.state_lock:
            self.counter += 1
            ident = self.counter
            done, box = threading.Event(), {}
            if self.ended.is_set():
                raise Refused('CHANNEL_CLOSED')
            self.pending[ident] = (done, box)
        try:
            self._write({'id': ident, 'op': op, **fields})
        except Refused:
            with self.state_lock:
                self.pending.pop(ident, None)
            raise
        return ident, done, box

    def wait(self, sent, timeout):
        ident, done, box = sent
        if not done.wait(timeout):
            with self.state_lock:
                self.pending.pop(ident, None)
            raise Refused('WORKER_TIMEOUT')
        return box['reply']

    def request(self, op, timeout, **fields):
        return self.wait(self.send(op, **fields), timeout)

    def ping(self):
        with self.state_lock:
            self.counter += 1
            ident = self.counter
        try:
            self._write({'id': ident, 'op': 'ping'})
        except Refused:
            pass

    def events_of(self, kind):
        with self.state_lock:
            return [e for e in self.events if e.get('event') == kind]

    def close(self, wait=10):
        try:
            self.process.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            self.process.wait(wait)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(5)
        self.ended.wait(5)
        return self.process.returncode


class Supervisor:
    def __init__(self, host=None, journal=JOURNAL, own_files=(), runner_source=None, clock=now):
        self.host = host or Host()
        self.journal_path = journal
        self.own_files = tuple(own_files)
        self.source = runner_source if runner_source is not None else (HERE / 'a3-worker-guest.py').read_text()
        self.clock = clock
        self.lock = threading.RLock()
        self.launch_lock = threading.Lock()
        self.workers = {}
        self.gates = {}
        self.retry_at = {}
        self.boundary_cache = (0, None)
        self.last_health = 0
        self.last_ping = 0
        self.stopping = False
        self.state = self._load()
        self.key = None

    # ------------------------------------------------------------ journal

    def _load(self):
        if not self.journal_path.exists():
            return {'version': 1, 'vm_uuid': VM_UUID, 'runs': {}, 'attempts': {}, 'active': None}
        installer.secure(self.journal_path)
        data = json.loads(self.journal_path.read_text())
        if data.get('version') != 1 or data.get('vm_uuid') != VM_UUID:
            raise Refused('JOURNAL_INVALID')
        return data

    def _save(self):
        installer.save(self.journal_path, json.dumps(self.state, indent=1, sort_keys=True) + '\n',
                       mode=0o600, replace=True)

    def _note(self, attempt, kind):
        attempt.setdefault('log', []).append([stamp(self.clock()), kind])
        del attempt['log'][:-200]

    def _attempt(self, ref, states=None):
        attempt = self.state['attempts'].get(ref['attempt_id'])
        if not attempt or attempt['run_id'] != ref['run_id']:
            raise Refused('UNKNOWN_ATTEMPT')
        if 'fence' in ref and attempt['fence'] != ref['fence']:
            raise Refused('STALE_FENCE')
        if states is not None and attempt['state'] not in states:
            raise Refused({'human': 'TAKEN_OVER'}.get(attempt['state'], 'ATTEMPT_NOT_ACTIVE'))
        return attempt

    def _live(self):
        return [a for a in self.state['attempts'].values() if a['state'] in LIVE]

    # ----------------------------------------------------------- receipts

    def _key_id(self):
        if self.key is None:
            self.key = self.host.key_id()
        return self.key

    def _receipt(self, attempt, reason, evidence, descendants_gone, workspace_removed):
        payload = {
            'v': 1, 'kind': 'a3-teardown', 'run_id': attempt['run_id'], 'attempt_id': attempt['attempt_id'],
            'fence': attempt['fence'], 'workspace_id': attempt.get('workspace_id'), 'vm_uuid': VM_UUID,
            'bound_boot_id': attempt.get('boot_id'), 'unit': attempt.get('unit'), 'reason': reason,
            'stopped_at': stamp(self.clock()), 'descendants_gone': descendants_gone,
            'workspace_removed': workspace_removed, 'evidence': evidence,
            'uncertain_actions': [a['ordinal'] for a in attempt.get('actions', []) if a['state'] == 'uncertain'],
            'actions_performed': len(attempt.get('actions', [])), 'key_id': self._key_id(),
            'supervisor_sha256': self.state.get('supervisor_sha256')}
        credential = (self.state['runs'].get(attempt['run_id']) or {}).get('credential')
        if credential is not None:
            # Binding ID, revision and outcomes only: never a value or a hash of one.
            payload['credential'] = {
                'binding_id': credential['binding_id'], 'binding_revision': credential['binding_revision'],
                'submits': [{'ordinal': a['ordinal'], 'outcome': a.get('outcome', a['state'])}
                            for a in attempt.get('actions', []) if a['action'] == 'submit_bound_fixture'],
                'logout': attempt.get('logout')}
        body = canonical(payload)
        signature = self.host.sign(body)
        return {'run_id': attempt['run_id'], 'attempt_id': attempt['attempt_id'], 'fence': attempt['fence'],
                'descendants_gone': descendants_gone, 'workspace_removed': workspace_removed,
                'attestation': 'a3r1.%s.%s' % (b64url(body), b64url(signature))}

    # ----------------------------------------------------------- teardown

    def _verify_gone(self, attempt):
        """Host readback that no descendant or workspace of the attempt remains."""
        evidence = {}
        state = self.host.vm_state()
        evidence['vm_status'] = state.get('status')
        if state.get('status') == 'Stopped':
            evidence['guest_processes'] = 'VM stopped'
            return evidence, True, True
        if state.get('status') != 'Running':
            # Frozen, starting or error states may still hold the worker's processes.
            raise Refused('TEARDOWN_UNVERIFIED', 'VM status %s' % state.get('status'))
        boot = self.host.boot_id()
        evidence['observed_boot_id'] = boot
        if attempt.get('boot_id') and boot != attempt['boot_id']:
            # A new guest boot has none of the previous boot's processes or tmpfs.
            evidence['guest_rebooted'] = True
            return evidence, True, True
        unit = attempt['unit']
        unit_state = self.host.unit_state(unit)
        evidence['unit'] = {k: unit_state.get(k) for k in ('LoadState', 'ActiveState', 'Result')}
        gone = self.host.gone(unit, (attempt.get('workspace') or {}).get('device'))
        evidence.update({'cgroup_exists': gone['cgroup_exists'], 'cgroup_populated': gone['cgroup_populated'],
                         'unit_members': gone['members'], 'worker_uid_processes': gone['nobody'],
                         'workspace_mounts': gone['mounted']})
        descendants = (unit_state.get('ActiveState') in ('inactive', 'failed') and not gone['members']
                       and not gone['nobody'] and gone['cgroup_populated'] is not True)
        workspace = descendants and not gone['mounted']
        return evidence, descendants, workspace

    def _teardown(self, attempt_id, reason):
        """Stop and verify one attempt; idempotent; never replays an action."""
        with self.lock:
            gate = self.gates.setdefault(attempt_id, threading.Lock())
        with gate:
            return self._teardown_once(attempt_id, reason)

    def _teardown_once(self, attempt_id, reason):
        with self.lock:
            attempt = self.state['attempts'][attempt_id]
            if attempt['state'] in TERMINAL:
                return attempt['receipt']
            if attempt['state'] != 'stopping':
                attempt['state'] = 'stopping'
                attempt['stop_reason'] = reason
                for action in attempt.get('actions', []):
                    if action['state'] == 'started':
                        action['state'] = 'uncertain'
                self._note(attempt, 'stopping:' + reason)
                self._save()
            reason = attempt['stop_reason']
            worker = self.workers.get(attempt_id)
        if worker is not None:
            try:
                # An attempt that submitted a credential signs out first (POST /api/logout).
                reply = worker.request('stop', STOP_SECONDS if attempt.get('credential_submitted') else 3)
                if attempt.get('credential_submitted'):
                    logout = (reply.get('result') or {}).get('logout') if reply.get('ok') else None
                    with self.lock:
                        attempt['logout'] = logout if logout in ('done', 'failed') else 'not_run'
            except Refused:
                if attempt.get('credential_submitted'):
                    with self.lock:
                        attempt['logout'] = 'not_run'

        try:
            if attempt.get('unit') and attempt.get('spawned'):
                state = self.host.vm_state()
                if state.get('status') == 'Running':
                    self.host.stop_unit(attempt['unit'])
            if worker is not None:
                worker.close()
                attempt['exit'] = summary(worker.stderr_tail)
            if attempt.get('spawned'):
                evidence, descendants, workspace = None, False, False
                for _ in range(5):
                    evidence, descendants, workspace = self._verify_gone(attempt)
                    if descendants and workspace:
                        break
                    time.sleep(1)
            else:
                evidence, descendants, workspace = {'launched': False}, True, True
        except (Refused, OSError, subprocess.SubprocessError) as error:
            with self.lock:
                self._note(attempt, 'teardown_unverified')
                self._save()
            raise Refused('TEARDOWN_UNVERIFIED', getattr(error, 'code', error)) from error
        if not (descendants and workspace):
            with self.lock:
                attempt['teardown_evidence'] = evidence
                self._note(attempt, 'teardown_unverified')
                self._save()
            raise Refused('TEARDOWN_UNVERIFIED')
        evidence['exit'] = attempt.get('exit')
        if attempt.get('credential_submitted'):
            evidence['logout'] = attempt.get('logout', 'not_run')
        receipt = self._receipt(attempt, reason, evidence, True, True)
        with self.lock:
            attempt['receipt'] = receipt
            attempt['teardown_evidence'] = evidence
            attempt['state'] = 'refused' if reason == 'launch_refused' else (
                'lost' if reason in ('supervisor_recovery', 'guest_lost') else 'stopped')
            attempt['stopped_at'] = stamp(self.clock())
            self._note(attempt, 'receipt')
            if self.state.get('active') == attempt_id:
                self.state['active'] = None
            self.workers.pop(attempt_id, None)
            self._save()
        return receipt

    # ------------------------------------------------------------- launch

    def _refuse_before_effect(self, spec, code, detail=None):
        """Record a refused attempt so it can never later be launched or revived."""
        with self.lock:
            if spec['attempt_id'] not in self.state['attempts']:
                self.state['attempts'][spec['attempt_id']] = {
                    'attempt_id': spec['attempt_id'], 'run_id': spec['run_id'], 'fence': spec['fence'],
                    'workspace_id': spec.get('workspace_id'), 'state': 'launching', 'spawned': False,
                    'unit': None, 'refusal': code, 'actions': []}
                self._save()
        self._teardown(spec['attempt_id'], 'launch_refused')
        raise Refused(code, detail)

    def launch(self, params, workload='browser'):
        spec = validate_launch(params)
        if workload != 'browser' and workload not in runner.PROOFS:
            raise Refused('INVALID_LAUNCH', 'workload')
        with self.launch_lock:
            with self.lock:
                if self.stopping:
                    raise Refused('SUPERVISOR_STOPPING')
                if spec['attempt_id'] in self.state['attempts']:
                    raise Refused('ATTEMPT_EXISTS')
                if self._live():
                    raise Refused('ACTIVE_ATTEMPT')
                run = self.state['runs'].get(spec['run_id'])
                pins = {'policy_digest': spec['policy_digest'], 'origin': spec['origin'],
                        'project_limits_revision': spec['project_limits_revision'], 'limits': spec['limits'],
                        'credential': spec['credential']}
                if run and any(run.get(k) != v for k, v in pins.items()):
                    refusal = 'RUN_POLICY_MISMATCH'
                elif run and spec['fence'] <= run['max_fence']:
                    refusal = 'STALE_FENCE'
                elif run and run['deadline'] is not None and self.clock() >= run['deadline']:
                    refusal = 'DEADLINE'
                elif run and run['max_actions'] is not None and run['action_count'] >= run['max_actions']:
                    refusal = 'ACTION_LIMIT'
                else:
                    refusal = None
            if refusal:
                self._refuse_before_effect(spec, refusal)
            try:
                boundary = self.host.full_boundary()
                self.host.verify_install(self.own_files)
                if (spec['install']['cpu'] > boundary['vm_cpus'] or spec['install']['memory_mib'] > boundary['vm_memory_mib']
                        or spec['install']['root_disk_gib'] > boundary['root_disk_gib']):
                    raise Refused('VM_CAPACITY_INSUFFICIENT', 'install shape')
                plan = worker_plan(spec['limits'], boundary['mem_total_kib'], boundary['guest_cpus'])
                broker_pinned = self._pin_at_broker(spec)
            except Refused as error:
                self._refuse_before_effect(spec, error.code, error.detail)
            with self.lock:
                started = self.clock()
                if not run:
                    limits = spec['limits']
                    run = self.state['runs'][spec['run_id']] = dict(
                        pins, first_launch_at=stamp(started), max_fence=0, action_count=0, attempts=[],
                        deadline=started + limits['max_seconds'] if 'max_seconds' in limits else None,
                        max_actions=limits.get('max_actions'), broker_pinned=broker_pinned)
                runtime = None
                if run['deadline'] is not None:
                    runtime = math.ceil(run['deadline'] - started)
                    if runtime < 1:
                        raise Refused('DEADLINE')
                unit = UNIT_PREFIX + spec['attempt_id']
                attempt = {'attempt_id': spec['attempt_id'], 'run_id': spec['run_id'], 'fence': spec['fence'],
                           'workspace_id': spec['workspace_id'], 'state': 'launching', 'spawned': True,
                           'unit': unit, 'workload': workload, 'boot_id': boundary['boot_id'],
                           'qemu_pid': boundary['pid'], 'fence_fingerprint': boundary['fence_fingerprint'],
                           'plan': plan, 'runtime_max_seconds': runtime, 'actions': [],
                           'launched_at': stamp(started), 'lease': started + LEASE_SECONDS}
                run['max_fence'] = spec['fence']
                run['attempts'].append(spec['attempt_id'])
                self.state['attempts'][spec['attempt_id']] = attempt
                self.state['active'] = spec['attempt_id']
                self._note(attempt, 'launch_reserved')
                # Durable before any guest effect: recovery tears down whatever this starts.
                self._save()
            config = {'attempt_id': spec['attempt_id'], 'workload': workload, 'spki': boundary['spki']}
            try:
                worker = Worker(self.host.spawn(unit, unit_properties(plan, runtime), self.source, config))
            except (OSError, subprocess.SubprocessError) as error:
                try:
                    self._teardown(spec['attempt_id'], 'launch_failed')
                except Refused:
                    pass  # Stays `stopping`; the watchdog retries verification.
                raise Refused('LAUNCH_FAILED', error) from error
            with self.lock:
                self.workers[spec['attempt_id']] = worker
            worker.ready.wait(READY_SECONDS)
            first = worker.first or {}
            failure = None
            if first.get('event') != 'ready':
                failure = first.get('code') or ('WORKER_EXITED' if worker.ended.is_set() else 'READY_TIMEOUT')
            else:
                try:
                    self._check_readback(unit, plan, runtime)
                except Refused as error:
                    failure = error.code
            if failure:
                detail = first.get('diagnostic') or summary(worker.stderr_tail)
                with self.lock:
                    attempt['launch_failure'] = {'code': failure, 'diagnostic': str(detail)[-1500:]}
                    self._save()
                try:
                    self._teardown(spec['attempt_id'], 'launch_failed')
                except Refused:
                    pass
                raise Refused('LAUNCH_FAILED', '%s %s' % (failure, json.dumps(detail)[:200]))
            with self.lock:
                attempt['state'] = 'running'
                attempt['workspace'] = first.get('workspace')
                attempt['browser_pid'] = first.get('browser_pid')
                attempt['browser_start_seconds'] = first.get('browser_start_seconds')
                attempt['lease'] = self._next_lease(run)
                self._note(attempt, 'running')
                self._save()
            return {'run_id': spec['run_id'], 'attempt_id': spec['attempt_id'], 'fence': spec['fence'],
                    'vm_uuid': VM_UUID, 'boot_id': boundary['boot_id'], 'unit': unit,
                    'lease_expires_at': stamp(attempt['lease']),
                    'deadline_at': None if run['deadline'] is None else stamp(run['deadline']),
                    'limits_applied': plan, 'runtime_max_seconds': runtime,
                    'workspace': {'kind': 'unit-private-tmpfs', **(first.get('workspace') or {})},
                    'workload': workload}

    def _pin_at_broker(self, spec):
        """Pin the binding revision and the token/spend policy with the A4 broker.

        A credential launch needs the broker and fails closed without it. A launch
        without one is pinned when the broker is installed (model calls for the run
        then have a policy) and proceeds unpinned otherwise (no model calls).
        """
        credential = spec['credential']
        if not self.host.broker_available():
            if credential is not None:
                raise Refused('CREDENTIAL_BROKER_UNAVAILABLE')
            return False
        spend = {k: spec['limits'][k] for k in ('max_tokens', 'max_usd') if k in spec['limits']}
        self.host.broker('pin_run', {'run_id': spec['run_id'], 'project_limits_revision': spec['project_limits_revision'],
                                     'limits': spend, 'credential': credential})
        return True

    def _check_readback(self, unit, plan, runtime):
        values = self.host.readback(unit)
        expected = {'User': 'nobody', 'NoNewPrivileges': 'yes', 'ProtectSystem': 'strict',
                    'PrivateDevices': 'yes', 'CapabilityBoundingSet': '', 'OOMPolicy': 'kill',
                    'KillMode': 'control-group', 'IPAddressAllow': '%s/32' % PROXY_ADDRESS,
                    'ControlGroup': '/system.slice/%s.service' % unit}
        for key, value in expected.items():
            if values.get(key) != value:
                raise Refused('UNIT_READBACK_FAILED', key)
        if '0.0.0.0/0' not in values.get('IPAddressDeny', '') or '::/0' not in values.get('IPAddressDeny', ''):
            raise Refused('UNIT_READBACK_FAILED', 'IPAddressDeny')
        if set(values.get('RestrictAddressFamilies', '').split()) != {'AF_UNIX', 'AF_INET', 'AF_INET6', 'AF_NETLINK'}:
            raise Refused('UNIT_READBACK_FAILED', 'RestrictAddressFamilies')
        limit = parse_timespan(values.get('RuntimeMaxUSec', ''))
        if (runtime is None) != (limit is None) or (runtime is not None and abs(limit - runtime) > 1):
            raise Refused('UNIT_READBACK_FAILED', 'RuntimeMaxUSec')
        cgroup = values['cgroup']
        for key, value in expected_cgroup(plan).items():
            if cgroup.get(key) != value:
                raise Refused('UNIT_READBACK_FAILED', key)

    def _next_lease(self, run):
        lease = self.clock() + LEASE_SECONDS
        return lease if run['deadline'] is None else min(lease, run['deadline'])

    # ------------------------------------------------------- per-attempt ops

    def _usable(self, attempt):
        run = self.state['runs'][attempt['run_id']]
        if run['deadline'] is not None and self.clock() >= run['deadline']:
            raise Refused('DEADLINE')
        if self.clock() >= attempt['lease']:
            raise Refused('LEASE_EXPIRED')
        return run

    def renew(self, params):
        ref = validate_ref(params)
        with self.lock:
            attempt = self._attempt(ref, ('running', 'human'))
            run = self._usable(attempt)
            attempt['lease'] = self._next_lease(run)
            self._save()
            return {'lease_expires_at': stamp(attempt['lease'])}

    def action(self, params):
        submit = isinstance(params, dict) and params.get('action') == 'submit_bound_fixture'
        ref = validate_ref(params, ('action', 'binding_id') if submit else ('action',))
        if ref['action'] not in runner.ACTIONS:
            raise Refused('INVALID_BROWSER_ACTION')
        if submit:
            return self._submit(ref)
        with self.lock:
            attempt = self._attempt(ref, ('running',))
            if attempt['workload'] != 'browser':
                raise Refused('INVALID_BROWSER_ACTION')
            run = self._usable(attempt)
            if run['max_actions'] is not None and run['action_count'] >= run['max_actions']:
                raise Refused('ACTION_LIMIT')
            run['action_count'] += 1
            record = {'ordinal': run['action_count'], 'action': ref['action'], 'state': 'started',
                      'at': stamp(self.clock())}
            attempt['actions'].append(record)
            # The reservation is durable before the browser can act on it.
            self._save()
            worker = self.workers.get(ref['attempt_id'])
        if worker is None:
            self._fail_channel(ref['attempt_id'])
            raise Refused('CHANNEL_CLOSED')
        started = time.monotonic()
        try:
            reply = worker.request('action', ACTION_SECONDS, action=ref['action'])
        except Refused as error:
            self._fail_channel(ref['attempt_id'])
            raise Refused(error.code) from error
        with self.lock:
            if reply.get('error') == 'CHANNEL_CLOSED':
                record['state'] = 'uncertain'
                self._save()
                self._fail_channel(ref['attempt_id'])
                raise Refused('CHANNEL_CLOSED')
            record['state'] = 'done' if reply.get('ok') else 'failed'
            record['latency_ms'] = int((time.monotonic() - started) * 1000)
            if not reply.get('ok'):
                record['error'] = str(reply.get('error'))[:64]
            if attempt['state'] == 'running':
                attempt['lease'] = self._next_lease(run)
            self._save()
        if not reply.get('ok'):
            raise Refused(str(reply.get('error'))[:64])
        return {'ordinal': record['ordinal'], 'result': reply.get('result'), 'untrusted': True}

    def _submit_target(self, ref):
        attempt = self._attempt(ref, ('running',))
        if attempt['workload'] != 'browser':
            raise Refused('INVALID_BROWSER_ACTION')
        run = self._usable(attempt)
        credential = run.get('credential')
        if credential is None:
            raise Refused('CREDENTIAL_NOT_BOUND')
        if credential['binding_id'] != ref['binding_id']:
            raise Refused('BINDING_MISMATCH')
        return attempt, run, credential

    def _submit(self, ref):
        """submit_bound_fixture: broker check, runner action, broker delivery.

        Only the binding ID crosses the runner channel; the broker writes the
        value to the runner's FIFO itself, so no value is ever in this process.
        """
        if not isinstance(ref['binding_id'], str) or not UUID.fullmatch(ref['binding_id']):
            raise Refused('INVALID_REQUEST')
        with self.lock:
            attempt, run, credential = self._submit_target(ref)
        try:
            # Rotation and revocation are refused here, before any browser effect.
            self.host.broker('check', {'run_id': ref['run_id'], 'binding_id': ref['binding_id']}, 15)
        except Refused as error:
            with self.lock:
                self._note(attempt, 'submit_refused:' + error.code)
                self._save()
            raise
        with self.lock:
            attempt, run, credential = self._submit_target(ref)
            if run['max_actions'] is not None and run['action_count'] >= run['max_actions']:
                raise Refused('ACTION_LIMIT')
            run['action_count'] += 1
            record = {'ordinal': run['action_count'], 'action': 'submit_bound_fixture',
                      'binding_id': credential['binding_id'], 'binding_revision': credential['binding_revision'],
                      'state': 'started', 'at': stamp(self.clock())}
            attempt['actions'].append(record)
            attempt['credential_submitted'] = True
            self._save()
            worker = self.workers.get(ref['attempt_id'])
        if worker is None:
            self._fail_channel(ref['attempt_id'])
            raise Refused('CHANNEL_CLOSED')
        started = time.monotonic()
        worker.credential_channel.clear()
        try:
            sent = worker.send('action', action='submit_bound_fixture', binding_id=ref['binding_id'])
        except Refused as error:
            self._fail_channel(ref['attempt_id'])
            raise Refused(error.code) from error
        # Deliver only once the runner reports its FIFO reader is open: a runner
        # that refused first (no login form) never causes a vault read.
        deadline = time.monotonic() + runner.DELIVERY_SECONDS
        while (not worker.credential_channel.is_set() and not sent[1].is_set()
               and time.monotonic() < deadline):
            worker.credential_channel.wait(0.05)
        delivery_error = None
        if worker.credential_channel.is_set():
            try:
                self.host.broker('deliver', {'run_id': ref['run_id'], 'attempt_id': ref['attempt_id'],
                                             'binding_id': ref['binding_id']}, DELIVERY_SECONDS)
            except Refused as error:
                delivery_error = error.code
        try:
            reply = worker.wait(sent, ACTION_SECONDS + runner.DELIVERY_SECONDS)
        except Refused as error:
            self._fail_channel(ref['attempt_id'])
            raise Refused(error.code) from error
        with self.lock:
            if reply.get('error') == 'CHANNEL_CLOSED':
                record['state'] = 'uncertain'
                self._save()
                self._fail_channel(ref['attempt_id'])
                raise Refused('CHANNEL_CLOSED')
            result = reply.get('result') if reply.get('ok') else None
            record['latency_ms'] = int((time.monotonic() - started) * 1000)
            if isinstance(result, dict) and result.get('binding_id') == ref['binding_id'] and delivery_error is None:
                record['state'] = 'done'
                record['outcome'] = result.get('outcome') if result.get('outcome') in (
                    'signed_in', 'rejected', 'unknown') else 'unknown'
            else:
                record['state'] = 'failed'
                record['error'] = delivery_error or str(reply.get('error'))[:64]
                record['outcome'] = 'refused:' + record['error']
            if attempt['state'] == 'running':
                attempt['lease'] = self._next_lease(run)
            self._save()
        if record['state'] != 'done':
            raise Refused(record['error'])
        return {'ordinal': record['ordinal'], 'untrusted': True,
                'result': {'binding_id': ref['binding_id'], 'binding_revision': record['binding_revision'],
                           'outcome': record['outcome'], 'login_requests': result.get('login_requests'),
                           'untrusted_page_claim_authenticated_as_bound_account':
                               result.get('untrusted_page_claim_authenticated_as_bound_account') is True}}

    def _fail_channel(self, attempt_id):
        threading.Thread(target=self._safe_teardown, args=(attempt_id, 'channel_lost'), daemon=True).start()

    def _safe_teardown(self, attempt_id, reason):
        try:
            self._teardown(attempt_id, reason)
        except Refused:
            pass

    def stop(self, params, operator=False):
        ref = validate_ref(params, ('reason',))
        if ref['reason'] not in (OPERATOR_STOP_REASONS if operator else BACKEND_STOP_REASONS):
            raise Refused('INVALID_REQUEST', 'reason')
        with self.lock:
            attempt = self.state['attempts'].get(ref['attempt_id'])
            if attempt is None:
                # This supervisor never started it; record that so it can never start.
                self.state['attempts'][ref['attempt_id']] = {
                    'attempt_id': ref['attempt_id'], 'run_id': ref['run_id'], 'fence': ref['fence'],
                    'workspace_id': None, 'state': 'launching', 'spawned': False, 'unit': None,
                    'refusal': 'NEVER_LAUNCHED', 'actions': []}
                self._save()
                attempt = self.state['attempts'][ref['attempt_id']]
                reason = 'launch_refused'
            else:
                reason = ref['reason']
            self._attempt(ref)
        return {'receipt': self._teardown(ref['attempt_id'], reason)}

    # ----------------------------------------------------------- operator

    def takeover(self, params):
        ref = validate_ref(params)
        with self.lock:
            attempt = self._attempt(ref, ('running',))
            if attempt['workload'] != 'browser':
                raise Refused('ATTEMPT_NOT_ACTIVE')
            self._usable(attempt)
            # Fences the model first: from here only the operator socket acts.
            attempt['state'] = 'human'
            self._note(attempt, 'takeover')
            self._save()
            return {'state': 'human', 'model_actions': 'refused'}

    def _operator_call(self, params, extra, states, op, timeout=ACTION_SECONDS, renew=False, **fields):
        ref = validate_ref(params, extra)
        with self.lock:
            attempt = self._attempt(ref, states)
            run = self._usable(attempt)
            worker = self.workers.get(ref['attempt_id'])
            # Only a human holding takeover extends the lease by using it; watching
            # the model's attempt never keeps a lost coordinator's worker alive.
            if renew and attempt['state'] == 'human':
                attempt['lease'] = self._next_lease(run)
                self._save()
        if worker is None:
            raise Refused('CHANNEL_CLOSED')
        reply = worker.request(op, timeout, **fields)
        if not reply.get('ok'):
            raise Refused(str(reply.get('error'))[:64])
        return reply.get('result')

    def view(self, params):
        return self._operator_call(params, (), ('running', 'human'), 'view', renew=True)

    def human_input(self, params):
        try:
            runner.validate_input(params.get('input') if isinstance(params, dict) else None)
        except runner.Refused as error:
            raise Refused(error.code) from error
        return self._operator_call(params, ('input',), ('human',), 'input', renew=True, input=params['input'])

    def observe(self, params):
        return self._operator_call(params, (), ('running', 'human'), 'observe')

    def locate(self, params):
        if not isinstance(params, dict) or params.get('target') not in ('sign_in_button', 'sign_out_button'):
            raise Refused('INVALID_REQUEST')
        return self._operator_call(params, ('target',), ('running', 'human'), 'locate', target=params['target'])

    def egress_probe(self, params):
        return self._operator_call(params, (), ('running',), 'egress_probe', timeout=120)

    def proof(self, params):
        ref = validate_ref(params)
        with self.lock:
            attempt = self._attempt(ref, ('running',))
            if attempt['workload'] not in runner.PROOFS:
                raise Refused('INVALID_REQUEST')
            worker = self.workers.get(ref['attempt_id'])
        if worker is None:
            raise Refused('CHANNEL_CLOSED')
        try:
            reply = worker.request('proof', 90)
        except Refused as error:
            reply = {'ok': False, 'error': error.code}
        return {'reply': reply, 'events': worker.events_of('proof') + worker.events_of('progress')[-3:],
                'ended': worker.ended.is_set(), 'exit': summary(worker.stderr_tail)}

    def unit_stats(self, params):
        if not exact(params, ('attempt_id',)) or params['attempt_id'] not in self.state['attempts']:
            raise Refused('UNKNOWN_ATTEMPT')
        attempt = self.state['attempts'][params['attempt_id']]
        return self.host.stats(attempt['unit'])

    def journal(self, params):
        if not exact(params, ('attempt_id',)) or params['attempt_id'] not in self.state['attempts']:
            raise Refused('UNKNOWN_ATTEMPT')
        with self.lock:
            attempt = json.loads(json.dumps(self.state['attempts'][params['attempt_id']]))
            run = json.loads(json.dumps(self.state['runs'].get(attempt['run_id'])))
        return {'attempt': attempt, 'run': run}

    def crash_mid_action(self, params):
        """Proof hook: journal a started action, then die before it is sent."""
        ref = validate_ref(params, ('action',))
        with self.lock:
            attempt = self._attempt(ref, ('running',))
            run = self._usable(attempt)
            run['action_count'] += 1
            attempt['actions'].append({'ordinal': run['action_count'], 'action': ref['action'],
                                       'state': 'started', 'at': stamp(self.clock())})
            self._save()
        os.kill(os.getpid(), signal.SIGKILL)

    # ------------------------------------------------------------- status

    def status(self, _params=None):
        with self.lock:
            live = self._live()
            active = None
            if live:
                a = live[0]
                run = self.state['runs'].get(a['run_id'], {})
                active = {'run_id': a['run_id'], 'attempt_id': a['attempt_id'], 'fence': a['fence'],
                          'state': a['state'], 'boot_id': a.get('boot_id'),
                          'lease_expires_at': stamp(a['lease']) if a.get('lease') else None,
                          'deadline_at': stamp(run['deadline']) if run.get('deadline') else None}
        blockers, boundary = [], None
        if active is None:
            cached_at, cached = self.boundary_cache
            if self.clock() - cached_at < 10 and cached is not None:
                boundary, blockers = cached
            else:
                try:
                    boundary = self.host.full_boundary()
                    self.host.verify_install(self.own_files)
                except Refused as error:
                    blockers = ['%s: %s' % (error.code, error.detail)]
                self.boundary_cache = (self.clock(), (boundary, blockers))
        public = None if boundary is None else {k: boundary[k] for k in ('vm_uuid', 'boot_id', 'spki')}
        return {'supervisor': {'version': 1, 'key_id': self._key_id(),
                               'supervisor_sha256': self.state.get('supervisor_sha256'),
                               'runner_sha256': hashlib.sha256(self.source.encode()).hexdigest()},
                'target': TARGET, 'vm_uuid': VM_UUID, 'boundary': public, 'blockers': blockers,
                'credential_broker': 'available' if self.host.broker_available() else 'absent',
                'active': active, 'accepting_launch': active is None and not blockers and not self.stopping}

    # ----------------------------------------------------- recovery/watch

    def recover(self):
        """After any restart: tear down every non-terminal attempt, never replay."""
        with self.lock:
            pending = [a['attempt_id'] for a in self._live()]
        for attempt_id in pending:
            try:
                self._teardown(attempt_id, 'supervisor_recovery')
            except Refused:
                pass
        try:
            units = self.host.worker_units()
        except Refused:
            units = []
        for unit in units:
            attempt_id = unit[len(UNIT_PREFIX):]
            attempt = self.state['attempts'].get(attempt_id)
            if attempt is None or attempt['state'] in TERMINAL:
                # Never leave an unowned or terminal worker unit running.
                self.host.stop_unit(unit)
        return pending

    def tick(self):
        with self.lock:
            live = self._live()
        for attempt in live:
            attempt_id, reason = attempt['attempt_id'], None
            worker = self.workers.get(attempt_id)
            run = self.state['runs'].get(attempt['run_id'], {})
            if attempt['state'] == 'stopping':
                if time.monotonic() < self.retry_at.get(attempt_id, 0):
                    continue
                self.retry_at[attempt_id] = time.monotonic() + 15
                reason = attempt.get('stop_reason') or 'retry'
            elif attempt['state'] == 'launching':
                continue
            elif worker is None or worker.ended.is_set():
                reason = 'worker_exited'
            elif run.get('deadline') is not None and self.clock() >= run['deadline']:
                reason = 'deadline'
            elif self.clock() >= attempt['lease']:
                reason = 'lease_expired'
            else:
                if time.monotonic() - self.last_ping >= PING_SECONDS:
                    worker.ping()
                    self.last_ping = time.monotonic()
                if time.monotonic() - self.last_health >= HEALTH_SECONDS:
                    self.last_health = time.monotonic()
                    try:
                        self.host.light_boundary(attempt['qemu_pid'], attempt['fence_fingerprint'])
                    except Refused:
                        reason = 'boundary_lost'
            if reason:
                self._safe_teardown(attempt_id, reason)

    def dispatch(self, method, params, operator=False):
        if not isinstance(params, dict):
            raise Refused('INVALID_REQUEST')
        if method not in (OPERATOR_METHODS if operator else BACKEND_METHODS):
            raise Refused('METHOD_NOT_ALLOWED')
        if method == 'launch':
            if operator and 'workload' in params:
                params = dict(params)
                workload = params.pop('workload')
            else:
                workload = 'browser'
            return self.launch(params, workload)
        if method == 'stop':
            return self.stop(params, operator)
        return {'status': self.status, 'renew': self.renew, 'action': self.action,
                'takeover': self.takeover, 'view': self.view, 'input': self.human_input,
                'observe': self.observe, 'locate': self.locate, 'egress_probe': self.egress_probe,
                'proof': self.proof, 'unit_stats': self.unit_stats, 'journal': self.journal,
                'proof_crash_mid_action': self.crash_mid_action}[method](params)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        creds = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
        _, uid, _ = struct.unpack('3i', creds)
        if uid != self.server.peer_uid:
            return
        self.request.settimeout(180)
        line = self.rfile.readline(262145)
        try:
            if len(line) > 262144:
                raise Refused('INVALID_REQUEST', 'too large')
            try:
                request = json.loads(line)
            except ValueError as error:
                raise Refused('INVALID_REQUEST') from error
            if not isinstance(request, dict) or set(request) - {'method', 'params'} or 'method' not in request:
                raise Refused('INVALID_REQUEST')
            result = self.server.supervisor.dispatch(request['method'], request.get('params', {}),
                                                     operator=self.server.operator)
            reply = {'ok': True, 'result': result}
        except Refused as error:
            reply = {'ok': False, 'error': error.code}
            if error.detail:
                reply['detail'] = error.detail
        except Exception as error:  # noqa: BLE001 - never crash the listener.
            reply = {'ok': False, 'error': 'INTERNAL', 'detail': type(error).__name__}
        self.wfile.write((json.dumps(reply, separators=(',', ':')) + '\n').encode())


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    peer_uid = 0  # Root peers only; the backend container and the operator run as root.


def listen(path, supervisor, operator):
    path.unlink(missing_ok=True)
    server = Server(str(path), Handler)
    os.chmod(path, 0o600)
    server.supervisor, server.operator = supervisor, operator
    threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.5}, daemon=True).start()
    return server


def installed_files():
    names = ('a3-worker-supervisor.py', 'a3-worker-guest.py', 'a3-install-proxy.py',
             'a3-install-fence.py', 'a3-network-fence.py', 'a3-origin-proxy.py')
    return [HERE / name for name in names] + [UNIT]


def serve():
    if os.geteuid() != 0:
        raise Refused('ROOT_REQUIRED')
    own = installed_files()
    supervisor = Supervisor(own_files=own)
    supervisor.host.verify_install(own)
    supervisor.state['supervisor_sha256'] = hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()
    supervisor._save()
    supervisor.recover()
    RUN_DIR.mkdir(mode=0o700, exist_ok=True)
    servers = [listen(BACKEND_SOCKET, supervisor, False), listen(OPERATOR_SOCKET, supervisor, True)]
    finished = threading.Event()

    def terminate(*_):
        supervisor.stopping = True
        finished.set()
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    while not finished.wait(1):
        supervisor.tick()
    for server in servers:
        server.shutdown()
    for attempt in list(supervisor._live()):
        supervisor._safe_teardown(attempt['attempt_id'], 'supervisor_stopping')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true', required=True)
    parser.parse_args()
    serve()


if __name__ == '__main__':
    try:
        main()
    except Refused as error:
        print('A3 supervisor refused: %s %s' % (error.code, error.detail or ''), file=sys.stderr)
        sys.exit(1)
