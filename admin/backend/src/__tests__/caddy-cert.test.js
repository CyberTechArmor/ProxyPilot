// Unit tests for lib/caddy-cert.js. Filesystem calls are stubbed via
// the `fs` injection seam — these never touch the host's actual ACME
// directory.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCertDir } from '../lib/caddy-cert.js';

// Build a fake fs adapter from an in-memory tree.
//   tree = {
//     'certificates': ['acme-v02', 'acme-staging'],
//     'certificates/acme-v02/example.com': ['example.com.crt', 'example.com.key'],
//     ...
//   }
// stats = { '/abs/path/example.com.crt': { mtime: <ms> } }
function makeFs(tree, stats) {
  return {
    listDir(path) {
      // strip trailing slash
      const key = path.replace(/\/$/, '');
      // tree keys are stored without the base prefix; allow either
      for (const k of Object.keys(tree)) {
        if (key.endsWith(k)) return tree[k];
      }
      return [];
    },
    statFile(path) {
      return stats[path] || null;
    },
  };
}

test('resolveCertDir: returns null for hostnames with no on-disk dir', () => {
  const fs = makeFs({ certificates: [] }, {});
  const r = resolveCertDir('example.com', { base: '/var/lib/caddy/.local/share/caddy', fs });
  assert.equal(r, null);
});

test('resolveCertDir: returns the dir + issuer + filenames when both .crt and .key are present', () => {
  const base = '/var/lib/caddy/.local/share/caddy';
  const fs = makeFs(
    {
      certificates: ['acme-v02.api.letsencrypt.org-directory'],
    },
    {
      [`${base}/certificates/acme-v02.api.letsencrypt.org-directory/example.com/example.com.crt`]: { mtime: 1_700_000_000_000 },
      [`${base}/certificates/acme-v02.api.letsencrypt.org-directory/example.com/example.com.key`]: { mtime: 1_700_000_000_000 },
    }
  );
  const r = resolveCertDir('example.com', { base, fs });
  assert.ok(r, 'expected a result');
  assert.equal(r.issuer, 'acme-v02.api.letsencrypt.org-directory');
  assert.equal(
    r.dir,
    `${base}/certificates/acme-v02.api.letsencrypt.org-directory/example.com`
  );
  assert.equal(r.certFilename, 'example.com.crt');
  assert.equal(r.keyFilename, 'example.com.key');
  assert.equal(r.mtime instanceof Date, true);
  assert.equal(r.mtime.getTime(), 1_700_000_000_000);
});

test('resolveCertDir: picks newest mtime across multiple issuers', () => {
  const base = '/var/lib/caddy/.local/share/caddy';
  const tree = {
    certificates: ['acme-staging', 'acme-v02'],
  };
  const stats = {
    [`${base}/certificates/acme-staging/example.com/example.com.crt`]: { mtime: 1_600_000_000_000 },
    [`${base}/certificates/acme-staging/example.com/example.com.key`]: { mtime: 1_600_000_000_000 },
    [`${base}/certificates/acme-v02/example.com/example.com.crt`]: { mtime: 1_700_000_000_000 },
    [`${base}/certificates/acme-v02/example.com/example.com.key`]: { mtime: 1_700_000_000_000 },
  };
  const fs = makeFs(tree, stats);
  const r = resolveCertDir('example.com', { base, fs });
  assert.equal(r.issuer, 'acme-v02');
  assert.equal(r.mtime.getTime(), 1_700_000_000_000);
});

test('resolveCertDir: skips issuers where .key is missing (in-flight ACME run)', () => {
  const base = '/var/lib/caddy/.local/share/caddy';
  const tree = {
    certificates: ['half-issued', 'good'],
  };
  const stats = {
    // half-issued has crt but no key — should be skipped
    [`${base}/certificates/half-issued/example.com/example.com.crt`]: { mtime: 1_800_000_000_000 },
    [`${base}/certificates/good/example.com/example.com.crt`]: { mtime: 1_700_000_000_000 },
    [`${base}/certificates/good/example.com/example.com.key`]: { mtime: 1_700_000_000_000 },
  };
  const fs = makeFs(tree, stats);
  const r = resolveCertDir('example.com', { base, fs });
  assert.equal(r.issuer, 'good');
});

test('resolveCertDir: refuses bogus hostnames', () => {
  const fs = makeFs({}, {});
  assert.equal(resolveCertDir('', { fs }), null);
  assert.equal(resolveCertDir('foo;rm -rf /', { fs }), null);
  assert.equal(resolveCertDir('a/b', { fs }), null);
  assert.equal(resolveCertDir(null, { fs }), null);
});

test('resolveCertDir: accepts wildcard hostnames', () => {
  const base = '/var/lib/caddy/.local/share/caddy';
  const tree = { certificates: ['acme-v02'] };
  const stats = {
    [`${base}/certificates/acme-v02/*.example.com/*.example.com.crt`]: { mtime: 1 },
    [`${base}/certificates/acme-v02/*.example.com/*.example.com.key`]: { mtime: 1 },
  };
  const fs = makeFs(tree, stats);
  const r = resolveCertDir('*.example.com', { base, fs });
  assert.ok(r);
});
