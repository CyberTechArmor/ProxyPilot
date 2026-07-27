// DESIGN HELP — the interview that turns "make it look professional" into a
// brief a build can execute.
//
// "Professional" and "fancy" are adjectives, and a build handed an adjective
// reaches for gradients and shadows. The screens that read as designed were
// DECIDED differently — someone knew the screen's one job, the hardest real
// row, which numbers are worth tapping, how much must be visible, and what a
// status says besides being red. The operator has those answers; nobody asked.
//
// The hard part is not the questions, it is that the ask lane is STATELESS
// between turns: the chat is the only memory, so the interview's position has
// to be visible in it. Most of what is asserted here is about that.
//
// Native-free (risk R9): the interview is pure; the ask wiring is asserted by
// reading the source, the way the other lane checks do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DESIGN_HELP_QUESTIONS, DESIGN_HELP_TOTAL, DESIGN_HELP_MARKER_RE, designHelpMarker,
  detectDesignHelpIntent, designHelpProgress, isDesignHelpContinuation, designHelpTurn,
  buildDesignHelpSystemPrompt, buildDesignHelpTask, designHelpOpening,
} from '../mock2/design-help-logic.js';
import {
  detectPolishIntent, buildAskContextBlock,
  DESIGN_HELP_CONTEXT_MAX_MESSAGES, DESIGN_HELP_CONTEXT_MAX_CHARS,
} from '../mock2/ask-logic.js';

const asst = (body) => ({ kind: 'assistant', body });
const usr = (body) => ({ kind: 'user', body });

test('the interview asks for decisions, never for adjectives', () => {
  // The whole point: an operator who says "make it professional" gets
  // gradients. Every question here has an answer only they can give, and none
  // of them is a style preference.
  assert.equal(DESIGN_HELP_QUESTIONS.length, DESIGN_HELP_TOTAL);
  assert.ok(DESIGN_HELP_TOTAL >= 6 && DESIGN_HELP_TOTAL <= 10, 'short enough to finish in one sitting');
  const ids = DESIGN_HELP_QUESTIONS.map((q) => q.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'ids are unique');
  // The properties that actually separate a considered screen from a generated
  // one — each is a question, not a principle.
  for (const id of ['purpose', 'hard-row', 'actionable', 'density', 'status', 'bespoke', 'states', 'motion']) {
    assert.ok(ids.includes(id), `the interview must cover ${id}`);
  }
  // Purpose first: answering "how many rows fit" before "what is this for"
  // produces a dense screen that answers nothing.
  assert.equal(ids[0], 'purpose');
  for (const q of DESIGN_HELP_QUESTIONS) {
    assert.ok(q.ask.trim().endsWith('?'), `${q.id} must be a question`);
    assert.ok(q.why.length > 40, `${q.id} must say WHY it is asked — an operator who does not know will answer the letter of it`);
    assert.ok(q.example.length > 20, `${q.id} must show the SHAPE of an answer`);
  }
  // The vocabulary this exists to avoid must not appear in the questions.
  const all = JSON.stringify(DESIGN_HELP_QUESTIONS).toLowerCase();
  for (const word of ['visual hierarchy', 'affordance', 'information architecture']) {
    assert.ok(!all.includes(word), `"${word}" is jargon the operator did not come here for`);
  }
});

test('the interview knows where it is, because the chat is its only memory', () => {
  // The ask lane starts a fresh transcript every turn. Without a marker in the
  // chat, turn two would be read as a brand-new engineering question and
  // "12 on a laptop, 5 on a phone" would get an answer about the codebase.
  const chat = [usr('design help'), asst(`…question one…\n\n${designHelpMarker(1, 8)}`)];
  assert.deepEqual(designHelpProgress(chat), { step: 1, total: 8, done: false });
  assert.equal(isDesignHelpContinuation(chat), true);
  assert.deepEqual(designHelpTurn(designHelpProgress(chat)), { writeBrief: false, step: 2 });

  // The same answer whether the caller reads the chat before or after inserting
  // the operator's message — a difference between two call sites is not
  // something an interview should hinge on.
  assert.deepEqual(designHelpProgress([...chat, usr('12 on a laptop')]), { step: 1, total: 8, done: false });
});

test('answering the LAST question is what produces the brief', () => {
  // Treating "done" as "not a continuation" would drop the operator out one
  // turn before the thing they came for.
  const chat = [asst(`…question eight…\n\n${designHelpMarker(8, 8)}`)];
  assert.equal(isDesignHelpContinuation(chat), true, 'the last answer is still part of the interview');
  assert.deepEqual(designHelpTurn(designHelpProgress(chat)), { writeBrief: true, step: 8 });
  // And the brief turn gets a different prompt, not a clamped step number.
  const brief = buildDesignHelpSystemPrompt({ projectName: 'N9', step: 8, writeBrief: true });
  assert.match(brief, /This message is the brief/);
  assert.doesNotMatch(brief, /YOU ARE ON QUESTION/, 'the brief turn is not asking anything');
  assert.match(brief, /No marker on this message/, 'or the next ordinary question reads as question 9');
});

