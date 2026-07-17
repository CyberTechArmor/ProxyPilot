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
    key: 'clean-slate',
    name: 'Clean Slate',
    description: 'Light, neutral SaaS look — indigo primary on white, system type. A safe default for tools and admin apps.',
    tokens: {
      colors: {
        background: '#ffffff', surface: '#f8fafc', text: '#0f172a', muted: '#64748b',
        border: '#e2e8f0', primary: '#4f46e5', primaryText: '#ffffff', accent: '#6366f1',
        danger: '#dc2626', success: '#16a34a',
      },
      typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '16px' },
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
      typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '16px' },
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
      typography: { fontFamily: 'Georgia, Cambria, "Times New Roman", serif', headingFamily: 'Georgia, "Playfair Display", serif', baseSize: '17px' },
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
      typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '16px' },
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
      typography: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', headingFamily: 'system-ui, sans-serif', baseSize: '15px' },
      radius: { sm: '3px', md: '6px', lg: '10px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 2px rgba(0,0,0,0.08)' },
    },
  },
]);

export function getDesignPreset(key) {
  return DESIGN_PRESETS.find((p) => p.key === String(key || '').trim()) || null;
}

// normalizeDesignPresetKey — a stored/user value into a valid preset key or
// the 'ai' sentinel (unknown/empty → 'ai', the old behavior).
export function normalizeDesignPresetKey(key) {
  return getDesignPreset(key) ? String(key).trim() : DESIGN_PRESET_AI;
}

// The public list shape for the picker UI (tokens included — the frontend
// renders swatches from them; they're small and non-secret).
export function publicDesignPresets() {
  return DESIGN_PRESETS.map((p) => ({ key: p.key, name: p.name, description: p.description, tokens: p.tokens }));
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

// applyDesignPreset — bind the Concept prompts to the chosen palette by
// appending a hard section to the locked design system. No preset → the
// design system rides unchanged (the model picks the look, as before).
export function applyDesignPreset(designSystemMd, key) {
  const preset = getDesignPreset(key);
  const base = String(designSystemMd || '');
  if (!preset) return base;
  const t = preset.tokens;
  return `${base}

## Chosen base design preset (binding): ${preset.name}
The Builder chose this preset at project creation — every mockup and screen uses
EXACTLY these tokens. Do not introduce other colors, families, or radii:
- background ${t.colors.background}, surface ${t.colors.surface}, text ${t.colors.text}, muted ${t.colors.muted}, border ${t.colors.border}
- primary ${t.colors.primary} (on-primary text ${t.colors.primaryText}), accent ${t.colors.accent}, danger ${t.colors.danger}, success ${t.colors.success}
- type: body ${t.typography.fontFamily}; headings ${t.typography.headingFamily}; base size ${t.typography.baseSize}
- radii ${t.radius.sm}/${t.radius.md}/${t.radius.lg}; spacing unit ${t.spacing.unit}; card shadow ${t.shadow.card}`;
}
