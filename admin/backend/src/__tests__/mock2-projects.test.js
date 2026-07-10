// Mock2 Phase M2 tests — slug minting/reservation, project role/access
// resolution, derived status, response shape, rotation-grace active-FQDN
// computation, the project template builders, and the Caddy upstream block.
//
// Stub-first (risk R9 / docs/known-issues.md): imports ONLY the pure decision
// modules (slug.js, project-logic.js, template.js) and the pure Caddy string
// builders (caddy.js). None pulls in better-sqlite3, Express, Incus, or DNS, so
// the suite never worsens the fresh-checkout native-module gap. The DB access
// (projects.js), the provisioning job (provision.js), and the real Incus/git
// paths are covered by the manual M2 verification checklist, not here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mintSlugCandidate,
  isReservedSlug,
  isValidSlugShape,
  slugifyName,
  slugFqdn,
} from '../mock2/slug.js';
import {
  roleSatisfies,
  resolveMock2Access,
  mock2TerminalDecision,
  deriveProjectStatus,
  publicProjectShape,
  projectActiveFqdns,
} from '../mock2/project-logic.js';
import {
  defaultManifest,
  parseManifestWebPort,
  buildSeedFiles,
  buildContainerSetupScript,
  DEFAULT_WEB_PORT,
} from '../mock2/template.js';
import {
  buildMock2SiteBlock,
  buildMock2DomainConfig,
  normalizeUpstream,
} from '../mock2/caddy.js';

// ---- slug minting + reservation ----

test('mintSlugCandidate: p- + 8 lowercase hex, deterministic on injected hex', () => {
  assert.equal(mintSlugCandidate('7f3a9c2e'), 'p-7f3a9c2e');
  assert.equal(mintSlugCandidate('7F3A9C2EFFFF'), 'p-7f3a9c2e'); // truncates + lowercases
  assert.ok(isValidSlugShape(mintSlugCandidate('deadbeef')));
});

test('mintSlugCandidate: pads short randomness so the shape invariant always holds', () => {
  const slug = mintSlugCandidate('ab');
  assert.equal(slug, 'p-ab000000');
  assert.ok(isValidSlugShape(slug));
});

test('isValidSlugShape: any DNS-safe label (name-derived or legacy p-hex)', () => {
  assert.ok(isValidSlugShape('p-0123abcd'));   // legacy mint
  assert.ok(isValidSlugShape('my-app'));       // name-derived
  assert.ok(isValidSlugShape('app2'));
  assert.ok(isValidSlugShape('a'));
  assert.equal(isValidSlugShape('-app'), false);   // leading hyphen
  assert.equal(isValidSlugShape('app-'), false);   // trailing hyphen
  assert.equal(isValidSlugShape('My-App'), false); // uppercase
  assert.equal(isValidSlugShape('a.b'), false);    // dot is not a label char
  assert.equal(isValidSlugShape(''), false);
});

test('slugifyName: derives a DNS-safe label from a project name', () => {
  assert.equal(slugifyName('My App'), 'my-app');
  assert.equal(slugifyName('  Hello, World!  '), 'hello-world');
  assert.equal(slugifyName('Café Ölü'), 'cafe-olu');       // accent-folded
  assert.equal(slugifyName('a___b--c'), 'a-b-c');           // runs collapse
  assert.equal(slugifyName('---trim---'), 'trim');
  assert.equal(slugifyName('😀 emoji only 🎉'), 'emoji-only');
  assert.equal(slugifyName('🎉🎉🎉'), '');                    // nothing usable
  assert.equal(slugifyName(''), '');
  // Length-capped to a safe label, with no trailing hyphen left by the cut.
  const long = slugifyName('x'.repeat(80));
  assert.ok(long.length <= 50 && isValidSlugShape(long));
});

test('slugifyName output is a valid, non-reserved label for ordinary names', () => {
  for (const name of ['My App', 'Dashboard', 'client portal 2']) {
    const s = slugifyName(name);
    assert.ok(isValidSlugShape(s), `${name} → ${s} should be a valid label`);
    assert.equal(isReservedSlug(s), false);
  }
  // A name that slugifies to a reserved label is caught by isReservedSlug.
  assert.ok(isReservedSlug(slugifyName('API')));
});

test('isReservedSlug: blocks the _mock2 namespace and reserved labels', () => {
  assert.ok(isReservedSlug('_mock2-verify-abcdef'));  // M1 canary namespace
  assert.ok(isReservedSlug('_mock2'));
  assert.ok(isReservedSlug('www'));
  assert.ok(isReservedSlug('api'));
  assert.equal(isReservedSlug('p-7f3a9c2e'), false);
});

