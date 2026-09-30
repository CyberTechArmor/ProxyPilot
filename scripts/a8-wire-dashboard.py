#!/usr/bin/env python3
"""Explicit A8 opt-in; patch only an already opted-in Docker installation.

Only the backend runtime directory and a copy of the PUBLIC receipt key are
mounted. No service is restarted and no toggle, account or run is changed.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import tempfile
import time

SOCKET = Path('/run/proxypilot-a3-backend/supervisor.sock')
KEY_DIR = Path('/etc/proxypilot-a8')
KEY = KEY_DIR / 'supervisor-pub.pem'
SOURCE_KEY = Path('/etc/proxypilot-a3-proof/supervisor-pub.pem')
INSTALLED = Path('/etc/proxypilot-a3-proof/supervisor/a3-install-supervisor.py')
VM = '49592202-a8b0-45af-9ac6-5439761d73e4'
SETTINGS = {'OPERATIONS_AGENT_SUPERVISOR_SOCKET': str(SOCKET),
            'OPERATIONS_AGENT_SUPERVISOR_PUBLIC_KEY': str(KEY),
            'OPERATIONS_AGENT_VM_UUID': VM}
BEGIN = '      # A8 backend-only mounts (a8-wire-dashboard.py)\n'
END = '      # End A8 backend-only mounts\n'
BLOCK = BEGIN + f'''      - type: bind
        source: {SOCKET.parent}
        target: {SOCKET.parent}
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: {KEY_DIR}
        target: {KEY_DIR}
        read_only: true
        bind:
          create_host_path: false
''' + END


def secure(path):
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError('Refusing symlink in configuration path')
        if part.exists():
            info = part.stat()
            if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                raise ValueError('Configuration paths must be exclusively root-owned')


def read_settings(text):
    found = {}
    for line in text.splitlines():
        match = re.match(r'^\s*(?:export\s+)?(OPERATIONS_AGENT_\w+)\s*=(.*)$', line)
        if not match or match[1] not in SETTINGS:
            continue
        if match[1] in found:
            raise ValueError('Duplicate A8 setting')
        value = match[2].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        found[match[1]] = value
    return found


def configured(text):
    values = read_settings(text)
    if not any(values.values()):
        return False
    if values != SETTINGS:
        raise ValueError('A8 requires all three reviewed socket/key/VM settings')
    return True


def compose_text(text):
    """Bounded patch of the installer's service. Custom/ambiguous YAML refuses."""
    if '\r' in text or '\t' in text or text.count('\n  proxypilot:\n') != 1:
        raise ValueError('Unsupported compose layout; review before wiring A8')
    start = text.index('\n  proxypilot:\n') + 1
    body = start + len('  proxypilot:\n')
    end_match = re.search(r'^\S|^  [a-zA-Z0-9_-]+:', text[body:], re.M)
    end = body + end_match.start() if end_match else len(text)
    service = text[start:end]
    if not re.search(r'^    privileged: true\s*$', service, re.M) or not re.search(r'^    pid: host\s*$', service, re.M):
        raise ValueError('A8 pilot requires the reviewed legacy root backend deployment')
    if re.search(r'^    (user|userns_mode|extends):|[&*][a-zA-Z_]', service, re.M):
        raise ValueError('Custom user or inherited compose service requires review')
    if not re.search(r'^    env_file:\n      - \.env\s*$', service, re.M):
        raise ValueError('Expected the installation .env in compose')
    if any(name in service for name in SETTINGS):
        raise ValueError('Compose must not override A8 environment settings')
    if BEGIN in service or END in service:
        if service.count(BEGIN) != 1 or service.count(END) != 1 or BLOCK not in service:
            raise ValueError('Owned A8 mount block changed')
        service = service.replace(BLOCK, '')
    # Both directories are dedicated. Never expose the operator socket or the
    # A3 key directory, or silently retain an old socket-file mount.
    if re.search(r'/run/proxypilot-a3|/etc/proxypilot-a[38](?:-proof)?(?:/|\b)', service):
        raise ValueError('Conflicting supervisor mount requires explicit review')
    if service.count('    volumes:\n') != 1:
        raise ValueError('Expected one service volumes section')
    service = service.replace('    volumes:\n', '    volumes:\n' + BLOCK)
    return text[:start] + service + text[end:]


def public_key_id(path):
    # Exact Ed25519 SPKI, not an arbitrary public/private key or PEM bundle.
    secure(path)
    data = path.read_bytes()
    if len(data) > 512 or not data.startswith(b'-----BEGIN PUBLIC KEY-----\n'):
        raise ValueError('Expected a bounded Ed25519 public key')
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-in', str(path), '-outform', 'DER'],
                         capture_output=True, check=True, timeout=10).stdout
    if len(der) != 44 or der[:12] != bytes.fromhex('302a300506032b6570032100'):
        raise ValueError('Expected an Ed25519 public key')
    canonical = b'-----BEGIN PUBLIC KEY-----\n' + base64.b64encode(der) + b'\n-----END PUBLIC KEY-----\n'
    if data != canonical:
        raise ValueError('Expected one canonical public key with no appended content')
    return hashlib.sha256(der).hexdigest()


def wiring_checks():
    secure(SOCKET)
    secure(KEY)
    if not SOCKET.is_socket() or stat.S_IMODE(SOCKET.stat().st_mode) != 0o600:
        raise ValueError('Expected the installed root-only backend socket')
    for directory in (SOCKET.parent, KEY_DIR):
        if stat.S_IMODE(directory.stat().st_mode) != 0o700:
            raise ValueError('Backend and public-key directories must be mode 0700')
    key_id = public_key_id(KEY)
    if KEY.read_bytes() != SOURCE_KEY.read_bytes() or key_id != public_key_id(SOURCE_KEY):
        raise ValueError('Dashboard public key differs from the installed supervisor key')
    if sorted(p.name for p in KEY_DIR.iterdir()) != [KEY.name]:
        raise ValueError('Only the public key may be in the mounted key directory')
    return key_id