test('leaving the interview leaves it — the platform does not drag you back', () => {
  // Anything the platform said last that is not an interview turn means the
  // operator has moved on.
  assert.equal(designHelpProgress([asst(`q\n${designHelpMarker(3, 8)}`), asst('An ordinary answer about the codebase.')]), null);
  assert.equal(designHelpProgress([asst('no marker here')]), null);
  assert.equal(designHelpProgress([]), null);
  assert.equal(designHelpProgress(null), null);
  // A malformed marker is not a position.
  assert.equal(designHelpProgress([asst('[design-help 0/8]')]), null);
  assert.equal(designHelpProgress([asst('[design-help abc]')]), null);
});

test('the trigger is narrow, so real questions still reach the tool loop', () => {
  for (const q of [
    'design help', 'Design help', 'design help — the shifts screen',
    'help me design the dashboard', 'walk me through the design',
    'can you guide me through the ui step by step',
  ]) {
    assert.ok(detectDesignHelpIntent(q), `"${q}" should start the interview`);
  }
  for (const q of [
    'how does the design token system work',
    'why is the design.css not loading',
    'add a help link to the header',
    'what does the design-adherence gate measure',
  ]) {
    assert.equal(detectDesignHelpIntent(q), null, `"${q}" is a real question, not a request to be interviewed`);
  }
  // A long brief is an instruction someone already wrote — do not interview them.
  assert.equal(detectDesignHelpIntent(`help me design ${'x'.repeat(500)}`), null);
});

test('an interview ANSWER is never mistaken for a design-review request', () => {
  // The genuine hazard: answering question 4 with "check the layout at 390"
  // matches the polish intent, and being pulled into a screenshot run
  // mid-interview strands the operator with no way back to question 5. The
  // ordering in ask.js is what prevents it, so assert the ordering.
  const answer = 'check the layout at 390 — 5 rows';
  assert.ok(detectPolishIntent(answer), 'this answer really would trigger a review');
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock2', 'ask.js'),
    'utf8',
  );
  assert.ok(src.indexOf('DESIGN HELP') < src.indexOf('POLISH INTENT'), 'design help must be decided first');
  assert.match(src, /const polish = designHelp \? null : detectPolishIntent\(question\)/,
    'and an interview in progress must suppress the polish route outright');
});

test('the first turn is written, not generated', () => {
  // Nothing to react to, so paying a model call for a fixed greeting only makes
  // the feature feel slow. It also guarantees the marker exists, so the
  // interview can never fail to start.
  const open = designHelpOpening({ projectName: 'N9' });
  assert.match(open, /N9/);
  assert.match(open, new RegExp(`1 of ${DESIGN_HELP_TOTAL}`));
  assert.ok(open.includes(DESIGN_HELP_QUESTIONS[0].ask), 'question one, in full');
  assert.match(open, DESIGN_HELP_MARKER_RE);
  assert.deepEqual(designHelpProgress([{ kind: 'assistant', body: open }]), { step: 1, total: DESIGN_HELP_TOTAL, done: false });
  assert.match(open, /"[Ss]kip" or "you decide" is fine/, 'skippability has to be said, or it is not true');
});

test('each turn asks exactly one question and hands back the marker', () => {
  for (let n = 1; n <= DESIGN_HELP_TOTAL; n++) {
    const p = buildDesignHelpSystemPrompt({ projectName: 'N9', step: n });
    const q = DESIGN_HELP_QUESTIONS[n - 1];
    assert.ok(p.includes(`YOU ARE ON QUESTION ${n} of ${DESIGN_HELP_TOTAL}`), `step ${n} names its question`);
    assert.ok(p.includes(q.ask), `step ${n} carries the question text`);
    assert.ok(p.includes(q.why) && p.includes(q.example), `step ${n} carries the why and the example`);
    assert.ok(p.includes(designHelpMarker(n, DESIGN_HELP_TOTAL)), `step ${n} demands its own marker`);
    assert.match(p, /Ask exactly ONE question/);
    assert.match(p, /"Skip", "you decide", "I don't know" and silence are complete answers/);
  }
});

