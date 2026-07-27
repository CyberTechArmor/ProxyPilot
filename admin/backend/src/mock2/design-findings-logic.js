// Mock2 DESIGN FINDINGS LEDGER — the pure layer.
//
// WHY THIS EXISTS. The post-build design review opens a browser, signs in,
// screenshots the app, critiques it against the approved mockup, and posts what
// it found into the chat. Then it stops. The after-build hook runs with
// apply=false, so nothing carries a finding into the next build — the next
// build starts from the same mockup with no knowledge that anyone looked at the
// app, let alone what they said about it. Three builds could receive the same
// critique and act on none of them, and the only sign was the operator noticing
// the same sentence three times in the chat.
//
// A critique that reaches no one is not a review, it is a diary. This is the
// ledger that closes the loop: findings persist as project state, a finding
// still present on the next review is REPEATED rather than duplicated, one that
// stops appearing resolves itself, and everything still open rides the next
// build's first turn as standing work.
//
// The ledger lives in the container at state/design-findings.json — the same
// place as inventory, rules, ui-checks and design.css — so the build can read
// it directly, it survives the platform being restarted, and it moves with the
// project.
//
// PURE (stub-first, risk R9): no I/O, no native modules. Terminology (risk R7):
// nothing here is named "agent".

export const DESIGN_FINDINGS_PATH = 'state/design-findings.json';

// How many open findings ride a build's first turn. A ledger is allowed to grow
// (it is the record); a task turn is not. Ordered by severity then age, so what
// rides is the worst and the most-ignored, never simply the newest.
export const MAX_BRIEFED_FINDINGS = 8;

// A finding stops being asked for after this many builds have seen it and left
// it alone. Not because it stopped being true — because a line that has ridden
// eight builds unchanged is one the build cannot or will not act on, and
// repeating it forever costs tokens on every build while teaching nobody
// anything. It stays in the ledger, marked, where an operator can see it.
export const STALE_AFTER_BUILDS = 8;

const SEVERITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });
const MAX_LEDGER = 200;

function clip(v, n) { return String(v ?? '').trim().slice(0, n); }

// Words that carry no signal about WHICH defect this is. Dropped before
// comparison so "the tiles do nothing" and "tiles do not do anything" are
// compared on `tiles`, not on `the`/`do`/`not`.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'that', 'this', 'these',
  'those', 'it', 'its', 'has', 'have', 'had', 'not', 'no', 'do', 'does', 'did', 'so', 'than',
  'then', 'there', 'when', 'which', 'while', 'you', 'your', 'they', 'their', 'can', 'could',
  'should', 'would', 'will', 'instead', 'into', 'onto', 'out', 'up', 'down', 'any', 'all',
]);

function normalizeScreen(v) {
  return clip(v, 120).toLowerCase().replace(/\/+$/, '') || '/';
}

