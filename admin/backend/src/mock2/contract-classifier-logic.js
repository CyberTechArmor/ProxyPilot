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
  "complexity": "mechanical" | "complex",
  "touches": ["auth" | "rbac" | "crypto" | "migration" | "external-integration" | "money"] | [],
  "additions": {
    "screens": [{ "name": "...", "purpose": "...",
                  "actions": [{ "label": "..." }],
                  "fields": [{ "name": "..." }] }],
    "actions": [{ "screen": "<existing screen name>", "label": "..." }],
    "fields":  [{ "screen": "<existing screen name>", "name": "..." }]
  }
}

complexity: "mechanical" ONLY for small, well-specified changes with no
cross-file invariants — copy, styling, a straightforward field or list on an
existing pattern. Anything with schema changes, new subsystems, tricky state,
or ambiguity is "complex". touches: every sensitive surface the request
brushes — authentication/session, roles/permissions, crypto/secrets, data
migration/deletion, external integrations, money/billing. Empty when none.

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
  // The 3a/3b routing signals ride the same call (zero extra model spend):
  // complexity + touches feed implementLaneForTask, whose hard carve-out
  // (touches non-empty → never the cheap tier) is enforced downstream.
  const complexity = String(doc.complexity || '').trim().toLowerCase() === 'mechanical' ? 'mechanical' : 'complex';
  const touches = (Array.isArray(doc.touches) ? doc.touches : [])
    .map((t) => String(t || '').trim().toLowerCase()).filter(Boolean).slice(0, 8);
  return { covered: doc.covered || empty, reason: str(doc.reason, 300), complexity, touches, additions };
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

// ---- the build plan step (phase 2 made real: top model thinks, cheap builds) ----

// When the lane ladder sends a build to the CHEAP tier, the phase map's PLAN
// model first writes a tight implementation plan that rides the task turn —
// the five-phase pipeline's "plan" phase as an actual top-tier call, not just
// a map entry. Cheap execution without top-tier thinking is how mechanical
// changes miss cross-file invariants; the plan is what makes Luna-first safe
// beyond the gates.
export const BUILD_PLAN_SYSTEM_PROMPT = `You are the PLAN phase of a five-phase build pipeline. A cheaper model will
implement this request in an existing TypeScript/Express/Drizzle codebase —
YOU write the plan it follows. Be concrete enough that faithful execution is
enough; flag anything the executor must not touch.

Write, as tight numbered markdown (no code, no preamble):
1. Files to read first, and what to look for in each.
2. The changes, in order: file → what changes → why.
3. Cross-file invariants and shared constants that must stay consistent
   (role enums, shared modules, tests that assert cross-file equality).
4. What must NOT change.
5. The tests/gates this change must satisfy, incl. ui-checks for touched
   screens.`;

export function buildPlanTask({ instruction = '', inventoryJson = '', requirementsDoc = '' } = {}) {
  return [
    `Build request:\n${String(instruction).slice(0, 4000)}`,
    requirementsDoc ? `Design & functional requirements on record:\n${String(requirementsDoc).slice(0, 12000)}` : null,
    inventoryJson ? `Approved inventory:\n${String(inventoryJson).slice(0, 20000)}` : null,
  ].filter(Boolean).join('\n\n');
}

export function formatPlanForTask(planText, plannerModel = '') {
  const t = String(planText || '').trim();
  if (!t) return '';
  return `\n\n---\nIMPLEMENTATION PLAN from the plan phase${plannerModel ? ` (${plannerModel})` : ''} — follow it; where it names an invariant or a do-not-touch, that is binding:\n${t.slice(0, 8000)}`;
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
