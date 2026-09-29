#!/usr/bin/env python3
"""A7 live view on the proof host: Neko in the proof VM and the TURN relay.

Root only. Each subcommand is one reviewed step (user decisions 1, 1a and 1b,
2026-09-29: Neko inside the worker unit; TURN with a TLS fallback):

  build-neko      Clone Neko at the pinned commit, apply ProxyPilot's reviewed
                  Unix-socket patch, build the server in the pinned Debian trixie
                  Go image (Docker on this host), record the binary's sha256.
  build-probe     Build the host proof's WebRTC viewer (cmd/a7-live-probe from
                  this checkout) in the same image, every module checked against
                  its reviewed go.sum; record the binary's sha256.
  provision-vm    Snapshot the proof VM, then push the built Neko, the managed
                  Chromium policy and the Debian packages the live desktop needs
                  (never while a worker attempt runs); read every file back.
  install-turn    coturn under its own unit and config: TURN on 3478 UDP/TCP and
                  TURN over TLS on 5349 for viewers (on this host's default-route
                  address unless --listen-ip), relaying only to the VM's one
                  Neko port from the gateway address. A new shared secret (root
                  0600; never printed). Optionally a Caddy site for the hostname
                  so Caddy obtains its certificate.
  cert-sync       Copy the certificate Caddy keeps for the TURN hostname (also run
                  daily by a timer) and reload the relay when it changed.
  enable          The fence's one live-relay line, then live.json: from the next
                  launch the supervisor runs browser attempts live.
  disable         live.json removed first, then the fence line; the relay stopped.
  status          Every piece, read-only.

Nothing here reaches the proof VM's network: the packages are downloaded on the
host in a throwaway Debian trixie container and pushed with `incus file push`.
Never pp-nodus, never an Incus upgrade or archive.
"""
import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent


def _module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fence_installer = _module('a7_fence_installer', 'a3-install-fence.py')
fence = fence_installer.fence
runner = _module('a7_worker_guest', 'a3-worker-guest.py')

VM = fence.VM
GUEST_IPV4 = fence_installer.MANIFEST['guest_ipv4']
GATEWAY_IPV4 = fence_installer.MANIFEST['gateway_ipv4']
CONFIG = Path('/etc/proxypilot-a7')
STATE = Path('/var/lib/proxypilot-a7')
JOURNAL = STATE / 'live-install.json'
BUILD = STATE / 'build'
NEKO_OUT = STATE / 'neko'
PROBE_OUT = STATE / 'a7-live-probe'
PROBE_SOURCE = HERE.parent / 'cmd' / 'a7-live-probe'
DEBS = STATE / 'debs'
TURN_CONF = CONFIG / 'turnserver.conf'
TURN_SECRET = CONFIG / 'turn-secret'
TURN_CERT = CONFIG / 'turn-cert.pem'
TURN_KEY = CONFIG / 'turn-key.pem'
TURN_UNIT = Path('/etc/systemd/system/proxypilot-a7-turn.service')
CERT_SERVICE = Path('/etc/systemd/system/proxypilot-a7-turn-cert.service')
CERT_TIMER = Path('/etc/systemd/system/proxypilot-a7-turn-cert.timer')
CADDY_SITE = Path('/etc/caddy/custom/pp-a7-turn.caddy')
CADDY_CERTS = Path('/var/lib/caddy/.local/share/caddy/certificates')
LIVE_MARKER = fence_installer.CONFIG / 'live.json'
OPERATOR_SOCKET = Path('/run/proxypilot-a3/operator.sock')
TURNSERVER = Path('/usr/bin/turnserver')
TURN_USER = 'turnserver'

NEKO_REPO = 'https://github.com/m1k1o/neko.git'
NEKO_COMMIT = '3f4f94087a1fd40b2aaddd5aad00a2e5f4959270'
PATCH = HERE / 'a7-neko-unix-socket.patch'
PATCH_SHA256 = 'a4fedb0f77048c4c0f0d3827cbcb2db29a31627680741438259399a9a2e8e71c'
BUILD_IMAGE = 'golang:1.25-trixie'
DEBIAN_IMAGE = 'debian:trixie'
BUILD_DEPS = ('libx11-dev', 'libxrandr-dev', 'libxtst-dev', 'libgtk-3-dev', 'libxcvt-dev', 'libgstreamer1.0-dev',
              'libgstreamer-plugins-base1.0-dev')
