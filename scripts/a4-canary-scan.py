#!/usr/bin/env python3
"""A4 canary check: the bound value must appear in no sink. Match counts only.

Root only, after the A4 proof. The canary is the bound credential value the
operator created in the dashboard. It is read here with the INSTALLED broker's
AppRole at the binding's recorded version, held only in memory, and never
printed, written or hashed into the output. Each sink is searched for the raw
value and its common encodings (JSON-escaped, URL-encoded, base64 and
base64url at every byte alignment), and every signed receipt found is also
decoded and searched. A sink that cannot be read is reported `scanned: false`
and fails the check: an unread sink is never counted as zero.

Sinks: the supervisor, broker and proxy unit journals and the whole host
journal; the proof VM guest journal (the worker units); the ProxyPilot backend
container logs; the ProxyPilot database (raw files and a logical dump) and its
MCP ledger table; supervisor and broker journals (receipts, deliveries, model
request/response records); proof reports (page reads); Incus logs.
"""
import argparse
import base64
import glob
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from urllib.parse import quote, quote_plus

INSTALLED_BROKER = Path('/etc/proxypilot-a4/broker/a4-credential-broker.py')
VM = 'pp-agents-a3-debian13-proof-20260927'
DB_CANDIDATES = ('/opt/proxypilot/data/db/proxypilot.db', '/opt/proxypilot/admin/backend/data/db/proxypilot.db',
                 '/var/lib/proxypilot/db/proxypilot.db', '/var/lib/proxypilot/data/db/proxypilot.db')
ATTESTATION = re.compile(rb'a3r1\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+')
MIN_CANARY = 12


