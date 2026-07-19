// Mock2 design presets — a base look chosen UP FRONT, at project creation,
// instead of whatever the mockup model happens to render. Each preset is a
// complete design-token set (the exact shape parseDesignTokens guarantees), so
// a fresh project's state/design-tokens.json + state/design.css are seeded
// deterministically and the base app is styled before any model turn. The
// Concept mockups are then BOUND to the chosen palette (the addendum below
// rides the locked design system), so the approved design and the built app
// start from the same look. 'ai' keeps the old behavior: no seed, the mockup
// model picks the look and approval extracts it.
//
// PURE (stub-first, risk R9): token literals + prompt text only — no I/O, no
// native modules. Terminology (risk R7): nothing here is named "agent".

import { renderDesignTokensCss } from './concept-logic.js';

// 'ai' — the sentinel for "no preset": the mockup model chooses the look.
export const DESIGN_PRESET_AI = 'ai';

// Every token value below stays within the sanitizers' grammar (safeHex /
// safeSize / safeFont / safeShadow), so a preset can never inject CSS the
// extractor path wouldn't accept.
export const DESIGN_PRESETS = Object.freeze([
  {
    // Derived from the operator's uploaded portal base project (kept: the
    // light blue/teal professional SaaS look — white cards on a cool-gray
    // wash, soft layered shadows, pill badges; dropped: the portal-specific
    // screens). This is the DEFAULT preset for new projects.
    key: 'portal-blue',
    name: 'Portal Blue',
    description: 'Professional blue/teal SaaS — white cards on a cool-gray wash, soft shadows, pill badges. The recommended base look.',
    tokens: {
      colors: {
        background: '#f5f8fc', surface: '#ffffff', text: '#12263f', muted: '#5a6b81',
        border: '#e2e8f1', primary: '#1466b8', primaryText: '#ffffff', accent: '#12a3a3',
        danger: '#d24545', success: '#1f9d57',
      },
      typography: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', headingFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', baseSize: '15px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      radius: { sm: '8px', md: '9px', lg: '12px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 2px rgba(16,42,72,0.06), 0 8px 24px rgba(16,42,72,0.07)' },
    },
  },
  {
    key: 'clean-slate',
    name: 'Clean Slate',
    description: 'Light, neutral SaaS look — indigo primary on white, system type. A safe default for tools and admin apps.',
    tokens: {
      colors: {
        background: '#ffffff', surface: '#f8fafc', text: '#0f172a', muted: '#64748b',
        border: '#e2e8f0', primary: '#4f46e5', primaryText: '#ffffff', accent: '#6366f1',
        danger: '#dc2626', success: '#16a34a',
      },
      typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '16px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      radius: { sm: '6px', md: '10px', lg: '16px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 3px rgba(0,0,0,0.1)' },
    },
  },
  {
    key: 'midnight-ops',
    name: 'Midnight Ops',
    description: 'Dark dashboard — deep navy surfaces, sky-blue primary, high-contrast text. For monitoring, dev tools, and ops consoles.',
    tokens: {
      colors: {
        background: '#0b1220', surface: '#111a2c', text: '#e2e8f0', muted: '#94a3b8',
        border: '#1e293b', primary: '#38bdf8', primaryText: '#082f49', accent: '#818cf8',
        danger: '#f87171', success: '#4ade80',
      },
      typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '16px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      radius: { sm: '4px', md: '8px', lg: '12px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 2px rgba(0,0,0,0.6)' },
    },
  },
  {
    key: 'editorial-warm',
    name: 'Editorial Warm',
    description: 'Warm cream background, serif headings, terracotta accents. For content sites, portfolios, and hospitality.',
    tokens: {
      colors: {
        background: '#f7f4ec', surface: '#fffdf7', text: '#292524', muted: '#78716c',
        border: '#e7e0d3', primary: '#c2571b', primaryText: '#ffffff', accent: '#9a6b3f',
        danger: '#b91c1c', success: '#3f6212',
      },
      typography: { fontFamily: 'Georgia, Cambria, "Times New Roman", serif', headingFamily: 'Georgia, "Playfair Display", serif', baseSize: '17px', monoFamily: '"Courier New", Courier, monospace' },
      radius: { sm: '4px', md: '8px', lg: '14px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 3px rgba(41,37,36,0.12)' },
    },
  },
  {
    key: 'forest-ledger',
    name: 'Forest Ledger',
    description: 'Calm green primary on soft gray-green neutrals. For finance, health, and record-keeping apps that should feel steady.',
    tokens: {
      colors: {
        background: '#fafdf9', surface: '#f1f5f0', text: '#1a2e22', muted: '#5f6f64',
        border: '#dce5dc', primary: '#166534', primaryText: '#ffffff', accent: '#0d9488',
        danger: '#b91c1c', success: '#15803d',
      },
      typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '16px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      radius: { sm: '6px', md: '10px', lg: '16px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 3px rgba(26,46,34,0.10)' },
    },
  },
  {
    key: 'slate-pro',
    name: 'Slate Pro',
    description: 'Understated enterprise gray — slate primary, tight radii, minimal shadow. For internal tools that should stay out of the way.',
    tokens: {
      colors: {
        background: '#ffffff', surface: '#f4f5f7', text: '#111827', muted: '#6b7280',
        border: '#d1d5db', primary: '#334155', primaryText: '#ffffff', accent: '#0f766e',
        danger: '#b91c1c', success: '#15803d',
      },
      typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '15px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      radius: { sm: '3px', md: '6px', lg: '10px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 2px rgba(0,0,0,0.08)' },
    },
  },
  {
    // ProxyPilot's own dashboard look: near-black navy wash, dark slate
    // surfaces, high-contrast text, the signature green primary with blue
    // accents — for apps that should feel like part of the ProxyPilot family.
    key: 'proxypilot',
    name: 'ProxyPilot',
    description: 'The ProxyPilot dashboard look — dark navy surfaces, signature green primary, blue accents, high-contrast text. For consoles and ops tools that should match the platform.',
    tokens: {
      colors: {
        background: '#0b1220', surface: '#101a2e', text: '#e2e8f0', muted: '#94a3b8',
        border: '#1e293b', primary: '#22c55e', primaryText: '#06230f', accent: '#3b82f6',
        danger: '#ef4444', success: '#22c55e',
      },
      typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', baseSize: '15px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      radius: { sm: '6px', md: '8px', lg: '12px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 2px rgba(0,0,0,0.35), 0 8px 24px rgba(0,0,0,0.25)' },
    },
  },
]);

