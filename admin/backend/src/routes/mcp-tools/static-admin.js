// Static-site administration over MCP: delete a site (its docroot archived
// first), delete a file (a copy kept), releases (docroot snapshots under
// /var/lib/proxypilot/static-releases) with rollback, and aliases (extra
// hostnames as sibling root routes on the same service).

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { stamp, intIn } from '../../lib/mcp-ext/logic.js';

const RELEASES_ROOT = process.env.STATIC_RELEASES_DIR || '/var/lib/proxypilot/static-releases';

export function createStaticAdminHandlers(kit) {
  const { ctx, ok, err, mutation, reader, confirmToken, confirmFlag, dry, tail } = kit;
  const {
    getDb, getStaticSite, staticSiteDomains, validDomainName, regenerateDomainCaddyConfig, ensureCaddyStructure,
    assertRoutesShareSslStance, caddyAdapt, caddyReload, uuidv4,
  } = ctx;

  function safePath(baseDir, userPath) {
    const resolved = resolve(baseDir, String(userPath || ''));
    if (!resolved.startsWith(`${resolve(baseDir)}/`) && resolved !== resolve(baseDir)) return null;
    return resolved;
  }

  async function dirSize(root) {
    let bytes = 0; let files = 0;
    const stack = [root];
    while (stack.length && files < 50000) {
      const d = stack.pop();
      let entries = [];
      try { entries = await readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) { files += 1; try { bytes += (await stat(p)).size; } catch { /* raced */ } }
      }
    }
    return { bytes, files };
  }

  async function captureRelease(site, label, { kind = 'manual', by = null } = {}) {
    const id = stamp();
    const dir = join(RELEASES_ROOT, String(site.id), id);
    await mkdir(dir, { recursive: true });
    await cp(site.data_dir, join(dir, 'files'), { recursive: true, force: true, errorOnExist: false });
    const size = await dirSize(join(dir, 'files'));
    const meta = { id, site_id: site.id, site_name: site.name, label: label || null, kind, created_at: new Date().toISOString(), created_by: by, ...size };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  async function listReleases(siteId) {
    const root = join(RELEASES_ROOT, String(siteId));
    let ids = [];
    try { ids = (await readdir(root)).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).sort().reverse(); } catch { return []; }
    const out = [];
    for (const id of ids) {
      try { out.push(JSON.parse(await readFile(join(root, id, 'meta.json'), 'utf8'))); } catch { out.push({ id, site_id: siteId, corrupt_meta: true }); }
    }
    return out;
  }

  async function applyDomains(domains, rollback) {
    const db = getDb();
    const undo = async (stage, detail) => {
      for (const fn of [...rollback].reverse()) { try { fn(); } catch { /* best effort */ } }
      for (const d of domains) { try { await regenerateDomainCaddyConfig(db, d); } catch { /* best effort */ } }
      try { await caddyReload({}); } catch { /* best effort */ }
      return err(`${stage}: ${detail} — the change was rolled back.`);
    };
    try { await ensureCaddyStructure(); } catch { /* regenerate re-checks */ }
    try { for (const d of domains) await regenerateDomainCaddyConfig(db, d); } catch (e) { return undo('Failed to render the Caddy config', e?.message || e); }
    try { await caddyAdapt({}); } catch (e) { return undo('Generated Caddy config failed validation', e?.stderr || e?.message || e); }
    try { await caddyReload({}); } catch (e) { return undo('Caddy reload failed', e?.stderr || e?.message || e); }
    return null;
  }

  const delete_static_site = mutation('delete_static_site', { subjectType: 'service', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const site = getStaticSite(args.site_id);
    if (!site) return err('Static site not found — list_static_sites shows ids');
    note.subject_id = site.id;
    const domains = staticSiteDomains(site.id).map((d) => d.domain);
    const size = site.data_dir ? await dirSize(site.data_dir) : { bytes: 0, files: 0 };
    const removeFiles = args.remove_files === true;
    const plan = { site_id: site.id, name: site.name, domains, docroot: site.data_dir, files: size.files, bytes: size.bytes, archive_first: `${RELEASES_ROOT}/${site.id}/<timestamp> (release kind: pre-delete)`, docroot_removed: removeFiles };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'delete_static_site', subject: String(site.id), action: `delete static site "${site.name}" (${domains.join(', ') || 'no domains'}${removeFiles ? ', docroot removed' : ', docroot kept on disk'})`, preview: plan });
    if (gate) return gate;
    let release = null;
    if (site.data_dir) {
      try { release = await captureRelease(site, 'pre-delete', { kind: 'pre-delete', by: auth.created_by }); } catch (e) { return err(`Nothing was deleted: could not archive the docroot first (${e?.message || e})`); }
      note.snapshot = `${RELEASES_ROOT}/${site.id}/${release.id}`;
    }
    const db = getDb();
    const routes = db.prepare(`SELECT * FROM service_http_routes WHERE service_id = ?`).all(site.id);
    const siteCols = Object.keys(site);
    const rollback = [
      () => db.prepare(`INSERT INTO services (${siteCols.join(', ')}) VALUES (${siteCols.map(() => '?').join(', ')})`).run(...siteCols.map((k) => site[k])),
      () => { for (const r of routes) { const cols = Object.keys(r); db.prepare(`INSERT INTO service_http_routes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => r[k])); } },
    ];
    db.prepare(`DELETE FROM services WHERE id = ?`).run(site.id);
    const fail = await applyDomains(domains, rollback);
    if (fail) return fail;
    let removed = false;
    if (removeFiles && site.data_dir) { try { await rm(site.data_dir, { recursive: true, force: true }); removed = true; } catch (e) { note.detail.docroot_error = e?.message || String(e); } }
    note.summary = `deleted static site ${site.name}`;
    note.detail = { ...note.detail, domains, release: release?.id || null, docroot_removed: removed };
    return ok({ deleted: true, ...plan, docroot_removed: removed, archive: release, note: 'The archived release stays on disk; create_static_site + rollback_static_site with it re-creates the content.' });
  });

  const delete_static_site_file = mutation('delete_static_site_file', { subjectType: 'service', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const site = getStaticSite(args.site_id);
    if (!site) return err('Static site not found');
    note.subject_id = site.id;
    const rel = String(args.path || '').replace(/^\/+/, '');
    const abs = rel ? safePath(site.data_dir, rel) : null;
    if (!abs || abs === resolve(site.data_dir)) return err('path must name a file or folder inside the docroot (never the docroot itself)');
    let st; try { st = await stat(abs); } catch { return err(`${rel} does not exist`); }
    const isDir = st.isDirectory();
    if (isDir && args.recursive !== true) return err(`${rel} is a directory — pass recursive: true to delete it and its contents`);
    const keepOld = !isDir && args.keep_old !== false;
    const plan = { site_id: site.id, path: rel, kind: isDir ? 'directory' : 'file', size: st.size, backup: keepOld ? `${rel}.old` : null };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Delete ${rel} from "${site.name}"${keepOld ? ` (a copy stays at ${rel}.old)` : ' — no copy kept'}.`); if (gate) return gate;
    if (keepOld) await rename(abs, `${abs}.old`);
    else await rm(abs, { recursive: isDir, force: true });
    note.summary = `deleted ${rel} from static site ${site.name}`;
    note.detail = plan;
    return ok({ deleted: true, ...plan });
  });

  const create_static_release = mutation('create_static_release', { subjectType: 'service' }, async (args, auth, req, note) => {
    const site = getStaticSite(args.site_id);
    if (!site) return err('Static site not found');
    if (!site.data_dir) return err('This site has no docroot on disk');
    note.subject_id = site.id;
    const label = args.label != null ? String(args.label).slice(0, 120) : null;
    const size = await dirSize(site.data_dir);
    const d = dry(args, { site_id: site.id, label, ...size, into: `${RELEASES_ROOT}/${site.id}/<timestamp>` }); if (d) return d;
    const meta = await captureRelease(site, label, { kind: 'manual', by: auth.created_by });
    note.summary = `release ${meta.id} of static site ${site.name}`;
    note.detail = { release: meta.id, files: meta.files };
    return ok({ created: true, release: meta, note: 'Releases are full docroot copies; rollback_static_site restores one after capturing the current state as another release.' });
  });

  const list_static_releases = reader('list_static_releases', async (args) => {
    const site = getStaticSite(args.site_id);
    if (!site) return err('Static site not found');
    const releases = await listReleases(site.id);
    return ok({ site_id: site.id, name: site.name, releases, ...(releases.length ? {} : { note: 'No releases yet — create_static_release captures the current docroot.' }) });
  });

  const rollback_static_site = mutation('rollback_static_site', { subjectType: 'service', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const site = getStaticSite(args.site_id);
    if (!site) return err('Static site not found');
    if (!site.data_dir) return err('This site has no docroot on disk');
    note.subject_id = site.id;
    const id = String(args.release || '');
    if (!/^\d{8}T\d{6}Z$/.test(id)) return err('release must be a release id from list_static_releases');
    const dir = join(RELEASES_ROOT, String(site.id), id);
    let meta; try { meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')); } catch { return err(`Release ${id} not found for this site`); }
    const current = await dirSize(site.data_dir);
    const plan = { site_id: site.id, name: site.name, restore: meta, current: { ...current }, pre_rollback_release: 'captured automatically first' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'rollback_static_site', subject: `${site.id}/${id}`, action: `replace the docroot of "${site.name}" with release ${id}${meta.label ? ` (${meta.label})` : ''}`, preview: plan });
    if (gate) return gate;
    const pre = await captureRelease(site, `pre-rollback to ${id}`, { kind: 'pre-rollback', by: auth.created_by });
    note.snapshot = `${RELEASES_ROOT}/${site.id}/${pre.id}`;
    const entries = await readdir(site.data_dir);
    for (const e of entries) await rm(join(site.data_dir, e), { recursive: true, force: true });
    await cp(join(dir, 'files'), site.data_dir, { recursive: true, force: true });
    const after = await dirSize(site.data_dir);
    note.summary = `rolled back static site ${site.name} to release ${id}`;
    note.detail = { release: id, pre_rollback_release: pre.id, files: after.files };
    return ok({ rolled_back: true, site_id: site.id, release: meta, pre_rollback_release: pre, now: after, reverse_with: `rollback_static_site({ site_id: "${site.id}", release: "${pre.id}" })` });
  });

  const set_static_site_aliases = mutation('set_static_site_aliases', { subjectType: 'service' }, async (args, auth, req, note) => {
    const site = getStaticSite(args.site_id);
    if (!site) return err('Static site not found');
    note.subject_id = site.id;
    if (!Array.isArray(args.aliases)) return err('aliases must be an array of hostnames (empty removes every alias)');
    const aliases = [];
    for (const a of args.aliases) { const v = validDomainName(a); if (!v) return err(`"${a}" is not a valid hostname`); if (!aliases.includes(v)) aliases.push(v); }
    const db = getDb();
    const rows = staticSiteDomains(site.id).filter((r) => r.path_prefix === '/');
    if (!rows.length) return err('This site has no primary domain route');
    const primary = rows[0].domain;
    const currentAliases = rows.slice(1).map((r) => r.domain);
    const wanted = aliases.filter((a) => a !== primary);
    const add = wanted.filter((a) => !currentAliases.includes(a));
    const remove = currentAliases.filter((a) => !wanted.includes(a));
    for (const a of add) {
      const taken = db.prepare(`SELECT r.domain, s.name FROM service_http_routes r JOIN services s ON s.id = r.service_id WHERE r.domain = ? LIMIT 1`).get(a);
      if (taken) return err(`${a} is already served by "${taken.name}" — free it there first`);
    }
    const plan = { site_id: site.id, primary, aliases_after: wanted, add, remove, tls: !!rows[0].ssl_enabled };
    const d = dry(args, plan); if (d) return d;
    if (!add.length && !remove.length) return ok({ applied: false, ...plan, note: 'Already in the requested state.' });
    const gate = confirmFlag(args, note, `Aliases for "${site.name}": add ${add.join(', ') || 'none'}, remove ${remove.join(', ') || 'none'}.`); if (gate) return gate;
    const rollback = [];
    const tls = !!rows[0].ssl_enabled;
    for (const a of add) {
      const id = uuidv4();
      try { assertRoutesShareSslStance(db, a, { sslEnabled: tls, forceHttps: tls }); } catch (e) { return err(e?.message || 'TLS stance conflict'); }
      db.prepare(`INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size) VALUES (?, ?, ?, '/', NULL, 0, ?, ?, '1G')`).run(id, site.id, a, tls ? 1 : 0, tls ? 1 : 0);
      rollback.push(() => db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(id));
    }
    for (const a of remove) {
      const row = db.prepare(`SELECT * FROM service_http_routes WHERE service_id = ? AND domain = ? AND path_prefix = '/'`).get(site.id, a);
      if (!row) continue;
      const cols = Object.keys(row);
      rollback.push(() => db.prepare(`INSERT INTO service_http_routes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k])));
      db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(row.id);
    }
    const fail = await applyDomains([...add, ...remove], rollback);
    if (fail) return fail;
    note.summary = `aliases for static site ${site.name}: +${add.length} -${remove.length}`;
    note.detail = plan;
    return ok({ applied: true, ...plan, next: add.length ? `Point DNS for ${add.join(', ')} at this host, then test_route each.` : undefined });
  });

  return { delete_static_site, delete_static_site_file, create_static_release, list_static_releases, rollback_static_site, set_static_site_aliases };
}
