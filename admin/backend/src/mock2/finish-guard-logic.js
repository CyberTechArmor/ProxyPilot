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

import { createHash } from 'node:crypto';
import { databaseRefusalText, describeEngineHits } from './database-exception-logic.js';

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

// ---- no SQLite without an explicit request (app foundation, 2026-10) ----
//
// A build whose diff ADDS a refused database engine (a SQLite import, a
// better-sqlite3 dependency, DATABASE_URL=file:…) cannot report done, whatever
// the gate copied into the container said. The host reads the changed files
// (one round trip, the script below), judges them in
// database-exception-logic.introducedEngineHits — against the file at the
// commit the cycle started from (HEAD when unknown), so only what this build
// added counts, committed mid-cycle or not — and rejects through the shared
// finish budget. A recorded SQLite exception (mock2.db, never a repo file)
// allows the SQLite family; nothing allows the others. This is also what holds
// an app from before the foundation to the rule: its gate only REPORTS the
// engines it already had.
//
// CHEAPEST PASS: take the engine out and use the foundation's PostgreSQL —
// which is the point. Rewording the finish cannot pass it; the budget bounds
// the round trips and exhaustion concludes for operator review, never as a
// success.

// Lines worth sending back for a source file: a superset of everything the
// classifier can match (specifiers and DATABASE_URL literals).
const ENGINE_PREFILTER = 'sqlite|libsql|sql\\.js|pglite|mysql|mongo|typeorm|sequelize|prisma|knex|drizzle-orm|DATABASE_URL';

// The commit a cycle started from. The finish guards compare the tree against
// it rather than against HEAD, so a commit the build makes mid-cycle does not
// hide what it changed. Anything but a full object name falls back to HEAD.
export function cycleBaseRef(base) {
  const s = String(base || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(s) ? s : 'HEAD';
}

// `git rev-parse -q --verify HEAD` output → the commit, or null.
export function parseCycleBase(stdout) {
  const s = String(stdout || '').trim().split('\n').pop().trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(s) ? s : null;
}

export const CYCLE_BASE_READ_COMMAND = 'git rev-parse -q --verify HEAD 2>/dev/null';

// The shell lines that set $BASE to the cycle's base commit, or HEAD when that
// commit is not in the checkout.
function baseRefLines(base) {
  return `BASE='${cycleBaseRef(base)}'
git rev-parse -q --verify "$BASE^{commit}" >/dev/null 2>&1 || BASE=HEAD`;
}

// The container script. Prints, per changed file: `@@F <b64 path>`,
// `@@B <b64 at the base>`, `@@C <b64 now>`. package.json goes whole (it is
// parsed); other files go as `N:line` for the prefiltered lines only. Bounded:
// 400 files, 400 lines or 256 KiB a file, 4 MB in all. `base` is the commit
// the cycle started from (cycleBaseRef; HEAD when unknown).
export function buildChangedEngineReadScript({ appDir = '/srv/app', base = null } = {}) {
  const dir = String(appDir).replace(/'/g, '');
  return `cd '${dir}' 2>/dev/null || exit 0
PRE='${ENGINE_PREFILTER}'
${baseRefLines(base)}
b() { base64 | tr -d '\\n'; }
{ git -c core.quotePath=false diff --name-only "$BASE" 2>/dev/null; git -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null; } | sort -u \\
  | grep -Ev '(^|/)(node_modules|dist|build|coverage|\\.git)/|^state/' \\
  | grep -Ei '\\.([cm]?[jt]sx?|json|ya?ml|toml|sh)$|(^|/)\\.env[^/]*$' \\
  | head -n 400 | while IFS= read -r f; do
    printf '@@F %s\\n' "$(printf '%s' "$f" | b)"
    case "$f" in
      package.json|*/package.json)
        printf '@@B %s\\n' "$(git show "$BASE:$f" 2>/dev/null | head -c 262144 | b)"
        if [ -f "$f" ]; then printf '@@C %s\\n' "$(head -c 262144 "$f" | b)"; else printf '@@C \\n'; fi ;;
      *)
        printf '@@B %s\\n' "$(git show "$BASE:$f" 2>/dev/null | grep -Ein "$PRE" | head -n 400 | b)"
        if [ -f "$f" ]; then printf '@@C %s\\n' "$(grep -Ein "$PRE" "$f" 2>/dev/null | head -n 400 | b)"; else printf '@@C \\n'; fi ;;
    esac
  done | head -c 4000000
exit 0
`;
}

function fromB64(s) {
  try { return Buffer.from(String(s || '').trim(), 'base64').toString('utf8'); } catch { return ''; }
}

// `N:text` lines back into a sparse text whose line numbers are the file's own.
function sparseText(numbered) {
  const lines = [];
  for (const l of String(numbered || '').split('\n')) {
    const m = l.match(/^(\d+):(.*)$/);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 1e6) lines[Number(m[1]) - 1] = m[2];
  }
  return Array.from(lines, (x) => x ?? '').join('\n');
}

// parseChangedEngineRead(stdout) → [{ path, base, current }]
export function parseChangedEngineRead(stdout) {
  const files = [];
  let cur = null;
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^@@([FBC]) ?(.*)$/);
    if (!m) continue;
    if (m[1] === 'F') {
      cur = { path: fromB64(m[2]), base: '', current: '' };
      if (cur.path) files.push(cur);
      continue;
    }
    if (!cur) continue;
    const text = fromB64(m[2]);
    const whole = /(?:^|\/)package\.json$/i.test(cur.path);
    if (m[1] === 'B') cur.base = whole ? text : sparseText(text);
    else cur.current = whole ? text : sparseText(text);
  }
  return files;
}