// ---- custom presets (operator-uploaded / AI-adjusted, DB-backed) ----
//
// This module stays PURE: the store (design-presets-store.js) loads the rows
// and injects them here at boot and after every mutation. All existing callers
// (seed files, prompt binding, key normalization) then work for custom presets
// with no changes.
let customPresets = [];
export function setCustomPresets(list = []) {
  customPresets = (Array.isArray(list) ? list : []).filter((p) => p && p.key && p.tokens);
}

function allPresets() {
  return [...DESIGN_PRESETS, ...customPresets];
}

export function getDesignPreset(key) {
  return allPresets().find((p) => p.key === String(key || '').trim()) || null;
}

// normalizeDesignPresetKey — a stored/user value into a valid preset key or
// the 'ai' sentinel (unknown/empty → 'ai', the old behavior).
export function normalizeDesignPresetKey(key) {
  return getDesignPreset(key) ? String(key).trim() : DESIGN_PRESET_AI;
}

// The public list shape for the picker UI (tokens included — the frontend
// renders swatches from them; they're small and non-secret).
export function publicDesignPresets() {
  return [
    ...DESIGN_PRESETS.map((p) => ({ key: p.key, name: p.name, description: p.description, tokens: p.tokens, source: 'builtin' })),
    ...customPresets.map((p) => ({ key: p.key, name: p.name, description: p.description, tokens: p.tokens, source: 'custom' })),
  ];
}