# The live desktop in the VM: the display, the input counter, the lock-down proof
# tool, and Neko's runtime libraries (GStreamer VP8 and Opus, X, GTK).
VM_PACKAGES = ('xvfb', 'xinput', 'xdotool', 'libgstreamer1.0-0', 'gstreamer1.0-plugins-base',
               'gstreamer1.0-plugins-good', 'libxtst6', 'libxrandr2', 'libxcvt0', 'libgtk-3-0t64', 'libx11-6')
VM_NEKO = runner.NEKO_BINARY
VM_POLICY = runner.LIVE_POLICY_PATH
TURN_PORT, TURN_TLS_PORT = 3478, 5349
HOSTNAME = re.compile(r'(?=.{4,253}\Z)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z')


def execute(argv, input=None, timeout=120, check=True):
    result = subprocess.run(argv, input=input, capture_output=True, text=not isinstance(input, bytes), timeout=timeout)
    if check and result.returncode:
        err = result.stderr if isinstance(result.stderr, str) else result.stderr.decode('utf-8', 'replace')
        raise ValueError('%s failed: %s' % (' '.join(argv[:3]), err.strip()[-400:]))
    return result.stdout


secure = fence_installer.secure


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    return sha256_bytes(Path(path).read_bytes())


def save(path, content, mode=0o644, group=None):
    """Write a root-owned file atomically (bytes or text), optionally group-readable."""
    path = Path(path)
    secure(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o750 if path.parent == CONFIG else 0o700)
    data = content if isinstance(content, bytes) else content.encode()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), mode)
            if group is not None:
                os.fchown(stream.fileno(), 0, group)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    os.replace(tmp, path)


def read_journal():
    if not JOURNAL.exists():
        return {'version': 1, 'vm': VM}
    secure(JOURNAL)
    data = json.loads(JOURNAL.read_text())
    if data.get('version') != 1 or data.get('vm') != VM:
        raise ValueError('Invalid A7 live journal')
    return data


def write_journal(data):
    save(JOURNAL, json.dumps(data, indent=2, sort_keys=True) + '\n', mode=0o600)


def supervisor_idle():
    """No worker attempt is live (the supervisor's own status on the operator socket)."""
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(30)
            client.connect(str(OPERATOR_SOCKET))
            client.sendall(b'{"method":"status","params":{}}\n')
            reply = json.loads(client.makefile().readline())
    except (OSError, ValueError) as error:
        raise ValueError('The A3 supervisor did not answer its status: %s' % error) from error
    if not reply.get('ok'):
        raise ValueError('The A3 supervisor refused its status')
    if reply['result'].get('active') is not None:
        raise ValueError('A worker attempt is live; stop it first (a3-worker-operator.py status)')
    return reply['result']


# ------------------------------------------------------------------ build

def build_neko():
    for path in (CONFIG, STATE):
        secure(path)
    if sha256_file(PATCH) != PATCH_SHA256:
        raise ValueError('The Neko patch differs from the reviewed one')
    STATE.mkdir(mode=0o700, exist_ok=True)
    if BUILD.exists():
        secure(BUILD)
        shutil.rmtree(BUILD)
    BUILD.mkdir(mode=0o700)
    source = BUILD / 'neko'
    execute(['git', 'clone', '--quiet', '--no-checkout', NEKO_REPO, str(source)], timeout=600)
    execute(['git', '-C', str(source), 'checkout', '--quiet', NEKO_COMMIT])
    if execute(['git', '-C', str(source), 'rev-parse', 'HEAD']).strip() != NEKO_COMMIT:
        raise ValueError('The Neko checkout is not the pinned commit')
    execute(['git', '-C', str(source), 'apply', '--check', str(PATCH)])
    execute(['git', '-C', str(source), 'apply', str(PATCH)])
    execute(['docker', 'pull', '--quiet', BUILD_IMAGE], timeout=900)
    image = execute(['docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', BUILD_IMAGE]).strip()
    script = ('set -e; apt-get update -qq; apt-get install -y -qq --no-install-recommends %s >/dev/null; '
              "go build -o bin/neko -ldflags \"-s -w -X 'm1k1o/neko.gitCommit=%s'\" cmd/neko/main.go"
              % (' '.join(BUILD_DEPS), NEKO_COMMIT[:8]))
    execute(['docker', 'run', '--rm', '-v', '%s:/src' % (source / 'server'), '-w', '/src', image, 'sh', '-c', script],
            timeout=3600)
    built = source / 'server' / 'bin' / 'neko'
    data = built.read_bytes()
    save(NEKO_OUT, data, mode=0o755)
    shutil.rmtree(BUILD)
    journal = read_journal()
    journal['neko'] = {'commit': NEKO_COMMIT, 'patch_sha256': PATCH_SHA256, 'build_image': image,
                       'sha256': sha256_bytes(data), 'bytes': len(data), 'built_at': stamp()}
    write_journal(journal)
    return {'neko': journal['neko']}


