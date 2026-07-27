// Mock2 DESIGN HELP — the interview that turns "make it look professional"
// into a brief a build can execute. Pure layer.
//
// WHY THIS EXISTS. Asked for a better-looking app, an operator writes "make it
// more professional" or "make it fancy", and that is the worst possible
// instruction: it names an adjective, so a build reaches for the things that
// signal effort — gradients, shadows, an accent colour on everything — and the
// result is a screen that is harder to read than the one before it.
//
// The screens that DO look professional are not styled differently. They were
// decided differently: someone knew what single question the screen answers,
// what the hardest real row looks like, which numbers are worth tapping, how
// much has to be visible before scrolling, and what a status says besides being
// red. None of that is a style preference — it is eight answers the operator
// already has and was never asked for.
//
// So this is an interview, not a style guide. One question at a time, every one
// skippable, and it ends by writing the brief itself: a concrete, imperative
// instruction naming behaviour rather than adjectives, ready to send as a Quick
// update.
//
// It rides the ASK lane rather than being a fourth build-shaped button, for the
// same reason the Polish pass did: it is a conversation that produces an
// instruction, and Ask is where conversations happen.
//
// PURE (stub-first, risk R9): prompts and text only — no I/O, no native
// modules. Terminology (risk R7): nothing here is named "agent".

// The marker every interview turn ends with. This is how the NEXT ask knows it
// is answering question 4 rather than starting a fresh engineering question —
// the ask lane is stateless between turns and the chat is the only memory, so
// the state has to be visible in the chat.
export const DESIGN_HELP_MARKER_RE = /\[design-help\s+(\d{1,2})\/(\d{1,2})\]/i;

export function designHelpMarker(step, total) {
  return `[design-help ${step}/${total}]`;
}

// The interview. Each question is one line to answer, carries WHY it is being
// asked (an operator who does not know why will answer the letter of it), and
// an example in the shape of a real answer rather than a description of one.
//
// Ordered deliberately: purpose before data before interaction before density.
// Answering "how many rows fit" before "what is this screen for" produces a
// dense screen that answers nothing.
export const DESIGN_HELP_QUESTIONS = Object.freeze([
  {
    id: 'purpose',
    ask: 'What single question does this screen answer, who opens it, and what has just happened to make them open it?',
    why: 'A screen with one job can have a hierarchy. A screen with four has none — which is what "it looks generic" usually means.',
    example: '"Where is coverage at risk today" — a shift supervisor, first thing, after someone called in sick.',
  },
  {
    id: 'hard-row',
    ask: 'Which REAL record breaks the happy path — the one with a missing field, a 60-character name, a span across midnight, a number that should be zero?',
    why: 'Designs get thoughtful when they have to survive real data. A layout built on tidy sample rows falls apart on the first real one, and that is the version people see.',
    example: 'A per-diem nurse with no assigned unit, working 22:00–06:30 across two dates.',
  },
  {
    id: 'actionable',
    ask: 'Which numbers on this screen should be tappable, and what should tapping one show?',
    why: 'A number you cannot act on is decoration. The difference between a dashboard and a poster is that tapping "4 uncovered" shows you those 4.',
    example: 'Tapping "4 uncovered shifts" filters the list to those four. Tapping a unit name scopes everything to it.',
  },
  {
    id: 'density',
    ask: 'How many rows should be visible without scrolling — on a laptop, and on a phone?',
    why: 'This is the single biggest tell. Generated screens arrive airy: three cards, a lot of padding, and a scroll for everything that matters. A number here is a decision; "clean" is not.',
    example: '12 shifts on a laptop, 5 on a phone, with the day header staying put as you scroll.',
  },
  {
    id: 'status',
    ask: 'What states can a row be in, and for each — what is the WORD, and what is the glyph?',
    why: 'Colour is the third channel, never the only one. A red dot is invisible to a colourblind reader, illegible in a screenshot, and unsearchable. Word + glyph + colour is also just faster to read.',
    example: 'Covered ✓ green · At risk ! amber · Uncovered ✕ red · Not scheduled — grey.',
  },
  {
    id: 'bespoke',
    ask: 'If ONE thing on this screen were purpose-built rather than a generic card, table or chart, what would it be?',
    why: 'Every app in a category has cards and a table. What makes a screen look designed is the one element built for the thing this app is actually about.',
    example: 'A per-shift coverage strip: one segment per hour, colour-coded, so a whole day reads in one glance.',
  },
  {
    id: 'states',
    ask: 'What should this screen say when it is empty, still loading, has failed, and has exactly one item?',
    why: 'Amateur interfaces ship one state — the full one. The other four are where people actually meet a new app.',
    example: 'Empty: "No shifts today. Add one." Loading: skeleton rows, not a spinner. Error: what failed and a Retry. One item: the row, no header.',
  },
  {
    id: 'motion',
    ask: 'What should acknowledge a tap, and what should arrive rather than simply appear?',
    why: 'The design system ships .press, .enter, .stagger and .pulse-once on approved timings. Motion someone chose reads as considered; motion nobody chose reads as a template. Answer "nothing" if the screen should be still.',
    example: 'Buttons press. Rows stagger in when a filter changes. The count pulses once when it updates.',
  },
]);

