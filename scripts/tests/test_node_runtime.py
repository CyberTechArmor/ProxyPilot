"""Exercise the real shell bootstrap with disposable Node/npm and download/apt boundaries.
Never contacts NodeSource, installs host packages, or restarts real services.
"""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/ensure-node-runtime.sh'
NODE = shutil.which('node')


class NodeRuntime(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['old', 'installed', 'bin', 'package']:
            (self.root / name).mkdir()
        self.events = self.root / 'events'
        self.runtime('old', '20.20.0')
        self.runtime('package', '24.0.0')
        self.stub('curl', '''#!/usr/bin/env python3
import os,sys
from pathlib import Path
root=Path(os.environ['FIXTURE_ROOT'])
with (root/'events').open('a') as f:f.write('download '+repr(sys.argv[1:])+'\\n')
out=Path(sys.argv[sys.argv.index('-o')+1])
out.write_text('#!/bin/bash\\necho setup >> "$FIXTURE_ROOT/events"\\nif [ -n "${FAIL_SETUP:-}" ]; then exit 7; fi\\n')
if os.environ.get('FAIL_DOWNLOAD'):raise SystemExit(22)
''')
        self.stub('apt-get', '''#!/usr/bin/env python3
import os,sys,shutil
from pathlib import Path
root=Path(os.environ['FIXTURE_ROOT'])
with (root/'events').open('a') as f:f.write('apt '+repr(sys.argv[1:])+'\\n')
if os.environ.get('FAIL_APT'):raise SystemExit(100)
if not os.environ.get('NO_RUNTIME'):
 for p in (root/'package').iterdir():shutil.copy(p,root/'installed'/p.name)
''')

    def stub(self, name, text):
        path = self.root / 'bin' / name
        path.write_text(text)
        path.chmod(0o755)

    def runtime(self, folder, version, npm=True):
        path = self.root / folder
        # Run the actual JS version predicate with an emulated old Node version.
        (path / 'node').write_text('#!/bin/bash\nif [ "$1" = -e ]; then exec ' + shlex.quote(NODE) + ' -e ' + shlex.quote("Object.defineProperty(process.versions,'node',{value:'" + version + "'});") + '"$2"; fi\nif [ "$1" = --version ]; then echo v' + version + '; exit; fi\nexec ' + shlex.quote(NODE) + ' "$@"\n')
        (path / 'node').chmod(0o755)
        if npm:
            (path / 'npm').write_text("#!/usr/bin/env node\nconst fs=require('fs');if(process.argv.includes('--version')){console.log('10.0.0');}else{fs.appendFileSync(process.env.FIXTURE_ROOT+'/events','npm '+JSON.stringify(process.argv.slice(2))+'\\n');process.exit(process.env.FAIL_NPM?42:0);}")
            (path / 'npm').chmod(0o755)

    def run_helper(self, can_install=True, ci=False, **extra):
        script = '''source "$1"
log(){ printf '%s\\n' "$*"; }
pp_node_candidates(){ printf '%s\\n' "$FIXTURE_ROOT/old/node" "$FIXTURE_ROOT/installed/node"; }
pp_node_can_install(){ return ''' + ('0' if can_install else '1') + '''; }
pp_ensure_node_runtime || exit $?
printf 'selected=%s\\nnpm=%s\\npath-node=%s\\n' "$NODE_CMD" "$NPM_CMD" "$(command -v node)"
"$NPM_CMD" --version
'''
        if ci:
            script += '\nLOG_FILE="$FIXTURE_ROOT/npm.log"\npp_install_locked_dependencies "$FIXTURE_ROOT/package" --omit=dev || exit $?\necho dependencies-ready\n'
        return subprocess.run(['bash', '-c', script, 'test', str(HELPER)], capture_output=True, text=True, timeout=10,
                              env=dict(os.environ, PATH=str(self.root / 'bin') + os.pathsep + os.environ['PATH'], FIXTURE_ROOT=str(self.root), **extra))

    def history(self):
        return self.events.read_text() if self.events.exists() else ''

    def test_old_runtime_is_upgraded_and_shadowed_path_is_replaced(self):
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('selected=' + str(self.root / 'installed/node'), r.stdout)
        self.assertIn('path-node=' + str(self.root / 'installed/node'), r.stdout)
        self.assertIn('https://deb.nodesource.com/setup_24.x', self.history())
        self.assertLess(self.history().index('setup'), self.history().index('apt'))
        self.assertIn("apt ['install', '-y', 'nodejs']", self.history())
        self.assertIn('runtime ready: v24.0.0', r.stdout)

    def test_supported_pair_is_reused_without_network_or_packages(self):
        for version in ['22.15.0', '22.20.0', '24.0.0']:
            with self.subTest(version=version):
                self.runtime('old', version)
                r = self.run_helper(can_install=False)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertEqual(self.history(), '')

    def test_supported_system_node_wins_over_old_path_without_install(self):
        self.runtime('installed', '24.0.0')
        r = self.run_helper(can_install=False)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('selected=' + str(self.root / 'installed/node'), r.stdout)
        self.assertEqual(self.history(), '')

    def test_missing_npm_repairs_the_pair(self):
        self.runtime('old', '24.0.0')
        (self.root / 'old/npm').unlink()
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('apt', self.history())

    def test_missing_node_is_installable(self):
        (self.root / 'old/node').unlink()
        self.assertEqual(self.run_helper().returncode, 0)
        self.assertIn('apt', self.history())

    def test_unsupported_host_or_unprivileged_user_stops_without_install(self):
        for version in ['20.20.0', '22.14.0', '23.0.0']:
            with self.subTest(version=version):
                self.runtime('old', version)
                r = self.run_helper(can_install=False)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('requires root on a Debian/Ubuntu host', r.stdout)
                self.assertEqual(self.history(), '')

    def test_failed_download_never_executes_or_installs_partial_content(self):
        r = self.run_helper(FAIL_DOWNLOAD='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('runtime download failed', r.stdout)
        self.assertNotIn('\nsetup\n', '\n' + self.history())
        self.assertNotIn('apt', self.history())

    def test_failed_repository_setup_never_installs(self):
        r = self.run_helper(FAIL_SETUP='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('repository setup failed', r.stdout)
        self.assertNotIn('apt', self.history())

    def test_failed_apt_or_false_success_never_continues(self):
        for extra in [{'FAIL_APT':'1'}, {'NO_RUNTIME':'1'}]:
            with self.subTest(extra=extra):
                r = self.run_helper(**extra)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('no application rebuild has started', r.stdout)
                self.assertNotIn('selected=', r.stdout)

    def test_locked_install_uses_selected_node_and_rejects_npm_failure_through_tee(self):
        self.runtime('old', '24.0.0')
        r = self.run_helper(ci=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('npm ["ci","--omit=dev"]', self.history())
        self.assertIn('dependencies-ready', r.stdout)
        r = self.run_helper(ci=True, FAIL_NPM='1')
        self.assertEqual(r.returncode, 42, r.stdout + r.stderr)
        self.assertNotIn('dependencies-ready', r.stdout)

    def test_generated_cli_wrapper_pins_node_for_itself_and_child_commands(self):
        self.runtime('installed', '24.0.0')
        cli = self.root / 'cli/bin'
        cli.mkdir(parents=True)
        (cli / 'proxypilot.js').write_text("console.log(require('child_process').execFileSync('node',['--version'],{encoding:'utf8'}).trim());")
        source = (ROOT / 'update.sh').read_text()
        body = source.split('    cat > /usr/local/bin/proxypilot <<EOF\n', 1)[1].split('\nEOF', 1)[0]
        wrapper = self.root / 'proxypilot'
        script = 'NODE_CMD="$1"\nSCRIPT_DIR="$2"\ncat > "$3" <<EOF\n' + body + '\nEOF\nchmod +x "$3"\nexec "$3"\n'
        r = subprocess.run(['bash', '-c', script, 'test', str(self.root / 'installed/node'), str(self.root), str(wrapper)],
                           capture_output=True, text=True, timeout=10, env=dict(os.environ, PATH=str(self.root / 'old') + os.pathsep + os.environ['PATH']))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout.strip(), 'v24.0.0')

    def test_updater_orders_runtime_before_changes_and_pins_cli_interpreter(self):
        # Structural wiring check complements the executable bootstrap tests and
        # the real updater restricted-Compose refusal in test_update_privileges.
        source = (ROOT / 'update.sh').read_text()
        provision = source.index('if ! pp_ensure_node_runtime; then')
        self.assertLess(source.index('python3 "${SCRIPT_DIR}/scripts/check-update-privileges.py"'), provision)
        self.assertLess(source.index('exec bash "$SCRIPT_DIR/update.sh" --rebuild'), provision)
        self.assertLess(provision, source.index('\nsync_env_keys\n'))
        self.assertIn('exec "${NODE_CMD}" "${SCRIPT_DIR}/cli/bin/proxypilot.js"', source)


if __name__ == '__main__':
    unittest.main()
