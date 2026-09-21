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

test('ratchet: the migration-history repair runs before 912 and comes from the tested pure module', () => {
  const db = src('db.js');
  assert.match(db, /import \{ repairStrayMigration912 \} from '\.\/lib\/migration-repair\.js';/);
  const at = db.indexOf('repairStrayMigration912(db, { log:');
  assert.ok(at > 0 && at < db.indexOf("runMigration(db, 912, 'lxc_exports'"), 'repair sits before the 912 migration');
});

// ---- minted secrets + production mode wiring ----

test('ratchet: the deploy mints owned secrets and refuses to start without production mode', () => {
  const deploy = src('mock2/deploy.js');
  assert.match(deploy, /validateDeployEnvironment\(\{ unitText: unit, environmentText: envRead\.stdout \|\| '', requiredKeys: requiredSecretKeys \}\)/);
  // A deferred key (marker missing on disk) is neither minted nor required.
  assert.match(deploy, /requiredSecretKeys = secrets\.required;/);
  const install = src('mock2/component-install.js');
  assert.match(install, /MARKER MISSING/);
  assert.match(install, /verdict\.get\(c\.key\)/);
  assert.match(install, /export function deferredSecretsMessage/);
  // The built artifact must exist and carry the marker (NOBUILD / STALE below).
  // A first install writes the contract's fresh values (an empty legacy list);
  // a reinstall (anything kept) does not.
  assert.match(install, /installed\.filter\(\(i\) => i\.counts && i\.counts\.kept === 0\)\.map\(\(i\) => i\.contract\)/);
  assert.match(install, /export async function ensureFreshEnvValues/);
  // A declared built artifact must EXIST and carry the marker; missing or
  // stale builds defer with their own reasons.
  assert.match(install, /MARKER NOBUILD/);
  assert.match(install, /MARKER STALE/);
  // The data guard: rows are read from the app's database and classified
  // before a protecting key is minted; fresh_value waits for fresh storage.
  assert.match(install, /probe, envHasKey: false, newlyProvisioned, writersStopped,/);
  assert.match(install, /if \(freshStorage !== true\) return \{ ok: true, written: \[\], skipped: 'storage not confirmed fresh' \};/);
  assert.match(install, /const storage = await storageIsFresh\(\{ containerName, contracts: freshContracts, newlyProvisioned \}\);/);
  assert.match(install, /if \(newlyProvisioned !== true\) return \{ fresh: false,/);
  // Only the provision path may say "newly provisioned", and only for a
  // container created from the template with no restored, copied or
  // rehydrated data.
  const provision = src('mock2/provision.js');
  assert.match(provision, /newlyProvisioned: dataOrigin === 'new'/);
  assert.match(provision, /dataOrigin: copyDatabase \? 'restored' : 'new'/);
  assert.match(provision, /mode: 'rehydrate', dataOrigin: 'rehydrate'/);
  assert.match(provision, /preinstallComponents\(\{ project, initiatedBy: project\?\.created_by \?\? null, newlyProvisioned: newlyProvisioned === true \}\)/);
  for (const other of ['mock2/audit.js', 'mock2/routes.js', '../src/routes/mcp-tools/project-config.js'.replace('../src/', '')]) {
    assert.doesNotMatch(src(other), /newlyProvisioned/, `${other} must not claim a fresh provision`);
  }
  // The deferral stays visible: three readiness warnings on every deploy.
  const readiness = src('mock2/readiness-logic.js');
  assert.match(readiness, /MASTERKEY:200/); assert.match(readiness, /LEGACYBRIDGE:200/);
  assert.match(readiness, /export function masterKeyRowsCode/);
  assert.match(readiness, /MASTERKEY_CHECKS\.some\(\(m\) => m\.key === c\.key\) && noAuth\) continue;/);
  // The rows check is computed on the platform side with the tested cipher.
  const runner = src('mock2/readiness.js');
  assert.match(runner, /MASTERKEY_ROWS:\$\{masterKeyRowsCode\(\{ probe, envKey, legacyDefault: guard\.legacy_default \}\)\}/);
  const stopIdx = deploy.indexOf('systemctl stop mock2-dev.service');
  const mintIdx = deploy.indexOf('ensureComponentSecrets(');
  const validateIdx = deploy.indexOf('validateDeployEnvironment(');
  const swapIdx = deploy.indexOf('const swap = await containerSh(');
  assert.ok(stopIdx > 0 && stopIdx < mintIdx && mintIdx < validateIdx && validateIdx < swapIdx, 'stop the app, then mint, then validate, then write and start the unit');
  // The final probe and mint happen with writers stopped; every failure after
  // the stop — stop itself, mint, and validation after key persistence —
  // starts the unit again before returning.
  assert.match(deploy, /ensureComponentSecrets\(\{ containerName, rows, writersStopped: true \}\)/);
  assert.match(deploy, /const restartUnit = async \(\) => \{[\s\S]{0,400}`systemctl daemon-reload[^`]*systemctl start mock2-dev\.service[^`]*\$\{servingProbeScript\(webPort, 10\)\}`/);
  assert.equal((deploy.match(/const back = await restartUnit\(\);/g) || []).length, 5, 'stop failure, mint failure, mint exception, validation failure, unit swap failure');
  // The swap failure path restarts too — the comment promise "every failure after this point" is kept by the code.
  assert.match(deploy, /if \(swap\.code !== 0\) \{[^}]*await restartUnit\(\);/);
  // "Restart attempted" and "recovered" are different states: the restart reports whether the app serves, and never claims recovery.
  assert.match(deploy, /return restartOutcomeText\(restartVerdict\(r\?\.stdout\)\);/);
  assert.doesNotMatch(deploy, /the app was started again on its current unit/);
  assert.equal((deploy.match(/\$\{back\}/g) || []).length, 5, 'every restart path reports its outcome');
  // Deploys for one container are serialized on the container lock that the
  // restores and the retry-path mint share (container-lock.js).
  assert.match(deploy, /withContainerLock\(String\(args\?\.containerName \|\| ''\), 'deploy', \(\) => deployProjectUnqueued\(args\)\)/);
  assert.doesNotMatch(deploy, /deployQueues/);
  const projectConfig = src('routes/mcp-tools/project-config.js');
  assert.match(projectConfig, /withContainerLock\(p\.incusName, 'restore_project_db', run, \{ wait: false \}\)/, 'the database restore is refused while a deploy holds the container');
  assert.ok(projectConfig.indexOf("withContainerLock(p.incusName, 'restore_project_db'") > projectConfig.indexOf("tool: 'restore_project_db'"), 'the lock is taken after the confirmation gate, before the pre-restore dump');
  const lxcAdmin = src('routes/mcp-tools/lxc-admin.js');
  assert.match(lxcAdmin, /withContainerLock\(incus\(name\), 'restore_snapshot', run, \{ wait: false \}\)/, 'the snapshot restore takes the same lock');
  const runnerSrc = src('mock2/runner.js');
  assert.match(runnerSrc, /withContainerLock\(containerName, 'retry-secrets', \(\) => ensureComponentSecrets\(/, 'the retry-path mint holds the lock');
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
  // The master secret is minted only into code that can migrate what it replaces —
  // checked in the source AND the compiled artifact.
  const master = cfg.find((c) => c.key === 'AUTH_MASTER_SECRET');
  assert.deepEqual(master.requires_marker, { path: 'src/auth/crypto.ts', contains: 'decryptSecretAny', built: 'dist/auth/crypto.js' });
  assert.equal(cfg.find((c) => c.key === 'AUTH_JWT_SECRET').requires_marker, undefined);
  // A fresh install starts with an EMPTY legacy list.
  const legacy = cfg.find((c) => c.key === 'AUTH_LEGACY_MASTER_SECRETS');
  assert.equal(legacy.fresh_value, '');
  assert.notEqual(legacy.secret, true);
  // The master secret declares the data it protects, so the platform can read
  // and classify it before changing the key.
  assert.deepEqual(master.protects, { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce', filter: "provider = 'ldaps'", legacy_default: 'dev-insecure-master-secret-change-me' });
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
  // Completion is established by an inventory over every row, not one read.
  assert.match(ldaps, /export async function masterKeyInventory\(\)/);
  assert.match(ldaps, /inv\.complete = inv\.legacy === 0 && inv\.unreadable === 0;/);
  assert.match(ldaps, /masterKeyInventory: inventory,/);
  // The component's own test pins the empty-list parsing and the refusal.
  const configTest = file('src/auth/config.test.ts');
  assert.match(configTest, /AUTH_LEGACY_MASTER_SECRETS: '' \}\)\)\)\.toEqual\(\[\]\)/);
});
