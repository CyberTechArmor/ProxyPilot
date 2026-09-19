// Components, standards, and project lifecycle / configuration over MCP.
//
//   components   list / get / import / install / uninstall / versions
//   standards    get_standards_version / upgrade_project_standards / set_standards_source
//   lifecycle    delete_project (export first + confirmation token) / rename_project / set_project_domain
//   secrets      set_project_env (write-only) / list_project_env_keys — /etc/environment in the guest,
//                which deploy.js sources for every build and start
//   egress       approve_egress / list_egress_requests
//   resources    set_project_resources (guest limits) / set_project_build_settings (provider + budget)
//   git          pull_git_remote / create_branch / switch_branch / merge_branch / tag_release
//   references   list / get / delete
//   database     run_project_sql (read-only) / dump_project_db / restore_project_db
//   CPR          list_releases / snapshot_before_promote / promote_release / rollback_release —
//                a platform-side release registry (state/releases.json + git tags); promote deploys
//                a tag's tree through a promote commit, rollback promotes the previous entry.

import { basename } from 'node:path';
import { readStandardsSeedVersion, fetchStandardsManifest } from '../../lib/self-update.js';
import {
  intIn, stamp, sha256Hex, validGitRefName, validateEnvVars, mergeEnvFile, envFileKeys, readOnlySqlError,
  parseReleases, renderReleases, RELEASES_PATH, pathUnder,
} from '../../lib/mcp-ext/logic.js';

const STANDARDS_SOURCE_KEY = 'mcp.standards_source_url';
const DB_DUMPS_DIR = '/var/backups/proxypilot-db';