// The significant words of a finding, as a set.
function issueWords(issue) {
  return new Set(
    clip(issue, 400).toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

// A stable identity for a NEW finding: screen + its first significant words.
// This is the row's id, not the matcher — see matchFinding for why those are
// different jobs.
export function findingKey(f) {
  const words = [...issueWords(f?.issue)].slice(0, 10).join(' ');
  return `${normalizeScreen(f?.screen)}::${words}`;
}

// How alike two findings' wording has to be to count as the same defect.
// 0.5 = half their significant vocabulary. Tuned on the failure that made this
// matter: "KPI tiles are decorative" and "The KPI tiles are decorative and do
// nothing when tapped" share 3 of 5 words (0.6) and are obviously one defect.
export const SAME_FINDING_SIMILARITY = 0.5;

// matchFinding(rows, incoming) → the row this finding is a re-report OF, or null.
//
// WHY THIS IS NOT A KEY LOOKUP. The review is a model, and it does not phrase
// the same defect identically on two runs — the second look adds a clause, drops
// a word, or leads with the consequence instead of the cause. A key derived from
// the text (any key, including this module's own) therefore reports almost every
// repeat as new, the ledger never converges, and the count that makes a repeat
// legible — "raised on 3 reviews" — never gets above 1. That is the failure this
// whole ledger exists to avoid, so matching is similarity, not equality.
//
// Same screen is required: identical wording about two different screens is two
// defects. Above the threshold, the CLOSEST row wins, so a screen carrying
// several related findings does not collapse into whichever was written first.
export function matchFinding(rows = [], incoming = null, { exclude = new Set() } = {}) {
  const screen = normalizeScreen(incoming?.screen);
  const words = issueWords(incoming?.issue);
  if (!words.size) return null;
  let best = null; let bestScore = 0;
  for (const row of rows) {
    if (exclude.has(row.key) || normalizeScreen(row.screen) !== screen) continue;
    const other = issueWords(row.issue);
    if (!other.size) continue;
    let shared = 0;
    for (const w of words) if (other.has(w)) shared++;
    const score = shared / (words.size + other.size - shared);
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return bestScore >= SAME_FINDING_SIMILARITY ? best : null;
}

// parseFindingsLedger — tolerant read of the on-disk file.
//
// A missing, empty, truncated or hand-edited file is an ordinary outcome (the
// project may predate this, or an operator may have been reading it), and the
// answer to all of them is the same: an empty ledger, never a throw. A review
// that cannot read the ledger must still run.
export function parseFindingsLedger(text) {
  let doc = null;
  try { doc = JSON.parse(String(text || '')); } catch { return { findings: [] }; }
  const rows = Array.isArray(doc?.findings) ? doc.findings : [];
  const findings = rows
    .filter((f) => f && typeof f === 'object' && clip(f.issue, 400))
    .slice(0, MAX_LEDGER)
    .map((f) => ({
      key: clip(f.key, 200) || findingKey(f),
      screen: clip(f.screen, 120) || '/',
      severity: SEVERITY_RANK[f.severity] === undefined ? 'medium' : f.severity,
      issue: clip(f.issue, 400),
      fix: clip(f.fix, 400),
      status: f.status === 'resolved' || f.status === 'stale' ? f.status : 'open',
      firstSeenCycle: Number.isFinite(Number(f.firstSeenCycle)) ? Number(f.firstSeenCycle) : null,
      lastSeenCycle: Number.isFinite(Number(f.lastSeenCycle)) ? Number(f.lastSeenCycle) : null,
      timesSeen: Math.max(1, Math.min(999, Number(f.timesSeen) || 1)),
      buildsBriefed: Math.max(0, Math.min(999, Number(f.buildsBriefed) || 0)),
    }));
  return { findings };
}

export function renderFindingsLedger(ledger) {
  return `${JSON.stringify({ findings: ledger?.findings || [] }, null, 2)}\n`;
}

// mergeFindings(ledger, incoming, { cycleId }) → the ledger after a review.
//
// The three transitions, and why each is what it is:
//
//   seen again    — bump timesSeen and lastSeenCycle. A finding on its fourth
//                   review is not four findings; it is one the app keeps
//                   failing, and the count is the most useful thing about it.
//   newly absent  — an OPEN finding the latest review did not raise resolves.
//                   The review looked at the same screens with the same eyes;
//                   if it no longer says this, it is no longer true (or no
//                   longer reachable, which for a design finding is the same
//                   outcome). Resolving on absence is what keeps the ledger
//                   from becoming a list nobody trusts.
//   returning     — a resolved finding raised again reopens with its history
//                   intact, rather than starting over as if it were new.
export function mergeFindings(ledger, incoming = [], { cycleId = null } = {}) {
  const byKey = new Map((ledger?.findings || []).map((f) => [f.key, { ...f }]));
  const seenNow = new Set();

  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const issue = clip(raw?.issue, 400);
    if (!issue) continue;
    // Match by wording similarity, not by key: see matchFinding. `seenNow` is
    // also the exclusion set, so two findings in ONE review cannot both fold
    // into the same existing row — the second is a new defect on that screen.
    const prior = matchFinding([...byKey.values()], raw, { exclude: seenNow });
    const key = prior ? prior.key : findingKey(raw);
    seenNow.add(key);
    if (prior) {
      byKey.set(key, {
        ...prior,
        // The newest wording wins: the review just looked at the app, and its
        // current sentence describes the app's current state.
        screen: clip(raw.screen, 120) || prior.screen,
        severity: SEVERITY_RANK[raw.severity] === undefined ? prior.severity : raw.severity,
        issue,
        fix: clip(raw.fix, 400) || prior.fix,
        status: 'open',
        lastSeenCycle: cycleId,
        timesSeen: Math.min(999, (prior.timesSeen || 1) + 1),
      });
    } else {
      // Below the similarity threshold but colliding on the derived key (two
      // findings whose first significant words agree while the rest do not):
      // a distinct defect, so give it a distinct row rather than overwriting.
      let fresh = key;
      for (let n = 2; byKey.has(fresh); n++) fresh = `${key}#${n}`;
      seenNow.add(fresh);
      byKey.set(fresh, {
        key: fresh,
        screen: clip(raw.screen, 120) || '/',
        severity: SEVERITY_RANK[raw.severity] === undefined ? 'medium' : raw.severity,
        issue,
        fix: clip(raw.fix, 400),
        status: 'open',
        firstSeenCycle: cycleId,
        lastSeenCycle: cycleId,
        timesSeen: 1,
        buildsBriefed: 0,
      });
    }
  }

  for (const [key, f] of byKey) {
    if (f.status === 'open' && !seenNow.has(key)) byKey.set(key, { ...f, status: 'resolved' });
  }

  // Newest first, bounded. The bound drops the oldest RESOLVED rows first — a
  // ledger at its limit should be losing history, not live work.
  const all = [...byKey.values()];
  const live = all.filter((f) => f.status !== 'resolved');
  const done = all.filter((f) => f.status === 'resolved');
  return { findings: [...live, ...done].slice(0, MAX_LEDGER) };
}

// Everything still asking to be fixed, worst and most-repeated first.
export function openFindings(ledger) {
  return (ledger?.findings || [])
    .filter((f) => f.status === 'open')
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 1) - (SEVERITY_RANK[b.severity] ?? 1)
      || (b.timesSeen || 1) - (a.timesSeen || 1));
}

