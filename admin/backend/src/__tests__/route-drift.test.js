import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS,
  extractCaddyUpstreams,
  intendedUpstreams,
  indexGuestsByIp,
  compareRoutes,
  driftNotifications,
} from '../lib/route-drift.js';

// The live bridge at the time of the incident.
const GUESTS = [
  { name: 'mock2', ip: '10.185.17.224' },
  { name: 'unlimited-lighting', ip: '10.185.17.22' },
  { name: 'RustDesk', ip: '10.185.17.14' },
  { name: 'mailcow', ip: '10.185.17.145' },
];
const guestsByIp = indexGuestsByIp(GUESTS);

function intent(entries) {
  return new Map(
    entries.map((e) => [
      e.domain,
      {
        domain: e.domain,
        container: e.container ?? null,
        expected: new Set(e.expected || []),
        routes: [],
      },
    ]),
  );
}

function files(entries) {
  return new Map(entries.map((e) => [e.domain, { file: e.domain, upstreams: e.upstreams || [] }]));
}

describe('extractCaddyUpstreams', () => {
  test('pulls host → dial pairs out of adapted Caddy JSON', () => {
    const config = {
      apps: {
        http: {
          servers: {
            srv0: {
              routes: [
                {
                  match: [{ host: ['git.fractionate.ai'] }],
                  handle: [
                    {
                      handler: 'subroute',
                      routes: [
                        { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.185.17.22:3000' }] }] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };
    const got = extractCaddyUpstreams(config);
    assert.deepEqual([...got.get('git.fractionate.ai')], ['10.185.17.22:3000']);
  });

  test('keeps every upstream on a path-fan-out domain', () => {
    // The host matcher sits above the subroute; each inner route has its own
    // reverse_proxy. A walker that stopped at the first handler would report
    // one arbitrary upstream as though it were the whole domain.
    const config = {
      apps: {
        http: {
          servers: {
            srv0: {
              routes: [
                {
                  match: [{ host: ['meet.fractionate.ai'] }],
                  handle: [
                    {
                      handler: 'subroute',
                      routes: [
                        { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.185.17.131:7880' }] }] },
                        { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.185.17.131:8080' }] }] },
                        { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.185.17.131:3000' }] }] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };
    const got = extractCaddyUpstreams(config);
    assert.deepEqual(
      [...got.get('meet.fractionate.ai')].sort(),
      ['10.185.17.131:3000', '10.185.17.131:7880', '10.185.17.131:8080'],
    );
  });

  test('returns empty for null or junk input rather than throwing', () => {
    assert.equal(extractCaddyUpstreams(null).size, 0);
    assert.equal(extractCaddyUpstreams('nope').size, 0);
    assert.equal(extractCaddyUpstreams({}).size, 0);
  });
});

describe('intendedUpstreams', () => {
  test('groups routes by domain and skips static sites', () => {
    const rows = [
      { domain: 'a.example.com', path_prefix: '/', target_port: 3000, kind: 'container_service', target_ip: '10.0.0.5', lxc_container_name: 'app' },
      { domain: 'a.example.com', path_prefix: '/api', target_port: 8080, kind: 'container_service', target_ip: '10.0.0.5', lxc_container_name: 'app' },
      { domain: 'static.example.com', path_prefix: '/', target_port: null, kind: 'static_site', target_ip: null, lxc_container_name: null },
    ];
    const db = { prepare: () => ({ all: () => rows }) };
    const got = intendedUpstreams(db);
    assert.deepEqual([...got.get('a.example.com').expected].sort(), ['10.0.0.5:3000', '10.0.0.5:8080']);
    assert.equal(got.get('a.example.com').container, 'app');
    // A static site has no upstream to drift.
    assert.equal(got.get('static.example.com').expected.size, 0);
  });
});

describe('compareRoutes', () => {
  test('reports clean when both stores agree with the route table', () => {
    const report = compareRoutes({
      intended: intent([{ domain: 'git.fractionate.ai', container: 'mock2', expected: ['10.185.17.224:3000'] }]),
      siteFiles: files([{ domain: 'git.fractionate.ai', upstreams: ['10.185.17.224:3000'] }]),
      running: new Map([['git.fractionate.ai', new Set(['10.185.17.224:3000'])]]),
      guestsByIp,
    });
    assert.equal(report.clean, true);
    assert.equal(report.summary.match, 1);
    assert.equal(report.cross_tenant.length, 0);
  });

  test('THE INCIDENT: names the specific difference and the tenant it leaked to', () => {
    // git.fractionate.ai declared against mock2 (.224), but the site file and
    // Caddy both still dial .22 — which by then belonged to unlimited-lighting.
    const report = compareRoutes({
      intended: intent([{ domain: 'git.fractionate.ai', container: 'mock2', expected: ['10.185.17.224:3000'] }]),
      siteFiles: files([{ domain: 'git.fractionate.ai', upstreams: ['10.185.17.22:3000'] }]),
      running: new Map([['git.fractionate.ai', new Set(['10.185.17.22:3000'])]]),
      guestsByIp,
    });

    assert.equal(report.clean, false);
    const row = report.domains.find((d) => d.domain === 'git.fractionate.ai');
    assert.equal(row.status, STATUS.DRIFT);
    // It must name both addresses, not just say "drift".
    assert.ok(row.differences.some((d) => d.includes('10.185.17.22:3000') && d.includes('10.185.17.224:3000')));

    // And it must identify the cross-tenant condition explicitly.
    assert.equal(report.cross_tenant.length, 1);
    const x = report.cross_tenant[0];
    assert.equal(x.declared_container, 'mock2');
    assert.equal(x.serving_container, 'unlimited-lighting');
    assert.equal(x.upstream, '10.185.17.22:3000');
  });

  test('THE SILENT CASE: cross-tenant is flagged even when nothing is failing', () => {
    // The 200-with-someone-else's-app case. Both stores agree with each other;
    // only the container attribution reveals the problem. Under the old system
    // this raised nothing anywhere.
    const report = compareRoutes({
      intended: intent([{ domain: 'mock2.fractionate.ai', container: 'mock2', expected: ['10.185.17.22:80'] }]),
      siteFiles: files([{ domain: 'mock2.fractionate.ai', upstreams: ['10.185.17.22:80'] }]),
      running: new Map([['mock2.fractionate.ai', new Set(['10.185.17.22:80'])]]),
      guestsByIp,
    });
    assert.equal(report.clean, false);
    assert.equal(report.cross_tenant.length, 1);
    assert.equal(report.cross_tenant[0].serving_container, 'unlimited-lighting');
  });

  test('the prefix-collision pair does not produce a false cross-tenant report', () => {
    // .14 and .145 are different guests. A substring-based resolver would tie
    // mail.techmations.com to RustDesk and cry wolf on a healthy route.
    const report = compareRoutes({
      intended: intent([{ domain: 'mail.techmations.com', container: 'mailcow', expected: ['10.185.17.145:80'] }]),
      siteFiles: files([{ domain: 'mail.techmations.com', upstreams: ['10.185.17.145:80'] }]),
      running: new Map([['mail.techmations.com', new Set(['10.185.17.145:80'])]]),
      guestsByIp,
    });
    assert.equal(report.clean, true);
    assert.equal(report.cross_tenant.length, 0);
  });

  test('flags a declared route with no site file', () => {
    // Failure 2: the delete removed the block and left the row.
    const report = compareRoutes({
      intended: intent([{ domain: 'git.fractionate.ai', container: 'mock2', expected: ['10.185.17.224:3000'] }]),
      siteFiles: files([]),
      running: new Map(),
      guestsByIp,
    });
    assert.equal(report.clean, false);
    const row = report.domains[0];
    assert.equal(row.status, STATUS.MISSING);
    assert.ok(row.differences.some((d) => d.includes('no site file')));
  });

  test('flags a site file Caddy serves that the route table does not declare', () => {
    const report = compareRoutes({
      intended: intent([]),
      siteFiles: files([{ domain: 'leftover.example.com', upstreams: ['10.0.0.9:80'] }]),
      running: new Map(),
      guestsByIp,
    });
    assert.equal(report.summary.unmanaged_in_caddy, 1);
    assert.equal(report.domains[0].status, STATUS.UNMANAGED);
  });

  test('catches a file that is correct while Caddy is running something else', () => {
    // A reload that never happened, or a hand edit since the last reload.
    const report = compareRoutes({
      intended: intent([{ domain: 'a.example.com', container: 'app', expected: ['10.0.0.5:3000'] }]),
      siteFiles: files([{ domain: 'a.example.com', upstreams: ['10.0.0.5:3000'] }]),
      running: new Map([['a.example.com', new Set(['10.0.0.9:3000'])]]),
      guestsByIp,
    });
    assert.equal(report.clean, false);
    assert.equal(report.domains[0].status, STATUS.DRIFT);
    assert.ok(report.domains[0].differences.some((d) => d.includes('Caddy is running')));
  });

  test('degrades to a disk-only comparison when the admin API is unreachable', () => {
    const report = compareRoutes({
      intended: intent([{ domain: 'a.example.com', container: 'app', expected: ['10.0.0.5:3000'] }]),
      siteFiles: files([{ domain: 'a.example.com', upstreams: ['10.0.0.5:3000'] }]),
      running: null,
      guestsByIp,
    });
    assert.equal(report.caddy_admin_reachable, false);
    assert.equal(report.clean, true);
    assert.equal(report.domains[0].in_caddy, undefined);
  });

  test('a static site with no upstream is never reported as drifted', () => {
    const report = compareRoutes({
      intended: intent([{ domain: 'scan.fractionate.ai', container: null, expected: [] }]),
      siteFiles: files([{ domain: 'scan.fractionate.ai', upstreams: [] }]),
      running: new Map(),
      guestsByIp,
    });
    assert.equal(report.clean, true);
    assert.equal(report.summary.match, 1);
  });
});

describe('driftNotifications', () => {
  test('raises cross-tenant at error level, drift at warning', () => {
    const report = compareRoutes({
      intended: intent([{ domain: 'git.fractionate.ai', container: 'mock2', expected: ['10.185.17.224:3000'] }]),
      siteFiles: files([{ domain: 'git.fractionate.ai', upstreams: ['10.185.17.22:3000'] }]),
      running: new Map([['git.fractionate.ai', new Set(['10.185.17.22:3000'])]]),
      guestsByIp,
    });
    const notes = driftNotifications(report);
    const cross = notes.find((n) => n.dedupe_key.includes('cross-tenant'));
    assert.equal(cross.level, 'error');
    assert.ok(cross.title.includes('git.fractionate.ai'));
    assert.ok(notes.some((n) => n.level === 'warning'));
  });

  test('a clean report raises nothing', () => {
    const report = compareRoutes({
      intended: intent([{ domain: 'a.example.com', container: 'app', expected: ['10.0.0.5:3000'] }]),
      siteFiles: files([{ domain: 'a.example.com', upstreams: ['10.0.0.5:3000'] }]),
      running: new Map([['a.example.com', new Set(['10.0.0.5:3000'])]]),
      guestsByIp,
    });
    assert.deepEqual(driftNotifications(report), []);
  });

  test('dedupe keys are stable per condition so a sweep refreshes one row', () => {
    const report = compareRoutes({
      intended: intent([{ domain: 'a.example.com', container: 'app', expected: ['10.0.0.5:3000'] }]),
      siteFiles: files([{ domain: 'a.example.com', upstreams: ['10.0.0.9:3000'] }]),
      running: null,
      guestsByIp,
    });
    const first = driftNotifications(report).map((n) => n.dedupe_key);
    const second = driftNotifications(report).map((n) => n.dedupe_key);
    assert.deepEqual(first, second);
  });
});