test('the brief is executable, not admirable', () => {
  const brief = buildDesignHelpSystemPrompt({ projectName: 'N9', writeBrief: true });
  assert.match(brief, /imperative changes/);
  assert.match(brief, /traceable to something they told you/);
  assert.match(brief, /Carry their\s+numbers through verbatim/);
  // The words the operator came here to stop having to use. Whitespace is
  // normalised first — the prompt is hand-wrapped, and a test that depends on
  // where a line happens to break tests the wrapping, not the rule.
  const flat = brief.replace(/\s+/g, ' ');
  for (const word of ['polish', 'modern', 'clean', 'professional', 'sleek', 'visual hierarchy']) {
    assert.ok(flat.includes(word), `the brief prompt must forbid "${word}"`);
  }
  assert.match(brief, /cannot be verified by looking at the screen afterwards, cut it/);
  // A skipped answer becomes a visible decision rather than a silent one.
  assert.match(brief, /state the assumption you are making as its own\s+item/);
  // And it ends where the next action is.
  assert.match(brief, /Send this as a Quick update/);
});

test('the answer turn says which question it answers', () => {
  // The transcript is a RECAP, not the true conversation, so "5 on a phone"
  // with no referent is answerable only by guessing.
  const t = buildDesignHelpTask('12 on a laptop, 5 on a phone', { step: 4 });
  assert.ok(t.includes(DESIGN_HELP_QUESTIONS[3].ask));
  assert.match(t, /Now ask question 5\./);
  // Silence is an answer.
  assert.match(buildDesignHelpTask('', { step: 2 }), /treat this as "you decide"/);
  // Past the end, it asks for the brief instead of a ninth question.
  assert.match(buildDesignHelpTask('nothing moves', { step: DESIGN_HELP_TOTAL }), /Write the brief now/);
});

test('the interview is wired into Ask, with no tools and a repaired marker', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock2', 'ask.js'),
    'utf8',
  );
  // A conversation, not a tool loop: the answers are in the operator's head.
  assert.match(src, /tools: designHelp \? \[\] : ASK_TOOLS/);
  assert.match(src, /serverTools: designHelp \? \[\] : serverTools/);
  assert.match(src, /const maxTurns = designHelp \? 1 : ASK_MAX_TURNS/);
  // The marker is the only state there is. A model that drops it would strand
  // the operator mid-interview, so it is repaired rather than trusted.
  assert.match(src, /!DESIGN_HELP_MARKER_RE\.test\(finalText\)/);
  assert.match(src, /designHelp && !designHelp\.writeBrief/, 'and never appended to the brief');

  // Reachable from the UI, through the SAME phrase the backend matches — so the
  // button and someone typing it cannot drift apart.
  const chat = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'src', 'components', 'mock2', 'BuildChat.jsx'),
    'utf8',
  );
  assert.match(chat, /const startDesignHelp = async/);
  assert.match(chat, /'Design help'/);
  assert.ok(detectDesignHelpIntent('Design help'), 'the phrase the button sends must trigger the interview');
  assert.ok(detectDesignHelpIntent('Design help — tighten the shifts screen'), 'including with a draft appended');
  // It must be offered when the composer is EMPTY — this is the action for
  // someone who does not yet know what to type.
  assert.match(chat, /\|\| hasDraft \|\| online \? \(/);
});

test('the brief is written from EVERY answer, not the last few', () => {
  // Eight questions and eight answers is 16 messages, and an ordinary ask
  // recaps 12. At that bound the brief would be written having forgotten what
  // the operator said about the screen's PURPOSE — the first answer, and the
  // one everything else hangs off.
  const chat = [];
  for (let i = 1; i <= DESIGN_HELP_TOTAL; i++) {
    chat.push(asst(`question ${i} …\n\n${designHelpMarker(i, DESIGN_HELP_TOTAL)}`));
    chat.push(usr(`answer number ${i}`));
  }
  const wide = buildAskContextBlock(chat, {
    maxMessages: DESIGN_HELP_CONTEXT_MAX_MESSAGES, maxChars: DESIGN_HELP_CONTEXT_MAX_CHARS,
  });
  for (let i = 1; i <= DESIGN_HELP_TOTAL; i++) {
    assert.ok(wide.includes(`answer number ${i}`), `answer ${i} must survive into the brief turn`);
  }
  // The ordinary bound genuinely would have lost it — this is the defect, not a
  // hypothetical.
  assert.ok(!buildAskContextBlock(chat).includes('answer number 1'));

  // And the wider window is actually used for interview turns.
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock2', 'ask.js'),
    'utf8',
  );
  assert.match(src, /designHelp \? DESIGN_HELP_CONTEXT_MAX_MESSAGES : ASK_CONTEXT_MAX_MESSAGES/);
  assert.match(src, /maxChars: DESIGN_HELP_CONTEXT_MAX_CHARS/);
});
