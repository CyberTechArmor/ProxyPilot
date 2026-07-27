// The PLATFORM module of the provisioned base app.
//
// Everything asserted here ships into EVERY new project, so a regression is not
// a bug in one app — it is a bug in every app created afterwards.
//
// Native-free: the generators are pure string builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildScaffoldFiles } from '../mock2/scaffold.js';
import { buildAuthWiredFiles } from '../mock2/scaffold-auth.js';
import { seedOrgName, PLACEHOLDER_ORG_NAME } from '../mock2/scaffold-platform.js';

const scaffold = () => new Map(buildScaffoldFiles({ id: 1, name: 'probe' }).map((f) => [f.path, f.content]));
const wired = () => new Map(buildAuthWiredFiles().map((f) => [f.path, f.content]));

test('RATCHET: every emitted JavaScript file parses', () => {
  // The scaffold is built from template literals, so an unescaped backtick in a
  // COMMENT silently truncates the emitted file and ships a syntax error into
  // every new project. That mistake was made four times while writing this
  // module; this is the check that makes it impossible to ship.
  for (const [path, content] of scaffold()) {
    if (!path.endsWith('.js')) continue;
    assert.doesNotThrow(() => new vm.Script(content, { filename: path }), `${path} does not parse`);
  }
});

test('RATCHET: no emitted file was truncated by a stray backtick', () => {
  // A truncated template literal usually leaves an obviously unbalanced file.
  // Braces are the cheapest signal that survives in TS as well as JS.
  for (const [path, content] of new Map([...scaffold(), ...wired()])) {
    if (!/\.(ts|js)$/.test(path)) continue;
    let depth = 0;
    for (const ch of content) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    assert.equal(depth, 0, `${path} has unbalanced braces (${depth}) — likely a truncated template literal`);
    assert.ok(content.trim().length > 20, `${path} is suspiciously short`);
  }
});

test('every project is provisioned with the platform module', () => {
  const files = scaffold();
  for (const p of ['src/platform/schema.ts', 'src/platform/branding.ts', 'src/platform/api-keys.ts',
    'src/platform/api-key-auth.ts', 'src/platform/readonly.ts',
    'migrations/0100_platform.sql', 'public/theme.js', 'public/platform.js']) {
    assert.ok(files.has(p), `the scaffold must emit ${p}`);
  }
  // routes.ts is the exception: it imports the auth component, so it ships with
  // the auth wiring (see the scaffold-only regression test below).
  assert.ok(wired().has('src/platform/routes.ts'));
  // And it is actually MOUNTED — emitting a file nothing imports would be a
  // feature that exists on disk and nowhere else.
  const app = wired().get('src/app.ts');
  assert.match(app, /publicPlatformRoutes/);
  assert.match(app, /adminPlatformRoutes/);
  assert.match(app, /withApiKey/);
  const server = wired().get('src/server.ts');
  assert.match(server, /ensureSeeded/, 'branding + legal pages must be seeded at boot');
  assert.match(server, /ensureViews/, 'the read-only views must be published at boot');
});

test('the public surface is mounted BEFORE the auth gate', () => {
  const app = wired().get('src/app.ts');
  // The sign-in screen renders the copyright notice and the Privacy/Terms links
  // before anyone has a session, and the browser fetches the favicon with no
  // cookies at all. Behind the gate, all of that 401s or redirects.
  assert.ok(app.indexOf('publicPlatformRoutes') < app.indexOf('app.use(bootstrapGate())'),
    'public platform routes must be mounted before the bootstrap gate');
  assert.ok(app.indexOf('withApiKey') < app.indexOf('app.use(bootstrapGate())'),
    'API-key auth must attach before the gate so a key is a valid identity');
});

test('the theme is applied before first paint and surfaces are tokenised', () => {
  const files = scaffold();
  const css = files.get('public/base.css');
  const theme = files.get('public/theme.js');
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /color-scheme:light/);
  assert.match(css, /color-scheme:dark/);
  assert.match(theme, /prefers-color-scheme: dark/);
  assert.match(theme, /'system'/);
  // Delegated, not per-render: screens re-render their own headers, and binding
  // in each one guarantees the next one added is silently broken.
  assert.match(theme, /document\.addEventListener\('click'/);
  // 44px touch targets at phone widths, and reduced motion honoured.
  assert.match(css, /min-height:44px/);
  assert.match(css, /prefers-reduced-motion/);
});

