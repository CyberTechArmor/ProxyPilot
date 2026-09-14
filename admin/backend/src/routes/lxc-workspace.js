// LXC workspace — the Flightdeck file API for an operator's container.
//
// The container dialog's Workspace tab (admin/frontend/src/components/lxc/
// LxcWorkspace.jsx) reuses Flightdeck's explorer + editor + terminal + preview
// over these routes. Same tree/read/save/create/rename/delete contract as
// mock2/flightdeck.js, with one difference: the root is an operator-chosen
// ABSOLUTE directory inside the guest (`?root=` / body.root) instead of the fixed
// /srv/app, because a hand-built LXC keeps its app wherever the operator put it.
//
// Auth: registered on lxcRouter AFTER its `use(requireProxyAccess)` (mounted at
// /api/lxc behind authenticateToken + blockPendingRole + CSRF), so the same
// people who can already browse/upload files via the legacy Files tab can use
// this. Every guest path rides as an argv positional parameter of `sh -c`
// (never interpolated into the script), the relative part goes through
// Flightdeck's safeRelPath guard, and the root through validAbsDir. File bytes
// go over stdin (write) / stdout (read) — nothing touches the host filesystem.
// Pure decisions live in lib/lxc-workspace-logic.js (unit-tested).

import { z } from 'zod';
import { logAudit } from '../db.js';
import { runHostCapture, readContainerStartup } from '../lib/lxc-zip.js';
import {
  buildFindCommand, parseFindTypeOutput, buildFileTree, languageForPath, isProbablyBinary,
  MAX_EDIT_FILE_BYTES,
} from '../mock2/flightdeck-logic.js';
import {
  validAbsDir, joinWorkspacePath, pickDefaultRoot, buildRootProbeScript, parseRootProbeOutput,
} from '../lib/lxc-workspace-logic.js';

const INSTANCE_PREFIX = 'pp-';
const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const MAX_SAVE_BYTES = 4_000_000;

const rootField = z.string().min(1).max(4096);
const saveSchema = z.object({ root: rootField, path: z.string().min(1).max(4096), content: z.string().max(MAX_SAVE_BYTES) });
const createSchema = z.object({ root: rootField, path: z.string().min(1).max(4096), type: z.enum(['file', 'dir']).default('file'), content: z.string().max(MAX_SAVE_BYTES).optional() });
const renameSchema = z.object({ root: rootField, from: z.string().min(1).max(4096), to: z.string().min(1).max(4096) });

// Every guest path is a positional parameter: `sh -c '<script>' sh <p1> <p2>…`.
function guestSh(incusName, script, params, opts = {}) {
  return runHostCapture('incus', ['exec', incusName, '--', 'sh', '-c', script, 'sh', ...params], { timeoutMs: 30000, ...opts });
}

function notRunning(res, r, what) {
  const detail = (r.stderr || '').trim().slice(-300);
  return res.status(502).json({ success: false, error: `${what} — is the container running?${detail ? ` ${detail}` : ''}` });
}

// Resolve the container name from the URL, or answer 400.
function containerFor(req, res) {
  const { name } = req.params;
  if (!NAME_REGEX.test(String(name || ''))) {
    res.status(400).json({ success: false, error: 'Invalid container name.' });
    return null;
  }
  return { name, incusName: `${INSTANCE_PREFIX}${name}` };
}

// The root for a request: the operator's choice when given (validated), else the
// startup unit's working directory, else the first conventional app directory
// that exists, else /root. Answers 400 itself on a bad explicit root.
async function resolveRoot(req, res, incusName) {
  const raw = req.method === 'GET' || req.method === 'DELETE' ? req.query.root : req.body?.root;
  if (raw != null && String(raw).trim() !== '') {
    const root = validAbsDir(raw);
    if (!root) { res.status(400).json({ success: false, error: 'root must be an absolute directory inside the container' }); return null; }
    return root;
  }
  const startup = await readContainerStartup(incusName).catch(() => null);
  const probe = await runHostCapture('incus', ['exec', incusName, '--', 'sh', '-c', buildRootProbeScript()], { timeoutMs: 15000 });
  return pickDefaultRoot({ startupWorkingDir: startup?.workingDir || null, existing: probe.status === 0 ? parseRootProbeOutput(probe.stdout) : [] });
}

