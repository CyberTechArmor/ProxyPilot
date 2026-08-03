// Mock2 finish-handshake GUARD — PURE decision layer (native-free, unit-tested).
//
// Born from project 47 request 141: the build's finish tool call was malformed —
// the `summary` parameter literally contained
//     "</summary>\n<parameter name=\"acceptance\">[...]"
// so the harness never received an `acceptance` parameter at all. The rejection
// message ("finish requires `acceptance` …") never showed the model what WAS
// received, so five consecutive retries were the same structural bug, $4.75 was
// spent, and the cycle ended awaiting_admin with all the work complete and
// stranded. That was a parse/diagnostics failure, not a prose-quality failure.
//
// This module owns the four fixes:
//   1. malformedFinishInput — a parameter value carrying tool-call syntax
//      fragments IS a malformed call; name the fragment and where it appeared.
//   2. receivedParamsEcho — every finish rejection now lists the parameter
//      names the harness actually received and a short snippet of each, so a
//      structural bug is visible to the model on the FIRST rejection.
//   3. identical-retry detection — a retry whose payload is the same as the
//      last rejected one gets an escalated diagnostic naming the likely cause,
//      not the same rejection again.
//   4. a SHARED rejection budget across ALL finish validators (gate-audit.md
//      recommendation #1). N real rejections total — repeated-identical
//      rejections charge the budget once — and on exhaustion the runner
//      CONCLUDES the cycle with a checkpoint and an operator summary instead
//      of negotiating further. A type-clean tree is never stranded behind the
//      handshake.
//
// CHEAPEST-PASS NOTE (the standing rule from docs/gate-audit.md): the cheapest
// thing a build can do to get past this guard is to send ONE well-formed finish
// call — which is exactly the thing we want. The budget cannot be gamed into
// shipping bad work: exhaustion concludes as pending-operator-verification
// (checkpointed, not deployed as a success), so "get rejected three times on
// purpose" buys a build nothing except an operator reading its unfinished
// summary. Evidence: P47 request 141 ($4.75, five identical rejections,
// nothing shipped); P34 (no gate battery, 24/24 shipped).
//
// Terminology (risk R7): nothing here is named "agent".

// N real rejections shared across every finish validator. Three is deliberate:
// P34's whole median request cost $1.51; five rejection round-trips on a large
// context cost more than most useful cycles. One rejection fixes an honest
// omission; two fixes a misunderstanding; a third non-identical rejection is
// the last chance — after that the operator decides, not the loop.
export const FINISH_REJECTION_BUDGET = 3;

// The syntax fragments that can only appear in a parameter VALUE when the
// model's tool call was serialized/parsed wrong (request 141's exact shape).
export const TOOL_SYNTAX_FRAGMENTS = Object.freeze(['</summary>', '</parameter>', '<parameter ']);

const SNIPPET_LEN = 120;

function snippet(v, len = SNIPPET_LEN) {
  let s;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

// malformedFinishInput — walk every string value in the finish input (top level
// and one level into arrays/objects, which covers acceptance[] and
// assumptions.verified[]) looking for tool-call syntax fragments. Returns
// { malformed:false } or { malformed:true, param, fragment, where } with a
// quotable excerpt around the offending fragment.
export function malformedFinishInput(input) {
  const check = (param, v) => {
    if (typeof v !== 'string') return null;
    for (const frag of TOOL_SYNTAX_FRAGMENTS) {
      const i = v.indexOf(frag);
      if (i !== -1) {
        const start = Math.max(0, i - 40);
        return {
          malformed: true,
          param,
          fragment: frag,
          where: `${v.slice(start, i)}▶${v.slice(i, i + frag.length + 60)}`.replace(/\s+/g, ' ').slice(0, 160),
        };
      }
    }
    return null;
  };
  const obj = input && typeof input === 'object' ? input : {};
  for (const [k, v] of Object.entries(obj)) {
    const hit = check(k, v);
    if (hit) return hit;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const h = check(`${k}[${i}]`, v[i]) || (v[i] && typeof v[i] === 'object'
          ? Object.entries(v[i]).map(([kk, vv]) => check(`${k}[${i}].${kk}`, vv)).find(Boolean)
          : null);
        if (h) return h;
      }
    } else if (v && typeof v === 'object') {
      for (const [kk, vv] of Object.entries(v)) {
        const h = check(`${k}.${kk}`, vv)
          || (Array.isArray(vv) ? vv.map((x, i) => check(`${k}.${kk}[${i}]`, x)).find(Boolean) : null);
        if (h) return h;
      }
    }
  }
  return { malformed: false };
}

