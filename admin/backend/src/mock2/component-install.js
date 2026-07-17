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
  markProjectComponentInstall, decideProjectComponent,
} from './components.js';
import { getComponentAutoApply } from './settings.js';
import {
  parseFilesJson, parseContractJson, safeComponentPath, selectAutoApplyComponents,
  buildComponentManifest, buildPathsExistScript, parsePathsExistOutput,
  buildManifestVerifyScript, parseShaVerifyOutput,
  planMigrationRenumber, mergeEnvDefaults, manifestEntryFromConnection,
  deriveComponentSubsystem, buildComponentsStateDoc, publicProjectComponentShape,
  COMPONENTS_STATE_PATH,
} from './component-logic.js';
import { backfillManifestEntryInContainer } from './integration-enforcement.js';
import { componentWiresBootstrap, planAuthWiring, AUTH_WIRING_TARGETS } from './scaffold-auth.js';
import { buildCheckpointScript } from './template.js';
import { insertChangeRecord, changeRecordMirror } from './change-records.js';
import { getCurrentFrameworkVersion } from './framework.js';
import { insertMessage } from './chats.js';

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

// ---- the pre-install pass (all confirmed selections for a project) ----

// preinstallComponents — install every confirmed (or previously failed)
// selection into the project container, mirror the selection to
// state/components.json, checkpoint with a hash-chained change record, and post
// a chat message so the record of WHAT the build uses is visible where the
// build happens. Returns { ok, installed, failed } — ok is false when any
// selection failed (the caller blocks the build; pressing Build again retries).
export async function preinstallComponents({ project, initiatedBy = null, actingAsAdmin = 0, cycleId = null }) {
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

  const rows = listProjectComponents(projectId).filter((r) => INSTALLABLE.has(r.status));
  if (!rows.length) return { ok: true, installed: [], failed: [] };
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

  // Repair pass over selections already marked 'installed' (they were filtered
  // out of INSTALLABLE above and never re-run installOne): verify their declared
  // deps exist in node_modules and reinstall the missing ones. Heals projects
  // provisioned under the old silent-npm-failure bug without a manual step.
  let ensured = { ok: true, repaired: [], failed: [] };
  try {
    ensured = await ensureComponentDeps({ containerName, rows: listProjectComponents(projectId) });
  } catch (e) { console.warn('[mock2] component dep repair failed:', e?.message); }
  for (const f of ensured.failed) failedRows.push(f);

  // Mirror the full selection to state/components.json (rides the hash-chained
  // history like integrations.json), checkpoint, and record the change.
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
    await writeFileInContainer(containerName, COMPONENTS_STATE_PATH, buildComponentsStateDoc(all));
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
    for (const f of failedRows) {
      insertMessage({ projectId, kind: 'system', cycleId, body: `Component install failed for ${f.row.key}: ${f.error} — fix the cause and press Build to retry.` });
    }
  } catch (e) { console.warn('[mock2] preinstall chat message failed:', e?.message); }

  return { ok: failedRows.length === 0, installed, failed: failedRows, at: nowIso() };
}