export function databaseEngineRejectionMessage(hits = []) {
  return `Not finished — this build adds a database engine the platform refuses. ${databaseRefusalText(describeEngineHits(hits))}\n`
    + 'Remove it and use the foundation\'s PostgreSQL (DATABASE_URL from the environment, Drizzle for every query; files and '
    + 'embeddings through the adapters in foundation/). If PostgreSQL is unreachable, report it and stop — do not work around it.';
}

// ---- foundation/ is platform-owned (app foundation, 2026-10) ----
//
// In a project on the foundation (projects.foundation_version set), foundation/
// is the platform's: the base-app upgrade rewrites it as a group, and the host
// trusts the health and job state its CLI reports. Constitution §2: feature
// code imports foundation/ and never edits, copies or forks it. So a build
// whose diff — against the commit the cycle started from, untracked files
// included — adds, modifies or deletes anything under foundation/ cannot
// report done. Judged on the host, like the database check. The platform also
// puts those files back (runner.restoreFoundationEdits) — at the refusal, so
// the build continues from the platform's foundation/, and before every
// checkpoint commit, so a halt, a pause or a concluded finish budget cannot
// carry the change into the history a resumed segment starts from.
//
// THE ONE EXEMPTION is the platform's own base-app upgrade
// (base-app-upgrade.js). It commits as `ProxyPilot <platform@proxypilot>`
// ("base app: platform module …") before a build starts (the manual route
// refuses while one runs), so its change is normally not in a build's diff at
// all. When it is — an upgrade whose commit did not land — it is recognised by
// CONTENT, not by an author or message a build could write too: a file whose
// bytes are exactly what the platform generates today (scaffoldFoundationFiles)
// is the upgrade's. The upgrade never deletes, so a deletion is never exempt.
//
// CHEAPEST PASS: leave foundation/ the way the platform put it — which is the
// point.

export const FOUNDATION_OWNED_DIR = 'foundation/';

export function isFoundationOwnedChange(path) {
  const p = String(path || '');
  return p.startsWith(FOUNDATION_OWNED_DIR) && !p.split('/').includes('..');
}

// The container script. Prints one `@@ <status> <sha256|-> <b64 path>` line per
// path under foundation/ that differs from the base (git diff --name-status,
// no rename pairing) or is untracked (status A). Bounded to 400 paths.
export function buildFoundationChangeReadScript({ appDir = '/srv/app', base = null } = {}) {
  const dir = String(appDir).replace(/'/g, '');
  return `cd '${dir}' 2>/dev/null || exit 0
${baseRefLines(base)}
TAB=$(printf '\\t')
{ git -c core.quotePath=false diff --name-status --no-renames "$BASE" -- foundation 2>/dev/null
  git -c core.quotePath=false ls-files --others --exclude-standard -- foundation 2>/dev/null | while IFS= read -r u; do printf 'A\\t%s\\n' "$u"; done
} | head -n 400 | while IFS="$TAB" read -r st f; do
    [ -n "$f" ] || continue
    h=-
    if [ -f "$f" ] && [ ! -L "$f" ]; then h=$(sha256sum < "$f" 2>/dev/null | cut -d' ' -f1); [ -n "$h" ] || h=-; fi
    printf '@@ %s %s %s\\n' "$st" "$h" "$(printf '%s' "$f" | base64 | tr -d '\\n')"
  done
exit 0
`;
}

// parseFoundationChangeRead(stdout) → [{ path, status: 'A'|'M'|'D'|…, sha256: string|null }]
export function parseFoundationChangeRead(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^@@ ([A-Z])[0-9]* (-|[0-9a-f]{64}) (\S+)\s*$/);
    if (!m) continue;
    const path = fromB64(m[3]);
    if (!path) continue;
    out.push({ path, status: m[1], sha256: m[2] === '-' ? null : m[2] });
  }
  return out;
}