def build_probe():
    for path in (CONFIG, STATE):
        secure(path)
    STATE.mkdir(mode=0o700, exist_ok=True)
    names = sorted(p.name for p in PROBE_SOURCE.iterdir())
    if names != ['go.mod', 'go.sum', 'main.go']:
        raise ValueError('Unexpected files in %s: %s' % (PROBE_SOURCE, names))
    if BUILD.exists():
        secure(BUILD)
        shutil.rmtree(BUILD)
    BUILD.mkdir(mode=0o700)
    source = BUILD / 'probe'
    source.mkdir(mode=0o700)
    for name in names:
        (source / name).write_bytes((PROBE_SOURCE / name).read_bytes())
    execute(['docker', 'pull', '--quiet', BUILD_IMAGE], timeout=900)
    image = execute(['docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', BUILD_IMAGE]).strip()
    execute(['docker', 'run', '--rm', '-e', 'GOFLAGS=-mod=readonly', '-e', 'CGO_ENABLED=0', '-v', '%s:/src' % source,
             '-w', '/src', image, 'sh', '-c', 'go mod verify && go build -trimpath -o a7-live-probe .'], timeout=1800)
    data = (source / 'a7-live-probe').read_bytes()
    save(PROBE_OUT, data, mode=0o755)
    shutil.rmtree(BUILD)
    journal = read_journal()
    journal['probe'] = {'go_sum_sha256': sha256_file(PROBE_SOURCE / 'go.sum'),
                        'main_sha256': sha256_file(PROBE_SOURCE / 'main.go'), 'build_image': image,
                        'sha256': sha256_bytes(data), 'bytes': len(data), 'built_at': stamp()}
    write_journal(journal)
    return {'probe': journal['probe'], 'path': str(PROBE_OUT)}


def stamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


# -------------------------------------------------------------- provision

def guest(argv, timeout=120, input=None):
    return execute(['incus', 'exec', VM, '--', *argv], timeout=timeout, input=input)