export function registerLxcWorkspaceRoutes(lxcRouter) {
  // ---- read: directory tree under the root ----
  // No root → the default is resolved and echoed back, so the UI can show it.
  lxcRouter.get('/containers/:name/workspace/tree', async (req, res) => {
    const c = containerFor(req, res); if (!c) return;
    const root = await resolveRoot(req, res, c.incusName); if (!root) return;
    const script = `cd "$1" 2>/dev/null || exit 3; ${buildFindCommand({ maxDepth: 8 })}`;
    const r = await guestSh(c.incusName, script, [root], { timeoutMs: 60000 });
    if (r.status === 3) return res.status(404).json({ success: false, error: `${root} is not a directory in this container`, root });
    if (r.status !== 0) return notRunning(res, r, 'Could not list the directory');
    const { paths, dirs } = parseFindTypeOutput(r.stdout || '');
    res.json({ success: true, root, tree: buildFileTree(paths, { dirs }), truncated: r.stdoutTruncated === true });
  });

  // ---- read: file content ----
  lxcRouter.get('/containers/:name/workspace/file', async (req, res) => {
    const c = containerFor(req, res); if (!c) return;
    const root = await resolveRoot(req, res, c.incusName); if (!root) return;
    const abs = joinWorkspacePath(root, req.query.path);
    if (!abs) return res.status(400).json({ success: false, error: 'invalid path' });
    const script = 'p="$1"; test -f "$p" || exit 66; head -c "$2" -- "$p"';
    const r = await guestSh(c.incusName, script, [abs, String(MAX_EDIT_FILE_BYTES + 1)], { maxCapture: MAX_EDIT_FILE_BYTES + 64 * 1024 });
    if (r.status === 66) return res.status(404).json({ success: false, error: `not a file: ${abs}` });
    if (r.status !== 0) return notRunning(res, r, 'Could not read the file');
    const content = r.stdout || '';
    if (content.length > MAX_EDIT_FILE_BYTES) return res.status(413).json({ success: false, error: 'file too large to open in the editor', size: content.length });
    if (isProbablyBinary(content)) return res.status(415).json({ success: false, error: 'binary file — not editable as text', path: abs, binary: true });
    const rel = String(req.query.path);
    res.json({ success: true, root, path: rel, absolutePath: abs, content, language: languageForPath(rel), size: content.length });
  });

  // ---- write: save (create or overwrite). Bytes over stdin; the target dir is
  // created on the way so a new file in a new folder is one call. ----
  lxcRouter.put('/containers/:name/workspace/file', async (req, res) => {
    const c = containerFor(req, res); if (!c) return;
    const parsed = saveSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ success: false, error: 'root, path and content are required' });
    const root = validAbsDir(parsed.data.root);
    const abs = root && joinWorkspacePath(root, parsed.data.path);
    if (!abs) return res.status(400).json({ success: false, error: 'invalid path' });
    const script = 'p="$1"; mkdir -p "$(dirname "$p")" && cat > "$p" && echo PP_OK';
    const r = await guestSh(c.incusName, script, [abs], { input: parsed.data.content, timeoutMs: 60000 });
    if (r.status !== 0 || !String(r.stdout || '').includes('PP_OK')) return notRunning(res, r, 'Could not save the file');
    logAudit(req.user?.id ?? null, 'LXC_WORKSPACE_SAVE', 'lxc_container', c.name, { path: abs, bytes: Buffer.byteLength(parsed.data.content) }, req.ip);
    res.json({ success: true, root, path: parsed.data.path, absolutePath: abs, saved: true });
  });

  // ---- create: new file or folder (fails if it exists) ----
  lxcRouter.post('/containers/:name/workspace/create', async (req, res) => {
    const c = containerFor(req, res); if (!c) return;
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ success: false, error: 'root and path are required' });
    const root = validAbsDir(parsed.data.root);
    const abs = root && joinWorkspacePath(root, parsed.data.path);
    if (!abs) return res.status(400).json({ success: false, error: 'invalid path' });
    const isDir = parsed.data.type === 'dir';
    const script = isDir
      ? 'p="$1"; [ -e "$p" ] && { echo EXISTS; exit 0; }; mkdir -p "$p" && echo PP_OK'
      : 'p="$1"; [ -e "$p" ] && { echo EXISTS; exit 0; }; mkdir -p "$(dirname "$p")" && cat > "$p" && echo PP_OK';
    const r = await guestSh(c.incusName, script, [abs], isDir ? {} : { input: parsed.data.content ?? '' });
    const out = String(r.stdout || '');
    if (out.includes('EXISTS')) return res.status(409).json({ success: false, error: 'already exists' });
    if (r.status !== 0 || !out.includes('PP_OK')) return notRunning(res, r, `Could not create the ${isDir ? 'folder' : 'file'}`);
    logAudit(req.user?.id ?? null, 'LXC_WORKSPACE_CREATE', 'lxc_container', c.name, { path: abs, kind: parsed.data.type }, req.ip);
    res.status(201).json({ success: true, root, path: parsed.data.path, absolutePath: abs, type: parsed.data.type, created: true });
  });

  // ---- rename / move (within the root) ----
  lxcRouter.post('/containers/:name/workspace/rename', async (req, res) => {
    const c = containerFor(req, res); if (!c) return;
    const parsed = renameSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ success: false, error: 'root, from and to are required' });
    const root = validAbsDir(parsed.data.root);
    const from = root && joinWorkspacePath(root, parsed.data.from);
    const to = root && joinWorkspacePath(root, parsed.data.to);
    if (!from || !to) return res.status(400).json({ success: false, error: 'invalid path' });
    const script = 's="$1"; t="$2"; [ ! -e "$s" ] && { echo NOSRC; exit 0; }; [ -e "$t" ] && { echo DSTEXISTS; exit 0; }; mkdir -p "$(dirname "$t")" && mv "$s" "$t" && echo PP_OK';
    const r = await guestSh(c.incusName, script, [from, to]);
    const out = String(r.stdout || '');
    if (out.includes('NOSRC')) return res.status(404).json({ success: false, error: 'source not found' });
    if (out.includes('DSTEXISTS')) return res.status(409).json({ success: false, error: 'destination already exists' });
    if (r.status !== 0 || !out.includes('PP_OK')) return notRunning(res, r, 'Could not rename');
    logAudit(req.user?.id ?? null, 'LXC_WORKSPACE_RENAME', 'lxc_container', c.name, { from, to }, req.ip);
    res.json({ success: true, root, from: parsed.data.from, to: parsed.data.to, renamed: true });
  });

  // ---- delete (file or folder; recursive for folders; never the root) ----
  lxcRouter.delete('/containers/:name/workspace/file', async (req, res) => {
    const c = containerFor(req, res); if (!c) return;
    const root = validAbsDir(req.query.root);
    const abs = root && joinWorkspacePath(root, req.query.path);
    if (!abs) return res.status(400).json({ success: false, error: 'invalid path' });
    const script = 'p="$1"; [ ! -e "$p" ] && { echo NONE; exit 0; }; rm -rf -- "$p" && echo PP_OK';
    const r = await guestSh(c.incusName, script, [abs]);
    const out = String(r.stdout || '');
    if (out.includes('NONE')) return res.status(404).json({ success: false, error: 'not found' });
    if (r.status !== 0 || !out.includes('PP_OK')) return notRunning(res, r, 'Could not delete');
    logAudit(req.user?.id ?? null, 'LXC_WORKSPACE_DELETE', 'lxc_container', c.name, { path: abs }, req.ip);
    res.json({ success: true, root, path: String(req.query.path), deleted: true });
  });
}
