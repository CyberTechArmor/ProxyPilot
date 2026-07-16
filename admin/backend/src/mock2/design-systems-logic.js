// Mock2 design-system CATALOG — pure decision layer. Native-free, unit-tested
// stub-first (risk R9): imports nothing that opens a DB, hits the network, or
// reads a file. The seed-body reader lives in the thin half (design-systems.js).
//
// Stage 1 (Concept) renders a mockup against a LOCKED design system so every
// project's design starts from the same tokens/rules (constitution §6.1;
// ADR-003). Originally there was exactly one — the framework's design_system_md.
// This catalog lets a project CHOOSE its design language UP FRONT (before the
// design is approved), keeping a project on one coherent look across every
// concept turn and mockup render:
//
//   * `default` — "Studio Dark": the framework's own design_system_md. Resolves
//     to whatever the pinned framework version carries, so it stays in lockstep
//     with framework versioning (append-only, never edited). A dark surface.
//   * `clarity-clinical` — "Clarity Clinical": a light, blue/teal clinical
//     theme vendored as a seed file (framework-seed/design-systems/), for
//     healthcare / compliance / records-heavy apps. Its body is a constant
//     across framework versions (the seed IS its source of truth).
//
// The chosen key is stored per project (mock2_projects.design_system_key, null =
// 'default') and is editable ONLY until the design is approved — after approval
// the look is locked with the inventory (changing it would desync the approved
// mockup from the tokens the build reproduces).
//
// Terminology (risk R7): nothing here is named "agent".

// ---- the catalog (metadata only; bodies resolve in the thin half) ----

// Each entry: key (stored value), label (UI title), summary (one line), theme
// ('dark'|'light', for the selector swatch), and `source`:
//   'framework' — body IS the pinned framework's design_system_md (default).
//   'seed:<file>' — body is read from framework-seed/design-systems/<file>.
export const BUILTIN_DESIGN_SYSTEMS = Object.freeze([
  Object.freeze({
    key: 'default',
    label: 'Studio Dark',
    summary: 'The default dark studio look — deep near-black surfaces, a single green accent, Manrope. Best for internal tools and dashboards.',
    theme: 'dark',
    source: 'framework',
  }),
  Object.freeze({
    key: 'clarity-clinical',
    label: 'Clarity Clinical',
    summary: 'A calm, light clinical theme — deep blues with a teal accent, high-contrast records and forms. Best for healthcare, compliance and credentialing apps.',
    theme: 'light',
    source: 'seed:clarity-clinical.md',
  }),
]);

export const DEFAULT_DESIGN_SYSTEM_KEY = 'default';

const KEY_SET = new Set(BUILTIN_DESIGN_SYSTEMS.map((d) => d.key));

// normalizeDesignSystemKey — coerce any stored/user value to a real catalog key.
// null / '' / unknown all fall back to the default, so a fresh project (column
// NULL) and a stale value both behave as "the framework's own design system".
export function normalizeDesignSystemKey(value) {
  const k = String(value ?? '').trim().toLowerCase();
  return KEY_SET.has(k) ? k : DEFAULT_DESIGN_SYSTEM_KEY;
}

// isDesignSystemKey — is this a real catalog key (before normalization)? Used by
// the route to reject an unknown key with a 400 rather than silently defaulting.
export function isDesignSystemKey(value) {
  return KEY_SET.has(String(value ?? '').trim().toLowerCase());
}

// catalogEntry — the metadata row for a key (normalized), never null.
export function catalogEntry(key) {
  const k = normalizeDesignSystemKey(key);
  return BUILTIN_DESIGN_SYSTEMS.find((d) => d.key === k) || BUILTIN_DESIGN_SYSTEMS[0];
}

// resolveDesignSystemBody — the actual design-system markdown a project's chosen
// key maps to, ready to inject into the concept/mockup system prompts. Pure: the
// two possible bodies are passed in (the framework's design_system_md, and the
// vendored seed bodies keyed by file), so this stays DB/FS-free and testable.
//
//   { key, frameworkDesignSystem, seedBodies }
//     frameworkDesignSystem — the pinned framework version's design_system_md.
//     seedBodies — { '<file>': '<markdown>' } for the seed-backed entries.
//
// Falls back to the framework body when a seed body is missing (a seed file that
// couldn't be read must never blank out the design rules — better the default
// look than none), so the render always has a binding design system.
export function resolveDesignSystemBody({ key, frameworkDesignSystem = '', seedBodies = {} } = {}) {
  const entry = catalogEntry(key);
  if (entry.source === 'framework') return String(frameworkDesignSystem || '');
  if (entry.source.startsWith('seed:')) {
    const file = entry.source.slice('seed:'.length);
    const body = seedBodies?.[file];
    if (body && String(body).trim()) return String(body);
  }
  // Unknown source or unreadable seed — never blank; fall back to the framework's.
  return String(frameworkDesignSystem || '');
}

// ---- API response shape ----

// publicDesignSystemShape — one catalog entry decorated with whether it is the
// project's current selection. `selectedKey` is the project's normalized key.
export function publicDesignSystemShape(entry, selectedKey) {
  if (!entry) return null;
  return {
    key: entry.key,
    label: entry.label,
    summary: entry.summary,
    theme: entry.theme,
    selected: entry.key === normalizeDesignSystemKey(selectedKey),
  };
}

// designSystemCatalog — the whole catalog shaped for the API, current selection
// flagged. `selectedKey` comes from the project row (NULL → default).
export function designSystemCatalog(selectedKey) {
  const sel = normalizeDesignSystemKey(selectedKey);
  return {
    selected_key: sel,
    // Editability is a route/project concern (locked after approval); the shape
    // only reports the options + which is chosen.
    options: BUILTIN_DESIGN_SYSTEMS.map((e) => publicDesignSystemShape(e, sel)),
  };
}
