// Mock2 FEATURE ACTIVATION — which platform features actually fired.
//
// THE QUESTION NOBODY COULD ANSWER. Six features shipped in a week — screen
// accounts, demo content, the clarifier, the shell contract, design options,
// removal claims — every one unit-tested, not one observed on a live build.
// Asked "did demo content run on this build?", the only way to find out was to
// scroll a chat looking for a note that may never have been written, because a
// feature that DECLINES to act writes nothing at all. Silence meant both "it
// ran and found nothing to do" and "it never ran", and those are the two
// answers that matter most when you are trying to validate something.
//
// So: one ledger per build, one line per feature, INCLUDING the features that
// did nothing. A skip with a reason is the most valuable row here — it is the
// one that used to be invisible.
//
// WHY NOT JUST READ THE CHAT NOTES. They are written for an operator mid-build
// ("3 fixture users ready"), they are interleaved with everything else, each
// feature phrases its own differently, and — the fatal part — they are only
// written on the interesting branch. This is a different artefact with a
// different job: a complete, uniform, boring list.
//
// PURE (stub-first, risk R9). Terminology (risk R7): nothing here is an "agent".

// The registry. A feature must be declared here to be recorded, so a typo
// becomes an error rather than a silent extra row nobody notices — and so this
// list doubles as the answer to "what is the platform actually doing to my
// build", which no file previously stated.
export const FEATURES = Object.freeze({
  screen_accounts: 'Screen accounts',
  demo_content: 'Demo content',
  clarifier: 'Request clarifier',
  shell_contract: 'Shell contract',
  removal_claims: 'Removal claims',
  design_review: 'Design review',
  design_options: 'Design options',
  first_run: 'First-run detection',
  prepass: 'Quick-lane pre-pass',
});

// Three states, and the middle one is the reason this exists.
//   fired   — it did something; `detail` says what
//   skipped — it ran and decided not to act; `detail` says WHY
//   failed  — it broke; `detail` is the error
export const ACTIVATION_STATES = Object.freeze(['fired', 'skipped', 'failed']);

export function isKnownFeature(key) {
  return Object.prototype.hasOwnProperty.call(FEATURES, String(key));
}

// normaliseActivation — one entry, cleaned. Returns null for anything that
// would put a junk row in the ledger; the caller drops it.
export function normaliseActivation(entry) {
  const key = String(entry?.feature ?? '').trim();
  if (!isKnownFeature(key)) return null;
  const state = String(entry?.state ?? '').trim();
  if (!ACTIVATION_STATES.includes(state)) return null;
  return {
    feature: key,
    label: FEATURES[key],
    state,
    detail: String(entry?.detail ?? '').trim().slice(0, 240),
  };
}

// mergeActivations — later wins, order of FIRST appearance preserved.
//
// A feature can report twice in one build (the shell contract is read at the
// gate and again at smoke). Keeping both would make the ledger a log; keeping
// the FIRST would freeze an early "skipped" over a later "fired". The last
// word is the outcome, and the original position keeps the list stable.
export function mergeActivations(entries = []) {
  const byKey = new Map();
  for (const raw of entries || []) {
    const e = normaliseActivation(raw);
    if (!e) continue;
    // A `failed` is never overwritten by a later success: a feature that threw
    // and then partially recovered is a thing to look at, not to forget.
    const prev = byKey.get(e.feature);
    if (prev && prev.state === 'failed' && e.state !== 'failed') continue;
    byKey.set(e.feature, e);
  }
  return [...byKey.values()];
}

const MARK = Object.freeze({ fired: '✓', skipped: '–', failed: '!' });

// activationNote — the one note an operator reads.
//
// Every declared feature appears, including ones that never reported: "not
// reached" is a real and different answer from "skipped", and it is what an
// operator sees when a build never got as far as that stage. Inventing a
// "skipped" for it would be a lie in the direction of everything-is-fine.
export function activationNote(entries = [], { known = Object.keys(FEATURES) } = {}) {
  const merged = mergeActivations(entries);
  if (!merged.length) return '';
  const byKey = new Map(merged.map((e) => [e.feature, e]));
  const width = Math.max(...known.map((k) => (FEATURES[k] || k).length));
  const lines = ['Platform features this build:'];
  for (const key of known) {
    const e = byKey.get(key);
    const label = (FEATURES[key] || key).padEnd(width);
    if (!e) { lines.push(`  · ${label}  not reached`); continue; }
    lines.push(`  ${MARK[e.state]} ${label}  ${e.detail || e.state}`);
  }
  const failed = merged.filter((e) => e.state === 'failed');
  if (failed.length) {
    lines.push('', `${failed.length} feature(s) failed — that is a platform defect, not something your app did: ${failed.map((e) => e.label).join(', ')}.`);
  }
  return lines.join('\n');
}

// activationSummary — the counts, for a log line or a status payload.
export function activationSummary(entries = []) {
  const merged = mergeActivations(entries);
  const count = (s) => merged.filter((e) => e.state === s).length;
  return {
    total: merged.length,
    fired: count('fired'),
    skipped: count('skipped'),
    failed: count('failed'),
    notReached: Object.keys(FEATURES).length - merged.length,
  };
}
