import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXCLUDES,
  patternToRegExp,
  isExcluded,
  planPublish,
  validateRemoteRepo,
  validateBranch,
  repoApiPlan,
  commitSubject,
} from '../lib/git-publish-logic.js';

describe('patternToRegExp', () => {
  test('* does not cross a path separator', () => {
    assert.equal(patternToRegExp('*.key').test('server.key'), true);
    assert.equal(patternToRegExp('*.key').test('certs/server.key'), false);
  });

  test('** spans any depth', () => {
    assert.equal(patternToRegExp('node_modules/**').test('node_modules/a/b/c.js'), true);
    assert.equal(patternToRegExp('node_modules/**').test('node_modules/pkg'), true);
  });

  test('escapes regex metacharacters rather than honouring them', () => {
    // '.' must be literal, or '.env' would match 'aenv' and the filter would
    // widen instead of narrow.
    assert.equal(patternToRegExp('.env').test('aenv'), false);
    assert.equal(patternToRegExp('.env').test('.env'), true);
    assert.equal(patternToRegExp('a+b').test('a+b'), true);
    assert.equal(patternToRegExp('a+b').test('aab'), false);
  });

  test('? matches exactly one non-separator character', () => {
    assert.equal(patternToRegExp('a?c').test('abc'), true);
    assert.equal(patternToRegExp('a?c').test('a/c'), false);
  });
});

describe('isExcluded — secret hygiene', () => {
  test('holds back the credential shapes that actually turn up in app dirs', () => {
    for (const p of [
      '.env',
      '.env.production',
      'config/.env',
      'server.key',
      'certs/tls.pem',
      'id_rsa',
      'id_ed25519',
      '.ssh/known_hosts',
      '.aws/credentials',
      '.netrc',
      '.npmrc',
      '.pgpass',
      'credentials.json',
      'service-account-prod.json',
    ]) {
      assert.equal(isExcluded(p), true, `expected ${p} to be excluded`);
    }
  });

  test('holds back local state that should never be repo contents', () => {
    for (const p of ['.git/config', 'node_modules/react/index.js', 'app.sqlite', 'data.db-wal', '__pycache__/x.pyc']) {
      assert.equal(isExcluded(p), true, p);
    }
  });

  test('lets ordinary application source through', () => {
    for (const p of ['index.html', 'src/app.js', 'docker-compose.yml', 'README.md', 'assets/logo.svg', 'Dockerfile']) {
      assert.equal(isExcluded(p), false, p);
    }
  });

  test('publishes .env templates — they are documentation, not secrets', () => {
    for (const p of ['.env.example', '.env.sample', '.env.template', '.env.dist']) {
      assert.equal(isExcluded(p), false, p);
    }
    // But the real one beside it still does not ship.
    assert.equal(isExcluded('.env.production'), true);
  });

  test('catches a secret nested at any depth, not only at the root', () => {
    assert.equal(isExcluded('services/api/.env'), true);
    assert.equal(isExcluded('a/b/c/node_modules/x/y.js'), true);
    assert.equal(isExcluded('deep/nested/.ssh/id_rsa'), true);
  });

  test('an empty path is not excluded and does not throw', () => {
    assert.equal(isExcluded(''), false);
    assert.equal(isExcluded(null), false);
  });
});

describe('planPublish', () => {
  test('splits a realistic app directory and names every held-back file', () => {
    const { included, excluded } = planPublish([
      'docker-compose.yml',
      '.env',
      'src/index.js',
      'node_modules/left-pad/index.js',
      '.env.example',
      'tls/server.key',
    ]);
    assert.deepEqual(included.sort(), ['.env.example', 'docker-compose.yml', 'src/index.js']);
    assert.deepEqual(
      excluded.map((e) => e.path).sort(),
      ['.env', 'node_modules/left-pad/index.js', 'tls/server.key'],
    );
    // The reason has to be legible to an operator reading the result.
    assert.ok(excluded[0].reason.includes('secret'));
  });

  test('extra excludes are additive, not a replacement', () => {
    const { included, excluded } = planPublish(['a.txt', 'b.log', '.env'], { extraExcludes: ['*.log'] });
    assert.deepEqual(included, ['a.txt']);
    assert.deepEqual(excluded.map((e) => e.path).sort(), ['.env', 'b.log']);
  });

  test('includeSecrets bypasses the defaults — an explicit, auditable opt-out', () => {
    const { included, excluded } = planPublish(['.env', 'src/a.js'], { includeSecrets: true });
    assert.deepEqual(included.sort(), ['.env', 'src/a.js']);
    assert.equal(excluded.length, 0);
  });

  test('handles an empty or missing list', () => {
    assert.deepEqual(planPublish([]), { included: [], excluded: [] });
    assert.deepEqual(planPublish(null), { included: [], excluded: [] });
  });
});

