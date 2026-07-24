// Pure derivation of the live "what's being worked on" activity stream from raw
// cycle events. Kept DB-free (no getMock2Db import) so it is unit-testable in the
// native-free sandbox; cycle-events.js re-exports it and does the DB read.
//
// An activity row is either the model's narration ({type:'message'}) or a file
// operation ({type:'tool', tool, file, path, detail, adds, dels}) — the VS Code
// / Claude-Code style feed the build chat renders while a cycle runs.

export function basenameOf(p) {
  if (!p) return null;
  const s = String(p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

export function lineCount(s) {
  if (s == null) return 0;
  const str = String(s);
  return str ? str.split('\n').length : 0;
}

// Canonical actions — so every harness's tool vocabulary (Claude SDK's
// Read/Edit/Write/Bash/Grep, the Copilot/ProxyPilot harness's read_file/
// write_file/list_dir/run_terminal/search_workspace, …) collapses to one small
// set the UI can give a consistent icon + verb. `match` is lowercased tool names.
const TOOL_ACTIONS = [
  ['read', 'Read', ['read', 'read_file', 'view', 'open_file', 'cat', 'cat_file']],
  ['edit', 'Edited', ['edit', 'multiedit', 'edit_file', 'apply_patch', 'str_replace', 'str_replace_editor', 'patch']],
  ['write', 'Wrote', ['write', 'write_file', 'save_file']],
  ['create', 'Created', ['create_file', 'create', 'new_file', 'touch']],
  ['delete', 'Deleted', ['delete_file', 'delete', 'rm', 'remove_file']],
  ['search', 'Searched', ['grep', 'glob', 'search', 'search_workspace', 'grep_search', 'file_search', 'ripgrep']],
  ['run', 'Ran', ['bash', 'run_terminal', 'exec', 'shell', 'run', 'run_gates', 'run_command']],
  ['list', 'Listed', ['list_dir', 'ls', 'list', 'readdir']],
  ['check', 'Checked', ['get_diagnostics', 'diagnostics', 'lint', 'typecheck']],
];
function classify(tool) {
  const t = String(tool || '').toLowerCase();
  for (const [action, verb, names] of TOOL_ACTIONS) if (names.includes(t)) return { action, verb };
  // Fallback: a readable verb from the raw tool name (snake/camel → Title Case).
  const verb = t.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase()) || 'Tool';
  return { action: 'other', verb };
}

// deriveActivityItem — one shaped-event → one compact activity row (or null for
// kinds the live stream doesn't surface: gate/checkpoint/deploy/task/note). PURE;
// diff counts come from the tool input, and the bulky old/new strings are dropped
// so the poll payload stays small. `action` is the canonical kind the UI styles;
// `tool` keeps the raw name.
export function deriveActivityItem(ev) {
  if (!ev) return null;
  const base = { seq: ev.seq, at: ev.created_at };
  if (ev.kind === 'ai_message') {
    const text = String(ev.content || '').trim();
    return text ? { ...base, type: 'message', text } : null;
  }
  if (ev.kind !== 'tool_call') return null;
  const name = (ev.meta && ev.meta.name) || 'tool';
  const input = (ev.meta && ev.meta.input) || {};
  const { action, verb } = classify(name);
  const file = input.file_path || input.path || input.notebook_path || input.filename || null;
  let detail = null; let adds = null; let dels = null;
  if (action === 'read') {
    if (input.offset != null) {
      const start = Number(input.offset) || 0;
      detail = input.limit != null ? `lines ${start}–${start + Number(input.limit)}` : `from line ${start}`;
    }
  } else if (action === 'edit') {
    if (Array.isArray(input.edits)) {
      adds = input.edits.reduce((n, e) => n + lineCount(e.new_string), 0);
      dels = input.edits.reduce((n, e) => n + lineCount(e.old_string), 0);
    } else if (input.new_string != null || input.old_string != null) {
      adds = lineCount(input.new_string); dels = lineCount(input.old_string);
    }
  } else if (action === 'write' || action === 'create') {
    if (input.content != null) adds = lineCount(input.content);
  } else if (action === 'run') {
    detail = String(input.command || input.cmd || '').replace(/\s+/g, ' ').slice(0, 80) || null;
  } else if (action === 'search') {
    const q = input.query || input.pattern || input.q;
    detail = q ? `"${String(q).slice(0, 60)}"` : null;
  }
  return { ...base, type: 'tool', tool: name, action, verb, file: basenameOf(file), path: file || null, detail, adds, dels };
}

// Trim a chronological event list to the last `limit` surfaced rows.
export function deriveActivity(events = [], { limit = 40 } = {}) {
  const items = [];
  for (const ev of events) {
    const it = deriveActivityItem(ev);
    if (it) items.push(it);
  }
  return items.slice(-Math.max(1, limit));
}
