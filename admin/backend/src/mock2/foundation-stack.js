// Mock2 application foundation — the GUEST STACK, exec half (2026-10).
//
// Drives the Compose stack inside a project guest. Every call is one
// `incus exec <guest> -- …` through mock2/host.js runHost (R3: nsenter when
// the backend runs in Docker). The DECISIONS — files, scripts, parsers — are
// foundation-stack-logic.js; this module only runs them and reads the result.
//
// Secrets (the master key, the S3 keys) only ever cross on the command's
// STDIN: never in argv (visible in the guest's process list), never in a file
// the stack reads, never in a result or a step detail.
//
// Nothing here deletes a volume. Turning a feature off is `docker compose
// stop`; `down -v`, `rm -v` and volume commands are refused (composeArgsError).
//
// Terminology (risk R7): nothing here is named "agent".

import { runHost } from './host.js';
import { STACK, FOUNDATION_VERSION } from './foundation-contract.js';
import {
  DEFAULT_LAYOUT, resolveLayout, composeArgv, composeArgsError,
  buildFoundationFiles, writeFilesScript, parseWriteFiles,
  masterKeyScript, parseMasterKey, masterKeyError,
  dockerProbeScript, parseDockerProbe,
  foundationPsqlArgv, foundationEnsureSql, isTransientPgError,
  storageIdentityScript, parseStorageIdentity, storageCredentialError,
  objectCountScript, parseObjectCount,
  interpretServiceStatus, servicesReady, wantedServices, FOUNDATION_SERVICES, FOUNDATION_IMAGES,
  imagePresenceScript, parseImagePresence,
  foundationCliArgsError, foundationCliScript, foundationJobScript, foundationJobUnit, validAppDir,
} from './foundation-stack-logic.js';

// ---- the guest runner (overridable for the real-Docker test) ----
function incusGuestExec(containerName, argv, { input = null, timeoutMs = 120000 } = {}) {
  return runHost('incus', ['exec', String(containerName), '--', ...argv], { input, timeoutMs });
}
let guestExec = incusGuestExec;
let layoutOverride = null;

// Test seam: run "guest" commands with another runner (the docker test runs
// them on the test host) under another layout (an a3-… project in a temp
// dir). Call with no arguments to restore the defaults.
export function _setFoundationGuestExecForTests(fn = null, { layout = null } = {}) {
  guestExec = typeof fn === 'function' ? fn : incusGuestExec;
  layoutOverride = layout ? resolveLayout(layout) : null;
}
function currentLayout() { return layoutOverride || DEFAULT_LAYOUT; }

