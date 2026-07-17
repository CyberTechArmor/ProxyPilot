// Deterministic auth wiring (scaffold-auth.js) — the pure decision layer that
// makes "the base app can log in from day one" a platform guarantee instead of
// usage_md guidance a build model can skim. Native-free (risk R9): no DB, no
// container; the shipped example component doc is read from docs/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  componentWiresBootstrap, planAuthWiring, buildAuthWiredFiles, AUTH_WIRING_TARGETS,
} from '../mock2/scaffold-auth.js';
import { buildScaffoldFiles } from '../mock2/scaffold.js';
import { buildInstalledComponentsSection } from '../mock2/component-logic.js';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function loadAuthExample() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.join(here, '../../../../docs/features/examples/proxypilot-auth.component.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('componentWiresBootstrap: true for the shipped auth component, false otherwise', () => {
  const doc = loadAuthExample();
  assert.equal(componentWiresBootstrap(doc.contract, doc.files), true);
  // Missing the gate export → no wiring.
  const noGate = { ...doc.contract, exports: doc.contract.exports.filter((e) => e !== 'bootstrapGate') };
  assert.equal(componentWiresBootstrap(noGate, doc.files), false);
  // Missing the sign-in page → no wiring (the gate redirects to /login).
  const noLogin = doc.files.filter((f) => f.path !== 'public/login.html');
  assert.equal(componentWiresBootstrap(doc.contract, noLogin), false);
  assert.equal(componentWiresBootstrap(null, []), false);
});

test('wired files mount the gate, routers, sign-in page, and auth init', () => {
  const files = buildAuthWiredFiles();
  assert.deepEqual(files.map((f) => f.path), [...AUTH_WIRING_TARGETS]);
  const app = files.find((f) => f.path === 'src/app.ts').content;
  assert.match(app, /app\.use\(withAuth\)/);
  assert.match(app, /app\.use\(bootstrapGate\(\)\)/);
  assert.match(app, /app\.use\('\/api', authRoutes\)/);
  assert.match(app, /app\.use\('\/api', adminAuthRoutes\)/);
  assert.match(app, /app\.get\('\/login'/);
  assert.match(app, /isAuthenticated\(req\)/);
  assert.match(app, /\/design\.css/);
  // The scaffold contract survives: health routes and the mockup preview stay.
  assert.match(app, /app\.use\('\/api', healthRoutes\)/);
  assert.match(app, /_preview/);
  const server = files.find((f) => f.path === 'src/server.ts').content;
  assert.match(server, /initAuth\(\{ db: db as unknown as AuthDb, config: loadAuthConfigFromEnv\(\) \}\)/);
  assert.match(server, /wireLdapsFromConfig/);
  // initAuth must run before the app is created/served.
  assert.ok(server.indexOf('initAuth(') < server.indexOf('createApp()'), 'initAuth before createApp');
});

test('planAuthWiring: pristine scaffold targets are wired, missing files too', () => {
  const doc = loadAuthExample();
  const seeds = buildScaffoldFiles({ name: 'updoc' });
  const shas = new Map(AUTH_WIRING_TARGETS.map((t) => [t, sha256(seeds.find((f) => f.path === t).content)]));
  const plan = planAuthWiring({ contract: doc.contract, files: doc.files, currentShaByPath: shas });
  assert.equal(plan.applies, true);
  assert.deepEqual(plan.actions.map((a) => a.action), ['wire', 'wire']);
  assert.ok(plan.actions.every((a) => typeof a.content === 'string' && a.content.length > 0));
  // A missing target (null sha) is also written.
  const missing = planAuthWiring({ contract: doc.contract, files: doc.files, currentShaByPath: new Map([['src/app.ts', null]]) });
  assert.equal(missing.actions.find((a) => a.path === 'src/app.ts').action, 'wire');
});

test('planAuthWiring: adapted files are kept; re-install is idempotent', () => {
  const doc = loadAuthExample();
  // Adapted: hash of some build-edited content.
  const adapted = new Map([
    ['src/app.ts', sha256('// a build already changed this file')],
    ['src/server.ts', sha256('// and this one')],
  ]);
  const keep = planAuthWiring({ contract: doc.contract, files: doc.files, currentShaByPath: adapted });
  assert.deepEqual(keep.actions.map((a) => a.action), ['kept-adapted', 'kept-adapted']);
  // Already wired: hashes of the wired contents themselves → nothing to do.
  const wiredShas = new Map(buildAuthWiredFiles().map((f) => [f.path, sha256(f.content)]));
  const again = planAuthWiring({ contract: doc.contract, files: doc.files, currentShaByPath: wiredShas });
  assert.deepEqual(again.actions.map((a) => a.action), ['already-wired', 'already-wired']);
});

test('planAuthWiring: non-auth components never apply', () => {
  const plan = planAuthWiring({ contract: { exports: ['sendEmail'] }, files: [{ path: 'src/email/index.ts' }] });
  assert.equal(plan.applies, false);
  assert.deepEqual(plan.actions, []);
});

test('installed-components prompt carries the binding wired-auth rules', () => {
  const doc = loadAuthExample();
  const s = buildInstalledComponentsSection([
    { key: 'proxypilot-auth', name: 'ProxyPilot Auth', version: 1, contract: doc.contract },
  ]);
  assert.match(s, /Auth is WIRED by the platform/);
  assert.match(s, /NEVER remove or reorder withAuth \/ bootstrapGate\(\)/);
  assert.match(s, /canCreateSuperadmin/);
  // No auth component → no auth rules.
  const plain = buildInstalledComponentsSection([{ key: 'x', name: 'X', version: 1, contract: { exports: ['a'] } }]);
  assert.ok(!plain.includes('Auth is WIRED'));
});