def provision_vm():
    journal = read_journal()
    neko = journal.get('neko') or {}
    if not NEKO_OUT.exists() or sha256_file(NEKO_OUT) != neko.get('sha256'):
        raise ValueError('Build Neko first (build-neko); the built binary is missing or changed')
    supervisor_idle()
    instance = fence_installer.query('/1.0/instances/' + VM)
    if instance.get('config', {}).get('volatile.uuid') != fence.PROOF_UUID or instance.get('status') != 'Running':
        raise ValueError('The proof VM must be the reviewed one and running')
    # A rollback point that leaves the pre-network snapshot untouched.
    snapshot = 'pp-a7-pre-live-' + time.strftime('%Y%m%d-%H%M%S', time.gmtime())
    execute(['incus', 'snapshot', 'create', VM, snapshot], timeout=600)
    if DEBS.exists():
        secure(DEBS)
        shutil.rmtree(DEBS)
    DEBS.mkdir(mode=0o700)
    # apt resolves against the VM's own installed-package list, so the download is
    # exactly what the VM lacks (not what a fresh container lacks).
    execute(['incus', 'file', 'pull', VM + '/var/lib/dpkg/status', str(DEBS / 'vm-dpkg-status')], timeout=120)
    execute(['docker', 'run', '--rm', '-v', '%s:/out' % DEBS, DEBIAN_IMAGE, 'sh', '-c',
             'set -e; apt-get update -qq; apt-get install -y -qq --download-only --no-install-recommends '
             '-o Dir::State::status=/out/vm-dpkg-status %s >/dev/null; '
             'cp /var/cache/apt/archives/*.deb /out/ 2>/dev/null || true' % ' '.join(VM_PACKAGES)], timeout=1800)
    (DEBS / 'vm-dpkg-status').unlink()
    debs = sorted(p.name for p in DEBS.glob('*.deb'))
    if not all(re.fullmatch(r'[A-Za-z0-9.+~_:%-]+\.deb', name) for name in debs):
        raise ValueError('The package download has an unexpected file name')
    if debs:
        guest(['rm', '-rf', '/root/pp-a7-debs'])
        guest(['install', '-d', '-m', '0700', '/root/pp-a7-debs'])
        for name in debs:
            execute(['incus', 'file', 'push', '--uid', '0', '--gid', '0', '--mode', '0644', str(DEBS / name),
                     '%s/root/pp-a7-debs/%s' % (VM, name)], timeout=300)
        guest(['sh', '-c', 'apt-get install -y -q --no-download --no-install-recommends /root/pp-a7-debs/*.deb'],
              timeout=1800)
        guest(['rm', '-rf', '/root/pp-a7-debs'])
    shutil.rmtree(DEBS)
    guest(['install', '-d', '-m', '0755', str(Path(VM_NEKO).parent), str(Path(VM_POLICY).parent)])
    execute(['incus', 'file', 'push', '--uid', '0', '--gid', '0', '--mode', '0755', str(NEKO_OUT), VM + VM_NEKO],
            timeout=300)
    with tempfile.NamedTemporaryFile(prefix='pp-a7-policy-') as stream:
        stream.write(runner.live_policy_bytes())
        stream.flush()
        execute(['incus', 'file', 'push', '--uid', '0', '--gid', '0', '--mode', '0644', stream.name, VM + VM_POLICY])
    read = vm_readback()
    if read['neko_sha256'] != neko['sha256'] or read['policy_sha256'] != sha256_bytes(runner.live_policy_bytes()):
        raise ValueError('The files in the VM do not read back as pushed')
    if read['missing_libraries']:
        raise ValueError('Neko is missing libraries in the VM: %s' % ', '.join(read['missing_libraries']))
    journal['vm_files'] = {'snapshot': snapshot, 'packages': list(VM_PACKAGES), 'debs': debs, **read,
                           'provisioned_at': stamp()}
    write_journal(journal)
    return {'vm_files': journal['vm_files']}


def vm_readback():
    sums = dict(reversed(line.split(None, 1)) for line in guest(['sha256sum', VM_NEKO, VM_POLICY]).splitlines())
    tools = {tool: guest(['sh', '-c', 'test -x %s && echo yes || echo no' % tool]).strip() == 'yes'
             for tool in (runner.XVFB, runner.XINPUT, '/usr/bin/xdotool')}
    missing = [line.split()[0] for line in guest(['ldd', VM_NEKO]).splitlines() if 'not found' in line]
    modes = guest(['stat', '-c', '%a %U:%G', VM_NEKO, VM_POLICY]).split('\n')
    return {'neko_sha256': sums.get(VM_NEKO, '').strip(), 'policy_sha256': sums.get(VM_POLICY, '').strip(),
            'tools': tools, 'missing_libraries': missing, 'modes': [m for m in modes if m]}


# ------------------------------------------------------------------- TURN

def render_turn(hostname, listen_ip, secret):
    """The relay: viewers on listen_ip (the router forwards 3478 and 5349 to it);
    relays from the gateway to the VM's one Neko port and nowhere else."""
    return '\n'.join([
        '# ProxyPilot A7 TURN relay; owned by a7-install-live.py. Do not edit.',
        'listening-ip=%s' % listen_ip,
        'listening-port=%d' % TURN_PORT,
        'tls-listening-port=%d' % TURN_TLS_PORT,
        'relay-ip=%s' % GATEWAY_IPV4,
        'min-port=%d' % fence.LIVE_RELAY_PORTS[0],
        'max-port=%d' % fence.LIVE_RELAY_PORTS[1],
        'realm=%s' % hostname,
        'server-name=%s' % hostname,
        'use-auth-secret',
        'static-auth-secret=%s' % secret,
        'fingerprint',
        'no-cli',
        'no-dtls',
        'no-tlsv1',
        'no-tlsv1_1',
        'no-tcp-relay',
        'no-multicast-peers',
        'no-software-attribute',
        'denied-peer-ip=0.0.0.0-255.255.255.255',
        'denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        'allowed-peer-ip=%s' % GUEST_IPV4,
        'user-quota=6',
        'total-quota=24',
        # Bytes per second per relay session: 10 Mbit/s. No total capacity: coturn
        # reserves it per allocation, and a browser holds one per TURN URL.
        'max-bps=1250000',
        'stale-nonce=600',
        'cert=%s' % TURN_CERT,
        'pkey=%s' % TURN_KEY,
        'pidfile=/run/proxypilot-a7-turn/turnserver.pid',
        # The static secret needs no user database; keep coturn's own off /var.
        'userdb=/run/proxypilot-a7-turn/turndb',
        'log-file=syslog',
        'simple-log',
        '',
    ])


