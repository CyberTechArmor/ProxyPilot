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

// deriveActivityItem — one shaped-event → one compact activity row (or null for
// kinds the live stream doesn't surface: gate/checkpoint/deploy/task/note). PURE;
// diff counts come from the tool input, and the bulky old/new strings are dropped
// so the poll payload stays small.
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
  const file = input.file_path || input.path || input.notebook_path || null;
  let detail = null; let adds = null; let dels = null;
  switch (name) {
    case 'Read':
      if (input.offset != null) {
        const start = Number(input.offset) || 0;
        detail = input.limit != null ? `lines ${start}–${start + Number(input.limit)}` : `from line ${start}`;
      }
      break;
    case 'Edit': adds = lineCount(input.new_string); dels = lineCount(input.old_string); break;
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      adds = edits.reduce((n, e) => n + lineCount(e.new_string), 0);
      dels = edits.reduce((n, e) => n + lineCount(e.old_string), 0);
      break;
    }
    case 'Write': adds = lineCount(input.content); break;
    case 'Bash': detail = String(input.command || '').replace(/\s+/g, ' ').slice(0, 80); break;
    case 'Grep': case 'Glob': detail = input.pattern ? `"${String(input.pattern).slice(0, 60)}"` : null; break;
    default: break;
  }
  return { ...base, type: 'tool', tool: name, file: basenameOf(file), path: file || null, detail, adds, dels };
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
