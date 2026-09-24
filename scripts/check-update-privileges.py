#!/usr/bin/env python3
"""Refuse legacy updates that would widen a customized container boundary.

This is a compatibility preflight, not a claim that the legacy baseline is safe.
Compose resolves overrides/interpolation; never print its secret-bearing config.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path


def check(document):
    services = document.get('services', {})
    if not isinstance(services, dict):
        raise ValueError('Invalid Compose services')
    matches = [s for name, s in services.items() if name == 'proxypilot' or
               (isinstance(s, dict) and s.get('container_name') == 'proxypilot-admin')]
    if len(matches) != 1 or not isinstance(matches[0], dict):
        raise ValueError('Cannot identify exactly one ProxyPilot backend')
    service = matches[0]
    restrictive = (service.get('privileged') is not True or
                   service.get('pid') != 'host' or
                   str(service.get('user', '0')).split(':')[0] not in ('', '0', 'root') or
                   bool(service.get('read_only')) or bool(service.get('cap_drop')) or
                   bool(service.get('security_opt')) or bool(service.get('userns_mode')))
    volumes = service.get('volumes', [])
    socket = any(isinstance(v, dict) and v.get('type') == 'bind' and
                 v.get('source') == '/var/run/docker.sock' and
                 v.get('target') == '/var/run/docker.sock' and not v.get('read_only')
                 for v in volumes)
    if restrictive or not socket:
        raise ValueError('Restricted/custom backend detected. Automatic legacy update refused; '
                         'existing privileges will not be expanded. See docs/core/security-host-boundary.md.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?')
    parser.add_argument('--check-json', type=Path, help='Check a saved normalized Compose config')
    args = parser.parse_args()
    try:
        if args.check_json:
            document = json.loads(args.check_json.read_text())
        elif args.directory:
            # Match update.sh's implicit Compose discovery, including override
            # files and COMPOSE_FILE. config is read-only and needs no restart.
            result = subprocess.run(['docker', 'compose', 'config', '--format', 'json'],
                                    cwd=args.directory, capture_output=True, timeout=30, check=True)
            document = json.loads(result.stdout)
        else:
            raise ValueError('An installation directory is required')
        check(document)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # Do not emit captured stdout/stderr: normalized config includes secrets.
        detail = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else 'Cannot safely resolve Compose configuration; Docker Compose v2 is required.'
        print(f'Privilege preflight refused: {detail}', file=sys.stderr)
        return 2
    print('Legacy host-authority deployment detected (S6 remains open). Privilege expansion is disabled.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
