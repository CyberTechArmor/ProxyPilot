#!/usr/bin/env python3
"""Separate, root-reviewed A3 proxy/supervisor + A4 package transaction.

No ordinary updater enrollment, acceptance creation, key/config/state restore,
VM/firewall mutation, credential activation, download or caller-supplied paths.
The CLI uses only this file's fixed production contract. Python adapters are
test seams, never command-line or wire authority.
"""
import argparse
import ast
import base64
import contextlib
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
VERSION = 'selected-runtime-package.v1'
ROOT = '/etc/proxypilot-a3-proof'
STATE = '/var/lib/proxypilot-a3-proof'
SUPERVISOR = ROOT + '/supervisor'
BROKER = '/etc/proxypilot-a4/broker/a4-credential-broker.py'
VM = 'pp-agents-a3-debian13-proof-20260927'
VM_UUID = '49592202-a8b0-45af-9ac6-5439761d73e4'
SOURCE = '/opt/proxypilot'
SOURCE_RECORD = '/var/lib/proxypilot/update/source-dir'
TRANSACTION = '/var/lib/proxypilot/update/selected-runtime-package'
LOCK = '/run/proxypilot-a3-fence.lock'
GATEWAY_STATE = STATE + '/selected-gateway'
LEGACY = ('a3-worker-supervisor.py', 'a3-worker-guest.py', 'a3-install-proxy.py',
          'a3-install-fence.py', 'a3-network-fence.py', 'a3-origin-proxy.py')
SELECTED = ('selected_browser_supervisor.py', 'selected_browser_policy.py', 'selected_browser_gateway.py',
            'selected_browser_worker.py', 'selected_browser_contract.py', 'selected-browser-schemas.json',
            'selected-browser-model.py')
UNIT_ROOT = '/etc/systemd/system/'
SUP_UNIT = UNIT_ROOT + 'proxypilot-a3-supervisor.service'
PROXY_UNIT = UNIT_ROOT + 'proxypilot-a3-origin-proxy.service'
BROKER_UNIT = UNIT_ROOT + 'proxypilot-a4-broker.service'
RENEW_SERVICE = UNIT_ROOT + 'proxypilot-a3-proxy-renew.service'
RENEW_TIMER = UNIT_ROOT + 'proxypilot-a3-proxy-renew.timer'
UNITS = (SUP_UNIT, PROXY_UNIT, BROKER_UNIT, RENEW_SERVICE, RENEW_TIMER)
JOURNALS = (STATE + '/supervisor-install.json', STATE + '/proxy-install.json',
            '/var/lib/proxypilot-a4/broker-install.json')
PUBLIC_KEY = ROOT + '/supervisor-pub.pem'
OWNED = tuple(SUPERVISOR + '/' + n for n in LEGACY + SELECTED) + (
    SUP_UNIT, RENEW_SERVICE, RENEW_TIMER, ROOT + '/origin-proxy.py',
    ROOT + '/selected_browser_gateway.py', ROOT + '/selected_browser_policy.py',
    PROXY_UNIT, BROKER, BROKER_UNIT) + JOURNALS
PROTECTED = (ROOT + '/supervisor-key.pem', PUBLIC_KEY, '/etc/proxypilot-a8/supervisor-pub.pem',
             ROOT + '/proxy-cert.pem', ROOT + '/proxy-key.pem', ROOT + '/fence.nft',
             ROOT + '/live.json', ROOT + '/selected-browser-acceptance.json',
             STATE + '/fence-install.json', STATE + '/supervisor-keys',
             '/etc/proxypilot-a4/broker-config.json', '/etc/proxypilot-a7',
             '/var/lib/proxypilot-a7/live-install.json', UNIT_ROOT + 'proxypilot-a3-fence.service',
             UNIT_ROOT+'proxypilot-a7-turn.service',UNIT_ROOT+'proxypilot-a7-turn-cert.service',
             UNIT_ROOT+'proxypilot-a7-turn-cert.timer','/etc/caddy/custom/pp-a7-turn.caddy',
             SOURCE + '/.env', SOURCE + '/docker-compose.yml', SOURCE_RECORD)
LEDGERS = (STATE + '/supervisor/state.json', '/var/lib/proxypilot-a4/broker/state.json', GATEWAY_STATE)
OPTIONAL = {ROOT + '/selected-browser-acceptance.json', STATE + '/supervisor-keys', GATEWAY_STATE}
SOURCE_NAMES = LEGACY + SELECTED + ('a4-credential-broker.py', 'a3-install-supervisor.py',
                                   'a4-install-broker.py', 'selected-runtime-package.py')
MAX_FILE = 2 * 1024 * 1024
MAX_LEDGER = 16 * 1024 * 1024
HEX = re.compile('[0-9a-f]{64}\\Z')
A8_SOCKET='/run/proxypilot-a3-backend/supervisor.sock'
A8_KEY='/etc/proxypilot-a8/supervisor-pub.pem'
A8_SETTINGS={'OPERATIONS_AGENT_SUPERVISOR_SOCKET':A8_SOCKET,'OPERATIONS_AGENT_SUPERVISOR_PUBLIC_KEY':A8_KEY,'OPERATIONS_AGENT_VM_UUID':VM_UUID}
A8_BEGIN='      # A8 backend-only mounts (a8-wire-dashboard.py)\n'
A8_END='      # End A8 backend-only mounts\n'
A8_BLOCK=A8_BEGIN+'''      - type: bind
        source: /run/proxypilot-a3-backend
        target: /run/proxypilot-a3-backend
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: /etc/proxypilot-a8
        target: /etc/proxypilot-a8
        read_only: true
        bind:
          create_host_path: false
'''+A8_END


def refuse(message):
    raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def inode(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink)


def file_stamp(info):
    return inode(info)+(info.st_size,info.st_mtime_ns,info.st_ctime_ns)


def strict(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                refuse('Duplicate journal field')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: refuse('Nonfinite journal'))
    except (UnicodeError, json.JSONDecodeError):
        refuse('Invalid bounded UTF-8 journal')