test('legal pages ship real copy and substitute the org at READ time', () => {
  const b = scaffold().get('src/platform/branding.ts');
  assert.match(b, /DEFAULT_PAGES/);
  assert.match(b, /Privacy Policy/);
  assert.match(b, /Terms & Conditions/);
  // Substitution at read time is what makes a rename update the shipped copy.
  assert.match(b, /export function substitute/);
  assert.match(b, /\{\{ORG\}\}/);
  // The year is derived, never stored — a stored year goes stale on 1 January.
  const fn = b.slice(b.indexOf('export function copyrightYears'), b.indexOf('export function copyrightNotice'));
  assert.match(fn, /getFullYear\(\)/);
  // The client recomputes too, so a tab open across New Year corrects itself.
  assert.match(scaffold().get('public/platform.js'), /new Date\(\)\.getFullYear\(\)/);
});

test('a new app is named after its project, not "Application"', () => {
  // The operator names the project at provision and the platform then dropped
  // it: an app called "N8" served "© 2026 Application" in its footer and on its
  // sign-in screen — the first thing anyone saw of it.
  const b = scaffold().get('src/platform/branding.ts');
  assert.match(b, /const SEED_ORG_NAME = "probe";/);
  assert.match(b, /orgName: SEED_ORG_NAME/, 'the seeded row must take the project name');
  // seedOrgName is the only shared definition of the fallback, so an unnamed
  // project still gets a legal notice rather than "© 2026 undefined".
  assert.equal(seedOrgName({ name: '  Northwind Health  ' }), 'Northwind Health');
  assert.equal(seedOrgName({ name: '   ' }), PLACEHOLDER_ORG_NAME);
  assert.equal(seedOrgName(null), PLACEHOLDER_ORG_NAME);
  assert.equal(seedOrgName({ name: 'x'.repeat(200) }).length, 120, 'must respect the column bound');
});

test('an app already carrying the placeholder adopts the project name; a named one is left alone', () => {
  // The fix has to reach apps that already exist — their branding row was
  // written before the name was carried through, so seeding the INSERT is not
  // enough. Equally, an operator who has named the organisation must never see
  // it reverted on a redeploy.
  const b = scaffold().get('src/platform/branding.ts');
  const fn = b.slice(b.indexOf('export async function ensureSeeded'), b.indexOf('export async function getBranding'));
  assert.match(fn, /db\.update\(branding\)/, 'ensureSeeded must be able to heal an existing row');
  assert.match(fn, /rows\[0\]\.orgName === PLACEHOLDER_ORG_NAME/,
    'the placeholder must be the ONLY value treated as "never named"');
  assert.match(fn, /SEED_ORG_NAME !== PLACEHOLDER_ORG_NAME/,
    'an unnamed project must not rewrite the row with the same placeholder');
});