// ---- the portable design document (upload format) ----
//
// A design is uploaded as ONE JSON document:
//   { "format": "proxypilot-design@1", "key": "my-brand", "name": "My Brand",
//     "description": "…", "tokens": { colors, typography, radius, spacing, shadow } }
// key is optional (derived from the name); every token value is validated
// against the same grammar the presets use, so an upload can never inject CSS.
export const DESIGN_DOC_FORMAT = 'proxypilot-design@1';

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SIZE_RE = /^\d{1,3}(?:\.\d{1,2})?(?:px|rem|em)$/;
const FONT_RE = /^[\w\s"',.\-()]{1,200}$/;
const SHADOW_RE = /^[\w\s.,()#%\-]{1,200}$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const COLOR_KEYS = ['background', 'surface', 'text', 'muted', 'border', 'primary', 'primaryText', 'accent', 'danger', 'success'];

// parseDesignDoc(doc) → { ok, data: {key,name,description,tokens} } | { ok:false, error }.
// Missing optional token fields fall back to sane values; colors are REQUIRED.
export function parseDesignDoc(doc) {
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'the design document must be a JSON object' };
  if (doc.format !== DESIGN_DOC_FORMAT) {
    return { ok: false, error: `unsupported format "${String(doc.format || '(none)').slice(0, 60)}" — expected ${DESIGN_DOC_FORMAT}` };
  }
  const name = String(doc.name || '').trim();
  if (!name || name.length > 60) return { ok: false, error: 'name is required (max 60 chars)' };
  const key = String(doc.key || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).trim();
  if (!KEY_RE.test(key)) return { ok: false, error: 'key must be lowercase letters/digits/hyphens (2–41 chars)' };
  const description = String(doc.description || '').trim().slice(0, 300);

  const t = doc.tokens || {};
  const colors = {};
  for (const k of COLOR_KEYS) {
    const v = String(t.colors?.[k] || '').trim();
    if (!HEX_RE.test(v)) return { ok: false, error: `tokens.colors.${k} must be a hex color (#rgb or #rrggbb)` };
    colors[k] = v;
  }
  const str = (v, re, fallback) => {
    const s = String(v || '').trim();
    return s && re.test(s) ? s : fallback;
  };
  const tokens = {
    colors,
    typography: {
      fontFamily: str(t.typography?.fontFamily, FONT_RE, 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'),
      headingFamily: str(t.typography?.headingFamily, FONT_RE, 'system-ui, sans-serif'),
      monoFamily: str(t.typography?.monoFamily, FONT_RE, 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'),
      baseSize: str(t.typography?.baseSize, SIZE_RE, '15px'),
    },
    radius: {
      sm: str(t.radius?.sm, SIZE_RE, '4px'),
      md: str(t.radius?.md, SIZE_RE, '8px'),
      lg: str(t.radius?.lg, SIZE_RE, '12px'),
    },
    spacing: { unit: str(t.spacing?.unit, SIZE_RE, '8px') },
    shadow: { card: str(t.shadow?.card, SHADOW_RE, '0 1px 2px rgba(0,0,0,0.08)') },
  };
  return { ok: true, data: { key, name, description, tokens } };
}

// The document shape, for the upload help and the AI-adjust prompt.
export function designDocTemplate() {
  return {
    format: DESIGN_DOC_FORMAT,
    key: 'my-brand',
    name: 'My Brand',
    description: 'Short human description of the look.',
    tokens: DESIGN_PRESETS[0].tokens,
  };
}

// The seed files a chosen preset contributes to a fresh project: the token doc
// and the rendered stylesheet, exactly what design approval would produce —
// so the base app is styled before any model turn. 'ai'/unknown → [].
export function buildDesignPresetSeedFiles(key) {
  const preset = getDesignPreset(key);
  if (!preset) return [];
  return [
    { path: 'state/design-tokens.json', content: `${JSON.stringify(preset.tokens, null, 2)}\n` },
    { path: 'state/design.css', content: renderDesignTokensCss(preset.tokens) },
  ];
}

// applyDesignPreset — bind the Concept prompts to the chosen theme by
// appending a section to the locked design system. The theme is a BASE the
// model builds on and may extend COMPLEMENTARILY — not a cage: the original
// "EXACTLY these tokens, nothing else" wording measurably flattened mockups
// (the model couldn't reach the modern component/detail language it knows).
// No preset → the design system rides unchanged (the model picks the look).
export function applyDesignPreset(designSystemMd, key) {
  const preset = getDesignPreset(key);
  const base = String(designSystemMd || '');
  if (!preset) return base;
  const t = preset.tokens;
  return `${base}

## Base design theme (binding as a BASE): ${preset.name}
The Builder chose this theme at project creation. Treat it as the FOUNDATION,
and design UP from it to the level of today's best product UIs:
- The core stays recognizable on every screen: these background/surface/text
  colors, this primary and accent, and these font families anchor the chrome,
  nav, buttons, and body text.
- You SHOULD extend it complementarily where it improves the design: tints,
  shades, and translucent variants of the base colors; at most one or two
  additional accents that harmonize with the palette; gradients and elevated
  surfaces derived from it; refined component detail (hover/focus states,
  subtle shadows and transitions, empty states, iconography). Additions must
  read as the SAME family — never a different theme.
- Never replace the core palette or the font families with unrelated ones, and
  never leave the design flat when a complementary touch would lift it.
Base tokens:
- background ${t.colors.background}, surface ${t.colors.surface}, text ${t.colors.text}, muted ${t.colors.muted}, border ${t.colors.border}
- primary ${t.colors.primary} (on-primary text ${t.colors.primaryText}), accent ${t.colors.accent}, danger ${t.colors.danger}, success ${t.colors.success}
- type: body ${t.typography.fontFamily}; headings ${t.typography.headingFamily}; base size ${t.typography.baseSize}${t.typography.monoFamily ? `; code ${t.typography.monoFamily}` : ''}
- radii ${t.radius.sm}/${t.radius.md}/${t.radius.lg}; spacing unit ${t.spacing.unit}; card shadow ${t.shadow.card}`;
}

// applyExploreDesign — the Builder chose "new look" for THIS turn: the base
// theme is set aside and the model designs freely at reference quality. If the
// mockup is approved, the extractor adopts its look as the project's design
// system — exploration is a proposal until approval, never a silent fork.
export function applyExploreDesign(designSystemMd) {
  const base = String(designSystemMd || '');
  return `${base}

## Design direction for THIS turn: EXPLORE a new look (Builder's choice)
Set aside any base theme above for this mockup. Design at the level of the
best modern product UIs (shadcn/Radix-inspired component language,
Linear/Stripe-class polish):
1. First think about what THIS application's domain needs — its core objects,
   states, and tasks — and the display patterns the best products use for them.
2. Then choose a palette, typography, and component language that FIT that
   domain (not a generic default), and apply them consistently.
Everything must remain fully self-contained HTML/CSS (no CDNs, no external
fonts — pick from families commonly installed). If the Builder approves this
mockup, its look becomes the project's design system going forward.`;
}
