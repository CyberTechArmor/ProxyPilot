#!/usr/bin/env python3
"""Host reboot persistence check for the agent proof stack (A6 follow-up).

Two steps around a host reboot, both as root on the proof host:

  a6-reboot-check.py record   before the reboot: saves the host and proof-VM
                              boot IDs (nothing else) to RECORD
  a6-reboot-check.py check    after the reboot: proves the host and the proof
                              VM really rebooted, then that the whole stack came
                              back by itself, using each component's own status

The check reads only. It runs the installers' `status` actions (fence, origin
proxy, supervisor, broker), the renewal timer, the origin-proxy probe from the
VM, and the dashboard container's health. It prints one JSON document of
verdicts and short reasons, never a status body, key or secret. Exit 0 only
when every check passed. A worker launch after the reboot is proven separately
by the A3 worker proof (a3-probe-worker.py).
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

SCRIPTS = Path(__file__).resolve().parent
RECORD = Path('/var/lib/proxypilot-a6-proof/reboot-before.json')
HOST_BOOT = Path('/proc/sys/kernel/random/boot_id')
VM = 'pp-agents-a3-debian13-proof-20260927'
TIMER = 'proxypilot-a3-proxy-renew.timer'
DASHBOARD = 'proxypilot-admin'


def run(argv, timeout=180):
    """(exit code, stdout) of one command; never raises for a failing command."""
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return 127, type(error).__name__
    return done.returncode, done.stdout


def installer(name, *args):
    return ['python3', str(SCRIPTS / name), *args]


def vm_boot(run=run):
    code, out = run(['incus', 'exec', VM, '--', 'cat', '/proc/sys/kernel/random/boot_id'], timeout=60)
    return out.strip() if code == 0 and out.strip() else None


def record(run=run, host_boot=HOST_BOOT, path=RECORD, clock=time.time):
    before = {'version': 1, 'host_boot_id': host_boot.read_text().strip(), 'vm_boot_id': vm_boot(run),
              'recorded_at_epoch': int(clock())}
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps(before) + '\n')
    path.chmod(0o600)
    return {'recorded': str(path), 'host_boot_id': before['host_boot_id'], 'vm_boot_id': before['vm_boot_id']}


def parsed(out):
    """The last JSON object an installer printed (status prints one document)."""
    start = out.rfind('\n{')
    try:
        return json.loads(out[start + 1:] if start >= 0 else out)
    except ValueError:
        return None


def verdict(name, passed, reason=''):
    return {'check': name, 'passed': bool(passed), **({'reason': reason} if reason and not passed else {})}


def check(run=run, host_boot=HOST_BOOT, path=RECORD):
    checks = []
    try:
        before = json.loads(path.read_text())
    except (OSError, ValueError):
        before = None
    if not isinstance(before, dict) or before.get('version') != 1:
        return {'reboot_check': 'failed', 'checks': [verdict('record', False, f'no record at {path}: run record first')]}
    now_host = host_boot.read_text().strip()
    checks.append(verdict('host_rebooted', now_host != before.get('host_boot_id'),
                          'the host boot ID is unchanged: no reboot happened since record'))
    now_vm = vm_boot(run)
    checks.append(verdict('vm_running', now_vm is not None, 'the proof VM is not running or does not answer'))
    checks.append(verdict('vm_rebooted', now_vm is not None and now_vm != before.get('vm_boot_id'),
                          'the proof VM boot ID is unchanged'))
    for name, script in (('fence', 'a3-install-fence.py'), ('origin_proxy', 'a3-install-proxy.py')):
        code, out = run(installer(script, 'status'))
        checks.append(verdict(name, code == 0 and (parsed(out) or {}).get('installed') is True,
                              f'{script} status exited {code}'))
    code, out = run(installer('a3-install-supervisor.py', 'status'))
    sup = parsed(out) or {}
    checks.append(verdict('supervisor', code == 0 and sup.get('accepting_launch') is True and sup.get('blockers') == []
                          and sup.get('active') is None,
                          f"exit {code}, accepting_launch {sup.get('accepting_launch')}, blockers {sup.get('blockers')}, "
                          f"active {'none' if sup.get('active') is None else 'an attempt'}"))
    code, out = run(installer('a4-install-broker.py', 'status'))
    broker = parsed(out) or {}
    checks.append(verdict('broker', code == 0 and broker.get('approle_login') == 'ok' and broker.get('vault_healthy') is True,
                          f"exit {code}, approle_login {broker.get('approle_login')}, vault_healthy {broker.get('vault_healthy')}"))
    active, _ = run(['systemctl', 'is-active', TIMER], timeout=30)
    enabled, _ = run(['systemctl', 'is-enabled', TIMER], timeout=30)
    checks.append(verdict('renewal_timer', active == 0 and enabled == 0, 'the certificate renewal timer is not active and enabled'))
    code, out = run(installer('a3-probe-proxy.py'))
    checks.append(verdict('proxy_path', code == 0 and (parsed(out) or {}).get('proxy_checks') == 'passed',
                          f'a3-probe-proxy.py exited {code}'))
    code, out = run(['docker', 'inspect', '--format', '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
                     DASHBOARD], timeout=30)
    checks.append(verdict('dashboard', code == 0 and out.split() in (['true', 'healthy'], ['true']),
                          f'container {DASHBOARD}: {out.strip() or "not found"}'))
    return {'reboot_check': 'passed' if all(c['passed'] for c in checks) else 'failed',
            'host_boot_id': now_host, 'vm_boot_id': now_vm, 'checks': checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=('record', 'check'))
    args = parser.parse_args()
    result = record() if args.action == 'record' else check()
    print(json.dumps(result, indent=1))
    return 0 if args.action == 'record' or result['reboot_check'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
