// Mock2 deterministic component pre-install — the ZERO-TOKEN materialization
// path. Confirmed per-project component selections (mock2_project_components,
// migration 524) are written into the project container by the PLATFORM, not by
// the build runner: files land over the same proven base64 channel
// materialize_component uses (byte-exact, sha256-verified), the component's SQL
// migrations are renumbered to append after the project's existing ones,
// declared dependencies are npm-installed, non-secret config defaults are
// merged into .env, and each contract connection is pre-declared in
// state/integrations.json — all before the build runner's first model turn.
// No model is involved anywhere in this module; the build's AI budget is spent
// only on wiring the design to the installed components' API surface.
//
// Invoked from audit.js proceedToBuild (every build passes through it) and from
// the operator's "install now" route. Keep-existing semantics throughout: a
// re-run never clobbers files an earlier build adapted (a component UPGRADE is
// a deliberate future flow, never a silent overwrite).
//
// Terminology (risk R7): nothing here is named "agent".

import { logAudit } from '../db.js';
import {
  containerSh, execInContainer, readFileInContainer, writeFileInContainer,
} from './runner.js';
import { containerNameForProject } from './provision.js';
import {
  listProjectComponents, listPublishedComponents, getPublishedComponentWithVersion,
  getComponentVersion, markProjectComponentInstall, decideProjectComponent,
} from './components.js';
import { getComponentAutoApply } from './settings.js';
import {
  parseFilesJson, parseContractJson, safeComponentPath, selectAutoApplyComponents,
  buildComponentManifest, buildPathsExistScript, parsePathsExistOutput,
  buildManifestVerifyScript, parseShaVerifyOutput,
  planMigrationRenumber, mergeEnvDefaults, manifestEntryFromConnection,
  deriveComponentSubsystem, buildComponentsStateDoc, publicProjectComponentShape,
  COMPONENTS_STATE_PATH, planSecretMint, componentSecretKeys, secretMintGuards, freshEnvValues, secretDataGuards,
} from './component-logic.js';
import { authDataProbeScript, parseAuthDataProbe, classifyRows, decideMasterSecretMint } from './auth-data-logic.js';
import { mergeEnvFile } from '../lib/mcp-ext/logic.js';
import { b64 } from './host.js';
import { backfillManifestEntryInContainer } from './integration-enforcement.js';
import { componentWiresBootstrap, planAuthWiring, AUTH_WIRING_TARGETS } from './scaffold-auth.js';
import { SCAFFOLD_DEPENDENCIES } from './scaffold.js';
import { buildCheckpointScript } from './template.js';
import { insertChangeRecord, changeRecordMirror } from './change-records.js';
import { getCurrentFrameworkVersion } from './framework.js';
import { insertMessage } from './chats.js';
import { nodeRuntimeProbeScript, parseNodeRuntimeProbe, describeNodeRuntimeOutcome } from './node-runtime-logic.js';

const APP_DIR = '/srv/app';
const nowIso = () => new Date().toISOString();

// The statuses the pre-installer acts on: fresh confirmations plus earlier
// failures (pressing Build again retries a failed install).
const INSTALLABLE = new Set(['confirmed', 'install_failed']);

// ---- one component into one container (deterministic, no model) ----

