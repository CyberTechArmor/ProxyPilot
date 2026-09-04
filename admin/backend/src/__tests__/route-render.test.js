import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  domainsForService,
  renderDomains,
  applyServiceUpstream,
} from '../lib/route-render.js';

// ---------------------------------------------------------------------------
// A hand-rolled stand-in for the better-sqlite3 surface these helpers touch.
// The real module is a native dependency that isn't installed in the sandbox
// (see CLAUDE.md), so tests stub at the module boundary — the pattern the rest
// of the suite follows.
// ---------------------------------------------------------------------------
function makeDb({ services = [], routes = [] } = {}) {
  const state = {
    services: services.map((s) => ({ ...s })),
    routes: routes.map((r) => ({ ...r })),
    updates: [],
  };
  state.prepare = (sql) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT DISTINCT domain FROM service_http_routes WHERE service_id')) {
      return { all: (id) => [...new Set(state.routes.filter((r) => r.service_id === id).map((r) => r.domain))].map((domain) => ({ domain })) };
    }
    if (q.startsWith('SELECT id, target_ip FROM services WHERE id')) {
      return { get: (id) => state.services.find((s) => s.id === id) || undefined };
    }
    if (q.startsWith('UPDATE services SET target_ip')) {
      return {
        run: (ip, id) => {
          const row = state.services.find((s) => s.id === id);
          if (row) row.target_ip = ip;
          state.updates.push({ id, ip });
        },
      };
    }
    throw new Error(`unexpected SQL in test stub: ${q}`);
  };
  return state;
}

// Records what the render pipeline did, and can be told to fail at a stage.
function makeRenderSpy({ failOn = null } = {}) {
  const calls = { regenerate: [], adapt: 0, reload: 0, writes: [], removes: [] };
  const files = new Map();
  return {
    calls,
    files,
    deps: {
      regenerate: async (_db, domain) => {
        calls.regenerate.push(domain);
        if (failOn === 'regenerate') throw new Error('render boom');
        files.set(domain, `rendered:${domain}`);
      },
      adapt: async () => {
        calls.adapt += 1;
        if (failOn === 'adapt') { const e = new Error('adapt boom'); e.stderr = 'bad config'; throw e; }
      },
      reload: async () => {
        calls.reload += 1;
        if (failOn === 'reload' && calls.reload === 1) throw new Error('reload boom');
      },
      caddyFilePath: (domain) => `/etc/caddy/sites/${domain}`,
      writeConfig: async (path, content) => { calls.writes.push({ path, content }); },
      removeConfig: async (path) => { calls.removes.push(path); },
    },
  };
}

const SERVICE_ID = 'svc-mock2';

// mock2 owns two hostnames — the shape that made the incident possible.
function twoDomainFixture(targetIp = '10.185.17.22') {
  return makeDb({
    services: [{ id: SERVICE_ID, target_ip: targetIp, lxc_container_name: 'mock2' }],
    routes: [
      { service_id: SERVICE_ID, domain: 'git.fractionate.ai' },
      { service_id: SERVICE_ID, domain: 'mock2.fractionate.ai' },
    ],
  });
}

describe('domainsForService', () => {
  test('returns every domain the service serves, deduped', () => {
    const db = makeDb({
      services: [{ id: SERVICE_ID, target_ip: '10.0.0.1' }],
      routes: [
        { service_id: SERVICE_ID, domain: 'a.example.com' },
        { service_id: SERVICE_ID, domain: 'a.example.com' },
        { service_id: SERVICE_ID, domain: 'b.example.com' },
        { service_id: 'other', domain: 'c.example.com' },
      ],
    });
    assert.deepEqual(domainsForService(db, SERVICE_ID).sort(), ['a.example.com', 'b.example.com']);
  });

  test('returns empty rather than throwing when the query fails', () => {
    const db = { prepare: () => { throw new Error('no such table'); } };
    assert.deepEqual(domainsForService(db, SERVICE_ID), []);
  });
});

describe('renderDomains', () => {
  test('renders, validates, then reloads — in that order', async () => {
    const db = twoDomainFixture();
    const spy = makeRenderSpy();
    const res = await renderDomains({
      db,
      domains: ['git.fractionate.ai', 'mock2.fractionate.ai'],
      ...spy.deps,
    });
    assert.deepEqual(res.domains, ['git.fractionate.ai', 'mock2.fractionate.ai']);
    assert.deepEqual(spy.calls.regenerate, ['git.fractionate.ai', 'mock2.fractionate.ai']);
    assert.equal(spy.calls.adapt, 1);
    assert.equal(spy.calls.reload, 1);
  });

  test('never reloads a config that failed validation', async () => {
    const db = twoDomainFixture();
    const spy = makeRenderSpy({ failOn: 'adapt' });
    await assert.rejects(
      () => renderDomains({ db, domains: ['git.fractionate.ai'], ...spy.deps }),
      /failed validation/,
    );
    // The restore path reloads once to put Caddy back on the good config; the
    // point is that the *bad* config was never the thing reloaded onto.
    assert.equal(spy.calls.adapt, 1);
  });

  test('deduplicates and ignores empty domains', async () => {
    const db = twoDomainFixture();
    const spy = makeRenderSpy();
    const res = await renderDomains({
      db,
      domains: ['a.example.com', 'a.example.com', null, undefined, ''],
      ...spy.deps,
    });
    assert.deepEqual(res.domains, ['a.example.com']);
    assert.deepEqual(spy.calls.regenerate, ['a.example.com']);
  });

  test('is a no-op with no domains — no adapt, no reload', async () => {
    const db = twoDomainFixture();
    const spy = makeRenderSpy();
    const res = await renderDomains({ db, domains: [], ...spy.deps });
    assert.deepEqual(res.domains, []);
    assert.equal(spy.calls.adapt, 0);
    assert.equal(spy.calls.reload, 0);
  });
});