// ---- the file-based finish fallback (P47 cycle 587) ----
//
// The mangling is EMISSION flakiness, not a parser bug: the same model sent
// three glued calls in one cycle and a clean one in the next. Re-issuing the
// call is a coin flip — so there is a path serialization cannot mangle: write
// the SAME fields as one JSON object to state/finish.json with the file tools
// (which demonstrably work — the whole build was made with them), then call
// finish again, even bare. The runner reads the file as the call's parameters
// and CONSUMES it (deleted before the diff is read), so it can never leak into
// a checkpoint or feed a later cycle.
export const FINISH_FILE_PATH = 'state/finish.json';

export function finishFileHint() {
  return `If a re-issued call gets mangled again, use the FILE FALLBACK: write the same fields as ONE JSON object to \`${FINISH_FILE_PATH}\` `
    + '({"summary": "…", "acceptance": ["…"], "assumptions": {"verified": ["…"], "assumed": []}}, plus optional '
    + '"acceptance_ids"/"removals") using your file tools, then call finish again — even with no parameters. '
    + 'The harness reads that file as the call\'s parameters and deletes it.';
}

// parseFinishFile — tolerant read of the fallback file. Only well-shaped fields
// are taken; a file with nothing usable is an error the rejection can quote.
export function parseFinishFile(text) {
  let doc;
  try { doc = JSON.parse(String(text || '')); } catch (e) {
    return { ok: false, error: `${FINISH_FILE_PATH} is not valid JSON: ${e?.message || e}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: `${FINISH_FILE_PATH} must be a JSON object` };
  }
  const fields = {};
  if (typeof doc.summary === 'string' && doc.summary.trim()) fields.summary = doc.summary.trim();
  if (Array.isArray(doc.acceptance)) {
    const acc = doc.acceptance.map((s) => String(s || '').trim()).filter(Boolean);
    if (acc.length) fields.acceptance = acc;
  }
  const a = doc.assumptions;
  if (a && typeof a === 'object' && Array.isArray(a.verified) && Array.isArray(a.assumed)) {
    fields.assumptions = {
      verified: a.verified.map((s) => String(s || '').trim()).filter(Boolean),
      assumed: a.assumed.map((s) => String(s || '').trim()).filter(Boolean),
    };
  }
  if (Array.isArray(doc.acceptance_ids)) fields.acceptance_ids = doc.acceptance_ids.map((s) => String(s || '').trim()).filter(Boolean);
  if (Array.isArray(doc.removals)) fields.removals = doc.removals;
  if (!Object.keys(fields).length) {
    return { ok: false, error: `${FINISH_FILE_PATH} carries no usable finish fields (summary / acceptance / assumptions / acceptance_ids / removals)` };
  }
  return { ok: true, fields };
}

// malformedRejectionMessage — the rejection for a malformed call. Quotes the
// offending fragment and where it appeared (request 141's fix: the model can
// only correct a structural bug it can see).
export function malformedRejectionMessage(hit, input) {
  return `Not finished — this finish call is MALFORMED: the \`${hit.param}\` parameter value contains tool-call syntax `
    + `("${hit.fragment}"), which means the call's parameters were serialized into one string instead of arriving separately.\n\n`
    + `Where it appeared (▶ marks the fragment): …${hit.where}…\n\n`
    + `${receivedParamsEcho(input)}\n\n`
    + 'Do not rephrase the prose — fix the STRUCTURE: re-call finish with `summary`, `acceptance`, and `assumptions` as '
    + `separate parameters, each a plain value with no XML/tool-call markup inside it.\n\n${finishFileHint()}`;
}

// receivedParamsEcho — "here is what the harness actually received", appended
// to EVERY finish rejection. Request 141's five identical retries happened
// because nothing showed the model the gap between what it thought it sent and
// what arrived.
export function receivedParamsEcho(input, { expected = ['summary', 'acceptance', 'assumptions'] } = {}) {
  const obj = input && typeof input === 'object' ? input : {};
  const keys = Object.keys(obj);
  const lines = ['Parameters the harness received in this call:'];
  if (!keys.length) lines.push('  (none — the call carried no parameters at all)');
  for (const k of keys) {
    const v = obj[k];
    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    lines.push(`  - ${k}: ${empty ? '(empty)' : `"${snippet(v)}"`}`);
  }
  const missing = (expected || []).filter((k) => {
    const v = obj[k];
    return v == null || v === '' || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) lines.push(`Missing or empty: ${missing.join(', ')}.`);
  return lines.join('\n');
}

// ---- identical-retry detection + the shared budget ----

function normalizePayload(input) {
  const obj = input && typeof input === 'object' ? input : {};
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  let s;
  try { s = JSON.stringify(sorted); } catch { s = String(obj); }
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenSet(s) {
  // Trailing-s stemming so a payload that only pluralizes a word ("view" →
  // "views") still reads as the same retry — the point is catching a model
  // re-sending the same thing lightly reworded, not exact-match trivia.
  return new Set(String(s).split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 2)
    .map((t) => t.replace(/s$/, '')));
}

// similarity — token Jaccard, 0..1. Cheap, order-insensitive: a payload that
// reshuffles the same sentences is still "the same retry".
export function payloadSimilarity(a, b) {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 1;
}

export const NEAR_IDENTICAL_SIMILARITY = 0.9;

export function initFinishGuard() {
  return {
    charged: 0,          // budget-charged rejections
    total: 0,            // every rejection, including uncharged repeats
    repeats: 0,          // consecutive identical/near-identical retries
    lastRejectedNorm: null,
    history: [],         // [{ validator, identical }] — for the operator summary
  };
}

// recordFinishRejection — fold one rejection into the guard state. Returns
// { state, count, identicalRepeat, exhausted }:
//   - identicalRepeat: this payload is the same (or nearly) as the last
//     rejected one → the caller sends the escalated diagnostic, and the budget
//     is NOT charged again (repeated-identical rejections count once).
//   - exhausted: the budget is spent (or the model has sent the same payload
//     three times) → the caller CONCLUDES the cycle instead of rejecting.
export function recordFinishRejection(state, { validator = 'finish', input = null } = {}) {
  const s = { ...state, history: [...(state.history || [])] };
  const norm = normalizePayload(input);
  const identicalRepeat = s.lastRejectedNorm != null
    && (norm === s.lastRejectedNorm || payloadSimilarity(norm, s.lastRejectedNorm) >= NEAR_IDENTICAL_SIMILARITY);
  s.total += 1;
  if (identicalRepeat) s.repeats += 1;
  else { s.repeats = 0; s.charged += 1; }
  s.lastRejectedNorm = norm;
  s.history.push({ validator, identical: identicalRepeat });
  // Exhausted when the budget of REAL rejections is spent, or when the model
  // has re-sent a near-identical payload twice after the escalated diagnostic —
  // at that point another round-trip cannot change anything.
  const exhausted = s.charged > FINISH_REJECTION_BUDGET || s.repeats >= 2;
  return { state: s, count: s.charged, identicalRepeat, exhausted };
}

// escalatedRetryDiagnostic — the message for an identical retry. Names the
// likely structural cause instead of repeating the rejection the model has
// already failed to act on.
export function escalatedRetryDiagnostic({ validator = 'finish', input = null } = {}) {
  const hit = malformedFinishInput(input);
  const cause = hit.malformed
    ? `The likely cause: your \`${hit.param}\` parameter contains tool-call syntax ("${hit.fragment}") — the call is being `
      + 'serialized wrong, so the other parameters never arrive as parameters. Fix the call STRUCTURE, not the wording.'
    : 'The likely cause is structural — a parameter arriving under the wrong name, folded into another parameter, or in the '
      + 'wrong shape — not the wording of your prose. Compare the echo below against what you intended to send.';
  return `This finish payload is essentially IDENTICAL to the one just rejected (${validator}). `
    + 'Re-sending it cannot succeed, so this is a diagnostic instead of the same rejection again.\n\n'
    + `${cause}\n\n${receivedParamsEcho(input)}\n\n${finishFileHint()}\n\n`
    + 'If you believe the payload is correct and the harness is rejecting it in error, call halt and say so — quote the '
    + 'payload and the rejection verbatim. A halt that asserts a harness fault after repeated rejections is accepted as-is.';
}

// budgetNote — one line appended to every charged rejection so the model knows
// where it stands.
export function budgetNote(count) {
  return `(Finish rejection ${count} of ${FINISH_REJECTION_BUDGET} for this cycle — after that the cycle concludes for operator review.)`;
}

// ---- budget-exhaustion conclusion ----

// The operator summary posted when the handshake budget is exhausted. The work
// is checkpointed; nothing is stranded.
export function budgetExhaustedSummary({ history = [], finishSummary = '', changedFiles = [] } = {}) {
  const validators = [...new Set(history.map((h) => h.validator))];
  const identical = history.filter((h) => h.identical).length;
  const lines = [
    '**Build concluded for your review — the finish handshake used up its rejection budget.**',
    '',
    `The build completed its work and tried to finish, but the finish payload was rejected ${history.length} time(s)`
      + ` (${validators.join(', ')}${identical ? `; ${identical} retr${identical === 1 ? 'y was' : 'ies were'} identical to a rejected payload` : ''}).`,
    'Rather than keep spending money on the handshake, the work has been CHECKPOINTED as-is.',
    '',
  ];
  if (finishSummary) lines.push(`The build's own summary of what it did:\n${String(finishSummary).slice(0, 1500)}`, '');
  const files = (changedFiles || []).slice(0, 15);
  if (files.length) lines.push(`Files changed: ${files.join(', ')}${(changedFiles || []).length > files.length ? ', …' : ''}`, '');
  lines.push(
    'What to do: review the checkpointed change (Change history), try the app, and press Deploy if it is right.',
    'If the rejections look like a harness bug (e.g. a malformed tool call), that is flagged for harness triage below.',
  );
  return lines.join('\n');
}

// ---- harness-fault halts (fix 1.e) ----

// A halt whose reason asserts the HARNESS is at fault (rejections malformed,
// validator wrong, tool call mangled). When the finish-rejection history is
// consistent with that assertion — there were rejections — the halt is
// accepted as-is: no options re-litigation, and it is flagged for harness
// triage. Request 141's endgame was a halt REJECTED for wording while the
// model was correctly reporting a harness bug.
export function isHarnessFaultHalt(reason) {
  const r = String(reason || '').toLowerCase();
  return /harness|validator|rejection|finish (call|tool|payload)|tool.?call|malformed|parameter|parse/.test(r)
    && /(reject|malform|bug|fault|error|wrong|stuck|loop|cannot|can't|refus)/.test(r);
}

export function harnessFaultHaltAccepted({ reason, rejectionTotal = 0 } = {}) {
  return rejectionTotal > 0 && isHarnessFaultHalt(reason);
}

// ---- verified-vs-assumed ledger checking (run-taxonomy fix #10/D3) ----
//
// `finish`'s assumptions: { verified: string[], assumed: string[] } is already
// structurally required (both arrays, additionalProperties: false) — absence
// is rejected. What was never checked is CONTENT: a `verified` entry was taken
// on faith. This section checks a citing claim against the cycle's own
// read-set (readSetFromTranscript, runner-logic.js) — evidence already in the
// transcript, no new tracking side-channel.

// A path-shaped token: a slash-separated path, or a bare filename ending in a
// recognized extension pattern. Broad and forgiving on purpose — several
// models will phrase a citation differently, and a false rejection here (a
// real citation the regex missed) is worse than a missed one (an uncited claim
// simply isn't checked at all, per unverifiableClaims below).
const PATH_TOKEN_RE = /[a-zA-Z0-9_.-]*\/[a-zA-Z0-9_./-]*[a-zA-Z0-9_-]|[a-zA-Z0-9_-]+\.[a-zA-Z]{1,5}\b/;

// extractCitedFile — a "verified" entry cites the file it was checked against,
// either in parens at the end ("role slugs are lowercase (src/routes/profile.ts)")
// or inline ("read src/routes/profile.ts: role slugs are lowercase"). Prefers
// the LAST parenthesized citation when more than one exists (the closing one is
// the citation; earlier parens are usually incidental prose). Returns null when
// no path-shaped token is found — many true claims (a cross-cutting invariant,
// a UI behavior observed via a browser probe, Spec B) legitimately cite nothing.
// A ROUTE is not a file (project 55). The two claims that cost that build two
// of its three finish attempts were:
//
//   "Verified /login rendered without console or network errors through
//    browser_probe."
//   "…GET /api/health returned 200; browser probe of /login reported no
//    console or network errors."
//
// Neither cites a file — they are the browser-probe observations this module's
// own contract says must never be flagged — but PATH_TOKEN_RE read "/login"
// and "/api/health" as paths, found them in no read-set (nothing can read a
// URL), and rejected the finish. A cited token is only treated as a FILE when
// it carries a file extension or is rooted in a source directory; a bare
// leading-slash route, a URL, or an HTTP-verb target is prose about the
// running app.
const SOURCE_ROOT_RE = /^(?:\.\/)?(?:src|public|app|lib|server|client|migrations|routes|components|pages|views|tests?|__tests__|scripts|state|docs|e2e|styles|db|config)\//i;
const FILE_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,4}$/;

// Prose that the bare-filename half of PATH_TOKEN_RE reads as `name.ext`.
const PROSE_ABBREV = new Set(['e.g', 'i.e', 'etc', 'vs', 'no', 'cf', 'a.k.a']);

export function looksLikeFileCitation(token) {
  const t = String(token || '').trim();
  if (!t) return false;
  // http://host/x, GET /api/health, /login — the running app, not the tree.
  if (/:\/\//.test(t)) return false;
  if (t.startsWith('/')) return false;
  if (PROSE_ABBREV.has(t.toLowerCase())) return false;
  return FILE_EXT_RE.test(t) || SOURCE_ROOT_RE.test(t);
}

export function extractCitedFile(verifiedEntry) {
  const s = String(verifiedEntry || '');
  let fromParens = null;
  for (const m of s.matchAll(/\(([^()]+)\)/g)) {
    const hit = m[1].trim().match(PATH_TOKEN_RE);
    if (hit && looksLikeFileCitation(hit[0])) fromParens = hit[0];
  }
  if (fromParens) return fromParens;
  // The FIRST token was the only one considered, so a claim that mentioned a
  // route before its file ("GET /api/health is served by src/health.ts") cited
  // the route. Scan every path-shaped token and take the first real file.
  for (const m of s.matchAll(new RegExp(PATH_TOKEN_RE, 'g'))) {
    if (looksLikeFileCitation(m[0])) return m[0];
  }
  return null;
}

function citationMatchesReadSet(cited, readSet) {
  if (readSet.has(cited)) return true;
  for (const p of readSet) {
    if (p === cited || p.endsWith(`/${cited}`) || cited.endsWith(`/${p}`)) return true;
  }
  return false;
}

// unverifiableClaims — the verified[] entries that cite a SPECIFIC file this
// cycle never read. An entry with no citation at all is not included here —
// that is a separate, non-blocking signal (many legitimate claims cite
// nothing); only a claim naming a file the cycle demonstrably never opened is
// flagged. `readSet` accepts a Set or an array (readSetFromTranscript returns
// a Set; tests may pass either).
export function unverifiableClaims({ assumptions, readSet } = {}) {
  const verified = Array.isArray(assumptions?.verified) ? assumptions.verified : [];
  const read = readSet instanceof Set ? readSet : new Set(Array.isArray(readSet) ? readSet : []);
  const out = [];
  for (const entry of verified) {
    const cited = extractCitedFile(entry);
    if (!cited) continue;
    if (!citationMatchesReadSet(cited, read)) out.push(entry);
  }
  return out;
}

// ---- sensitive-assumed detection (D3.5) — downgrades to pending-verification ----

const SENSITIVE_ASSUMED_RE = /\b(role|permission|rbac|admin|is_admin|authz|auth[zn]?|access[_ ]?level)\b/i;

// hasSensitiveAssumedValue — true when any assumed[] entry looks like it's
// making an access-control claim without having verified it. Not a rejection
// signal (a legitimate but risky claim, not a malformed submission) — the
// caller routes this to the existing pending-verification path instead.
export function hasSensitiveAssumedValue(assumed = []) {
  return (Array.isArray(assumed) ? assumed : []).some((entry) => SENSITIVE_ASSUMED_RE.test(String(entry || '')));
}

// sensitiveAssumedEntries — the actual matching assumed[] entries (not just
// the boolean), so the caller can name each one in the pending-verification
// checklist rather than a single generic line.
export function sensitiveAssumedEntries(assumed = []) {
  return (Array.isArray(assumed) ? assumed : []).filter((entry) => SENSITIVE_ASSUMED_RE.test(String(entry || '')));
}
