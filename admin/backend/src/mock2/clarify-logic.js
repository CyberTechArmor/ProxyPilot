// Mock2 REQUEST CLARIFIER — pure decision layer.
//
// WHY THIS EXISTS, with the numbers that justify it. Two notes apps were built
// from a byte-identical starting instruction. One got 24 follow-up builds and
// came out thoughtful; the other got 8 and came out empty-looking. The
// difference was entirely in what the operator asked for afterwards:
//
//   the good one   median instruction 174 chars, 12 of 24 builds about BEHAVIOUR
//   the other one  median instruction 865 chars,  1 of  8 builds about behaviour
//
// So the product's job is not to make people write MORE. It is to notice when a
// request has no checkable outcome, and offer one.
//
// THE DEFINITION OF VAGUE, AND WHY THE OBVIOUS ONE IS WRONG.
//
// Length is anti-correlated with quality in that data — the good project's
// vaguest-looking asks were its shortest. Two of its 24 builds were literally
// "Please fix" and "Please update", ten and thirteen characters, and BOTH
// succeeded: the build before them was "Please complete the biometric login",
// so the conversation carried the referent. A classifier that reads the
// instruction alone flags those and is wrong precisely on the project that is
// going well.
//
// The test used here is instead: COULD YOU TELL AFTERWARDS WHETHER IT WAS DONE?
// "Put the cursor back where the server last saw it" — checkable. "Fix any css
// issues" — not. And the pre-pass already computes exactly this as
// `brief.acceptance` ("concrete checks that would prove it works"), so the
// signal was already being produced and thrown away.
//
// WHAT THIS MUST NOT BECOME. A design interview shipped four days before this
// and was removed on the operator's report: "8 questions feels like too many at
// that time, there is no way to skip the rest, on mobile it feels like a lot to
// read and respond to." So: ONE card, never a conversation; options that are
// PRESSED, not questions that are answered; "Build it anyway" always
// first-class; and it fires at most once per request.
//
// PURE (stub-first, risk R9): prompts, detection and composition only.
// Terminology (risk R7): nothing here is named "agent".

export const CLARIFY_MODES = Object.freeze(['off', 'ask']);
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 3;
const MAX_PAGES = 3;
const CLIP = 600;

export function normalizeClarifyMode(v) {
  return CLARIFY_MODES.includes(v) ? v : 'ask';
}

/* -------------------------------------------------------------------------- *
 * The deterministic pre-filter.
 *
 * Everything below runs BEFORE any model output is trusted, and it exists to
 * keep the clarifier quiet. A helper that interrupts a request which was
 * already fine is worse than no helper: it costs a decision every time and
 * teaches the operator to ignore it.
 * -------------------------------------------------------------------------- */

