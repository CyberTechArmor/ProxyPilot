// Mock2 screen plan — the PURE decision layer for per-screen apply. Design
// approval extracts an inventory whose screens[] enumerate the app's pages;
// this module turns that list into a reviewable plan (approve/defer per
// screen) and scopes each apply to ONE screen so the background builds stay
// small, reviewable, and cheap — instead of one monolithic "build everything"
// pass a low-effort model can fumble.
//
// PURE (stub-first, risk R9): no DB, no container, no model calls.
// Terminology (risk R7): nothing here is named "agent".

export const SCREEN_STATUSES = Object.freeze(['planned', 'deferred', 'queued', 'building', 'built', 'failed']);

// The Builder-settable statuses (everything else is machine-driven).
export const SCREEN_DECISIONS = Object.freeze(['planned', 'deferred']);

// screenPlanFromInventory — inventory.screens[] → plan rows [{name, purpose,
// sort}]. Tolerant of partial inventories; names are deduped (the UNIQUE
// (project_id, name) index backs this) and clamped to sane lengths.
// The initial "everything at once" build's instruction prefix (concept.js
// composes INITIAL_BUILD_INSTRUCTION from this). When THAT request succeeds,
// the whole approved inventory was implemented in one pass — every still-open
// screen row is settled as built so the Screens panel reflects reality
// instead of showing "0/N built" over a fully working app.
export const INITIAL_BUILD_INSTRUCTION_PREFIX = 'Build the working application from the approved design inventory';

export function screenPlanFromInventory(inventory) {
  const screens = Array.isArray(inventory?.screens) ? inventory.screens : [];
  const seen = new Set();
  const rows = [];
  for (const s of screens) {
    const name = String(s?.name || '').trim().slice(0, 120);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    rows.push({
      name,
      purpose: String(s?.purpose || '').trim().slice(0, 500) || null,
      sort: rows.length,
    });
  }
  return rows;
}

// buildScreenBuildInstruction — the scoped MVP-build instruction for ONE
// screen. Binding constraints: only this screen, behind the existing auth,
// styled by the approved tokens, everything else untouched.
export function buildScreenBuildInstruction({ name, purpose = null } = {}) {
  const target = String(name || '').trim() || 'the screen';
  const why = purpose ? ` Its purpose: ${purpose}.` : '';
  return `Implement ONLY the screen "${target}" from state/inventory.json — its fields, actions, and states.${why} ` +
    'Scope is BINDING: do not build, restyle, or refactor any other screen, and do not touch the auth wiring ' +
    '(src/auth/*, the login/bootstrap flow, or the withAuth/bootstrapGate mounts in src/app.ts). ' +
    'Serve the screen behind the existing sign-in (guard its routes with requireAuth/requireRole from ./auth/index.js) ' +
    'and link it from the app shell at /. FIRST read the approved mockup at state/mockups/current.html and reproduce ' +
    'its layout, navigation structure (e.g. a mobile bottom tab bar), and component patterns for this screen — the ' +
    'mockup is the visual contract, not just its colors. Load /design.css and match state/design-tokens.json; never ' +
    'restyle from generic defaults. Any inventory feature of this screen you cannot finish must be visibly marked ' +
    '"Not built yet" in the UI (disabled control + badge), never a dead element. Keep the diff small: one screen, not the app.';
}

// nextQueuedScreen — the row the drainer should start next: queued rows in
// sort order. Nothing is startable while a screen is building (one writer).
export function nextQueuedScreen(rows = []) {
  if (rows.some((r) => r?.status === 'building')) return null;
  return [...rows]
    .filter((r) => r?.status === 'queued')
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || (a.id ?? 0) - (b.id ?? 0))[0] || null;
}

// A transient start refusal (lock/audit contention) → stay queued and retry on
// the next drain; anything else is a real failure for that screen.
export function isTransientStartError(error) {
  return /checked out|already running|must be online/i.test(String(error || ''));
}

export function screenPlanCounts(rows = []) {
  const by = {};
  for (const s of SCREEN_STATUSES) by[s] = 0;
  for (const r of rows) if (r && by[r.status] != null) by[r.status] += 1;
  return { total: rows.length, ...by };
}

// The production-check instruction — a FULL build pass whose only deliverable
// is readiness: no new features, just the audit interview, per-rule tests,
// acceptance checks, and the complete gate battery run to green.
export const PRODUCTION_CHECK_INSTRUCTION =
  'Production check — add NO new features. Verify the application as built: run the complete gate battery ' +
  '(typecheck, constitution lint, security scan, tests, component reuse, rule coverage, UI interaction, acceptance) ' +
  'and fix only what a gate flags. Confirm every inventory screen works end-to-end behind the wired sign-in, that ' +
  'the first-admin bootstrap flow still works from a fresh database, that state/design.css styling applies on every ' +
  'screen, and that no secrets are hardcoded. The deliverable is a clean, fully gated build of the app exactly as designed.';

export function publicScreenShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose || null,
    sort: row.sort ?? 0,
    status: row.status,
    request_id: row.request_id ?? null,
    error: row.error || null,
    updated_at: row.updated_at || null,
  };
}

// ---- feature checklist (per-screen functionality tracking) ----

// screenItemsFromInventory — inventory.screens[] → checklist items: one row
// per ACTION (the functionality) and one per STATE worth handling. These are
// the "is/isn't done yet" units the Screens panel tracks — screens can be
// BUILT while several of their items are still pending, and that gap is
// exactly what the checklist makes visible.
export function screenItemsFromInventory(inventory) {
  const screens = Array.isArray(inventory?.screens) ? inventory.screens : [];
  const out = [];
  for (const s of screens) {
    const screenName = String(s?.name || '').trim().slice(0, 120);
    if (!screenName) continue;
    const push = (list, kind) => {
      for (const raw of Array.isArray(list) ? list : []) {
        const name = String(typeof raw === 'string' ? raw : raw?.name || raw?.label || '').trim().slice(0, 200);
        if (name) out.push({ screen_name: screenName, name, kind });
      }
    };
    push(s.actions, 'action');
    push(s.states, 'state');
  }
  return out;
}

// buildItemsBuildInstruction — the scoped instruction for "finish THESE
// checklist items next": grouped by screen, binding scope, mockup-faithful.
export function buildItemsBuildInstruction(groups = []) {
  const parts = [];
  for (const g of groups) {
    if (!g?.screen || !Array.isArray(g.items) || !g.items.length) continue;
    parts.push(`${g.screen}: ${g.items.map((i) => String(i).trim()).filter(Boolean).join('; ')}`);
  }
  return 'Finish these specific features from the approved design inventory (state/inventory.json) — ' +
    `${parts.join(' · ')}. ` +
    'Scope is BINDING: implement ONLY the listed features, on their listed screens; do not build, restyle, or ' +
    'refactor anything else, and do not touch the auth wiring. Match the approved mockup faithfully — read ' +
    'state/mockups/current.html for the exact layout, navigation, and component patterns — and load /design.css. ' +
    'Any listed feature you cannot finish this cycle must be visibly marked "Not built yet" in the UI (disabled ' +
    'control + badge), never a dead or silently missing element.';
}