def installed_checks():
    secure(INSTALLED)
    spec = importlib.util.spec_from_file_location('a8_installed_supervisor', INSTALLED)
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    result = installer.status()  # Recorded sources, loaded unit, pins, dependencies.
    if result['vm_uuid'] != VM or result['active'] is not None or not result['accepting_launch']:
        raise ValueError('Expected the idle, ready proof supervisor')
    if result['key_id'] != public_key_id(SOURCE_KEY):
        raise ValueError('Installed receipt key differs from the serving supervisor')
    return result


def atomic(path, data, mode):
    secure(path)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def commit(install_dir, changes, verify=lambda: None):
    """Private byte-exact backup before any write; rollback on write failure."""
    changes = {p: data for p, data in changes.items() if not p.exists() or p.read_bytes() != data}
    if not changes:
        verify()
        return None
    backup_root = install_dir / '.a8-backups'
    secure(backup_root)
    backup_root.mkdir(mode=0o700, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%SZ-'), dir=backup_root))
    previous = {}
    inventory = []
    for index, path in enumerate(changes):
        secure(path)
        old = path.read_bytes() if path.exists() else None
        mode = stat.S_IMODE(path.stat().st_mode) if old is not None else 0o600
        previous[path] = (old, mode)
        name = str(index)
        if old is not None:
            atomic(backup / name, old, 0o600)
        inventory.append({'path': str(path), 'file': name, 'existed': old is not None,
                          'sha256': hashlib.sha256(old).hexdigest() if old is not None else None, 'mode': mode})
    atomic(backup / 'inventory.json', (json.dumps(inventory, indent=2) + '\n').encode(), 0o600)
    written = []
    try:
        for path, data in changes.items():
            written.append(path)
            atomic(path, data, 0o600 if path.name == '.env' or path == KEY else previous[path][1])
        verify()
    except BaseException:
        for path in reversed(written):
            old, mode = previous[path]
            if old is None:
                path.unlink(missing_ok=True)
            else:
                atomic(path, old, mode)
        raise
    return str(backup)


def run(mode, install_dir):
    env = install_dir / '.env'
    # Default installs are unchanged; no probe, directory or backup is created.
    text = env.read_text() if env.exists() else ''
    enabled = configured(text)
    if not enabled and mode != 'configure':
        return {'configured': False, 'changed': False}
    if os.geteuid() != 0:
        raise ValueError('A8 wiring requires the host operator (root)')
    for path in (env, install_dir / 'docker-compose.yml', KEY_DIR, SOURCE_KEY):
        secure(path)
    original = (install_dir / 'docker-compose.yml').read_text()
    patched = compose_text(original)  # Validate layout before copying any key.
    changes = {}
    if mode == 'configure':
        installed_checks()
        public_key_id(SOURCE_KEY)
        KEY_DIR.mkdir(mode=0o700, exist_ok=True)
        if stat.S_IMODE(KEY_DIR.stat().st_mode) != 0o700:
            raise ValueError('Mounted public-key directory must be mode 0700')
        if any(p.name != KEY.name for p in KEY_DIR.iterdir()):
            raise ValueError('Mounted key directory contains unrelated files')
        changes[KEY] = SOURCE_KEY.read_bytes()
        # Preserve all unrelated .env bytes. Replace only the three own keys.
        kept = [line for line in text.splitlines(keepends=True)
                if not re.match(r'^\s*(?:export\s+)?(' + '|'.join(SETTINGS) + r')\s*=', line)]
        new_env = ''.join(kept)
        if new_env and not new_env.endswith('\n'):
            new_env += '\n'
        changes[env] = (new_env + ''.join(f'{k}={v}\n' for k, v in SETTINGS.items())).encode()
    else:
        wiring_checks()
    if mode == 'status':
        if patched != original:
            raise ValueError('A8 compose mounts are missing')
        return {'configured': True, 'changed': False, 'key_id': wiring_checks(), 'vm_uuid': VM,
                'socket': str(SOCKET), 'public_key': str(KEY), 'mounts': 'backend-directory/public-key-only'}
    changes[install_dir / 'docker-compose.yml'] = patched.encode()
    # configure checks the socket before commit, as well as the serving pins.
    secure(SOCKET)
    if not SOCKET.is_socket() or stat.S_IMODE(SOCKET.stat().st_mode) != 0o600:
        raise ValueError('Backend socket is missing or has the wrong mode')
    if stat.S_IMODE(SOCKET.parent.stat().st_mode) != 0o700:
        raise ValueError('Backend directory must be mode 0700')
    checked = {}
    def verify():
        checked['key_id'] = wiring_checks()
    backup = commit(install_dir, changes, verify)
    return {'configured': True, 'changed': backup is not None, 'backup': backup,
            'key_id': checked['key_id'], 'vm_uuid': VM, 'restart_required': backup is not None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('configure', 'patch', 'status'))
    parser.add_argument('--install-dir', type=Path, default=Path('/opt/proxypilot'))
    args = parser.parse_args()
    try:
        if not args.install_dir.is_absolute():
            raise ValueError('Install directory must be absolute')
        print(json.dumps(run(args.mode, args.install_dir)))
    except (OSError, ValueError, subprocess.SubprocessError):
        # No .env contents, key material, subprocess output or exception detail.
        print(json.dumps({'ok': False, 'error': 'A8 wiring refused; review paths, pins and compose layout'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
