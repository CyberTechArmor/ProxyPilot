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

// The base look every new project starts on. Project creation no longer asks —
// the choice moved into the design chat, where the "On theme / New look" toggle
// decides per turn whether the AI stays on this built-in base or explores a
// fresh look. A caller can still pin a preset (or 'ai') explicitly on create.
export const DEFAULT_DESIGN_PRESET = 'portal-blue';

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
    // One of the four FLAGSHIP themes (with the three Folio registers below):
    // each carries a full art-direction contract, not just tokens.
    artDirection: {
      register: 'SaaS portal — dense, legible, working software',
      namedPalette: [
        { name: 'portal-blue', hex: '#1466b8', role: 'the one interactive accent: primary buttons, links, active nav' },
        { name: 'teal', hex: '#12a3a3', role: 'secondary accent for data highlights only — never on controls' },
        { name: 'cool-wash', hex: '#f5f8fc', role: 'the page behind everything' },
        { name: 'card-white', hex: '#ffffff', role: 'every working surface' },
        { name: 'slate-ink', hex: '#12263f', role: 'all text — one ink, weight carries hierarchy' },
        { name: 'hairline', hex: '#e2e8f1', role: 'borders and dividers' },
      ],
      fontPairing: {
        display: 'the same sans, heavier', ui: '-apple-system/Segoe UI/Roboto sans',
        rules: 'A deliberately SINGLE-FACE register: hierarchy comes from weight (800 brand, 700 headings, 600 labels) and size steps, never from a second family.',
      },
      signature: [
        'pill status badges with a leading colored dot',
        'numbered section cards with slim progress meters in the header',
        'primary buttons carry a small leading icon',
      ],
    },
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
      motion: {
        durationFast: '120ms', durationBase: '200ms', durationSlow: '320ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
    },
  },
  {
    // FLAGSHIP 2/4 — distilled from the operator's warm FOLIO reference (the
    // paper-and-rust editorial studio): the work sits on a lighter sheet above
    // a darker desk, Georgia display over Inter UI, one rust accent doing all
    // interactive emphasis.
    key: 'folio-warm',
    name: 'Folio Warm',
    description: 'Warm editorial studio — paper surfaces on a linen desk, Georgia display over sans UI, a single rust accent. For editorial, publishing, and studio tools.',
    artDirection: {
      register: 'editorial studio — calm, tactile, gallery-quiet',
      namedPalette: [
        { name: 'ink', hex: '#1d1b18', role: 'all text — near-black warm ink' },
        { name: 'ink-soft', hex: '#6e675f', role: 'secondary text and captions' },
        { name: 'rust', hex: '#a74f36', role: 'THE accent: selection, primary actions, live indicators — nothing else gets a hue' },
        { name: 'rust-pale', hex: '#ead3ca', role: 'rust tint for chips and soft fills' },
        { name: 'paper', hex: '#fbf6ea', role: 'the working sheet (cards, canvases, panels)' },
        { name: 'shell', hex: '#d8d2c8', role: 'the desk behind the sheet (app frame)' },
        { name: 'rail', hex: '#eee8de', role: 'side rails and secondary panels' },
        { name: 'line', hex: '#c9c0b4', role: 'hairlines and borders' },
      ],
      fontPairing: {
        display: 'Georgia serif', ui: 'Inter/system sans',
        rules: 'Georgia ONLY for display moments — page titles, pull quotes, page-number furniture, big numerals. Every control, label, and body-UI string is the sans. The serif/sans rhythm IS the register.',
      },
      signature: [
        'paper-on-desk layering: the work floats as a lighter sheet above a darker surround',
        'dashed selection frames with small square corner handles',
        'one rust accent; everything else earns attention through type and spacing',
      ],
    },
    tokens: {
      colors: {
        background: '#eee8de', surface: '#fbf6ea', text: '#1d1b18', muted: '#6e675f',
        border: '#c9c0b4', primary: '#a74f36', primaryText: '#ffffff', accent: '#8f402b',
        danger: '#9c2f1f', success: '#5f7040',
      },
      typography: { fontFamily: 'Inter, -apple-system, "Segoe UI", Roboto, sans-serif', headingFamily: 'Georgia, "Times New Roman", serif', baseSize: '15px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      radius: { sm: '6px', md: '10px', lg: '14px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 2px rgba(29,27,24,0.08), 0 12px 32px rgba(29,27,24,0.08)' },
      motion: {
        durationFast: '140ms', durationBase: '260ms', durationSlow: '400ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
    },
  },
  {
    // FLAGSHIP 3/4 — the light FOLIO register: white chrome on a cool gallery
    // wash, hairlines instead of boxes, one cobalt accent, serif display.
    key: 'folio-light',
    name: 'Folio Light',
    description: 'Light gallery — white chrome on a cool wash, hairline structure, one cobalt accent, serif display over sans UI. For collaboration and review tools.',
    artDirection: {
      register: 'light gallery — airy, precise, professional',
      namedPalette: [
        { name: 'gallery-wash', hex: '#f6f7f9', role: 'the page behind everything' },
        { name: 'paper-white', hex: '#ffffff', role: 'every working surface' },
        { name: 'ink', hex: '#17181c', role: 'all text — cool near-black' },
        { name: 'quiet', hex: '#697077', role: 'secondary text' },
        { name: 'cobalt', hex: '#2563eb', role: 'THE accent: primary actions, selection, active states' },
        { name: 'leaf', hex: '#16a34a', role: 'positive status chips only' },
        { name: 'hairline', hex: '#e4e7eb', role: 'dividers carry the structure — not boxes' },
      ],
      fontPairing: {
        display: 'Georgia serif', ui: 'Inter/system sans',
        rules: 'Georgia for document titles and content display; sans for all chrome. Content reads like print, chrome reads like software.',
      },
      signature: [
        'structure from hairline dividers and generous margins, not filled boxes',
        'status lives in soft pill chips (tinted background, darker text)',
        'floating micro-toolbars appear on selection, close to the work',
      ],
    },
    tokens: {
      colors: {
        background: '#f6f7f9', surface: '#ffffff', text: '#17181c', muted: '#697077',
        border: '#e4e7eb', primary: '#2563eb', primaryText: '#ffffff', accent: '#1d4ed8',
        danger: '#dc2626', success: '#16a34a',
      },
      typography: { fontFamily: 'Inter, -apple-system, "Segoe UI", Roboto, sans-serif', headingFamily: 'Georgia, "Times New Roman", serif', baseSize: '15px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      radius: { sm: '8px', md: '10px', lg: '14px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 2px rgba(23,24,28,0.05), 0 8px 24px rgba(23,24,28,0.06)' },
      motion: {
        durationFast: '120ms', durationBase: '200ms', durationSlow: '320ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
    },
  },
  {
    // FLAGSHIP 4/4 — the dark FOLIO register: a near-black studio where the
    // work canvas floats as warm parchment, with one moss/olive accent.
    key: 'folio-dark',
    name: 'Folio Dark',
    description: 'Dark studio — near-black chrome, the work floats as warm parchment, one moss accent, serif display. For focused creative and review tools.',
    artDirection: {
      register: 'dark studio — focused, warm-on-dark, theatrical about the work',
      namedPalette: [
        { name: 'char', hex: '#141511', role: 'the studio (page background)' },
        { name: 'panel', hex: '#1b1d17', role: 'chrome surfaces (rails, bars, cards)' },
        { name: 'parchment', hex: '#f3ecd9', role: 'the WORK canvas only — the one bright thing on screen' },
        { name: 'bone', hex: '#e8e4d8', role: 'all text on the dark chrome' },
        { name: 'ash', hex: '#98988a', role: 'secondary text' },
        { name: 'moss', hex: '#a3b53c', role: 'THE accent: selection, confirmation ticks, leader lines' },
        { name: 'seam', hex: '#2a2c24', role: 'borders' },
      ],
      fontPairing: {
        display: 'Georgia serif', ui: 'Inter/system sans',
        rules: 'Georgia lives on the parchment (content display); the dark chrome is all sans. The two worlds — warm work, dark studio — never swap type.',
      },
      signature: [
        'the work canvas is warm parchment floating on the near-black studio — maximum contrast reserved for the work itself',
        'dashed leader lines connect comments/annotations to their target',
        'moss is the only accent; selected items get a thin moss frame with square handles',
      ],
    },
    tokens: {
      colors: {
        background: '#141511', surface: '#1b1d17', text: '#e8e4d8', muted: '#98988a',
        border: '#2a2c24', primary: '#a3b53c', primaryText: '#15170a', accent: '#c6d16a',
        danger: '#e06c4f', success: '#8aa53f',
      },
      typography: { fontFamily: 'Inter, -apple-system, "Segoe UI", Roboto, sans-serif', headingFamily: 'Georgia, "Times New Roman", serif', baseSize: '15px', monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      radius: { sm: '6px', md: '10px', lg: '14px' },
      spacing: { unit: '8px' },
      shadow: { card: '0 1px 2px rgba(0,0,0,0.5), 0 12px 32px rgba(0,0,0,0.35)' },
      motion: {
        durationFast: '120ms', durationBase: '220ms', durationSlow: '360ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
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
      motion: {
        durationFast: '120ms', durationBase: '200ms', durationSlow: '320ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
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
      motion: {
        durationFast: '90ms', durationBase: '150ms', durationSlow: '240ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
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
      motion: {
        durationFast: '140ms', durationBase: '260ms', durationSlow: '400ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
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
      motion: {
        durationFast: '120ms', durationBase: '220ms', durationSlow: '340ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
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
      motion: {
        durationFast: '90ms', durationBase: '140ms', durationSlow: '220ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
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
      motion: {
        durationFast: '90ms', durationBase: '150ms', durationSlow: '240ms',
        easingStandard: 'cubic-bezier(0.2,0,0,1)',
        easingEntrance: 'cubic-bezier(0,0,0,1)',
        easingExit: 'cubic-bezier(0.3,0,1,1)',
      },
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
// Motion. Bounded at 1s in the grammar itself: a design document is an upload,
// and "everything on this screen takes four seconds" is a look nobody chose.
const DUR_RE = /^(?:\d{1,3}|1000)ms$|^0?\.\d{1,3}s$|^1s$/;
// `.3` (no leading zero) is valid CSS and is what the mockup template emits.
const EASE_RE = /^(?:linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\(\s*-?(?:\d(?:\.\d{1,4})?|\.\d{1,4})\s*(?:,\s*-?(?:\d(?:\.\d{1,4})?|\.\d{1,4})\s*){3}\))$/;

const COLOR_KEYS = ['background', 'surface', 'text', 'muted', 'border', 'primary', 'primaryText', 'accent', 'danger', 'success'];

// A preset's component block is a design system, not an application: big enough
// for the cards, rows, chips and layout primitives that make a look, small
// enough that nobody can ship an app through the preset registry.
export const MAX_COMPONENTS_CSS = 60_000;

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
    // Optional, like everything but colour: a design document written before
    // motion existed still parses, and gets the platform's timings.
    motion: {
      durationFast: str(t.motion?.durationFast, DUR_RE, '120ms'),
      durationBase: str(t.motion?.durationBase, DUR_RE, '200ms'),
      durationSlow: str(t.motion?.durationSlow, DUR_RE, '320ms'),
      easingStandard: str(t.motion?.easingStandard, EASE_RE, 'cubic-bezier(0.2,0,0,1)'),
      easingEntrance: str(t.motion?.easingEntrance, EASE_RE, 'cubic-bezier(0,0,0,1)'),
      easingExit: str(t.motion?.easingExit, EASE_RE, 'cubic-bezier(0.3,0,1,1)'),
    },
  };
  // The component block, when the document carries one. Sanitised rather than
  // trusted: an uploaded stylesheet is operator input that ends up served to
  // every user of every app seeded from it, so the two things that turn CSS
  // into a network request — @import and a remote url() — are refused outright
  // rather than stripped, because silently altering someone's stylesheet is how
  // they end up debugging a look they did not write.
  const rawComponents = String(doc.components_css || doc.componentsCss || '').trim();
  if (rawComponents.length > MAX_COMPONENTS_CSS) {
    return { ok: false, error: `components_css is ${rawComponents.length} characters — the limit is ${MAX_COMPONENTS_CSS}` };
  }
  if (/@import\b/i.test(rawComponents)) {
    return { ok: false, error: 'components_css must not use @import — inline the rules instead' };
  }
  if (/url\(\s*['"]?\s*(https?:)?\/\//i.test(rawComponents)) {
    return { ok: false, error: 'components_css must not reference remote URLs — a design must render offline' };
  }
  if (/<\/?script/i.test(rawComponents)) {
    return { ok: false, error: 'components_css contains markup, not CSS' };
  }

  return { ok: true, data: { key, name, description, tokens, componentsCss: rawComponents } };
}

// The document shape, for the upload help and the AI-adjust prompt.
export function designDocTemplate() {
  return {
    format: DESIGN_DOC_FORMAT,
    key: 'my-brand',
    name: 'My Brand',
    description: 'Short human description of the look.',
    tokens: DESIGN_PRESETS[0].tokens,
    components_css: '/* Optional: the components that make this look — cards, rows, chips.\n   Written on var(--app-*) from the tokens above so re-valuing the design\n   re-values everything built on it. */\n.card { background: var(--app-surface); border-radius: var(--app-radius-lg); }',
  };
}

// The seed files a chosen preset contributes to a fresh project: the token doc
// and the rendered stylesheet, exactly what design approval would produce —
// so the base app is styled before any model turn. 'ai'/unknown → [].
export function buildDesignPresetSeedFiles(key) {
  const preset = getDesignPreset(key);
  if (!preset) return [];
  // A preset's COMPONENT block, when it has one. Tokens alone are a palette;
  // what makes a look a look is the components — the card, the row, the chip —
  // and a preset that could not carry them meant every project re-derived the
  // same house style from scratch. Appended after the rendered tokens so it can
  // build on them, and sanitised at save time (see parseDesignDoc).
  const css = preset.componentsCss
    ? `${renderDesignTokensCss(preset.tokens)}\n/* ==preset-components== ${preset.key} */\n${preset.componentsCss}\n`
    : renderDesignTokensCss(preset.tokens);
  return [
    { path: 'state/design-tokens.json', content: `${JSON.stringify(preset.tokens, null, 2)}\n` },
    { path: 'state/design.css', content: css },
  ];
}

// applyDesignPreset — bind the Concept prompts to the chosen theme by
// appending a section to the locked design system. The theme is a BASE the
// model builds on and may extend COMPLEMENTARILY — not a cage: the original
// "EXACTLY these tokens, nothing else" wording measurably flattened mockups
// (the model couldn't reach the modern component/detail language it knows).
// No preset → the design system rides unchanged (the model picks the look).
// artDirectionSection — the CRAFT CONTRACT a flagship theme carries beyond its
// tokens: the named palette with usage roles, the type pairing with its rules,
// and the signature details that make the register IT. This is the concrete
// answer to "function A-, form B": tokens alone make a look consistent; the
// contract is what makes it designed. Gated by the admin "Art direction
// contract" toggle (on by default) via the caller's opts.
function artDirectionSection(ad) {
  if (!ad) return '';
  return `

## Art direction (craft contract — this is what separates A-grade form from B)
Register: ${ad.register}.
Named palette — use these ROLES; beyond tints/shades of them, invent no new hues:
${ad.namedPalette.map((c) => `- ${c.name} ${c.hex} — ${c.role}`).join('\n')}
Type pairing: display = ${ad.fontPairing.display}; UI = ${ad.fontPairing.ui}.
${ad.fontPairing.rules}
Signature details — every screen should show at least one:
${ad.signature.map((s) => `- ${s}`).join('\n')}
Craft rules (always):
- One spacing scale (multiples of the spacing unit); no ad-hoc gaps.
- ONE accent does interactive emphasis; status colors appear only on status.
- The display face appears only in display moments — never on controls.
- Every screen has one focal point and one clear primary action.`;
}

export function applyDesignPreset(designSystemMd, key, { artDirection = true } = {}) {
  const preset = getDesignPreset(key);
  const base = String(designSystemMd || '');
  if (!preset) return base;
  const t = preset.tokens;
  const contract = artDirection ? artDirectionSection(preset.artDirection) : '';
  return `${base}${contract}

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
export function applyExploreDesign(designSystemMd, { artDirection = true } = {}) {
  const base = String(designSystemMd || '');
  const contract = artDirection ? `
3. DECLARE your art direction before you use it, in a CSS comment at the top of
   the mockup: a NAMED palette (5–8 named hex tokens, each with a usage role),
   a type PAIRING (display face + UI face, with the rule for when each
   appears), and ONE signature detail (the crafted touch that makes this app
   recognizably itself). Then follow your own declaration on every screen —
   one accent for interaction, one spacing scale, display face only in display
   moments. The four flagship themes (Folio Warm/Light/Dark, Portal Blue) are
   the quality bar: commit to a register the way they do.` : '';
  return `${base}

## Design direction for THIS turn: EXPLORE a new look (Builder's choice)
Set aside any base theme above for this mockup. Design at the level of the
best modern product UIs (shadcn/Radix-inspired component language,
Linear/Stripe-class polish):
1. First think about what THIS application's domain needs — its core objects,
   states, and tasks — and the display patterns the best products use for them.
2. Then choose a palette, typography, and component language that FIT that
   domain (not a generic default), and apply them consistently.${contract}
Everything must remain fully self-contained HTML/CSS (no CDNs, no external
fonts — pick from families commonly installed). If the Builder approves this
mockup, its look becomes the project's design system going forward.`;
}
