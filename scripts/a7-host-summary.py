#!/usr/bin/env python3
"""Read-only A7 host summary: every verdict from the newest proof reports.

Prints one JSON document: the newest A3 worker proof, A4 proof, A5 proof and A7
proof (every case), the live install as recorded (Neko, the probe, the VM files,
the TURN relay, the live marker; hashes and names only), and each canary scan
saved by the A7 host steps (under /var/lib/proxypilot-a7-proof/, one JSON result
per `canary-*.json`). It writes nothing, contacts nothing and prints no secret:
the reports and the install journal hold typed fields only, and only verdicts,
case names, hashes and times are printed. The A3 proof counts only when it ran
after the live view was enabled (the regression in live mode).
Exit 0 only when every report is present and passed.
"""
import argparse
import calendar
import json
from pathlib import Path
import sys
import time

A3 = Path('/var/lib/proxypilot-a3-proof/proof')
A4 = Path('/var/lib/proxypilot-a4-proof')
A5 = Path('/var/lib/proxypilot-a5-proof')
A7 = Path('/var/lib/proxypilot-a7-proof')
LIVE = Path('/var/lib/proxypilot-a7/live-install.json')
MARKER = Path('/etc/proxypilot-a3-proof/live.json')
# The A7 proof's cases (scripts/a7-probe.mjs ORDER).
A7_CASES = ('live_view', 'live_refusals', 'dashboard_takeover', 'resume_new_run', 'takeover_during_submit',
            'grant_loss_while_holding', 'coordinator_killed_while_holding', 'timeout_is_a_decision',
            'model_proof_switches', 'model_summary', 'account_loss_while_holding', 'key_loss_while_holding',
            'worker_killed_mid_read', 'worker_killed_mid_approval', 'coordinator_killed_mid_read',
            'coordinator_killed_mid_approval', 'coordinator_killed_mid_write', 'worker_killed_mid_write')
CANARIES = ('canary-a4.json', 'canary-a5.json', 'canary-a7.json')


def newest(paths):
    paths = sorted(paths, key=lambda p: p.stat().st_mtime)
    return paths[-1] if paths else None


def cases(report):
    return [{'case': c.get('case'), 'passed': c.get('passed') is True} for c in report.get('cases', [])]


def read(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def proof(path, verdict_key):
    if path is None:
        return {'report': None, 'verdict': 'missing'}
    report = read(path)
    if not isinstance(report, dict):
        return {'report': str(path), 'verdict': 'unreadable'}
    listed = cases(report)
    return {'report': str(path), 'verdict': report.get(verdict_key), 'cases': len(listed),
            'passed': sum(c['passed'] for c in listed), 'failed': [c['case'] for c in listed if not c['passed']],
            'case_names': [c['case'] for c in listed], 'mtime': path.stat().st_mtime}


def a7_proof(path):
    out = proof(path, 'a7_proof')
    report = read(path) if path is not None else None
    if isinstance(report, dict):
        supervisor = report.get('supervisor') or {}
        out['live'] = supervisor.get('live') is True
        out['supervisor_sha256'] = supervisor.get('supervisor_sha256')
        out['runner_sha256'] = supervisor.get('runner_sha256')
        out['viewer_sha256'] = report.get('viewer_sha256')
        out['all_cases'] = tuple(out.get('case_names', [])) == A7_CASES
        observed = {c.get('case'): c.get('observed') or {} for c in report.get('cases', [])}
        view = observed.get('live_view') or {}
        out['live_view'] = {'fps': view.get('fps'), 'frames': view.get('frames'), 'connect_ms': view.get('connect_ms'),
                            'pair': view.get('pair')}
    return out


def canary(path):
    result = read(path)
    if not isinstance(result, dict):
        return {'file': str(path), 'verdict': 'missing' if not path.exists() else 'unreadable'}
    sinks = result.get('sinks') or {}
    dirty = sorted(name for name, sink in sinks.items() if isinstance(sink, dict) and (
        sink.get('scanned') is not True or sink.get('matches') or sink.get('marker_matches')))
    return {'file': str(path), 'verdict': result.get('canary_scan'), 'sinks': len(sinks), 'unclean_sinks': dirty}


def live_install(journal=LIVE, marker=MARKER):
    data = read(journal)
    if not isinstance(data, dict):
        return {'recorded': False}
    turn = data.get('turn') or {}
    vm = data.get('vm_files') or {}
    return {'recorded': True,
            'neko': {k: (data.get('neko') or {}).get(k) for k in ('commit', 'patch_sha256', 'sha256', 'built_at')},
            'probe': {k: (data.get('probe') or {}).get(k) for k in ('main_sha256', 'go_sum_sha256', 'sha256', 'built_at')},
            'vm_files': {k: vm.get(k) for k in ('snapshot', 'neko_sha256', 'policy_sha256', 'missing_libraries',
                                                 'provisioned_at')},
            'turn': {k: turn.get(k) for k in ('hostname', 'listen_ip', 'conf_sha256', 'installed_at')},
            'enabled': data.get('enabled'), 'marker_present': marker.exists()}


def summary(a3=A3, a4=A4, a5=A5, a7=A7, journal=LIVE, marker=MARKER):
    out = {'a3': proof(newest(a3.glob('worker-proof-*.json')) if a3.is_dir() else None, 'worker_proof'),
           'a4': proof(newest(a4.glob('a4-proof-*.json')) if a4.is_dir() else None, 'a4_proof'),
           'a5': proof(newest(a5.glob('*/a5-proof-*.json')) if a5.is_dir() else None, 'a5_proof'),
           'a7': a7_proof(newest(a7.glob('*/a7-proof-*.json')) if a7.is_dir() else None),
           'live_install': live_install(journal, marker),
           'canary': [canary(a7 / name) for name in CANARIES]}
    enabled = out['live_install'].get('enabled') or {}
    enabled_mtime = None
    if enabled.get('at'):
        try:
            enabled_mtime = calendar.timegm(time.strptime(enabled['at'], '%Y-%m-%dT%H:%M:%SZ'))
        except ValueError:
            enabled_mtime = None
    out['a3']['after_live_enabled'] = bool(enabled_mtime is not None and out['a3'].get('mtime') and
                                          out['a3']['mtime'] >= enabled_mtime)
    verdicts = [out[k]['verdict'] for k in ('a3', 'a4', 'a5', 'a7')] + [c['verdict'] for c in out['canary']]
    out['all_passed'] = (all(v == 'passed' for v in verdicts) and all(not c.get('unclean_sinks') for c in out['canary'])
                         and out['a7'].get('live') is True and out['a7'].get('all_cases') is True
                         and out['live_install'].get('marker_present') is True and out['a3']['after_live_enabled'])
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.parse_args(argv)
    result = summary()
    print(json.dumps(result, indent=1))
    return 0 if result['all_passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
