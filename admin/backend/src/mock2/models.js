// Model-ID registry — THE single place a Claude model id is spelled out.
//
// Before this file, the same ids were duplicated as string literals across
// ~10 modules (concept, runner, runner-logic, connector-logic,
// routing-logic, prepass-logic, settings, consult-logic, concept-logic,
// lean-beaf), so a model migration was a repo-wide hunt where one missed
// call site silently kept paying old-model prices — or 404'd. Now a
// migration edits these constants and, where behavior genuinely shifts,
// the per-lane tuning that references them.
//
// Tiers (not lanes): pick by capability class, then let routing-logic /
// connector-logic map lanes onto tiers.
export const MODEL_FRONTIER = 'claude-fable-5'; // hardest audits/consults only — priced above Opus
export const MODEL_PRIMARY = 'claude-opus-5'; // default build/chat/mockup workhorse
export const MODEL_PRIMARY_PREV = 'claude-opus-4-8'; // escalation / fallback tier
export const MODEL_BALANCED = 'claude-sonnet-5'; // fast lanes (difficulty-routed builds)
export const MODEL_CHEAP = 'claude-haiku-4-5'; // classifiers, summaries, briefs
// Pinned full id where a lane deliberately wants a dated snapshot (the
// pre-pass classifier keeps deterministic behavior across releases).
export const MODEL_CHEAP_PINNED = 'claude-haiku-4-5-20251001';
