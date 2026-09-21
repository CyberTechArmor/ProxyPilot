// The 2026-09 immediate repairs (passkey assurance, bounded elevation,
// MCP owner validity, minted secrets + production mode) — the machine checks
// that keep each one from regressing.
//
// Stub-first (docs/known-issues.md): routes/auth.js, lib/webauthn.js,
// routes/mcp.js and the mcp-tools import native or absent packages, so the
// policy is asserted two ways — the pure modules are exercised directly, and
// the wiring in the route files is checked as SOURCE TEXT (the same ratchet
// self-update-runner.test.js applies to the systemd units).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  PASSKEY_USER_VERIFICATION, PASSKEY_RESIDENT_KEY, PASSKEY_REQUIRE_UV,
  USER_VERIFICATION_REASON, USER_VERIFICATION_ERROR,
  passkeyAuthenticatorSelection, classifyWebAuthnFailure,
} from '../lib/passkey-policy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

// ---- passkey policy (pure) ----

test('passkey policy: user verification is required and verified server-side', () => {
  assert.equal(PASSKEY_USER_VERIFICATION, 'required');
  assert.equal(PASSKEY_REQUIRE_UV, true);
  // Discoverability is not an assurance property — stays preferred.
  assert.equal(PASSKEY_RESIDENT_KEY, 'preferred');
  assert.deepEqual(passkeyAuthenticatorSelection(), { residentKey: 'preferred', userVerification: 'required' });
});

test('passkey policy: the UV refusal is recognised by its wording, everything else is not', () => {
  assert.equal(classifyWebAuthnFailure('User verification required, but user could not be verified'), USER_VERIFICATION_REASON);
  assert.equal(classifyWebAuthnFailure('user verification was not performed'), USER_VERIFICATION_REASON);
  assert.equal(classifyWebAuthnFailure('Unexpected authentication response challenge'), null);
  assert.equal(classifyWebAuthnFailure(''), null);
  assert.equal(classifyWebAuthnFailure(undefined), null);
  assert.match(USER_VERIFICATION_ERROR, /PIN or biometric/);
});

// ---- wiring ratchets: the route files carry the policy, not a local literal ----

test('ratchet: no passkey ceremony asks for or accepts "preferred" user verification', () => {
  const auth = src('routes/auth.js');
  const webauthn = src('lib/webauthn.js');
  assert.doesNotMatch(auth, /userVerification:\s*'preferred'/, 'auth router still requests preferred UV');
  assert.doesNotMatch(auth, /requireUserVerification:\s*false/, 'registration verify still accepts unverified attestations');
  assert.doesNotMatch(webauthn, /requireUserVerification:\s*false/, 'assertion verify still accepts unverified assertions');
  // Both verify calls take the policy constant; both begin calls request it.
  assert.match(auth, /requireUserVerification:\s*PASSKEY_REQUIRE_UV/);
  assert.match(webauthn, /requireUserVerification:\s*PASSKEY_REQUIRE_UV/);
  assert.equal((auth.match(/userVerification:\s*PASSKEY_USER_VERIFICATION/g) || []).length, 2, 'sudo begin + login begin');
  assert.match(auth, /authenticatorSelection:\s*passkeyAuthenticatorSelection\(\)/);
});

test('ratchet: passwordless passkey login mints a session and nothing else (no sudo grant)', () => {
  const auth = src('routes/auth.js');
  const start = auth.indexOf("authRouter.post('/passkey/authenticate/verify'");
  assert.ok(start > 0, 'login verify handler present');
  const end = auth.indexOf('authRouter.', start + 10);
  const handler = auth.slice(start, end > 0 ? end : undefined);
  assert.doesNotMatch(handler, /UPDATE sessions SET sudo_until/, 'login still opens the sudo window');
  assert.doesNotMatch(handler, /SUDO_GRANT_HOURS/);
  assert.match(handler, /sudoUntil:\s*null/, 'response shape kept, value null');
  // The explicit re-proof paths still grant — that is where elevation lives.
  const sudo = auth.slice(auth.indexOf("authRouter.post('/sudo/passkey/verify'"), start);
  assert.match(sudo, /UPDATE sessions SET sudo_until/);
});