// platformFoundationHashes([{ path, content }]) → Map(path → sha256 hex) of the
// bytes the platform generates for foundation/ today.
export function platformFoundationHashes(files = []) {
  const map = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || !isFoundationOwnedChange(f.path) || typeof f.content !== 'string') continue;
    map.set(f.path, createHash('sha256').update(f.content, 'utf8').digest('hex'));
  }
  return map;
}

// foundationEditRefusals({ changes, platformHashes }) → [{ path, change }]
// change: 'added' | 'modified' | 'deleted'. A file that now holds exactly the
// platform's own bytes is the base-app upgrade's, and is not refused.
export function foundationEditRefusals({ changes = [], platformHashes = new Map() } = {}) {
  const hashes = platformHashes instanceof Map ? platformHashes : new Map(Object.entries(platformHashes || {}));
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(changes) ? changes : []) {
    if (!c || !isFoundationOwnedChange(c.path) || seen.has(c.path)) continue;
    seen.add(c.path);
    const change = c.status === 'A' ? 'added' : c.status === 'D' ? 'deleted' : 'modified';
    if (change !== 'deleted' && c.sha256 && hashes.get(c.path) === c.sha256) continue;
    out.push({ path: c.path, change });
  }
  return out;
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// The container script that puts foundation/ back as it was at the base: a
// modified or deleted file is checked out from the base, an added one is
// removed. Only the refused paths (foundationEditRefusals), nothing else
// (runner.restoreFoundationEdits).
export function buildFoundationRestoreScript({ appDir = '/srv/app', base = null, refusals = [] } = {}) {
  const dir = String(appDir).replace(/'/g, '');
  const lines = [];
  for (const r of Array.isArray(refusals) ? refusals : []) {
    if (!r || !isFoundationOwnedChange(r.path)) continue;
    const p = shQuote(r.path);
    lines.push(r.change === 'added'
      ? `rm -f -- ${p} || printf 'not removed: %s\\n' ${p}`
      : `git checkout "$BASE" -- ${p} 2>/dev/null || printf 'not restored: %s\\n' ${p}`);
  }
  return `cd '${dir}' 2>/dev/null || exit 0
${baseRefLines(base)}
${lines.join('\n')}
exit 0
`;
}

function listChanges(list, max = 12) {
  return list.slice(0, max).map((r) => `${r.path} (${r.change})`).join('; ')
    + (list.length > max ? `; … ${list.length - max} more` : '');
}

// The rejection. `restored` is what the platform already put back
// (runner.restoreFoundationEdits); `remaining` is what it could not, with the
// commands that do it.
export function foundationEditRejectionMessage({ restored = [], remaining = [] } = {}, { base = null } = {}) {
  const done = Array.isArray(restored) ? restored : [];
  const left = Array.isArray(remaining) ? remaining : [];
  const restore = left.filter((r) => r.change !== 'added').slice(0, 40).map((r) => shQuote(r.path));
  const remove = left.filter((r) => r.change === 'added').slice(0, 40).map((r) => shQuote(r.path));
  const steps = [
    restore.length ? `git checkout ${cycleBaseRef(base)} -- ${restore.join(' ')}` : '',
    remove.length ? `rm -f -- ${remove.join(' ')}` : '',
  ].filter(Boolean).join(' && ');
  return 'Not finished — this build changed foundation/, which is platform-owned (constitution §2): the platform\'s '
    + 'base-app upgrade rewrites it, and the host trusts the health and job state it reports.\n'
    + (done.length ? `The platform put these back as they were when this cycle started: ${listChanges(done)}.\n` : '')
    + (left.length ? `Still changed — put them back yourself: ${listChanges(left)}${steps ? ` (${steps})` : ''}.\n` : '')
    + 'Feature code uses the adapters — import { storage, embeddings, vector } from \'#foundation\' (foundation/README.md) — '
    + 'and never edits, copies or forks foundation/. Redo the work that needed the change through the adapters; if the '
    + 'foundation itself has to change, ask the platform to change it: say what and why in your finish summary (or halt), '
    + 'and leave foundation/ untouched.';
}