class Tree:
    """Fixed logical paths; a prefix is an in-process test seam only.

    Every ancestor and opened inode is checked. Replacement uses a pinned parent
    descriptor, an exclusive random sibling, file+directory fsync and readback.
    The existing root operator is the authority boundary, not hostile root.
    """
    def __init__(self, prefix=Path('/'), owner=0):
        self.prefix, self.owner = Path(prefix), owner
        self.base = self.prefix.stat()
        if self.prefix.is_symlink() or not stat.S_ISDIR(self.base.st_mode) or self.base.st_uid!=owner or self.base.st_mode&0o022:
            refuse('Package filesystem root custody changed')

    def path(self, logical):
        if not isinstance(logical, str) or not logical.startswith('/') or '..' in Path(logical).parts:
            refuse('Unknown package path')
        return self.prefix / logical.lstrip('/')

    def secure(self, logical, missing=False):
        if (self.prefix.stat().st_dev, self.prefix.stat().st_ino) != (self.base.st_dev, self.base.st_ino):
            refuse('Package filesystem root changed')
        path = self.path(logical)
        current = self.prefix
        for part in path.relative_to(self.prefix).parts:
            current = current / part
            try:
                info = current.lstat()
            except FileNotFoundError:
                if missing:
                    return None
                refuse('Required package path missing')
            if info.st_uid != self.owner or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
                refuse('Package path custody changed')
            if current != path and not stat.S_ISDIR(info.st_mode):
                refuse('Package ancestor is not a directory')
        return info

    def read(self, logical, limit=MAX_FILE, missing=False):
        info = self.secure(logical, missing=missing)
        if info is None:
            return None
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            refuse('Package file shape or bound changed')
        fd = os.open(self.path(logical), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino, opened.st_nlink, opened.st_uid, opened.st_mode) != (
                    info.st_dev, info.st_ino, 1, self.owner, info.st_mode):
                refuse('Package file changed during open')
            with os.fdopen(os.dup(fd), 'rb') as stream:
                value = stream.read(limit + 1)
            if len(value) > limit or file_stamp(self.secure(logical)) != file_stamp(opened) or file_stamp(os.fstat(fd)) != file_stamp(opened):
                refuse('Package file changed during read')
            return value
        finally:
            os.close(fd)

    def pin(self, logical, missing=False, limit=MAX_FILE):
        value = self.read(logical, limit, missing)
        return None if value is None else dict(sha256=sha(value), bytes=len(value),
                                              mode=stat.S_IMODE(self.secure(logical).st_mode))

    def mkdir(self, logical, mode):
        path = self.path(logical)
        parent=str(Path(logical).parent)
        before=self.secure(parent)
        fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            if inode(os.fstat(fd))!=inode(before):
                refuse('Package directory parent changed')
            created=False
            try:
                os.mkdir(path.name,mode,dir_fd=fd)
                created=True
            except FileExistsError:
                pass
            info=self.secure(logical)
            child=os.stat(path.name,dir_fd=fd,follow_symlinks=False)
            if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode)!=mode or
                    inode(info)!=inode(child) or inode(self.secure(parent))[:-1]!=inode(before)[:-1]):
                refuse('Package directory mode/parent changed')
            if created:
                # Sync the link in the parent, not merely later journal entries
                # inside the new directory, before external service effects.
                os.fsync(fd)
        finally:
            os.close(fd)

    def rmdir(self,logical):
        path=self.path(logical)
        expected=self.secure(logical)
        parent=str(Path(logical).parent)
        before=self.secure(parent)
        fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            if (not stat.S_ISDIR(expected.st_mode) or inode(os.fstat(fd))!=inode(before) or
                    inode(os.stat(path.name,dir_fd=fd,follow_symlinks=False))!=inode(expected) or
                    inode(self.secure(parent))!=inode(before)):
                refuse('Package empty-directory removal parent changed')
            os.rmdir(path.name,dir_fd=fd)
            os.fsync(fd)
        finally:
            os.close(fd)

    def write(self, logical, data, mode):
        path = self.path(logical)
        existing=self.secure(logical, missing=True)
        if existing is not None and (not stat.S_ISREG(existing.st_mode) or existing.st_nlink!=1):
            refuse('Package replacement target shape changed')
        parent = str(Path(logical).parent)
        before = self.secure(parent)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        name = '.selected-package-' + secrets.token_hex(16)
        try:
            if inode(os.fstat(fd)) != inode(before):
                refuse('Package parent changed')
            out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
            try:
                os.fchmod(out, mode)
                with os.fdopen(os.dup(out), 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                os.fsync(out)
                if inode(self.secure(parent)) != inode(before):
                    refuse('Package parent changed before replacement')
                os.replace(name, path.name, src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
            finally:
                os.close(out)
            if self.read(logical, max(MAX_FILE, len(data))) != data or self.pin(logical)['mode'] != mode:
                refuse('Package replacement verification failed')
        finally:
            try:
                os.unlink(name, dir_fd=fd)
            except FileNotFoundError:
                pass
            os.close(fd)

    def remove(self, logical):
        self.pin(logical)
        self.path(logical).unlink()
        fd = os.open(self.path(str(Path(logical).parent)), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def inventory(self, logical, missing=False):
        info = self.secure(logical, missing)
        if info is None:
            return None
        if stat.S_ISREG(info.st_mode):
            return self.pin(logical, limit=MAX_LEDGER)
        if not stat.S_ISDIR(info.st_mode):
            refuse('Protected runtime path is not data')
        result, total = {}, 0
        for directory, dirs, names in os.walk(self.path(logical), followlinks=False):
            for name in sorted(dirs + names):
                child = str(Path('/') / (Path(directory) / name).relative_to(self.prefix))
                item = self.secure(child)
                if stat.S_ISDIR(item.st_mode):
                    result[child] = dict(mode=stat.S_IMODE(item.st_mode), directory=True)
                else:
                    result[child] = self.pin(child, limit=MAX_LEDGER)
                    total += result[child]['bytes']
                if len(result) > 256 or total > 64 * 1024 * 1024:
                    refuse('Protected runtime inventory exceeds reviewed bound')
        return dict(mode=stat.S_IMODE(info.st_mode), entries=result)

    @contextlib.contextmanager
    def lock(self):
        self.secure(LOCK, missing=True)
        fd = os.open(self.path(LOCK), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            if info.st_uid != self.owner or info.st_nlink != 1 or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) not in {0o600,0o644}:
                refuse('Package lock custody changed')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if inode(self.secure(LOCK))!=inode(info):
                refuse('Package lock path changed')
            yield
        finally:
            os.close(fd)


def literals(data, fields):
    """Read only literal unit constants. Never import candidate root Python."""
    values = {}
    for item in ast.parse(data.decode('utf-8')).body:
        if isinstance(item, ast.Assign) and len(item.targets) == 1 and isinstance(item.targets[0], ast.Name):
            name = item.targets[0].id
            if name in fields:
                values[name] = ast.literal_eval(item.value)
    if set(values) != set(fields) or any(not isinstance(v, str) for v in values.values()):
        refuse('Fixed installer unit constants changed')
    return values


def validate_a8_wiring(env,compose):
    """Read-only fixed A8 contract; no import/patch of mutable candidate code."""
    found={}
    for line in env.splitlines():
        match=re.match(r'^\s*(?:export\s+)?(OPERATIONS_AGENT_\w+)\s*=(.*)$',line)
        if not match or match[1] not in A8_SETTINGS:
            continue
        if match[1] in found:
            refuse('Duplicate A8 setting')
        value=match[2].strip()
        if len(value)>=2 and value[0]==value[-1] and value[0] in "\"'":
            value=value[1:-1]
        found[match[1]]=value
    if found!=A8_SETTINGS:
        refuse('Existing A8 opt-in differs from fixed socket/public-key/VM contract')
    if '\r' in compose or '\t' in compose or compose.count('\n  proxypilot:\n')!=1:
        refuse('Unsupported A8 compose layout')
    start=compose.index('\n  proxypilot:\n')+1
    body=start+len('  proxypilot:\n')
    end_match=re.search(r'^\S|^  [a-zA-Z0-9_-]+:',compose[body:],re.M)
    end=body+end_match.start() if end_match else len(compose)
    service=compose[start:end]
    if (not re.search(r'^    privileged: true\s*$',service,re.M) or not re.search(r'^    pid: host\s*$',service,re.M) or
            re.search(r'^    (user|userns_mode|extends):|[&*][a-zA-Z_]',service,re.M) or
            not re.search(r'^    env_file:\n      - \.env\s*$',service,re.M) or any(n in service for n in A8_SETTINGS)):
        refuse('Existing A8 backend service identity differs')
    if service.count(A8_BEGIN)!=1 or service.count(A8_END)!=1 or A8_BLOCK not in service:
        refuse('Owned A8 read-only backend/public-key mount block changed')
    service=service.replace(A8_BLOCK,'')
    if service.count('    volumes:\n')!=1 or re.search(r'/run/proxypilot-a3|/etc/proxypilot-a[38](?:-proof)?(?:/|\b)',service):
        refuse('Conflicting A8 supervisor/secret/operator mount')


def candidate_files(sources):
    if set(sources) != set(SOURCE_NAMES):
        refuse('Source package owned set changed')
    for name, value in sources.items():
        if len(value) > MAX_FILE:
            refuse('Source file exceeds reviewed bound')
        if name.endswith('.json'):
            if set(strict(value)) != {'configuration', 'action'}:
                refuse('Source schema owned set changed')
        else:
            compile(value.decode('utf-8'), name, 'exec')
    sup = literals(sources['a3-install-supervisor.py'], ('UNIT_TEXT', 'RENEW_SERVICE_TEXT', 'RENEW_TIMER_TEXT'))
    proxy = literals(sources['a3-install-proxy.py'], ('UNIT_TEXT',))['UNIT_TEXT']
    broker = literals(sources['a4-install-broker.py'], ('UNIT_TEXT',))['UNIT_TEXT']
    proxy = proxy.replace('--serve\n', '--serve --selected-control\n').replace(
        'ProtectSystem=strict\n', 'ProtectSystem=strict\nRuntimeDirectory=proxypilot-a3\nRuntimeDirectoryMode=0700\nRuntimeDirectoryPreserve=yes\n'
        'ReadWritePaths=/run/proxypilot-a3 /var/lib/proxypilot-a3-proof/selected-gateway\n')
    if proxy.count('--serve --selected-control\n') != 1:
        refuse('Proxy selected-control unit contract changed')
    files = {SUPERVISOR + '/' + name: sources[name] for name in LEGACY + SELECTED}
    files.update({SUP_UNIT: sup['UNIT_TEXT'].encode(), RENEW_SERVICE: sup['RENEW_SERVICE_TEXT'].encode(),
                  RENEW_TIMER: sup['RENEW_TIMER_TEXT'].encode(), PROXY_UNIT: proxy.encode(),
                  ROOT + '/origin-proxy.py': sources['a3-origin-proxy.py'],
                  ROOT + '/selected_browser_gateway.py': sources['selected_browser_gateway.py'],
                  ROOT + '/selected_browser_policy.py': sources['selected_browser_policy.py'],
                  BROKER: sources['a4-credential-broker.py'], BROKER_UNIT: broker.encode()})
    if set(files) != set(OWNED) - set(JOURNALS):
        refuse('Candidate package layout changed')
    return files


def idle_ledgers(tree):
    supervisor = strict(tree.read(LEDGERS[0], MAX_LEDGER))
    broker = strict(tree.read(LEDGERS[1], MAX_LEDGER))
    for record in (supervisor, broker):
        if record.get('version') != 1 or record.get('vm_uuid') != VM_UUID:
            refuse('Runtime ledger identity changed')
    attempts = supervisor.get('attempts', {})
    calls = broker.get('calls', {})
    if (supervisor.get('active') is not None or any(a.get('state') not in {'stopped', 'lost', 'refused'} for a in attempts.values()) or
            any(c.get('state') not in {'uncertain', 'refused', 'abandoned', 'settled', 'settled_at_reservation', 'provider_error'}
                for c in calls.values())):
        refuse('Runtime work is active or unknown')
    for value in supervisor.get('public_reviews', {}).values():
        if value.get('state') not in {'reserved', 'completed', 'cancelled', 'failed'}:
            refuse('Runtime review state unknown')
        if value['state'] == 'reserved' and value.get('call_id') not in calls:
            refuse('Runtime review reservation unverifiable')
    for record in supervisor.get('selected_browser_model_runs',{}).values():
        if record.get('state') not in {'active','cancelled'} or not isinstance(record.get('calls',{}),dict):
            refuse('Selected model namespace state unknown')
        if any(call.get('state') not in {'completed','refused'} for call in record.get('calls',{}).values()):
            refuse('Selected model reservation active or unknown')
    supervisor.pop('supervisor_sha256', None)
    broker.pop('broker_sha256', None)
    gateway = tree.inventory(GATEWAY_STATE, missing=True)
    # A durable latch still identifies an attempt after restart. No install/update
    # clears it, even if the socket currently reports no active in-memory work.
    if tree.read(GATEWAY_STATE + '/selected-gateway-latch.json', missing=True) is not None:
        refuse('Selected gateway attempt remains latched')
    return {'supervisor': sha(encoded(supervisor)), 'broker': sha(encoded(broker)), 'gateway': gateway}


class Host:
    """Production read-only identity/health and fixed service operations."""
    def __init__(self):
        self.tree = Tree()

    def execute(self, args, timeout=30, input=None):
        return subprocess.run(args, check=True, capture_output=True, timeout=timeout, input=input, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}).stdout

    def wiring(self,require_socket=False):
        validate_a8_wiring(self.tree.read(SOURCE+'/.env').decode('utf-8'),self.tree.read(SOURCE+'/docker-compose.yml').decode('utf-8'))
        for directory in ('/run/proxypilot-a3-backend','/etc/proxypilot-a8'):
            if stat.S_IMODE(self.tree.secure(directory).st_mode)!=0o700:
                refuse('A8 dedicated directory mode changed')
        if sorted(f.name for f in self.tree.path('/etc/proxypilot-a8').iterdir())!=['supervisor-pub.pem']:
            refuse('A8 mounted directory contains other files')
        info=self.tree.secure(A8_SOCKET,missing=not require_socket)
        if info is not None and (not stat.S_ISSOCK(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600):
            refuse('A8 root-only backend socket identity changed')

    def sources(self):
        # Ordinary install/update copies /opt from the root runner's recorded
        # checkout. Never guess a Git root from the copied install or a branch.
        record = self.tree.read(SOURCE_RECORD, 4096)
        if self.tree.pin(SOURCE_RECORD)['mode'] not in {0o600, 0o644}:
            refuse('Recorded source custody/mode changed')
        try:
            checkout = record.decode('utf-8').removesuffix('\n')
        except UnicodeError:
            refuse('Recorded source is not UTF-8')
        path = Path(checkout)
        if (not checkout or '\n' in checkout or '\r' in checkout or '\x00' in checkout or
                not path.is_absolute() or str(path) != checkout or '..' in path.parts):
            refuse('Recorded source is not one canonical checkout')
        if not stat.S_ISDIR(self.tree.secure(checkout).st_mode):
            refuse('Recorded source is not a directory')
        self.tree.secure(checkout + '/.git')
        git = ['git', '-C', str(self.tree.path(checkout))]
        top = self.execute(git + ['rev-parse', '--show-toplevel']).decode().strip()
        if top != str(self.tree.path(checkout)):
            refuse('Recorded source Git root differs')
        # Worktrees may use a .git pointer. Its target and shared Git state must
        # have the same root-only custody as the recorded checkout.
        for argument in ('--git-dir', '--git-common-dir'):
            directory = self.execute(git + ['rev-parse', '--path-format=absolute', argument]).decode().strip()
            try:
                logical = '/' + str(Path(directory).relative_to(self.tree.prefix))
            except ValueError:
                refuse('Recorded Git state is outside the trusted tree')
            if not stat.S_ISDIR(self.tree.secure(logical).st_mode):
                refuse('Recorded Git state custody changed')
        revision = self.execute(git + ['rev-parse', '--verify', 'HEAD']).decode().strip()
        if not re.fullmatch('[0-9a-f]{40}', revision):
            refuse('Exact reviewed source revision required')
        files, modes = {}, {}
        for name in SOURCE_NAMES:
            installed = SOURCE + '/scripts/' + name
            value = self.tree.read(installed)
            # Copying into the install honors the root updater's umask.
            # Recognize ordinary/private source modes, never writable ones.
            mode = self.tree.pin(installed)['mode']
            if mode not in {0o600, 0o644, 0o700, 0o755}:
                refuse('Delivered source file mode differs from the reviewed contract')
            committed = self.execute(git + ['show', revision + ':scripts/' + name])
            if value != committed or self.tree.read(checkout + '/scripts/' + name) != committed:
                refuse('Source file differs from pinned checkout')
            files[name] = value
            modes[name] = mode
        if (self.tree.read(SOURCE_RECORD, 4096) != record or
                self.execute(git + ['rev-parse', '--verify', 'HEAD']).decode().strip() != revision or
                any(self.tree.read(SOURCE+'/scripts/'+name) != value or
                    self.tree.pin(SOURCE+'/scripts/'+name)['mode'] != modes[name] for name, value in files.items())):
            refuse('Recorded source/delivery changed during attestation')
        return revision, files, dict(path=checkout, record_sha256=sha(record), delivered_modes=modes)

    def identity(self, allow_work=False):
        self.wiring()
        query = lambda p: strict(self.execute(['incus', 'query', p]))
        vm = query('/1.0/instances/' + VM)
        running = query('/1.0/instances/' + VM + '/state')
        if vm.get('type') != 'virtual-machine' or vm.get('config', {}).get('volatile.uuid') != VM_UUID or running.get('status') != 'Running':
            refuse('Current proof VM identity is unverified')
        groups=self.execute(['incus','exec',VM,'--','/usr/bin/ls','-1','/sys/fs/cgroup/system.slice']).decode('utf-8').splitlines()
        if not allow_work and any(name.startswith('pp-a3-worker-') and name.endswith('.service') for name in groups):
            refuse('Guest worker cgroup remains; package must not trigger runtime cleanup')
        policy = self.execute(['incus', 'exec', VM, '--', 'sha256sum', '/etc/chromium/policies/managed/proxypilot-live.json']).decode().split()[0]
        der=self.execute(['openssl','pkey','-pubin','-in',PUBLIC_KEY,'-outform','DER'])
        key=sha(der)
        private_der=self.execute(['openssl','pkey','-in',ROOT+'/supervisor-key.pem','-pubout','-outform','DER'])
        canonical=b'-----BEGIN PUBLIC KEY-----\n'+base64.b64encode(der)+b'\n-----END PUBLIC KEY-----\n'
        if (len(der)!=44 or der[:12]!=bytes.fromhex('302a300506032b6570032100') or der!=private_der or
                self.tree.read(PUBLIC_KEY,512)!=canonical or self.tree.read(A8_KEY,512)!=canonical or not HEX.fullmatch(policy)):
            refuse('Existing receipt key/policy pin identity changed')
        self.execute(['openssl', 'x509', '-in', ROOT + '/proxy-cert.pem', '-checkend', '86400', '-noout'])
        certificate_public=self.execute(['openssl','x509','-in',ROOT+'/proxy-cert.pem','-pubkey','-noout'])
        certificate_der=self.execute(['openssl','pkey','-pubin','-outform','DER'],input=certificate_public)
        proxy_private=self.execute(['openssl','pkey','-in',ROOT+'/proxy-key.pem','-pubout','-outform','DER'])
        if certificate_der!=proxy_private:
            refuse('Existing proxy certificate/private-key pair changed')
        nft = strict(self.execute(['nft', '--json', 'list', 'table', 'bridge', 'pp_a3_proof']))
        def normalized(value):
            if isinstance(value, dict):
                return {k:normalized(v) for k,v in value.items() if k not in {'handle', 'metainfo', 'packets', 'bytes'}}
            return [normalized(v) for v in value] if isinstance(value, list) else value
        machine_id=self.tree.read('/etc/machine-id').decode().strip()
        if not re.fullmatch('[0-9a-f]{32}',machine_id):
            refuse('Current host machine identity unknown')
        return dict(machine_id=machine_id,
                    host_boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                    vm_uuid=VM_UUID, vm_configuration_sha256=sha(encoded({k:vm.get(k) for k in ('type','config','expanded_devices')})),
                    nft_sha256=sha(encoded(normalized(nft))), managed_policy_sha256=policy, key_id=key,
                    proxy_spki_sha256=sha(certificate_der))

    def unit_inventory(self, recovery=False):
        result = {}
        for path in UNITS:
            name = Path(path).name
            show = lambda p: self.execute(['systemctl', 'show', name, '--property=' + p, '--value']).decode().strip()
            reload=show('NeedDaemonReload')
            if show('FragmentPath') != path or show('DropInPaths') or reload not in ({'no','yes'} if recovery else {'no'}):
                refuse('Loaded fixed unit identity changed')
            state = show('ActiveState')
            if state not in {'active','inactive'} or path==RENEW_SERVICE and state!='inactive':
                refuse('Fixed service transition or renewal remains active')
            result[path] = {'active': state, 'enabled': show('UnitFileState')}
        return result

    def unit_check(self, active=True):
        result=self.unit_inventory()
        for path,item in result.items():
            wanted = 'inactive' if path == RENEW_SERVICE or not active else 'active'
            if item['active'] != wanted:
                refuse('Fixed service boundary is not idle/healthy')
        return result

    def stopped_backend(self):
        if self.execute(['docker', 'compose', '-f', SOURCE + '/docker-compose.yml', 'ps', '--status', 'running', '--quiet', 'proxypilot']).strip():
            refuse('Dashboard must be stopped by its authorized operator')
        database = SOURCE + '/data/db/proxypilot.db'
        self.tree.read(database, 128 * 1024 * 1024)
        with sqlite3.connect(self.tree.path(database).as_uri() + '?mode=ro', uri=True, timeout=5) as db:
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'ops_agent_runs' not in tables:
                refuse('Dashboard schema unknown')
            for table, terminal in (('ops_agent_runs', ('completed','cancelled','failed','blocked')),
                                    ('ops_selected_browser_runs', ('completed','cancelled','failed','uncertain')),
                                    ('ops_website_review_runs', ('completed','cancelled','failed','blocked','interrupted')),
                                    ('ops_browser_conversions', ('completed','blocked','cancelled','interrupted')),
                                    ('ops_agent_model_calls', ('chosen','refused','uncertain')),
                                    ('ops_selected_browser_model_reservations', ('settled','uncertain','suppressed'))):
                if table in tables and db.execute(f'SELECT 1 FROM {table} WHERE state NOT IN ({",".join("?" for _ in terminal)}) LIMIT 1', terminal).fetchone():
                    refuse('Dashboard work active or unknown')

    def rpc(self, path, method, gateway=False):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(15)
            client.connect(path)
            client.sendall(encoded(dict(v=1, method=method, params={}) if gateway else dict(method=method, params={})))
            raw = client.makefile('rb').readline(262145)
        if len(raw) > 262144 or not raw.endswith(b'\n'):
            refuse('Runtime health reply exceeds bound')
        reply = strict(raw)
        if reply.get('ok') is not True:
            refuse('Runtime health refused')
        return reply['result']

    def health(self, pins, key_id, selected, allow_work=False):
        self.wiring(require_socket=True)
        self.unit_check()
        def wait(path,method,gateway=False):
            deadline=time.monotonic()+30
            while True:
                try:
                    return self.rpc(path,method,gateway)
                except OSError:
                    if time.monotonic()>=deadline:
                        refuse('Fixed runtime socket did not become ready')
                    time.sleep(.25)
        a = wait('/run/proxypilot-a3/operator.sock', 'status')
        b = wait('/run/proxypilot-a4/broker.sock', 'status')
        active_work = (allow_work and isinstance(a.get('active'), dict) and a.get('blockers') == [])
        if ((not allow_work and a.get('active') is not None) or
                (a.get('accepting_launch') is not True and not active_work) or a.get('vm_uuid') != VM_UUID or
                a['supervisor'].get('key_id') != key_id or a['supervisor'].get('supervisor_sha256') != pins[SUPERVISOR + '/a3-worker-supervisor.py']['sha256'] or
                a['supervisor'].get('runner_sha256') != pins[SUPERVISOR + '/a3-worker-guest.py']['sha256'] or
                b.get('vm_uuid') != VM_UUID or b['broker'].get('broker_sha256') != pins[BROKER]['sha256']):
            refuse('Serving paired runtime identity changed')
        if selected:
            g = wait('/run/proxypilot-a3/selected-proxy.sock', 'health', True)
            expected = {n:pins[ROOT + '/' + n]['sha256'] for n in ('selected_browser_gateway.py','selected_browser_policy.py')}
            expected['a3-origin-proxy.py'] = pins[ROOT + '/origin-proxy.py']['sha256']
            if (type(g.get('active')) is not bool or (g['active'] and not allow_work) or
                    g.get('files') != expected or g.get('protocol') != 'selected-gateway.v1'):
                refuse('Serving gateway identity changed or latched')

    def stop(self):
        for path in (RENEW_TIMER, RENEW_SERVICE, SUP_UNIT, PROXY_UNIT, BROKER_UNIT):
            self.execute(['systemctl', 'stop', Path(path).name], timeout=90)
        result=self.unit_inventory(recovery=True)
        if any(s['active']!='inactive' for s in result.values()):
            refuse('Fixed paired services did not stop')

    def start(self):
        self.execute(['systemctl', 'daemon-reload'])
        for path in (BROKER_UNIT, PROXY_UNIT, SUP_UNIT, RENEW_TIMER):
            self.execute(['systemctl', 'start', Path(path).name], timeout=90)


class Package:
    def __init__(self, host, clock=time.time):
        self.h, self.t, self.clock = host, host.tree, clock

    def protected(self):
        value={p:self.t.inventory(p, missing=p in OPTIONAL) for p in PROTECTED}
        for p,mode in ((ROOT+'/supervisor-key.pem',0o600),(PUBLIC_KEY,0o644),
                       ('/etc/proxypilot-a8/supervisor-pub.pem',0o600),(ROOT+'/proxy-key.pem',0o600),
                       (ROOT+'/proxy-cert.pem',0o644),('/etc/proxypilot-a4/broker-config.json',0o600)):
            if value[p]['mode']!=mode:
                refuse('Existing private key/config custody differs from reviewed contract')
        gateway=self.t.secure(GATEWAY_STATE,missing=True)
        if gateway is not None and (not stat.S_ISDIR(gateway.st_mode) or stat.S_IMODE(gateway.st_mode)!=0o700):
            refuse('Dedicated gateway state root mode changed')
        return value

    def installed(self, operation):
        journals = [strict(self.t.read(p)) for p in JOURNALS]
        sup, proxy, broker = journals
        expected_sup = {SUPERVISOR + '/' + n for n in LEGACY + (() if operation == 'install' else SELECTED)} | {SUP_UNIT, RENEW_SERVICE, RENEW_TIMER, PUBLIC_KEY}
        expected_proxy = {ROOT + '/origin-proxy.py', PROXY_UNIT, ROOT + '/proxy-cert.pem', ROOT + '/proxy-key.pem'}
        if operation != 'install':
            expected_proxy |= {ROOT + '/selected_browser_gateway.py', ROOT + '/selected_browser_policy.py'}
        for record, expected in zip(journals, (expected_sup, expected_proxy, {BROKER, BROKER_UNIT})):
            if record.get('version') != 1 or record.get('phase') != 'installed' or record.get('vm_uuid') != VM_UUID or set(record.get('files', {})) != expected:
                refuse('Installed package journal/owned set differs from reviewed contract')
            for path, digest in record['files'].items():
                if not HEX.fullmatch(str(digest)) or self.t.pin(path)['sha256'] != digest:
                    refuse('Installed package hash drift')
        pins = {p:self.t.pin(p, missing=True) for p in OWNED}
        for p, pin in pins.items():
            new = p in {SUPERVISOR + '/' + n for n in SELECTED} | {ROOT + '/selected_browser_gateway.py', ROOT + '/selected_browser_policy.py'}
            if operation == 'install' and new:
                if pin is not None:
                    refuse('Unowned selected runtime file exists')
            elif pin is None or pin['mode'] != (0o600 if p in JOURNALS else 0o644):
                refuse('Installed package file mode/absence changed')
        return journals, pins

    def candidates(self, sources, journals):
        files = candidate_files(sources)
        for path, current in zip(JOURNALS, journals):
            value = copy.deepcopy(current)
            allowed = set(value['files'])
            if path == JOURNALS[0]:
                allowed |= {SUPERVISOR + '/' + n for n in SELECTED}
            if path == JOURNALS[1]:
                allowed |= {ROOT + '/selected_browser_gateway.py', ROOT + '/selected_browser_policy.py'}
            value['files'] = {p:sha(files[p]) if p in files else value['files'][p] for p in sorted(allowed)}
            files[path] = encoded(value)
        return files

    def save(self, name, value):
        self.t.write(TRANSACTION + '/' + name, encoded(value), 0o600)

    def tx(self):
        if self.t.pin(TRANSACTION+'/transaction.json')['mode']!=0o600 or stat.S_IMODE(self.t.secure(TRANSACTION).st_mode)!=0o700:
            refuse('Package transaction custody changed')
        data = strict(self.t.read(TRANSACTION + '/transaction.json'))
        fields = {'schema','id','phase','operation','plan_sha256','identity','protected','ledgers','units','files','gateway_created'}
        if (set(data) != fields or data['schema'] != VERSION or data['phase'] not in {'prepared','stopped','replacing','applied','restoring','rolled_back','committed'} or
                data['operation'] not in {'install','update'} or set(data['files']) != set(OWNED) or
                set(data['protected']) != set(PROTECTED) or set(data['units']) != set(UNITS) or
                not HEX.fullmatch(data['plan_sha256']) or not re.fullmatch('[0-9a-f]{32}', data['id']) or
                type(data['gateway_created']) is not bool):
            refuse('Unknown package transaction; no recovery effects')
        for p, rec in data['files'].items():
            if set(rec) != {'old','new'} or not isinstance(rec['new'], dict):
                refuse('Unknown package transaction file')
            for pin in (rec['old'], rec['new']):
                if pin is not None and (set(pin) != {'sha256','bytes','mode'} or not HEX.fullmatch(str(pin['sha256'])) or
                        type(pin['bytes']) is not int or not 0 <= pin['bytes'] <= MAX_FILE or pin['mode'] != (0o600 if p in JOURNALS else 0o644)):
                    refuse('Unknown package transaction pin')
        return data

    def current_identity(self, prior=None):
        value = self.h.identity()
        if not isinstance(value, dict) or value.get('vm_uuid') != VM_UUID or not HEX.fullmatch(str(value.get('key_id'))):
            refuse('Current host identity unknown')
        # Reboot is reviewable during recovery. Identity/config/policy/fence/key
        # still have to match; the fresh operator receipt pins the new boot ID.
        if prior and {k:v for k,v in value.items() if k != 'host_boot_id'} != {k:v for k,v in prior.items() if k != 'host_boot_id'}:
            refuse('Current host identity drift')
        return value

    def snapshot(self, operation):
        identity = self.current_identity()
        protected = self.protected()
        ledgers = idle_ledgers(self.t)
        if operation in {'install','update'}:
            self.h.stopped_backend()
            journals, pins = self.installed(operation)
            if journals[0].get('key_id') != identity['key_id']:
                refuse('Existing installation receipt key differs')
            revision, sources, checkout = self.h.sources()
            files = self.candidates(sources, journals)
            new = {p:dict(sha256=sha(b), bytes=len(b), mode=0o600 if p in JOURNALS else 0o644) for p,b in files.items()}
            if self.t.read(TRANSACTION + '/transaction.json', missing=True) is not None and self.tx()['phase'] not in {'committed','rolled_back'}:
                refuse('Incomplete package transaction requires separately reviewed recovery')
            self.h.health(pins, identity['key_id'], operation == 'update')
            units = self.h.unit_check()
            plan = dict(schema=VERSION, operation=operation, source_revision=revision, source_checkout=checkout,
                        source_files={n:sha(b) for n,b in sources.items()}, identity=identity, protected=protected,
                        ledgers=ledgers, units=units, files={p:dict(old=pins[p],new=new[p]) for p in OWNED})
            return plan, files
        data = self.tx()
        self.current_identity(data['identity'])
        self.h.stopped_backend()
        if protected != data['protected'] or self.ledger_equal(ledgers, data['ledgers']) is False:
            refuse('Protected identity/state drift before recovery')
        if operation == 'commit':
            if data['phase'] != 'applied':
                refuse('Only verified applied package may commit')
        elif operation == 'recover' and data['phase'] not in {'prepared','stopped','replacing','restoring'}:
            refuse('Only incomplete transaction requires recovery')
        elif operation == 'rollback' and data['phase'] not in {'applied','committed'}:
            refuse('Only applied package may roll back')
        current = self.verify_transaction(data, require_new=operation == 'commit')
        revision,sources,checkout=self.h.sources()
        candidate_files(sources)
        units=self.h.unit_inventory(recovery=True)
        if {u:s['enabled'] for u,s in units.items()}!={u:s['enabled'] for u,s in data['units'].items()}:
            refuse('Fixed unit enablement changed before recovery')
        return dict(schema=VERSION, operation=operation, transaction_id=data['id'], transaction_sha256=sha(encoded(data)),
                    identity=identity, protected=protected, ledgers=ledgers, files=current,units=units,
                    source_revision=revision,source_checkout=checkout,source_files={n:sha(b) for n,b in sources.items()}), None

    @staticmethod
    def ledger_equal(current, previous):
        # Initial install may create only the previously absent empty gateway
        # directory. No latch/history is cleared or invented.
        a,b = copy.deepcopy(current),copy.deepcopy(previous)
        if b['gateway'] is None and a['gateway'] == {'mode':0o700,'entries':{}}:
            a['gateway'] = None
        return a == b

    def plan(self, operation):
        value,_ = self.snapshot(operation)
        return dict(plan_sha256=sha(encoded(value)), plan=value, acceptance_created=False, runtime_accepted=False)

    def review(self, operation, expected):
        result = self.plan(operation)
        if result['plan_sha256'] != expected:
            refuse('Operator review plan changed')
        # No automated CLI flag can replace the production TTY confirmation.
        self.t.mkdir(TRANSACTION, 0o700)
        receipt = dict(schema=VERSION, operation=operation, plan_sha256=expected,
                       reviewed_at=self.clock(), expires_at=self.clock()+900, token=secrets.token_hex(32))
        self.save('review.json', receipt)
        return dict(reviewed=True, plan_sha256=expected, expires_at=receipt['expires_at'])

    def reviewed(self, operation, expected):
        receipt = strict(self.t.read(TRANSACTION + '/review.json'))
        if (set(receipt) != {'schema','operation','plan_sha256','reviewed_at','expires_at','token'} or
                receipt['schema'] != VERSION or receipt['operation'] != operation or receipt['plan_sha256'] != expected or
                not HEX.fullmatch(str(receipt['token'])) or type(receipt['reviewed_at']) not in (int,float) or
                type(receipt['expires_at']) not in (int,float) or not receipt['reviewed_at'] <= self.clock() < receipt['expires_at'] <= receipt['reviewed_at']+900):
            refuse('Fresh root-owned operator review required')
        self.t.secure(TRANSACTION)
        if stat.S_IMODE(self.t.secure(TRANSACTION).st_mode) != 0o700 or self.t.pin(TRANSACTION + '/review.json')['mode'] != 0o600:
            refuse('Operator review custody changed')
        plan, files = self.snapshot(operation)
        if sha(encoded(plan)) != expected:
            refuse('Source/installed/host/state plan drift before effects')
        return plan, files

    def verify_transaction(self, data, require_new=False):
        generation=self.t.secure(TRANSACTION+'/'+data['id'])
        if not stat.S_ISDIR(generation.st_mode) or stat.S_IMODE(generation.st_mode)!=0o700:
            refuse('Private package generation custody changed')
        current = {}
        for n,p in enumerate(OWNED):
            rec = data['files'][p]
            for label in ('old','new'):
                if rec[label] is not None:
                    pin = self.t.pin(TRANSACTION + '/' + data['id'] + '/' + label + '-' + str(n))
                    if pin['sha256'] != rec[label]['sha256'] or pin['bytes'] != rec[label]['bytes'] or pin['mode'] != 0o600:
                        refuse('Package backup/stage bytes drift; no effects')
            pin = self.t.pin(p, missing=True)
            if pin != rec['new'] and (require_new or pin != rec['old']):
                refuse('Installed bytes differ from recognized old/new transaction')
            current[p] = pin
        return current

    def preserved(self, data):
        self.current_identity(data['identity'])
        if self.protected() != data['protected'] or not self.ledger_equal(idle_ledgers(self.t),data['ledgers']):
            refuse('Immutable identity/state changed during package transaction')
        self.h.stopped_backend()

    def apply(self, expected):
        receipt = strict(self.t.read(TRANSACTION + '/review.json'))
        operation = receipt.get('operation')
        if operation not in {'install','update'}:
            refuse('Install/update operator review required')
        plan, files = self.reviewed(operation, expected)
        txid = secrets.token_hex(16)
        self.t.mkdir(TRANSACTION + '/' + txid, 0o700)
        for n,p in enumerate(OWNED):
            if plan['files'][p]['old'] is not None:
                self.t.write(TRANSACTION + '/' + txid + '/old-' + str(n), self.t.read(p), 0o600)
            self.t.write(TRANSACTION + '/' + txid + '/new-' + str(n), files[p], 0o600)
        data = dict(schema=VERSION,id=txid,phase='prepared',operation=operation,plan_sha256=expected,
                    identity=plan['identity'],protected=plan['protected'],ledgers=plan['ledgers'],units=plan['units'],
                    files=plan['files'],gateway_created=plan['ledgers']['gateway'] is None)
        # Recheck all review authority and every real source/installed byte after
        # backup staging, before the first service operation or target write.
        self.reviewed(operation,expected)
        self.verify_transaction(data)
        self.save('transaction.json',data)
        self.t.remove(TRANSACTION + '/review.json')
        self.h.stop()
        self.preserved(data)
        data['phase']='stopped'; self.save('transaction.json',data)
        self.verify_transaction(data)
        if data['gateway_created']:
            self.t.mkdir(GATEWAY_STATE,0o700)
        data['phase']='replacing'; self.save('transaction.json',data)
        for n,p in enumerate(OWNED):
            self.t.write(p,self.t.read(TRANSACTION + '/' + txid + '/new-' + str(n)),data['files'][p]['new']['mode'])
        self.verify_transaction(data,require_new=True)
        self.preserved(data)
        self.h.start()
        self.h.health({p:r['new'] for p,r in data['files'].items()},data['identity']['key_id'],True)
        if self.h.unit_check() != data['units']:
            refuse('Service enablement/identity changed')
        self.preserved(data)
        data['phase']='applied'; self.save('transaction.json',data)
        return dict(applied=True,operation=operation,plan_sha256=expected,acceptance_created=False,runtime_accepted=False)

    def restore(self, operation, expected):
        self.reviewed(operation,expected)
        data=self.tx()
        self.verify_transaction(data)
        self.t.remove(TRANSACTION + '/review.json')
        self.h.stop()
        self.preserved(data)
        self.verify_transaction(data)
        data['phase']='restoring'; self.save('transaction.json',data)
        for n,p in enumerate(OWNED):
            rec=data['files'][p]
            if rec['old'] is None:
                if self.t.pin(p,missing=True) is not None:
                    self.t.remove(p)
            else:
                self.t.write(p,self.t.read(TRANSACTION + '/' + data['id'] + '/old-' + str(n)),rec['old']['mode'])
        if data['gateway_created'] and self.t.secure(GATEWAY_STATE,missing=True) is not None:
            if self.t.inventory(GATEWAY_STATE) != {'mode':0o700,'entries':{}}:
                refuse('Gateway state is not empty; never delete runtime history')
            self.t.rmdir(GATEWAY_STATE)
        for p,rec in data['files'].items():
            if self.t.pin(p,missing=True) != rec['old']:
                refuse('Paired restore readback mismatch')
        self.preserved(data)
        self.h.start()
        self.h.health({p:r['old'] for p,r in data['files'].items()},data['identity']['key_id'],data['operation']=='update')
        if self.h.unit_check() != data['units']:
            refuse('Restored service enablement changed')
        self.preserved(data)
        data['phase']='rolled_back';self.save('transaction.json',data)
        return dict(rolled_back=True,recovered=operation=='recover',replayed=False,acceptance_created=False)

    def commit(self, expected):
        self.reviewed('commit',expected)
        data=self.tx()
        self.h.health({p:r['new'] for p,r in data['files'].items()},data['identity']['key_id'],True)
        self.preserved(data)
        data['phase']='committed';self.save('transaction.json',data)
        self.t.remove(TRANSACTION + '/review.json')
        return dict(committed=True,plan_sha256=data['plan_sha256'],runtime_accepted=False)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('plan','review','apply','recover','rollback','commit'))
    parser.add_argument('--operation',choices=('install','update','recover','rollback','commit'))
    parser.add_argument('--plan-sha256')
    args=parser.parse_args()
    if os.geteuid()!=0:
        parser.error('Actual UID0 operator required')
    if Path(__file__).absolute()!=Path(SOURCE+'/scripts/selected-runtime-package.py') or Path(__file__).is_symlink():
        parser.error('Reviewed fixed installed source path required; no checkout execution')
    host=Host()
    host.tree.secure(SOURCE+'/scripts/selected-runtime-package.py')
    if args.action in ('plan','review') and args.operation is None:
        parser.error('Explicit operation required')
    if args.action not in ('plan','review') and args.operation is not None:
        parser.error('Operation is bound by review/action; no extra operation accepted')
    if args.action=='plan' and args.plan_sha256 is not None:
        parser.error('Plan generation does not accept a prior approval hash')
    if args.action!='plan' and (not HEX.fullmatch(args.plan_sha256 or '')):
        parser.error('Exact reviewed plan SHA256 required')
    if args.action=='review' and (not sys.stdin.isatty() or not sys.stdout.isatty()):
        parser.error('Interactive root operator review required')
    with host.tree.lock():
        package=Package(host)
        if args.action=='plan':
            result=package.plan(args.operation)
        elif args.action=='review':
            proposed=package.plan(args.operation)
            if proposed['plan_sha256']!=args.plan_sha256:
                refuse('Review plan changed')
            print(json.dumps(proposed,indent=2))
            if input('Confirm this complete separate package contract by typing its plan SHA256: ')!=args.plan_sha256:
                refuse('Operator review declined')
            result=package.review(args.operation,args.plan_sha256)
        elif args.action in ('recover','rollback'):
            result=package.restore(args.action,args.plan_sha256)
        else:
            result=getattr(package,args.action)(args.plan_sha256)
        print(json.dumps(result,sort_keys=True))


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        # A parser/service failure can contain credential or journal bytes. Never
        # echo subprocess output, user values, bodies, paths or tracebacks.
        print('Selected runtime package refused: '+(str(error) if isinstance(error,ValueError) else type(error).__name__),file=sys.stderr)
        sys.exit(1)
