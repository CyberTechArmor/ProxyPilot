// Mock2 DESIGN OPTIONS — 2–3 layouts to choose from, not a guess to build.
//
// WHY THIS EXISTS. "It doesn't look right" is a REPORT, not an instruction, and
// the operator is usually right about the report and unqualified to write the
// instruction. The product used to make them write it anyway: they typed a
// sentence, a build spent real money interpreting it, and they looked at the
// result to find out what they had actually asked for.
//
// Project 44 is the whole argument. Three builds, two annotation rounds and one
// plain-English retry all chasing "there is so much unused space above the text
// field". Each build satisfied the words and missed the point — one of them by
// giving the reclaimed space to an empty textarea, which looks exactly like the
// wasted space that was being complained about. Nobody was wrong; nobody had
// said what the fix WAS, because nobody knew.
//
// So: a complaint stops producing a build. It produces a diagnosis and two or
// three named layouts, each with what changes and what it costs, posted as
// ordinary chat messages — which means each one already carries the "Build this
// as a Quick update" chip, and the operator picks by pressing the one they
// want. One cheap read replaces three expensive guesses.
//
// THREE PROPERTIES MAKE IT WORK, and each is enforced below rather than hoped
// for:
//
//   1. It SEES the screen. Screenshots at both widths, the density
//      measurements, and the approved design. A model reasoning from the
//      sentence alone produces the same generic advice the operator could have
//      written themselves.
//   2. The options differ in KIND, not degree. "Tighter", "much tighter" and
//      "very tight" is one option pretending to be three. Each option declares
//      a distinct STRATEGY and the parser drops duplicates.
//   3. NOTHING is applied. The whole value is finding out what the fix looks
//      like before paying for it.
//
// PURE (stub-first, risk R9): prompts and parsing only — no I/O, no browser.
// Terminology (risk R7): nothing here is named "agent".

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 3;

// The strategies an option may take. Named rather than free-form because this
// is the list that stops three gradations of "tighter" being presented as a
// choice — two options with the same strategy are the same option.
export const OPTION_STRATEGIES = Object.freeze([
  // Same elements, less room: padding, gaps, wrapping, type scale.
  'compact',
  // Same elements, different place: into a menu, a bottom bar, a second line,
  // an overflow, another screen.
  'relocate',
  // Fewer elements doing more: merge bands, fold a control into a row, make a
  // thing that was decoration into the thing itself.
  'restructure',
  // Change what the screen is FOR — the biggest move, and sometimes the right
  // one: put the content first and let the chrome earn its place back.
  'reframe',
]);

const MAX_STR = 600;
const clip = (v, n = MAX_STR) => String(v ?? '').trim().slice(0, n);

