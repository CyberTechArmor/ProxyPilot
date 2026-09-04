// End-to-end exercise of the publish mechanism against a real local git remote.
//
// buildPublishScript() produces the script that does the actual work; the rest
// of publishDirToGit is enumeration, filtering and plumbing that is unit-tested
// elsewhere. This runs the generated script for real — git clone / init,
// tree replacement, commit, push — against a `file://` bare repo, so the
// behaviour that matters on a production host (history preserved, deletions
// propagated, no-op when unchanged, secrets held back) is proven rather than
// asserted about a string.
//
// Shells out to git and tar. Both are present wherever ProxyPilot runs — the
// publish path itself needs them — but the suite skips cleanly if they are not,
// rather than failing for an unrelated reason.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPublishScript } from '../lib/git-publish.js';
import { planPublish } from '../lib/git-publish-logic.js';

function haveTools() {
  for (const bin of ['git', 'tar']) {
    if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status !== 0) return false;
  }
  // GNU tar's --null -T is what the script uses to read the manifest.
  const probe = spawnSync('tar', ['--null', '-T', '/dev/null', '-cf', '/dev/null'], { stdio: 'ignore' });
  return probe.status === 0;
}

const TOOLS = haveTools();
let root;
let remote;
let source;

// Run the publish script exactly as the backend would: manifest on stdin,
// NUL-delimited.
function runPublish({ branch = 'main', subdir = '', subject = 'Publish from ProxyPilot', paths }) {
  const script = buildPublishScript({
    url: `file://${remote}`,
    branch,
    sourceDir: source,
    subdir,
    subject,
  });
  const res = spawnSync('sh', ['-c', script], {
    input: paths.join('\0'),
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', HOME: root },
  });
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

// What the remote actually holds on a branch.
function remoteFiles(branch = 'main') {
  const out = execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', branch], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
}

function remoteCommitCount(branch = 'main') {
  const out = execFileSync('git', ['--git-dir', remote, 'rev-list', '--count', branch], { encoding: 'utf8' });
  return Number(out.trim());
}

function remoteFileContent(path, branch = 'main') {
  return execFileSync('git', ['--git-dir', remote, 'show', `${branch}:${path}`], { encoding: 'utf8' });
}

before(() => {
  if (!TOOLS) return;
  root = mkdtempSync(join(tmpdir(), 'pp-publish-e2e-'));
  remote = join(root, 'remote.git');
  source = join(root, 'source');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  mkdirSync(join(source, 'src'), { recursive: true });
  mkdirSync(join(source, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(source, 'index.html'), '<h1>v1</h1>\n');
  writeFileSync(join(source, 'src', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(source, '.env'), 'DB_PASSWORD=hunter2\n');
  writeFileSync(join(source, '.env.example'), 'DB_PASSWORD=\n');
  writeFileSync(join(source, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1;\n');
});

after(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('publish end-to-end against a real git remote', { skip: !TOOLS ? 'git/GNU tar not available' : false }, () => {
  test('first publish creates the branch and ships only the planned files', () => {
    const all = ['index.html', 'src/app.js', '.env', '.env.example', 'node_modules/left-pad/index.js'];
    const { included, excluded } = planPublish(all);

    const r = runPublish({ paths: included });
    assert.equal(r.status, 0, r.out);
    // An empty bare repo clones successfully (git just warns), so the branch is
    // created off that clone. The `init` mode is reserved for a remote that
    // cannot be cloned at all. Either way this is the first commit.
    assert.match(r.out, /PROXYPILOT_PUSHED (clone-newbranch|init)/);

    assert.deepEqual(remoteFiles(), ['.env.example', 'index.html', 'src/app.js']);
    assert.equal(remoteCommitCount(), 1);

    // The secret must not be in the remote at all — not in the tree, and not
    // recoverable from history either, since this is its first commit.
    assert.equal(remoteFiles().includes('.env'), false);
    assert.equal(excluded.some((e) => e.path === '.env'), true);
    assert.throws(() => remoteFileContent('.env'), /./);
  });

  test('a second publish with no changes commits nothing', () => {
    const { included } = planPublish(['index.html', 'src/app.js', '.env', '.env.example']);
    const r = runPublish({ paths: included });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PROXYPILOT_NOCHANGE/);
    assert.equal(remoteCommitCount(), 1, 'no empty commit was created');
  });

  test('an edit lands as a new commit ON TOP — history is preserved, not replaced', () => {
    writeFileSync(join(source, 'index.html'), '<h1>v2</h1>\n');
    const { included } = planPublish(['index.html', 'src/app.js', '.env', '.env.example']);

    const r = runPublish({ paths: included });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PROXYPILOT_PUSHED clone/);

    assert.equal(remoteCommitCount(), 2, 'the previous commit is still there');
    assert.match(remoteFileContent('index.html'), /v2/);
  });

  test('a file removed from the source is removed from the remote', () => {
    rmSync(join(source, 'src', 'app.js'));
    const { included } = planPublish(['index.html', '.env', '.env.example']);

    const r = runPublish({ paths: included });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(remoteFiles(), ['.env.example', 'index.html']);
    assert.equal(remoteCommitCount(), 3);
  });

  test('publishing into a subdirectory leaves the rest of the repo alone', () => {
    writeFileSync(join(source, 'index.html'), '<h1>sub</h1>\n');
    const { included } = planPublish(['index.html', '.env.example']);

    const r = runPublish({ paths: included, subdir: 'sites/docs' });
    assert.equal(r.status, 0, r.out);

    const files = remoteFiles();
    // The subdir got the payload...
    assert.equal(files.includes('sites/docs/index.html'), true);
    // ...and the root content from earlier publishes survived untouched.
    assert.equal(files.includes('index.html'), true);
    assert.match(remoteFileContent('index.html'), /sub|v2/);
  });

  test('a second branch is created without disturbing the first', () => {
    const { included } = planPublish(['index.html', '.env.example']);
    const r = runPublish({ paths: included, branch: 'staging' });
    assert.equal(r.status, 0, r.out);

    assert.equal(remoteFiles('staging').includes('index.html'), true);
    // main still has the subdir publish from the previous test.
    assert.equal(remoteFiles('main').includes('sites/docs/index.html'), true);
  });

  test('a filename containing a quote and a space survives the round trip', () => {
    // The manifest is NUL-delimited and every interpolated value is quoted;
    // this is the case that would break a naive implementation.
    const odd = `it's a file.txt`;
    writeFileSync(join(source, odd), 'ok\n');
    const { included } = planPublish(['index.html', '.env.example', odd]);

    const r = runPublish({ paths: included, branch: 'oddnames' });
    assert.equal(r.status, 0, r.out);
    assert.equal(remoteFiles('oddnames').includes(odd), true);
    assert.match(remoteFileContent(odd, 'oddnames'), /ok/);
  });

  test('a commit subject full of shell metacharacters is stored as text', () => {
    writeFileSync(join(source, 'index.html'), '<h1>subject-test</h1>\n');
    const { included } = planPublish(['index.html', '.env.example']);
    const nasty = `note: $(touch ${join(root, 'PWNED')}) && echo x`;

    const r = runPublish({ paths: included, branch: 'subjects', subject: nasty });
    assert.equal(r.status, 0, r.out);

    // The substitution must NOT have run.
    assert.equal(existsSync(join(root, 'PWNED')), false, 'command substitution in the subject executed');
    const log = execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'subjects'], { encoding: 'utf8' });
    assert.match(log, /\$\(touch/);
  });
});
