import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isIpv4,
  sameHost,
  parseUpstreamToken,
  parseCaddySiteFile,
  siteFileTargetsHost,
} from '../lib/caddy-site-file.js';

// The exact file shape the merged renderer emits (services.js
// buildDomainCaddyConfig), reduced to the parts this parser reads.
const MERGED_SITE = `git.fractionate.ai {
    handle {
        reverse_proxy 10.185.17.224:3000 {
            flush_interval -1
            transport http {
                keepalive 30s
            }
        }
    }

    header {
        X-Frame-Options "SAMEORIGIN"
    }

    log {
        output file /var/log/caddy/git.fractionate.ai.log
    }
}
`;

// The shape the legacy lxc.js fast path emitted.
const LEGACY_SITE = `# proxypilot: healthpath=/healthz
mock2.fractionate.ai {
    tls internal
    reverse_proxy 10.185.17.224:80
    encode gzip zstd
    log {
        output file /var/log/caddy/mock2.fractionate.ai.log
    }
}
`;

describe('isIpv4', () => {
  test('accepts well-formed addresses', () => {
    for (const ip of ['10.185.17.22', '10.185.17.224', '0.0.0.0', '255.255.255.255']) {
      assert.equal(isIpv4(ip), true, ip);
    }
  });

  test('rejects malformed addresses', () => {
    for (const bad of ['10.185.17', '10.185.17.256', '10.185.17.22.1', '10.185.17.022', 'nope', '', null]) {
      assert.equal(isIpv4(bad), false, String(bad));
    }
  });
});

describe('sameHost — the prefix-collision regression', () => {
  // This is the incident. `content.includes('10.185.17.22')` returned true for
  // a file dialing 10.185.17.224, so mock2's hostnames were filed under
  // unlimited-lighting and deleted from its page.
  test('does not treat a prefix as a match', () => {
    assert.equal(sameHost('10.185.17.22', '10.185.17.224'), false);
    assert.equal(sameHost('10.185.17.224', '10.185.17.22'), false);
  });

  test('the second live collision pair is also distinct', () => {
    // rd.fractionate.ai (RustDesk) vs mail.techmations.com (mailcow).
    assert.equal(sameHost('10.185.17.14', '10.185.17.145'), false);
    assert.equal(sameHost('10.185.17.145', '10.185.17.14'), false);
  });

  test('matches identical addresses, trimming whitespace', () => {
    assert.equal(sameHost('10.185.17.22', '10.185.17.22'), true);
    assert.equal(sameHost(' 10.185.17.22 ', '10.185.17.22'), true);
  });

  test('never matches on missing input', () => {
    assert.equal(sameHost(null, '10.0.0.1'), false);
    assert.equal(sameHost('10.0.0.1', undefined), false);
    assert.equal(sameHost('', ''), false);
  });
});

describe('parseUpstreamToken', () => {
  test('splits host and port', () => {
    assert.deepEqual(parseUpstreamToken('10.185.17.224:3000'), { host: '10.185.17.224', port: 3000 });
  });

  test('handles a bare host', () => {
    assert.deepEqual(parseUpstreamToken('10.185.17.224'), { host: '10.185.17.224', port: null });
  });

  test('strips a scheme', () => {
    assert.deepEqual(parseUpstreamToken('http://10.0.0.5:8080'), { host: '10.0.0.5', port: 8080 });
  });

  test('handles bracketed IPv6 with and without a port', () => {
    assert.deepEqual(parseUpstreamToken('[fd00::1]:3000'), { host: 'fd00::1', port: 3000 });
    assert.deepEqual(parseUpstreamToken('[fd00::1]'), { host: 'fd00::1', port: null });
  });

  test('treats a bare IPv6 literal as a host, not host:port', () => {
    assert.deepEqual(parseUpstreamToken('fd00::1'), { host: 'fd00::1', port: null });
  });

  test('returns null for empty input', () => {
    assert.equal(parseUpstreamToken(''), null);
    assert.equal(parseUpstreamToken(null), null);
  });
});

