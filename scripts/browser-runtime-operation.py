#!/usr/bin/env python3
"""Fixed authenticated host operation; no caller paths, shell or acceptance."""
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import sys
import time

sys.dont_write_bytecode = True
SOURCE = '/opt/proxypilot/scripts'
OPERATION_ROOT = '/var/lib/proxypilot/update/browser-runtime-operation'
STATE = OPERATION_ROOT + '/state.json'


class Operation:
    def __init__(self, package, host, clock=time.time, sleep=time.sleep, request_id=None):
        self.p, self.h, self.t = package, host, host.tree
        self.clock, self.sleep = clock, sleep
        self.pkg = package.Package(host)
        self.record = None
        self.request_id = request_id

    def save(self, phase, **values):
        self.record.update(phase=phase, updated_at=self.clock(), **values)
        self.t.write(STATE, self.p.encoded(self.record), 0o600)
        print(json.dumps({'phase': phase, 'operation': self.record['operation'], **values}), flush=True)

    def dashboard(self):
        value = json.loads(self.h.execute(['docker', 'inspect', '--format', '{{json .}}', 'proxypilot-admin']))
        cid = value.get('Id', '')
        labels = value.get('Config', {}).get('Labels', {}) or {}
        if (not re.fullmatch('[a-f0-9]{64}', cid) or value.get('Name') != '/proxypilot-admin'
                or labels.get('com.docker.compose.service') != 'proxypilot'):
            self.p.refuse('Dashboard container identity is not the installed Compose service')
        return cid, value.get('State', {}).get('Running') is True

    def restart(self):
        cid, _ = self.dashboard()
        if cid != self.record['container_id']:
            self.p.refuse('Dashboard identity changed during operation')
        self.save('restarting_dashboard')
        self.h.execute(['docker', 'start', cid], timeout=60)
        deadline = self.clock() + 90
        while self.clock() < deadline:
            try:
                self.h.execute(['docker', 'exec', cid, 'node', '-e',
                    "fetch('http://127.0.0.1:3001/api/health',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], timeout=10)
                return
            except Exception:
                self.sleep(2)
        self.p.refuse('Dashboard restarted but health did not recover within 90 seconds')

    def authorize(self, operation):
        plan = self.pkg.plan(operation)
        # Keep full inventories private; public progress contains only a digest.
        self.t.write(OPERATION_ROOT + '/plan.json', self.p.encoded(plan), 0o600)
        self.save('package_' + operation, plan_sha256=plan['plan_sha256'])
        self.pkg.review(operation, plan['plan_sha256'], authority='authenticated-host-runner')
        return plan['plan_sha256']

    def transaction(self):
        return self.pkg.tx() if self.t.read(self.p.TRANSACTION + '/transaction.json', missing=True) is not None else None

    def restore(self, tx):
        action = 'rollback' if tx['phase'] in {'applied', 'committed'} else 'recover'
        self.pkg.restore(action, self.authorize(action))

    def archive_preparation(self):
        # No published transaction means apply has not stopped a runtime service
        # or replaced an owned target. Retain staged bytes, never discard them.
        if self.t.secure(self.p.TRANSACTION, missing=True) is None:
            return
        if self.transaction() is not None:
            self.p.refuse('Published transactions cannot be archived as preparation')
        saved = self.p.strict(self.t.read(OPERATION_ROOT + '/plan.json'))
        plan = saved['plan']
        if (plan.get('operation') != 'install' or saved['plan_sha256'] != self.p.sha(self.p.encoded(plan))
                or set(plan['files']) != set(self.p.OWNED)):
            self.p.refuse('Unrecognized pre-transaction preparation')
        self.pkg.current_identity(plan['identity'])
        if self.pkg.protected() != plan['protected'] or self.h.unit_check() != plan['units']:
            self.p.refuse('Pre-transaction runtime state changed')
        for name, pins in plan['files'].items():
            if self.t.pin(name, missing=True) != pins['old']:
                self.p.refuse('Pre-transaction installed bytes changed')
        self.t.inventory(self.p.TRANSACTION)  # custody, links and bounds
        destination = OPERATION_ROOT + '/preparation-' + secrets.token_hex(16)
        os.rename(self.t.path(self.p.TRANSACTION), self.t.path(destination))
        for name in (str(Path(self.p.TRANSACTION).parent), OPERATION_ROOT):
            fd = os.open(self.t.path(name), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try: os.fsync(fd)
            finally: os.close(fd)
        self.save('preparation_archived')

    def run(self, operation):
        if operation not in {'install', 'recover', 'rollback'}:
            self.p.refuse('Unknown fixed browser runtime operation')
        self.h.sources()  # immutable delivered inputs before any Docker mutation
        cid, running = self.dashboard()
        previous_bytes = self.t.read(STATE, missing=True)
        previous = self.p.strict(previous_bytes) if previous_bytes else None
        unfinished = previous and previous.get('phase') not in {'completed', 'failed_recovered'}
        if unfinished and operation != 'recover':
            self.p.refuse('Previous runtime operation needs recovery')
        if unfinished and previous.get('container_id') != cid:
            self.p.refuse('Recovery dashboard identity differs from retained operation')
        if not running and not (operation == 'recover' and unfinished):
            self.p.refuse('Dashboard is already stopped without an owned recovery record')
        before = self.transaction()
        before_id = before['id'] if before else None
        self.t.mkdir(OPERATION_ROOT, 0o700)
        self.record = dict(schema='browser-runtime-operation.v1', operation=operation,
            container_id=cid, request_id=self.request_id, started_at=self.clock(), authority='authenticated-host-runner')
        self.save('prepared')
        safe_to_start = False
        try:
            self.save('stopping_dashboard')
            self.h.execute(['docker', 'stop', '--time', '30', cid], timeout=45)
            if self.dashboard() != (cid, False):
                self.p.refuse('Dashboard stop did not complete')
            self.save('dashboard_stopped')
            if operation == 'recover':
                tx = self.transaction()
                if tx and tx['phase'] not in {'committed', 'rolled_back'}:
                    self.restore(tx)
                elif tx and tx['phase'] == 'committed':
                    self.pkg.verify_transaction(tx, require_new=True)
                    self.h.health({p: r['new'] for p, r in tx['files'].items()}, tx['identity']['key_id'], True)
                if tx is None:
                    self.archive_preparation()
                safe_to_start = True
            elif operation == 'rollback':
                if not before or before['phase'] not in {'applied', 'committed'}:
                    self.p.refuse('No applied package to roll back')
                self.restore(before)
                safe_to_start = True
            else:
                if before and before['phase'] not in {'committed', 'rolled_back'}:
                    self.p.refuse('Incomplete package requires recovery')
                action = 'update' if before and (before['phase'] == 'committed' or before['operation'] == 'update') else 'install'
                self.pkg.apply(self.authorize(action))
                self.pkg.commit(self.authorize('commit'))
                safe_to_start = True
            self.save('package_complete', acceptance_created=False, runtime_accepted=False)
        except Exception as error:
            try:
                tx = self.transaction()
                # Planning failure must not roll back an older healthy package.
                if tx and tx['phase'] != 'rolled_back' and (tx['id'] != before_id or operation in {'recover', 'rollback'}):
                    self.restore(tx)
                elif tx and tx['phase'] not in {'committed', 'rolled_back'}:
                    raise ValueError('Incomplete package retained')
                if tx is None:
                    self.archive_preparation()
                safe_to_start = True
            except Exception:
                self.save('recovery_required', error_type=type(error).__name__)
            if safe_to_start:
                self.restart()
                self.save('failed_recovered', error_type=type(error).__name__)
            raise
        if safe_to_start:
            self.restart()
            self.save('completed', acceptance_created=False, runtime_accepted=False)


def validate_installed(path):
    # Validate custody before importing executable code. Do not follow links.
    current = Path(path)
    for target in (current, *current.parents):
        info = target.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ValueError('Installed helper custody changed')
        if target == current and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            raise ValueError('Installed helper is not a private regular file')


def finish_interrupted_status(p, host, request_id):
    path = '/var/lib/proxypilot/update/state.json'
    raw = host.tree.read(path, missing=True)
    if raw is None:
        return
    value = p.strict(raw)
    if not request_id or value.get('id') != request_id or not str(value.get('action', '')).startswith('browser-runtime-') or value.get('status') not in {'running', 'queued'}:
        return
    ident = value.get('id', '')
    if not re.fullmatch('[a-f0-9-]{36}', ident):
        raise ValueError('Interrupted operation identity invalid')
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    value.update(status='failed', phase='Interrupted browser operation recovered',
                 reason='Host operation was interrupted; recovery restored the dashboard. Inspect runtime status before retrying.',
                 finished_at=now, updated_at=now, exit_code=1)
    data = p.encoded(value)
    host.tree.write('/var/lib/proxypilot/update/state.' + ident + '.json', data, 0o644)
    host.tree.write(path, data, 0o644)


def main():
    if os.geteuid() != 0 or Path(__file__).absolute() != Path(SOURCE + '/browser-runtime-operation.py') or Path(__file__).is_symlink():
        raise ValueError('Fixed root-owned installed helper required')
    if len(sys.argv) != 2 or sys.argv[1] not in {'install', 'recover', 'rollback', 'recover-if-needed'}:
        raise ValueError('One fixed operation required')
    validate_installed(SOURCE + '/browser-runtime-operation.py')
    validate_installed(SOURCE + '/selected-runtime-package.py')
    spec = importlib.util.spec_from_file_location('selected_runtime_package', SOURCE + '/selected-runtime-package.py')
    p = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(p)
    host = p.Host()
    host.tree.secure(SOURCE + '/browser-runtime-operation.py')
    host.tree.secure(SOURCE + '/selected-runtime-package.py')
    if sys.argv[1] == 'recover-if-needed':
        raw = host.tree.read(STATE, missing=True)
        if raw is None:
            return
    def interrupted(*_):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise RuntimeError('Operation interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    with host.tree.lock():
        action = sys.argv[1]
        if action == 'recover-if-needed':
            raw = host.tree.read(STATE, missing=True)
            if raw is None:
                return
            previous = p.strict(raw)
            request_id = previous.get('request_id')
            if previous.get('phase') not in {'completed', 'failed_recovered'}:
                Operation(p, host, request_id=request_id).run('recover')
            finish_interrupted_status(p, host, request_id)
        else:
            state = p.strict(host.tree.read('/var/lib/proxypilot/update/state.json'))
            request_id = state.get('id')
            if (state.get('action') != 'browser-runtime-' + action or state.get('status') != 'running'
                    or not isinstance(request_id, str) or not re.fullmatch('[a-f0-9-]{36}', request_id)):
                raise ValueError('Authenticated root-runner request context required')
            Operation(p, host, request_id=request_id).run(action)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'reason': str(error) if isinstance(error, ValueError) else type(error).__name__}), flush=True)
        sys.exit(1)
