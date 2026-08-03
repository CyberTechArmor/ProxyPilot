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

// The TYPED resolution kinds a halt option can carry (task Part 1). Every option is
// classified so the UI renders it right and the resume path knows how to treat the
// choice:
//   - grant_authorization  : grant a scoped ONE-TIME privileged op (carries the exact
//                            scope + expected row count) — admin only.
//   - expand_scope         : broaden what this build may touch / hand it missing context.
//   - run_dependency_first : do a prerequisite (e.g. another cycle) before resuming.
//   - override_rule        : override a constitution rule for THIS build — admin only.
//   - abandon              : give up this cycle (closes it as abandoned, no resume).
export const HALT_OPTION_KINDS = Object.freeze([
  'grant_authorization', 'expand_scope', 'run_dependency_first', 'override_rule', 'abandon',
]);

// Kinds that perform a privileged act (grant a one-time authorization, or override a
// constitution rule) and so may only be CHOSEN by an administrator — the prompt even
// documents override_rule as "override_rule (admin)". Every other kind, and a
// free-text "Other" answer, an editor can pick.
export const ADMIN_ONLY_HALT_KINDS = Object.freeze(['grant_authorization', 'override_rule']);

export function haltOptionRequiresAdmin(kind) {
  return ADMIN_ONLY_HALT_KINDS.includes(String(kind || ''));
}

// Kinds whose choice carries a one-time authorization to grant on resume (the scope
// the operator is signing off on). grant_authorization always does; override_rule may.
export function haltOptionCarriesAuthorization(option) {
  return !!(option && (option.kind === 'grant_authorization' || option.kind === 'override_rule') && option.authorization?.scope);
}

// Coerce the model's kind string onto one of HALT_OPTION_KINDS. Tolerant: the prompt
// documents override_rule as "override_rule (admin)" (the " (admin)" collapses to a
// trailing "_admin" we strip); a missing/unknown kind is inferred from the option
// (an inline authorization scope ⇒ grant_authorization, an "abandon" label ⇒ abandon)
// and otherwise defaults to the neutral expand_scope so a well-formed option is never
// dropped for a sloppy kind.
function normalizeHaltKind(kind, { hasScope = false, label = '' } = {}) {
  let k = String(kind || '').trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
  k = k.replace(/_admin$/, '');
  if (HALT_OPTION_KINDS.includes(k)) return k;
  if (/abandon|give_?up/.test(k) || /\b(abandon|give up)\b/i.test(label)) return 'abandon';
  if (hasScope) return 'grant_authorization';
  return 'expand_scope';
}

// Normalize the model's proposed resolution options (from halt(reason, options)) into
// [{ id, label, kind, detail, risk, injectOnResume, recommended, authorization }].
// Tolerant of a bare string list, legacy {label, detail} objects, and the enriched
// shape (kind, risk, injectOnResume, recommended, authorization:{scope,expectedRows}).
// Ids are stable, human-meaningful slugs so a selection round-trips through the UI;
// at most ONE option keeps recommended:true (the first that asks for it).
export function parseHaltOptions(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  let recommendedTaken = false;
  for (let i = 0; i < arr.length && out.length < HALT_OPTION_LIMIT; i++) {
    const raw = arr[i];
    let label = '';
    let detail = '';
    let id = '';
    let kindRaw = '';
    let inject = '';
    let wantsRecommended = false;
    let authorization = null;
    if (typeof raw === 'string') { label = raw.trim(); }
    else if (raw && typeof raw === 'object') {
      label = String(raw.label || raw.title || raw.text || '').trim();
      // risk/tradeoff is the one-line note; `detail`/`description` kept for back-compat.
      detail = String(raw.risk || raw.tradeoff || raw.detail || raw.description || '').trim();
      id = String(raw.id || '').trim();
      kindRaw = raw.kind || raw.type || '';
      inject = String(raw.injectOnResume || raw.inject || raw.resumeGuidance || raw.resume || '').trim();
      wantsRecommended = raw.recommended === true || raw.recommend === true;
      const a = raw.authorization || raw.auth || null;
      const scope = String((a && (a.scope || a.sql)) || raw.scope || raw.sql || '').trim();
      if (scope) {
        const rowsRaw = (a && (a.expectedRows ?? a.rows ?? a.rowCount)) ?? raw.expectedRows ?? raw.rows ?? raw.rowCount;
        const expectedRows = rowsRaw == null || rowsRaw === '' ? null : String(rowsRaw).trim();
        authorization = { scope, expectedRows };
      }
    }
    if (!label) continue;
    const kind = normalizeHaltKind(kindRaw, { hasScope: !!authorization, label });
    if (!id) id = `opt-${i + 1}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)}`;
    if (out.some((o) => o.id === id)) id = `${id}-${i + 1}`;
    let recommended = false;
    if (wantsRecommended && !recommendedTaken) { recommended = true; recommendedTaken = true; }
    out.push({ id, label, kind, detail, risk: detail, injectOnResume: inject, recommended, authorization });
  }
  return out;
}

