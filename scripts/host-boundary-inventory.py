#!/usr/bin/env python3
"""Inventory candidate direct host interfaces; refuse unreviewed new call sites.

Static evidence includes imports/comments and is not proof of reachability or
isolation. Keep the architectural contracts in security-host-boundary.md current.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'docs/core/security-host-interfaces.json'
PATTERNS = {
    'host_namespace': re.compile(r'nsenter|/proc/1/(?:ns|root)'),
    'host_command': re.compile(r'runHostCapture|spawnHost|execOnHost|spawnOnHost|guestExec|hostExec'),
    'process_api': re.compile(r'child_process'),
    'host_files': re.compile(r'/etc/(?:caddy|wireguard|systemd|ssh|iptables)|/var/lib/(?:proxypilot|incus|docker)|/var/run/docker\.sock|/run/proxypilot'),
}


def inventory(root=ROOT):
    entries = {}
    for path in sorted((root / 'admin/backend/src').rglob('*.js')):
        relative = path.relative_to(root).as_posix()
        if '/__tests__/' in relative or '/framework-seed/' in relative:
            continue
        evidence = Counter()
        for line in path.read_text().splitlines():
            # Retain candidate evidence, including comments: removal requires
            # a caller/operation review rather than assuming text is executable.
            kinds = sorted(kind for kind, pattern in PATTERNS.items() if pattern.search(line))
            if kinds:
                evidence[' '.join(kinds) + ': ' + line.strip()] += 1
        if evidence:
            entries[relative] = dict(sorted(evidence.items()))
    return entries


def additions(current, accepted):
    return {path: dict(extra) for path, lines in current.items()
            if (extra := Counter(lines) - Counter(accepted.get(path, {})))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true', help='Record reviewed candidate evidence; inspect the diff before committing')
    args = parser.parse_args()
    current = inventory()
    if args.write:
        MANIFEST.write_text(json.dumps({'status': 'S6 partially implemented/open; candidates are not all executable paths',
            'contracts': 'docs/core/security-host-boundary.md', 'files': current}, indent=2) + '\n')
    else:
        extra = additions(current, json.loads(MANIFEST.read_text())['files'])
        if extra:
            print('New/changed host-boundary candidates need contract review and an inventory update:', file=sys.stderr)
            print('\n'.join(extra), file=sys.stderr)
            return 1
    print(f'{len(current)} candidate backend files inventoried; S6 remains open.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