// markBriefed(ledger, keys) — record that a build was TOLD about these.
//
// Counted at brief time rather than at review time because that is the question
// being asked: not "how often has this been true" but "how many builds have
// been handed this and shipped without it". Once that passes STALE_AFTER_BUILDS
// the finding stops riding every task turn — it stays in the ledger, marked
// stale, so it is visible without being expensive.
export function markBriefed(ledger, keys = []) {
  const set = new Set(keys);
  return {
    findings: (ledger?.findings || []).map((f) => {
      if (!set.has(f.key) || f.status !== 'open') return f;
      const buildsBriefed = (f.buildsBriefed || 0) + 1;
      return { ...f, buildsBriefed, status: buildsBriefed >= STALE_AFTER_BUILDS ? 'stale' : 'open' };
    }),
  };
}

// The section that rides a build's first turn.
//
// Subordinate to the instruction, like the pre-pass brief and the operator's
// standing feedback: this is what the LAST look at the running app found, not a
// new assignment. A build asked for one thing should not silently turn into a
// polish pass — but it should also not re-ship a defect that has been named
// three times, and "seen on N reviews" is the line that makes the difference
// legible without the build having to guess.
export function designFindingsSection(open = []) {
  const items = (Array.isArray(open) ? open : []).slice(0, MAX_BRIEFED_FINDINGS);
  if (!items.length) return '';
  const lines = items.map((f) => {
    const repeat = (f.timesSeen || 1) > 1 ? ` [raised on ${f.timesSeen} reviews]` : '';
    return `- ${f.screen} (${f.severity})${repeat}: ${f.issue}${f.fix ? ` — ${f.fix}` : ''}`;
  });
  return `\n\nOpen design findings (from the automated review of the RUNNING app after earlier builds — still true as of the last look):\n${lines.join('\n')}\nFix these where they touch what you are already changing; a finding raised on several reviews is one the app keeps shipping, so prefer it over a cosmetic improvement of your own. Do not restyle anything not listed, and do not treat this as the task.`;
}

// The keys briefed, so the caller can mark them without re-deriving the slice.
export function briefedKeys(open = []) {
  return (Array.isArray(open) ? open : []).slice(0, MAX_BRIEFED_FINDINGS).map((f) => f.key);
}

// One line for the chat: what the review changed about the ledger. Posted with
// the critique so the operator can see the loop working — "3 new, 2 still open
// from earlier builds, 1 fixed since the last review" — rather than reading the
// same findings each time with no idea whether anything moved.
export function ledgerDelta(before, after) {
  const beforeOpen = new Map((before?.findings || []).filter((f) => f.status === 'open').map((f) => [f.key, f]));
  const afterRows = after?.findings || [];
  let fresh = 0; let repeated = 0; let resolved = 0;
  for (const f of afterRows) {
    if (f.status === 'open') {
      if (beforeOpen.has(f.key)) repeated++; else fresh++;
    } else if (f.status === 'resolved' && beforeOpen.has(f.key)) resolved++;
  }
  const parts = [];
  if (fresh) parts.push(`${fresh} new`);
  if (repeated) parts.push(`${repeated} still open from an earlier review`);
  if (resolved) parts.push(`${resolved} fixed since the last review`);
  if (!parts.length) return '';
  return `Design findings ledger: ${parts.join(', ')}. Open findings ride the next build automatically.`;
}