// Validate a halt's proposed options (task Part 4: "never a bare refusal"). A model
// halt must offer at least `min` viable options, and any grant_authorization /
// override_rule option must carry an exact authorization scope (the operator has to
// see precisely what they'd be signing off on). Returns { ok, error, options } with
// the normalized options either way, so the caller can feed the error back for a retry.
export function validateHaltOptions(input, { min = 2 } = {}) {
  const options = parseHaltOptions(input);
  if (options.length < min) {
    return { ok: false, error: `a halt must propose at least ${min} resolution options with tradeoffs — never a bare refusal (got ${options.length})`, options };
  }
  for (const o of options) {
    if (o.kind === 'grant_authorization' || o.kind === 'override_rule') {
      const v = validateAuthScope(o.authorization?.scope);
      if (!v.ok) {
        return { ok: false, error: `option "${o.label}" (${o.kind}) must state the exact authorization scope: ${v.error}`, options };
      }
    }
  }
  return { ok: true, options };
}

// Find the option the operator selected (by id or label). Returns the option object
// or, when the operator typed a free-text choice not in the list, a synthesized
// expand_scope option carrying their words (the "Other" escape hatch).
export function resolveSelectedOption(options = [], selected) {
  const sel = selected == null ? '' : String(selected).trim();
  if (!sel) return null;
  const list = Array.isArray(options) ? options : [];
  const hit = list.find((o) => o.id === sel || o.label === sel);
  if (hit) return hit;
  return { id: 'free', label: sel, kind: 'expand_scope', detail: '', risk: '', injectOnResume: '', recommended: false, authorization: null };
}

