// Mock2 cross-provider model equivalence map (pure decision layer). Native-free,
// unit-tested stub-first (risk R9): imports nothing that opens a DB, hits the
// network, or touches Incus.
//
// The map aligns Anthropic and OpenAI model ids by CAPABILITY TIER. Within each
// provider speed tracks inversely with capability, so matching the capability
// tier matches the speed tier too — one map covers code quality, speed, and the
// rough cost bracket at once. It exists for two callers:
//   * cross-provider fallback — if a connector's call fails, resolve the
//     mapped-equivalent model on the OTHER provider (feature-flagged off by
//     default; see the runner's fallback gate);
//   * the admin UI — show "the OpenAI model that stands in for Opus 4.8" when an
//     operator is choosing a connector.
//
// Terminology (risk R7): nothing here is named "agent". This module NEVER makes
// a model call — it only resolves one id to its cross-provider twin.
//
// Prices (per 1M tokens, verified 2026-07 — see quota-logic DEFAULT_MODEL_PRICES,
// the single source of truth for cost):
//   Fable 5 $10/$50 · Opus 4.8 $5/$25 · Sonnet 5 $3/$15 · Haiku 4.5 $1/$5
//   GPT-5.6 Sol $5/$30 · Terra $2.50/$15 · Luna $1/$6 · 5.3-Codex $1.75/$14
//   GPT-5.4 mini $0.75/$4.50 · nano $0.20/$1.25  (both BELOW the Haiku floor)

// Canonicalize a model id for map lookup: lower-case, trim, fold the dotted
// version separator to a dash ("gpt-5.6-sol" ⇒ "gpt-5-6-sol") so a dotted id and
// its dashed alias resolve the same, and drop a trailing date/snapshot suffix
// ("-20260101", "@20260101") the way defaultModelPrice tolerates one.
export function normalizeModelId(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/[@-]\d{6,8}$/, '');
}

// Which provider an id belongs to, by prefix. null when we can't tell (a local
// or openai_compatible id we have no mapping for — callers then skip fallback).
export function providerOfModel(model) {
  const id = normalizeModelId(model);
  if (!id) return null;
  if (id.startsWith('claude-') || /(fable|mythos)-/.test(id)) return 'anthropic';
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3')) return 'openai';
  return null;
}

// Anthropic (normalized id) → OpenAI equivalent (the real, provider-usable id).
// Both Fable 5 and Opus 4.8 map UP to Sol — Sol is the single OpenAI frontier
// tier that stands in for either. The cheaper coding alternative for Opus is
// noted separately (OPENAI_CODING_ALT) rather than made the default, so a
// straight tier swap never silently downgrades reasoning to a coding specialist.
export const ANTHROPIC_TO_OPENAI = Object.freeze({
  'claude-fable-5': 'gpt-5.6-sol',
  'claude-opus-5': 'gpt-5.6-sol',
  'claude-opus-4-8': 'gpt-5.6-sol',
  'claude-sonnet-5': 'gpt-5.6-terra',
  'claude-haiku-4-5': 'gpt-5.6-luna',
});

// OpenAI (normalized id) → Anthropic equivalent (the real, provider-usable id).
// Sol has multiple Anthropic sources; its reverse resolves to Opus 5 — the
// high-capability workhorse — not Fable 5, so a round-trip lands on the everyday
// tier rather than the most expensive one. 5.3-Codex (a coding specialist) maps
// back to Opus 5 as its nearest high-capability Claude.
export const OPENAI_TO_ANTHROPIC = Object.freeze({
  'gpt-5-6-sol': 'claude-opus-5',
  'gpt-5-6-terra': 'claude-sonnet-5',
  'gpt-5-6-luna': 'claude-haiku-4-5',
  'gpt-5-3-codex': 'claude-opus-5',
});

// The cost-down coding alternative for the Opus/Sol tier: cheaper per token with
// a 400K context, at the price of general reasoning breadth. Offered, never
// auto-selected by equivalentModel.
export const OPENAI_CODING_ALT = 'gpt-5.3-codex';

// OpenAI-only cheap utility tier — below Anthropic's Haiku floor, so it has no
// Claude equivalent. Surface these as "cheaper than Haiku" bulk options.
export const OPENAI_CHEAP_UTILITY = Object.freeze(['gpt-5.4-mini', 'gpt-5.4-nano']);

// equivalentModel — the cross-provider twin of `model`, or null when there is
// none. Bidirectional: an Anthropic id resolves to its OpenAI equivalent and
// vice-versa. Pass targetProvider to require a direction (returns null if `model`
// is already on that provider or maps elsewhere); omit it to auto-flip to the
// other provider. mini/nano and unmapped ids return null — the caller keeps the
// original model rather than inventing a substitute.
export function equivalentModel(model, targetProvider = null) {
  const id = normalizeModelId(model);
  if (!id) return null;
  const from = providerOfModel(id);
  if (from === 'anthropic') {
    if (targetProvider && targetProvider !== 'openai') return null;
    return ANTHROPIC_TO_OPENAI[id] || null;
  }
  if (from === 'openai') {
    if (targetProvider && targetProvider !== 'anthropic') return null;
    return OPENAI_TO_ANTHROPIC[id] || null;
  }
  return null;
}

// The full alignment table, tier by tier, for display (admin UI / docs). Each
// row names the Anthropic model, its OpenAI twin, and a one-line rationale.
// mini/nano appear with anthropic:null (no equivalent).
export const MODEL_EQUIVALENCE_TABLE = Object.freeze([
  { tier: 'frontier', anthropic: 'claude-fable-5', openai: 'gpt-5.6-sol', note: 'top capability, hardest long-running coding' },
  { tier: 'high', anthropic: 'claude-opus-5', openai: 'gpt-5.6-sol', note: 'high-capability workhorse (coding cost-down: gpt-5.3-codex)' },
  { tier: 'balanced', anthropic: 'claude-sonnet-5', openai: 'gpt-5.6-terra', note: 'balanced production / agent default' },
  { tier: 'fast', anthropic: 'claude-haiku-4-5', openai: 'gpt-5.6-luna', note: 'fast, low-cost, quick edits / routing' },
  { tier: 'utility', anthropic: null, openai: 'gpt-5.4-mini', note: 'cheap utility, below the Haiku floor' },
  { tier: 'utility', anthropic: null, openai: 'gpt-5.4-nano', note: 'cheapest, below the Haiku floor' },
]);