describe('validateRemoteRepo', () => {
  test('accepts owner/name and full https URLs', () => {
    assert.equal(validateRemoteRepo('acme/widgets'), null);
    assert.equal(validateRemoteRepo('acme/widgets.git'), null);
    assert.equal(validateRemoteRepo('https://git.example.com/acme/widgets.git'), null);
  });

  test('rejects anything that could redirect the push somewhere else', () => {
    // These get interpolated into a remote URL; a traversal or an extra
    // segment must not be able to change the host or the path it lands on.
    for (const bad of ['../../etc', 'acme/../../evil', 'acme//widgets', 'a/b/c', 'acme', '']) {
      assert.notEqual(validateRemoteRepo(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  test('rejects a segment that starts with a dot', () => {
    assert.notEqual(validateRemoteRepo('acme/.git'), null);
  });

  test('rejects a non-http scheme', () => {
    assert.notEqual(validateRemoteRepo('ssh://git@host/acme/widgets'), null);
    assert.notEqual(validateRemoteRepo('file:///etc/passwd'), null);
  });
});

describe('validateBranch', () => {
  test('accepts ordinary branch names', () => {
    for (const b of ['main', 'feature/x', 'release-1.2', 'a_b.c']) {
      assert.equal(validateBranch(b), null, b);
    }
  });

  test('rejects shapes git itself would reject or that read as flags', () => {
    for (const b of ['', '-force', 'a..b', 'a//b', '/main', 'main/', 'x.lock', 'has space', 'semi;colon']) {
      assert.notEqual(validateBranch(b), null, JSON.stringify(b));
    }
  });
});

describe('repoApiPlan', () => {
  test('builds Gitea API URLs from the connector base URL', () => {
    const plan = repoApiPlan({ provider: 'gitea', base_url: 'https://git.example.com/' }, 'acme/widgets');
    assert.equal(plan.getUrl, 'https://git.example.com/api/v1/repos/acme/widgets');
    assert.equal(plan.createUrl, 'https://git.example.com/api/v1/orgs/acme/repos');
    assert.equal(plan.createUrlUser, 'https://git.example.com/api/v1/user/repos');
    assert.equal(plan.createBody.private, true);
    assert.equal(plan.createBody.name, 'widgets');
  });

  test('uses api.github.com for the github provider', () => {
    const plan = repoApiPlan({ provider: 'github', base_url: null }, 'acme/widgets');
    assert.equal(plan.getUrl, 'https://api.github.com/repos/acme/widgets');
  });

  test('returns null when there is no API to talk to', () => {
    assert.equal(repoApiPlan({ provider: 'generic_https', base_url: 'https://x' }, 'a/b'), null);
    assert.equal(repoApiPlan({ provider: 'gitea', base_url: '' }, 'a/b'), null);
    assert.equal(repoApiPlan({ provider: 'gitea', base_url: 'https://x' }, 'not-owner-name'), null);
  });
});

describe('commitSubject', () => {
  test('reads as a normal commit subject', () => {
    assert.equal(commitSubject('static site "docs"'), 'Publish static site "docs" from ProxyPilot');
    assert.equal(
      commitSubject('static site "docs"', 'nightly'),
      'Publish static site "docs" from ProxyPilot: nightly',
    );
  });

  test('strips newlines so a note cannot forge extra commit structure', () => {
    const s = commitSubject('x', 'line1\nline2\r\nAuthor: someone else');
    assert.equal(s.includes('\n'), false);
    assert.equal(s.includes('\r'), false);
  });

  test('caps the length', () => {
    assert.ok(commitSubject('x', 'y'.repeat(500)).length <= 200);
  });
});