// buildResumeContextBlock — the AUTHORITATIVE operator-guidance turn injected AFTER
// the original task when a cycle resumes. Clearly labeled so the model treats it as
// human direction (not part of its own reasoning). Includes, when present: the
// operator's free-text message, the resolution option they chose, and any scoped
// one-time authorizations granted for THIS resume. Returns '' when there's nothing to
// add (a bare resume stays a bare resume).
export function buildResumeContextBlock({ message = '', selectedOption = null, authorizations = [], waivers = [], findings = [], lastCheckpoint = null } = {}) {
  const msg = String(message || '').trim();
  const opt = selectedOption && selectedOption.label ? selectedOption : null;
  const auths = (Array.isArray(authorizations) ? authorizations : []).filter((a) => a && a.scope);
  const waived = (Array.isArray(waivers) ? waivers : []).filter(Boolean);
  const found = (Array.isArray(findings) ? findings : []).map((f) => String(f || '').trim()).filter(Boolean);
  const checkpoint = lastCheckpoint && String(lastCheckpoint.summary || '').trim() ? lastCheckpoint : null;
  if (!msg && !opt && !auths.length && !waived.length && !found.length && !checkpoint) return '';

  const lines = [
    'Operator guidance on resume (AUTHORITATIVE — a human is directing this build after it',
    'paused/blocked. Follow this guidance; it supersedes your earlier assumptions where they',
    'conflict, but never the constitution unless an authorization or approved deviation below',
    'explicitly permits it):',
  ];
  if (checkpoint) {
    // The previous cycle's outcome, up front. Without it a resumed build
    // re-pays 10-30 orientation turns rediscovering what was already done
    // (reads, greps, git log) before it can act on the guidance below. The
    // summary is diff-anchored (checkpointAndRecord embeds the diffstat), so
    // this is evidence-shaped context, not narrative — verify against the
    // tree as usual before relying on any claim in it.
    const seq = checkpoint.seq != null ? ` (change record ${checkpoint.seq})` : '';
    lines.push('', `Last checkpoint before this resume${seq}:`, String(checkpoint.summary).trim().slice(0, 4000));
    // D1.4: a halt summary produced by haltSummaryWithLandedWork names a real
    // gate battery run against the checkpointed tree (the "N/M gates passed"
    // shape) — tell the model that's evidence, not narration, so a resume
    // doesn't re-derive what the halt already confirmed. Gated on the pattern
    // so an older, pre-fix record (a bare label, no verification) never gets
    // a false claim of having been verified.
    if (/gates? passed/.test(checkpoint.summary)) {
      lines.push('This was verified against the tree before the halt — do not re-derive what it already confirms.');
    }
  }
  if (opt) {
    // Name the typed kind (except the neutral expand_scope) so the model knows what
    // KIND of direction this is, then the option's exact injectOnResume text if it
    // provided one — that string is the authoritative "do this" the model proposed.
    const kindTag = opt.kind && opt.kind !== 'expand_scope' ? ` [${opt.kind}]` : '';
    lines.push('', `Chosen resolution${kindTag}: ${opt.label}${opt.detail ? ` — ${opt.detail}` : ''}`);
    if (opt.injectOnResume) lines.push(opt.injectOnResume);
  }
  if (msg) {
    lines.push('', `Operator message: ${msg}`);
  }
  if (waived.length) {
    // A waiver named here is REAL: the orchestrator applies it at the
    // enforcement layer (acceptanceVerdict) for this resumed cycle — it is never
    // merely narrated. Only structured admin-granted waivers reach this list.
    lines.push('', `Enforced waivers for this resumed cycle (applied at the finish gate itself — these are in effect, not just described): ${waived.map((w) => String(w.rule || w)).join(', ')}.`);
  }
  if (found.length) {
    // The EXACT findings the previous run was blocked on. Without this, a
    // resumed build has to rediscover them blind — the real engine of the
    // "resolve → re-halt on the same block" loop: the gate is deterministic,
    // so the resume converges only if it targets these specific items.
    lines.push('', `The previous run was BLOCKED by the integration gate on the following specific findings. First VERIFY each against the current code — the gate re-evaluates fresh at finish, so a finding may already be moot. For each REAL one, fix the named file/function (for behavior an operator explicitly confirmed, like serving cached last-synced data, implement it honestly: surface the transport failure and label cached data as cached; never convert an error into success). For a finding that is NOT real — the code is genuinely local/correct — leave the code alone; do NOT restructure correct code to appease a detector (that is the named anti-pattern), just run the gates and finish:`);
    for (const f of found) lines.push(`- ${f}`);
  }
  if (auths.length) {
    lines.push('', buildAuthorizationBlock(auths));
  }
  // Cycle-94 lesson: operator guidance asserted "the audit is clean" and "the
  // work is substantially done"; both were checkable, one was false, and the
  // build proceeded anyway. Guidance directs WHAT to do — it is not evidence
  // about the current state of the tree.
  lines.push(
    '',
    'VERIFY CHECKABLE CLAIMS: where this guidance asserts a checkable fact about the current',
    'state ("the audit is clean", "X is already implemented", "the dependency was merged"),',
    'verify it against the tree/tooling BEFORE relying on it. If observation CONTRADICTS a',
    'claimed precondition, do not proceed on the claim: halt(reason, options) stating exactly',
    'what was claimed, what you observed, and the viable paths forward. A falsified',
    'precondition is a stopping condition, not a soft note. In particular, "substantially',
    'done" never exempts you from demonstrating acceptance (reproduce-first for bug fixes).',
  );
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
