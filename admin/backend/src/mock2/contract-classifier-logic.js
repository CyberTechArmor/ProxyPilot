// Contract classifier PURE decision layer — closes the "unapproved feature"
// dead-end at build time.
//
// The project-53 folders saga: a build request asked for a capability the
// approved inventory didn't carry. The builder — correctly forbidden from
// inventing unapproved behavior — halted three times and finally shipped a
// placeholder card labeled "Not built yet"; three follow-up quick parts then
// decorated the hole (a folder column with no folder schema). The operator's
// only recourse was the design chat, which is not reachable from the build
// chat.
//
// The fix is a CLASSIFIER, not a detour: before a build runs, a cheap model
// compares the request against the inventory. Capabilities the request needs
// that the contract lacks are appended to state/inventory.json as a RECORDED
// AMENDMENT (append-only, origin-stamped, announced in the chat, riding the
// cycle's checkpoint diff) — and the build proceeds authorized, with the new
// actions immediately covered by the action-parity gate. Silence is the enemy
// here, not the amendment: sign-off #2 approved a design, and this keeps every
// extension of it loud and auditable instead of impossible.
//
// PURE (stub-first, risk R9): prompt text + JSON parsing + inventory math.
// Terminology (risk R7): nothing here is named "agent".

// ---- toggle (default on; 'off' restores the halt-first behavior) ----

export const CONTRACT_CLASSIFIER_FLAG = 'MOCK2_CONTRACT_CLASSIFIER';