def turn_unit():
    return '''[Unit]
Description=ProxyPilot A7 TURN relay for the live agent view
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%s
Group=%s
RuntimeDirectory=proxypilot-a7-turn
ExecStart=%s -c %s --no-stdout-log
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
UMask=0077
MemoryMax=256M
TasksMax=64

[Install]
WantedBy=multi-user.target
''' % (TURN_USER, TURN_USER, TURNSERVER, TURN_CONF)


def cert_units():
    service = '''[Unit]
Description=ProxyPilot A7 TURN certificate sync from Caddy

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I %s cert-sync
''' % (CONFIG / 'a7-install-live.py')
    timer = '''[Unit]
Description=ProxyPilot A7 TURN certificate sync, daily

[Timer]
OnBootSec=5min
OnUnitActiveSec=1d
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
'''
    return service, timer


def caddy_site(hostname):
    # Only so Caddy obtains and renews the certificate for the TURN hostname.
    return '# ProxyPilot A7: certificate for the TURN relay only.\n%s {\n\trespond 404\n}\n' % hostname


def valid_hostname(hostname):
    if not isinstance(hostname, str) or not HOSTNAME.fullmatch(hostname):
        raise ValueError('The TURN hostname must be a DNS name such as turn.example.com')
    return hostname


def valid_listen_ip(value, local=None):
    address = ipaddress.IPv4Address(value)
    if address.is_loopback or address.is_unspecified or address.is_multicast or str(address) == GATEWAY_IPV4:
        raise ValueError('The TURN listening address must be this host\'s LAN address')
    local = local if local is not None else host_addresses()
    if str(address) not in local:
        raise ValueError('%s is not an address of this host' % address)
    return str(address)


def default_listen_ip():
    """This host's source address on its default route: the address the router
    forwards to (a routing lookup only; nothing is sent). --listen-ip overrides."""
    rows = json.loads(execute(['ip', '-j', '-4', 'route', 'get', '1.1.1.1']))
    source = rows[0].get('prefsrc') if isinstance(rows, list) and rows and isinstance(rows[0], dict) else None
    if not isinstance(source, str) or not source:
        raise ValueError('This host has no default route source address; pass --listen-ip')
    return source


def host_addresses():
    rows = json.loads(execute(['ip', '-j', '-4', 'addr', 'show']))
    return {info['local'] for row in rows for info in row.get('addr_info', []) if 'local' in info}


def caddy_certificate(hostname):
    matches = sorted(CADDY_CERTS.glob('*/%s/%s.crt' % (hostname, hostname)))
    for cert in matches:
        key = cert.with_suffix('.key')
        if key.exists():
            return cert, key
    return None


def cert_sync(hostname=None):
    journal = read_journal()
    hostname = valid_hostname(hostname or (journal.get('turn') or {}).get('hostname'))
    found = caddy_certificate(hostname)
    if found is None:
        raise ValueError('Caddy has no certificate for %s yet (DNS, the router forward of 80/443, the Caddy site)' % hostname)
    group = turn_group()
    cert, key = (p.read_bytes() for p in found)
    changed = (not TURN_CERT.exists() or TURN_CERT.read_bytes() != cert or not TURN_KEY.exists()
               or TURN_KEY.read_bytes() != key)
    if changed:
        save(TURN_CERT, cert, mode=0o640, group=group)
        save(TURN_KEY, key, mode=0o640, group=group)
        if execute(['systemctl', 'is-active', TURN_UNIT.name], check=False).strip() == 'active':
            execute(['systemctl', 'restart', TURN_UNIT.name])
    return {'hostname': hostname, 'certificate_sha256': sha256_bytes(cert), 'changed': changed}