// A request that names any of these is actionable whatever else it says.
const NAMES_PATH = /(?:^|[\s("'`])(\/[a-z][a-z0-9/_-]*)/i;
const NAMES_SELECTOR = /[#.][a-zA-Z][\w-]{2,}\b|\<[a-z]+\>|\bdata-[a-z-]+/;
const NAMES_MEASURE = /\b\d+\s*(?:px|rem|em|%|ms|s|pt|ch|vh|vw|columns?|rows?|items?|characters?|chars?)\b/i;
const NAMES_QUOTED = /["'“”][^"'“”]{3,}["'“”]/;
// An imperative naming a concrete UI noun. Deliberately a NOUN list rather than
// a verb list: "make it better" and "make it one row" share a verb.
const NAMES_ELEMENT = /\b(button|link|field|input|label|header|footer|nav|menu|modal|dialog|table|row|column|column|card|list|toggle|checkbox|dropdown|select|tab|badge|icon|avatar|tooltip|banner|sidebar|drawer|toast|form|search|filter|sort|pagination|breadcrumb|cursor|scrollbar|reminder|notification|to-?do|task|note)\b/i;

// The adjectives that are the whole problem: a judgement with no object.
const BARE_ADJECTIVE = /\b(better|nicer|nice|prettier|cleaner|clean|modern|professional|polished?|polish|slick|fancy|cutting[- ]edge|beautiful|ugly|bad|off|wrong|weird|meh)\b/i;
const VAGUE_VERB = /\b(fix|improve|update|clean up|tidy|sort out|sort it|redo|revamp|refresh|tweak|adjust|look at|check|review|doublecheck|double[- ]check)\b/i;

// A CONTINUATION is not a vague request — it is the second half of a sentence
// the previous turn started. "Please fix" after "the biometric login is broken"
// means something exact, and challenging it is the fastest way to make this
// feature annoying.
const CONTINUATION_MAX_CHARS = 60;
// Words that carry NO content of their own and exist only to point at the
// previous turn. "again" is not a vague verb — it is not a verb at all — but it
// is the purest continuation there is.
const CONTINUATION_WORD = /\b(again|same|same thing|once more|retry|redo it|as before|still|keep going|carry on|continue)\b/i;

export function isContinuation(instruction, { previousUserMessage = '', previousFailed = false } = {}) {
  const q = String(instruction || '').trim();
  if (!q) return false;
  // Short AND bare: "Please fix", "Please update", "again", "same thing".
  const bare = q.length <= CONTINUATION_MAX_CHARS
    && (VAGUE_VERB.test(q) || CONTINUATION_WORD.test(q))
    && !NAMES_ELEMENT.test(q)
    && !NAMES_PATH.test(q);
  if (!bare) return false;
  // It only counts as a continuation if there is something to continue: a
  // previous request, or a build that just failed and is obviously the referent.
  return previousFailed || String(previousUserMessage || '').trim().length > 0;
}

// Does the request, on its own, name something a build could aim at?
export function namesSomethingConcrete(instruction) {
  const q = String(instruction || '');
  return NAMES_PATH.test(q) || NAMES_SELECTOR.test(q) || NAMES_MEASURE.test(q)
    || NAMES_QUOTED.test(q) || NAMES_ELEMENT.test(q);
}

// The pages a request refers to — the ONLY ones worth screenshotting.
//
// "yes, but only the pages being referred to": a look costs a browser run, and
// capturing six screens to answer a question about one is most of the cost of a
// full design review for none of the value.
//
// Deliberately narrow, same rule as the design-options page hint: a leading
// slash, a letter, no spaces. "1/2 width" and "and/or" do not qualify.
export function pagesFromRequest(instruction, extra = []) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const path = String(p || '').trim().replace(/[.,;:!?)]+$/, '');
    if (!/^\/[a-z]/i.test(path) || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const m of String(instruction || '').matchAll(/(?:^|[\s("'`])(\/[a-z][a-z0-9/_-]*)/gi)) add(m[1]);
  for (const p of Array.isArray(extra) ? extra : []) add(p);
  return out.slice(0, MAX_PAGES);
}

/* -------------------------------------------------------------------------- *
 * The verdict.
 * -------------------------------------------------------------------------- */

// shouldClarify — the whole decision, in one place.
//
// `prepass` is the existing cheap call's output; its `brief.acceptance` is the
// signal. A model that cannot write one concrete check for a request has told
// us the request has no checkable outcome, which is the definition being used.
//
// Returns { clarify: boolean, reason, pages } — reason is for the log, so a
// person can tell WHY they were or were not interrupted.
export function shouldClarify(instruction, {
  prepass = null, mode = 'ask', previousUserMessage = '', previousFailed = false, hasImages = false,
} = {}) {
  const q = String(instruction || '').trim();
  if (normalizeClarifyMode(mode) === 'off') return { clarify: false, reason: 'the project has the clarifier turned off', pages: [] };
  if (!q) return { clarify: false, reason: 'empty request', pages: [] };
  // An image IS specificity — the operator has shown, not told.
  if (hasImages) return { clarify: false, reason: 'the request carries an image', pages: [] };
  if (isContinuation(q, { previousUserMessage, previousFailed })) {
    return { clarify: false, reason: 'a continuation of the previous request', pages: [] };
  }

  const pages = pagesFromRequest(q, prepass?.pages);
  // The model's own verdict, when it gave one and it is confident.
  if (prepass?.specificity === 'clear') return { clarify: false, reason: 'the request names a checkable outcome', pages };

  const acceptance = prepass?.brief?.acceptance || [];
  const modelSaysVague = prepass?.specificity === 'vague';
  // No pre-pass at all (disabled, timed out, failed) → fall back to the
  // deterministic read rather than interrupting on no evidence. Fail-QUIET is
  // the right default here: the cost of a missed clarification is one ordinary
  // build; the cost of a false one is a decision the operator did not need.
  if (!prepass) {
    const bare = BARE_ADJECTIVE.test(q) && !namesSomethingConcrete(q);
    return bare
      ? { clarify: true, reason: 'a judgement with nothing named, and no pre-pass to check it against', pages }
      : { clarify: false, reason: 'no pre-pass ran', pages };
  }
  if (!modelSaysVague && acceptance.length) {
    return { clarify: false, reason: 'the pre-pass could write concrete acceptance checks', pages };
  }
  if (!modelSaysVague && !acceptance.length && namesSomethingConcrete(q)) {
    return { clarify: false, reason: 'no acceptance checks, but the request names something concrete', pages };
  }
  return {
    clarify: true,
    reason: modelSaysVague
      ? 'the pre-pass read the request as having no checkable outcome'
      : 'the pre-pass could not write a single concrete acceptance check',
    pages,
  };
}

/* -------------------------------------------------------------------------- *
 * The prompt.
 * -------------------------------------------------------------------------- */

// buildClarifyPrompt — the second, EXPERT pass.
//
// Two lenses in one call, because they inform each other: the craft lens knows
// what usually causes what the operator is seeing, and the domain lens knows
// what this kind of app is supposed to do about it.
export function buildClarifyPrompt() {
  return `A person asked a web-app build system for a change, and the request has no
checkable outcome — nobody could tell afterwards whether it was done. They are
almost certainly right that something is wrong. Your job is to turn their report
into two or three requests they could PRESS, not to interview them.

You are two experts at once.

FRONT-END CRAFT. You know what usually causes what they are describing:
- "too much space above X" is almost never X's margin — it is something above it
  wrapping onto a second row, a fixed min-height, or a collapsed margin.
- "looks unfinished / not designed" is usually default browser chrome: native
  <select> boxes, unstyled focus rings, inconsistent radii, no empty state.
- "looks cramped" at one width and not another is a breakpoint, not a padding.
- "hard to read" is contrast or measure, and both are numbers.
- Anything about a table on a phone is a table that should be cards.

DOMAIN. You know what an app of this kind is expected to do. A notes app
distinguishes pinned from unpinned and shows how long ago; a reminder can be
snoozed and silenced; a list has an empty state that says what to do next.

RULES FOR THE OPTIONS:
- Each option is a COMPLETE instruction the build could run with no further
  questions: imperative, naming elements and numbers, no adjectives. It is what
  they will press a button to send.
- Order them smallest change first. They should be able to pick the cheap one.
- They must differ in KIND, not degree. "Tighter", "much tighter" and "very
  tight" is one option pretending to be three.
- Say what each one would let them CHECK afterwards — that is the thing their
  original request was missing.
- If you genuinely cannot tell what they mean, make the first option the
  smallest safe reading and say so in the diagnosis. Never invent a feature.
- Never propose editing platform-owned files. An override in the app's own
  stylesheet is allowed.

Reply with STRICT JSON only — no prose, no markdown fences:

{
  "diagnosis": "one sentence, in their language, on what cannot be checked yet",
  "question": "the single most useful thing you would ask them, in one short line",
  "options": [
    {
      "label": "Short name for the button",
      "instruction": "the full imperative request to run",
      "checkable": "what they would look at afterwards to know it worked"
    }
  ]
}`;
}

export function buildClarifyTask({
  instruction = '', appName = 'the app', pages = [], shots = [], prepass = null,
} = {}) {
  const parts = [`App: ${appName}`, `What they asked for:\n"${String(instruction).slice(0, 1200)}"`];
  if (pages.length) parts.push(`Screens they referred to: ${pages.join(', ')}.`);
  if (shots.length) {
    parts.push(`Screenshots of those screens are attached, in order: ${shots.map((s) => `${s.path}@${s.width}px`).join(', ')}. Read them — the picture is why the request could not be written precisely.`);
  } else if (pages.length) {
    parts.push('The screens could not be screenshotted, so reason from the request alone and say so if it limits you.');
  }
  const dom = prepass?.brief?.domain_expectations || [];
  if (dom.length) parts.push(`A domain read of the request already surfaced: ${dom.join('; ')}.`);
  parts.push('Give the diagnosis, the one question, and two or three pressable options as the JSON object described.');
  return parts.join('\n\n');
}

/* -------------------------------------------------------------------------- *
 * Parsing and composition.
 * -------------------------------------------------------------------------- */

const clip = (v, n = CLIP) => String(v ?? '').trim().slice(0, n);

export function parseClarifyReply(text) {
  let s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let doc;
  try { doc = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;

  const seen = new Set();
  const options = (Array.isArray(doc.options) ? doc.options : [])
    .map((o) => ({
      label: clip(o?.label, 60),
      instruction: clip(o?.instruction, 2000),
      checkable: clip(o?.checkable, 200),
    }))
    // An option with no instruction is the one thing this cannot ship: the
    // instruction IS the button.
    .filter((o) => o.label && o.instruction)
    .filter((o) => {
      const k = o.instruction.toLowerCase().slice(0, 120);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_OPTIONS);
  if (options.length < MIN_OPTIONS) return null;
  return { diagnosis: clip(doc.diagnosis, 400), question: clip(doc.question, 200), options };
}

// composeWithGuesses — the "Build it anyway" path.
//
// The operator has decided; the build runs. But the clarifier's reading is
// free information and throwing it away helps nobody, so it rides along
// LABELLED AS A GUESS and explicitly subordinate — same contract as the working
// brief. A guess presented as scope would be the clarifier quietly overruling
// the person who just overruled it.
export function composeWithGuesses(instruction, clarify) {
  const base = String(instruction || '');
  const opts = clarify?.options || [];
  if (!opts.length) return base;
  const lines = opts.map((o) => `- ${o.label}: ${o.instruction}`);
  return `${base}\n\nThe request above is authoritative and was sent as written. `
    + 'These are GUESSES at what it might mean, offered to the operator and not chosen by them — '
    + 'use them only where they agree with the request, and ignore any that do not:\n'
    + `${lines.join('\n')}`;
}

// The chat note posted when the card is shown, so the conversation records that
// a build did NOT start and why.
export function clarifyChatNote(parsed, { pages = [] } = {}) {
  const where = pages.length ? ` on \`${pages.join('`, `')}\`` : '';
  const lines = [`I did not start a build${where} — that request has no outcome anyone could check afterwards.`];
  if (parsed?.diagnosis) lines.push('', parsed.diagnosis);
  if (parsed?.question) lines.push('', `**${parsed.question}**`);
  lines.push('', 'Pick one of the options above, or press **Build it anyway** to send it exactly as you wrote it.');
  return lines.join('\n');
}
