// Flightdeck (build-phase IDE workspace) — PURE decision layer for the file API.
// Native-free, unit-tested stub-first (risk R9): imports nothing that opens a DB,
// hits the network, or touches Incus. The route layer (flightdeck.js) does the
// container I/O; everything decidable without it — path safety, tree assembly
// from a raw `find` listing, noise filtering, language detection — lives here.
//
// Terminology: the workspace is "Flightdeck"; the file API operates on the
// project's working tree inside its fenced container (/srv/app on m2-<id>).

// Directories that are build/vendor noise: kept REACHABLE in the tree (the top
// entry is listed) but their contents are not walked, and the UI mutes them.
export const FLIGHTDECK_NOISE_DIRS = Object.freeze(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.turbo', 'coverage']);

// safeRelPath — a clean relative path under the app dir, or null on anything
// unsafe. Rejects absolute paths, drive letters, NUL, and any '..' traversal;
// collapses '.'/'//'. Returns '.' for the root. This is the ONE traversal guard
// every file endpoint funnels through (mirrors runner.safeRel, plus normalization).
export function safeRelPath(p) {
  const s = String(p ?? '').trim();
  if (s === '' || s === '.' || s === './') return '.';
  if (s.includes('\0')) return null;
  if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return null; // absolute / drive
  const out = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null; // traversal — reject the whole path
    out.push(seg);
  }
  return out.length ? out.join('/') : '.';
}

export function isNoiseDir(name) {
  return FLIGHTDECK_NOISE_DIRS.includes(String(name || ''));
}

// Language id by extension (CodeMirror-friendly; the frontend maps it to a lang
// extension). 'text' when unknown. Kept small + deterministic.
const EXT_LANG = Object.freeze({
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json',
  html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css',
  md: 'markdown', markdown: 'markdown', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', java: 'java', kt: 'java', c: 'cpp', h: 'cpp', hpp: 'cpp',
  cc: 'cpp', cpp: 'cpp', cs: 'csharp', php: 'php', sh: 'shell', bash: 'shell',
  zsh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  sql: 'sql', xml: 'xml', svg: 'xml', vue: 'vue', svelte: 'svelte',
  dockerfile: 'dockerfile', env: 'text', txt: 'text',
});
export function languageForPath(path) {
  const base = String(path || '').toLowerCase();
  if (/(^|\/)dockerfile$/.test(base)) return 'dockerfile';
  const m = base.match(/\.([a-z0-9]+)$/);
  return m ? (EXT_LANG[m[1]] || 'text') : 'text';
}

// parseFindTypeOutput — parse the container's `find` listing. Each line is
// "<D|F>\t<path>" (dir/file + path relative to the app dir). Returns
// { paths, dirs } with clean relative paths (leading "./" and trailing "/"
// stripped) and unsafe entries dropped. dirs is the Set of directory paths.
export function parseFindTypeOutput(stdout) {
  const paths = [];
  const dirs = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^([DF])\t(.+)$/);
    if (!m) continue;
    const rel = safeRelPath(m[2].replace(/^\.\//, '').replace(/\/+$/, ''));
    if (!rel || rel === '.') continue;
    paths.push(rel);
    if (m[1] === 'D') dirs.add(rel);
  }
  return { paths, dirs };
}

// buildFileTree — assemble a nested tree from a flat list of relative paths plus
// the set of which are directories. Nodes: { name, path, type:'dir'|'file',
// children?, muted? }. Intermediate dirs implied by a path are created even if
// not explicitly listed. Noise dirs are marked muted. Sorted dirs-first, then
// alphabetical.
export function buildFileTree(paths, { dirs = null } = {}) {
  const dirSet = dirs instanceof Set ? dirs : new Set(dirs || []);
  const root = { name: '', path: '.', type: 'dir', children: [] };
  const index = new Map([['.', root]]);

  const ensureDir = (relPath) => {
    if (index.has(relPath)) return index.get(relPath);
    const cut = relPath.lastIndexOf('/');
    const parentPath = cut >= 0 ? relPath.slice(0, cut) : '.';
    const name = cut >= 0 ? relPath.slice(cut + 1) : relPath;
    const parent = ensureDir(parentPath);
    const node = { name, path: relPath, type: 'dir', children: [], muted: isNoiseDir(name) };
    parent.children.push(node);
    index.set(relPath, node);
    return node;
  };

  for (const rel of paths) {
    if (!rel || rel === '.') continue;
    if (dirSet.has(rel)) { ensureDir(rel); continue; }
    const cut = rel.lastIndexOf('/');
    const parentPath = cut >= 0 ? rel.slice(0, cut) : '.';
    const name = cut >= 0 ? rel.slice(cut + 1) : rel;
    // A path under a noise dir shouldn't be materialized as a file leaf.
    const parent = ensureDir(parentPath);
    if (!index.has(rel)) parent.children.push({ name, path: rel, type: 'file' });
  }
  sortTree(root);
  return root.children;
}

function sortTree(node) {
  if (!node.children) return;
  node.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  for (const c of node.children) sortTree(c);
}

// The `find` command body run inside the container to list the tree. Excludes
// the CONTENTS of noise dirs (via -path guards) but still lists their top entry,
// so they stay reachable; bounded depth keeps a huge tree from flooding. Emits
// "<D|F>\t<path>" lines parseFindTypeOutput understands. Pure string (no I/O).
export function buildFindCommand({ maxDepth = 8 } = {}) {
  const excl = FLIGHTDECK_NOISE_DIRS.map((d) => `-not -path '*/${d}/*'`).join(' ');
  const base = `find . -maxdepth ${Number(maxDepth) || 8} ${excl}`;
  // Two typed passes, marked, so a busybox `find` (no -printf) still works.
  return `${base} -type d 2>/dev/null | sed 's|^|D\\t|'; ${base} -type f 2>/dev/null | sed 's|^|F\\t|'`;
}

// A friendly cap: refuse to open absurdly large files in the editor.
export const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;

// isProbablyBinary — a quick NUL-byte / control-char heuristic so the editor
// doesn't try to render a binary blob. Operates on the first slice of content.
export function isProbablyBinary(sample) {
  const s = String(sample || '');
  const n = Math.min(s.length, 4096);
  if (n === 0) return false;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl / n > 0.3;
}