export const DESIGN_HELP_TOTAL = DESIGN_HELP_QUESTIONS.length;

// ---- intent ----
//
// Narrow, like detectPolishIntent and for the same reason: "how does the design
// system work" is a real engineering question for the tool loop, and hijacking
// it into an interview would be worse than not having the interview.
const HELP_PHRASE = /\b(design help|help me design|design interview|walk me through the design|design questions)\b/i;
const HELP_VERB = /\b(help|walk|guide|coach|take)\b/i;
const HELP_OBJECT = /\b(design|ux|ui|screen|layout|look)\b/i;
const HELP_THROUGH = /\b(through|me through|step by step|question by question)\b/i;

export function detectDesignHelpIntent(question) {
  const q = String(question || '').trim();
  if (!q) return null;
  // A long brief is an instruction, not a request to be interviewed.
  if (q.length > 400) return null;
  if (HELP_PHRASE.test(q)) return { intent: 'design-help' };
  if (HELP_VERB.test(q) && HELP_OBJECT.test(q) && HELP_THROUGH.test(q)) return { intent: 'design-help' };
  return null;
}

// ---- continuation ----
//
// The ask lane is stateless between turns; the chat is the memory. An interview
// turn ends with its marker, so the next ask can see it is an ANSWER rather
// than a new question. Without this the second turn would go to the ordinary
// Ask prompt, which would read "12 on a laptop, 5 on a phone" as a question
// about the codebase and answer it as one.
//
// The NEWEST thing the platform said decides. User messages are skipped rather
// than treated as a boundary, so this gives the same answer whether the caller
// reads the chat before or after inserting the operator's new message — a
// difference between two runners is not something an interview should hinge on.
export function designHelpProgress(messages = []) {
  const rows = (Array.isArray(messages) ? messages : []).filter((m) => m && String(m.body || '').trim());
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    if (m.kind !== 'assistant' && m.kind !== 'system') continue;
    const hit = DESIGN_HELP_MARKER_RE.exec(String(m.body));
    // An interview turn carries the marker. Anything else the platform said
    // last — an ordinary Ask answer, a build notice — means the operator has
    // left the interview, and dragging them back into it would be worse than
    // making them re-open it.
    if (!hit) return null;
    const step = Number(hit[1]);
    const total = Number(hit[2]) || DESIGN_HELP_TOTAL;
    if (!Number.isInteger(step) || step < 1) return null;
    return { step, total, done: step >= total };
  }
  return null;
}

// isDesignHelpContinuation — is this ask an ANSWER to an interview question?
//
// True for the last question too: answering question 8 is what produces the
// brief, and treating "done" as "not a continuation" would drop the operator
// out of the interview one turn before the thing they came for.
export function isDesignHelpContinuation(messages = []) {
  return !!designHelpProgress(messages);
}

// ---- the prompts ----

// `writeBrief` is the LAST turn: the interview is over and this message is the
// deliverable. It is a separate flag rather than "step === TOTAL" because those
// are different turns — on step TOTAL you are still asking question 8, and the
// turn after it is the one that writes the brief. Conflating them produced a
// prompt that told the model to do both.
export function buildDesignHelpSystemPrompt({ projectName = 'this app', step = 1, writeBrief = false } = {}) {
  if (writeBrief) return briefPrompt(projectName);
  const n = Math.min(Math.max(1, Number(step) || 1), DESIGN_HELP_TOTAL);
  const q = DESIGN_HELP_QUESTIONS[n - 1];
  const list = DESIGN_HELP_QUESTIONS.map((x, i) => `${i + 1}. ${x.ask}`).join('\n');
  return `You are running a short design interview for "${projectName}" — a ProxyPilot project whose
app is already built and running. You are NOT writing code, NOT reading the
codebase, and NOT redesigning anything yourself. You are asking the operator the
questions that turn "make it look professional" into something a build can
actually execute.

Why this exists: "professional" and "fancy" are adjectives, and a build handed
an adjective reaches for gradients and shadows. The screens that read as
designed were DECIDED differently — someone knew the screen's one job, the
hardest real row, which numbers are worth tapping, how much must be visible, and
what a status says besides being red. The operator has those answers. Nobody
ever asked them.

THE FULL INTERVIEW (${DESIGN_HELP_TOTAL} questions, in this order):
${list}

YOU ARE ON QUESTION ${n} of ${DESIGN_HELP_TOTAL}:
  ASK:     ${q.ask}
  WHY:     ${q.why}
  EXAMPLE: ${q.example}

HOW TO RUN YOUR TURN — this is binding:
- Ask exactly ONE question: question ${n}. Never batch two, never skip ahead.
- Open with at most one short sentence reacting to what they just said. If their
  answer was vague, say what you took it to mean in one line and move on — do
  not interrogate. Their time is the budget here.
- State the question, then the WHY in one line, then the EXAMPLE labelled as an
  example. The example is there so they answer in the right SHAPE; never present
  it as what their app should do.
- "Skip", "you decide", "I don't know" and silence are complete answers. Say
  what you will assume in one line, and go to the next question.
- Do not lecture, do not explain design theory, do not list principles. One
  question, one reason, one example.
- Write for someone who knows their domain and not this vocabulary. No "visual
  hierarchy", no "affordance", no "information architecture".
- End your message with exactly: ${designHelpMarker(n, DESIGN_HELP_TOTAL)}
  That marker is how the next turn knows where the interview is. Without it the
  interview ends and the operator has to start again.
${n >= DESIGN_HELP_TOTAL ? '\nThis is the LAST question. After they answer it the interview is over and the next message is the brief — so make this one count, and do not pre-empt it by summarising.' : ''}`;
}