describe('parseCaddySiteFile', () => {
  test('reads domain and upstream from a merged site file', () => {
    const parsed = parseCaddySiteFile(MERGED_SITE);
    assert.deepEqual(parsed.domains, ['git.fractionate.ai']);
    assert.equal(parsed.primaryDomain, 'git.fractionate.ai');
    assert.deepEqual(parsed.upstreams, [{ host: '10.185.17.224', port: 3000 }]);
    assert.equal(parsed.tlsInternal, false);
  });

  test('reads healthpath marker and tls internal from a legacy site file', () => {
    const parsed = parseCaddySiteFile(LEGACY_SITE);
    assert.equal(parsed.primaryDomain, 'mock2.fractionate.ai');
    assert.equal(parsed.healthPath, '/healthz');
    assert.equal(parsed.tlsInternal, true);
    assert.deepEqual(parsed.upstreams, [{ host: '10.185.17.224', port: 80 }]);
  });

  test('collects EVERY upstream on a multi-route domain', () => {
    // The old single-regex scan took only the first reverse_proxy line, so a
    // fan-out domain reported one arbitrary upstream as though it were the whole
    // story.
    const meet = `meet.fractionate.ai {
    handle /livekit* {
        reverse_proxy 10.185.17.131:7880
    }
    handle /api* {
        reverse_proxy 10.185.17.131:8080
    }
    handle {
        reverse_proxy 10.185.17.131:3000
    }
}
`;
    const parsed = parseCaddySiteFile(meet);
    assert.deepEqual(parsed.upstreams, [
      { host: '10.185.17.131', port: 7880 },
      { host: '10.185.17.131', port: 8080 },
      { host: '10.185.17.131', port: 3000 },
    ]);
  });

  test('handles several site addresses on one block', () => {
    const parsed = parseCaddySiteFile('a.example.com, b.example.com {\n    reverse_proxy 10.0.0.5:80\n}\n');
    assert.deepEqual(parsed.domains, ['a.example.com', 'b.example.com']);
    assert.equal(parsed.primaryDomain, 'a.example.com');
  });

  test('strips an http:// scheme from the site address', () => {
    const parsed = parseCaddySiteFile('http://plain.example.com {\n    reverse_proxy 10.0.0.5:80\n}\n');
    assert.deepEqual(parsed.domains, ['plain.example.com']);
  });

  test('returns an empty shape for junk input', () => {
    for (const junk of ['', null, undefined, 'not a caddyfile']) {
      const parsed = parseCaddySiteFile(junk);
      assert.deepEqual(parsed.domains, []);
      assert.equal(parsed.primaryDomain, null);
      assert.deepEqual(parsed.upstreams, []);
    }
  });

  test('ignores a static-site block with no reverse_proxy', () => {
    const parsed = parseCaddySiteFile('scan.fractionate.ai {\n    root * /data/services/scan\n    file_server\n}\n');
    assert.equal(parsed.primaryDomain, 'scan.fractionate.ai');
    assert.deepEqual(parsed.upstreams, []);
  });
});

describe('siteFileTargetsHost', () => {
  test('is true only for the exact upstream host', () => {
    assert.equal(siteFileTargetsHost(MERGED_SITE, '10.185.17.224'), true);
  });

  test('is false for a prefix of the upstream host — the incident', () => {
    // Before the fix this returned true and cost two hostnames their TLS.
    assert.equal(siteFileTargetsHost(MERGED_SITE, '10.185.17.22'), false);
  });

  test('is false for an unrelated host and for missing input', () => {
    assert.equal(siteFileTargetsHost(MERGED_SITE, '10.185.17.190'), false);
    assert.equal(siteFileTargetsHost(MERGED_SITE, null), false);
    assert.equal(siteFileTargetsHost('', '10.185.17.224'), false);
  });
});