def patterns(value):
    """Byte patterns for the value and its encodings; alignment-safe base64 slices."""
    if len(value) < MIN_CANARY:
        raise ValueError('canary shorter than %d bytes cannot be searched meaningfully' % MIN_CANARY)
    text = bytes(value).decode('utf-8')
    found = {bytes(value), json.dumps(text)[1:-1].encode(), quote(text, safe='').encode(),
             quote_plus(text, safe='').encode()}
    for encode in (base64.b64encode, base64.urlsafe_b64encode):
        for k in range(3):
            encoded = encode(b'\0' * k + bytes(value)).rstrip(b'=')
            start = -(-8 * k // 6)
            found.add(encoded[start:len(encoded) - 2])
    return sorted(p for p in found if len(p) >= 8)


def count(data, needles):
    total = 0
    for needle in needles:
        at = data.find(needle)
        while at >= 0:
            total += 1
            at = data.find(needle, at + 1)
    return total


def decoded_attestations(data):
    out = []
    for match in ATTESTATION.finditer(data):
        body = match.group(1)
        try:
            out.append(base64.urlsafe_b64decode(body + b'=' * (-len(body) % 4)))
        except ValueError:
            continue
    return out


def scan_bytes(data, needles):
    return count(data, needles) + sum(count(body, needles) for body in decoded_attestations(data))


def command(argv, timeout=600):
    result = subprocess.run(argv, capture_output=True, timeout=timeout)
    if result.returncode:
        raise OSError('%s exited %d' % (argv[0], result.returncode))
    return result.stdout + result.stderr


def files(pattern_list):
    paths = []
    for pattern in pattern_list:
        paths += [Path(p) for p in glob.glob(pattern, recursive=True) if Path(p).is_file()]
    return paths


def database_dump(path):
    connection = sqlite3.connect('file:%s?mode=ro' % path, uri=True, timeout=30)
    try:
        return '\n'.join(connection.iterdump()).encode('utf-8', 'surrogateescape')
    finally:
        connection.close()


def mcp_ledger(path):
    connection = sqlite3.connect('file:%s?mode=ro' % path, uri=True, timeout=30)
    try:
        rows = connection.execute('SELECT * FROM mcp_ledger').fetchall()
    finally:
        connection.close()
    return json.dumps(rows, default=str).encode()


def sink_sources(database=None, backend_container='proxypilot-admin', since='14 days ago'):
    """name -> zero-argument reader returning bytes. Each raises when unreadable."""
    db = database or next((p for p in DB_CANDIDATES if Path(p).is_file()), None)
    journal = lambda *extra: (lambda: command(['journalctl', '--no-pager', '-o', 'cat', '--since', since, *extra]))  # noqa: E731
    readers = {
        'supervisor_journal': journal('-u', 'proxypilot-a3-supervisor.service'),
        'broker_journal': journal('-u', 'proxypilot-a4-broker.service'),
        'proxy_journal': journal('-u', 'proxypilot-a3-origin-proxy.service'),
        'host_journal_all': journal(),
        'guest_unit_journals': lambda: command(['incus', 'exec', VM, '--', 'journalctl', '--no-pager', '-o', 'cat']),
        'backend_logs': lambda: command(['docker', 'logs', '--since', '336h', backend_container]),
        'receipts_and_supervisor_journal': lambda: b''.join(p.read_bytes() for p in files(
            ['/var/lib/proxypilot-a3-proof/supervisor/*.json'])) or _missing('supervisor journal'),
        'broker_journal_and_model_records': lambda: b''.join(p.read_bytes() for p in files(
            ['/var/lib/proxypilot-a4/broker/*.json'])) or _missing('broker journal'),
        'page_reads_and_proof_reports': lambda: b''.join(p.read_bytes() for p in files(
            ['/var/lib/proxypilot-a3-proof/proof/*.json', '/var/lib/proxypilot-a4-proof/*.json'])) or
        _missing('proof reports'),
        'incus_logs': lambda: b''.join(p.read_bytes() for p in files(['/var/log/incus/*.log'])),
    }
    if db:
        readers['database_files'] = lambda: b''.join(p.read_bytes() for p in files([db, db + '-wal', db + '-journal']))
        readers['database_dump'] = lambda: database_dump(db)
        readers['mcp_ledger'] = lambda: mcp_ledger(db)
    else:
        readers['database_files'] = readers['database_dump'] = readers['mcp_ledger'] = \
            lambda: _missing('ProxyPilot database (pass --database)')
    return readers


def _missing(what):
    raise OSError('%s not found' % what)


def scan(value, readers):
    needles = patterns(value)
    report = {}
    for name, read in readers.items():
        try:
            data = read()
        except (OSError, subprocess.SubprocessError, sqlite3.Error, ValueError) as error:
            report[name] = {'scanned': False, 'error': type(error).__name__ + ': ' + str(error)[:120]}
            continue
        report[name] = {'scanned': True, 'bytes': len(data), 'matches': scan_bytes(data, needles)}
    passed = all(r['scanned'] and r['matches'] == 0 for r in report.values())
    return {'canary_scan': 'passed' if passed else 'failed', 'encodings_searched': len(needles),
            'sinks': report}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--binding', required=True, help='the binding whose bound value is the canary')
    parser.add_argument('--database', help='ProxyPilot SQLite path when it is not in a standard location')
    parser.add_argument('--backend-container', default='proxypilot-admin')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    spec = importlib.util.spec_from_file_location('a4_canary_broker', INSTALLED_BROKER)
    broker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(broker)
    broker.secure(INSTALLED_BROKER)
    record, value = broker.bound_value(args.binding)
    try:
        result = scan(value, sink_sources(args.database, args.backend_container))
    finally:
        broker.wipe(value)
    result.update(binding_id=args.binding, binding_revision=record['revision'],
                  vault_version=record['vault']['version'])
    print(json.dumps(result, indent=2))
    sys.exit(0 if result['canary_scan'] == 'passed' else 1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:  # noqa: BLE001 - print a code or type, never data
        print('A4 canary scan stopped: %s' % (getattr(error, 'code', None) or type(error).__name__), file=sys.stderr)
        sys.exit(1)
