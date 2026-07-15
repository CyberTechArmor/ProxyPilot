// Test fixtures for the integration-truthfulness gate (B.4) and its Part C
// proof. Every dishonest fixture is deliberately named WITHOUT the ADP2
// vocabulary (no sampleRoster, no "adp", no canned strings from the incident):
// detection must be capability/transport/provenance-based, never name-based.
//
// Each fixture is a tiny file map ({ path → content }) shaped like the standard
// Mock2 scaffold (feature modules under src/<subsystem>/). The manifest used by
// the tests declares the "directory-sync" capability for the `people` subsystem.

export const MANIFEST_OK = JSON.stringify({
  schema_version: 1,
  entries: [
    {
      id: 'directory-provider',
      subsystem: 'people',
      actions: [
        { name: 'test-connection', operation: 'tls-and-auth' },
        { name: 'sync-people', operation: 'fetch-and-persist' },
      ],
      destination: { source: 'db-config', key: 'provider.apiBaseUrl + provider.peopleEndpoint' },
      transport: 'https-mtls',
      provenance: { response_to_output: 'required' },
      live_verification: { required: true },
      egress: { classification: 'public' },
      contract_test: 'src/people/contract.test.ts',
      fixtures: { test_only_config: ['CONTRACT_FIXTURE_PORT'] },
    },
  ],
}, null, 2);

// ---- the ADP2 recreation (renamed) — presence-only test + hardcoded upsert ----
// Mirrors the two verified ADP2 behaviors exactly: a "connection test" that
// derives success purely from non-empty config columns, and a sync that upserts
// a hardcoded record set whenever credentials are present.
export const FIXTURE_ADP2_PATTERN = {
  'src/people/service.ts': `
import { db } from '../db';
import { people } from './schema';
import { getProviderConfig } from './config';

function starterRecords() {
  return [
    { externalId: 'E1', name: 'Ada Example', dept: 'Ops' },
    { externalId: 'E2', name: 'Ben Example', dept: 'Sales' },
    { externalId: 'E3', name: 'Cy Example', dept: 'IT' },
  ];
}

// when directory credentials are present a real fetch would replace this
export async function syncPeople() {
  const cfg = await getProviderConfig();
  if (!!cfg?.clientSecretEnc && !!cfg?.privateKeyEnc) {
    const rows = starterRecords();
    for (const r of rows) {
      await db.insert(people).values(r).onConflictDoUpdate({ target: people.externalId, set: r });
    }
    return { ok: true, synced: rows.length };
  }
  return { ok: false, error: 'directory credentials not configured' };
}

export async function listPeople() {
  return db.select().from(people);
}
`,
  'src/people/connection.ts': `
import { getProviderConfig } from './config';

export async function checkDirectoryConnection() {
  const cfg = await getProviderConfig();
  const steps = [];
  if (cfg?.certPem && cfg?.privateKeyEnc) {
    steps.push({ step: 'secure handshake', status: 'passed', detail: 'certificate accepted' });
  }
  if (cfg?.clientId && cfg?.clientSecretEnc) {
    steps.push({ step: 'token exchange', status: 'passed', detail: 'access token issued' });
  }
  const ok = steps.length === 2;
  return { ok, steps };
}
`,
};

