#!/usr/bin/env python3
"""Read-only A6 host summary: every verdict from the newest proof reports.

Prints one JSON document: the newest A3 worker proof (every case), the newest
A4 proof (every case), the newest A5 proof (every case) and each canary scan
saved by the A6 host steps (under /var/lib/proxypilot-a6-proof/, one JSON
result per `canary-*.json`). It writes nothing and prints no secret: reports
hold typed fields only, and only verdicts and case names are printed.
Exit 0 only when every report is present and passed.
"""
import argparse
import json
from pathlib import Path
import sys

A3 = Path('/var/lib/proxypilot-a3-proof/proof')
A4 = Path('/var/lib/proxypilot-a4-proof')
A5 = Path('/var/lib/proxypilot-a5-proof')
A6 = Path('/var/lib/proxypilot-a6-proof')


def newest(paths):
    paths = sorted(paths, key=lambda p: p.stat().st_mtime)
    return paths[-1] if paths else None


def cases(report):
    return [{'case': c.get('case'), 'passed': c.get('passed') is True} for c in report.get('cases', [])]


def proof(path, verdict_key):
    if path is None:
        return {'report': None, 'verdict': 'missing'}
    try:
        report = json.loads(path.read_text())
    except (OSError, ValueError):
        return {'report': str(path), 'verdict': 'unreadable'}
    listed = cases(report)
    return {'report': str(path), 'verdict': report.get(verdict_key), 'cases': len(listed),
            'passed': sum(c['passed'] for c in listed), 'failed': [c['case'] for c in listed if not c['passed']],
            'case_names': [c['case'] for c in listed]}


def canary(path):
    try:
        result = json.loads(path.read_text())
    except (OSError, ValueError):
        return {'file': str(path), 'verdict': 'unreadable'}
    sinks = result.get('sinks') or {}
    dirty = sorted(name for name, sink in sinks.items() if isinstance(sink, dict) and (
        sink.get('scanned') is not True or sink.get('matches') or sink.get('marker_matches')))
    return {'file': str(path), 'verdict': result.get('canary_scan'), 'sinks': len(sinks), 'unclean_sinks': dirty}


def summary(a3=A3, a4=A4, a5=A5, a6=A6):
    out = {'a3': proof(newest(a3.glob('worker-proof-*.json')) if a3.is_dir() else None, 'worker_proof'),
           'a4': proof(newest(a4.glob('a4-proof-*.json')) if a4.is_dir() else None, 'a4_proof'),
           'a5': proof(newest(a5.glob('*/a5-proof-*.json')) if a5.is_dir() else None, 'a5_proof'),
           'canary': [canary(p) for p in sorted(a6.glob('canary-*.json'))] if a6.is_dir() else []}
    verdicts = [out['a3']['verdict'], out['a4']['verdict'], out['a5']['verdict']] + [c['verdict'] for c in out['canary']]
    out['all_passed'] = len(out['canary']) >= 2 and all(v == 'passed' for v in verdicts) and \
        all(not c.get('unclean_sinks') for c in out['canary'])
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.parse_args(argv)
    result = summary()
    print(json.dumps(result, indent=1))
    return 0 if result['all_passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
