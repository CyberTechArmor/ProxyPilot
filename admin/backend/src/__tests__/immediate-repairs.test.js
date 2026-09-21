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
  // Gate two moved the deploy's execution into ONE operation
  // (lib/setup-engine/deploy-op.js) that the host runner and the backend's
  // in-process fallback both run; the ratchets below read that file.
  const deploy = src('lib/setup-engine/deploy-op.js');
  assert.match(deploy, /validateDeployEnvironment\(\{ unitText: unit, environmentText: envRead\.stdout \|\| '', requiredKeys: requiredSecretKeys \}\)/);
  // A deferred key (marker missing on disk) is neither minted nor required.
  assert.match(deploy, /requiredSecretKeys = m\.required;/);
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
  const stopIdx = deploy.indexOf('systemctl stop ${p.unit}');
  const mintIdx = deploy.indexOf('mintComponentSecrets({');
  const validateIdx = deploy.indexOf('validateDeployEnvironment(');
  const swapIdx = deploy.indexOf("const swap = await guest('unit'");
  assert.ok(stopIdx > 0 && stopIdx < mintIdx && mintIdx < validateIdx && validateIdx < swapIdx, 'stop the app, then mint, then validate, then write and start the unit');
  // The final probe and mint happen with writers stopped; every failure after
  // the stop — stop itself, mint, and validation after key persistence —
  // starts the unit again before returning.
  assert.match(deploy, /mintComponentSecrets\(\{ guest, appDir, environmentFile, configs: p\.secrets\.configs, newlyProvisioned: p\.secrets\.newlyProvisioned, writersStopped: true, job \}\)/);
  assert.match(deploy, /const restartUnit = async \(\) => \{[\s\S]{0,400}`systemctl daemon-reload[^`]*systemctl start \$\{p\.unit\}[^`]*\$\{servingProbeScript\(webPort, 10\)\}`/);
  assert.equal((deploy.match(/const back = await restartUnit\(\);/g) || []).length, 6, 'stop failure, migration failure, mint failure, mint exception, validation failure, unit swap failure');
  // The swap failure path restarts too — the comment promise "every failure after this point" is kept by the code.
  assert.match(deploy, /if \(swap\.code !== 0\) \{[^}]*await restartUnit\(\);/);
  // "Restart attempted" and "recovered" are different states: the restart reports whether the app serves, and never claims recovery.
  assert.match(deploy, /const verdict = restartVerdict\(r\?\.stdout\);[\s\S]{0,400}return restartOutcomeText\(verdict\);/);
  assert.doesNotMatch(deploy, /the app was started again on its current unit/);
  assert.equal((deploy.match(/\$\{back\}/g) || []).length, 6, 'every restart path reports its outcome');
  // Deploys for one container are serialized on the container lock that the
  // restores and the retry-path mint share (container-lock.js).
  // Gate two: the deploy is a persisted job. A live host runner executes the
  // operation; otherwise the backend runs the SAME operation in-process under
  // the persistent container lock (mock2/deploy.js) — one implementation.
  // The entry module submits the job and, under the backend-allowed policy
  // with no live runner, drains it through the SAME executor the runner
  // uses (lib/setup-engine/executor.js) — it carries no deploy of its own.
  const deployEntry = src('mock2/deploy.js');
  assert.match(deployEntry, /submitDeployJob\(db, \{ app: containerName, params, requestedBy, via \}\)/);
  assert.match(deployEntry, /const mode = executionMode\(db, \{ env: store\.env \|\| process\.env \}\);/);
  assert.match(deployEntry, /if \(mode\.executor === 'none'\) \{/);
  assert.match(deployEntry, /drainRunnerJobsInProcess\(db, \{ \.\.\.deps, env: store\.env \|\| process\.env, max: 3 \}\)/);
  assert.doesNotMatch(deployEntry, /deployProjectUnqueued|deployQueues|runDeployOperation\(/);
  assert.doesNotMatch(deployEntry, /systemctl stop/, 'the entry module no longer carries a deploy of its own');
  const executor = src('lib/setup-engine/executor.js');
  assert.match(executor, /runDeployOperation\(\{ params: \{ \.\.\.p, reapOrphans: false, runDir \}/);
  // Since A-13…A-15 the two restores and the retry mint are runner jobs: the
  // surfaces submit through mock2/ops.js (the orchestrator refuses a restore
  // while a deploy or another restore holds the app, before any change) and
  // run no guest or host command of their own.
  const projectConfig = src('routes/mcp-tools/project-config.js');
  assert.match(projectConfig, /const out = await restoreProjectDb\(\{ containerName: p\.incusName/, 'the database restore is a runner job');
  assert.ok(projectConfig.indexOf('await restoreProjectDb(') > projectConfig.indexOf("tool: 'restore_project_db'"), 'submitted after the confirmation gate');
  assert.doesNotMatch(projectConfig, /pg_dump --clean --if-exists app" > "\$f"/, 'no pre-restore dump is taken by the tool itself');
  assert.doesNotMatch(projectConfig, /psql -X -v ON_ERROR_STOP=0/, 'no psql runs in the tool');
  const lxcAdmin = src('routes/mcp-tools/lxc-admin.js');
  assert.match(lxcAdmin, /const out = await restoreSnapshot\(\{ containerName: incus\(name\), snapshot: snap, acceptPartial/, 'the snapshot restore is a runner job');
  assert.doesNotMatch(lxcAdmin, /snapshotArgv\('restore'/, 'no incus restore runs in the tool');
  const lxcRoute = src('routes/lxc.js');
  assert.match(lxcRoute, /'\/containers\/:name\/snapshot\/:snapshotName\/restore', requireSudo/, 'the dashboard route needs fresh sudo');
  assert.doesNotMatch(lxcRoute, /execOnHost\(`incus snapshot restore/, 'the dashboard route builds no shell string for incus');
  const runnerSrc = src('mock2/runner.js');
  assert.match(runnerSrc, /const secrets = await retryProjectSecrets\(\{ containerName, via: 'system' \}\)/, 'the retry-path mint is a runner job');
  assert.doesNotMatch(runnerSrc, /withContainerLock\(containerName, 'retry-secrets'/);
  const ops = src('mock2/ops.js');
  assert.match(ops, /submitRunnerJob\(db, \{ kind: 'restore_db'/);
  assert.match(ops, /submitRunnerJob\(db, \{ kind: 'restore_snapshot'/);
  assert.match(ops, /submitRunnerJob\(db, \{ kind: 'retry_secrets'/);
});

test('ratchet (A-17.6): the Incus lifecycle and snapshot verbs of the dashboard and MCP run as setup-engine jobs; the surfaces build no incus lifecycle command of their own', () => {
  const lxcRoute = src('routes/lxc.js');
  // The dashboard routes: every lifecycle / snapshot verb submits through the engine.
  for (const kind of ['instance_start', 'instance_stop', 'instance_restart', 'instance_delete', 'instance_create', 'snapshot_create', 'snapshot_delete']) {
    assert.match(lxcRoute, new RegExp(`lifecycleViaRunner\\('${kind}'`), `${kind} goes through the engine`);
  }
  assert.doesNotMatch(lxcRoute, /execOnHost\(`incus (start|stop|restart) \$\{incusName\}( --force)? 2>&1`/, 'no start/stop/restart shell string (the zip import\'s post-import start belongs to the transport group)');
  assert.doesNotMatch(lxcRoute, /execOnHost\(`incus delete \$\{incusName\} --force 2>&1`/, 'no container delete shell string');
  assert.doesNotMatch(lxcRoute, /incus launch \$\{image\}/, 'no launch shell string (the profile and image were interpolated unquoted)');
  assert.doesNotMatch(lxcRoute, /spawnOnHost\(`incus snapshot create/, 'no snapshot create shell string');
  assert.doesNotMatch(lxcRoute, /execOnHost\(`incus snapshot delete/, 'no snapshot delete shell string');
  assert.match(lxcRoute, /'\/containers\/:name\/snapshot\/:snapshotName', requireSudo/, 'a snapshot delete needs fresh sudo (R-016)');
  assert.match(lxcRoute, /'\/containers\/:name\/snapshot\/:snapshotName\/local', requireSudo/);
  assert.match(lxcRoute, /'\/containers\/:name', requireSudo/, 'the container delete keeps its sudo');
  // R-025: the whole-snapshot delete removes nothing off-host unless the local copy is gone.
  const wholeDelete = lxcRoute.slice(lxcRoute.indexOf("lxcRouter.delete('/containers/:name/snapshot/:snapshotName', requireSudo"), lxcRoute.indexOf('// 2. Drop every S3 copy'));
  assert.match(wholeDelete, /if \(!local\.ok && !local\.notFound\) return lifecycleFailure\(res, local,/, 'a refused or failed local delete returns before the S3 copies and the notes');
  assert.doesNotMatch(wholeDelete, /errors\.push\(\{ scope: 'local'/, 'a local failure is never a "partial" failure');
  // What is left on the container's pivot in this file is the import / export transport group (recorded in the ledger), nothing of this group.
  const leftover = [...lxcRoute.matchAll(/execOnHost\(`incus (start|stop|restart|delete|launch) /g)].map((m) => m[1]);
  assert.deepEqual(leftover.sort(), ['delete', 'delete', 'start', 'start'], `only the import/export transports' post-import start and temp cleanup remain (A-17 transport group): ${leftover.join(', ')}`);
  // MCP: the three original tools and the two admin tools.
  const mcp = src('routes/mcp.js');
  assert.match(mcp, /runLifecycle\(\{ kind: LIFECYCLE_ACTIONS\[action\], containerName: incusName, force: false/, 'control_lxc_container is a job, clean shutdown only');
  assert.match(mcp, /runLifecycle\(\{ kind: 'instance_create', containerName: incusName, image, profile: 'default', config/, 'create_lxc_container is a job with an allowlisted config');
  assert.match(mcp, /runLifecycle\(\{ kind: 'snapshot_create', containerName: incusName, snapshot: snapName/, 'snapshot_lxc_container is a job');
  assert.doesNotMatch(mcp, /runHostCapture\('incus', \[action, incusName\]/);
  assert.doesNotMatch(mcp, /const argv = \['launch', image, incusName/);
  const lxcAdmin = src('routes/mcp-tools/lxc-admin.js');
  assert.match(lxcAdmin, /runLifecycle\(\{ kind: 'instance_delete', containerName: incus\(name\), force: args\.force === true, expect: identity/, 'delete_lxc_container binds the identity');
  assert.match(lxcAdmin, /subject: `\$\{name\}\/\$\{digest\}`, action: `delete container/, 'the token covers the identity');
  assert.match(lxcAdmin, /runLifecycle\(\{ kind: 'snapshot_delete', containerName: incus\(name\), snapshot: snap, expect: target\.created_at/, 'delete_snapshot binds the timestamp');
  assert.doesNotMatch(lxcAdmin, /runHostCapture\('incus', \['stop', incus\(name\)/);
  assert.doesNotMatch(lxcAdmin, /runHostCapture\('incus', \['delete', incus\(name\)\]/);
  assert.doesNotMatch(lxcAdmin, /snapshotArgv\('delete'/);
  // The engine side: fixed argv only, from the plan.
  const op = src('lib/setup-engine/lifecycle-op.js');
  assert.match(op, /await host\(lifecycleArgv\(kind, p\), \{ timeoutMs: TIMEOUTS\[kind\] \}\)/, 'the command issued is the rendered argv');
  assert.doesNotMatch(op, /'sh', '-c'|spawn\(|execOnHost|runHostCapture|nsenter/, 'no shell, no spawn of its own: the executor\'s host channel only');
  const logic = src('lib/setup-engine/lifecycle-logic.js');
  assert.match(logic, /p\.command != null \|\| p\.script != null \|\| p\.argv != null \|\| p\.args != null \|\| p\.options != null/);
});

test('ratchet (A-17.7): the post-launch and post-start fix-ups are setup-engine phases; the dashboard and MCP run no NAT / DNS / init-script command and keep no in-memory creation state', () => {
  const lxcRoute = src('routes/lxc.js');
  assert.doesNotMatch(lxcRoute, /async function ensureDns|export async function ensureNetworkNat|function ensureNetworkNat/, 'the NAT and DNS fix-ups are phases of the guest_setup job');
  assert.doesNotMatch(lxcRoute, /sysctl -w net\.ipv4\.ip_forward|iptables -C DOCKER-USER|incus network set \$\{net\.name\} ipv4\.nat/, 'no host NAT command in the route');
  assert.doesNotMatch(lxcRoute, /incus exec \$\{incusName\} -- (tee \/tmp\/pp-init\.sh|chmod \+x \/tmp\/pp-init\.sh|sh \/tmp\/pp-init\.sh|rm -f \/tmp\/pp-init\.sh)/, 'the init script runs contained in the runner, from an input file by reference');
  assert.doesNotMatch(lxcRoute, /> \/etc\/resolv\.conf|rm -f \/etc\/resolv\.conf/, 'no guest DNS write in the route');
  assert.doesNotMatch(lxcRoute, /const activeCreations = new Map\(\)|activeCreations\.(get|set|has|delete)\(/, 'creation progress is read from the records, never a map an API restart forgets');
  assert.match(lxcRoute, /writeInitScriptInput\(dir, initScript\.trim\(\)\)/, 'the script becomes a 0600 input next to the database');
  assert.match(lxcRoute, /setup\.phases\.push\('init_script'\)/); assert.match(lxcRoute, /setup\.phases\.push\('routes'\)/);
  assert.match(lxcRoute, /lifecycleViaRunner\('instance_create', incusName, req, \{\n\s+image: String\(image\), profile: profile \? String\(profile\) : 'default', config: launchConfig, vm: isVm, rootSize: isVm \? '20GiB' : null, setup, detach: true,/, 'the launch job carries the setup plan');
  assert.match(lxcRoute, /lifecycleViaRunner\('instance_start', incusName, req, \{ fixup: true \}\)/, 'start asks for the NAT + DNS follow-up');
  assert.match(lxcRoute, /lifecycleViaRunner\('instance_restart', incusName, req, \{ force: true, fixup: true \}\)/, 'restart asks for it');
  assert.match(lxcRoute, /lifecycleViaRunner\('instance_restart', incusName, req, \{ force: false, fixup: true \}\)/, 'reboot asks for it');
  assert.match(lxcRoute, /const view = createStatus\(getDb\(\), incusName\);/, 'create-status reads the records');
  assert.match(lxcRoute, /openJobsFor\(getDb\(\), incusName, \['instance_create', 'guest_setup'\]\)/, 'an open create is refused from the records');
  const createRoute = lxcRoute.slice(lxcRoute.indexOf("lxcRouter.post('/containers', async (req, res) => {"), lxcRoute.indexOf("lxcRouter.get('/containers/:name/create-status'"));
  assert.doesNotMatch(createRoute, /INSERT INTO service_http_routes|renderDomains\(|syncLxcServiceUpstream\(|findOrCreateLxcService\(/, 'the create-time route rows and their render are the configure_routes step (lib/guest-routes.js), not the request handler');
  assert.doesNotMatch(createRoute.slice(createRoute.indexOf("lifecycleViaRunner('instance_create'")), /execOnHost\(|spawnOnHost\(/, 'the create route runs no host command after the launch (the pre-flight reads before it stay)');
  assert.match(lxcRoute, /export \{ findOrCreateLxcService \} from '\.\.\/lib\/guest-routes\.js';/);
  const mcp = src('routes/mcp.js');
  assert.doesNotMatch(mcp, /ensureNetworkNat/, 'MCP\'s create does not run NAT itself');
  assert.match(mcp, /runLifecycle\(\{ kind: 'instance_create', containerName: incusName, image, profile: 'default', config, rootSize: diskGb !== null \? `\$\{diskGb\}GiB` : null, setup: \{ phases: \['network_nat', 'await_address'\], addressTimeoutMs: 15_000 \}/, 'the launch carries the NAT + address plan');
  assert.match(mcp, /await waitForSetup\(containerLockStore\(\)\.getDb\(\), launch\.setupJobId, \{ timeoutMs: 60_000 \}\)/, 'the tool waits on the setup record, not on a host poll');
  assert.doesNotMatch(mcp, /for \(let i = 0; i < 15; i \+= 1\) \{\n\s+const probe = await fetchLxcInstance\(incusName\);/, 'no DHCP poll in the tool');
  // The engine side: fixed argv, contained guest scripts, no shell of its own.
  const op = src('lib/setup-engine/setup-op.js');
  assert.doesNotMatch(op, /'sh', '-c'|spawn\(|execOnHost|runHostCapture|nsenter|exec\.guest\(/, 'the host channel and the contained guest executor only');
  assert.match(op, /containedGuest\(\{ exec, container: name, job \}\)/);
  assert.match(op, /mark\('init_script', \{ setup: true, resumable: true, disruptive: false, init_issued: true,[^\n]*\{ required: true \}\)/, 'the checkpoint before the script is mandatory');
  assert.match(op, /if \(prior && prior\.init_issued === true\) \{/, 'a resumed job reads, never re-runs');
  assert.match(op, /if \(origin && \['done', 'failed', 'timed_out', 'uncertain'\]\.includes\(origin\.state\)\) \{/, 'a retry never repeats an issued or completed init');
  const logic = src('lib/setup-engine/setup-logic.js');
  assert.match(logic, /p\.command != null \|\| p\.script != null \|\| p\.argv != null \|\| p\.args != null \|\| p\.options != null \|\| p\.initScriptText != null/);
  assert.match(logic, /export const HOST_NETWORK_LOCK = '@host\/network';/); assert.match(logic, /export const HOST_ROUTES_LOCK = '@host\/routes';/);
  // Both executors know the input store: the runner from the database it opened, the backend from its own path.
  assert.match(src('../../../cli/src/commands/setup-runner.js'), /inputsDir: deps\.inputsDir \|\| setupInputsDir\(o\.install\.dbPath\)/);
  assert.match(src('index.js'), /configureContainerLockStore\(\{ getDb, owner: backendOwner\(\), inputsDir: setupInputsDir\(databasePath\(\)\) \}\);/);
  assert.match(src('index.js'), /setInterval\(backendSteps, 15_000\)\.unref\(\);/, 'the backend drains its own steps whatever the policy');
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