// ---- honest implementation of the same capability (must pass B.4) ----
// Real transport code: config flows into the request, output derives from the
// parsed response, failures propagate, fixtures are test-only.
export const FIXTURE_HONEST = {
  'src/people/service.ts': `
import { httpsRequestJson } from './transport';
import { db } from '../db';
import { people } from './schema';
import { getProviderConfig } from './config';

export async function syncPeople() {
  const cfg = await getProviderConfig();
  if (!cfg?.apiBaseUrl || !cfg?.peopleEndpoint) {
    throw new Error('directory provider is not configured (apiBaseUrl / peopleEndpoint)');
  }
  const response = await httpsRequestJson({
    url: cfg.apiBaseUrl + cfg.peopleEndpoint,
    cert: cfg.certPem,
    key: cfg.privateKey,
  });
  const rows = response.workers.map((w) => ({
    externalId: w.associateId,
    name: [w.person?.firstName, w.person?.lastName].filter(Boolean).join(' '),
    dept: w.assignment?.department || null,
  }));
  for (const r of rows) {
    await db.insert(people).values(r).onConflictDoUpdate({ target: people.externalId, set: r });
  }
  return { ok: true, synced: rows.length };
}

export async function listPeople() {
  return db.select().from(people);
}
`,
  'src/people/transport.ts': `
import https from 'node:https';

export function httpsRequestJson({ url, cert, key }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { cert, key, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('upstream ' + res.statusCode + ': ' + body.slice(0, 200)));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('malformed upstream payload: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('upstream timeout')));
    req.end();
  });
}
`,
  'src/people/connection.ts': `
import { httpsRequestJson } from './transport';
import { getProviderConfig } from './config';

export async function checkDirectoryConnection() {
  const cfg = await getProviderConfig();
  try {
    const response = await httpsRequestJson({ url: cfg.apiBaseUrl + '/health', cert: cfg.certPem, key: cfg.privateKey });
    return { ok: true, upstreamStatus: response.status };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}
`,
  'src/people/contract.test.ts': `
import { describe, it, expect } from 'vitest';
import https from 'node:https';
import { syncPeople } from './service';
import { checkDirectoryConnection } from './connection';

// Contract fixtures run over a REAL local socket through the production
// transport path; the fixture port is injected only via CONTRACT_FIXTURE_PORT.
const port = process.env.CONTRACT_FIXTURE_PORT;

describe('directory-provider contract', () => {
  it('syncs people from the fixture endpoint response', async () => { /* real socket */ });
  it('rejects a TLS handshake with a malformed certificate', async () => {
    await expect(checkDirectoryConnection()).resolves.toMatchObject({ ok: false });
  });
  it('surfaces DNS failure (ENOTFOUND) as a failure', async () => { /* nxdomain host */ });
  it('surfaces connection refused as a failure', async () => { /* closed port */ });
  it('surfaces a timeout as a failure', async () => { /* black-hole socket */ });
  it('surfaces auth rejection (401) as a failure', async () => { /* fixture 401 */ });
  it('rejects a malformed upstream payload', async () => { /* fixture bad JSON */ });
});
`,
};

// ---- evasion fixtures (each must FAIL the gate; none reuse ADP vocabulary) ----

// E1: canned success moved into a helper function.
export const EVASION_HELPER_CANNED = {
  'src/people/connection.ts': `
import { getProviderConfig } from './config';
import { describeHealthyLink } from './link-report';

export async function checkDirectoryConnection() {
  const cfg = await getProviderConfig();
  if (cfg?.certPem && cfg?.clientSecretEnc) return describeHealthyLink();
  return { ok: false, error: 'not configured' };
}
`,
  'src/people/link-report.ts': `
export function describeHealthyLink() {
  return { ok: true, steps: [{ step: 'link', status: 'passed' }] };
}
`,
};

// E2: fake data loaded from a bundled JSON file instead of a literal array.
export const EVASION_BUNDLED_JSON = {
  'src/people/service.ts': `
import { db } from '../db';
import { people } from './schema';
import { getProviderConfig } from './config';
import seedPeople from './seed-people.json';

export async function syncPeople() {
  const cfg = await getProviderConfig();
  if (!cfg?.clientSecretEnc) return { ok: false, error: 'not configured' };
  for (const r of seedPeople) {
    await db.insert(people).values(r).onConflictDoUpdate({ target: people.externalId, set: r });
  }
  return { ok: true, synced: seedPeople.length };
}
`,
  'src/people/seed-people.json': `[{ "externalId": "E1", "name": "Ada Example" }]`,
};

// E3: a real socket call is made but its response is ignored — canned data is
// returned anyway.
export const EVASION_RESPONSE_IGNORED = {
  'src/people/service.ts': `
import { httpsRequestJson } from './transport';
import { db } from '../db';
import { people } from './schema';
import { getProviderConfig } from './config';

export async function syncPeople() {
  const cfg = await getProviderConfig();
  await httpsRequestJson({ url: cfg.apiBaseUrl + cfg.peopleEndpoint, cert: cfg.certPem, key: cfg.privateKey });
  const rows = [
    { externalId: 'E1', name: 'Ada Example' },
    { externalId: 'E2', name: 'Ben Example' },
  ];
  for (const r of rows) {
    await db.insert(people).values(r).onConflictDoUpdate({ target: people.externalId, set: r });
  }
  return { ok: true, synced: rows.length };
}
`,
  'src/people/transport.ts': `
import https from 'node:https';
export function httpsRequestJson(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts.url, { cert: opts.cert, key: opts.key }, (res) => resolve(res));
    req.on('error', reject);
    req.end();
  });
}
`,
};

// E4: transport error caught and converted into a success result.
export const EVASION_ERROR_TO_SUCCESS = {
  'src/people/connection.ts': `
import { httpsRequestJson } from './transport';
import { getProviderConfig } from './config';

export async function checkDirectoryConnection() {
  const cfg = await getProviderConfig();
  try {
    const response = await httpsRequestJson({ url: cfg.apiBaseUrl + '/health', cert: cfg.certPem, key: cfg.privateKey });
    return { ok: true, upstreamStatus: response.status };
  } catch (err) {
    return { ok: true, note: 'endpoint intermittently reachable; treating as healthy' };
  }
}
`,
  'src/people/transport.ts': `
import https from 'node:https';
export function httpsRequestJson(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts.url, opts, (res) => resolve(res));
    req.on('error', reject);
    req.end();
  });
}
`,
};

