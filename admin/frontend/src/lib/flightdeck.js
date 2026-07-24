// Flightdeck — the build-phase IDE workspace. ONE place for the workspace name
// (spec: a single WORKSPACE_NAME constant, no "VS"/"VSCode" strings anywhere)
// and the per-project persistence keys.
//
// Named "Flightdeck" — on-brand with ProxyPilot: the deck where every instrument
// lives (chat, files, editor, terminal, preview).
//
// IMPORTANT: this module is imported by the eagerly-loaded ProjectDetail page,
// so it must stay LIGHT — no CodeMirror/editor imports. The CodeMirror language
// mapping lives in FlightdeckEditor (loaded lazily with the workspace), which
// keeps the heavy editor packages out of the main bundle and avoids a
// cross-chunk init-order (TDZ) hazard from CodeMirror's internal circular deps.

export const WORKSPACE_NAME = 'Flightdeck';

// Per-project persistence keys (localStorage), matching the repo's
// `mock2:<thing>:<id>` convention.
export const flightdeckPrefKey = (projectId) => `mock2:flightdeck:${projectId}`;
export const flightdeckLayoutKey = (projectId) => `mock2:flightdeck-layout:${projectId}`;

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