test('mintSlugCandidate never yields a reserved slug (p- prefix cannot collide)', () => {
  // Exhaustive-ish: minted slugs always start with p-, never _mock2/www/etc.
  for (const hex of ['00000000', 'ffffffff', 'abadcafe', 'deadbeef']) {
    const slug = mintSlugCandidate(hex);
    assert.ok(slug && !isReservedSlug(slug), `${slug} must not be reserved`);
  }
});

test('slugFqdn: joins slug under the parent domain', () => {
  assert.equal(slugFqdn('p-7f3a9c2e', 'dev.example.com'), 'p-7f3a9c2e.dev.example.com');
});

// ---- role / access resolution (ADR-007) ----

test('roleSatisfies: editor implies viewer; viewer does not imply editor', () => {
  assert.ok(roleSatisfies('editor', 'editor'));
  assert.ok(roleSatisfies('editor', 'viewer'));
  assert.ok(roleSatisfies('viewer', 'viewer'));
  assert.equal(roleSatisfies('viewer', 'editor'), false);
});

test('resolveMock2Access: admin bypass stamps acting_as_admin only when not a member', () => {
  const admin = { id: 1, role: 'admin' };
  const asBypass = resolveMock2Access({ user: admin, membership: null, requiredRole: 'editor' });
  assert.equal(asBypass.allowed, true);
  assert.equal(asBypass.actingAsAdmin, true);

  const asMember = resolveMock2Access({ user: admin, membership: { role: 'editor' }, requiredRole: 'editor' });
  assert.equal(asMember.allowed, true);
  assert.equal(asMember.actingAsAdmin, false);
});

test('resolveMock2Access: superadmin (non-admin role) still bypasses', () => {
  const su = { id: 9, role: 'user' };
  const r = resolveMock2Access({ user: su, membership: null, requiredRole: 'editor', isSuperadmin: true });
  assert.equal(r.allowed, true);
  assert.equal(r.actingAsAdmin, true);
});

test('resolveMock2Access: member editor may edit; viewer may not; non-member denied', () => {
  const u = { id: 2, role: 'user' };
  assert.equal(resolveMock2Access({ user: u, membership: { role: 'editor' }, requiredRole: 'editor' }).allowed, true);
  const viewerEdit = resolveMock2Access({ user: u, membership: { role: 'viewer' }, requiredRole: 'editor' });
  assert.equal(viewerEdit.allowed, false);
  assert.match(viewerEdit.reason, /requires editor/);
  const nonMember = resolveMock2Access({ user: u, membership: null, requiredRole: 'viewer' });
  assert.equal(nonMember.allowed, false);
  assert.equal(nonMember.reason, 'not a project member');
});

// ---- derived status (single source of truth) ----

test('deriveProjectStatus: lifecycle terminal states win', () => {
  assert.equal(deriveProjectStatus({ lifecycle: 'provisioning' }), 'provisioning');
  assert.equal(deriveProjectStatus({ lifecycle: 'failed_provisioning' }), 'failed');
  assert.equal(deriveProjectStatus({ lifecycle: 'archived' }), 'archived');
});

test('deriveProjectStatus: zero editors ⇒ orphaned on a live project', () => {
  assert.equal(deriveProjectStatus({ lifecycle: 'active' }, { editorCount: 0 }), 'orphaned');
  assert.equal(deriveProjectStatus({ lifecycle: 'active' }, { editorCount: 1 }), 'online');
});

test('deriveProjectStatus: container liveness refines an active project', () => {
  assert.equal(deriveProjectStatus({ lifecycle: 'active' }, { editorCount: 1, containerState: 'running' }), 'online');
  assert.equal(deriveProjectStatus({ lifecycle: 'active' }, { editorCount: 1, containerState: 'stopped' }), 'idle');
  assert.equal(deriveProjectStatus({ lifecycle: 'stopped' }, { editorCount: 1 }), 'stopped');
});

// ---- response shape ----

test('publicProjectShape: builds the https URL and hides admin debug from non-admins', () => {
  const project = {
    id: 5, name: 'Demo', lifecycle: 'active', slug: 'p-7f3a9c2e',
    parent_domain_id: 1, container_ip: '10.0.5.20', web_port: 3000, repo_path: '/var/x.git', flagged: 0,
  };
  const asUser = publicProjectShape(project, { parentDomain: 'dev.example.com', editorCount: 1, isAdmin: false });
  assert.equal(asUser.url, 'https://p-7f3a9c2e.dev.example.com');
  assert.equal(asUser.status, 'online');
  assert.equal(asUser.bridge_ip, undefined);      // admin-only
  assert.equal(asUser.upstream, undefined);
  assert.equal(asUser.repo_path, undefined);

  const asAdmin = publicProjectShape(project, { parentDomain: 'dev.example.com', editorCount: 1, isAdmin: true });
  assert.equal(asAdmin.bridge_ip, '10.0.5.20');
  assert.equal(asAdmin.upstream, '10.0.5.20:3000'); // bridge address, never a host port
});

