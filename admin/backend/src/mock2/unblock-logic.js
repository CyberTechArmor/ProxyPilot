// Mock2 human-feedback / unblock PURE decision layer (native-free, unit-tested).
// The channels that let a blocked/awaiting cycle receive new context and progress:
//   - halt resolution OPTIONS the model proposes (Part 2),
//   - the RESUME CONTEXT injected as a labeled user turn on resume (Parts 1/2/4),
//   - scoped one-time AUTHORIZATION rendering (Part 4),
//   - the APPROVE-AS-EDITED authoritative deviation text (Part 3).
// Everything here is pure so the wire formats are testable and can't drift.
//
// Terminology (risk R7): nothing here is named "agent".

export const HALT_OPTION_LIMIT = 6;

// Normalize the model's proposed resolution options (from halt(reason, options)) into
// [{ id, label, detail }]. Tolerant of a bare string list or {label/detail} objects.
// Ids are stable, human-meaningful slugs so a selection round-trips through the UI.
export function parseHaltOptions(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  for (let i = 0; i < arr.length && out.length < HALT_OPTION_LIMIT; i++) {
    const raw = arr[i];
    let label = '';
    let detail = '';
    let id = '';
    if (typeof raw === 'string') { label = raw.trim(); }
    else if (raw && typeof raw === 'object') {
      label = String(raw.label || raw.title || raw.text || '').trim();
      detail = String(raw.detail || raw.description || '').trim();
      id = String(raw.id || '').trim();
    }
    if (!label) continue;
    if (!id) id = `opt-${i + 1}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)}`;
    if (out.some((o) => o.id === id)) id = `${id}-${i + 1}`;
    out.push({ id, label, detail });
  }
  return out;
}

// Find the option the operator selected (by id or label). Returns the option object
// or, when the operator typed a free-text choice not in the list, a synthesized one.
export function resolveSelectedOption(options = [], selected) {
  const sel = selected == null ? '' : String(selected).trim();
  if (!sel) return null;
  const list = Array.isArray(options) ? options : [];
  const hit = list.find((o) => o.id === sel || o.label === sel);
  if (hit) return hit;
  return { id: 'free', label: sel, detail: '' };
}

// buildResumeContextBlock — the AUTHORITATIVE operator-guidance turn injected AFTER
// the original task when a cycle resumes. Clearly labeled so the model treats it as
// human direction (not part of its own reasoning). Includes, when present: the
// operator's free-text message, the resolution option they chose, and any scoped
// one-time authorizations granted for THIS resume. Returns '' when there's nothing to
// add (a bare resume stays a bare resume).
export function buildResumeContextBlock({ message = '', selectedOption = null, authorizations = [] } = {}) {
  const msg = String(message || '').trim();
  const opt = selectedOption && selectedOption.label ? selectedOption : null;
  const auths = (Array.isArray(authorizations) ? authorizations : []).filter((a) => a && a.scope);
  if (!msg && !opt && !auths.length) return '';

  const lines = [
    'Operator guidance on resume (AUTHORITATIVE — a human is directing this build after it',
    'paused/blocked. Follow this guidance; it supersedes your earlier assumptions where they',
    'conflict, but never the constitution unless an authorization or approved deviation below',
    'explicitly permits it):',
  ];
  if (opt) {
    lines.push('', `Chosen resolution: ${opt.label}${opt.detail ? ` — ${opt.detail}` : ''}`);
  }
  if (msg) {
    lines.push('', `Operator message: ${msg}`);
  }
  if (auths.length) {
    lines.push('', buildAuthorizationBlock(auths));
  }
  return lines.join('\n');
}

// buildAuthorizationBlock — how a granted scoped authorization is presented to the
// model. It is a NARROW, single-use permission: the model may perform EXACTLY the
// scoped act and nothing broader, this once. Conditions the admin appended are
// binding. Pure so the wording is one place + testable.
export function buildAuthorizationBlock(authorizations = []) {
  const auths = (Array.isArray(authorizations) ? authorizations : []).filter((a) => a && a.scope);
  if (!auths.length) return '';
  const items = auths.map((a) => {
    const cond = a.conditions ? ` [conditions: ${String(a.conditions).trim()}]` : '';
    return `- ${String(a.scope).trim()}${cond}`;
  });
  return [
    'Authorized one-time operations (an administrator granted these for THIS resume only —',
    'single-use and scoped EXACTLY as written. Perform only the scoped act, exactly once, and',
    'only if it is necessary to unblock the change; do not generalize it into a standing',
    'behavior or touch anything outside the stated scope):',
    ...items,
  ].join('\n');
}

// approveAsEditedText — for "approve as edited": the admin may rewrite the deviation
// text and/or append conditions; the result becomes the AUTHORITATIVE approved record
// the runner is handed. Returns the edited deviation text (with conditions folded in)
// used to replace the deviation's question text, plus the short resolution note stored
// on the answer marker. Pure. When nothing is edited, returns the original text.
export function approveAsEditedText({ originalText = '', editedText = '', conditions = '' } = {}) {
  const base = String(editedText || '').trim() || String(originalText || '').trim();
  const cond = String(conditions || '').trim();
  const text = cond ? `${base}\n  Conditions: ${cond}` : base;
  const resolutionNote = cond ? `approved as edited; conditions: ${cond}` : (String(editedText || '').trim() ? 'approved as edited' : 'approved');
  return { text, resolutionNote, edited: !!(String(editedText || '').trim() || cond) };
}

// A concise validity check for a requested authorization scope. It must be a non-empty,
// bounded, single statement of intent — not a blank or an essay. Pure.
export function validateAuthScope(scope) {
  const s = String(scope || '').trim();
  if (!s) return { ok: false, error: 'an authorization must state an exact scope' };
  if (s.length > 2000) return { ok: false, error: 'authorization scope is too long (max 2000 chars)' };
  return { ok: true, scope: s };
}