// ---- intent ----
//
// A COMPLAINT, not an instruction. The line between them is whether the
// operator has said what to do: "make the header one row" is an instruction and
// belongs in a build; "the header looks bad" is a report and belongs here.
//
// Deliberately narrow in the same way the polish intent is: this takes over the
// ask lane, and taking over a real question would be worse than not existing.
const FEELING = /\b(look|looks|looking|feel|feels|seem|seems)\s+(bad|wrong|off|odd|cramped|empty|cluttered|messy|dated|cheap|unfinished|amateur)\b/i;
const NOT_RIGHT = /\b(does ?n[o']?t|doesn't|not)\s+(look|feel|seem)\s+(right|good|great|professional|designed)\b/i;
const NOT_DESIGNED = /\b(not designed well|badly designed|poorly designed|looks unfinished|needs design)\b/i;
const WASTED = /\b(wasted|unused|too much|so much|dead)\s+(space|room|whitespace|padding)\b/i;
const ASK_OPTIONS = /\b(design options?|show me options?|what would look better|how should this look|suggest a layout|layout options?)\b/i;
// An explicit instruction verb means they HAVE decided — do not interview them.
const INSTRUCTED = /\b(make it|change it to|move the|set the|use a|replace the|add a|remove the)\b/i;

// WHICH SCREEN. Options for the home page when the operator was looking at
// /notes are options for a screen nobody complained about — and the capture is
// the expensive half, so guessing wrong costs a browser run as well as a model
// call. A route named in the complaint wins; otherwise the caller's default.
//
// Deliberately narrow: a leading slash, a letter, and no spaces. "1/2 width",
// "and/or" and a bare "/" do not qualify.
const PAGE_HINT = /(?:^|[\s("'`])(\/[a-z][a-z0-9/_-]*)/i;

export function pageFromComplaint(question, fallback = '/') {
  const m = PAGE_HINT.exec(String(question || ''));
  if (!m) return fallback;
  // Trailing punctuation belongs to the sentence, not the route.
  const path = m[1].replace(/[.,;:!?)]+$/, '');
  return path.length > 1 ? path : fallback;
}

export function detectDesignOptionsIntent(question) {
  const q = String(question || '').trim();
  if (!q || q.length > 600) return null;
  const hit = { intent: 'design-options', page: pageFromComplaint(q) };
  if (ASK_OPTIONS.test(q)) return hit;
  if (INSTRUCTED.test(q)) return null;
  if (FEELING.test(q) || NOT_RIGHT.test(q) || NOT_DESIGNED.test(q) || WASTED.test(q)) return hit;
  return null;
}

// ---- the prompt ----

export function buildDesignOptionsPrompt() {
  return `You are a senior product designer looking at a screen someone has just told you
does not feel right. They are almost certainly correct about the feeling and
almost certainly unable to name the fix — that is your job, and it is the only
job you have here. You are NOT writing code and NOT changing anything.

Return TWO or THREE options. Each must be a layout somebody could choose between,
not a dial somebody could turn: "tighter", "much tighter" and "very tight" is one
option pretending to be three. Every option declares a distinct strategy:

  compact     — the same elements, given less room (padding, gaps, wrapping, type)
  relocate    — the same elements, somewhere else (a menu, a bottom bar, an
                overflow, a second line, another screen)
  restructure — fewer elements doing more (merge bands, fold a control into a
                row, promote something that was decoration)
  reframe     — change what the screen is FOR: content first, chrome earns its
                place back

WHAT YOU ARE GIVEN: screenshots of the running app at phone and laptop width,
deterministic measurements taken from the live DOM, the approved design's tokens
and component classes, and the operator's own words. Read the SCREENSHOTS — the
measurements tell you how much is on the screen, the picture tells you why it
reads badly.

HOW TO DIAGNOSE, before you propose anything:
- Name what is actually wrong in one sentence, in their language, not in design
  vocabulary. "Five stacked bands take 45% of the screen before the first line of
  the note" — not "the visual hierarchy is unclear".
- Count. Bands, rows, taps, pixels, items visible before scrolling. A diagnosis
  with a number in it can be checked; one without it is an opinion.
- Say what the screen is FOR, and whether its layout agrees.

RULES FOR THE OPTIONS:
- Order them smallest change first. The operator should be able to pick the
  cheap one and stop.
- Reclaimed space must go somewhere that MATTERS. Giving it to an empty box is
  the same defect with a different name — say so if that is what a tempting
  option would do.
- Each option's brief must be executable by a build with no further questions:
  imperative, naming elements and numbers, no adjectives. It is what the
  operator will press a button to run.
- Use the app's own design system where it applies — its component classes and
  its motion classes (.press, .enter, .stagger, .pulse-once). Do not invent a
  palette.
- Never propose editing platform-owned files. An override in the app's own
  stylesheet is allowed and is often the right answer for shell spacing.
- If one option is clearly right, say which and why in one sentence. Do not
  pretend three options are equal when they are not.

Reply with STRICT JSON only — no prose, no markdown fences:

{
  "diagnosis": "one or two sentences, with a number in them",
  "recommended": "the name of the option you would pick, or an empty string",
  "options": [
    {
      "name": "Collapse the chrome",
      "strategy": "compact",
      "rationale": "one sentence on what this trades away",
      "changes": ["one concrete change", "another"],
      "gain": "what it buys, measured — '~70px back', 'three more rows visible'",
      "brief": "the imperative instruction a build would run, self-contained"
    }
  ]
}`;
}

// The human-readable target: 'all screens', a single route, or a joined list.
// One place, so the started message, the job line, and the diagnosis header
// cannot disagree about what was looked at.
export function screensLabel(pages = [], allScreens = false) {
  if (allScreens) return 'all screens';
  const list = (Array.isArray(pages) ? pages : []).filter(Boolean);
  if (!list.length) return '/';
  return list.join(', ');
}

export function buildDesignOptionsTask({
  projectName = 'the app', complaint = '', page = '/', measurements = '', designNote = '', shots = [],
  multi = false, attachedCount = 0,
} = {}) {
  const parts = [`Project: ${projectName}`, `Screen${multi ? 's' : ''}: ${page}`];
  parts.push(`What the operator said:\n"${clip(complaint, 1200)}"`);
  if (shots.length) parts.push(`Screenshots attached, in order: ${shots.map((s) => `${s.path}@${s.width}px`).join(', ')}.`);
  if (multi) {
    parts.push('Several screens are attached. Options may target different screens — start each option\'s '
      + 'name with the screen it applies to (e.g. "/admin — Collapse the chrome") and make each brief name '
      + 'its screen explicitly, so the operator knows what they are pressing Build on.');
  }
  if (attachedCount > 0) {
    parts.push(`The operator also attached ${attachedCount} image(s) of their own (shown last) — e.g. an annotated `
      + 'screenshot with numbered red pins. Treat each pin as a pointer to a place that feels wrong; the pin '
      + 'notes are in their words above.');
  }
  if (measurements) parts.push(measurements);
  if (designNote) parts.push(designNote);
  parts.push('Diagnose it, then give two or three options as the JSON object described. Nothing will be changed until the operator picks one.');
  return parts.join('\n\n');
}

// ---- parsing ----

// Tolerant of fences and prose, strict about the shape. An option missing its
// brief is dropped rather than repaired: the brief is the thing the operator
// presses a button to run, and a half-written one is worse than one fewer
// option.
export function parseDesignOptions(text) {
  let s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let doc;
  try { doc = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;

  const seenStrategy = new Set();
  const options = (Array.isArray(doc.options) ? doc.options : [])
    .map((o) => ({
      name: clip(o?.name, 80),
      strategy: OPTION_STRATEGIES.includes(o?.strategy) ? o.strategy : '',
      rationale: clip(o?.rationale),
      changes: (Array.isArray(o?.changes) ? o.changes : []).map((c) => clip(c, 300)).filter(Boolean).slice(0, 8),
      gain: clip(o?.gain, 160),
      brief: clip(o?.brief, 2000),
    }))
    .filter((o) => o.name && o.brief)
    // Two options with the same strategy are the same option with different
    // wording — the failure this whole feature exists to avoid.
    .filter((o) => {
      if (!o.strategy) return true;
      if (seenStrategy.has(o.strategy)) return false;
      seenStrategy.add(o.strategy);
      return true;
    })
    .slice(0, MAX_OPTIONS);

  if (options.length < MIN_OPTIONS) return null;
  return {
    diagnosis: clip(doc.diagnosis, 800),
    recommended: clip(doc.recommended, 80),
    options,
  };
}

// ---- the chat messages ----

// The lead-in: what is actually wrong, and how to use what follows.
export function diagnosisMessage(parsed, { page = '/' } = {}) {
  const n = parsed?.options?.length || 0;
  const lines = [`**Design options for \`${page}\`** — ${n} way${n === 1 ? '' : 's'} to fix this. Nothing has changed yet.`];
  if (parsed?.diagnosis) lines.push('', parsed.diagnosis);
  if (parsed?.recommended) lines.push('', `I would pick **${parsed.recommended}**.`);
  lines.push('', 'Each option is its own message below — press **Build this as a Quick update** on the one you want.');
  return lines.join('\n');
}

// ONE MESSAGE PER OPTION, on purpose.
//
// An assistant message with no cycle_id already carries the "Build this as a
// Quick update" chip, so posting each option separately gives every one of them
// its own working button with no new UI at all. The brief is the message body's
// last section, which is what the distiller reads.
export function optionMessage(option, index, total) {
  const lines = [`**Option ${index + 1} of ${total} · ${option.name}**${option.strategy ? ` _(${option.strategy})_` : ''}`];
  if (option.rationale) lines.push('', option.rationale);
  if (option.changes.length) {
    lines.push('', 'What changes:');
    for (const c of option.changes) lines.push(`- ${c}`);
  }
  if (option.gain) lines.push('', `**Gain:** ${option.gain}`);
  lines.push('', '---', '', option.brief);
  return lines.join('\n');
}

// What is said when the model could not produce a usable set. Honest about
// which half failed, because "try again" and "say more" are different actions.
export function optionsFailureMessage(reason) {
  if (reason === 'unparseable') {
    return 'Design options could not be read back from the model — nothing was changed. Ask again, or describe the problem in a sentence and send it as a Quick update.';
  }
  if (reason === 'no-shots') {
    return 'Design options need to SEE the screen and the app could not be screenshotted — nothing was changed. Check the project is online and serving, then ask again.';
  }
  return `Design options could not run: ${reason || 'unknown error'}. Nothing was changed.`;
}

// The line posted as soon as the request is accepted, so a two-minute capture
// does not look like nothing happening. `page` may be a single route, a joined
// list, or 'all screens' (screensLabel).
export function optionsStartedMessage(page) {
  return `Looking at \`${page}\` at phone and laptop width, then working out two or three ways to fix it. Nothing will change until you pick one.`;
}
