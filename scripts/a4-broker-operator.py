#!/usr/bin/env python3
"""Root operator client for the A4 credential and provider broker.

Talks only to /run/proxypilot-a4/broker.sock. It authorizes, rotates and
revokes the one credential binding, binds the provider key's vault version,
confirms the price table, and reads the ledger. It never takes, prints or
stores a secret value: values are entered in the dashboard (OpenBao agent
credentials), and a binding names only their vault path and version.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import sys

SOCKET = Path('/run/proxypilot-a4/broker.sock')


class CallFailed(Exception):
    def __init__(self, reply):
        super().__init__(reply.get('error'))
        self.reply = reply
        self.code = reply.get('error')


def call(method, params=None, path=SOCKET, timeout=120):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(timeout)
        client.connect(str(path))
        client.sendall((json.dumps({'method': method, 'params': params or {}}) + '\n').encode())
        line = client.makefile().readline()
    if not line:
        raise CallFailed({'error': 'CONNECTION_CLOSED'})
    reply = json.loads(line)
    if not reply.get('ok'):
        raise CallFailed(reply)
    return reply['result']


def request(args):
    """(method, params) for a parsed command line; pure, for tests."""
    if args.command in ('status', 'bindings'):
        return args.command, {}
    if args.command == 'bind':
        return 'bind', {'binding_id': args.binding, 'project_id': args.project, 'profile_id': args.profile,
                        'username': args.username, 'vault_key': args.vault_key}
    if args.command == 'rotate':
        return 'rotate', {'binding_id': args.binding, 'expected_revision': args.expected_revision}
    if args.command == 'revoke':
        return 'revoke', {'binding_id': args.binding}
    if args.command == 'provider':
        return 'provider_bind', {'vault_key': args.vault_key}
    if args.command == 'price' and args.price_command == 'set':
        return 'price_set', {'model': args.model, 'input': args.input, 'cached_input': args.cached_input,
                             'cache_write': args.cache_write, 'output': args.output}
    if args.command == 'price' and args.price_command == 'clear':
        return 'price_clear', {'model': args.model}
    if args.command == 'ledger':
        return 'ledger', {} if args.run is None else {'run_id': args.run}
    raise ValueError('unknown command')


def parser():
    top = argparse.ArgumentParser(description=__doc__)
    sub = top.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    sub.add_parser('bindings')
    bind = sub.add_parser('bind', help='authorize one binding (UUIDs you choose; a vault key, never a value)')
    bind.add_argument('--binding', required=True)
    bind.add_argument('--project', required=True)
    bind.add_argument('--profile', required=True)
    bind.add_argument('--username', required=True, help='the synthetic account email (not secret)')
    bind.add_argument('--vault-key', required=True, help='the OpenBao agent credential key holding the password')
    rotate = sub.add_parser('rotate', help='new revision at the vault key\'s current version')
    rotate.add_argument('--binding', required=True)
    rotate.add_argument('--expected-revision', type=int, required=True)
    revoke = sub.add_parser('revoke')
    revoke.add_argument('--binding', required=True)
    provider = sub.add_parser('provider', help='bind the provider key\'s current vault version')
    provider.add_argument('--vault-key', required=True)
    price = sub.add_parser('price', help='operator-confirmed USD per 1M tokens for the allowlisted model')
    price_sub = price.add_subparsers(dest='price_command', required=True)
    price_set = price_sub.add_parser('set')
    for name in ('model', 'input', 'cached-input', 'cache-write', 'output'):
        price_set.add_argument('--' + name, required=True)
    price_clear = price_sub.add_parser('clear')
    price_clear.add_argument('--model', required=True)
    ledger = sub.add_parser('ledger')
    ledger.add_argument('--run')
    return top


def main():
    args = parser().parse_args()
    if os.geteuid() != 0:
        sys.exit('Run in the host root terminal')
    method, params = request(args)
    print(json.dumps(call(method, params), indent=2))


if __name__ == '__main__':
    try:
        main()
    except CallFailed as error:
        print('A4 broker refused: %s %s' % (error.code, error.reply.get('detail') or ''), file=sys.stderr)
        sys.exit(1)
    except OSError as error:
        print('A4 broker unreachable: %s' % error, file=sys.stderr)
        sys.exit(1)
