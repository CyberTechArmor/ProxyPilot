// Mock2 RULES VIEW — the rules your app is built against, where you can read them.
//
// state/rules.md WAS WRITE-ONLY. The audit (stage 'define') raises rule
// questions, the editor taps an answer, and appendRule commits it to
// state/rules.md with a hash-chained change record. That is sign-off #2 — the
// second of the two human approvals that gate all code. And nothing in the
// product ever showed it back. The operator confirms a rule, and from that
// moment the only way to see what their app is being built against is to open
// a terminal into the container.
//
// So the stage indicator drew "Define" as a step, the audit really ran, and the
// artefact it produced was invisible. That is not a missing feature; it is a
// finished feature with no read side.
//
// BOTH SOURCES OR IT LIES. A project's behaviour is governed by two things:
//
//   1. state/rules.md — what an editor CONFIRMED, per project. Often empty:
//      it is only written by the audited Full build lane, and most projects
//      are driven from the chat's Quick update.
//   2. CRUD_RULES_PACK — the standard floor injected into every quick/MVP
//      build, precisely BECAUSE the interview was skipped (the project-32
//      postmortem: the skipped Define stage shipped permanent workflow dead
//      ends, and this pack encodes the rules whose absence caused them).
//
// A panel showing only (1) would tell the overwhelming majority of projects
// "you have no rules", which is false and is the more dangerous direction of
// wrong — it invites an operator to assume nothing is guaranteed when in fact
// eight things are. So both are returned, labelled by origin, and the empty
// case says what to do about it.
//
// PURE (stub-first, risk R9). Terminology (risk R7): nothing here is an "agent".

export const RULES_PATH = 'state/rules.md';

// The anchor appendRule embeds, as an HTML comment: `<!-- rule-q12 -->`.
const ANCHOR = /^<!--\s*(rule-q\d+)\s*-->$/;

// parseRulesMd — the committed markdown → the sections an operator reads.
//
// Parsed rather than stored structurally for the same reason the findings card
// parses its own message: the markdown IS the durable artefact — it is what is
// committed, hash-chained and diffed — and a parallel structured copy would be
// a second thing to keep in sync. This reads our own generator's output.
export function parseRulesMd(md) {
  const text = String(md || '');
  if (!text.trim()) return { ok: true, rules: [], intro: '', malformed: 0 };

  const lines = text.split('\n');
  const rules = [];
  let intro = [];
  let cur = null;
  let malformed = 0;
  let seenHeading = false;

  const flush = () => {
    if (!cur) return;
    const body = cur.body.join('\n').trim();
    // `**Answer:**` is what appendRule writes. A section without one is a rule
    // that was written by hand or by an older shape; it is still shown (the
    // operator's rule is the operator's rule) but the answer is left empty
    // rather than guessed from the prose.
    const m = body.match(/\*\*Answer:\*\*\s*([\s\S]*)$/);
    const question = (m ? body.slice(0, m.index) : body).trim();
    if (!m) malformed += 1;
    rules.push({
      anchor: cur.anchor,
      heading: cur.heading,
      question,
      answer: m ? m[1].trim() : '',
      origin: 'confirmed',
    });
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      flush();
      seenHeading = true;
      cur = { heading: h2[1].trim(), anchor: '', body: [] };
      // The anchor, when present, is the very next non-blank line.
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        const a = lines[j].trim().match(ANCHOR);
        if (a) { cur.anchor = a[1]; i = j; }
        break;
      }
      continue;
    }
    if (cur) { cur.body.push(line); continue; }
    // Anything before the first `##` is the document's own preamble (the
    // "# Project rules" title and its explanation). Not a rule.
    if (!seenHeading && !/^#\s/.test(line)) intro.push(line);
  }
  flush();

  return { ok: true, rules, intro: intro.join('\n').trim(), malformed };
}

// The standard floor, as displayable rules. Parsed from the pack's own numbered
// text so there is ONE definition — re-typing the eight rules here is how the
// panel and the builds start disagreeing about what is guaranteed.
export function parseRulesPack(packText) {
  const text = String(packText || '');
  if (!text.trim()) return [];
  const out = [];
  // Entries look like "1. Every record …" and WRAP across indented continuation
  // lines. Split on the numbered starts rather than matching lazily up to a
  // lookahead: with the `m` flag `$` matches at every line end, so a lazy body
  // stopped at the first newline and every rule lost all but its opening
  // clause — silently, since a truncated sentence still reads like a rule.
  const chunks = text.split(/^(?=\d+\.\s)/m).filter((c) => /^\d+\.\s/.test(c));
  for (const chunk of chunks) {
    const m = chunk.match(/^(\d+)\.\s([\s\S]*)$/);
    if (!m) continue;
    const body = m[2].replace(/\s+/g, ' ').trim();
    if (!body) continue;
    out.push({
      anchor: `pack-${m[1]}`,
      heading: body.length > 80 ? `${body.slice(0, 79)}…` : body,
      question: '',
      answer: body,
      origin: 'baseline',
    });
  }
  return out;
}

// rulesView — what the panel renders.
//
// `confirmed` never merges into `baseline`: they have different authority. A
// baseline rule is a default the platform applies; a confirmed rule is a person
// signing off on a decision about their domain, and a UI that blurs the two
// makes the sign-off worth less than it is.
export function rulesView({ rulesMd = '', packText = '', auditRan = false } = {}) {
  const parsed = parseRulesMd(rulesMd);
  const baseline = parseRulesPack(packText);
  return {
    confirmed: parsed.rules,
    baseline,
    intro: parsed.intro,
    malformed: parsed.malformed,
    counts: { confirmed: parsed.rules.length, baseline: baseline.length },
    // The empty case is the common one, and saying "no rules" would be wrong.
    emptyMessage: parsed.rules.length
      ? ''
      : auditRan
        ? 'No rules confirmed yet — the audit ran but every question was left unanswered. The baseline below still applies to every build.'
        : 'No rules confirmed yet. The baseline below applies to every build; a Full build additionally asks you to confirm the decisions it cannot infer, and your answers land here.',
  };
}

// rulesStageInfo — the stage indicator, told the truth.
//
// conceptStageInfo advances concept → build on design approval and never says
// 'define', so the indicator draws a step the project silently skips. Passing
// the rule count in (rather than reading a container from a pure function) lets
// the indicator distinguish "Define is next" from "Define has happened".
export function rulesStageInfo(base, { confirmedCount = null } = {}) {
  if (!base || confirmedCount === null) return base;
  const done = Number(confirmedCount) > 0;
  return {
    ...base,
    define_done: done,
    confirmed_rules: Number(confirmedCount) || 0,
    // Only ever a REFINEMENT of what the base said. If the base has not
    // unlocked build yet, Define is not the current step and saying so would
    // move the indicator backwards.
    current: base.current === 'build' && !done ? 'define' : base.current,
  };
}
