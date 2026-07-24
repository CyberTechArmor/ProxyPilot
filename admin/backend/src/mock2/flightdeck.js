// Flightdeck (build-phase IDE workspace) — the file-CRUD HTTP API.
//
// The project's editable working tree lives ONLY inside its fenced Incus
// container (/srv/app on m2-<id>); the host holds a bare repo with no worktree.
// So every file operation goes through the container over `incus exec`, reusing
// the runner's proven host round-trip (base64-wrapped payloads → no quoting
// hazard) and the same safeRel-style guard. No file bytes ever touch the host FS.
//
// Auth: mounted on the mock2 router (already authenticateToken + blockPendingRole
// + CSRF via /api/ + rate-limited). Each route adds requireMock2Role — 'viewer'
// for reads, 'editor' for writes — and mutations add refuseIfArchived. The
// container must be online (lifecycle 'active'); otherwise 409. Pure path/tree/
// language logic lives in flightdeck-logic.js and is unit-tested there.

import { z } from 'zod';
import { requireMock2Role } from './authz.js';
import { logAudit } from '../db.js';
import {
  containerSh, readFileInContainer, writeFileInContainer, APP_DIR,
} from './runner.js';
import { containerNameForProject } from './provision.js';
import { b64 } from './host.js';
import {
  safeRelPath, buildFindCommand, parseFindTypeOutput, buildFileTree,
  languageForPath, isProbablyBinary, MAX_EDIT_FILE_BYTES,
} from './flightdeck-logic.js';

const pathSchema = z.object({ path: z.string().min(1).max(4096) });
const saveSchema = z.object({ path: z.string().min(1).max(4096), content: z.string().max(4_000_000) });
const createSchema = z.object({ path: z.string().min(1).max(4096), type: z.enum(['file', 'dir']).default('file'), content: z.string().max(4_000_000).optional() });
const renameSchema = z.object({ from: z.string().min(1).max(4096), to: z.string().min(1).max(4096) });

// The container name for a request's project (req.mock2Project is stamped by
// requireMock2Role). Only usable once the container exists / is active.
function containerFor(project) {
  return project.container_name || containerNameForProject(project.id);
}

// A project must be online for file I/O (the container has to exist). Mirrors the
// terminal authorizer's lifecycle gate. Returns a 409 response, or null when ok.
function requireOnline(project, res) {
  if (project.lifecycle !== 'active') {
    res.status(409).json({ error: 'The project container is not running. Start the project to use Flightdeck.' });
    return true;
  }
  return false;
}

// Run a shell snippet in the container with a model/user path already decoded
// safely inside the script. `relParts` are safeRelPath-cleaned strings that get
// base64-decoded in-container, so nothing user-supplied is interpolated raw.
async function containerExec(containerName, script, timeoutMs = 30000) {
  return containerSh(containerName, script, { timeoutMs });
}

