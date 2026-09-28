import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

STAGER = Path(__file__).resolve().parents[1] / 'a3-stage-candidate.sh'
POLICY = 'admin/backend/src/lib/mcp-policy/mcp-extended-policy.json'
ENV = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t',
           GIT_COMMITTER_EMAIL='t@t', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')


@unittest.skipUnless(shutil.which('git'), 'git is required')
class StageCandidateTests(unittest.TestCase):
    """The host situation: identical A3 files already on the candidate with another mode."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        self.git('init', '-q', '-b', 'main')
        self.write(POLICY, '{"install": "npm ci"}\n')
        self.write('admin/x.js', 'v1\n')
        self.write('other.js', 'base\n')
        self.base = self.commit('base')
        self.git('checkout', '-q', '-b', 'code')
        self.write('scripts/a3-mirror.py', '#!/usr/bin/env python3\nprint(1)\n', 0o755)
        self.write('scripts/new.py', '#!/usr/bin/env python3\nprint(2)\n')
        self.write('admin/x.js', 'v2\n')
        self.write(POLICY, '{"install": "npm ci && node prepare-self-check-native.mjs"}\n')
        self.code = self.commit('reviewed')
        self.git('checkout', '-q', '-b', 'candidate', self.base)
        self.write('scripts/a3-mirror.py', '#!/usr/bin/env python3\nprint(1)\n', 0o644)
        self.write(POLICY, '{"install": "npm ci && node prepare-self-check-native.mjs", "live_only": true}\n')
        self.write('other.js', 'live only\n')
        self.candidate = self.commit('candidate with mirrored file and live-only changes')

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, check=True):
        return subprocess.run(['git', *args], cwd=self.repo, env=ENV, capture_output=True, text=True, check=check)

    def write(self, path, text, mode=0o644):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        target.chmod(mode)

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', message)
        return self.git('rev-parse', 'HEAD').stdout.strip()

    def stage(self):
        return subprocess.run(['sh', str(STAGER), str(self.repo), self.code, self.base], env=ENV,
                              capture_output=True, text=True)

    def test_recovers_the_mode_conflict_and_keeps_candidate_only_changes(self):
        picked = self.git('cherry-pick', f'{self.base}..{self.code}', check=False)
        self.assertNotEqual(picked.returncode, 0)
        self.assertIn('CONFLICT (add/add)', picked.stdout + picked.stderr)
        result = self.stage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('aborted the interrupted cherry-pick', result.stdout)
        self.assertEqual(self.git('status', '--porcelain').stdout, '')
        self.assertEqual(self.git('diff', '--name-only', self.code, 'HEAD', '--', 'scripts', 'admin/x.js').stdout, '')
        self.assertEqual((self.repo / 'other.js').read_text(), 'live only\n')
        self.assertIn('live_only', (self.repo / POLICY).read_text())
        self.assertEqual(self.git('rev-parse', 'HEAD~1').stdout.strip(), self.candidate)
        again = self.stage()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn('already matches', again.stdout)

    def test_restages_a_newer_reviewed_commit_over_an_earlier_one(self):
        self.assertEqual(self.stage().returncode, 0)
        self.git('checkout', '-q', 'code')
        self.write('scripts/new.py', '#!/usr/bin/env python3\nprint(3)\n')
        self.code = self.commit('reviewed fix')
        self.git('checkout', '-q', 'candidate')
        result = self.stage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.repo / 'scripts/new.py').read_text(), '#!/usr/bin/env python3\nprint(3)\n')
        self.assertEqual((self.repo / 'other.js').read_text(), 'live only\n')

    def test_refuses_to_overwrite_a_candidate_only_change(self):
        self.write('admin/x.js', 'candidate only\n')
        head = self.commit('candidate-only edit of a reviewed path')
        result = self.stage()
        self.assertEqual(result.returncode, 1)
        self.assertIn('differs from both base and reviewed commit: admin/x.js', result.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD').stdout.strip(), head)
        self.assertEqual((self.repo / 'admin/x.js').read_text(), 'candidate only\n')

    def test_refuses_uncommitted_changes_and_a_missing_self_check_line(self):
        (self.repo / 'other.js').write_text('uncommitted\n')
        self.assertIn('uncommitted changes', self.stage().stderr)
        self.git('checkout', '-q', '--', 'other.js')
        self.write(POLICY, '{"install": "npm ci"}\n')
        self.commit('policy without the self-check line')
        result = self.stage()
        self.assertEqual(result.returncode, 1)
        self.assertIn('lacks the self-check install line', result.stderr)


if __name__ == '__main__':
    unittest.main()
