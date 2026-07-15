// B.7 egress completeness — pure dialed-host discovery vs declared egress.
// Written RED first: nothing correlated code that dials a host with an egress
// declaration (AUDIT.md A.6 — the ADP2 `egress:` block stayed commented out).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverDialedHosts, classifyHostString, egressCompleteness,
} from '../mock2/egress-check-logic.js';
import { parseIntegrationManifest } from '../mock2/integration-logic.js';
import { MANIFEST_OK } from './fixtures/integration-fixtures.js';

const manifest = parseIntegrationManifest(MANIFEST_OK).manifest;

test('discovers literal URLs, IP literals, env-sourced and config-sourced destinations', () => {
  const files = [{
    path: 'src/ldap/service.ts',
    content: `
import ldap from 'ldapjs';
const client = ldap.createClient({ url: 'ldaps://10.20.0.5:636' });
export async function ping() {
  await fetch('https://api.public-provider.example/v1/health');
  await fetch(process.env.WEBHOOK_URL);
  const cfg = await loadConfig();
  await fetch(cfg.apiBaseUrl + '/workers');
}
`,
  }];
  const hosts = discoverDialedHosts(files);
  const kinds = hosts.map((h) => h.kind).sort();
  assert.ok(hosts.some((h) => h.kind === 'literal' && h.host === '10.20.0.5' && h.port === 636), JSON.stringify(hosts));
  assert.ok(hosts.some((h) => h.kind === 'literal' && h.host === 'api.public-provider.example'));
  assert.ok(hosts.some((h) => h.kind === 'env' && h.configKey === 'WEBHOOK_URL'));
  assert.ok(hosts.some((h) => h.kind === 'config'), `expected a config-sourced destination in ${kinds}`);
});

test('host classification: private/internal vs public vs local contract-test', () => {
  assert.equal(classifyHostString('10.20.0.5'), 'private');
  assert.equal(classifyHostString('192.168.1.9'), 'private');
  assert.equal(classifyHostString('directory.internal'), 'private');
  assert.equal(classifyHostString('api.provider.example'), 'public');
  assert.equal(classifyHostString('127.0.0.1'), 'local');
  assert.equal(classifyHostString('localhost'), 'local');
});

test('a private host dialed in code with no declared egress entry fails', () => {
  const discovered = [{ file: 'src/ldap/service.ts', line: 3, kind: 'literal', host: '10.20.0.5', port: 636 }];
  const r = egressCompleteness({ discovered, declaredEgress: [], manifest, approvedGrants: [] });
  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.kind === 'undeclared_private_egress');
  assert.ok(f, JSON.stringify(r.findings));
  assert.match(f.message, /10\.20\.0\.5/);
});

test('a declared+approved private host passes; declared-but-unapproved is surfaced as pending', () => {
  const discovered = [{ file: 'src/ldap/service.ts', line: 3, kind: 'literal', host: '10.20.0.5', port: 636 }];
  const declared = [{ host: '10.20.0.5', port: 636, protocol: 'tcp' }];
  const ok = egressCompleteness({ discovered, declaredEgress: declared, manifest, approvedGrants: [{ host: '10.20.0.5', port: 636, status: 'approved' }] });
  assert.equal(ok.ok, true, JSON.stringify(ok.findings));
  const pending = egressCompleteness({ discovered, declaredEgress: declared, manifest, approvedGrants: [] });
  assert.equal(pending.ok, false);
  assert.ok(pending.findings.some((f) => f.kind === 'egress_grant_not_approved'));
});

test('public hosts are allowed per fence policy but noted', () => {
  const discovered = [{ file: 'src/notify/service.ts', line: 2, kind: 'literal', host: 'hooks.chat-provider.example', port: 443 }];
  const r = egressCompleteness({ discovered, declaredEgress: [], manifest, approvedGrants: [] });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.ok(r.notes.some((n) => n.kind === 'public_egress_noted' && /chat-provider/.test(n.message)));
});

test('local contract-test endpoints never count as deploy egress', () => {
  const discovered = [{ file: 'tests/fixture-server.ts', line: 5, kind: 'literal', host: '127.0.0.1', port: 8443 }];
  const r = egressCompleteness({ discovered, declaredEgress: [], manifest, approvedGrants: [] });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.findings.length, 0);
});

test('unknown dynamic destinations cannot silently pass: the config key must be declared', () => {
  const discovered = [{ file: 'src/webhooks/service.ts', line: 9, kind: 'env', configKey: 'WEBHOOK_URL' }];
  // Not covered by any manifest destination key and no declared egress → finding.
  const r = egressCompleteness({ discovered, declaredEgress: [], manifest, approvedGrants: [] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.kind === 'undeclared_dynamic_destination' && /WEBHOOK_URL/.test(f.message)));
  // Covered when a manifest entry declares that configuration key as its destination.
  const m2 = {
    schema_version: 1,
    entries: [...manifest.entries, {
      id: 'webhook-out', subsystem: 'webhooks',
      actions: [{ name: 'push', operation: 'http-post' }],
      destination: { source: 'env', key: 'WEBHOOK_URL' },
      transport: 'https', provenance: { response_to_output: 'required' },
      live_verification: { required: true }, egress: { classification: 'public' },
    }],
  };
  const r2 = egressCompleteness({ discovered, declaredEgress: [], manifest: m2, approvedGrants: [] });
  assert.equal(r2.ok, true, JSON.stringify(r2.findings));
});

test('config-sourced destinations covered by a manifest destination key pass', () => {
  const discovered = [{ file: 'src/people/service.ts', line: 12, kind: 'config', configKey: 'apiBaseUrl' }];
  const r = egressCompleteness({ discovered, declaredEgress: [], manifest, approvedGrants: [] });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});
