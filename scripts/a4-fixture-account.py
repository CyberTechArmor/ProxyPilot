#!/usr/bin/env python3
"""Root host tool for the A4 synthetic account on the fixture origin.

The fixture origin is the demo LXC (`pp-fractionate-demo`, fractionate-demo.service
as www-data). The synthetic account is additive: the public demo account keeps
working. The account's password is the bound credential value, entered by the
operator in the dashboard (OpenBao agent credential). This tool reads it with
the INSTALLED broker's AppRole, derives an scrypt verifier on the host, pushes
only the verifier (salt, parameters, derived key) into the demo guest over
`incus file push` standard input, and wipes the value. The value is never
printed, written to disk on the host, or placed in the guest.

  provision --binding <uuid>   write/refresh the verifier (after bind or rotate)
  deploy-server                push this checkout's reviewed demo server.mjs
                               (keeps the previous file as server.mjs.pre-a4)
  rollback-server              restore server.mjs.pre-a4 and restart
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

INSTANCE = 'pp-fractionate-demo'
DEMO_DIR = '/opt/app/demo'
VERIFIER = DEMO_DIR + '/synthetic-account.json'
SERVER = DEMO_DIR + '/server.mjs'
BACKUP = DEMO_DIR + '/server.mjs.pre-a4'
SERVICE = 'fractionate-demo.service'
INSTALLED_BROKER = Path('/etc/proxypilot-a4/broker/a4-credential-broker.py')
REVIEWED_SERVER = Path(__file__).resolve().parents[1] / 'admin' / 'frontend' / 'demo' / 'server.mjs'
SCRYPT = {'N': 32768, 'r': 8, 'p': 1, 'dklen': 32}


def load_broker(path=INSTALLED_BROKER):
    """The reviewed installed copy, so the vault read uses the installed AppRole path."""
    spec = importlib.util.spec_from_file_location('a4_installed_broker', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.secure(path)
    return module


def verifier(email, value, salt=None):
    """The scrypt verifier document the demo server accepts. `value` is a bytearray."""
    salt = os.urandom(16) if salt is None else salt
    key = hashlib.scrypt(bytes(value), salt=salt, n=SCRYPT['N'], r=SCRYPT['r'], p=SCRYPT['p'],
                         dklen=SCRYPT['dklen'], maxmem=128 * 1024 * 1024)
    return json.dumps({'v': 1, 'email': email, 'scrypt': dict(SCRYPT, salt=base64.b64encode(salt).decode(),
                                                               hash=base64.b64encode(key).decode())}) + '\n'


def run(argv, data=None, timeout=60):
    return subprocess.run(argv, input=data, capture_output=True, check=True, timeout=timeout)


def guest_sha256(path, instance=INSTANCE):
    out = subprocess.run(['incus', 'exec', instance, '--', 'sha256sum', path], capture_output=True, timeout=30)
    return out.stdout.decode().split()[0] if out.returncode == 0 and out.stdout else None


def push(data, path, instance=INSTANCE, mode='0644'):
    """Push bytes that are not secret (a verifier or reviewed source) from a 0600
    temporary host file, then read them back byte-exact from the guest."""
    with tempfile.NamedTemporaryFile(prefix='pp-a4-fixture-') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(data)
        stream.flush()
        run(['incus', 'file', 'push', stream.name, '%s%s' % (instance, path), '--uid', '0', '--gid', '0',
             '--mode', mode])
    if guest_sha256(path, instance) != hashlib.sha256(data).hexdigest():
        raise ValueError('pushed file does not read back byte-exact: ' + path)


def provision(binding_id, instance=INSTANCE, broker=None):
    broker = broker or load_broker()
    record, value = broker.bound_value(binding_id)
    try:
        document = verifier(record['username'], value).encode()
    finally:
        broker.wipe(value)
    push(document, VERIFIER, instance)
    # Reported: which binding revision the verifier matches, never a value or a hash.
    return {'provisioned': True, 'instance': instance, 'path': VERIFIER, 'email': record['username'],
            'binding_id': binding_id, 'binding_revision': record['revision'],
            'vault_version': record['vault']['version'], 'verifier_bytes': len(document),
            'notice': 'The demo re-reads the verifier on change; no restart is needed.'}


def deploy_server(instance=INSTANCE, source=REVIEWED_SERVER):
    data = source.read_bytes()
    before = guest_sha256(SERVER, instance)
    if before is None:
        raise ValueError('demo server not found in ' + instance)
    if guest_sha256(BACKUP, instance) is None:
        run(['incus', 'exec', instance, '--', 'cp', '-p', SERVER, BACKUP])
    push(data, SERVER, instance)
    run(['incus', 'exec', instance, '--', 'systemctl', 'restart', SERVICE])
    run(['incus', 'exec', instance, '--', 'systemctl', 'is-active', '--quiet', SERVICE])
    return {'deployed': True, 'instance': instance, 'previous_sha256': before,
            'server_sha256': hashlib.sha256(data).hexdigest(), 'backup': BACKUP, 'service': 'active'}


def rollback_server(instance=INSTANCE):
    if guest_sha256(BACKUP, instance) is None:
        raise ValueError('no pre-A4 backup in ' + instance)
    run(['incus', 'exec', instance, '--', 'cp', '-p', BACKUP, SERVER])
    run(['incus', 'exec', instance, '--', 'systemctl', 'restart', SERVICE])
    run(['incus', 'exec', instance, '--', 'systemctl', 'is-active', '--quiet', SERVICE])
    return {'rolled_back': True, 'server_sha256': guest_sha256(SERVER, instance),
            'notice': 'The synthetic-account file is left in place and ignored by the pre-A4 server.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    prov = sub.add_parser('provision')
    prov.add_argument('--binding', required=True)
    sub.add_parser('deploy-server')
    sub.add_parser('rollback-server')
    for command in sub.choices.values():
        command.add_argument('--instance', default=INSTANCE)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    if args.command == 'provision':
        result = provision(args.binding, args.instance)
    elif args.command == 'deploy-server':
        result = deploy_server(args.instance)
    else:
        result = rollback_server(args.instance)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print('A4 fixture operation failed: %s exited %s' % (error.cmd[0], error.returncode), file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print('A4 fixture operation refused: %s' % error, file=sys.stderr)
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 - the broker's Refused; print its code only
        print('A4 fixture operation refused: %s' % getattr(error, 'code', type(error).__name__), file=sys.stderr)
        sys.exit(1)
