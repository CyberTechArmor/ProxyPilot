#!/usr/bin/env python3
"""Operator-only disposable VM browser cold-start and host RSS measurement."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('proxy_install', Path(__file__).with_name('a3-install-proxy.py'))
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)
GUEST = '''import json, os, pathlib, shutil, signal, subprocess, sys, tempfile, time
spki = sys.argv[1]
if pathlib.Path('/sys/class/net/enp5s0/address').read_text().strip() != '10:66:6a:55:f6:3f':
    raise SystemExit('Guest NIC identity mismatch')
if os.geteuid() != 0:
    raise SystemExit('Host fixture expected guest setup authority')
results = []
for index in range(3):
    work = tempfile.mkdtemp(prefix='a3-cold-', dir='/tmp')
    os.chmod(work, 0o700)
    os.chown(work, 65534, 65534)
    args = ['/usr/bin/chromium', '--headless=new', '--disable-gpu',
            '--no-first-run', '--no-default-browser-check',
            '--disable-dev-shm-usage', '--disable-background-networking',
            '--disable-extensions', '--disable-sync', '--disable-translate',
            '--proxy-server=http://10.185.17.1:18083',
            '--ignore-certificate-errors-spki-list=' + spki,
            '--user-data-dir=' + work, '--virtual-time-budget=15000',
            '--dump-dom', 'https://demo.fractionate.ai/']
    # No --no-sandbox. The browser and every child run as unprivileged nobody.
    def drop():
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
    process = None
    started = time.monotonic()
    try:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={'HOME':work, 'XDG_CONFIG_HOME':work, 'TMPDIR':work,
                                        'LANG':'C.UTF-8', 'PATH':'/usr/bin:/bin'},
                                   preexec_fn=drop, start_new_session=True)
        try:
            out, err = process.communicate(timeout=50)
        except subprocess.TimeoutExpired:
            raise SystemExit('Browser cold start timed out')
        duration = round(time.monotonic() - started, 3)
        if process.returncode != 0 or b'Sign in' not in out or b'<html' not in out[:2048].lower():
            print(json.dumps(dict(cold_start=index+1, exit_code=process.returncode,
                                  seconds=duration, dom_bytes=len(out),
                                  stderr_tail=err[-1200:].decode('utf-8','replace'))))
            raise SystemExit('Approved origin browser DOM check failed')
        # Never return the page body or cookies in evidence.
        results.append(dict(cold_start=index+1, exit_code=process.returncode,
                            seconds=duration, dom_bytes=len(out), sign_in_visible=True))
    finally:
        if process is not None:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            if process.poll() is None: process.communicate(timeout=5)
        shutil.rmtree(work)
print(json.dumps(dict(boot_id=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                      browser_starts=results)))
'''


def process_tree_rss_kib(pid, proc_root=Path('/proc')):
    """Read QEMU plus recursively parented host helpers; refuse lost root."""
    processes = {}
    for directory in proc_root.iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            status = (directory / 'status').read_text()
        except (OSError, UnicodeError):
            continue  # A process may exit while /proc is scanned.
        fields = {}
        for line in status.splitlines():
            if line.startswith(('PPid:', 'VmRSS:')):
                key, value = line.split(':', 1)
                fields[key] = int(value.strip().split()[0])
        if 'PPid' in fields:
            processes[int(directory.name)] = (fields['PPid'], fields.get('VmRSS', 0))
    if pid not in processes:
        raise ValueError('Verified QEMU process disappeared')
    selected = {pid}
    while True:
        more = {child for child, (parent, _) in processes.items() if parent in selected}
        if more <= selected:
            break
        selected |= more
    return sum(processes[child][1] for child in selected), len(selected)


def qemu_pid():
    state = i.i.query('/1.0/instances/' + i.i.fence.VM + '/state')
    if state.get('status') != 'Running' or type(state.get('pid')) is not int or state['pid'] <= 0:
        raise ValueError('Proof VM is not running')
    pid = state['pid']
    command = Path('/proc', str(pid), 'cmdline').read_bytes().replace(b'\0', b' ')
    if not (b'qemu' in command.lower() and i.i.fence.VM.encode() in command):
        raise ValueError('QEMU process does not match the proof VM')
    return pid


def run():
    status = i.status()
    pid = qemu_pid()
    baseline, baseline_processes = process_tree_rss_kib(pid)
    started = time.monotonic()
    child = subprocess.Popen(['incus', 'exec', i.i.fence.VM, '--', 'python3', '-c', GUEST,
                              status['certificate_spki_sha256']],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    peak = baseline
    try:
        while child.poll() is None:
            if time.monotonic() - started > 200:
                raise ValueError('Host browser proof exceeded its deadline')
            sample, _ = process_tree_rss_kib(pid)
            peak = max(peak, sample)
            time.sleep(0.2)
        stdout, stderr = child.communicate(timeout=3)
        if child.returncode != 0:
            raise ValueError('Guest browser proof failed: ' + stderr[-1200:] + stdout[-1200:])
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=3)
    report = i.i.parse_json(stdout, 'guest browser proof')
    results = report.get('browser_starts')
    if (not isinstance(results, list) or len(results) != 3 or
            any(entry.get('exit_code') != 0 or entry.get('sign_in_visible') is not True
                for entry in results)):
        raise ValueError('Three successful cold browser starts not observed')
    if qemu_pid() != pid or i.status()['vm_uuid'] != status['vm_uuid']:
        raise ValueError('Proof VM/proxy identity changed')
    return dict(browser_cold_starts='passed', vm_uuid=status['vm_uuid'],
                boot_id=report['boot_id'], starts=results,
                qemu_tree_baseline_rss_kib=baseline, qemu_tree_baseline_processes=baseline_processes,
                qemu_tree_peak_rss_kib=peak,
                worker_ready=False,
                notice='Cold browser DOM and RSS only; supervisor, human control and lifecycle remain open')


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise ValueError('Run in the host root terminal')
        print(json.dumps(run(), indent=2))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'A3 browser proof stopped: {error}', file=sys.stderr)
        sys.exit(1)