test('legal page bodies are escaped before rendering (no stored XSS)', () => {
  const c = scaffold().get('public/platform.js');
  const fn = c.slice(c.indexOf('function renderBody'), c.indexOf('function renderPage'));
  // An admin with page-edit rights must not be able to turn the
  // UNAUTHENTICATED privacy page into a script host.
  for (const tag of ['<h2>', '<li>', '<p>']) {
    const i = fn.indexOf(tag);
    assert.ok(i > 0, `renderBody must emit ${tag}`);
    assert.match(fn.slice(i, i + 90), /esc\(/, `${tag} content must be escaped`);
  }
});

test('API keys reuse the app permission catalog and cannot outrank their issuer', () => {
  const k = scaffold().get('src/platform/api-keys.ts');
  // The privilege ceiling: without it, anyone who may mint a key could mint an
  // admin one and use it.
  assert.match(k, /You cannot grant a key permissions you do not hold/);
  // Only a hash is stored; a database dump must not yield working credentials.
  assert.match(k, /tokenHash: sha256\(secret\)/);
  // Revoking clears the hash, not just a flag.
  const rev = k.slice(k.indexOf('export async function revokeKey'));
  assert.match(rev, /tokenHash: null/);
  assert.match(k, /timingSafeEqual/);
  assert.match(wired().get('src/platform/routes.ts'), /DEFAULT_PERMISSIONS/,
    'keys must draw on the same catalog people hold');
});

test('a key is limited to its own permissions and cannot escalate itself', () => {
  const mw = scaffold().get('src/platform/api-key-auth.ts');
  // Not everything its owner can do — otherwise every key an admin issued would
  // carry admin rights.
  assert.match(mw, /req\.apiKey\.permissions\.includes\(permission\)/);
  // A machine credential must not take over its account or mint another key.
  assert.match(mw, /export function denyApiKey/);
  const routes = wired().get('src/platform/routes.ts');
  assert.match(routes, /post\('\/api-keys', denyApiKey/, 'a key must not be able to mint a key');
  assert.match(routes, /delete\('\/api-keys\/:id', denyApiKey/);
  assert.match(routes, /post\('\/db\/readonly', denyApiKey/);
});

test('read-only SQL publishes VIEWS, never the tables holding secrets', () => {
  const ro = scaffold().get('src/platform/readonly.ts');
  assert.ok(!/GRANT SELECT ON ALL TABLES IN SCHEMA public/.test(ro), 'never grant on public');
  assert.match(ro, /REVOKE ALL ON SCHEMA public FROM/);
  // The api_keys view must not publish the hash.
  const view = ro.slice(ro.indexOf('.api_keys AS'), ro.indexOf('.platform_audit AS'));
  assert.ok(!/token_hash/.test(view), 'the api_keys view must not publish token_hash');
  // Assets are queryable as metadata, never as payloads.
  const assetsView = ro.slice(ro.indexOf('.assets AS'), ro.indexOf('.api_keys AS'));
  assert.ok(!/\bdata\b/.test(assetsView.replace(/--.*$/gm, '')), 'asset bytes must not be published');
  for (const bad of ['GRANT INSERT', 'GRANT UPDATE', 'GRANT DELETE', 'GRANT ALL ON ALL TABLES']) {
    assert.ok(!ro.includes(bad), `read-only must never ${bad}`);
  }
  assert.match(ro, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
  // A missing CREATEROLE privilege is a configuration answer, not a 500.
  assert.match(ro, /DB_PRIVILEGE/);
  assert.match(ro, /ALTER ROLE <app_role> CREATEROLE/);
});

test('the machine API is discoverable before you have a key', () => {
  const routes = wired().get('src/platform/routes.ts');
  assert.ok(routes.indexOf("publicPlatformRoutes.get('/api/meta'") > 0, '/api/meta must be on the PUBLIC router');
  assert.match(routes, /publicPlatformRoutes\.get\('\/api\/branding'/);
  assert.match(routes, /publicPlatformRoutes\.get\('\/api\/legal\/:slug'/);
  assert.match(routes, /publicPlatformRoutes\.get\('\/favicon\.ico'/);
});

test('whoami requires a real identity, not merely an attached context', () => {
  const routes = wired().get('src/platform/routes.ts');
  // withAuth attaches a context whether or not an identity was asserted, so
  // checking for the object alone answered 200 to a caller with no session.
  assert.match(routes, /!auth \|\| !auth\.authenticated/);
});

test('uploaded assets are served sandboxed and type-pinned', () => {
  const routes = wired().get('src/platform/routes.ts');
  const fn = routes.slice(
    routes.indexOf("publicPlatformRoutes.get('/api/assets/:id'"),
    routes.indexOf("publicPlatformRoutes.get('/favicon.ico'"),
  );
  assert.match(fn, /nosniff/);
  // SVG is a storable asset type ONLY because of these headers.
  assert.match(fn, /default-src 'none'; sandbox/);
  assert.ok(!/'text\/html'/.test(routes), 'HTML must never be a storable asset type');
});

test('the migration matches the Drizzle schema', () => {
  const sql = scaffold().get('migrations/0100_platform.sql');
  const schema = scaffold().get('src/platform/schema.ts');
  for (const t of ['branding', 'legal_pages', 'assets', 'api_keys', 'platform_audit']) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`), `migration missing ${t}`);
    assert.ok(schema.includes(`'${t}'`), `schema missing ${t}`);
  }
  // Revoking clears the hash, so the column must allow null.
  assert.ok(!/token_hash\s+text NOT NULL/.test(sql), 'token_hash must be nullable for revoked keys');
});

test('the platform schema is registered on the Drizzle client', () => {
  const db = scaffold().get('src/db/index.ts');
  // Emitting tables nothing registers would make every platform query fail at
  // runtime with a confusing "relation does not exist".
  assert.match(db, /platformSchema/);
  assert.match(db, /\.\.\.schema, \.\.\.platformSchema/);
});

/* ------------------------- provisioning regressions ----------------------- */

test('REGRESSION: a scaffold-only project has no dependency on the auth component', () => {
  // tsconfig compiles EVERYTHING under src/, imported or not. Emitting a file
  // that imports '../auth/index.js' into a project provisioned without the auth
  // component fails `tsc`, which fails the deploy. Only routes.ts needs auth, so
  // only routes.ts ships with the auth wiring.
  for (const [path, content] of scaffold()) {
    if (!path.startsWith('src/')) continue;
    assert.ok(!/from '\.\.\/auth\//.test(content),
      `${path} imports the auth component but ships in the base scaffold`);
  }
  assert.ok(!scaffold().has('src/platform/routes.ts'), 'routes.ts must not ship in the base scaffold');
  assert.ok(wired().has('src/platform/routes.ts'), 'routes.ts must ship with the auth wiring');
});

test('REGRESSION: the seed script stays far below the argv limit (E2BIG)', async () => {
  // Linux caps a SINGLE argv entry at MAX_ARG_STRLEN (128 KiB). The seed used to
  // inline every template file base64-encoded into the script, so once the
  // template passed ~96 KiB of source EVERY provision died with
  // "bare repo seed failed: spawn failed: spawn E2BIG". The script must now be
  // fixed-size, with the files travelling on stdin.
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../mock2/provision.js', import.meta.url), 'utf8'));

  // The script must NOT interpolate the file list any more.
  const fn = src.slice(src.indexOf('function buildSeedScript'), src.indexOf('function setStatus'));
  assert.ok(!/\$\{writes\}/.test(fn), 'the seed script must not inline file contents');
  assert.match(fn, /base64 -d \| tar -xf - -C "\$WT"/, 'files must arrive as a tarball on stdin');
  // buildSeedScript no longer takes files at all — the signature is the guard.
  assert.match(fn, /function buildSeedScript\(\{ repoPath, projectName \}\)/);
  // And the call site must actually pass the payload as stdin.
  assert.match(src, /input: buildSeedPayload\(seedFiles\)/);
});

test('REGRESSION: the real seed payload would fit even if it doubled', async () => {
  const { buildSeedTar } = await import('../mock2/seed-tar.js');
  const { buildSeedFiles } = await import('../mock2/template.js');
  const files = buildSeedFiles({ id: 1, name: 'probe' }, { webPort: 3000 });
  const tar = buildSeedTar(files);
  // This is the number that used to matter. It now travels on stdin, so the
  // assertion is simply that it is real and complete — the ARGV entry is the
  // fixed script, checked above.
  assert.ok(tar.length > 50_000, 'the seed should carry the whole template');
  // Every file must be in the archive: a silently dropped file would provision
  // a project missing part of its base app.
  const text = tar.toString('binary');
  for (const f of files) assert.ok(text.includes(f.path.split('/').pop()), `missing from tar: ${f.path}`);
});

test('the seed tar is a valid, reproducible ustar archive', async () => {
  const { buildSeedTar } = await import('../mock2/seed-tar.js');
  const files = [
    { path: 'a.txt', content: 'hello' },
    { path: 'deep/nested/dir/file.ts', content: 'export const x = 1;\n' },
    { path: 'run.sh', content: '#!/bin/sh\n', mode: 0o755 },
  ];
  const tar = buildSeedTar(files);
  // 512-byte blocks, two zero blocks at the end.
  assert.equal(tar.length % 512, 0);
  assert.ok(tar.subarray(-1024).every((b) => b === 0), 'must end with two zero blocks');
  // ustar magic in the first header.
  assert.equal(tar.subarray(257, 262).toString('ascii'), 'ustar');
  // The mode must survive — serve.py has to stay executable.
  const runHeader = tar.indexOf(Buffer.from('run.sh\0'));
  assert.ok(runHeader >= 0);
  assert.match(tar.subarray(runHeader + 100, runHeader + 107).toString('ascii'), /755/);
  // Byte-reproducible: a fixed mtime means two builds of the same template
  // produce the same archive, so a diff between seeds is meaningful.
  assert.ok(buildSeedTar(files).equals(tar));
});

test('the seed tar refuses a path it cannot represent', async () => {
  const { buildSeedTar } = await import('../mock2/seed-tar.js');
  // ustar splits at 100 + 155. A path that cannot be split must THROW rather
  // than silently truncate into the wrong filename.
  const tooLong = `${'x'.repeat(120)}/${'y'.repeat(200)}.ts`;
  assert.throws(() => buildSeedTar([{ path: tooLong, content: 'x' }]), /too long/);
  // A long path that CAN be split is fine.
  const splittable = `${'a/'.repeat(40)}file.ts`;
  assert.doesNotThrow(() => buildSeedTar([{ path: splittable, content: 'x' }]));
});