export function contractClassifierMode(env = {}) {
  const v = String(env?.[CONTRACT_CLASSIFIER_FLAG] ?? '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' ? 'off' : 'on';
}

// ---- the classifier call (cheap tier, strict JSON) ----

export const CONTRACT_CLASSIFIER_PROMPT = `You compare ONE build request against an app's approved design inventory
(the contract of screens, fields, and actions) and decide whether the
request needs capabilities the contract does not carry.

Reply with STRICT JSON only, no prose:
{
  "covered": true | false,
  "reason": "<one sentence>",
  "additions": {
    "screens": [{ "name": "...", "purpose": "...",
                  "actions": [{ "label": "..." }],
                  "fields": [{ "name": "..." }] }],
    "actions": [{ "screen": "<existing screen name>", "label": "..." }],
    "fields":  [{ "screen": "<existing screen name>", "name": "..." }]
  }
}

Rules:
- covered:true (empty additions) when the contract already authorizes
  everything the request needs — styling, copy, layout, bug fixes, and
  rework of EXISTING capabilities are always covered.
- Additions are the MINIMUM the request genuinely requires: real
  user-facing capabilities only, named as short user-facing labels
  ("Create folder", not "POST /api/folders"). Mutations the user will
  perform MUST each be their own action.
- Prefer adding actions/fields to an existing screen over inventing a new
  screen; a new screen only when the request clearly describes one.
- Never rename, remove, or restate anything already in the inventory.`;

export function buildContractClassifierTask({ instruction = '', inventoryJson = '' } = {}) {
  return `Build request:\n${String(instruction).slice(0, 4000)}\n\nApproved inventory:\n${String(inventoryJson).slice(0, 40000)}`;
}

export function parseContractClassifierReply(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let doc;
  try { doc = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!doc || typeof doc !== 'object' || typeof doc.covered !== 'boolean') return null;
  const a = doc.additions || {};
  const str = (v, cap = 200) => String(v || '').trim().slice(0, cap);
  const additions = {
    screens: (Array.isArray(a.screens) ? a.screens : []).map((s) => ({
      name: str(s?.name, 120), purpose: str(s?.purpose, 500),
      actions: (Array.isArray(s?.actions) ? s.actions : []).map((x) => ({ label: str(x?.label) })).filter((x) => x.label),
      fields: (Array.isArray(s?.fields) ? s.fields : []).map((x) => ({ name: str(x?.name) })).filter((x) => x.name),
    })).filter((s) => s.name),
    actions: (Array.isArray(a.actions) ? a.actions : []).map((x) => ({ screen: str(x?.screen, 120), label: str(x?.label) })).filter((x) => x.label),
    fields: (Array.isArray(a.fields) ? a.fields : []).map((x) => ({ screen: str(x?.screen, 120), name: str(x?.name) })).filter((x) => x.name),
  };
  const empty = !additions.screens.length && !additions.actions.length && !additions.fields.length;
  return { covered: doc.covered || empty, reason: str(doc.reason, 300), additions };
}

// ---- applying additions (append-only, origin-stamped, deduped) ----

export const AMENDMENT_ORIGIN = 'request_amendment';

// applyInventoryAdditions — a NEW inventory object with the additions
// appended. Append-only by construction: existing screens/actions/fields are
// never edited or removed; duplicates (case-insensitive name/label match)
// are dropped. Every appended entry carries origin + amended_at so the
// contract's history stays readable. Returns { inventory, added, summary };
// added.total === 0 means nothing changed (caller skips the write).
export function applyInventoryAdditions(inventory, additions = {}, { at = null } = {}) {
  const inv = JSON.parse(JSON.stringify(inventory || {}));
  if (!Array.isArray(inv.screens)) inv.screens = [];
  const stamp = { origin: AMENDMENT_ORIGIN, ...(at ? { amended_at: at } : {}) };
  const added = { screens: 0, actions: 0, fields: 0 };
  const parts = [];

  const screenByName = (name) => inv.screens.find(
    (s) => String(s?.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase(),
  );
  const hasAction = (sc, label) => (sc.actions || []).some(
    (x) => String(x?.label || '').trim().toLowerCase() === String(label || '').trim().toLowerCase(),
  );
  const hasField = (sc, name) => (sc.fields || []).some(
    (x) => String(x?.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase(),
  );

  for (const s of additions.screens || []) {
    if (!s?.name || screenByName(s.name)) continue;
    inv.screens.push({
      name: s.name, purpose: s.purpose || '',
      actions: (s.actions || []).map((x) => ({ label: x.label, ...stamp })),
      fields: (s.fields || []).map((x) => ({ name: x.name, ...stamp })),
      states: [], ...stamp,
    });
    added.screens += 1;
    added.actions += (s.actions || []).length;
    added.fields += (s.fields || []).length;
    parts.push(`screen "${s.name}" (${(s.actions || []).length} action${(s.actions || []).length === 1 ? '' : 's'})`);
  }
  for (const a of additions.actions || []) {
    const sc = screenByName(a.screen) || inv.screens[0];
    if (!sc || hasAction(sc, a.label)) continue;
    if (!Array.isArray(sc.actions)) sc.actions = [];
    sc.actions.push({ label: a.label, ...stamp });
    added.actions += 1;
    parts.push(`action "${a.label}" (${sc.name})`);
  }
  for (const f of additions.fields || []) {
    const sc = screenByName(f.screen) || inv.screens[0];
    if (!sc || hasField(sc, f.name)) continue;
    if (!Array.isArray(sc.fields)) sc.fields = [];
    sc.fields.push({ name: f.name, ...stamp });
    added.fields += 1;
  }
  const total = added.screens + added.actions + added.fields;
  return { inventory: inv, added: { ...added, total }, summary: parts.slice(0, 8).join(', ') };
}

// The loud part: the chat message announcing the amendment. Never silent —
// the human approved a design, so every automatic extension of it must be
// visible and reversible.
export function contractAmendmentMessage(added, summary, reason = '') {
  return `This request needs capabilities the approved design didn't include, so the contract was extended before building: ${summary || `${added.total} addition(s)`}. `
    + `${reason ? `(${reason}) ` : ''}`
    + 'The additions are appended to state/inventory.json (origin: request_amendment), ride this cycle\'s checkpoint, and are enforced by the action-parity gate like any approved action. '
    + 'If this is not what you wanted, say so — a build can remove them.';
}

// ---- split fidelity (the folders→fonts corruption) ----

const FIDELITY_STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'into', 'onto', 'when', 'then',
  'each', 'every', 'exactly', 'deliver', 'part', 'split', 'request', 'ensure',
  'build', 'make', 'update', 'implement', 'wired', 'component', 'state',
  'main', 'list', 'view', 'screen', 'layout', 'left', 'right', 'fixed',
  'selected', 'selection', 'click', 'clickable', 'handler', 'render',
]);

export function significantWords(text) {
  return new Set(
    String(text || '').toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !FIDELITY_STOPWORDS.has(w)),
  );
}

// splitPartsFidelity — detect a DOMAIN SUBSTITUTION in a split proposal: a
// significant word absent from the original request (singular/plural
// tolerant) that shows up in TWO OR MORE parts is a hallucinated domain
// ("fonts" across parts 1 and 3 of a folders request), not the splitter's
// legitimate implementation vocabulary (a "breadcrumb" or "240px" confined
// to one part never trips this). Flagged ≠ discarded — the caller keeps the
// split but the part instructions carry the original as ground truth.
export function splitPartsFidelity(originalText, parts = []) {
  const original = significantWords(originalText);
  const matchesOriginal = (w) => original.has(w)
    || original.has(`${w}s`) || (w.endsWith('s') && original.has(w.slice(0, -1)));
  const counts = new Map(); // foreign word → Set(part index)
  parts.forEach((p, i) => {
    const text = `${p?.title || ''} ${(p?.items || []).join(' ')}`;
    for (const w of significantWords(text)) {
      if (matchesOriginal(w)) continue;
      if (!counts.has(w)) counts.set(w, new Set());
      counts.get(w).add(i);
    }
  });
  const foreign = [...counts.entries()].filter(([, set]) => set.size >= 2).map(([w]) => w);
  return { ok: foreign.length === 0, foreign };
}
