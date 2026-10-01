"""Actual updater entry/re-exec in disposable repositories with build boundaries.

Only the post-checkout build tail is replaced. Git, argument parsing, dirty
checks, ancestry, DB guard ordering and lock/re-exec use the production code.
Never contacts the network or changes an installed application.
"""
import json
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
REAL_GIT = shutil.which('git')


class UpdateGit(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pp-update-git-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'checkout with spaces'
        self.remote = self.root / 'remote.git'
        self.bin = self.root / 'bin'
        (self.repo / 'scripts').mkdir(parents=True)
        (self.repo / 'admin/backend').mkdir(parents=True)
        self.bin.mkdir()
        for name in ['update-git.sh', 'update-terminal-handoff.sh']:
            shutil.copyfile(ROOT / 'scripts' / name, self.repo / 'scripts' / name)
        source = (ROOT / 'update.sh').read_text()
        source = source.split('# A new dependency floor must not strand', 1)[0]
        source = source.replace('set -e\n', 'set -e\necho entry >> "$FIXTURE_EVENTS"\n', 1)
        source = source.replace('LOG_FILE="/tmp/proxypilot-update.log"', 'LOG_FILE="$FIXTURE_LOG"')
        # No installed-host reads: the DB boundary proves no backup/service
        # work occurs on a refused ancestry, and is inherited across re-exec.
        source = source.replace('# Backup the database before any code changes.',
                                'resolve_db_path(){ echo "$FIXTURE_ROOT/db"; }\n'
                                'backup_db(){ echo backup >> "$FIXTURE_EVENTS"; DB_BACKUP_FILE="$FIXTURE_ROOT/backup"; DB_BACKUP_SOURCE="$FIXTURE_ROOT/db"; }\n'
                                '# Backup the database before any code changes.', 1)
        source += '''
pp_verify_update_head before-build || exit 1
if flock -n "$PROXYPILOT_UPDATE_LOCK" true; then echo update-lock-lost >&2; exit 1; fi
echo build >> "$FIXTURE_EVENTS"
echo visible-stderr >&2
if [ "${DRIFT_AT_COMPLETION:-}" = 1 ]; then "$REAL_GIT" -C "$SCRIPT_DIR" commit -q --allow-empty -m drift; fi
pp_complete_update || exit 1
echo completed
'''
        (self.repo / 'update.sh').write_text(source)
        (self.repo / 'admin/backend/package.json').write_text('{"version":"1.0.0"}')
        self.env = dict(os.environ, GIT_AUTHOR_NAME='fixture', GIT_AUTHOR_EMAIL='fixture@invalid',
                        GIT_COMMITTER_NAME='fixture', GIT_COMMITTER_EMAIL='fixture@invalid',
                        REAL_GIT=REAL_GIT, FIXTURE_ROOT=str(self.root), FIXTURE_EVENTS=str(self.root / 'events'),
                        FIXTURE_LOG=str(self.root / 'log'), PROXYPILOT_UPDATE_RUNNER='1',
                        PROXYPILOT_UPDATE_RESULT_FILE=str(self.root / 'result.json'),
                        PROXYPILOT_UPDATE_LOCK=str(self.root / 'lock'))
        for name in ['PROXYPILOT_UPDATE_REEXEC', 'PROXYPILOT_UPDATE_EXPECTED_SHA',
                     'PROXYPILOT_UPDATE_LOCK_INHERITED', 'PROXYPILOT_UPDATE_EXPECTED_BRANCH']:
            self.env.pop(name, None)
        self.git('init', '-q', '-b', 'main')
        self.git('add', '.')
        self.git('commit', '-q', '-m', 'base')
        self.base = self.git('rev-parse', 'HEAD').strip()
        self.git('clone', '-q', '--bare', str(self.repo), str(self.remote))
        self.git('remote', 'add', 'origin', str(self.remote))
        wrapper = self.bin / 'git'
        wrapper.write_text('''#!/usr/bin/env python3
import json,os,subprocess,sys
a=sys.argv[1:]
# The helper supplies -C; normal version/status probes may not.
c=a[2:] if a[:1]==['-C'] else a
cmd=c[0] if c else ''
if cmd in ['fetch','merge']:
 with open(os.environ['FIXTURE_EVENTS'],'a') as f:f.write(cmd+' '+json.dumps(c[1:])+'\\n')
if cmd=='fetch' and os.environ.get('FAIL_FETCH'):
 print('fatal: fixture fetch failed',file=sys.stderr);sys.exit(128)
if cmd=='merge' and os.environ.get('FAIL_MERGE'):
 print('fatal: fixture merge failed',file=sys.stderr);sys.exit(128)
if cmd=='merge' and os.environ.get('FALSE_MERGE'):sys.exit(0)
r=subprocess.run([os.environ['REAL_GIT'],*a])
if r.returncode==0 and cmd=='fetch' and os.environ.get('MOVE_CACHED_REF'):
 subprocess.run([os.environ['REAL_GIT'],'-C',os.environ['FIXTURE_REPO'],'update-ref','refs/remotes/origin/main',os.environ['MOVE_CACHED_REF']],check=True)
if cmd=='merge-base' and os.environ.get('RACE_HEAD'):
 subprocess.run([os.environ['REAL_GIT'],'-C',os.environ['FIXTURE_REPO'],'commit','-q','--allow-empty','-m','raced-head'],check=True)
sys.exit(r.returncode)
''')
        wrapper.chmod(0o755)
        self.env.update(PATH=str(self.bin) + os.pathsep + self.env['PATH'], FIXTURE_REPO=str(self.repo))

    def git(self, *args):
        return subprocess.check_output([REAL_GIT, '-C', str(self.repo), *args], env=self.env,
                                       text=True, stderr=subprocess.PIPE)

    def target(self):
        (self.repo / 'remote-change').write_text('target')
        self.git('add', '.')
        self.git('commit', '-q', '-m', 'target')
        target = self.git('rev-parse', 'HEAD').strip()
        self.git('push', '-q', 'origin', 'main')
        self.git('reset', '-q', '--hard', self.base)
        return target

    def run_update(self, *flags, **extra):
        return subprocess.run(['bash', str(self.repo / 'update.sh'), '--yes', '--no-restart', *flags],
                              env=dict(self.env, **extra), capture_output=True, text=True, timeout=15)

    def events(self):
        p = self.root / 'events'
        return p.read_text().splitlines() if p.exists() else []

    def test_fetch_failure_128_is_not_hidden_by_successful_tee(self):
        r = self.run_update(FAIL_FETCH='1')
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('git fetch failed (exit 128)', r.stdout)
        self.assertFalse(any(e in ['backup', 'build'] for e in self.events()))
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)

    def test_merge_failure_128_is_not_hidden_by_successful_tee(self):
        self.target()
        r = self.run_update(FAIL_MERGE='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('git merge failed (exit 128)', r.stdout)
        self.assertNotIn('build', self.events())
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)

    def test_divergence_preserves_local_commit_and_has_no_application_effects(self):
        self.target()
        self.git('commit', '-q', '--allow-empty', '-m', 'local evidence')
        local = self.git('rev-parse', 'HEAD').strip()
        r = self.run_update()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('cannot fast-forward', r.stdout)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), local)
        self.assertFalse(any(e in ['backup', 'build'] or e.startswith('merge ') for e in self.events()))

    def test_fast_forward_builds_exact_fetched_target_once_with_one_reexec(self):
        target = self.target()
        r = self.run_update(MOVE_CACHED_REF=self.base)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), target)
        self.assertEqual(sum(e.startswith('fetch ') for e in self.events()), 1)
        self.assertEqual(self.events().count('entry'), 2)
        self.assertEqual(self.events().count('backup'), 1)
        self.assertEqual(self.events().count('build'), 1)
        self.assertIn('visible-stderr', r.stderr)
        self.assertEqual(json.loads((self.root / 'result.json').read_text())['expected_sha'], target)
        self.assertEqual(self.git('for-each-ref', '--format=%(refname)', 'refs/proxypilot-update').strip(), '')

    def test_current_and_explicit_rebuild_are_legitimate_successes(self):
        for flags, build, outcome in [((), 0, 'already-current'), (('--rebuild',), 1, 'build-current')]:
            with self.subTest(flags=flags):
                (self.root / 'events').unlink(missing_ok=True)
                r = self.run_update(*flags)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertEqual(self.events().count('build'), build)
                self.assertEqual(json.loads((self.root / 'result.json').read_text())['outcome'], outcome)

    def test_pinned_rollback_build_never_fetches_or_advances(self):
        self.target()  # origin main ahead; checkout deliberately remains at base
        r = self.run_update('--build-current=' + self.base)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)
        self.assertEqual(self.events().count('build'), 1)
        self.assertFalse(any(e.startswith(('fetch ', 'merge ')) for e in self.events()))

    def test_current_message_names_fetched_target_even_if_cached_main_is_stale(self):
        stale = self.target()
        self.git('push', '-q', '--force', 'origin', self.base + ':main')
        self.git('update-ref', 'refs/remotes/origin/main', stale)
        r = self.run_update()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        reported = r.stdout.split('Local and fetched main are both at: ', 1)[1].splitlines()[0]
        self.assertIn(self.base[:7], reported)
        self.assertNotIn(stale[:7], reported)
        self.assertNotIn('build', self.events())
        self.assertEqual(json.loads((self.root / 'result.json').read_text())['expected_sha'], self.base)

    def test_wrong_pinned_sha_dirty_pinned_build_and_conflicting_flags_refuse(self):
        target = self.target()
        for flags in [('--build-current=' + target,), ('--build-current=' + self.base, '--rebuild'),
                      ('--build-current=' + self.base, '--discard-local'), ('--build-current=' + self.base, '--enable-mock2'),
                      ('--build-current=main',), ('--build-current=' + self.base, '--build-current=' + self.base)]:
            r = self.run_update(*flags)
            self.assertNotEqual(r.returncode, 0, flags)
        (self.repo / 'untracked').write_text('preserve me')
        r = self.run_update('--build-current=' + self.base)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('clean checkout', r.stdout)
        self.assertEqual((self.repo / 'untracked').read_text(), 'preserve me')
        self.assertNotIn('build', self.events())

    def test_false_merge_success_and_completion_drift_never_record_success(self):
        self.target()
        for extra in [{'FALSE_MERGE':'1'}, {'DRIFT_AT_COMPLETION':'1'}]:
            self.git('reset', '-q', '--hard', self.base)
            r = self.run_update(**extra)
            self.assertNotEqual(r.returncode, 0)
            result = json.loads((self.root / 'result.json').read_text())
            self.assertEqual(result['status'], 'failed')
            self.assertIn('HEAD postcondition failed', result['reason'])

    def test_raced_head_and_unpinned_reexec_refuse_before_build(self):
        self.target()
        r = self.run_update(RACE_HEAD='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('raced HEAD', r.stdout)
        self.assertNotIn('build', self.events())
        r = self.run_update(PROXYPILOT_UPDATE_REEXEC='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('no valid pinned target', r.stdout)

    def test_reexec_marker_never_bypasses_another_updater_lock(self):
        with (self.root / 'lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            r = self.run_update(PROXYPILOT_UPDATE_REEXEC='1')
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('Another update.sh is already running', r.stderr)
            self.assertFalse(any(e.startswith('fetch ') or e == 'build' for e in self.events()))


if __name__ == '__main__':
    unittest.main()