test('publicProjectShape: custom domain wins over slug for the URL', () => {
  const shaped = publicProjectShape(
    { id: 6, name: 'C', lifecycle: 'active', slug: 'p-aaaabbbb', custom_domain: 'app.customer.com', flagged: 0 },
    { parentDomain: 'dev.example.com', editorCount: 1 },
  );
  assert.equal(shaped.url, 'https://app.customer.com');
});

// ---- rotation-grace active-FQDN computation ----

const NOW = '2026-07-09T12:00:00.000Z';
const future = '2026-07-09T12:30:00.000Z'; // inside a 1h grace window
const past = '2026-07-09T11:00:00.000Z';   // grace already lapsed

function liveProject(extra = {}) {
  return {
    id: 7, lifecycle: 'active', slug: 'p-newnewww', parent_domain: 'dev.example.com',
    container_ip: '10.0.7.30', web_port: 3000, ...extra,
  };
}

test('projectActiveFqdns: current slug routes to the container upstream', () => {
  const fqdns = projectActiveFqdns(liveProject(), [], NOW);
  assert.equal(fqdns.length, 1);
  assert.equal(fqdns[0].fqdn, 'p-newnewww.dev.example.com');
  assert.equal(fqdns[0].upstream, '10.0.7.30:3000');
});

test('projectActiveFqdns: a grace-window old slug coexists; a lapsed one does not', () => {
  const grace = [{ slug: 'p-oldoldxx', active_until: future }, { slug: 'p-deadxxxx', active_until: past }];
  const fqdns = projectActiveFqdns(liveProject(), grace, NOW).map((f) => f.fqdn);
  assert.ok(fqdns.includes('p-newnewww.dev.example.com'));
  assert.ok(fqdns.includes('p-oldoldxx.dev.example.com'));   // still in grace
  assert.ok(!fqdns.includes('p-deadxxxx.dev.example.com'));  // 404s after grace
});

test('projectActiveFqdns: no upstream (not yet provisioned) publishes nothing', () => {
  assert.deepEqual(projectActiveFqdns(liveProject({ container_ip: null }), [], NOW), []);
});

test('projectActiveFqdns: archived / failed projects publish nothing', () => {
  assert.deepEqual(projectActiveFqdns(liveProject({ lifecycle: 'archived' }), [], NOW), []);
  assert.deepEqual(projectActiveFqdns(liveProject({ lifecycle: 'failed_provisioning' }), [], NOW), []);
});

test('projectActiveFqdns: custom domain gets its own block on the same upstream', () => {
  const fqdns = projectActiveFqdns(liveProject({ custom_domain: 'app.customer.com' }), [], NOW);
  const hosts = fqdns.map((f) => f.fqdn);
  assert.ok(hosts.includes('app.customer.com'));
  assert.ok(hosts.includes('p-newnewww.dev.example.com'));
  for (const f of fqdns) assert.equal(f.upstream, '10.0.7.30:3000');
});

// ---- project template ----

test('manifest: default declares the web port and round-trips through the parser (ADR-005)', () => {
  const yaml = defaultManifest({ webPort: 3000 });
  assert.equal(parseManifestWebPort(yaml), 3000);
  assert.equal(parseManifestWebPort(defaultManifest({ webPort: 8080 })), 8080);
  assert.equal(parseManifestWebPort('nonsense'), null);
  assert.equal(parseManifestWebPort('web: 99999999'), null); // out of range
});

test('buildSeedFiles: ships the manifest, placeholder app, executable dev server, and secrets manifest', () => {
  const files = buildSeedFiles({ name: 'Demo' }, { webPort: DEFAULT_WEB_PORT });
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.ok(byPath['mock2.yaml']);
  assert.ok(byPath['public/index.html'].content.includes('Demo'));
  assert.equal(byPath['serve.py'].mode, 0o755);
  assert.ok(byPath['.env.example'].content.includes('DATABASE_URL')); // in-container Postgres (ADR-008)
  assert.ok(byPath['.gitignore'].content.includes('.env'));
  assert.ok(byPath['state/rules.md']);                                 // state/ path exists for M8
});

test('buildContainerSetupScript: writes a systemd unit and honors the declared port', () => {
  const script = buildContainerSetupScript({ appDir: '/srv/app', webPort: 4321 });
  assert.match(script, /mock2-dev\.service/);
  assert.match(script, /Environment=PORT=4321/);
  assert.match(script, /postgresql/);       // ADR-008 install (best-effort)
  assert.match(script, /python3 \/srv\/app\/serve\.py/);
});