async function installOne({ containerName, row }) {
  const found = getPublishedComponentWithVersion(row.key);
  if (!found) return { ok: false, error: `component "${row.key}" is not published (deprecated or deleted?)` };
  const { component, version } = found;
  const contract = parseContractJson(version.contract_json);
  const files = parseFilesJson(version.files_json)
    .map((f) => ({ path: safeComponentPath(f.path), content: f.content }))
    .filter((f) => f.path);
  if (!files.length) return { ok: false, error: `component "${row.key}" has no files` };

  // 1) Migrations renumber to APPEND after the project's existing migrations
  //    (skipped when the same-suffix migration already landed on an earlier
  //    install — renumbering it again would re-run its DDL).
  let plan = { renames: [], skipped: [], migrationPaths: new Set() };
  if (contract?.migrations) {
    const ls = await execInContainer(containerName, `ls -1 ${contract.migrations.dir} 2>/dev/null || true`);
    const names = String(ls.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    plan = planMigrationRenumber(files, names, contract.migrations);
  }
  const targets = [
    ...files.filter((f) => !plan.migrationPaths.has(f.path)),
    ...plan.renames.map((r) => ({ path: r.to, content: r.content })),
  ];
  const manifest = buildComponentManifest(targets);

  // 2) Existing target paths are KEPT (a re-install never wipes adapted files).
  const ex = await containerSh(containerName, buildPathsExistScript(targets.map((f) => f.path), { appDir: APP_DIR }), { timeoutMs: 60000 });
  const existing = parsePathsExistOutput(ex.stdout);

  // 3) Write server-side, then verify byte-exactness in-container.
  const statuses = {};
  for (const f of targets) {
    if (existing.has(f.path)) { statuses[f.path] = 'kept'; continue; }
    const w = await writeFileInContainer(containerName, f.path, f.content);
    statuses[f.path] = w.ok ? 'written' : 'write failed';
  }
  const written = targets.filter((f) => statuses[f.path] === 'written').map((f) => f.path);
  if (written.length) {
    const v = await containerSh(containerName, buildManifestVerifyScript(written, { appDir: APP_DIR }), { timeoutMs: 120000 });
    const shas = parseShaVerifyOutput(v.stdout);
    for (const m of manifest) {
      if (statuses[m.path] === 'written' && shas.get(m.path) !== m.sha256) statuses[m.path] = 'verify failed';
    }
  }
  const failed = manifest.filter((m) => !['written', 'kept'].includes(statuses[m.path]));
  if (failed.length) {
    return { ok: false, error: `${failed.length} file(s) did not land intact: ${failed.slice(0, 5).map((m) => m.path).join(', ')}` };
  }

  // 3.5) Deterministic auth wiring (scaffold-auth.js): when the component
  //      provides the forced first-admin bootstrap, rewrite the scaffold's
  //      still-pristine entry files so the gate is MOUNTED and the sign-in
  //      page served — no model turn involved, so a build can't skip it.
  //      Adapted files are kept and reported, never clobbered.
  const wired = [];
  const wiringKept = [];
  if (componentWiresBootstrap(contract, files)) {
    const vs = await containerSh(
      containerName,
      buildManifestVerifyScript(AUTH_WIRING_TARGETS, { appDir: APP_DIR }),
      { timeoutMs: 60000 },
    );
    const plan = planAuthWiring({ contract, files, currentShaByPath: parseShaVerifyOutput(vs.stdout) });
    for (const a of plan.actions) {
      if (a.action === 'wire') {
        const w = await writeFileInContainer(containerName, a.path, a.content);
        if (!w.ok) return { ok: false, error: `auth wiring failed for ${a.path}: ${w.error || 'write failed'}` };
        wired.push(a.path);
      } else if (a.action === 'kept-adapted') {
        wiringKept.push(a.path);
      }
    }
  }

  // 4) Declared dependencies (the contract's structured npm installs — no
  //    usage_md parsing). The fence's egress proxy already allows npm.
  //    NPM'S OWN exit code must be checked: `npm install | tail` reports
  //    tail's exit (always 0), which silently shipped projects whose deps
  //    never landed — the deploy then failed at tsc with "Cannot find module".
  //    Log to a file, propagate npm's code, show the tail.
  const npmInstall = (args) =>
    `npm install --no-audit --no-fund ${args} > /tmp/mock2-npm-install.log 2>&1; c=$?; tail -5 /tmp/mock2-npm-install.log; exit $c`;
  const deps = contract?.dependencies;
  const runtime = [...(deps?.runtime || []), ...(deps?.peers || [])];
  if (runtime.length) {
    const r = await execInContainer(containerName, npmInstall(runtime.join(' ')));
    if (r.code !== 0) return { ok: false, error: `npm install failed for ${row.key}: ${(r.stdout || r.stderr || '').trim().slice(-300)}` };
  }
  if (deps?.dev?.length) {
    const r = await execInContainer(containerName, npmInstall(`-D ${deps.dev.join(' ')}`));
    if (r.code !== 0) return { ok: false, error: `npm install -D failed for ${row.key}: ${(r.stdout || r.stderr || '').trim().slice(-300)}` };
  }

  // 5) Non-secret config defaults into .env (secrets are NEVER written — they
  //    surface on the operator verification checklist via the manifest entry).
  if (Array.isArray(contract?.config) && contract.config.length) {
    const cur = await readFileInContainer(containerName, '.env');
    const merged = mergeEnvDefaults(cur.ok ? cur.content : '', contract.config);
    if (merged.added.length) {
      const w = await writeFileInContainer(containerName, '.env', merged.text);
      if (!w.ok) return { ok: false, error: `could not write .env defaults: ${w.error}` };
    }
  }

  // 6) Pre-declare each contract connection in state/integrations.json so the
  //    truthfulness gate sees an honest manifest from cycle start.
  const declared = [];
  const subsystem = deriveComponentSubsystem(files, component.key);
  for (const conn of contract?.connections || []) {
    const entry = manifestEntryFromConnection({ componentKey: component.key, connection: conn, subsystem });
    const r = await backfillManifestEntryInContainer({
      containerName, entry, execInContainer, readFileInContainer, writeFileInContainer,
    });
    if (r.ok) declared.push(entry.id);
    else console.warn(`[mock2] component connection pre-declare failed (${entry.id}): ${r.error}`);
  }

  const counts = {
    written: Object.values(statuses).filter((s) => s === 'written').length,
    kept: Object.values(statuses).filter((s) => s === 'kept').length,
    migrations: plan.renames.length,
    migrationsSkipped: plan.skipped.length,
    deps: runtime.length + (deps?.dev?.length || 0),
    connections: declared.length,
    wired: wired.length,
    wiringKept: wiringKept.length,
  };
  return { ok: true, component, version, contract, manifest, counts, wired, wiringKept };
}

// ---- dependency ensure (repair installed-but-broken selections) ----

// 'name' from an npm install spec: 'cookie@^0.7.2' → 'cookie',
// '@types/node@^20' → '@types/node'.
function npmSpecName(spec) {
  const s = String(spec || '').trim();
  if (!s) return '';
  if (s.startsWith('@')) { const i = s.indexOf('@', 1); return i === -1 ? s : s.slice(0, i); }
  const i = s.indexOf('@');
  return i === -1 ? s : s.slice(0, i);
}
const SAFE_PKG_RE = /^[a-zA-Z0-9@/_.\-]+$/;

// Does a stored component VERSION row provide the wireable auth bootstrap?
// (Contract + file list run through the same detector installOne uses.)
function versionWiresBootstrap(versionRow) {
  if (!versionRow) return false;
  let files = [];
  try { files = JSON.parse(versionRow.files_json || '[]') || []; } catch { files = []; }
  return componentWiresBootstrap(parseContractJson(versionRow.contract_json), files);
}

// ensureComponentDeps — verify every 'installed' selection's declared runtime
// deps actually EXIST in node_modules, and npm-install the missing ones.
// Exists because a past install bug reported success while npm silently failed
// (`npm install | tail` returned tail's exit code), leaving components marked
// 'installed' whose modules never landed — every later deploy then failed at
// tsc with "Cannot find module". Idempotent and cheap when nothing is missing.
export async function ensureComponentDeps({ containerName, rows }) {
  const repaired = [];
  const failed = [];
  for (const row of rows || []) {
    if (row?.status !== 'installed') continue;
    const contract = parseContractJson(row.contract_json);
    const deps = contract?.dependencies;
    const specs = [...(deps?.runtime || []), ...(deps?.peers || [])].filter((s) => SAFE_PKG_RE.test(npmSpecName(s)));
    if (!specs.length) continue;
    const names = specs.map(npmSpecName);
    const check = await execInContainer(
      containerName,
      names.map((n) => `[ -d "node_modules/${n}" ] || echo "MISSING ${n}"`).join('\n'),
    );
    const missing = String(check.stdout || '').split('\n')
      .filter((l) => l.startsWith('MISSING ')).map((l) => l.slice(8).trim());
    if (!missing.length) continue;
    const toInstall = specs.filter((s) => missing.includes(npmSpecName(s)));
    const r = await execInContainer(
      containerName,
      `npm install --no-audit --no-fund ${toInstall.join(' ')} > /tmp/mock2-npm-ensure.log 2>&1; c=$?; tail -5 /tmp/mock2-npm-ensure.log; exit $c`,
    );
    if (r.code === 0) {
      repaired.push({ key: row.key, missing });
    } else {
      const error = `dependency repair failed for ${row.key} (${missing.join(', ')}): ${(r.stdout || r.stderr || '').trim().slice(-300)}`;
      try { markProjectComponentInstall({ id: row.id, ok: false, error }); } catch { /* keep going */ }
      failed.push({ row, error });
    }
  }
  return { ok: failed.length === 0, repaired, failed };
}

// ---- the secrets a component owns ----
//
// Until 2026-09 a contract's secrets were "never written — they surface on the
// operator verification checklist", and the auth component fell back to a
// literal dev-insecure default, so a freshly generated app signed its sessions
// with a public string unless someone hand-set the env. The platform now MINTS
// the secrets a component declares as its own (contract.config secret +
// generate) once per project into the container's /etc/environment — the file
// the app's systemd unit reads (deploy-logic.js) and set_project_env writes —
// and never touches a key that is already there, so reinstall and redeploy
// keep the values the app already signed with. Values never leave the
// container: this function reports KEY NAMES only.
const ENVIRONMENT_FILE = '/etc/environment';

function installedSecretConfigs(rows) {
  const configs = [];
  for (const row of rows || []) {
    if (row?.status !== 'installed') continue;
    const contract = parseContractJson(row.contract_json);
    for (const c of contract?.config || []) {
      if (c && c.secret === true && c.generate === true) configs.push(c);
    }
  }
  return configs;
}

// installedSecretKeys(rows) → the env keys every installed component expects
// the platform to have minted (deploy validation checks they are present).
export function installedSecretKeys(rows) {
  return componentSecretKeys(installedSecretConfigs(rows));
}

// Result: { ok, minted, deferred, required, error? }.
//   minted   — keys written this call (names only).
//   deferred — [{ key, reason }]: keys whose requires_marker is NOT on disk.
//              The installer never overwrites a file an app already has, so a
//              project generated before the component learned to migrate data
//              under a replaced key keeps its current value (today: the dev
//              default for AUTH_MASTER_SECRET) rather than having its stored
//              data stranded. Reported, not silent.
//   required — the minted-or-eligible keys a deploy must find present.
const shq = (s) => String(s).replace(/'/g, "'\\''");

// The container's environment file, read whole and written whole (moved into
// place, so the unit never reads a half-written file). Same file, mode and
// channel as set_project_env.
async function readEnvironment(containerName) {
  const cur = await containerSh(containerName, `cat ${ENVIRONMENT_FILE} 2>/dev/null || true`, { timeoutMs: 15000 });
  if (cur.code !== 0) return { ok: false, error: `could not read ${ENVIRONMENT_FILE}: ${(cur.stderr || cur.stdout || '').trim().slice(-200)}` };
  return { ok: true, text: cur.stdout || '' };
}
async function writeEnvironment(containerName, text) {
  const w = await containerSh(
    containerName,
    `umask 022\nprintf '%s' '${b64(text)}' | base64 -d > ${ENVIRONMENT_FILE}.mock2-tmp && chmod 0644 ${ENVIRONMENT_FILE}.mock2-tmp && mv -f ${ENVIRONMENT_FILE}.mock2-tmp ${ENVIRONMENT_FILE}`,
    { timeoutMs: 15000 },
  );
  if (w.code !== 0) return { ok: false, error: `could not write ${ENVIRONMENT_FILE}: ${(w.stderr || w.stdout || '').trim().slice(-200)}` };
  return { ok: true };
}

// probeProtectedData({ containerName, guard }) → the stored rows a secret
// protects, read from the app's own database (auth-data-logic.js). "No files
// kept" is not "no data": this is what tells a fresh app from one whose files
// were rebuilt over an existing or restored database.
export async function probeProtectedData({ containerName, guard }) {
  try {
    const r = await containerSh(containerName, authDataProbeScript(guard), { timeoutMs: 20000 });
    return parseAuthDataProbe(r.stdout || '');
  } catch (e) {
    return { state: 'unknown', rows: [], detail: `probe failed: ${e?.message || e}` };
  }
}

// storageIsFresh({ containerName, contracts, newlyProvisioned }) → { fresh,
// reasons }: true only when the platform POSITIVELY identified this container
// as newly provisioned (created in this run from the template, no restored,
// copied or rehydrated data) AND every data guard the contracts declare finds
// nothing stored. New files over an existing database, a probe that could not
// run, or data on a supposedly new container are all NOT fresh.
export async function storageIsFresh({ containerName, contracts, newlyProvisioned = false } = {}) {
  const reasons = [];
  if (newlyProvisioned !== true) return { fresh: false, reasons: ['this container was not positively identified as newly provisioned (a rebuild, a clone with data, a rehydrate, or a later install)'] };
  let fresh = true;
  for (const contract of contracts || []) {
    for (const { key, guard } of secretDataGuards(contract?.config || [])) {
      const probe = await probeProtectedData({ containerName, guard });
      const d = decideMasterSecretMint({ probe, envHasKey: false, newlyProvisioned: true, classification: classifyRows(probe.rows, { legacy: [guard.legacy_default] }) });
      if (!d.fresh) { fresh = false; reasons.push(`${key}: ${d.reason}`); }
    }
  }
  return { fresh, reasons };
}

// ensureFreshEnvValues — on a component's FIRST install into a project (every
// file written, nothing kept) AND with storage confirmed fresh by the data
// probe, write the contract's fresh_value entries into the environment unless
// the key is already there. A fresh app has no data under any previous key,
// so e.g. its legacy-key list starts EMPTY. New files over an existing or
// restored database, or a probe that could not run, never reach here.
export async function ensureFreshEnvValues({ containerName, contracts, freshStorage = false } = {}) {
  if (freshStorage !== true) return { ok: true, written: [], skipped: 'storage not confirmed fresh' };
  const vars = {};
  for (const contract of contracts || []) {
    for (const { key, value } of freshEnvValues(contract?.config || [])) {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) vars[key] = value;
    }
  }
  const keys = Object.keys(vars);
  if (!keys.length) return { ok: true, written: [] };
  const cur = await readEnvironment(containerName);
  if (!cur.ok) return { ok: false, written: [], error: cur.error };
  const existing = new Set(envFileKeysOf(cur.text));
  const toWrite = {};
  for (const k of keys) if (!existing.has(k)) toWrite[k] = vars[k];
  const written = Object.keys(toWrite);
  if (!written.length) return { ok: true, written: [] };
  const w = await writeEnvironment(containerName, mergeEnvFile(cur.text, toWrite));
  if (!w.ok) return { ok: false, written: [], error: w.error };
  return { ok: true, written };
}
function envFileKeysOf(text) {
  const keys = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// Options: newlyProvisioned — the container was created in this run from the
// template with no earlier data (provision.js says so; nothing else may);
// writersStopped — the app is stopped (deploy.js stops it before calling), so
// a key that protects stored data may change without a concurrent write
// landing under the old key. Without either, a data-guarded key is deferred.
export async function ensureComponentSecrets({ containerName, rows, rand, newlyProvisioned = false, writersStopped = false } = {}) {
  const configs = installedSecretConfigs(rows);
  if (!configs.length) return { ok: true, minted: [], deferred: [], required: [] };
  const deferred = [];
  let eligible = configs;
  const guards = secretMintGuards(configs);
  if (guards.length) {
    // The source must carry the marker, and when a built artifact is declared
    // it must EXIST and carry it: the unit runs the compiled code (the manifest
    // start command), so a missing or stale dist/ is not the code that will
    // run. The deploy builds before it mints, so at deploy time the built file
    // is the one the unit is about to start; at pre-install it does not exist
    // yet and the key waits for the deploy.
    const script = guards
      .map((g) => {
        const src = `grep -q -F -- '${shq(g.contains)}' '${APP_DIR}/${shq(g.path)}' 2>/dev/null`;
        if (!g.built) return `if ${src}; then echo "MARKER OK ${g.key}"; else echo "MARKER MISSING ${g.key}"; fi`;
        const builtPath = `'${APP_DIR}/${shq(g.built)}'`;
        return `if ! ${src}; then echo "MARKER MISSING ${g.key}"; elif [ ! -e ${builtPath} ]; then echo "MARKER NOBUILD ${g.key}"; elif grep -q -F -- '${shq(g.contains)}' ${builtPath} 2>/dev/null; then echo "MARKER OK ${g.key}"; else echo "MARKER STALE ${g.key}"; fi`;
      })
      .join('\n');
    const r = await containerSh(containerName, script, { timeoutMs: 15000 });
    const verdict = new Map();
    for (const l of String(r.stdout || '').split('\n')) {
      const m = l.match(/^MARKER (OK|MISSING|NOBUILD|STALE) (\S+)$/);
      if (m) verdict.set(m[2], m[1]);
    }
    for (const g of guards) {
      const v = verdict.get(g.key) || 'MISSING';
      if (v === 'OK') continue;
      const reason = v === 'NOBUILD'
        ? `the compiled artifact ${g.built} does not exist yet — the running service executes the build, so ${g.key} is minted by the deploy once the build exists`
        : v === 'STALE'
          ? `the compiled artifact ${g.built} does not carry "${g.contains}" while ${g.path} does — a stale build is not the code that will run; ${g.key} keeps its current value until a deploy rebuilds it`
          : `${g.path} in this project does not carry "${g.contains}" — the installed component predates the code that migrates data encrypted under the previous value, so ${g.key} keeps its current value (a component upgrade brings the code; the key is minted on the deploy after that)`;
      deferred.push({ key: g.key, reason });
    }
    eligible = configs.filter((c) => (verdict.get(c.key) || (guards.some((g) => g.key === c.key) ? 'MISSING' : 'OK')) === 'OK');
  }
  const cur = await readEnvironment(containerName);
  if (!cur.ok) return { ok: false, minted: [], deferred, required: [], error: cur.error };
  // The data guard: before a key that protects stored data is minted, read
  // those rows from the app's database and decide (auth-data-logic.js). A key
  // already in the environment is never overwritten; fresh storage or data the
  // component's bridge can migrate lets the mint proceed; an unknown key or an
  // unreadable probe defers it and says why.
  const envKeys = new Set(envFileKeysOf(cur.text));
  for (const { key, guard } of secretDataGuards(eligible)) {
    if (envKeys.has(key)) continue;
    const probe = await probeProtectedData({ containerName, guard });
    const d = decideMasterSecretMint({
      probe, envHasKey: false, newlyProvisioned, writersStopped,
      classification: classifyRows(probe.rows, { legacy: [guard.legacy_default] }),
    });
    if (d.mint === 'ok') continue;
    deferred.push({ key, reason: d.reason });
    eligible = eligible.filter((c) => c.key !== key);
  }
  const required = componentSecretKeys(eligible);
  if (!eligible.length) return { ok: true, minted: [], deferred, required };
  const plan = planSecretMint(cur.text, eligible, rand ? { rand } : {});
  if (!plan.minted.length) return { ok: true, minted: [], deferred, required };
  const w = await writeEnvironment(containerName, mergeEnvFile(cur.text, plan.vars));
  if (!w.ok) return { ok: false, minted: [], deferred, required, error: w.error };
  return { ok: true, minted: plan.minted, deferred, required };
}

// deferredSecretsMessage(deferred) → the project-chat line for keys that were
// NOT minted, or null when none were deferred.
export function deferredSecretsMessage(deferred = []) {
  if (!deferred || !deferred.length) return null;
  return `Not minted: ${deferred.map((d) => `${d.key} (${d.reason})`).join('; ')}.`;
}

// ensureScaffoldDeps — restore scaffold dependencies a corrupted package.json
// lost. Two npm processes racing in the same tree (the pre-serialization
// double base-app deploy) could rewrite package.json/package-lock.json and drop
// entries the scaffold was born with (e.g. @types/pg) — after which `npm ci`
// exits 0 against the consistent-but-wrong lockfile and the deploy fails at
// tsc. Add-only merge: never overrides a version the project declares.
export async function ensureScaffoldDeps({ containerName }) {
  const cur = await readFileInContainer(containerName, 'package.json');
  if (!cur.ok) return { ok: false, added: [], error: 'package.json unreadable' };
  let pkg;
  try { pkg = JSON.parse(cur.content); } catch { return { ok: false, added: [], error: 'package.json unparseable' }; }
  const added = [];
  for (const [section, wanted] of Object.entries(SCAFFOLD_DEPENDENCIES)) {
    const target = pkg[section] && typeof pkg[section] === 'object' ? pkg[section] : (pkg[section] = {});
    for (const [name, version] of Object.entries(wanted)) {
      if (!target[name]) { target[name] = version; added.push(name); }
    }
  }
  if (added.length) {
    await writeFileInContainer(containerName, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return { ok: true, added };
}

// ensureNodeRuntime — bring an ALREADY-PROVISIONED container up to Node >= 20.
// MOCK2_BASE_IMAGE is only read at `incus launch`, and buildContainerSetupScript
// only runs during provisioning — a container never re-runs setup on its own, so
// without this repair, projects that existed before the Node 20 template change
// would keep running Node 18 (and skipping the e2e gate) forever. Idempotent and
// best-effort, mirroring scripts/patch-wg-mtu.sh's contract: no-op when already
// satisfied, never throws, never fails the caller. Wired into the deploy repair
// path alongside ensureScaffoldDeps so every project self-heals on its next
// deploy without operator action.
export async function ensureNodeRuntime({ containerName }) {
  let r;
  try {
    r = await containerSh(containerName, nodeRuntimeProbeScript(), { timeoutMs: 180000 });
  } catch (e) {
    return { ok: false, changed: false, version: null, detail: `ensureNodeRuntime crashed: ${e?.message || e}` };
  }
  const probe = parseNodeRuntimeProbe(r.stdout);
  return describeNodeRuntimeOutcome(probe, { stderrTail: (r.stderr || r.stdout || '').slice(-300) });
}

// ---- the pre-install pass (all confirmed selections for a project) ----

// preinstallComponents — install every confirmed (or previously failed)
// selection into the project container, mirror the selection to
// state/components.json, checkpoint with a hash-chained change record, and post
// a chat message so the record of WHAT the build uses is visible where the
// build happens. Returns { ok, installed, failed } — ok is false when any
// selection failed (the caller blocks the build; pressing Build again retries).
export async function preinstallComponents({ project, initiatedBy = null, actingAsAdmin = 0, cycleId = null, newlyProvisioned = false }) {
  const projectId = Number(project.id);

  // Auto-apply (operator setting, default on): every published component with
  // no explicit decision for this project is confirmed here (origin 'auto') so
  // the deterministic pre-install below lands it. Every build path funnels
  // through this function, so this is the single choke point. Human decisions
  // are respected — a declined component stays declined — and keep-existing
  // install semantics mean already-adapted files are never clobbered.
  if (getComponentAutoApply()) {
    try {
      const picks = selectAutoApplyComponents(listPublishedComponents(), listProjectComponents(projectId));
      for (const c of picks) {
        decideProjectComponent({
          projectId, componentId: c.id, versionId: c.current_version_id,
          status: 'confirmed', origin: 'auto', decidedBy: initiatedBy,
        });
      }
      if (picks.length) {
        insertMessage({
          projectId, kind: 'system', cycleId,
          body: `Auto-apply is on — ${picks.length} standard component${picks.length === 1 ? '' : 's'} selected for this build: ${picks.map((c) => c.key).join(', ')}.`,
        });
      }
    } catch (e) { console.warn('[mock2] component auto-apply failed:', e?.message); }
  }

  // Targeted auth-wiring upgrade: a selection installed from a version that
  // CANNOT wire the sign-in/first-admin bootstrap, while the component's
  // current version can (the seeded bundle), is re-confirmed here so this same
  // run reinstalls it wired. Converges in one pass — after the reinstall the
  // pinned version wires and the check skips. Keep-existing semantics still
  // protect files a build already adapted.
  try {
    for (const r of listProjectComponents(projectId)) {
      if (r.status !== 'installed') continue;
      const pinned = r.version_id ? getComponentVersion(r.version_id) : null;
      if (versionWiresBootstrap(pinned)) continue;
      const found = getPublishedComponentWithVersion(r.key);
      if (!found || found.version.id === r.version_id || !versionWiresBootstrap(found.version)) continue;
      decideProjectComponent({
        projectId, componentId: r.component_id, versionId: found.version.id,
        status: 'confirmed', origin: 'auto', decidedBy: initiatedBy,
      });
      insertMessage({
        projectId, kind: 'system', cycleId,
        body: `Component ${r.key} is being upgraded to v${found.version.version} — the installed version could not wire the sign-in/first-admin bootstrap. Reinstalling now (files a build already adapted are kept).`,
      });
    }
  } catch (e) { console.warn('[mock2] component wiring upgrade check failed:', e?.message); }

  // NO early return when nothing is freshly installable: the repair passes
  // below must still run for selections already marked 'installed' — healing
  // installed-but-broken state is their whole point, and that state has, by
  // definition, no confirmed/install_failed rows left.
  const rows = listProjectComponents(projectId).filter((r) => INSTALLABLE.has(r.status));
  const containerName = project.container_name || containerNameForProject(projectId);

  const installed = [];
  const failedRows = [];
  for (const row of rows) {
    let result;
    try {
      result = await installOne({ containerName, row });
    } catch (err) {
      result = { ok: false, error: err?.message || String(err) };
    }
    if (result.ok) {
      markProjectComponentInstall({ id: row.id, ok: true, versionId: result.version.id, manifest: result.manifest });
      installed.push({ row, ...result });
    } else {
      markProjectComponentInstall({ id: row.id, ok: false, error: result.error });
      failedRows.push({ row, error: result.error });
    }
    try {
      logAudit(initiatedBy, 'MOCK2_COMPONENT_PREINSTALL', 'mock2_component', row.component_id, {
        project_id: projectId, cycle_id: cycleId, key: row.key,
        ok: result.ok, ...(result.ok ? result.counts : { error: String(result.error).slice(0, 300) }),
      }, null);
    } catch (e) { console.warn('[mock2] preinstall audit log failed:', e?.message); }
  }

  // First installs (every file written, nothing kept) get their contracts'
  // fresh_value entries — but only once the DATA probe confirms fresh storage:
  // "nothing kept" says the files are new, not that the database is. A fresh
  // app starts with, for instance, an EMPTY legacy-key list; new files over an
  // existing or restored database keep the component's default bridge, and a
  // probe that could not run is reported and treated as not fresh.
  try {
    const freshContracts = installed.filter((i) => i.counts && i.counts.kept === 0).map((i) => i.contract);
    if (freshContracts.length) {
      const storage = await storageIsFresh({ containerName, contracts: freshContracts, newlyProvisioned });
      const fresh = await ensureFreshEnvValues({ containerName, contracts: freshContracts, freshStorage: storage.fresh });
      if (fresh.written.length) {
        insertMessage({ projectId, kind: 'system', cycleId, body: `Fresh install with fresh storage: set ${fresh.written.join(', ')} in the container environment (no earlier data to migrate).` });
      } else if (!storage.fresh) {
        insertMessage({ projectId, kind: 'system', cycleId, body: `New component files, but the storage is not confirmed fresh — existing keys are preserved and the legacy bridge stays enabled: ${storage.reasons.join('; ')}.` });
      }
      if (!fresh.ok) console.warn(`[mock2] fresh env values failed for project ${projectId}: ${fresh.error}`);
    }
  } catch (e) { console.warn('[mock2] fresh env values failed:', e?.message); }

  // Repair pass over selections already marked 'installed' (they were filtered
  // out of INSTALLABLE above and never re-run installOne): verify their declared
  // deps exist in node_modules and reinstall the missing ones. Heals projects
  // provisioned under the old silent-npm-failure bug without a manual step.
  let ensured = { ok: true, repaired: [], failed: [] };
  try {
    ensured = await ensureComponentDeps({ containerName, rows: listProjectComponents(projectId) });
  } catch (e) { console.warn('[mock2] component dep repair failed:', e?.message); }
  for (const f of ensured.failed) failedRows.push(f);

  // The secrets the installed components own are minted here, before the
  // build's first turn, so the app never boots on a dev default (the deploy
  // step re-checks and refuses to start production mode without them).
  try {
    // Data-guarded keys are minted here only on a newly provisioned container
    // (nothing runs yet); on an existing app the deploy mints them after it
    // stops the app (writersStopped) — never beside a running writer.
    const secrets = await ensureComponentSecrets({ containerName, rows: listProjectComponents(projectId), newlyProvisioned });
    if (secrets.minted.length) {
      insertMessage({
        projectId, kind: 'system', cycleId,
        body: `Minted ${secrets.minted.length} application secret(s) into the container environment (${secrets.minted.join(', ')}). Values stay in the container; the app reads them at start.`,
      });
    }
    const deferredNote = deferredSecretsMessage(secrets.deferred);
    if (deferredNote) insertMessage({ projectId, kind: 'system', cycleId, body: deferredNote });
    if (!secrets.ok) console.warn(`[mock2] component secret minting failed for project ${projectId}: ${secrets.error}`);
  } catch (e) { console.warn('[mock2] component secret minting failed:', e?.message); }

  // Restore scaffold deps a corrupted package.json lost (see ensureScaffoldDeps)
  // — the deploy's install step materializes them (`npm ci` fails on the now
  // out-of-sync lockfile and falls back to `npm install`, which resolves both).
  let scaffoldDeps = { ok: true, added: [] };
  try {
    scaffoldDeps = await ensureScaffoldDeps({ containerName });
  } catch (e) { console.warn('[mock2] scaffold dep repair failed:', e?.message); }

  // Bring an already-provisioned container's Node runtime up to >= 20 (see
  // ensureNodeRuntime) — containers never re-run their setup script on their
  // own, so this is the only path that reaches a project provisioned before
  // the Node 20 template change. Every build funnels through here, so this
  // heals the whole fleet without an operator action.
  try {
    const nodeRuntime = await ensureNodeRuntime({ containerName });
    if (nodeRuntime.changed) {
      insertMessage({
        projectId, kind: 'system', cycleId,
        body: `Upgraded this container's Node runtime to ${nodeRuntime.version} (the e2e gate needs 20+; this project was provisioned before that landed).`,
      });
    } else if (!nodeRuntime.ok) {
      console.warn(`[mock2] node runtime repair did not confirm a usable Node for project ${projectId}: ${nodeRuntime.detail}`);
    }
  } catch (e) { console.warn('[mock2] node runtime repair failed:', e?.message); }

  // Wiring repair pass: selections already 'installed' never re-run installOne,
  // so fixes to the WIRED entry files (e.g. mounting the /_preview mockup
  // preview BEFORE the bootstrap gate — behind it, a fresh app with zero users
  // 302'd the preview iframe to /login and the design was unreviewable) would
  // otherwise never reach provisioned projects. planAuthWiring is idempotent:
  // current content → 'already-wired'; a historical wired/seed generation
  // (hash-matched) → rewritten; anything a build adapted → kept, untouched.
  try {
    const wireRow = listProjectComponents(projectId).find(
      (r) => r.status === 'installed' && r.version_id && versionWiresBootstrap(getComponentVersion(r.version_id)),
    );
    if (wireRow) {
      const version = getComponentVersion(wireRow.version_id);
      let vFiles = [];
      try { vFiles = JSON.parse(version.files_json || '[]') || []; } catch { vFiles = []; }
      const vs = await containerSh(
        containerName,
        buildManifestVerifyScript(AUTH_WIRING_TARGETS, { appDir: APP_DIR }),
        { timeoutMs: 60000 },
      );
      const plan = planAuthWiring({
        contract: parseContractJson(version.contract_json),
        files: vFiles,
        currentShaByPath: parseShaVerifyOutput(vs.stdout),
      });
      const rewired = [];
      for (const a of plan.actions) {
        if (a.action !== 'wire') continue;
        const w = await writeFileInContainer(containerName, a.path, a.content);
        if (w.ok) rewired.push(a.path);
        else console.warn(`[mock2] wiring repair write failed for ${a.path}: ${w.error || 'write failed'}`);
      }
      if (rewired.length) {
        insertMessage({
          projectId, kind: 'system', cycleId,
          body: `Platform maintenance: refreshed the wired entry file${rewired.length === 1 ? '' : 's'} ${rewired.join(' + ')} to the current base-app wiring (files a build adapted are never touched).`,
        });
      }
    }
  } catch (e) { console.warn('[mock2] auth wiring repair failed:', e?.message); }

  // Mirror the full selection to state/components.json (rides the hash-chained
  // history like integrations.json), checkpoint, and record the change. Skipped
  // when the project has no component selections at all (nothing to mirror —
  // and this now runs on every build, not only when something was installable).
  try {
    const all = listProjectComponents(projectId).map((r) => {
      const shape = publicProjectComponentShape(r);
      const contract = parseContractJson(r.contract_json);
      // The installed file paths (from the verified install manifest) — the
      // component-reuse gate needs them to tell adaptation (edits inside these
      // paths) from reimplementation (parallel copies / re-registered endpoints
      // outside them).
      let files;
      try {
        const manifest = r.install_manifest_json ? JSON.parse(r.install_manifest_json) : null;
        files = Array.isArray(manifest) ? manifest.map((m) => m.path).filter(Boolean) : undefined;
      } catch { files = undefined; }
      return {
        key: shape.key, version: shape.version, status: shape.status, origin: shape.origin,
        options: shape.options, installed_at: shape.installed_at,
        api: contract?.api, files,
      };
    });
    if (all.length) await writeFileInContainer(containerName, COMPONENTS_STATE_PATH, buildComponentsStateDoc(all));
    if (installed.length) {
      const summary = `Installed component${installed.length === 1 ? '' : 's'}: ${installed.map((i) => `${i.component.key} v${i.version.version}`).join(', ')} (platform pre-install — no build credits)`;
      const cp = buildCheckpointScript({ appDir: APP_DIR, message: `mock2: ${summary}` });
      await containerSh(containerName, cp, { timeoutMs: 120000 });
      const sha = await containerSh(containerName, `git -C "${APP_DIR}" rev-parse HEAD 2>/dev/null`);
      const framework = getCurrentFrameworkVersion();
      try {
        const record = insertChangeRecord({
          projectId, cycleId, initiatedBy, actingAsAdmin,
          frameworkVersion: framework?.version ?? 0, frameworkVersionId: framework?.id ?? null,
          rulesTouched: null, gatesRun: null,
          commitSha: (sha.stdout || '').trim().split('\n').pop() || null, summary,
        });
        if (record) {
          await writeFileInContainer(containerName, `state/changes/${record.seq}.json`, JSON.stringify(changeRecordMirror(record), null, 2));
          await containerSh(containerName, buildCheckpointScript({ appDir: APP_DIR, message: `mock2: change record ${record.seq}` }), { timeoutMs: 120000 });
        }
      } catch (e) { console.warn('[mock2] preinstall change record failed:', e?.message); }
    }
  } catch (e) { console.warn('[mock2] components state mirror failed:', e?.message); }

  // The visible record in the build chat: what landed (and what failed).
  try {
    if (installed.length) {
      const lines = installed.map((i) => `- ${i.component.key} v${i.version.version} — ${i.counts.written} files written, ${i.counts.kept} kept, ${i.counts.migrations} migration(s) queued${i.counts.connections ? `, ${i.counts.connections} connection(s) declared` : ''}${i.counts.wired ? `, auth bootstrap WIRED into ${i.wired.join(' + ')} (sign-in + first-admin flow live)` : ''}${i.counts.wiringKept ? `, wiring kept out of adapted ${i.wiringKept.join(' + ')}` : ''}`);
      insertMessage({
        projectId, kind: 'system', cycleId,
        body: `Standard components installed by the platform (0 build credits):\n${lines.join('\n')}\nThe build will wire the design to their APIs.`,
      });
    }
    if (ensured.repaired.length) {
      const lines = ensured.repaired.map((r) => `- ${r.key}: reinstalled ${r.missing.join(', ')}`);
      insertMessage({
        projectId, kind: 'system', cycleId,
        body: `Repaired missing component dependencies (a past install reported success but npm had failed):\n${lines.join('\n')}`,
      });
    }
    if (scaffoldDeps.added?.length) {
      insertMessage({
        projectId, kind: 'system', cycleId,
        body: `Restored scaffold dependencies that had been lost from package.json: ${scaffoldDeps.added.join(', ')} — the deploy's install step lands them.`,
      });
    }
    for (const f of failedRows) {
      insertMessage({ projectId, kind: 'system', cycleId, body: `Component install failed for ${f.row.key}: ${f.error} — fix the cause and press Build to retry.` });
    }
  } catch (e) { console.warn('[mock2] preinstall chat message failed:', e?.message); }

  return { ok: failedRows.length === 0, installed, failed: failedRows, at: nowIso() };
}
