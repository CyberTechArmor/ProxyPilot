// Mock2 anchored-edit PURE decision layer (Copilot-grade file editing). Native-
// free, unit-tested stub-first (risk R9): imports nothing that opens a DB, hits
// the network, or touches Incus. runner.js reads the file from the fenced
// container, calls applyEdits here, and writes the result back only on ok:true.
//
// This is the reliable APPLY step — the highest-impact harness lever. The model
// edits an existing file by exact, anchored string replacement instead of
// re-emitting the whole file: cheaper (output tokens cost 5–10× input), and
// safe (a mismatch is a structured error the model retries on, never a silent
// corrupt write). Matching is byte-for-byte — no normalization of the model's
// old_string, so whitespace and indentation must match the file exactly.
//
// applyEdits(content, edits, opts) → on success
//   { ok:true, applied:N, content:<new text>, diff:<unified diff> }
// on failure (NEVER throws — the model acts on the code):
//   { ok:false, error:{ code, message, ... } }
//     NO_MATCH        { code, message, nearest }   old_string not found
//     AMBIGUOUS_MATCH { code, count, message }      matched >1, replace_all false
//     PARSE_FAIL      { code, message }             post-apply validate() rejected
//     INVALID_EDIT    { code, message }             malformed edit input
// The batch is ALL-OR-NOTHING: edits apply sequentially in memory, and if any
// one fails the original content is returned untouched (applied:0). Terminology
// (risk R7): nothing here is named "agent".

// Count non-overlapping byte-exact occurrences of needle in hay.
function countOccurrences(hay, needle) {
  if (needle === '') return 0;
  return hay.split(needle).length - 1;
}

// Replace the FIRST occurrence only, by slice — never String.replace, whose
// replacement string interprets `$&`/`$1` patterns that may appear verbatim in
// the model's new_string.
function replaceFirst(hay, needle, replacement) {
  const i = hay.indexOf(needle);
  if (i < 0) return hay;
  return hay.slice(0, i) + replacement + hay.slice(i + needle.length);
}

// Replace EVERY occurrence, byte-exact, without pattern interpretation.
function replaceAllLiteral(hay, needle, replacement) {
  return hay.split(needle).join(replacement);
}

// The lines of `content` nearest to the first meaningful line of a missing
// old_string, with 1-based line numbers — the hint that lets the model re-anchor
// after a NO_MATCH instead of guessing. Falls back to the file head when nothing
// resembles the anchor. Bounded to a small window so it never bloats the result.
export function nearestLines(content, oldString, { window = 3 } = {}) {
  const lines = String(content).split('\n');
  const anchor = String(oldString).split('\n').map((l) => l.trim()).find((l) => l.length) || '';
  let best = 0;
  if (anchor) {
    let bestScore = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      let score = 0;
      if (t === anchor) score = 1000;
      else if (t.includes(anchor) || anchor.includes(t)) score = Math.min(t.length, anchor.length);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (bestScore < 0) best = 0;
  }
  const start = Math.max(0, best - window);
  const end = Math.min(lines.length, best + window + 1);
  return lines.slice(start, end).map((l, k) => `${start + k + 1}\t${l}`).join('\n');
}

// A compact line-based unified diff (LCS backtrace) with a few lines of context.
// For display in the tool result — shows the model exactly what its edit changed.
export function unifiedDiff(before, after, path = 'file', { context = 3 } = {}) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  // LCS table (line granularity). Files here are single edited files, so the
  // O(n·m) table is fine; guard pathological sizes by capping the table.
  const n = a.length; const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // Backtrace into a flat op list: ' ' equal, '-' remove, '+' add.
  const ops = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) { ops.push(['-', a[i]]); i++; }
  while (j < m) { ops.push(['+', b[j]]); j++; }

  // Collapse into hunks: runs of change plus `context` equal lines on each side.
  const changed = ops.map((o) => o[0] !== ' ');
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (changed[k]) {
      for (let d = -context; d <= context; d++) {
        const idx = k + d;
        if (idx >= 0 && idx < ops.length) keep[idx] = true;
      }
    }
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  // Track original line numbers as we walk ops.
  const opALine = []; const opBLine = [];
  {
    let al = 1; let bl = 1;
    for (const [tag] of ops) {
      opALine.push(al); opBLine.push(bl);
      if (tag === ' ') { al++; bl++; }
      else if (tag === '-') al++;
      else bl++;
    }
  }
  while (k < ops.length) {
    if (!keep[k]) { k++; continue; }
    let end = k;
    while (end < ops.length && keep[end]) end++;
    const slice = ops.slice(k, end);
    const aStart = opALine[k];
    const bStart = opBLine[k];
    const aCount = slice.filter(([t]) => t === ' ' || t === '-').length;
    const bCount = slice.filter(([t]) => t === ' ' || t === '+').length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const [tag, text] of slice) out.push(`${tag}${text}`);
    k = end;
  }
  // No hunks (identical) → empty diff body.
  return out.length > 2 ? out.join('\n') : '';
}

// applyEdits — the contract. `edits` is [{ old_string, new_string, replace_all }].
// `opts.path` labels the diff; `opts.validate(newContent)` is an OPTIONAL post-
// apply syntax/parse hook — return { ok:false, message } to trigger PARSE_FAIL
// and roll the whole batch back (the runner leaves it unset today and verifies
// via the gate battery instead; tests exercise the branch with a fake validator).
export function applyEdits(content, edits, opts = {}) {
  const { path = 'file', validate = null } = opts;
  if (typeof content !== 'string') {
    return { ok: false, error: { code: 'INVALID_EDIT', path, message: 'file content is not text' } };
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: { code: 'INVALID_EDIT', path, message: 'edits must be a non-empty array' } };
  }
  let working = content;
  let applied = 0;
  for (let e = 0; e < edits.length; e++) {
    const edit = edits[e] || {};
    const oldStr = edit.old_string;
    const newStr = edit.new_string;
    const replaceAll = edit.replace_all === true;
    if (typeof oldStr !== 'string' || typeof newStr !== 'string' || oldStr === '') {
      return { ok: false, error: { code: 'INVALID_EDIT', path, message: `edit ${e + 1}: old_string and new_string must be strings and old_string must be non-empty` } };
    }
    if (oldStr === newStr) {
      return { ok: false, error: { code: 'INVALID_EDIT', path, message: `edit ${e + 1}: old_string and new_string are identical — nothing to change` } };
    }
    const count = countOccurrences(working, oldStr);
    if (count === 0) {
      return { ok: false, error: { code: 'NO_MATCH', path, message: `edit ${e + 1}: old_string not found — re-read the file and copy the exact text (whitespace included)`, nearest: nearestLines(working, oldStr) } };
    }
    if (count > 1 && !replaceAll) {
      return { ok: false, error: { code: 'AMBIGUOUS_MATCH', path, count, message: `edit ${e + 1}: old_string matched ${count} times — add surrounding context to make it unique, or set replace_all:true` } };
    }
    working = replaceAll ? replaceAllLiteral(working, oldStr, newStr) : replaceFirst(working, oldStr, newStr);
    applied += replaceAll ? count : 1;
  }
  if (typeof validate === 'function') {
    let v;
    try { v = validate(working); } catch (err) { v = { ok: false, message: String(err?.message || err) }; }
    if (v && v.ok === false) {
      return { ok: false, error: { code: 'PARSE_FAIL', path, message: v.message || 'post-apply validation failed' } };
    }
  }
  return { ok: true, applied, content: working, diff: unifiedDiff(content, working, path) };
}
