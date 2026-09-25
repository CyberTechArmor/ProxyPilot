// Dev Studio — the build-phase IDE workspace. ONE place for the workspace name
// (spec: a single WORKSPACE_NAME constant, no "VS"/"VSCode" strings anywhere)
// and the per-project persistence keys.
//
// Display label: Dev Studio. Legacy Flightdeck module names, API routes and
// persistence keys stay stable for compatibility.
//
// IMPORTANT: this module is imported by the eagerly-loaded ProjectDetail page,
// so it must stay LIGHT — no CodeMirror/editor imports. The CodeMirror language
// mapping lives in FlightdeckEditor (loaded lazily with the workspace), which
// keeps the heavy editor packages out of the main bundle and avoids a
// cross-chunk init-order (TDZ) hazard from CodeMirror's internal circular deps.

import { api } from '@/lib/api';

export const WORKSPACE_NAME = 'Dev Studio';

// ---- File-system adapters -------------------------------------------------
// The explorer (FlightdeckFileTree) and editor (FlightdeckEditor) talk to the
// files behind them through this one small interface, so the SAME components
// serve a Mock2 project sandbox (/srv/app in m2-<id>) and an operator's LXC
// (any directory the operator picks). Every method returns the backend's JSON.
//   tree()                 → { tree, root? }
//   read(path)             → { content, language }
//   save(path, content)
//   create(path, 'file'|'dir', content?)
//   rename(from, to)
//   remove(path)
//   key                    — identity string; a change means "different files"
//                            (tabs/tree reset), e.g. another project or root.

export function mock2FlightdeckFs(projectId) {
  return {
    key: `mock2:${projectId}`,
    tree: () => api.mock2FlightdeckTree(projectId),
    read: (path) => api.mock2FlightdeckReadFile(projectId, path),
    save: (path, content) => api.mock2FlightdeckSaveFile(projectId, path, content),
    create: (path, type, content) => api.mock2FlightdeckCreate(projectId, path, type, content),
    rename: (from, to) => api.mock2FlightdeckRename(projectId, from, to),
    remove: (path) => api.mock2FlightdeckDelete(projectId, path),
  };
}

// An LXC workspace rooted at `root` (absolute, inside the guest). Paths handed
// to/returned from the tree are relative to that root.
export function lxcWorkspaceFs(containerName, root) {
  return {
    key: `lxc:${containerName}:${root}`,
    root,
    tree: () => api.lxcWorkspaceTree(containerName, root),
    read: (path) => api.lxcWorkspaceReadFile(containerName, root, path),
    save: (path, content) => api.lxcWorkspaceSaveFile(containerName, root, path, content),
    create: (path, type, content) => api.lxcWorkspaceCreate(containerName, root, path, type, content),
    rename: (from, to) => api.lxcWorkspaceRename(containerName, root, from, to),
    remove: (path) => api.lxcWorkspaceDelete(containerName, root, path),
    // Absolute guest path for a tree-relative one (terminal cwd, downloads).
    absolute: (path) => (!path || path === '.' ? root : (root === '/' ? `/${path}` : `${root}/${path}`)),
  };
}

// Per-project persistence keys (localStorage), matching the repo's
// `mock2:<thing>:<id>` convention.
export const flightdeckPrefKey = (projectId) => `mock2:flightdeck:${projectId}`;
export const flightdeckLayoutKey = (projectId) => `mock2:flightdeck-layout:${projectId}`;
// The container dialog's Workspace tab: layout + last-opened root, per container.
export const lxcWorkspaceLayoutKey = (name) => `lxc:workspace-layout:${name}`;
export const lxcWorkspaceRootKey = (name) => `lxc:workspace-root:${name}`;

// A read of localStorage that never throws (private-mode / disabled storage).
export function readPref(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; }
  catch { return fallback; }
}
export function writePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}
export function readJsonPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
export function writeJsonPref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