export function createProjectConfigHandlers(kit) {
  const { ctx, ok, err, mutation, reader, confirmToken, confirmFlag, dry, projectSh, hostSh, tail, policy } = kit;
  const {
    getSetting, setSetting, runHostCapture, mock2Modules, projectContainerName, requireActiveProject, liveBuildGuard,
    commitProjectPaths, verifiedContainerWrite, readProjectText, M2_APP_DIR, projectUrl, takeLxcSnapshot, defaultSnapshotName,
    fetchLxcInstance, lxcContainerDetail, projectSummary,
  } = ctx;
  const EXPORTS = policy.exports_dir;

  async function extra() {
    const [components, componentLogic, componentInstall, egressGrants, egressLogic, firewall, quotas, phaseRouting, baseApp, auditLogic, queue, publish, caddy, deploy, domainLogicM, mock2Db] = await Promise.all([
      import('../../mock2/components.js'), import('../../mock2/component-logic.js'), import('../../mock2/component-install.js'),
      import('../../mock2/egress-grants.js'), import('../../mock2/egress-logic.js'), import('../../mock2/firewall.js'),
      import('../../mock2/quotas.js'), import('../../mock2/phase-routing-logic.js'), import('../../mock2/base-app-upgrade.js'),
      import('../../mock2/audit-logic.js'), import('../../mock2/queue.js'), import('../../mock2/publish.js'), import('../../mock2/caddy.js'),
      import('../../mock2/deploy.js'), import('../../mock2/domain-logic.js'), import('../../mock2/db.js'),
    ]);
    return { components, componentLogic, componentInstall, egressGrants, egressLogic, firewall, quotas, phaseRouting, baseApp, auditLogic, queue, publish, caddy, deploy, domainLogic: domainLogicM, mock2Db };
  }

  async function anyProject(args) {
    const m = await mock2Modules();
    const p = m.projects.getProject(Number(args.project_id));
    if (!p) return { error: 'Project not found' };
    return { m, project: p, incusName: projectContainerName(m, p) };
  }
  async function activeProject(args) {
    const m = await mock2Modules();
    const { project: p, error } = requireActiveProject(m, args);
    if (error) return { error };
    return { m, project: p, incusName: projectContainerName(m, p) };
  }
  const git = (incusName, argv, opts = {}) => projectSh(incusName, 'cd /srv/app || exit 97; git -c user.email=mcp@proxypilot -c user.name="ProxyPilot MCP" "$@"', argv, { timeoutMs: 120000, ...opts });

  /* ------------------------------ components ------------------------------ */

  const list_components = reader('list_components', async (args) => {
    const x = await extra();
    const status = args.status ? String(args.status) : null;
    const rows = x.components.listComponents({ status });
    return ok({ count: rows.length, components: rows.map((c) => x.componentLogic.publicComponentShape(c, { currentVersion: x.components.getCurrentComponentVersion(c) })) });
  });

  async function findComponent(x, ref) {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    return (Number.isInteger(Number(s)) ? x.components.getComponent(Number(s)) : null) || x.components.getComponentByKey(s) || null;
  }

  const get_component = reader('get_component', async (args) => {
    const x = await extra();
    const c = await findComponent(x, args.component);
    if (!c) return err('Component not found (id or key)');
    const cur = x.components.getCurrentComponentVersion(c);
    return ok({ component: x.componentLogic.publicComponentShape(c, { currentVersion: cur, includeFiles: args.include_files === true }), versions: x.components.listComponentVersions(c.id).map((v) => x.componentLogic.publicComponentVersionShape(v)) });
  });

  const list_component_versions = reader('list_component_versions', async (args) => {
    const x = await extra();
    const c = await findComponent(x, args.component);
    if (!c) return err('Component not found (id or key)');
    return ok({ component: { id: c.id, key: c.key, name: c.name }, versions: x.components.listComponentVersions(c.id).map((v) => x.componentLogic.publicComponentVersionShape(v, { includeFiles: args.include_files === true })) });
  });

  const import_component = mutation('import_component', { subjectType: 'mock2_component' }, async (args, auth, req, note) => {
    const x = await extra();
    let doc = args.doc;
    if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch (e) { return err(`doc is not valid JSON: ${e?.message}`); } }
    const check = x.componentLogic.parseComponentImport(doc);
    if (!check.ok) return err(check.error);
    const d = check.data;
    note.subject_id = d.key;
    const existing = x.components.getComponentByKey(d.key);
    const reason = String(args.change_reason || '').trim() || `Imported over MCP (${d.key})`;
    const plan = { key: d.key, name: d.name, files: (d.files || []).length, as: existing ? `new version of component ${existing.id}` : 'new component', change_reason: reason };
    const dr = dry(args, plan); if (dr) return dr;
    const gate = confirmFlag(args, note, `Import component ${d.key} (${plan.as}).`); if (gate) return gate;
    let out;
    if (existing) {
      const version = x.components.insertComponentVersion(existing.id, { files: d.files, usage_md: d.usage_md, contract: d.contract, change_reason: reason, source: 'import', createdBy: auth.created_by });
      out = { created: false, component: x.componentLogic.publicComponentShape(x.components.getComponent(existing.id), { currentVersion: version }) };
    } else {
      const { component, version } = x.components.insertComponent({ key: d.key, name: d.name, description: d.description, category: d.category, tags: d.tags, files: d.files, usage_md: d.usage_md, contract: d.contract, change_reason: reason, source: 'import', createdBy: auth.created_by });
      out = { created: true, component: x.componentLogic.publicComponentShape(component, { currentVersion: version }) };
    }
    note.summary = `imported component ${d.key} (${plan.as})`;
    note.detail = plan;
    return ok({ imported: true, ...out });
  });

  const install_component = mutation('install_component', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const x = await extra();
    const c = await findComponent(x, args.component);
    if (!c) return err('Component not found (id or key)');
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    const cur = x.components.getCurrentComponentVersion(c);
    const existing = x.components.getProjectComponent(p.project.id, c.id);
    const plan = { project_id: p.project.id, component: { id: c.id, key: c.key, name: c.name, version: cur?.version || null }, current_status: existing?.status || 'not selected', runs: 'the deterministic zero-token pre-install (files materialized, deps ensured)' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Install component ${c.key}@${cur?.version || '?'} into ${p.project.name}.`); if (gate) return gate;
    x.components.decideProjectComponent({ projectId: p.project.id, componentId: c.id, versionId: cur?.id || null, status: 'confirmed', origin: 'operator', decidedBy: auth.created_by });
    let result;
    try { result = await x.componentInstall.preinstallComponents({ project: p.m.projects.getProject(p.project.id), initiatedBy: auth.created_by, actingAsAdmin: 1 }); } catch (e) { return err(`Install failed: ${e?.message || e}`); }
    const mine = result.installed.find((i) => i.component.key === c.key);
    const failed = result.failed.find((f) => f.row.key === c.key);
    note.summary = `installed component ${c.key}`;
    note.detail = { key: c.key, ok: !!mine, error: failed?.error || null };
    if (failed) return err(`Component ${c.key} did not install: ${failed.error}`);
    return ok({ installed: true, component: c.key, version: mine?.version?.version || cur?.version || null, counts: mine?.counts || null, components: x.components.listProjectComponents(p.project.id).map((r) => x.componentLogic.publicProjectComponentShape(r)), next: 'Read its usage notes with get_component and wire it in with apply_project_patch, then redeploy_project.' });
  });

  const uninstall_component = mutation('uninstall_component', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const x = await extra();
    const c = await findComponent(x, args.component);
    if (!c) return err('Component not found (id or key)');
    const existing = x.components.getProjectComponent(p.project.id, c.id);
    if (!existing) return err(`${c.key} is not selected on this project`);
    const plan = { project_id: p.project.id, component: c.key, current_status: existing.status, sets_status: 'rejected', files: 'kept in the checkout (CPR §7.4: package removal never drops feature data or code); remove them with delete_project_file / apply_project_patch if wanted' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Unselect component ${c.key} from ${p.project.name} (files stay; future builds stop receiving its usage notes).`); if (gate) return gate;
    x.components.decideProjectComponent({ projectId: p.project.id, componentId: c.id, status: 'rejected', origin: 'operator', decidedBy: auth.created_by });
    note.summary = `unselected component ${c.key}`;
    note.detail = plan;
    return ok({ uninstalled: true, ...plan, components: x.components.listProjectComponents(p.project.id).map((r) => x.componentLogic.publicProjectComponentShape(r)) });
  });

  /* ------------------------------- standards ------------------------------ */

  const get_standards_version = reader('get_standards_version', async (args) => {
    const m = await mock2Modules();
    const x = await extra();
    const current = m.framework.getCurrentFrameworkVersion();
    const seed = readStandardsSeedVersion();
    const source = getSetting(STANDARDS_SOURCE_KEY) || null;
    const site = args.check_site === false ? null : await fetchStandardsManifest(source ? { url: source } : {});
    const out = { framework: current ? { id: current.id, version: current.version, source: current.source, source_git_commit: current.source_git_commit, created_at: current.created_at, changelog: current.changelog } : null, seed, standards_source: source || seed.manifest, site, versions: m.framework.listFrameworkVersions().slice(0, 10) };
    if (args.project_id != null) {
      const p = m.projects.getProject(Number(args.project_id));
      if (!p) return err('Project not found');
      out.project = { id: p.id, last_built_framework_version_id: p.last_built_framework_version_id ?? null, drifted: x.auditLogic.isFrameworkDrifted(p.last_built_framework_version_id, current?.id), base_app: await x.baseApp.baseAppUpgradeStatus(p) };
    }
    return ok(out);
  });

  const upgrade_project_standards = mutation('upgrade_project_standards', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const x = await extra();
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    const status = await x.baseApp.baseAppUpgradeStatus(p.project);
    const current = p.m.framework.getCurrentFrameworkVersion();
    const drifted = x.auditLogic.isFrameworkDrifted(p.project.last_built_framework_version_id, current?.id);
    const plan = { project_id: p.project.id, base_app: status, framework: { current: current?.version || null, project_last_built: p.project.last_built_framework_version_id ?? null, drifted }, does: 'the base-app top-up (platform files re-materialized from the seed, additive) now; the framework pin moves on the next build' };
    const d = dry(args, plan); if (d) return d;
    if (!status.upgrade_available && !drifted && args.force !== true) return ok({ applied: false, ...plan, note: 'Already current. Pass force: true to re-materialize the platform files anyway.' });
    const gate = confirmFlag(args, note, `Top up ${p.project.name} to the current standards (base app ${status.current?.platform || '?'}, framework ${current?.version || '?'}).`); if (gate) return gate;
    let out;
    try { out = await x.baseApp.upgradeBaseApp(p.project, { initiatedBy: auth.created_by, reason: 'mcp' }); } catch (e) { return err(`Could not update the base app: ${e?.message || e}`); }
    if (!out.ok) return err(out.error);
    note.summary = `standards top-up (base app: ${out.changed ? 'updated' : 'unchanged'})`;
    note.detail = { changed: out.changed, files: out.written?.length || 0, drifted };
    return ok({ applied: true, changed: out.changed, message: out.message, paths: out.plan?.paths || [], framework_drifted: drifted, next: drifted ? 'The next start_project_build adopts the current framework version and clears the drift banner.' : 'redeploy_project makes the updated platform files live.' });
  });

  const set_standards_source = mutation('set_standards_source', { subjectType: 'setting' }, async (args, auth, req, note) => {
    note.subject_id = STANDARDS_SOURCE_KEY;
    const url = args.url === null || args.url === '' ? null : String(args.url || '').trim();
    if (url && !/^https:\/\/[^\s]+\/manifest\.json$/.test(url)) return err('url must be an https URL ending in /manifest.json (a mock2-core release / site manifest), or null to use the seed default');
    const current = getSetting(STANDARDS_SOURCE_KEY) || null;
    let probe = null;
    if (url) { probe = await fetchStandardsManifest({ url }); if (probe.error) return err(`That manifest is not reachable: ${probe.error}`); }
    const d = dry(args, { current, url, manifest: probe }); if (d) return d;
    const gate = confirmFlag(args, note, `Pin the standards source to ${url || 'the seed default'} (currently ${current || 'seed default'}).`); if (gate) return gate;
    setSetting(STANDARDS_SOURCE_KEY, url || '');
    note.summary = `standards source ${url ? `pinned to ${url}` : 'reset to seed default'}`;
    note.detail = { previous: current, url };
    return ok({ applied: true, previous: current, url, manifest: probe, note: 'get_standards_version and check_proxypilot_update compare the seed against this manifest; the seed itself still updates with ProxyPilot (docs/mock2/standards-and-cpr.md §3).' });
  });

  /* ------------------------------- lifecycle ------------------------------ */

  const delete_project = mutation('delete_project', { subjectType: 'mock2_project', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id;
    const x = await extra();
    if (p.project.lifecycle === 'archived') return err('Archived projects are read-only and cannot be deleted (rehydrate first)');
    if (p.project.lifecycle === 'provisioning') return err('The project is still provisioning');
    const pinned = p.m.projects.pinnedProjectIdSet().has(p.project.id);
    if (pinned) { note.refused = true; return err(`${p.project.name} is pinned — unpin it (set_project_pinned) before deleting`); }
    const live = p.m.cycles.listCyclesForProject(p.project.id, { limit: 20 }).some((c) => ['queued', 'estimating', 'running'].includes(c.status));
    if (live) { note.refused = true; return err('A build is running — interrupt_project_build first'); }
    const inst = await fetchLxcInstance(p.incusName);
    const hasContainer = !!inst.instance;
    const plan = { project_id: p.project.id, name: p.project.name, url: projectUrl(p.project, p.m.domains), container: p.incusName, container_present: hasContainer, export_first: hasContainer && args.export !== false ? `${EXPORTS}/lxc-${p.incusName}-<timestamp>.tar.gz (checkpoint-committed first)` : 'SKIPPED', removes: ['project row', 'routes + certs', 'container + bridge', 'bare repo', 'slug reservations'], keeps: ['the export tarball', 'chat history, change records and ledger rows in mock2.db (orphaned by project id)'] };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'delete_project', subject: String(p.project.id), action: `permanently delete project "${p.project.name}" (${plan.url || 'no url'}) — container, repo, routes and certs`, preview: plan });
    if (gate) return gate;
    let exported = null;
    if (hasContainer && args.export !== false) {
      await projectSh(p.incusName, p.m.template.buildCheckpointScript({ appDir: M2_APP_DIR, message: 'checkpoint: pre-delete (mcp)' }), [], { timeoutMs: 120000 }).catch(() => null);
      await hostSh('mkdir -p "$1" && chmod 750 "$1"', [EXPORTS], { timeoutMs: 10000 });
      const file = `${EXPORTS}/lxc-${p.incusName}-${stamp()}.tar.gz`;
      const r = await runHostCapture('incus', ['export', p.incusName, file], { timeoutMs: 45 * 60 * 1000 });
      if (r.status !== 0) return err(`Nothing was deleted: incus export failed (${tail(r.stderr) || 'timed out'}). Pass export: false to delete without a tarball (the ledger records it).`);
      exported = file;
      note.snapshot = file;
    } else if (hasContainer) note.detail.export_skipped = true;
    const project = p.project;
    p.m.projects.deleteProject(project.id);
    x.queue.resolveQueueItem(`mock2-provision:${project.id}`, { resolution: 'project deleted (mcp)' });
    x.queue.resolveQueueItem(`mock2-flag:${project.id}`, { resolution: 'project deleted (mcp)' });
    let caddy = { ok: true };
    if (project.parent_domain_id) {
      caddy = await x.publish.publishDomain(project.parent_domain_id).catch((e) => ({ ok: false, error: e?.message }));
      try {
        const domain = p.m.domains.getParentDomain(project.parent_domain_id);
        if (domain) {
          const fqdns = [...new Set([project.slug, ...p.m.projects.listProjectSlugs(project.id)].filter(Boolean).map((s) => `${s}.${domain.domain}`))];
          if (project.custom_domain) fqdns.push(project.custom_domain);
          await x.caddy.removeMock2Certs(fqdns);
        }
      } catch (e) { note.detail.cert_cleanup_error = e?.message || String(e); }
    }
    try { p.m.projects.purgeProjectSlugHistory(project.id); } catch (e) { note.detail.slug_purge_error = e?.message || String(e); }
    const teardown = await p.m.provision.teardownProject({ containerName: p.incusName, projectId: project.id, repoPath: project.repo_path, removeRepo: true }).catch((e) => ({ error: e?.message || String(e) }));
    await Promise.all([x.firewall.reconcileMock2Firewall().catch(() => null), (async () => { try { const eg = await import('../../mock2/egress.js'); await eg.reconcileMock2Egress(); } catch { /* ignore */ } })()]);
    note.summary = `deleted project ${project.name}`;
    note.detail = { ...note.detail, name: project.name, slug: project.slug, export: exported };
    return ok({ deleted: true, project_id: project.id, name: project.name, export: exported, caddy, teardown: { container: teardown.container?.code ?? teardown.container?.status ?? null, bridge: teardown.bridge?.ok ?? null, repo: teardown.repo ? 'removed' : 'kept/none', ...(teardown.error ? { error: teardown.error } : {}) }, reverse_with: exported ? `import_lxc({ name: "<new-name>", file: "${basename(exported)}" }) restores the guest as a plain LXC container (the project row itself is gone)` : null });
  });

  const rename_project = mutation('rename_project', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const name = args.name != null ? String(args.name).trim().slice(0, 120) : null;
    const description = args.description != null ? String(args.description).trim().slice(0, 2000) : null;
    if (!name && description == null) return err('Pass name and/or description');
    if (name != null && name.length < 2) return err('name must be at least 2 characters');
    const patch = { ...(name ? { name } : {}), ...(description != null ? { description } : {}) };
    const d = dry(args, { project_id: p.project.id, current: { name: p.project.name, description: p.project.description }, patch, note: 'The slug/URL does not change (rotate it from the dashboard).' }); if (d) return d;
    const gate = confirmFlag(args, note, `Rename project ${p.project.id} "${p.project.name}" → "${name || p.project.name}".`); if (gate) return gate;
    const updated = p.m.projects.updateProject(p.project.id, patch);
    note.summary = `renamed project ${p.project.name} → ${updated.name}`;
    note.detail = { previous_name: p.project.name, ...patch };
    return ok({ applied: true, project: projectSummary(updated, p.m), previous: { name: p.project.name, description: p.project.description } });
  });

  const set_project_domain = mutation('set_project_domain', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    if (p.project.lifecycle === 'archived') return err('Archived projects are read-only');
    if (!p.project.parent_domain_id) return err('Custom domains attach to a slug-based project');
    const x = await extra();
    const clear = args.custom_domain === null || args.custom_domain === '';
    let domain = null;
    if (!clear) {
      const v = x.domainLogic.validateDomain(args.custom_domain);
      if (!v.ok) return err(v.error);
      domain = v.domain;
      const claim = p.m.domains.baseDomainStatus(domain, { excludeProjectId: p.project.id });
      if (!claim.available) return err(`"${domain}" is already served by ${claim.claimed_by?.label || 'another service'}`);
    }
    const plan = { project_id: p.project.id, current: p.project.custom_domain || null, custom_domain: domain, default_url: projectUrl(p.project, p.m.domains) };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, domain ? `Serve ${p.project.name} on ${domain} as well as its slug URL.` : `Remove the custom domain ${p.project.custom_domain} from ${p.project.name}.`); if (gate) return gate;
    const updated = p.m.projects.updateProject(p.project.id, { custom_domain: domain });
    const caddy = await x.publish.publishDomain(p.project.parent_domain_id).catch((e) => ({ ok: false, error: e?.message }));
    note.summary = domain ? `custom domain ${domain}` : 'custom domain removed';
    note.detail = { previous: p.project.custom_domain || null, custom_domain: domain };
    return ok({ applied: true, ...plan, custom_domain: updated.custom_domain, caddy, next: domain ? `Point an A record for ${domain} at this host (set_dns_record if Cloudflare manages it), then test_route({ domain: "${domain}" }).` : undefined });
  });

  /* ------------------------------- env / secrets --------------------------- */

  const ENV_FILE = '/etc/environment';

  const list_project_env_keys = reader('list_project_env_keys', async (args) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    const r = await projectSh(p.incusName, 'cat /etc/environment 2>/dev/null || true', [], { timeoutMs: 15000 });
    return ok({ project_id: p.project.id, file: ENV_FILE, keys: envFileKeys(r.stdout), note: 'Values are never returned. deploy.js sources this file for every build, migrate and start.' });
  });

  const set_project_env = mutation('set_project_env', { subjectType: 'mock2_project', keepArgs: [] }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const v = validateEnvVars(args.vars);
    if (v.error) return err(v.error);
    const keys = Object.keys(v.vars);
    const removes = keys.filter((k) => v.vars[k] === null);
    const r = await projectSh(p.incusName, 'cat /etc/environment 2>/dev/null || true', [], { timeoutMs: 15000 });
    const before = envFileKeys(r.stdout);
    const plan = { project_id: p.project.id, file: ENV_FILE, set: keys.filter((k) => v.vars[k] !== null), remove: removes, existing_keys: before, restart_needed: 'redeploy_project (or restart the dev service) for the running app to see them' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Write ${plan.set.length} variable(s)${removes.length ? ` and remove ${removes.length}` : ''} in ${ENV_FILE} of ${p.project.name} (write-only; values are never read back).`); if (gate) return gate;
    const merged = mergeEnvFile(r.stdout, v.vars);
    const w = await verifiedContainerWrite(p.incusName, ENV_FILE, merged, { keepOld: true, mode: '0644', label: ENV_FILE });
    if (w.error) return err(w.error);
    note.summary = `env: set ${plan.set.join(', ') || 'none'}${removes.length ? `; removed ${removes.join(', ')}` : ''}`;
    note.detail = { set: plan.set, removed: removes };
    return ok({ applied: true, file: ENV_FILE, set: plan.set, removed: removes, keys: envFileKeys(merged), backup: `${ENV_FILE}.old`, next: 'redeploy_project restarts the app with the new environment.' });
  });

  /* --------------------------------- egress -------------------------------- */

  const list_egress_requests = reader('list_egress_requests', async (args) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    const x = await extra();
    const status = args.status ? String(args.status) : null;
    const grants = x.egressGrants.listEgressGrants(p.project.id, { status }).map(x.egressLogic.publicEgressGrantShape);
    let declared = null;
    if (p.project.lifecycle === 'active') { try { declared = await x.deploy.readDeclaredEgress(p.incusName); } catch { declared = null; } }
    return ok({ project_id: p.project.id, grants, pending: grants.filter((g) => g.status === 'pending').length, declared_in_mock2_yaml: declared, note: 'Approve a pending grant (or add an operator grant) with approve_egress; the fence is reconciled immediately.' });
  });

  const approve_egress = mutation('approve_egress', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    if (p.project.lifecycle === 'archived') return err('Archived projects are read-only');
    const x = await extra();
    const decision = args.decision === 'deny' ? 'denied' : args.decision === 'revoke' ? 'revoked' : 'approved';
    let plan; let grant = null;
    if (args.grant_id != null) {
      grant = x.egressGrants.getEgressGrant(Number(args.grant_id));
      if (!grant || grant.project_id !== p.project.id) return err('grant_id not found on this project');
      plan = { project_id: p.project.id, grant: x.egressLogic.publicEgressGrantShape(grant), decision };
    } else {
      if (decision !== 'approved') return err('deny/revoke need a grant_id');
      const host = String(args.host || '').trim(); const port = intIn(args.port, 1, 65535); const protocol = args.protocol === 'udp' ? 'udp' : 'tcp';
      if (!host || !port) return err('host and port are required for a new operator grant');
      plan = { project_id: p.project.id, new_grant: { host, port, protocol, reason: String(args.reason || '').slice(0, 200) }, decision };
    }
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, grant ? `${decision} egress ${grant.host}:${grant.port}/${grant.protocol} for ${p.project.name}.` : `Grant egress ${plan.new_grant.host}:${plan.new_grant.port}/${plan.new_grant.protocol} to ${p.project.name}.`); if (gate) return gate;
    let row;
    if (grant) { x.egressGrants.setEgressGrantStatus(grant.id, decision, { decidedBy: auth.created_by }); row = x.egressGrants.getEgressGrant(grant.id); }
    else {
      const created = x.egressGrants.insertOperatorEgressGrant({ projectId: p.project.id, host: plan.new_grant.host, port: plan.new_grant.port, protocol: plan.new_grant.protocol, reason: plan.new_grant.reason, decidedBy: auth.created_by });
      if (!created.ok) return err(created.error);
      row = x.egressGrants.getEgressGrant(created.grant.id);
    }
    let fence = { ok: true };
    try { await x.firewall.reconcileMock2Firewall(); } catch (e) { fence = { ok: false, error: e?.message || String(e) }; }
    let probe = null;
    if (decision === 'approved') { try { probe = await x.egressGrants.probeEgressGrants([row.id]); } catch { probe = null; } }
    note.summary = `egress ${decision}: ${row.host}:${row.port}/${row.protocol}`;
    note.detail = { grant_id: row.id, decision };
    return ok({ applied: true, decision, grant: x.egressLogic.publicEgressGrantShape(x.egressGrants.getEgressGrant(row.id)), fence, probe });
  });

  /* ------------------------------- resources ------------------------------ */

  const set_project_resources = mutation('set_project_resources', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const changes = [];
    if (args.cpu != null) { const n = intIn(args.cpu, 1, 128); if (!n) return err('cpu must be 1–128'); changes.push(['limits.cpu', String(n)]); }
    if (args.memory_mb != null) { const n = intIn(args.memory_mb, 256, 262144); if (!n) return err('memory_mb must be 256–262144'); changes.push(['limits.memory', `${n}MiB`]); }
    const disk = args.disk_gb != null ? intIn(args.disk_gb, 2, 4096) : null;
    if (args.disk_gb != null && !disk) return err('disk_gb must be 2–4096');
    if (!changes.length && !disk) return err('Pass cpu, memory_mb and/or disk_gb');
    const inst = await fetchLxcInstance(p.incusName);
    if (inst.error || inst.notFound) return err(`Project container ${p.incusName} is not present (${inst.error || 'archived/rehydrate needed'})`);
    const current = lxcContainerDetail(inst.instance).config;
    const plan = { project_id: p.project.id, container: p.incusName, set: Object.fromEntries(changes), root_disk: disk ? `${disk}GiB` : null, current, snapshot_first: true };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Resources on ${p.project.name}'s guest: ${changes.map(([k, v]) => `${k}=${v}`).join(', ')}${disk ? `, root ${disk}GiB` : ''}.`); if (gate) return gate;
    const snap = await takeLxcSnapshot(p.incusName, defaultSnapshotName(new Date(), 'pp-mcp-pre-resources'));
    if (snap.error) return err(`Refusing without a snapshot: ${snap.error}`);
    note.snapshot = snap.name;
    const applied = [];
    for (const [k, v] of changes) {
      const r = await runHostCapture('incus', ['config', 'set', p.incusName, k, v], { timeoutMs: 60000 });
      if (r.status !== 0) return err(`incus config set ${k} failed: ${tail(r.stderr)} (applied: ${applied.join(', ') || 'none'})`);
      applied.push(`${k}=${v}`);
    }
    if (disk) {
      let r = await runHostCapture('incus', ['config', 'device', 'override', p.incusName, 'root', `size=${disk}GiB`], { timeoutMs: 60000 });
      if (r.status !== 0) r = await runHostCapture('incus', ['config', 'device', 'set', p.incusName, 'root', 'size', `${disk}GiB`], { timeoutMs: 60000 });
      if (r.status !== 0) return err(`root disk resize failed: ${tail(r.stderr)} (applied: ${applied.join(', ') || 'none'}; shrinking is refused by the driver)`);
      applied.push(`root.size=${disk}GiB`);
    }
    note.summary = `resources: ${applied.join(', ')}`;
    note.detail = { applied };
    return ok({ applied, container: p.incusName, snapshot: snap.name });
  });

  const set_project_build_settings = mutation('set_project_build_settings', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const x = await extra();
    const patch = {}; const quota = {};
    if (args.provider !== undefined) {
      const pref = args.provider === null || args.provider === '' ? null : x.phaseRouting.normalizeProviderPreference(args.provider);
      if (args.provider && !pref) return err(`provider must be one of ${x.phaseRouting.PROJECT_PROVIDER_PREFS.join(', ')} (or null to clear)`);
      patch.provider_preference = pref;
    }
    if (args.suggest_mode !== undefined) { if (!['ask', 'auto', 'off'].includes(args.suggest_mode)) return err('suggest_mode must be ask, auto or off'); patch.suggest_mode = args.suggest_mode; }
    if (args.clarify_mode !== undefined) { if (!['ask', 'off', 'auto'].includes(args.clarify_mode)) return err('clarify_mode must be ask, auto or off'); patch.clarify_mode = args.clarify_mode; }
    if (args.budget_cents !== undefined) { const n = args.budget_cents === null ? null : intIn(args.budget_cents, 0, 1e8); if (args.budget_cents !== null && n == null) return err('budget_cents must be 0–100000000 (or null for no project cap)'); quota.budgetCents = n; }
    if (args.budget_wall_clock_min !== undefined) { const n = args.budget_wall_clock_min === null ? null : intIn(args.budget_wall_clock_min, 1, 1e6); quota.budgetWallClockMin = n; }
    if (args.max_concurrent_builds !== undefined) { const n = args.max_concurrent_builds === null ? null : intIn(args.max_concurrent_builds, 1, 10); quota.maxConcurrentCycles = n; }
    const period = ['daily', 'weekly', 'monthly'].includes(args.period) ? args.period : 'monthly';
    if (!Object.keys(patch).length && !Object.keys(quota).length) return err('Pass provider, suggest_mode, clarify_mode, budget_cents, budget_wall_clock_min and/or max_concurrent_builds');
    const existing = x.quotas.listQuotas().find((q) => q.scope === 'project' && q.project_id === p.project.id && q.period === period) || null;
    const plan = { project_id: p.project.id, project: patch, quota: Object.keys(quota).length ? { period, ...quota, current: existing } : null, model: 'The model itself comes from the connector slots + lane tuning (dashboard); provider narrows which slots this project may use.' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Update build settings on ${p.project.name}: ${[...Object.keys(patch), ...Object.keys(quota)].join(', ')}.`); if (gate) return gate;
    let updated = p.project;
    if (Object.keys(patch).length) updated = p.m.projects.updateProject(p.project.id, patch);
    let quotaRow = existing;
    if (Object.keys(quota).length) {
      x.quotas.upsertQuota({ scope: 'project', projectId: p.project.id, period, budgetCents: quota.budgetCents !== undefined ? quota.budgetCents : existing?.budget_cents ?? null, budgetWallClockMin: quota.budgetWallClockMin !== undefined ? quota.budgetWallClockMin : existing?.budget_wall_clock_min ?? null, maxConcurrentCycles: quota.maxConcurrentCycles !== undefined ? quota.maxConcurrentCycles : existing?.max_concurrent_cycles ?? null, bufferPct: existing?.buffer_pct ?? 15 });
      quotaRow = x.quotas.listQuotas().find((q) => q.scope === 'project' && q.project_id === p.project.id && q.period === period) || null;
    }
    note.summary = `build settings: ${[...Object.keys(patch), ...Object.keys(quota)].join(', ')}`;
    note.detail = { ...patch, ...quota, period };
    return ok({ applied: true, project: { id: updated.id, provider_preference: updated.provider_preference || null, suggest_mode: updated.suggest_mode || null, clarify_mode: updated.clarify_mode || null }, quota: quotaRow });
  });

  /* ----------------------------------- git -------------------------------- */

  const pull_git_remote = mutation('pull_git_remote', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    const remote = p.m.gitConnectors.getProjectRemote(p.project.id);
    if (!remote) return err('No git remote configured — set_git_remote first');
    const conn = p.m.gitConnectors.getGitConnector(remote.git_connector_id);
    if (!conn) return err('The git connector for this remote is gone');
    if (!p.project.repo_path) return err('Project has no bare repo');
    const branch = args.branch ? validGitRefName(args.branch) : 'main';
    if (!branch) return err('branch is not a valid ref name');
    const plan = { project_id: p.project.id, remote: remote.remote_repo, branch, steps: ['fetch <remote>/<branch> into the bare repo (host side, credential injected for this call only)', 'git pull --ff-only origin <branch> inside the checkout'], refuses_when: 'the checkout has uncommitted changes or the merge is not a fast-forward' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Pull ${remote.remote_repo}#${branch} into ${p.project.name}.`); if (gate) return gate;
    const st = await git(p.incusName, ['status', '--porcelain']);
    if (st.status !== 0) return err(`git status failed inside the container: ${tail(st.stderr)}`);
    if ((st.stdout || '').trim()) return err(`The checkout has uncommitted changes:\n${tail(st.stdout, 800)}\nCommit them (append_change_record / apply_project_patch) or discard them first.`);
    const gitLogic = p.m.gitLogic;
    const { decryptGitCredentialForMcp } = await import('../../mock2/git-connectors.js');
    let fetchResult;
    if (conn.auth_kind === 'token') {
      const cred = decryptGitCredentialForMcp(conn);
      if (!cred) return err('The connector credential cannot be decrypted (TOTP_ENCRYPTION_KEY changed?)');
      const url = gitLogic.buildTokenPushUrl(conn, remote.remote_repo, cred);
      if (!url) return err('Could not build the remote URL');
      fetchResult = await hostSh('git --git-dir="$1" fetch "$2" "+refs/heads/$3:refs/remotes/upstream/$3" 2>&1', [p.project.repo_path, url, branch], { timeoutMs: 180000 });
    } else {
      return err('Pull over an ssh-key connector is not supported yet — token connectors only.');
    }
    const scrub = (s) => String(s || '').replace(/https?:\/\/[^@\s/]+@/gi, 'https://***@');
    if (fetchResult.status !== 0) return err(`fetch failed: ${scrub(tail(fetchResult.stdout || fetchResult.stderr, 600))}`);
    const pull = await git(p.incusName, ['fetch', 'origin', `+refs/remotes/upstream/${branch}:refs/remotes/origin/upstream-${branch}`]);
    if (pull.status !== 0) return err(`could not fetch into the checkout: ${tail(pull.stderr)}`);
    const before = (await git(p.incusName, ['rev-parse', 'HEAD'])).stdout.trim();
    const merge = await git(p.incusName, ['merge', '--ff-only', `origin/upstream-${branch}`]);
    if (merge.status !== 0) return err(`Not a fast-forward: ${tail(merge.stderr || merge.stdout, 600)}. Use merge_branch after fetching, or resolve on the remote.`);
    const after = (await git(p.incusName, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(p.incusName, ['push', '-q', 'origin', `HEAD:${branch}`]).catch(() => null);
    note.summary = `pulled ${remote.remote_repo}#${branch}: ${before.slice(0, 8)} → ${after.slice(0, 8)}`;
    note.detail = { from: before, to: after, branch };
    return ok({ pulled: true, branch, from: before, to: after, changed: before !== after, next: before !== after ? 'redeploy_project makes the pulled code live.' : undefined });
  });

  async function currentBranch(incusName) {
    const r = await git(incusName, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.status === 0 ? (r.stdout || '').trim() : null;
  }

  const create_branch = mutation('create_branch', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const name = validGitRefName(args.name);
    if (!name) return err('name is not a valid branch name');
    const from = args.from ? validGitRefName(args.from) : null;
    if (args.from && !from) return err('from is not a valid ref');
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    const cur = await currentBranch(p.incusName);
    const d = dry(args, { branch: name, from: from || cur, switch: args.switch === true }); if (d) return d;
    const r = await git(p.incusName, ['branch', name, ...(from ? [from] : [])]);
    if (r.status !== 0) return err(`git branch failed: ${tail(r.stderr)}`);
    let switched = false;
    if (args.switch === true) { const s = await git(p.incusName, ['checkout', '-q', name]); switched = s.status === 0; }
    await git(p.incusName, ['push', '-q', 'origin', `${name}:${name}`]).catch(() => null);
    note.summary = `branch ${name} created from ${from || cur}`;
    note.detail = { branch: name, from: from || cur, switched };
    return ok({ created: true, branch: name, from: from || cur, switched, current: switched ? name : cur, note: 'Builds and the chat-lane commits push HEAD to main on the bare repo; work on a branch stays in the checkout until merged (merge_branch).' });
  });

  const switch_branch = mutation('switch_branch', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const name = validGitRefName(args.name);
    if (!name) return err('name is not a valid branch name');
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    const cur = await currentBranch(p.incusName);
    if (cur === name) return ok({ applied: false, current: cur, note: 'Already on that branch.' });
    const st = await git(p.incusName, ['status', '--porcelain']);
    if ((st.stdout || '').trim() && args.stash !== true) return err(`The checkout has uncommitted changes:\n${tail(st.stdout, 600)}\nCommit them, or pass stash: true to stash them on ${cur}.`);
    const d = dry(args, { from: cur, to: name, stash: args.stash === true }); if (d) return d;
    if ((st.stdout || '').trim()) { const s = await git(p.incusName, ['stash', 'push', '-u', '-m', `mcp switch_branch from ${cur}`]); if (s.status !== 0) return err(`stash failed: ${tail(s.stderr)}`); }
    const r = await git(p.incusName, ['checkout', '-q', name]);
    if (r.status !== 0) return err(`git checkout failed: ${tail(r.stderr)}`);
    note.summary = `switched ${cur} → ${name}`;
    note.detail = { from: cur, to: name };
    return ok({ switched: true, from: cur, to: name, stashed: (st.stdout || '').trim() !== '', next: 'redeploy_project serves this branch\'s tree; the live app keeps running the previous build until then.' });
  });

  const merge_branch = mutation('merge_branch', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const name = validGitRefName(args.name);
    if (!name) return err('name is not a valid branch name');
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    const cur = await currentBranch(p.incusName);
    if (cur === name) return err(`Already on ${name} — switch to the target branch first`);
    const st = await git(p.incusName, ['status', '--porcelain']);
    if ((st.stdout || '').trim()) return err('The checkout has uncommitted changes — commit or stash them first');
    const preview = await git(p.incusName, ['log', '--oneline', `${cur}..${name}`]);
    const commits = (preview.stdout || '').trim().split('\n').filter(Boolean);
    const plan = { into: cur, from: name, commits: commits.slice(0, 50), strategy: args.squash === true ? 'squash' : args.ff === 'only' ? 'ff-only' : 'merge commit (--no-ff)', delete_after: args.delete_branch === true };
    const d = dry(args, plan); if (d) return d;
    if (!commits.length) return ok({ applied: false, ...plan, note: `${name} has nothing ${cur} lacks.` });
    const gate = confirmFlag(args, note, `Merge ${name} (${commits.length} commit(s)) into ${cur}.`); if (gate) return gate;
    const argv = args.squash === true ? ['merge', '--squash', name] : args.ff === 'only' ? ['merge', '--ff-only', name] : ['merge', '--no-ff', '-m', `Merge branch '${name}' (mcp)`, name];
    const r = await git(p.incusName, argv);
    if (r.status !== 0) {
      await git(p.incusName, ['merge', '--abort']).catch(() => null);
      return err(`Merge failed and was aborted: ${tail(r.stdout || r.stderr, 800)}`);
    }
    if (args.squash === true) { const c = await git(p.incusName, ['commit', '-q', '-m', `Squash merge of ${name} (mcp)`]); if (c.status !== 0) return err(`squash commit failed: ${tail(c.stderr)}`); }
    const head = (await git(p.incusName, ['rev-parse', 'HEAD'])).stdout.trim();
    const push = await git(p.incusName, ['push', '-q', 'origin', `HEAD:${cur}`]);
    let deleted = false;
    if (args.delete_branch === true) { deleted = (await git(p.incusName, ['branch', '-d', name])).status === 0; await git(p.incusName, ['push', '-q', 'origin', `:${name}`]).catch(() => null); }
    note.summary = `merged ${name} into ${cur} (${commits.length} commits)`;
    note.detail = { into: cur, from: name, commits: commits.length, head };
    return ok({ merged: true, ...plan, head, pushed: push.status === 0, branch_deleted: deleted, next: 'redeploy_project makes the merged tree live.' });
  });

  const tag_release = mutation('tag_release', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const tag = validGitRefName(args.tag);
    if (!tag) return err('tag is not a valid ref name (e.g. v1.2.0)');
    const message = String(args.message || `Release ${tag}`).slice(0, 500);
    const ref = args.ref ? validGitRefName(args.ref) : 'HEAD';
    if (args.ref && !ref) return err('ref is not valid');
    const exists = await git(p.incusName, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
    if (exists.status === 0) return err(`Tag ${tag} already exists`);
    const sha = (await git(p.incusName, ['rev-parse', ref])).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return err(`ref ${ref} does not resolve`);
    const d = dry(args, { tag, ref, commit: sha, message, registered: 'in state/releases.json (list_releases)' }); if (d) return d;
    const r = await git(p.incusName, ['tag', '-a', tag, sha, '-m', message]);
    if (r.status !== 0) return err(`git tag failed: ${tail(r.stderr)}`);
    await git(p.incusName, ['push', '-q', 'origin', `refs/tags/${tag}`]).catch(() => null);
    const reg = await readRegistry(p.incusName);
    reg.releases.unshift({ tag, commit: sha, message, created_at: new Date().toISOString(), created_by: auth.created_by || 'mcp', promoted_at: null });
    const w = await writeRegistry(p.incusName, reg, `mock2: release ${tag} tagged`);
    note.summary = `tagged release ${tag} at ${sha.slice(0, 8)}`;
    note.detail = { tag, commit: sha };
    return ok({ tagged: true, tag, commit: sha, message, registry: w.error ? { error: w.error } : { path: RELEASES_PATH, sha256: w.sha256 }, next: `promote_release({ project_id: ${p.project.id}, tag: "${tag}", confirm: true }) deploys it.` });
  });

  /* ------------------------------- references ----------------------------- */

  const list_references = reader('list_references', async (args) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    const assets = p.m.assets.listAssets(p.project.id);
    return ok({ project_id: p.project.id, count: assets.length, references: assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, tag: a.tag ?? null, pinned: !!a.pinned, bytes: a.bytes ?? a.size ?? null, created_at: a.created_at, has_summary: !!a.summary })) });
  });

  const get_reference = reader('get_reference', async (args) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    const asset = p.m.assets.getAsset(p.project.id, Number(args.reference_id));
    if (!asset) return err('Reference not found');
    const max = intIn(args.max_bytes, 1024, 4 * 1024 * 1024) || 512 * 1024;
    let content = null;
    if (asset.kind === 'document') content = p.m.assets.readAssetText(p.project.id, asset.id);
    else if (asset.kind === 'content') content = asset.body ?? null;
    return ok({ project_id: p.project.id, reference: asset, content: content != null ? String(content).slice(0, max) : null, truncated: content != null && String(content).length > max, ...(asset.kind === 'image' ? { note: 'Images are not returned over MCP; the dashboard serves them.' } : {}) });
  });

  const delete_reference = mutation('delete_reference', { subjectType: 'mock2_project', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const p = await anyProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const asset = p.m.assets.getAsset(p.project.id, Number(args.reference_id));
    if (!asset) return err('Reference not found');
    if (asset.pinned && args.unpin !== true) return err(`"${asset.name}" is pinned — pass unpin: true to delete it anyway`);
    const d = dry(args, { delete: { id: asset.id, kind: asset.kind, name: asset.name } }); if (d) return d;
    const gate = confirmFlag(args, note, `Delete reference "${asset.name}" (${asset.kind}) from ${p.project.name}.`); if (gate) return gate;
    const r = p.m.assets.removeAsset(p.project.id, asset.id);
    if (!r.ok) return err(r.message || 'delete failed');
    note.summary = `deleted reference ${asset.name}`;
    note.detail = { reference_id: asset.id, kind: asset.kind };
    return ok({ deleted: true, reference: { id: asset.id, kind: asset.kind, name: asset.name } });
  });

  /* -------------------------------- database ------------------------------ */

  const run_project_sql = reader('run_project_sql', async (args) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    const bad = readOnlySqlError(args.sql);
    if (bad) return err(bad);
    const limit = intIn(args.limit, 1, 5000) || 200;
    const sql = String(args.sql).trim().replace(/;\s*$/, '');
    // A READ ONLY transaction plus a statement timeout: the keyword check above
    // is the reader's guard, the transaction is the database's.
    // The statement rides in a temp file the postgres user can read: nesting
    // it through su's quoting would be fragile.
    const safeScript = 'n="$1"; command -v psql >/dev/null 2>&1 || { echo NOPSQL >&2; exit 66; }; '
      + 'f=$(mktemp /tmp/pp-sql.XXXXXX) || exit 98; cat > "$f"; chmod 644 "$f"; '
      + 'out=$(su - postgres -c "psql -X -v ON_ERROR_STOP=1 -d app -A -F \'|\' --pset footer=off -c \'SET statement_timeout = 30000\' -c \'BEGIN READ ONLY\' -f $f -c ROLLBACK" 2>&1); ec=$?; rm -f "$f"; '
      + 'printf "%s\\n" "$out" | head -n "$((n + 8))"; exit $ec';
    const r = await projectSh(p.incusName, safeScript, [String(limit)], { input: `${sql};\n`, timeoutMs: 60000, maxCapture: 2 * 1024 * 1024 });
    if (r.status === 66) return err('psql is not available in this project container');
    if (r.status !== 0) return err(`Query failed: ${tail(r.stdout || r.stderr, 1200)}`);
    const lines = (r.stdout || '').split('\n').filter((l) => l !== '' && !/^(SET|BEGIN|ROLLBACK)$/.test(l));
    const header = lines.length ? lines[0].split('|') : [];
    const rows = lines.slice(1, 1 + limit).map((l) => l.split('|'));
    return ok({ project_id: p.project.id, columns: header, row_count: rows.length, truncated: lines.length - 1 > limit, rows, note: 'Ran inside BEGIN READ ONLY … ROLLBACK with a 30 s statement timeout, as the postgres superuser on database "app".' });
  });

  const dump_project_db = mutation('dump_project_db', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id;
    const label = args.label ? String(args.label).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) : 'mcp';
    const file = `${DB_DUMPS_DIR}/app-${label}-${stamp()}.sql`;
    const d = dry(args, { file, command: 'pg_dump --clean --if-exists app (inside the container)' }); if (d) return d;
    const script = 'f="$1"; mkdir -p "$(dirname "$f")"; command -v pg_dump >/dev/null 2>&1 || { echo NOPG >&2; exit 66; }; '
      + 'su - postgres -c "pg_dump --clean --if-exists app" > "$f.tmp" || { rm -f "$f.tmp"; exit 1; }; mv "$f.tmp" "$f"; chmod 600 "$f"; wc -c < "$f"; sha256sum "$f" | cut -d" " -f1';
    const r = await projectSh(p.incusName, script, [file], { timeoutMs: 20 * 60 * 1000 });
    if (r.status === 66) return err('pg_dump is not available in this project container (no Postgres?)');
    if (r.status !== 0) return err(`pg_dump failed: ${tail(r.stderr)}`);
    const [bytes, sha] = (r.stdout || '').trim().split('\n');
    note.snapshot = file;
    note.summary = `db dump ${basename(file)}`;
    note.detail = { file, bytes: Number(bytes) || null, sha256: sha };
    return ok({ dumped: true, file, bytes: Number(bytes) || null, sha256: sha, note: 'The dump lives inside the project container; restore_project_db takes its file name. Container snapshots (export_lxc) carry it along.' });
  });

  const restore_project_db = mutation('restore_project_db', { subjectType: 'mock2_project', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    const file = pathUnder(DB_DUMPS_DIR, basename(String(args.file || '')));
    if (!file || !/\.sql$/.test(file)) return err(`file must be a dump name inside ${DB_DUMPS_DIR} (from dump_project_db)`);
    const st = await projectSh(p.incusName, 'test -f "$1" && wc -c < "$1"', [file], { timeoutMs: 15000 });
    if (st.status !== 0) return err(`No such dump in the container: ${file}`);
    const plan = { project_id: p.project.id, file, bytes: Number((st.stdout || '').trim()) || null, pre_restore_dump: `${DB_DUMPS_DIR}/app-pre-restore-<timestamp>.sql`, then: 'psql -f <dump> (the dump carries --clean --if-exists, so the database lands exactly on the dumped state)' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'restore_project_db', subject: `${p.project.id}/${basename(file)}`, action: `replace ${p.project.name}'s database with ${basename(file)}`, preview: plan });
    if (gate) return gate;
    const pre = `${DB_DUMPS_DIR}/app-pre-restore-${stamp()}.sql`;
    const dump = await projectSh(p.incusName, 'f="$1"; mkdir -p "$(dirname "$f")"; su - postgres -c "pg_dump --clean --if-exists app" > "$f" && chmod 600 "$f"', [pre], { timeoutMs: 20 * 60 * 1000 });
    if (dump.status !== 0) return err(`Refusing to restore without a pre-restore dump: ${tail(dump.stderr)}`);
    note.snapshot = pre;
    const r = await projectSh(p.incusName, 'f="$1"; cp "$f" /tmp/pp-restore.sql && chmod 644 /tmp/pp-restore.sql; su - postgres -c "psql -X -v ON_ERROR_STOP=0 -q -d app -f /tmp/pp-restore.sql" 2>&1 | grep -E "^(psql|ERROR)" | head -n 40; rm -f /tmp/pp-restore.sql; exit 0', [file], { timeoutMs: 30 * 60 * 1000 });
    const errors = (r.stdout || '').split('\n').filter((l) => /ERROR/.test(l));
    note.summary = `db restored from ${basename(file)}`;
    note.detail = { file, pre_restore_dump: pre, errors: errors.length };
    return ok({ restored: true, file, pre_restore_dump: pre, errors: errors.slice(0, 20), reverse_with: `restore_project_db({ project_id: ${p.project.id}, file: "${basename(pre)}" })`, next: 'redeploy_project (or a restart) so the app reconnects cleanly.' });
  });

  /* ---------------------------------- CPR --------------------------------- */

  async function readRegistry(incusName) {
    const r = await readProjectText(incusName, RELEASES_PATH);
    return r.error ? { releases: [], current: null, sha256: null } : { ...parseReleases(r.content), sha256: r.sha256 };
  }
  async function writeRegistry(incusName, reg, message) {
    const w = await verifiedContainerWrite(incusName, `${M2_APP_DIR}/${RELEASES_PATH}`, renderReleases(reg), { label: RELEASES_PATH });
    if (w.error) return w;
    const g = await commitProjectPaths(incusName, [RELEASES_PATH], message);
    return { ...w, ...g };
  }

  const list_releases = reader('list_releases', async (args) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    const reg = await readRegistry(p.incusName);
    const tags = await git(p.incusName, ['tag', '-l', '--sort=-creatordate', '--format=%(refname:short)%09%(objectname)%09%(creatordate:iso-strict)']);
    const known = new Set(reg.releases.map((r) => r.tag));
    const extra = (tags.stdout || '').trim().split('\n').filter(Boolean).map((l) => { const [tag, sha, at] = l.split('\t'); return { tag, commit: sha, created_at: at }; }).filter((t) => !known.has(t.tag));
    const head = (await git(p.incusName, ['rev-parse', 'HEAD'])).stdout.trim();
    return ok({ project_id: p.project.id, current: reg.current, deployed_commit: p.project.deployed_commit || null, head, releases: reg.releases, untracked_tags: extra, note: 'promote_release deploys a tag; rollback_release re-promotes the previous entry. Blue/green slots on production hosts are the CPR base platform\'s job — this registry is the dev-URL side of it.' });
  });

  async function preflightPromote(p) {
    const guard = liveBuildGuard(p.m, p.project); if (guard) return { error: guard };
    const st = await git(p.incusName, ['status', '--porcelain']);
    if ((st.stdout || '').trim()) return { error: `The checkout has uncommitted changes — commit or discard them first:\n${tail(st.stdout, 500)}` };
    return {};
  }

  const snapshot_before_promote = mutation('snapshot_before_promote', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const d = dry(args, { steps: ['checkpoint commit', 'pg_dump to state/db/snapshot.sql (committed)', `incus snapshot ${p.incusName}`] }); if (d) return d;
    const out = await takePromoteSnapshot(p, auth);
    if (out.error) return err(out.error);
    note.snapshot = out.snapshot;
    note.summary = `pre-promote snapshot ${out.snapshot}`;
    note.detail = out;
    return ok({ snapshotted: true, ...out });
  });

  async function takePromoteSnapshot(p) {
    const x = await extra();
    const { buildDbSnapshotScript, DB_SNAPSHOT_PATH } = await import('../../mock2/restore-logic.js');
    await projectSh(p.incusName, buildDbSnapshotScript({ appDir: M2_APP_DIR }), [], { timeoutMs: 10 * 60 * 1000 }).catch(() => null);
    const cp = await projectSh(p.incusName, p.m.template.buildCheckpointScript({ appDir: M2_APP_DIR, message: 'checkpoint: pre-promote (mcp)' }), [], { timeoutMs: 120000 });
    const head = (await git(p.incusName, ['rev-parse', 'HEAD'])).stdout.trim();
    const snap = await takeLxcSnapshot(p.incusName, defaultSnapshotName(new Date(), 'pp-mcp-pre-promote'));
    if (snap.error) return { error: `Container snapshot failed: ${snap.error}` };
    void x;
    return { snapshot: snap.name, commit: head, db_snapshot: DB_SNAPSHOT_PATH, checkpoint_ok: cp.status === 0 };
  }

  async function deployTag(p, tag, auth, note, { kind }) {
    const sha = (await git(p.incusName, ['rev-parse', `refs/tags/${tag}^{commit}`])).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return { error: `Tag ${tag} does not exist in the checkout` };
    const snap = await takePromoteSnapshot(p);
    if (snap.error) return snap;
    note.snapshot = snap.snapshot;
    const before = snap.commit;
    // Promote = make the working tree equal to the tag's tree, as a new commit on
    // the current branch (history stays append-only; the previous state is the
    // snapshot + the commit before this one), then deploy it.
    const script = 'set -e; cd /srv/app; t="$1"; msg="$2"; git read-tree -u --reset "$t"; git -c user.email=mcp@proxypilot -c user.name="ProxyPilot MCP" commit -q --allow-empty -m "$msg"; git push -q origin HEAD:main 2>/dev/null || true; git rev-parse HEAD';
    const r = await projectSh(p.incusName, script, [`refs/tags/${tag}`, `${kind}: ${tag} (mcp)`], { timeoutMs: 120000 });
    if (r.status !== 0) return { error: `Could not check out ${tag}: ${tail(r.stderr)} (snapshot ${snap.snapshot} taken)` };
    const promoteCommit = (r.stdout || '').trim().split('\n').pop();
    const x = await extra();
    const { DEFAULT_WEB_PORT } = p.m.template;
    const steps = [];
    const res = await x.deploy.deployProject({ containerName: p.incusName, webPort: p.project.web_port || DEFAULT_WEB_PORT, onStep: (k, label) => steps.push(label || k) });
    const reg = await readRegistry(p.incusName);
    const previous = reg.current;
    const entry = reg.releases.find((e) => e.tag === tag);
    if (entry) entry.promoted_at = new Date().toISOString(); else reg.releases.unshift({ tag, commit: sha, promoted_at: new Date().toISOString(), created_by: auth.created_by || 'mcp' });
    reg.current = { tag, commit: sha, promote_commit: promoteCommit, promoted_at: new Date().toISOString(), previous: previous ? { tag: previous.tag, commit: previous.commit } : null, previous_head: before, snapshot: snap.snapshot, deploy_ok: !!res.ok };
    await writeRegistry(p.incusName, reg, `mock2: ${kind} ${tag}`);
    return { tag, commit: sha, promote_commit: promoteCommit, previous, previous_head: before, snapshot: snap.snapshot, deploy: { ok: !!res.ok, skipped: !!res.skipped, step: res.step || null, error: res.error || null, steps }, url: projectUrl(p.project, p.m.domains) };
  }

  const promote_release = mutation('promote_release', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const tag = validGitRefName(args.tag);
    if (!tag) return err('tag is required');
    const pre = await preflightPromote(p); if (pre.error) return err(pre.error);
    const sha = (await git(p.incusName, ['rev-parse', `refs/tags/${tag}^{commit}`])).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return err(`Tag ${tag} does not exist (tag_release creates one; list_releases shows them)`);
    const reg = await readRegistry(p.incusName);
    const plan = { project_id: p.project.id, tag, commit: sha, current: reg.current, steps: ['snapshot_before_promote', `promote commit (tree of ${tag})`, 'deployProject (install/migrate/build/restart + health check)', 'registry updated'] };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Promote ${tag} (${sha.slice(0, 8)}) on ${p.project.name} — the live dev URL serves that tree after the deploy.`); if (gate) return gate;
    const out = await deployTag(p, tag, auth, note, { kind: 'promote' });
    if (out.error) return err(out.error);
    note.summary = `promoted ${tag}`;
    note.detail = { tag, commit: sha, deploy_ok: out.deploy.ok, snapshot: out.snapshot };
    return ok({ promoted: true, ...out, ...(out.deploy.ok ? {} : { warning: `Deploy failed at ${out.deploy.step}: ${out.deploy.error}. rollback_release restores the previous release.` }), reverse_with: `rollback_release({ project_id: ${p.project.id}, confirm: true })` });
  });

  const rollback_release = mutation('rollback_release', { subjectType: 'mock2_project', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const p = await activeProject(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const pre = await preflightPromote(p); if (pre.error) return err(pre.error);
    const reg = await readRegistry(p.incusName);
    const target = args.tag ? validGitRefName(args.tag) : reg.current?.previous?.tag || null;
    if (args.tag && !target) return err('tag is not valid');
    if (!target) return err(reg.current ? 'No previous release recorded — pass tag explicitly' : 'Nothing has been promoted yet (list_releases)');
    const plan = { project_id: p.project.id, current: reg.current, rollback_to: target, method: 'promote the previous tag (a new commit; nothing is rewritten), after a fresh snapshot' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'rollback_release', subject: `${p.project.id}/${target}`, action: `roll ${p.project.name} back to release ${target}`, preview: plan });
    if (gate) return gate;
    const out = await deployTag(p, target, auth, note, { kind: 'rollback' });
    if (out.error) return err(out.error);
    note.summary = `rolled back to ${target}`;
    note.detail = { tag: target, deploy_ok: out.deploy.ok, snapshot: out.snapshot };
    return ok({ rolled_back: true, ...out, ...(out.deploy.ok ? {} : { warning: `Deploy failed at ${out.deploy.step}: ${out.deploy.error}.` }) });
  });

  return {
    list_components, get_component, import_component, install_component, uninstall_component, list_component_versions,
    get_standards_version, upgrade_project_standards, set_standards_source,
    delete_project, rename_project, set_project_domain,
    set_project_env, list_project_env_keys,
    approve_egress, list_egress_requests,
    set_project_resources, set_project_build_settings,
    pull_git_remote, create_branch, switch_branch, merge_branch, tag_release,
    list_references, get_reference, delete_reference,
    run_project_sql, dump_project_db, restore_project_db,
    list_releases, promote_release, rollback_release, snapshot_before_promote,
  };
}