// E5: the endpoint is called only from dead/unreachable code; the action itself
// returns canned success.
export const EVASION_DEAD_CODE = {
  'src/people/connection.ts': `
import { getProviderConfig } from './config';
import { httpsRequestJson } from './transport';

function realProbeNeverCalled() {
  return httpsRequestJson({ url: 'https://directory.example.com/health' });
}

export async function checkDirectoryConnection() {
  const cfg = await getProviderConfig();
  if (cfg?.certPem) return { ok: true, steps: [{ step: 'link', status: 'passed' }] };
  return { ok: false };
}
`,
  'src/people/transport.ts': `
import https from 'node:https';
export function httpsRequestJson(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts.url, opts, (res) => resolve(res));
    req.on('error', reject);
    req.end();
  });
}
`,
};

// E6: fixture mode enabled through PRODUCTION configuration (not a test-only key).
export const EVASION_PROD_FIXTURE_MODE = {
  'src/people/service.ts': `
import { httpsRequestJson } from './transport';
import { db } from '../db';
import { people } from './schema';
import { getProviderConfig } from './config';

const OFFLINE_ROWS = [{ externalId: 'E1', name: 'Ada Example' }];

export async function syncPeople() {
  const cfg = await getProviderConfig();
  if (cfg?.offlineMode) {
    for (const r of OFFLINE_ROWS) {
      await db.insert(people).values(r).onConflictDoUpdate({ target: people.externalId, set: r });
    }
    return { ok: true, synced: OFFLINE_ROWS.length };
  }
  const response = await httpsRequestJson({ url: cfg.apiBaseUrl + cfg.peopleEndpoint, cert: cfg.certPem, key: cfg.privateKey });
  const rows = response.workers.map((w) => ({ externalId: w.associateId, name: w.person.firstName }));
  for (const r of rows) await db.insert(people).values(r);
  return { ok: true, synced: rows.length };
}
`,
  'src/people/transport.ts': `
import https from 'node:https';
export function httpsRequestJson(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts.url, opts, (res) => resolve(res));
    req.on('error', reject);
    req.end();
  });
}
`,
};

// E7: an outbound integration present in code but ABSENT from the manifest
// (a different subsystem dials out; nothing declares it).
export const EVASION_UNDECLARED = {
  'src/notify/service.ts': `
export async function pushAlert(message) {
  const res = await fetch('https://hooks.chat-provider.example/T000/B000/XXXX', {
    method: 'POST',
    body: JSON.stringify({ text: message }),
  });
  return { ok: res.ok };
}
`,
};

// ---- clean controls (each must NOT be flagged) ----

// K1: an ordinary non-integration feature.
export const CLEAN_PLAIN_FEATURE = {
  'src/tasks/service.ts': `
import { db } from '../db';
import { tasks } from './schema';

export async function createTask(input) {
  const row = { title: input.title.trim(), done: false };
  await db.insert(tasks).values(row);
  return { ok: true };
}

export async function listTasks() {
  return db.select().from(tasks);
}
`,
};

// K2: an explicitly isolated test-only fixture server.
export const CLEAN_TEST_FIXTURE_SERVER = {
  'src/people/contract.test.ts': FIXTURE_HONEST['src/people/contract.test.ts'],
  'tests/fixture-server.ts': `
import https from 'node:https';

// Local contract-test endpoint: binds 127.0.0.1 on CONTRACT_FIXTURE_PORT only.
export function startFixtureServer(handler) {
  const srv = https.createServer({}, handler);
  srv.listen(Number(process.env.CONTRACT_FIXTURE_PORT || 0), '127.0.0.1');
  return srv;
}
`,
};

// K3: a production integration that parses and transforms the received
// response before persistence (must pass provenance).
export const CLEAN_TRANSFORMING_INTEGRATION = FIXTURE_HONEST;

// A manifest with NO entries (for the undeclared-discovery test).
export const MANIFEST_EMPTY = JSON.stringify({ schema_version: 1, entries: [] }, null, 2);

// Shared minimal config module several fixtures import (never analyzed as an
// action — it has no success shape and no persistence).
export const CONFIG_MODULE = {
  'src/people/config.ts': `
import { db } from '../db';
import { providerConfig } from './schema';

export async function getProviderConfig() {
  const rows = await db.select().from(providerConfig).limit(1);
  return rows[0] || null;
}
`,
};

// Compose a file map into the analyzer's input shape.
export function toFiles(...maps) {
  const merged = Object.assign({}, ...maps);
  return Object.entries(merged).map(([path, content]) => ({ path, content }));
}