// The deliverable. The whole interview exists to produce this message, so the
// rules are about what makes an instruction executable rather than admirable:
// imperative, traceable to something the operator said, and checkable by
// looking at the screen afterwards.
function briefPrompt(projectName) {
  return `The design interview for "${projectName}" is complete. This message is the brief —
the thing the whole interview existed to produce. Write it and nothing else.

Structure:

  One line: what this screen is for, in THEIR words.

  Then a numbered list of concrete, imperative changes — what to build, not what
  to aim for. Every item traceable to something they told you. Carry their
  numbers through verbatim (rows visible at each width, the state words and
  glyphs, which numbers are tappable and what tapping shows). Name the design
  system's own classes where motion applies (.press, .enter, .stagger,
  .pulse-once) rather than describing movement in prose.

  Where they skipped a question, state the assumption you are making as its own
  item, so a skipped answer is a visible decision rather than a silent one.

Binding:
- The words "polish", "modern", "clean", "professional", "sleek", "beautiful"
  and "visual hierarchy" must not appear. They are what the operator came here
  to stop having to say.
- If an item cannot be verified by looking at the screen afterwards, cut it.
- Do not add ideas of your own that nothing in the interview supports. The value
  of this brief is that it is THEIRS.
- No marker on this message — the interview is over.

End with exactly one line: "Send this as a Quick update, or edit it first."`;
}

// The OPENING message, written deterministically rather than generated.
//
// The first turn has nothing to react to, and paying a model call to produce a
// fixed greeting is the sort of thing that makes a feature feel slow for no
// reason. It also guarantees the marker is present on turn one, so the
// continuation can never fail to start.
export function designHelpOpening({ projectName = 'this app' } = {}) {
  const q = DESIGN_HELP_QUESTIONS[0];
  return `**Design help** — ${DESIGN_HELP_TOTAL} questions about ${projectName}, one at a time. They are the ones that turn "make it look professional" into something a build can actually do: an adjective gets you gradients, an answer gets you a screen that works.

Answer in a sentence. "Skip" or "you decide" is fine for any of them — I will say what I am assuming and move on. When we are done I will write the brief, and you can send it as a Quick update.

**1 of ${DESIGN_HELP_TOTAL}. ${q.ask}**

*Why:* ${q.why}
*For example:* ${q.example}

${designHelpMarker(1, DESIGN_HELP_TOTAL)}`;
}

// The user turn for a continuation: their answer, plus which question it
// answers, because the system prompt is rebuilt per turn and the transcript is
// a recap rather than the true conversation.
export function buildDesignHelpTask(answer, { step = 1 } = {}) {
  const n = Math.min(Math.max(1, Number(step) || 1), DESIGN_HELP_TOTAL);
  const prev = DESIGN_HELP_QUESTIONS[n - 1];
  const body = String(answer || '').trim() || '(no answer — treat this as "you decide")';
  const next = n + 1;
  return next > DESIGN_HELP_TOTAL
    ? `Their answer to question ${n} ("${prev.ask}"):\n\n${body}\n\nThat was the last question. Write the brief now, exactly as instructed.`
    : `Their answer to question ${n} ("${prev.ask}"):\n\n${body}\n\nNow ask question ${next}.`;
}

// designHelpTurn(progress) → what this turn is.
//
// Answering question N means this turn asks N+1. Answering the LAST question
// means this turn writes the brief instead — which is a different prompt, not a
// clamped step number.
export function designHelpTurn(progress) {
  const step = Number(progress?.step) || 0;
  if (step >= DESIGN_HELP_TOTAL) return { writeBrief: true, step: DESIGN_HELP_TOTAL };
  return { writeBrief: false, step: Math.max(1, step + 1) };
}
