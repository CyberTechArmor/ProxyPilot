"""Run the actual updater entry point with host service boundaries replaced.

No host services, application files, database or container are changed. The
fixture proves handoff arguments and refusal/order; real systemd/container
lifetime acceptance still requires a disposable installed host.
"""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/update-terminal-handoff.sh'


class TerminalUpdate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='pp-terminal-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.checkout = self.root / 'checkout with spaces'
        (self.checkout / 'scripts').mkdir(parents=True)
        (self.root / 'bin').mkdir()
        shutil.copyfile(ROOT / 'update.sh', self.checkout / 'update.sh')
        shutil.copyfile(HELPER, self.checkout / 'scripts' / HELPER.name)
        for command in ['systemd-run', 'systemctl', 'flock', 'git', 'npm', 'docker', 'apt-get']:
            stub = self.root / 'bin' / command
            stub.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name=Path(sys.argv[0]).name
with open(os.environ['FIXTURE_EVENTS'], 'a') as f:
    f.write(json.dumps([name, sys.argv[1:]])+'\\n')
if name == 'systemctl': sys.exit(int(os.environ.get('FAIL_SYSTEMCTL', '0')))
if name == 'systemd-run': sys.exit(int(os.environ.get('FAIL_HANDOFF', '0')))
# An inline updater must stop here, before it can touch the host.
sys.exit(99)
''')
            stub.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.root / 'bin') + os.pathsep + os.environ['PATH'],
                        FIXTURE_EVENTS=str(self.root / 'events'), PROXYPILOT_TERMINAL='host')
        for key in ['PROXYPILOT_UPDATE_RUNNER', 'PROXYPILOT_UPDATE_REEXEC', 'PROXYPILOT_TERMINAL_HANDOFF']:
            self.env.pop(key, None)

    def run_entry(self, *args, **env):
        return subprocess.run(['bash', str(self.checkout / 'update.sh'), *args],
                              env=dict(self.env, **env), capture_output=True, text=True, timeout=10)

    def events(self):
        path = self.root / 'events'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    @unittest.skipUnless(os.geteuid() == 0, 'actual privileged handoff entry requires root')
    def test_actual_entry_hands_off_before_lock_checkout_or_container_work(self):
        r = self.run_entry('--rebuild', '--verbose', COMPOSE_FILE='/opt/compose file.yml', TOKEN='SECRET-SENTINEL')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        events = self.events()
        self.assertEqual([e[0] for e in events], ['systemctl', 'systemd-run'])
        args = events[1][1]
        self.assertIn('--service-type=exec', args)
        self.assertIn('--property=StandardInput=null', args)
        self.assertIn('--property=StandardOutput=journal', args)
        self.assertIn('--property=StandardError=journal', args)
        self.assertIn('--property=KillMode=process', args)
        self.assertIn('--working-directory=' + str(self.checkout), args)
        self.assertIn('--setenv=PROXYPILOT_UPDATE_RUNNER=1', args)
        self.assertIn('--setenv=COMPOSE_FILE=/opt/compose file.yml', args)
        self.assertEqual(args[args.index('--') + 1:], ['/bin/bash', './update.sh', '--yes', '--rebuild', '--verbose'])
        for forbidden in ['--scope', '--pipe', '--pty', '--discard-local']:
            self.assertNotIn(forbidden, args)
        self.assertNotIn('SECRET-SENTINEL', repr(events) + r.stdout + r.stderr)
        self.assertNotIn('Update completed successfully', r.stdout)
        self.assertIn('completion has not been verified', r.stdout)

    @unittest.skipUnless(os.geteuid() == 0, 'actual privileged handoff entry requires root')
    def test_service_start_failure_never_falls_back_inline(self):
        r = self.run_entry('--rebuild', FAIL_HANDOFF='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual([e[0] for e in self.events()], ['systemctl', 'systemd-run'])
        self.assertIn('Refusing to continue', r.stdout)

    @unittest.skipUnless(os.geteuid() == 0, 'actual privileged handoff entry requires root')
    def test_unavailable_manager_refuses_before_work(self):
        r = self.run_entry('--rebuild', FAIL_SYSTEMCTL='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual([e[0] for e in self.events()], ['systemctl'])
        self.assertIn('No update work has started', r.stdout)

    def test_host_runner_does_not_handoff_again(self):
        r = self.run_entry('--rebuild', PROXYPILOT_UPDATE_RUNNER='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertTrue(self.events())
        self.assertFalse(any(name in ['systemd-run', 'systemctl'] for name, _ in self.events()))

    def test_no_restart_remains_foreground(self):
        r = self.run_entry('--no-restart')
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(any(name in ['systemd-run', 'systemctl'] for name, _ in self.events()))

    def test_marked_ancestor_is_detected_after_sudo_style_environment_clear(self):
        for marker in ['PROXYPILOT_TERMINAL=host', 'DOCKER_CONTAINER=true']:
            with self.subTest(marker=marker):
                env = {k: v for k, v in os.environ.items() if k not in ['PROXYPILOT_TERMINAL', 'DOCKER_CONTAINER']}
                key, value = marker.split('=')
                env[key] = value
                # Keep the marked parent alive, like the PTY shell around sudo.
                child = 'source "$1"; pp_dashboard_terminal_ancestor'
                parent = 'env -u PROXYPILOT_TERMINAL -u DOCKER_CONTAINER bash -c ' + shlex.quote(child) + ' test "$1"; rc=$?; exit "$rc"'
                r = subprocess.run(['bash', '-c', parent, 'test', str(HELPER)], env=env,
                                   capture_output=True, text=True, timeout=10)
                self.assertEqual(r.returncode, 0, r.stderr)

    @unittest.skipUnless(os.geteuid() == 0, 'actual privileged handoff requires root')
    def test_pre_pull_lock_is_closed_before_handoff(self):
        script = 'source "$1"; log(){ :; }; exec 200>"$2/lock"; /usr/bin/flock -n 200; pp_handoff_terminal_update "$2"; /usr/bin/flock -n "$2/lock" true'
        r = subprocess.run(['bash', '-c', script, 'test', str(HELPER), str(self.root)],
                           env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_completion_requires_health_or_explicit_skip(self):
        for skip, healthy, code, message in [
            ('false', 'false', 1, 'not complete'),
            ('false', '', 1, 'not complete'),
            ('false', 'true', 0, 'health check passed'),
            ('true', 'false', 0, 'restart was skipped'),
        ]:
            with self.subTest(skip=skip, healthy=healthy):
                script = 'source "$1"; log(){ printf "%s\\n" "$1"; }; pp_report_update_completion'
                r = subprocess.run(['bash', '-c', script, 'test', str(HELPER)], capture_output=True,
                                   text=True, env=dict(os.environ, SKIP_RESTART=skip, HEALTHY=healthy))
                self.assertEqual(r.returncode, code, r.stderr)
                self.assertIn(message, r.stdout)
                self.assertEqual('Update completed successfully' in r.stdout, skip == 'false' and healthy == 'true')

    def test_completion_is_wired_after_both_health_gates_and_runner_install(self):
        source = (ROOT / 'update.sh').read_text()
        completion = source.index('\npp_report_update_completion\n')
        self.assertGreater(completion, source.rindex('if [ "$HEALTHY" != "true" ]'))
        self.assertGreater(completion, source.rindex('then install_setup_runner; fi'))
        self.assertNotIn('Update completed successfully', source[:completion])

    def test_actual_docker_and_native_health_tails_only_report_success_when_ready(self):
        source = (ROOT / 'update.sh').read_text()
        docker = source.split('        # docker compose up -d returns 0', 1)[1].split('    # Non-Docker deployment:', 1)[0]
        docker = docker[docker.index('        HEALTH_PORT=3001'):]
        # The Docker arm exits before its enclosing fi; keep the executable arm.
        docker = docker[:docker.rindex('    fi')]
        native = source.split('    log "Waiting for ProxyPilot to become healthy on port ${PORT_TO_FREE}..."', 1)[1]
        native = 'if true; then\n' + native
        for kind, block in [('docker', docker), ('native', native)]:
            for ready in [True, False]:
                with self.subTest(kind=kind, ready=ready):
                    script = 'set -e\nsource "$1"\nlog(){ printf "%s\\n" "$1"; }; sleep(){ :; }; docker(){ :; }; install_setup_runner(){ :; }; curl(){ return ' + ('0' if ready else '1') + '; }\n' + block
                    r = subprocess.run(['bash', '-c', script, 'test', str(HELPER)],
                                       env=dict(os.environ, INSTALL_DIR=str(self.root), SCRIPT_DIR=str(self.root),
                                                SKIP_RESTART='false', PORT_TO_FREE='3001'),
                                       capture_output=True, text=True, timeout=10)
                    self.assertEqual(r.returncode, 0 if ready else 1, r.stdout + r.stderr)
                    self.assertEqual('Update completed successfully' in r.stdout, ready, r.stdout)

    def test_installed_frontend_build_failure_through_tee_stops_before_docker_down(self):
        source = (ROOT / 'update.sh').read_text()
        block = source.split('        # Rebuild frontend at the install location\n', 1)[1].split('        # Rebuild and restart Docker container\n', 1)[0]
        frontend = self.root / 'admin/frontend'
        (frontend / 'dist').mkdir(parents=True)
        # A stale index must not conceal a failed rebuild.
        (frontend / 'dist/index.html').write_text('old build')
        script = 'set -e\nlog(){ :; }; pp_install_locked_dependencies(){ return 0; }; NPM_CMD=false\n' + block + '\necho reached-docker-stop\n'
        r = subprocess.run(['bash', '-c', script], env=dict(os.environ, INSTALL_DIR=str(self.root), LOG_FILE=str(self.root / 'log')),
                           capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn('reached-docker-stop', r.stdout)


if __name__ == '__main__':
    unittest.main()
