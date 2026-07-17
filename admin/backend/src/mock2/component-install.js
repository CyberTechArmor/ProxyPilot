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
  listProjectComponents, getPublishedComponentWithVersion, markProjectComponentInstall,
} from './components.js';
import {
  parseFilesJson, parseContractJson, safeComponentPath,
  buildComponentManifest, buildPathsExistScript, parsePathsExistOutput,
  buildManifestVerifyScript, parseShaVerifyOutput,
  planMigrationRenumber, mergeEnvDefaults, manifestEntryFromConnection,
  deriveComponentSubsystem, buildComponentsStateDoc, publicProjectComponentShape,
  COMPONENTS_STATE_PATH,
} from './component-logic.js';
import { backfillManifestEntryInContainer } from './integration-enforcement.js';
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

  // 4) Declared dependencies (the contract's structured npm installs — no
  //    usage_md parsing). The fence's egress proxy already allows npm.
  const deps = contract?.dependencies;
  const runtime = [...(deps?.runtime || []), ...(deps?.peers || [])];
  if (runtime.length) {
    const r = await execInContainer(containerName, `npm install --no-audit --no-fund ${runtime.join(' ')} 2>&1 | tail -5`);
    if (r.code !== 0) return { ok: false, error: `npm install failed for ${row.key}: ${(r.stdout || r.stderr || '').trim().slice(-300)}` };
  }
  if (deps?.dev?.length) {
    const r = await execInContainer(containerName, `npm install -D --no-audit --no-fund ${deps.dev.join(' ')} 2>&1 | tail -5`);
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
  };
  return { ok: true, component, version, contract, manifest, counts };
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
      const lines = installed.map((i) => `- ${i.component.key} v${i.version.version} — ${i.counts.written} files written, ${i.counts.kept} kept, ${i.counts.migrations} migration(s) queued${i.counts.connections ? `, ${i.counts.connections} connection(s) declared` : ''}`);
      insertMessage({
        projectId, kind: 'system', cycleId,
        body: `Standard components installed by the platform (0 build credits):\n${lines.join('\n')}\nThe build will wire the design to their APIs.`,
      });
    }
    for (const f of failedRows) {
      insertMessage({ projectId, kind: 'system', cycleId, body: `Component install failed for ${f.row.key}: ${f.error} — fix the cause and press Build to retry.` });
    }
  } catch (e) { console.warn('[mock2] preinstall chat message failed:', e?.message); }

  return { ok: failedRows.length === 0, installed, failed: failedRows, at: nowIso() };
}
