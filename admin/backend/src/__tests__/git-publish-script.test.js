import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPublishScript, buildAuthedRemoteUrl } from '../lib/git-publish.js';

const BASE = {
  url: 'https://tok3n@git.example.com/acme/widgets.git',
  branch: 'main',
  sourceDir: '/data/services/docs',
  subdir: '',
  subject: 'Publish static site "docs" from ProxyPilot',
};

// Run `sh -n` (parse, do not execute) over a generated script. A quoting
// mistake here would be a command-injection surface on a production host, so
// this asserts the shell itself accepts what we generate.
function shParses(script) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-script-'));
  const file = join(dir, 's.sh');
  try {
    writeFileSync(file, script);
    execFileSync('sh', ['-n', file], { stdio: 'pipe' });
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildPublishScript — the generated shell parses', () => {
  test('the ordinary case', () => {
    assert.equal(shParses(buildPublishScript(BASE)), true);
  });

  test('with a repo subdirectory', () => {
    assert.equal(shParses(buildPublishScript({ ...BASE, subdir: 'sites/docs' })), true);
  });

  test('with a branch containing a slash', () => {
    assert.equal(shParses(buildPublishScript({ ...BASE, branch: 'release/1.2' })), true);
  });

  test('with quotes and shell metacharacters in the commit subject', () => {
    // The subject is operator-supplied text. It must be data, not script.
    const nasty = `it's a "test"; rm -rf / $(whoami) \`id\` && echo pwned | tee /tmp/x`;
    const script = buildPublishScript({ ...BASE, subject: nasty });
    assert.equal(shParses(script), true);
    // The dangerous forms must appear only inside the single-quoted literal —
    // never as live syntax. Single-quoting is escaped as '\'' so a bare
    // unescaped quote followed by a command would be the failure.
    assert.equal(script.includes(`rm -rf / $(whoami)`), true, 'text is present');
    assert.match(script, /commit -q -m 'it'\\''s a "test"/);
  });

  test('with a path containing a single quote', () => {
    const script = buildPublishScript({ ...BASE, sourceDir: "/data/services/o'brien" });
    assert.equal(shParses(script), true);
    assert.match(script, /cd '\/data\/services\/o'\\''brien'/);
  });
});

describe('buildPublishScript — shape', () => {
  test('reads the manifest from stdin rather than interpolating it', () => {
    const script = buildPublishScript(BASE);
    assert.match(script, /cat > "\$M\/manifest"/);
    assert.match(script, /tar --null -T "\$M\/manifest"/);
  });

  test('always cleans up its temp tree, including on failure', () => {
    const script = buildPublishScript(BASE);
    assert.match(script, /trap 'rm -rf "\$M"' EXIT INT TERM/);
    assert.match(script, /^set -e$/m);
  });

  test('never force-pushes and never rewrites remote history', () => {
    const script = buildPublishScript(BASE);
    assert.equal(/--force|\+refs\/|push -f\b/.test(script), false);
    assert.match(script, /push -q .* HEAD:refs\/heads\/main/);
  });

  test('is a no-op commit when the source already matches', () => {
    assert.match(buildPublishScript(BASE), /git diff --cached --quiet; then echo "PROXYPILOT_NOCHANGE"; exit 0/);
  });

  test('preserves .git when wiping the tree for replacement', () => {
    assert.match(buildPublishScript(BASE), /-not -name \.git -exec rm -rf/);
  });

  test('a subdir publish only wipes that subtree, not the repo root', () => {
    const script = buildPublishScript({ ...BASE, subdir: 'sites/docs' });
    assert.match(script, /find 'sites\/docs' -mindepth 1/);
    assert.equal(script.includes('find . -mindepth 1'), false);
  });

  test('pins a committer identity and disables hooks and signing', () => {
    const script = buildPublishScript(BASE);
    assert.match(script, /user\.name=ProxyPilot/);
    assert.match(script, /core\.hooksPath=\/dev\/null/);
    assert.match(script, /commit\.gpgsign=false/);
  });
});

describe('buildAuthedRemoteUrl', () => {
  const gitea = { provider: 'gitea', base_url: 'https://git.example.com' };

  test('builds owner/name against the connector base URL', () => {
    assert.equal(
      buildAuthedRemoteUrl(gitea, 'acme/widgets', 'tok'),
      'https://tok@git.example.com/acme/widgets.git',
    );
  });

  test('percent-encodes a token so its characters cannot restructure the URL', () => {
    // A token containing '@' or '/' would otherwise change the host or path.
    const url = buildAuthedRemoteUrl(gitea, 'acme/widgets', 'a/b@evil.com');
    assert.equal(url, 'https://a%2Fb%40evil.com@git.example.com/acme/widgets.git');
    assert.equal(new URL(url).hostname, 'git.example.com');
  });

  test('honours a full URL and replaces any userinfo already on it', () => {
    assert.equal(
      buildAuthedRemoteUrl(gitea, 'https://someoneelse@git.other.com/a/b.git', 'tok'),
      'https://tok@git.other.com/a/b.git',
    );
  });

  test('keeps a plain-http base URL rather than silently upgrading it', () => {
    // An operator on a LAN-only Gitea gets what they configured; quietly
    // switching to https would just fail to connect with a confusing error.
    assert.equal(
      buildAuthedRemoteUrl({ provider: 'gitea', base_url: 'http://gitea.lan:3000' }, 'a/b', 'tok'),
      'http://tok@gitea.lan:3000/a/b.git',
    );
  });

  test('returns null when there is no host to build from', () => {
    assert.equal(buildAuthedRemoteUrl({ provider: 'gitea', base_url: null }, 'a/b', 'tok'), null);
  });

  test('falls back to github.com for the github provider', () => {
    assert.equal(
      buildAuthedRemoteUrl({ provider: 'github', base_url: null }, 'a/b', 'tok'),
      'https://tok@github.com/a/b.git',
    );
  });
});