function validContainer(containerName) {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(String(containerName || ''));
}
function guestSh(containerName, script, args = [], opts = {}) {
  return guestExec(containerName, ['sh', '-c', script, 'sh', ...args], opts);
}
const tailOf = (r, n = 600) => `${r?.stderr || ''}${r?.stdout ? `\n${r.stdout}` : ''}`.trim().slice(-n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// foundationCompose(containerName, args, { timeoutMs, input }) → { code, stdout, stderr }
// `docker compose -p mock2-foundation -f /opt/mock2-foundation/compose.yaml <args…>`
// inside the guest. Volume-deleting arguments are refused before anything runs.
export async function foundationCompose(containerName, args, { timeoutMs = 120000, input = null } = {}) {
  if (!validContainer(containerName)) return { code: null, stdout: '', stderr: `invalid container name: ${containerName}`, refused: true };
  const bad = composeArgsError(args);
  if (bad) return { code: null, stdout: '', stderr: bad, refused: true };
  return guestExec(containerName, [...composeArgv(currentLayout()), ...args], { input, timeoutMs });
}

// foundationPsql(containerName, sql, { database, timeoutMs }) → { code, stdout, stderr }
// psql as the superuser INSIDE the postgres service (peer: root → postgres),
// the SQL on stdin, `-v ON_ERROR_STOP=1 -X -q -t -A`.
export async function foundationPsql(containerName, sql, { database = STACK.postgres.database, timeoutMs = 120000 } = {}) {
  if (!validContainer(containerName)) return { code: null, stdout: '', stderr: `invalid container name: ${containerName}` };
  let argv;
  try { argv = foundationPsqlArgv(database, currentLayout()); }
  catch (e) { return { code: null, stdout: '', stderr: e.message }; }
  return guestExec(containerName, argv, { input: String(sql ?? ''), timeoutMs });
}

// writeFoundationFiles(containerName, { features }) → { ok, changed, wrote, same, error }
// The platform-owned files under STACK.dir (compose.yaml + the Postgres
// configuration and init files). Idempotent: unchanged files are not
// rewritten. The files are the same for every feature state — all three
// services are always defined; `features` decides only what bring-up starts.
export async function writeFoundationFiles(containerName, { features = null } = {}) {
  void features;
  if (!validContainer(containerName)) return { ok: false, error: `invalid container name: ${containerName}` };
  const layout = currentLayout();
  const script = writeFilesScript(buildFoundationFiles({ layout }), layout);
  const r = await guestSh(containerName, script, [], { timeoutMs: 60000 });
  if (r.code !== 0) return { ok: false, error: `writing ${layout.dir} failed: ${tailOf(r, 400)}` };
  return { ok: true, error: null, ...parseWriteFiles(r.stdout) };
}

// ensureMasterKey(containerName, masterKeyB64) → { ok, changed, error }
// STACK.keyFile, 0600 root (directory 0700), the key on stdin.
export async function ensureMasterKey(containerName, masterKeyB64) {
  if (!validContainer(containerName)) return { ok: false, error: `invalid container name: ${containerName}` };
  const bad = masterKeyError(masterKeyB64);
  if (bad) return { ok: false, error: bad };
  const layout = currentLayout();
  const r = await guestSh(containerName, masterKeyScript(layout), [], { input: `${String(masterKeyB64).trim()}\n`, timeoutMs: 30000 });
  const parsed = parseMasterKey(r.stdout);
  if (r.code !== 0 || !parsed.state) return { ok: false, error: `writing the foundation master key failed: ${String(r.stderr || '').trim().slice(-300) || `exit ${r.code}`}` };
  if (parsed.mode !== '600') return { ok: false, error: `the foundation master key file has mode ${parsed.mode}, expected 600` };
  return { ok: true, changed: parsed.changed, error: null };
}

// foundationPresent(containerName) → true when the guest carries the stack's
// compose file (a foundation guest), false otherwise (native, or unreachable).
export async function foundationPresent(containerName) {
  if (!validContainer(containerName)) return false;
  const r = await guestExec(containerName, ['test', '-f', currentLayout().composeFile], { timeoutMs: 30000 });
  return r.code === 0;
}

// foundationServiceStatus(containerName) → [{ service, state, health }] for
// postgres, storage and embeddings (state `absent` = no container yet), or
// null when the guest/compose could not be asked.
export async function foundationServiceStatus(containerName) {
  const r = await foundationCompose(containerName, ['ps', '--all', '--format', 'json'], { timeoutMs: 30000 });
  if (r.code !== 0) return null;
  return interpretServiceStatus(r.stdout);
}

async function composeLogs(containerName, service, lines = 30) {
  const r = await foundationCompose(containerName, ['logs', '--no-color', '--tail', String(lines), service], { timeoutMs: 30000 });
  return String(r.stdout || r.stderr || '').trim().slice(-1200);
}

// Wait until every service is running AND healthy. A service that keeps
// failing (exited, restarting or unhealthy) for failFastMs is reported then,
// instead of waiting out the whole timeout on a crash loop.
async function waitHealthy(containerName, services, { timeoutMs, intervalMs = 2000, failFastMs = 90000 }) {
  const deadline = Date.now() + timeoutMs;
  const failingSince = new Map();
  let last = null;
  for (;;) {
    const statuses = await foundationServiceStatus(containerName);
    if (statuses) {
      last = servicesReady(statuses, services);
      if (last.ready) return { ok: true, statuses };
      const now = Date.now();
      for (const s of statuses.filter((x) => services.includes(x.service))) {
        const bad = s.health === 'unhealthy' || ['exited', 'dead', 'restarting'].includes(s.state);
        if (!bad) { failingSince.delete(s.service); continue; }
        if (!failingSince.has(s.service)) failingSince.set(s.service, now);
        if (now - failingSince.get(s.service) >= failFastMs) return { ok: false, statuses, notReady: [s.service], failing: true };
      }
    }
    if (Date.now() >= deadline) return { ok: false, statuses, notReady: last?.notReady?.length ? last.notReady : services };
    await sleep(intervalMs);
  }
}

// setFoundationService(containerName, service, 'start'|'stop', { healthTimeoutMs, intervalMs, failFastMs })
// → { ok, error }
// start = `up -d <service>` (creates the container the first time, same
// volume every time) and then waits until it is HEALTHY: `up -d` returns once
// the container runs, not once it serves, and every caller tests the provider
// right after (a switch's pending test, a health probe). stop = `stop
// <service>` (the volume stays). Postgres is the system of record and is never
// stopped here.
export async function setFoundationService(containerName, service, action, { healthTimeoutMs = null, intervalMs = 2000, failFastMs = 90000 } = {}) {
  if (!FOUNDATION_SERVICES.includes(service)) return { ok: false, error: `unknown foundation service: ${service}` };
  if (action !== 'start' && action !== 'stop') return { ok: false, error: `action must be start or stop, not ${action}` };
  if (action === 'stop' && service === STACK.postgres.service) return { ok: false, error: 'postgres is always on; it is never stopped through a feature switch' };
  const args = action === 'start' ? ['up', '-d', '--no-deps', service] : ['stop', service];
  const r = await foundationCompose(containerName, args, { timeoutMs: action === 'start' ? 15 * 60 * 1000 : 120000 });
  if (r.code !== 0) return { ok: false, error: `docker compose ${args.join(' ')} failed: ${tailOf(r, 400)}` };
  if (action === 'start') {
    // The same bounds as bring-up's healthy step (the embedding server may
    // still download its model on a first start).
    const timeoutMs = healthTimeoutMs ?? (service === STACK.embeddings.service ? 20 * 60 * 1000 : 4 * 60 * 1000);
    const healthy = await waitHealthy(containerName, [service], { timeoutMs, intervalMs, failFastMs });
    if (!healthy.ok) {
      const logs = await composeLogs(containerName, service);
      return { ok: false, error: `${service} was started but did not become healthy. Last log lines: ${logs || '(none)'}` };
    }
  }
  return { ok: true, error: null };
}

// bundledStorageObjectCount(containerName, { accessKeyId, secretAccessKey })
// → number of objects in bucket `app` (S3 ListObjectsV2 with the admin key,
// every page), or null when it cannot be told (storage stopped, bad key…).
export async function bundledStorageObjectCount(containerName, adminCredentials) {
  if (storageCredentialError(adminCredentials, 'admin')) return null;
  const r = await foundationCompose(containerName, ['exec', '-T', STACK.storage.service, 'sh', '-c', objectCountScript()], {
    input: `${adminCredentials.accessKeyId}\n${adminCredentials.secretAccessKey}\n`, timeoutMs: 10 * 60 * 1000,
  });
  if (r.code !== 0) return null;
  return parseObjectCount(r.stdout);
}

// foundationCli(containerName, args, { appDir, timeoutMs }) → { code, stdout, stderr }
// `node foundation/bin/foundation.mjs <args…>` in the app directory (args as
// positional parameters — never re-parsed by a shell).
export async function foundationCli(containerName, args, { appDir = '/srv/app', timeoutMs = 120000 } = {}) {
  if (!validContainer(containerName)) return { code: null, stdout: '', stderr: `invalid container name: ${containerName}` };
  const bad = foundationCliArgsError(args) || (validAppDir(appDir) ? null : `invalid app dir: ${appDir}`);
  if (bad) return { code: null, stdout: '', stderr: bad };
  return guestSh(containerName, foundationCliScript(), [appDir, ...args], { timeoutMs });
}

// runFoundationJobDetached(containerName, jobId, { appDir }) → { ok, unit, error }
// One transient systemd unit per job (systemd-run --collect), so a job keeps
// running when the request that started it is gone. The job row is the record.
export async function runFoundationJobDetached(containerName, jobId, { appDir = '/srv/app' } = {}) {
  let unit;
  try { unit = foundationJobUnit(jobId); }
  catch (e) { return { ok: false, unit: null, error: e.message }; }
  if (!validContainer(containerName)) return { ok: false, unit, error: `invalid container name: ${containerName}` };
  if (!validAppDir(appDir)) return { ok: false, unit, error: `invalid app dir: ${appDir}` };
  const r = await guestSh(containerName, foundationJobScript(), [appDir, String(jobId)], { timeoutMs: 30000 });
  if (r.code !== 0) {
    const out = tailOf(r, 300);
    return { ok: false, unit, alreadyRunning: /already exists|already loaded|is active/i.test(out), error: `starting ${unit} failed: ${out || `exit ${r.code}`}` };
  }
  return { ok: true, unit, error: null };
}

// bringUpFoundation({ containerName, features, masterKey, storageCredentials, onStep })
// → { ok, steps: [{ name, ok, detail }], error }
//
//   docker      Docker + Compose v2 present and the daemon answering
//   master-key  STACK.keyFile (when a key is passed; idempotent)
//   files       the platform-owned files under STACK.dir
//   pull        the images of the services that will run (the others best-effort)
//   up          `up -d` postgres + storage (+ embeddings when it is on and local)
//   healthy     every started service healthy
//   schema      role app + database app + FOUNDATION_SCHEMA_SQL (idempotent)
//   storage-identities  app + admin identities, bucket app, anonymous refused
//   features    `stop` the services whose feature is off
//
// Storage is always started once: its identities must exist before the
// bundled S3 is ever reachable with a feature on, and they persist in its
// volume. Idempotent; never recreates or removes a volume. onStep(name, label)
// reports progress.
export async function bringUpFoundation({ containerName, features, masterKey = null, storageCredentials, onStep = null } = {}) {
  const steps = [];
  const step = (name, label) => { try { onStep?.(name, label); } catch { /* progress only */ } };
  const record = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };
  const failed = (name, error) => { record(name, false, error); return { ok: false, steps, error }; };

  if (!validContainer(containerName)) return failed('docker', `invalid container name: ${containerName}`);
  const credErr = storageCredentialError(storageCredentials?.app, 'app') || storageCredentialError(storageCredentials?.admin, 'admin');
  if (credErr) return failed('storage-identities', credErr);
  if (storageCredentials.app.accessKeyId === storageCredentials.admin.accessKeyId) return failed('storage-identities', 'the app and admin storage identities must have different access keys');
  const want = wantedServices(features);
  const layout = currentLayout();

  // 1. Docker
  step('docker', 'Checking Docker in the guest…');
  const probe = parseDockerProbe((await guestSh(containerName, dockerProbeScript(), [], { timeoutMs: 60000 })).stdout);
  if (!probe.ok) return failed('docker', probe.error);
  record('docker', true, `Docker ${probe.docker}, Compose ${probe.compose}, storage driver ${probe.driver}${probe.warning ? ` — ${probe.warning}` : ''}`);

  // 2. Master key
  if (masterKey != null) {
    step('master-key', 'Writing the deployment master key…');
    const k = await ensureMasterKey(containerName, masterKey);
    if (!k.ok) return failed('master-key', k.error);
    record('master-key', true, k.changed ? `written to ${layout.keyFile} (0600 root)` : `${layout.keyFile} unchanged`);
  }

  // 3. Files
  step('files', `Writing ${layout.dir}…`);
  const files = await writeFoundationFiles(containerName, { features });
  if (!files.ok) return failed('files', files.error);
  record('files', true, files.changed ? `wrote ${files.wrote.join(', ')}` : 'unchanged');

  // 4. Pull — only the pinned images the guest does not have yet.
  const start = [STACK.postgres.service, STACK.storage.service, ...(want[STACK.embeddings.service] ? [STACK.embeddings.service] : [])];
  step('pull', `Pulling images (${start.join(', ')})…`);
  const refs = FOUNDATION_SERVICES.map((s) => FOUNDATION_IMAGES[s]);
  const presence = parseImagePresence((await guestSh(containerName, imagePresenceScript(), refs, { timeoutMs: 60000 })).stdout);
  const missing = new Set(presence.missing);
  const toPull = start.filter((s) => missing.has(FOUNDATION_IMAGES[s]) || !presence.present.includes(FOUNDATION_IMAGES[s]));
  if (toPull.length) {
    const pull = await foundationCompose(containerName, ['pull', '--quiet', ...toPull], { timeoutMs: 30 * 60 * 1000 });
    if (pull.code !== 0) {
      return failed('pull', `docker compose pull ${toPull.join(' ')} failed: ${tailOf(pull, 500)} — the guest must reach the image registries (Docker Hub${toPull.includes(STACK.embeddings.service) ? ', ghcr.io' : ''}); check its egress and retry`);
    }
  }
  let pullNote = '';
  if (!want[STACK.embeddings.service] && missing.has(FOUNDATION_IMAGES[STACK.embeddings.service])) {
    // Best effort, so turning embeddings on later does not wait for a pull.
    const opt = await foundationCompose(containerName, ['pull', '--quiet', '--ignore-pull-failures', STACK.embeddings.service], { timeoutMs: 30 * 60 * 1000 });
    pullNote = opt.code === 0 ? '; embeddings image pulled for later' : '; embeddings image not pulled (it is pulled when embeddings are turned on)';
  }
  record('pull', true, `${toPull.length ? `pulled ${toPull.join(', ')}` : 'all images already present'}${pullNote}`);

  // 5. Up
  step('up', 'Starting the foundation services…');
  const up = await foundationCompose(containerName, ['up', '-d', ...start], { timeoutMs: 10 * 60 * 1000 });
  if (up.code !== 0) return failed('up', `docker compose up -d ${start.join(' ')} failed: ${tailOf(up, 600)}`);
  record('up', true, start.join(', '));

  // 6. Healthy (the embedding server downloads its model on first start)
  step('healthy', 'Waiting for the services to report healthy…');
  const healthy = await waitHealthy(containerName, start, { timeoutMs: want[STACK.embeddings.service] ? 20 * 60 * 1000 : 4 * 60 * 1000 });
  if (!healthy.ok) {
    const svc = healthy.notReady[0] || start[0];
    const logs = await composeLogs(containerName, svc);
    const hint = svc === STACK.embeddings.service
      ? ' — the local embedding server downloads its model from huggingface.co on first start; allow that egress, or turn embeddings off / switch to another provider'
      : '';
    return failed('healthy', `${healthy.notReady.join(', ') || svc} did not become healthy${hint}. Last log lines of ${svc}: ${logs || '(none)'}`);
  }
  record('healthy', true, start.join(', '));

  // 7. Schema — the image's init file normally did this on the first start;
  // running it again converges a volume whose init was interrupted.
  step('schema', 'Preparing the app database (role, pgvector, foundation schema)…');
  let schema = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    schema = await foundationPsql(containerName, foundationEnsureSql(), { database: 'postgres', timeoutMs: 120000 });
    if (schema.code === 0 || !isTransientPgError(`${schema.stderr}\n${schema.stdout}`)) break;
    await sleep(2000);
  }
  if (schema.code !== 0) return failed('schema', `applying the foundation schema failed: ${tailOf(schema, 600)}`);
  const check = await foundationPsql(containerName,
    "SELECT extversion FROM pg_extension WHERE extname = 'vector';\nSELECT count(*) FROM information_schema.tables WHERE table_schema = 'mock2_foundation';\n",
    { database: STACK.postgres.database, timeoutMs: 60000 });
  const [vector, tables] = String(check.stdout || '').trim().split('\n').map((s) => s.trim());
  if (check.code !== 0 || !vector || !(Number(tables) >= 1)) return failed('schema', `the foundation schema is not in place after applying it (pgvector ${vector || 'missing'}, ${tables || 0} tables): ${tailOf(check, 300)}`);
  record('schema', true, `pgvector ${vector}, ${tables} mock2_foundation tables (${FOUNDATION_VERSION})`);

  // 8. Storage identities + bucket
  step('storage-identities', 'Configuring the bundled S3 identities…');
  const { app, admin } = storageCredentials;
  const ident = await foundationCompose(containerName, ['exec', '-T', STACK.storage.service, 'sh', '-c', storageIdentityScript()], {
    input: `${app.accessKeyId}\n${app.secretAccessKey}\n${admin.accessKeyId}\n${admin.secretAccessKey}\n`, timeoutMs: 180000,
  });
  const idres = parseStorageIdentity(ident.stdout, ident.code);
  if (!idres.ok) return failed('storage-identities', idres.error);
  record('storage-identities', true, `app (bucket ${STACK.storage.bucket}) and admin identities set; bucket ${idres.bucket}; anonymous requests refused`);

  // 9. Feature switches: stop what is off (volumes stay).
  step('features', 'Applying the feature switches…');
  const off = [STACK.storage.service, STACK.embeddings.service].filter((s) => !want[s]);
  if (off.length) {
    const stop = await foundationCompose(containerName, ['stop', ...off], { timeoutMs: 180000 });
    if (stop.code !== 0) return failed('features', `docker compose stop ${off.join(' ')} failed: ${tailOf(stop, 400)}`);
  }
  record('features', true, off.length ? `stopped ${off.join(', ')} (feature off; data kept)` : 'all features on');

  return { ok: true, steps, error: null };
}