export function registerFlightdeckRoutes(router, refuseIfArchived) {
  // ---- read: directory tree ----
  router.get('/projects/:id/flightdeck/tree', requireMock2Role('viewer'), async (req, res) => {
    const project = req.mock2Project;
    if (requireOnline(project, res)) return;
    const containerName = containerFor(project);
    const script = `cd '${APP_DIR}' 2>/dev/null || exit 3; ${buildFindCommand({ maxDepth: 8 })}`;
    const r = await containerExec(containerName, script);
    if (r.code === 3) return res.status(404).json({ error: 'project working tree not found in container' });
    const { paths, dirs } = parseFindTypeOutput(r.stdout || '');
    res.json({ root: APP_DIR, tree: buildFileTree(paths, { dirs }) });
  });

  // ---- read: file content ----
  router.get('/projects/:id/flightdeck/file', requireMock2Role('viewer'), async (req, res) => {
    const project = req.mock2Project;
    if (requireOnline(project, res)) return;
    const rel = safeRelPath(req.query.path);
    if (!rel || rel === '.') return res.status(400).json({ error: 'invalid path' });
    const r = await readFileInContainer(containerFor(project), rel);
    if (!r.ok) return res.status(404).json({ error: `could not read file: ${String(r.error).slice(0, 160)}` });
    const content = r.content || '';
    if (content.length > MAX_EDIT_FILE_BYTES) return res.status(413).json({ error: 'file too large to open in the editor', size: content.length });
    if (isProbablyBinary(content)) return res.status(415).json({ error: 'binary file — not editable as text', path: rel, binary: true });
    res.json({ path: rel, content, language: languageForPath(rel), size: content.length });
  });

  // ---- write: save (create or overwrite) ----
  router.put('/projects/:id/flightdeck/file', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    if (requireOnline(project, res)) return;
    const parsed = saveSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'path and content are required' });
    const rel = safeRelPath(parsed.data.path);
    if (!rel || rel === '.') return res.status(400).json({ error: 'invalid path' });
    const w = await writeFileInContainer(containerFor(project), rel, parsed.data.content);
    if (!w.ok) return res.status(500).json({ error: `could not save file: ${String(w.error).slice(0, 160)}` });
    logAudit(req.user?.id ?? null, 'MOCK2_FLIGHTDECK_SAVE', 'mock2_project', String(project.id), { path: rel, bytes: parsed.data.content.length, acting_as_admin: req.mock2Access?.actingAsAdmin || false }, req.ip);
    res.json({ path: rel, saved: true });
  });

  // ---- create: new file or folder (fails if it exists) ----
  router.post('/projects/:id/flightdeck/create', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    if (requireOnline(project, res)) return;
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'path is required' });
    const rel = safeRelPath(parsed.data.path);
    if (!rel || rel === '.') return res.status(400).json({ error: 'invalid path' });
    const containerName = containerFor(project);
    if (parsed.data.type === 'dir') {
      const script = `p=$(printf '%s' '${b64(rel)}' | base64 -d); d="${APP_DIR}/$p"; [ -e "$d" ] && echo EXISTS || { mkdir -p "$d" && echo OK; }`;
      const r = await containerExec(containerName, script);
      if (String(r.stdout || '').includes('EXISTS')) return res.status(409).json({ error: 'already exists' });
      if (!String(r.stdout || '').includes('OK')) return res.status(500).json({ error: 'could not create folder' });
    } else {
      // create_file semantics: fail if it exists; else write (optional content).
      const exists = await containerExec(containerName, `p=$(printf '%s' '${b64(rel)}' | base64 -d); [ -e "${APP_DIR}/$p" ] && echo EXISTS || echo NEW`);
      if (String(exists.stdout || '').includes('EXISTS')) return res.status(409).json({ error: 'already exists — use save to modify' });
      const w = await writeFileInContainer(containerName, rel, parsed.data.content ?? '');
      if (!w.ok) return res.status(500).json({ error: 'could not create file' });
    }
    logAudit(req.user?.id ?? null, 'MOCK2_FLIGHTDECK_CREATE', 'mock2_project', String(project.id), { path: rel, kind: parsed.data.type }, req.ip);
    res.status(201).json({ path: rel, type: parsed.data.type, created: true });
  });

  // ---- rename / move ----
  router.post('/projects/:id/flightdeck/rename', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    if (requireOnline(project, res)) return;
    const parsed = renameSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'from and to are required' });
    const from = safeRelPath(parsed.data.from);
    const to = safeRelPath(parsed.data.to);
    if (!from || from === '.' || !to || to === '.') return res.status(400).json({ error: 'invalid path' });
    const script = [
      `s=$(printf '%s' '${b64(from)}' | base64 -d)`,
      `t=$(printf '%s' '${b64(to)}' | base64 -d)`,
      `src="${APP_DIR}/$s"; dst="${APP_DIR}/$t"`,
      `[ ! -e "$src" ] && echo NOSRC && exit 0`,
      `[ -e "$dst" ] && echo DSTEXISTS && exit 0`,
      `mkdir -p "$(dirname "$dst")" && mv "$src" "$dst" && echo OK`,
    ].join('; ');
    const r = await containerExec(containerFor(project), script);
    const out = String(r.stdout || '');
    if (out.includes('NOSRC')) return res.status(404).json({ error: 'source not found' });
    if (out.includes('DSTEXISTS')) return res.status(409).json({ error: 'destination already exists' });
    if (!out.includes('OK')) return res.status(500).json({ error: 'could not rename' });
    logAudit(req.user?.id ?? null, 'MOCK2_FLIGHTDECK_RENAME', 'mock2_project', String(project.id), { from, to }, req.ip);
    res.json({ from, to, renamed: true });
  });

  // ---- delete (file or folder; recursive for folders) ----
  router.delete('/projects/:id/flightdeck/file', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const project = req.mock2Project;
    if (requireOnline(project, res)) return;
    const rel = safeRelPath(req.query.path);
    if (!rel || rel === '.') return res.status(400).json({ error: 'invalid path' });
    const script = `p=$(printf '%s' '${b64(rel)}' | base64 -d); d="${APP_DIR}/$p"; [ ! -e "$d" ] && echo NONE && exit 0; rm -rf "$d" && echo OK`;
    const r = await containerExec(containerFor(project), script);
    const out = String(r.stdout || '');
    if (out.includes('NONE')) return res.status(404).json({ error: 'not found' });
    if (!out.includes('OK')) return res.status(500).json({ error: 'could not delete' });
    logAudit(req.user?.id ?? null, 'MOCK2_FLIGHTDECK_DELETE', 'mock2_project', String(project.id), { path: rel }, req.ip);
    res.json({ path: rel, deleted: true });
  });
}