// ---- Caddy upstream block ----

test('normalizeUpstream: accepts ip:port in range, rejects junk and host ports out of range', () => {
  assert.equal(normalizeUpstream('10.0.5.20:3000'), '10.0.5.20:3000');
  assert.equal(normalizeUpstream('10.0.5.20:70000'), null); // > 65535
  assert.equal(normalizeUpstream('10.0.5.20'), null);        // no port
  assert.equal(normalizeUpstream(''), null);
  assert.equal(normalizeUpstream(null), null);
});

test('buildMock2SiteBlock: with an upstream emits reverse_proxy, keeping the dev headers', () => {
  const block = buildMock2SiteBlock({ fqdn: 'p-7f3a9c2e.dev.example.com', upstream: '10.0.5.20:3000' });
  assert.match(block, /reverse_proxy 10\.0\.5\.20:3000/);
  assert.match(block, /X-Robots-Tag "noindex/);          // dev headers intact
  assert.match(block, /handle \/robots\.txt/);            // robots deny intact
  assert.match(block, /# forward_auth 127\.0\.0\.1:3001/); // disabled hook intact
  assert.ok(!/respond "<!doctype/.test(block));           // no placeholder when live
});

test('buildMock2SiteBlock: without an upstream keeps the placeholder handler', () => {
  const block = buildMock2SiteBlock({ fqdn: '_mock2-verify-abc.dev.example.com' });
  assert.match(block, /Placeholder handler/);
  assert.match(block, /respond "<!doctype/);
  assert.ok(!/reverse_proxy \d/.test(block)); // no actual reverse_proxy directive
});

test('buildMock2DomainConfig: passes each entry upstream through to its block', () => {
  const cfg = buildMock2DomainConfig({
    domain: 'dev.example.com',
    fqdns: [
      { fqdn: 'p-aaaaaaaa.dev.example.com', upstream: '10.0.1.2:3000' },
      { fqdn: 'p-bbbbbbbb.dev.example.com', upstream: '10.0.1.3:8080' },
    ],
  });
  assert.match(cfg, /reverse_proxy 10\.0\.1\.2:3000/);
  assert.match(cfg, /reverse_proxy 10\.0\.1\.3:8080/);
});

// ---- mock2TerminalDecision (shell-terminal upgrade verdict) ----

const activeProject = { id: 5, lifecycle: 'active' };

test('mock2TerminalDecision: editor member on an online project is allowed', () => {
  const access = resolveMock2Access({ user: { id: 'u1', role: 'user' }, membership: { role: 'editor' }, requiredRole: 'editor' });
  const d = mock2TerminalDecision({ project: activeProject, access });
  assert.equal(d.ok, true);
  assert.equal(d.status, 200);
  assert.equal(d.actingAsAdmin, false);
});

test('mock2TerminalDecision: admin bypass is allowed and stamped acting_as_admin', () => {
  const access = resolveMock2Access({ user: { id: 'a1', role: 'admin' }, membership: null, requiredRole: 'editor' });
  const d = mock2TerminalDecision({ project: activeProject, access });
  assert.equal(d.ok, true);
  assert.equal(d.actingAsAdmin, true);
});

test('mock2TerminalDecision: a viewer is refused (a shell is a mutate capability)', () => {
  const access = resolveMock2Access({ user: { id: 'u2', role: 'user' }, membership: { role: 'viewer' }, requiredRole: 'editor' });
  const d = mock2TerminalDecision({ project: activeProject, access });
  assert.equal(d.ok, false);
  assert.equal(d.status, 403);
});

test('mock2TerminalDecision: a non-member gets 404, never a 403 that confirms existence', () => {
  const access = resolveMock2Access({ user: { id: 'u3', role: 'user' }, membership: null, requiredRole: 'editor' });
  const d = mock2TerminalDecision({ project: activeProject, access });
  assert.equal(d.ok, false);
  assert.equal(d.status, 404);
});

test('mock2TerminalDecision: a missing project is 404', () => {
  const d = mock2TerminalDecision({ project: null, access: null });
  assert.equal(d.ok, false);
  assert.equal(d.status, 404);
});

test('mock2TerminalDecision: an allowed member on an offline project is 409', () => {
  const access = resolveMock2Access({ user: { id: 'u4', role: 'user' }, membership: { role: 'editor' }, requiredRole: 'editor' });
  const d = mock2TerminalDecision({ project: { id: 6, lifecycle: 'stopped' }, access });
  assert.equal(d.ok, false);
  assert.equal(d.status, 409);
});