test('ratchet: migration 605 closes every open sudo window once', () => {
  const db = src('db.js');
  assert.match(db, /runMigration\(db, 605, 'sessions_sudo_reset'/);
  assert.match(db, /UPDATE sessions SET sudo_until = NULL WHERE sudo_until IS NOT NULL/);
});

// ---- MCP owner validity wiring ----

test('ratchet: MCP token lookup consults the owner on every call and audits the refusal', () => {
  const mcp = src('routes/mcp.js');
  const fn = mcp.slice(mcp.indexOf('function findToken('), mcp.indexOf('// ---- upload tickets'));
  assert.match(fn, /SELECT id, role FROM users WHERE id = \?/);
  assert.match(fn, /mcpTokenRefusal\(\{ expiresAt: row\.expires_at, ownerId: row\.created_by, owner \}\)/);
  assert.match(fn, /if \(refusal\) \{ noteOwnerRefusal\(row, refusal\); return null; \}/);
  assert.match(mcp, /'MCP_TOKEN_OWNER_REFUSED'/);
});

test('ratchet: disabling or deleting a user revokes the MCP keys it minted', () => {
  const admin = src('routes/mcp-tools/admin.js');
  const user = src('routes/user.js');
  const db = src('db.js');
  assert.match(admin, /UPDATE mcp_tokens SET revoked_at = \? WHERE created_by = \? AND revoked_at IS NULL/);
  assert.match(user, /function revokeUserAccess\(db, userId, \{ sessions: revokeSessions = true \} = \{\}\)/);
  assert.match(user, /UPDATE mcp_tokens SET revoked_at = \? WHERE created_by = \? AND revoked_at IS NULL/);
  assert.match(user, /UPDATE sessions SET revoked_at = \? WHERE user_id = \? AND revoked_at IS NULL/);
  // The dashboard's "disable" (role → pending) and delete both call it.
  assert.match(user, /if \(role === 'pending' && user\.role !== 'pending'\) \{\s*revoked = revokeUserAccess\(db, id\);/);
  assert.match(user, /const revoked = revokeUserAccess\(db, id\);\s*const deleteUserTx/);
  // Ownerless keys are refused at mint time; historical orphans are revoked.
  assert.match(admin, /if \(!ownerId\) \{ note\.refused = true;/);
  assert.match(db, /runMigration\(db, 913, 'mcp_tokens_owner_validity'/);
  assert.match(db, /created_by NOT IN \(SELECT id FROM users\)/);
  assert.match(db, /created_by IN \(SELECT id FROM users WHERE role = 'pending'\)/);
  // Expiry column (914) and the per-call rule that reads it.
  assert.match(db, /runMigration\(db, 914, 'mcp_tokens_expiry'/);
  assert.match(db, /ALTER TABLE mcp_tokens ADD COLUMN expires_at TEXT/);
  const mcp = src('routes/mcp.js');
  assert.match(mcp, /mcpTokenRefusal\(\{ expiresAt: row\.expires_at, ownerId: row\.created_by, owner \}\)/);
  // Demotion (admin → user) revokes keys in both the dashboard and the tool.
  assert.match(user, /\} else if \(isDemotion\) \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*revoked = revokeUserAccess\(db, id, \{ sessions: false \}\);/);
  assert.match(admin, /if \(demotion \|\| role === 'pending'\) \{/);
});

test('ratchet: a database that ran the branch\'s old migration 912 still gets lxc_exports', () => {
  const db = src('db.js');
  const guard = db.slice(db.indexOf('const stray = db.prepare(`SELECT name FROM schema_migrations WHERE version = 912`)'), db.indexOf("runMigration(db, 912, 'lxc_exports'"));
  assert.ok(guard.length > 0, 'guard sits before the 912 migration');
  assert.match(guard, /stray\.name === 'mcp_tokens_owner_validity'/);
  assert.match(guard, /UPDATE schema_migrations SET version = 913 WHERE version = 912/);
  // The row is deleted only when 913 already records the same migration.
  assert.match(guard, /has913\.name === 'mcp_tokens_owner_validity'/);
});

// ---- minted secrets + production mode wiring ----

test('ratchet: the deploy mints owned secrets and refuses to start without production mode', () => {
  const deploy = src('mock2/deploy.js');
  assert.match(deploy, /ensureComponentSecrets\(\{ containerName, rows \}\)/);
  assert.match(deploy, /validateDeployEnvironment\(\{ unitText: unit, environmentText: envRead\.stdout \|\| '', requiredKeys: requiredSecretKeys \}\)/);
  // A deferred key (marker missing on disk) is neither minted nor required.
  assert.match(deploy, /requiredSecretKeys = secrets\.required;/);
  const install = src('mock2/component-install.js');
  assert.match(install, /MARKER MISSING/);
  assert.match(install, /eligible = configs\.filter\(\(c\) => !missing\.has\(c\.key\)\);/);
  assert.match(install, /export function deferredSecretsMessage/);
  const mintIdx = deploy.indexOf('ensureComponentSecrets(');
  const validateIdx = deploy.indexOf('validateDeployEnvironment(');
  const swapIdx = deploy.indexOf('const swap = await containerSh(');
  assert.ok(mintIdx < validateIdx && validateIdx < swapIdx, 'mint, then validate, then write the unit');
});

test('ratchet: the seed auth component refuses its dev defaults in production and marks its secrets as minted', () => {
  const doc = JSON.parse(src('mock2/framework-seed/proxypilot-auth.component.json'));
  const cfg = doc.contract.config;
  for (const key of ['AUTH_JWT_SECRET', 'AUTH_MASTER_SECRET']) {
    const entry = cfg.find((c) => c.key === key);
    assert.ok(entry, `${key} declared`);
    assert.equal(entry.secret, true);
    assert.equal(entry.required, true);
    assert.equal(entry.generate, true, `${key} is minted by the platform`);
  }
  const config = doc.files.find((f) => f.path === 'src/auth/config.ts').content;
  assert.match(config, /export function refuseInsecureProductionSecrets\(cfg: AuthConfig\): AuthConfig/);
  assert.match(config, /if \(cfg\.NODE_ENV !== 'production'\) return cfg;/);
  assert.match(config, /cfg\.AUTH_JWT_SECRET === DEV_JWT_SECRET \|\| cfg\.AUTH_JWT_SECRET\.length < MIN_SECRET_LENGTH/);
  assert.match(config, /cfg\.AUTH_MASTER_SECRET === DEV_MASTER_SECRET \|\| cfg\.AUTH_MASTER_SECRET\.length < MIN_SECRET_LENGTH/);
  // Both loaders pass through the refusal.
  assert.match(config, /return refuseInsecureProductionSecrets\(AuthConfigSchema\.parse\(input\)\);/);
  assert.match(config, /return refuseInsecureProductionSecrets\(AuthConfigSchema\.parse\(\{/);
  // The third-party credential is NOT minted: only the two the app owns.
  assert.equal(cfg.filter((c) => c.generate === true).length, 2);
  // The master secret is minted only into code that can migrate what it replaces.
  const master = cfg.find((c) => c.key === 'AUTH_MASTER_SECRET');
  assert.deepEqual(master.requires_marker, { path: 'src/auth/crypto.ts', contains: 'decryptSecretAny' });
  assert.equal(cfg.find((c) => c.key === 'AUTH_JWT_SECRET').requires_marker, undefined);
});

test('ratchet: the seed auth component rekeys an LDAPS secret stored under the dev master secret', () => {
  // Minting a real AUTH_MASTER_SECRET into an app that had already encrypted an
  // LDAPS bind password under the dev default would strand that ciphertext.
  // The component opens it with the legacy key and re-encrypts in place.
  const doc = JSON.parse(src('mock2/framework-seed/proxypilot-auth.component.json'));
  const file = (p) => doc.files.find((f) => f.path === p).content;
  const crypto = file('src/auth/crypto.ts');
  assert.match(crypto, /export function decryptSecretAny\(/);
  assert.match(crypto, /rekeyed: true/);
  const ldaps = file('src/auth/ldaps-service.ts');
  assert.match(ldaps, /import \{ legacyMasterSecrets \} from '\.\/config\.js';/);
  assert.match(ldaps, /export async function openLdapsSecret\(/);
  assert.match(ldaps, /legacyMasterSecrets\(config\)/);
  assert.doesNotMatch(ldaps, /decryptSecret\(conn\.secretCiphertext/, 'a bare decrypt would strand legacy ciphertext');
  // The rekey is a compare-and-swap on the ciphertext that was read, never the
  // settings upsert (which resets label and status), and it is reported.
  assert.match(ldaps, /rekeyLdapsConnection\(\{\s*tenantId,\s*expectedCiphertext: conn\.secretCiphertext,/);
  assert.doesNotMatch(ldaps.slice(ldaps.indexOf('export async function openLdapsSecret'), ldaps.indexOf('async function readStoredSecret')), /upsertLdapsConnection/);
  assert.match(ldaps, /masterKey: keyStatus,/);
  const repo = file('src/auth/repo.ts');
  assert.match(repo, /export async function rekeyLdapsConnection\(/);
  assert.match(repo, /eq\(authConnections\.secretCiphertext, input\.expectedCiphertext\)/);
  // The bridge is bounded: the legacy list is configuration, defaulting to
  // the dev default and emptied once nothing is left to migrate.
  const config = file('src/auth/config.ts');
  assert.match(config, /AUTH_LEGACY_MASTER_SECRETS: z\.string\(\)\.default\(DEV_MASTER_SECRET\)/);
  assert.match(config, /export function legacyMasterSecrets\(cfg: AuthConfig\): string\[\]/);
  const service = file('src/auth/service.ts');
  assert.match(service, /const \{ secret \} = await openLdapsSecret\(conn\);/);
  assert.doesNotMatch(service, /decryptSecret\(conn\.secretCiphertext/);
});