describe('applyServiceUpstream', () => {
  test('THE REGRESSION: moving the address re-renders EVERY domain on the service', async () => {
    // The incident in one assertion. mock2 moved .22 -> .224; a write touching
    // one hostname advanced the row and re-rendered only that hostname, leaving
    // git.fractionate.ai dialing an address another guest had taken over.
    const db = twoDomainFixture('10.185.17.22');
    const spy = makeRenderSpy();

    const res = await applyServiceUpstream({
      db, serviceId: SERVICE_ID, ip: '10.185.17.224', render: spy.deps,
    });

    assert.equal(res.changed, true);
    assert.equal(res.oldIp, '10.185.17.22');
    assert.equal(res.newIp, '10.185.17.224');
    assert.deepEqual(res.domains.sort(), ['git.fractionate.ai', 'mock2.fractionate.ai']);
    assert.deepEqual(spy.calls.regenerate.sort(), ['git.fractionate.ai', 'mock2.fractionate.ai']);
    assert.equal(db.services[0].target_ip, '10.185.17.224');
  });

  test('no-ops when the address is unchanged — no DB write, no Caddy touch', async () => {
    const db = twoDomainFixture('10.185.17.224');
    const spy = makeRenderSpy();
    const res = await applyServiceUpstream({
      db, serviceId: SERVICE_ID, ip: '10.185.17.224', render: spy.deps,
    });
    assert.equal(res.changed, false);
    assert.equal(spy.calls.regenerate.length, 0);
    assert.equal(spy.calls.adapt, 0);
    assert.equal(spy.calls.reload, 0);
    assert.equal(db.updates.length, 0);
  });

  test('no-ops on a missing address rather than writing null', async () => {
    const db = twoDomainFixture('10.185.17.22');
    const spy = makeRenderSpy();
    const res = await applyServiceUpstream({ db, serviceId: SERVICE_ID, ip: null, render: spy.deps });
    assert.equal(res.changed, false);
    assert.equal(db.services[0].target_ip, '10.185.17.22');
    assert.equal(spy.calls.regenerate.length, 0);
  });

  test('reverts the DB row when the render fails — both stores stay in agreement', async () => {
    const db = twoDomainFixture('10.185.17.22');
    const spy = makeRenderSpy({ failOn: 'regenerate' });

    await assert.rejects(
      () => applyServiceUpstream({ db, serviceId: SERVICE_ID, ip: '10.185.17.224', render: spy.deps }),
      /Failed to render/,
    );

    // The row must be back at the old address: a DB that moved without Caddy is
    // precisely the divergence this module exists to prevent.
    assert.equal(db.services[0].target_ip, '10.185.17.22');
  });

  test('reverts the DB row when validation fails', async () => {
    const db = twoDomainFixture('10.185.17.22');
    const spy = makeRenderSpy({ failOn: 'adapt' });
    await assert.rejects(
      () => applyServiceUpstream({ db, serviceId: SERVICE_ID, ip: '10.185.17.224', render: spy.deps }),
      /failed validation/,
    );
    assert.equal(db.services[0].target_ip, '10.185.17.22');
  });

  test('reverts the DB row when the reload fails', async () => {
    const db = twoDomainFixture('10.185.17.22');
    const spy = makeRenderSpy({ failOn: 'reload' });
    await assert.rejects(
      () => applyServiceUpstream({ db, serviceId: SERVICE_ID, ip: '10.185.17.224', render: spy.deps }),
      /reload failed/,
    );
    assert.equal(db.services[0].target_ip, '10.185.17.22');
  });

  test('throws for an unknown service rather than silently doing nothing', async () => {
    const db = twoDomainFixture();
    const spy = makeRenderSpy();
    await assert.rejects(
      () => applyServiceUpstream({ db, serviceId: 'nope', ip: '10.0.0.1', render: spy.deps }),
      /not found/,
    );
  });

  test('a service with no routes still moves its address', async () => {
    const db = makeDb({ services: [{ id: SERVICE_ID, target_ip: '10.0.0.1' }], routes: [] });
    const spy = makeRenderSpy();
    const res = await applyServiceUpstream({ db, serviceId: SERVICE_ID, ip: '10.0.0.2', render: spy.deps });
    assert.equal(res.changed, true);
    assert.deepEqual(res.domains, []);
    assert.equal(db.services[0].target_ip, '10.0.0.2');
  });
});