def turn_group():
    import grp
    try:
        return grp.getgrnam(TURN_USER).gr_gid
    except KeyError as error:
        raise ValueError('coturn is not installed (no %s group); install it first' % TURN_USER) from error


def install_turn(hostname, listen_ip=None, write_caddy_site=False):
    hostname = valid_hostname(hostname)
    listen_ip = valid_listen_ip(listen_ip or default_listen_ip())
    if not TURNSERVER.exists():
        raise ValueError('coturn is not installed (apt-get install coturn)')
    if execute(['systemctl', 'is-active', 'coturn.service'], check=False).strip() == 'active':
        raise ValueError('The distribution coturn.service is active; stop and mask it so only the A7 relay runs')
    group = turn_group()
    for path in (CONFIG, TURN_UNIT, CERT_SERVICE, CERT_TIMER):
        secure(path)
    CONFIG.mkdir(mode=0o750, exist_ok=True)
    os.chown(CONFIG, 0, group)
    os.chmod(CONFIG, 0o750)
    if write_caddy_site:
        secure(CADDY_SITE)
        if CADDY_SITE.exists() and CADDY_SITE.read_text() != caddy_site(hostname):
            raise ValueError('%s exists with other content' % CADDY_SITE)
        save(CADDY_SITE, caddy_site(hostname))
        execute(['caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], timeout=120)
        execute(['systemctl', 'reload', 'caddy'])
        return {'caddy_site': str(CADDY_SITE), 'next': 'Wait for Caddy to obtain the certificate, then rerun install-turn '
                'without --caddy-site'}
    if not TURN_SECRET.exists():
        save(TURN_SECRET, secrets.token_hex(32) + '\n', mode=0o600)
    secure(TURN_SECRET)
    secret = TURN_SECRET.read_text().strip()
    installer_copy = CONFIG / 'a7-install-live.py'
    config = render_turn(hostname, listen_ip, secret)
    unit = turn_unit()
    service, timer = cert_units()
    with tempfile.TemporaryDirectory(prefix='pp-a7-units-') as tmp:
        for name, text in ((TURN_UNIT.name, unit), (CERT_SERVICE.name, service), (CERT_TIMER.name, timer)):
            (Path(tmp) / name).write_text(text)
        execute(['systemd-analyze', 'verify', *[str(Path(tmp) / n) for n in (TURN_UNIT.name, CERT_TIMER.name)]])
    save(installer_copy, Path(__file__).read_bytes(), mode=0o700)
    for name in ('a3-install-fence.py', 'a3-network-fence.py', 'a3-worker-guest.py', 'a7-neko-unix-socket.patch'):
        save(CONFIG / name, (HERE / name).read_bytes(), mode=0o600)
    cert_sync(hostname)
    save(TURN_CONF, config, mode=0o640, group=group)
    save(TURN_UNIT, unit)
    save(CERT_SERVICE, service)
    save(CERT_TIMER, timer)
    journal = read_journal()
    journal['turn'] = {'hostname': hostname, 'listen_ip': listen_ip, 'conf_sha256': sha256_bytes(config.encode()),
                       'unit_sha256': sha256_bytes(unit.encode()), 'installed_at': stamp()}
    write_journal(journal)
    execute(['systemctl', 'daemon-reload'])
    execute(['systemctl', 'enable', '--now', TURN_UNIT.name, CERT_TIMER.name])
    return status_turn()


def turn_urls(hostname):
    return ['turn:%s:%d?transport=udp' % (hostname, TURN_PORT), 'turn:%s:%d?transport=tcp' % (hostname, TURN_PORT),
            'turns:%s:%d?transport=tcp' % (hostname, TURN_TLS_PORT)]


def status_turn():
    journal = read_journal()
    turn = journal.get('turn') or {}
    if not turn:
        return {'turn': 'not installed'}
    try:
        rows = execute(['ss', '-Hltun'], check=False).splitlines()
    except OSError:
        rows = []
    listening = {int(line.split()[4].rsplit(':', 1)[1]) for line in rows
                 if len(line.split()) > 4 and line.split()[4].rsplit(':', 1)[-1].isdigit()}
    return {'turn': {'hostname': turn['hostname'], 'listen_ip': turn['listen_ip'],
                     'active': execute(['systemctl', 'is-active', TURN_UNIT.name], check=False).strip(),
                     'conf_matches': TURN_CONF.exists() and sha256_file(TURN_CONF) == turn['conf_sha256'],
                     'unit_matches': TURN_UNIT.exists() and sha256_file(TURN_UNIT) == turn['unit_sha256'],
                     'ports': {str(p): p in listening for p in (TURN_PORT, TURN_TLS_PORT)},
                     'certificate': TURN_CERT.exists() and TURN_KEY.exists(),
                     'cert_timer': execute(['systemctl', 'is-active', CERT_TIMER.name], check=False).strip(),
                     'urls': turn_urls(turn['hostname'])}}


# ------------------------------------------------------------ enable/disable

def enable():
    journal = read_journal()
    if not (journal.get('neko') and journal.get('vm_files') and journal.get('turn')):
        raise ValueError('build-neko, provision-vm and install-turn must all be done first')
    supervisor_idle()
    read = vm_readback()
    if read['neko_sha256'] != journal['neko']['sha256'] or read['policy_sha256'] != sha256_bytes(runner.live_policy_bytes()):
        raise ValueError('The live files in the VM changed since provisioning')
    turn = status_turn()['turn']
    if turn['active'] != 'active' or not turn['conf_matches'] or not turn['unit_matches']:
        raise ValueError('The TURN relay is not running as installed')
    fence_installer.live_relay(True)
    marker = {'version': 1, 'udp_port': runner.LIVE_UDP_PORT, 'relay_ports': list(fence.LIVE_RELAY_PORTS),
              'neko_sha256': journal['neko']['sha256'], 'policy_sha256': sha256_bytes(runner.live_policy_bytes()),
              'turn': {'urls': turn_urls(journal['turn']['hostname']), 'ttl_seconds': 3600}, 'enabled_at': stamp()}
    save(LIVE_MARKER, json.dumps(marker, indent=2, sort_keys=True) + '\n', mode=0o644)
    journal['enabled'] = {'at': marker['enabled_at'], 'marker_sha256': sha256_file(LIVE_MARKER)}
    write_journal(journal)
    return status()


def disable():
    supervisor_idle()
    if LIVE_MARKER.exists():
        secure(LIVE_MARKER)
        LIVE_MARKER.unlink()
    fence_installer.live_relay(False)
    execute(['systemctl', 'disable', '--now', TURN_UNIT.name], check=False)
    journal = read_journal()
    journal.pop('enabled', None)
    journal['disabled_at'] = stamp()
    write_journal(journal)
    return status()


def status():
    journal = read_journal()
    marker = None
    if LIVE_MARKER.exists():
        secure(LIVE_MARKER)
        marker = json.loads(LIVE_MARKER.read_text())
    try:
        fence_state = fence_installer.status()
        relay = fence_state.get('live_relay')
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        relay = 'unverified: %s' % error
    return {'neko': journal.get('neko'), 'probe': journal.get('probe'), 'vm_files': journal.get('vm_files'), **status_turn(),
            'fence_live_relay': relay, 'live_marker': marker is not None,
            'live_marker_sha256': sha256_file(LIVE_MARKER) if marker is not None else None,
            'enabled': journal.get('enabled')}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('build-neko', 'build-probe', 'provision-vm', 'enable', 'disable', 'status'):
        sub.add_parser(name)
    turn = sub.add_parser('install-turn')
    turn.add_argument('--hostname', required=True)
    turn.add_argument('--listen-ip', help='default: this host\'s address on its default route')
    turn.add_argument('--caddy-site', action='store_true')
    cert = sub.add_parser('cert-sync')
    cert.add_argument('--hostname')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    actions = {'build-neko': build_neko, 'build-probe': build_probe, 'provision-vm': provision_vm, 'enable': enable, 'disable': disable,
               'status': status, 'cert-sync': lambda: cert_sync(args.hostname),
               'install-turn': lambda: install_turn(args.hostname, args.listen_ip, args.caddy_site)}
    print(json.dumps(actions[args.command](), indent=2, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('A7 live operation refused: %s' % error, file=sys.stderr)
        sys.exit(1)
