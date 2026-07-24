// Flightdeck — the build-phase IDE workspace. ONE place for the workspace name
// (spec: a single WORKSPACE_NAME constant, no "VS"/"VSCode" strings anywhere)
// and the CodeMirror language mapping.
//
// Named "Flightdeck" — on-brand with ProxyPilot: the deck where every instrument
// lives (chat, files, editor, terminal, preview).

import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';

export const WORKSPACE_NAME = 'Flightdeck';

// Per-project persistence keys (localStorage), matching the repo's
// `mock2:<thing>:<id>` convention.
export const flightdeckPrefKey = (projectId) => `mock2:flightdeck:${projectId}`;
export const flightdeckLayoutKey = (projectId) => `mock2:flightdeck-layout:${projectId}`;

// Map the backend's `language` id (flightdeck-logic.languageForPath) to a
// CodeMirror language extension. Unknown → no extension (plain text).
export function codemirrorLanguage(language) {
  switch (language) {
    case 'javascript':
    case 'typescript': // lang-javascript handles TS/JSX/TSX with options
      return javascript({ jsx: true, typescript: language === 'typescript' });
    case 'json': return json();
    case 'html': return html();
    case 'css': return css();
    case 'markdown': return markdown();
    case 'python': return python();
    case 'xml': return xml();
    case 'yaml': return yaml();
    default: return null;
  }
}

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
