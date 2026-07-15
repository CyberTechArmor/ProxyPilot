// Mock2 finish-time assumption SCREENING — pure tiered lexical classifier (B.3).
// Native-free, unit-tested stub-first (risk R9). This is the SAFETY NET, not the
// primary detector: B.4 (integration-logic.js) is the source-level mechanism.
// Screening reads the finish payload's disclosure channels (assumptions, summary,
// acceptance notes) and change-record fields — the channels the AUDIT proved are
// stored-and-forgotten — and classifies simulation-disclosure language into tiers.
//
// Matching is case-insensitive with token-boundary awareness (a substring inside
// a larger word never matches: "stubborn" is not "stub", "resample" is not
// "sample").
//
// Terminology (risk R7): nothing here is named "agent".

export const SCREENING_SCHEMA_VERSION = 1;

// High-confidence disclosures: phrases that describe faking a production
// capability with little ambiguity. Ordered patterns; each carries a proposed
// classification for the admin. Patterns use \b-ish boundaries via buildMatcher.
const HIGH_CONFIDENCE = [
  { re: /\bsynthesi[sz]ed?\b(?:[^.]{0,60}\b(?:because|since|as)\b[^.]{0,40}\b(?:no|not|unreachable|isn'?t|unavailable)\b)?/i, why: 'data synthesized rather than fetched from the real source' },
  { re: /\bbest[-\s]?effort\s+prob(?:e|es|ing)\b/i, why: 'a "probe" that does not perform the real operation' },
  { re: /\b(?:a\s+)?real\s+(?:fetch|call|request|handshake)\s+would\s+replace\b/i, why: 'self-falsifying promise: the real call is deferred behind a condition already met' },
  { re: /\bno\s+live\s+(?:endpoint|server|host|service|directory)\b[^.]{0,40}\b(?:reachable|available)\b/i, why: 'success reported despite no reachable endpoint' },
  { re: /\breturns?\s+canned\s+(?:success|data|results?)\b/i, why: 'canned success returned in place of the real operation' },
  { re: /\b(?:backend|response|data|integration|sync|connection)\s+(?:is\s+)?(?:currently\s+)?(?:faked|fabricated|mocked\s+out|stubbed\s+out)\b/i, why: 'production behavior is faked' },
  { re: /\b(?:connection|integration|sync)\s+(?:test|check)\s+is\s+simulated\b/i, why: 'a test/check that is simulated rather than performing I/O' },
  { re: /\bsimulat(?:ed|es|ing|ion)\b[^.]{0,40}\b(?:because|since|no\s+live|not\s+reachable|unreachable)\b/i, why: 'behavior simulated because the real dependency is unreachable' },
];

// Ambiguous single terms: could be innocent, could be a disclosure. Blocking
// candidate with full context for admin resolution.
const AMBIGUOUS_TERMS = [
  { term: 'sample data', re: /\bsample\s+data\b/i },
  { term: 'fixture', re: /\bfixtures?\b/i },
  { term: 'stub', re: /\bstubs?\b/i },
  { term: 'stubbed', re: /\bstubbed\b/i },
  { term: 'simulated', re: /\bsimulated\b/i },
  { term: 'mock', re: /\bmock(?:ed|s)?\b/i },
  { term: 'hardcoded', re: /\bhard[-\s]?coded\b/i },
  { term: 'placeholder', re: /\bplaceholder\b/i },
  { term: 'dummy data', re: /\bdummy\s+(?:data|values?|records?)\b/i },
];

// Negation / remediation markers: when a disclosure term is inside a statement
// that says it was REMOVED or ISOLATED, it is recorded (not auto-blocking).
const NEGATION_MARKERS = /\b(removed|deleted|dropped|eliminated|replaced|no\s+longer|isolat(?:ed|ion)|verified|confirmed\s+no|without\s+any)\b/i;

// Guard / defense-description markers (ambiguous tier ONLY — never applied to a
// high-confidence phrase): a sentence that DESCRIBES A DEFENSE against
// simulation legitimately uses the ambiguous vocabulary — "a no-simulation
// guard that fails if anyone hardcodes a fake roster", "contract tests drive
// the transport against a real local TLS fixture", "fixture is test-only".
// Blocking those sentences punished exactly the disclosures the constitution
// demands (a real build looped for five cycles on them). The B.4 source
// analyzer remains the positive detector for fixture-in-production, canned
// success, and dead transport — this lexical net only stops flagging the
// sentences that describe the protections.
const GUARD_MARKERS = /\b(fails?\s+(?:if|when|on)|guards?\s+against|prevent(?:s|ing)?|detect(?:s|ing|ed)?|reject(?:s|ing|ed)?|refuse(?:s|d)?|forbid(?:s|den)?|blocks?|no[-\s]?simulation|anti[-\s]?simulation|test[-\s]?only|contract\s+tests?|local\s+(?:tls\s+)?fixture|fixture[-\s]server|in[-\s]?fence|never\s+(?:returns?|selects?|reachable|shipped))\b/i;

// A window of characters around a match, for the excerpt.
function excerptAround(text, start, end, pad = 60) {
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, end + pad);
  return (s > 0 ? '…' : '') + text.slice(s, e).trim() + (e < text.length ? '…' : '');
}

// The sentence containing a match (boundaries: '.', '\n', or start/end).
function sentenceAround(text, idx) {
  const prev = Math.max(text.lastIndexOf('.', idx), text.lastIndexOf('\n', idx));
  let next = text.indexOf('.', idx);
  if (next < 0) next = text.length;
  return text.slice(prev + 1, next);
}

// Is the sentence containing this match a negation/remediation statement?
function inNegatedContext(text, idx) {
  return NEGATION_MARKERS.test(sentenceAround(text, idx));
}

// Is the sentence a guard/defense description (ambiguous tier only)?
function inGuardContext(text, idx) {
  return GUARD_MARKERS.test(sentenceAround(text, idx));
}

function mkFinding(patch) {
  return { schema_version: SCREENING_SCHEMA_VERSION, ...patch };
}

// screenDisclosureText(fields) — fields is [{ source, text }]. Returns
// { findings } where each finding is a classified match with its source field,
// tier, matched span, excerpt, and a proposed classification.
export function screenDisclosureText(fields = []) {
  const findings = [];
  for (const { source, text } of fields || []) {
    const t = String(text || '');
    if (!t) continue;

    // High-confidence first (they win over an ambiguous single-term overlap).
    const highSpans = [];
    for (const p of HIGH_CONFIDENCE) {
      const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
      let m;
      while ((m = re.exec(t)) !== null) {
        const span = [m.index, m.index + m[0].length];
        highSpans.push(span);
        const negated = inNegatedContext(t, m.index);
        findings.push(mkFinding({
          source, tier: negated ? 'negated' : 'high',
          matched: m[0], span, excerpt: excerptAround(t, span[0], span[1]),
          proposed_classification: negated
            ? 'remediation/negation — recorded, not auto-blocking'
            : `blocking simulation disclosure — ${p.why}`,
          reason: p.why,
        }));
      }
    }

    // Ambiguous single terms (skip if already inside a high-confidence span).
    // A term inside a negation OR a guard/defense sentence is recorded, not
    // blocking — describing the protection is not disclosing a simulation.
    for (const term of AMBIGUOUS_TERMS) {
      const re = new RegExp(term.re.source, 'gi');
      let m;
      while ((m = re.exec(t)) !== null) {
        const idx = m.index;
        if (highSpans.some(([a, b]) => idx >= a && idx < b)) continue;
        const negated = inNegatedContext(t, idx);
        const guard = !negated && inGuardContext(t, idx);
        const span = [idx, idx + m[0].length];
        findings.push(mkFinding({
          source, tier: (negated || guard) ? 'negated' : 'ambiguous',
          term: term.term, matched: m[0], span, excerpt: excerptAround(t, span[0], span[1]),
          proposed_classification: negated
            ? 'remediation/negation — recorded, not auto-blocking'
            : guard
              ? 'guard/defense description (the sentence describes a protection against simulation) — recorded, not auto-blocking'
              : `ambiguous simulation term "${term.term}" — admin resolves as approved-simulation (register + label) or false positive`,
        }));
      }
    }
  }
  return { findings };
}

// screeningVerdict(findings) — roll the findings up into the blocking decision.
// High and ambiguous (non-negated) findings each create a BLOCKING candidate;
// negated findings are recorded only. Returns
// { blocking, candidates: [...], recorded: [...] }.
export function screeningVerdict(findings = []) {
  const candidates = [];
  const recorded = [];
  for (const f of findings || []) {
    if (f.tier === 'high' || f.tier === 'ambiguous') candidates.push(f);
    else if (f.tier === 'negated') recorded.push(f);
  }
  return { blocking: candidates.length > 0, candidates, recorded };
}

// The fields a finish payload + change record contribute to screening. Kept here
// so the runner and the migration path screen the SAME channels (AUDIT.md A.1).
export function disclosureFieldsFromFinish({ summary = '', acceptance = [], assumptions = null } = {}) {
  const fields = [];
  if (summary) fields.push({ source: 'finish.summary', text: String(summary) });
  for (const a of Array.isArray(acceptance) ? acceptance : []) {
    if (a) fields.push({ source: 'finish.acceptance', text: String(a) });
  }
  for (const v of (assumptions?.verified || [])) fields.push({ source: 'finish.assumptions.verified', text: String(v) });
  for (const a of (assumptions?.assumed || [])) fields.push({ source: 'finish.assumptions.assumed', text: String(a) });
  return fields;
}
