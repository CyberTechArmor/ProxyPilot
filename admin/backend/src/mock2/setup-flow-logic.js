// Mock2 GUIDED SETUP — the first-run path. Pure layer.
//
// WHY THIS EXISTS. Creating a project dropped you on a page with fifteen cards
// and no direction. Every part of a good first run already existed — the
// first-admin door, the asset library, the app's own self-description, the
// design chat, the approval gate — and nothing put them in an order or told you
// any of them were there. So the common path was: type one sentence into the
// prompt box and hope.
//
// That one sentence is the highest-leverage input in the whole pipeline. The
// mockup is generated from it; the inventory is extracted from the mockup; the
// first build's instruction is composed from the inventory; the adherence gate
// and the design review both measure the app AGAINST the mockup. Everything
// downstream is calibrated to a document written by someone who was never asked
// who the app is for.
//
// The evidence for what that costs is two builds on one project, one day apart:
// "implement every screen, field and action the inventory defines" took 110
// turns and $9.65; a brief that said what to build with numbers in it took 39
// turns and $2.53 and closed on its first finish attempt.
//
// NOTHING HERE BLOCKS. Every step is skippable, and skipping all of them
// reproduces today's behaviour exactly. The panel is not a gate; it is the
// product admitting it knows what a good first hour looks like.
//
// RESUMABILITY IS THE DESIGN CONSTRAINT. Projects get created and abandoned
// mid-setup, so there is no progress counter to desync: every step computes its
// own done-state from data that already exists for other reasons. Close the tab
// at step 4 and it is still at step 4 tomorrow, on any device.
//
// PURE (stub-first, risk R9): no I/O, no native modules. Terminology (risk R7):
// nothing here is named "agent".

// The three intake questions. Deliberately not four: "copy" was in the original
// sketch and came out, because before there are screens there is nothing for
// copy to attach to — it belongs in the asset library, and becomes useful the
// moment there is a screen to write it for.
//
// Each has a placeholder in the SHAPE of an answer rather than a description of
// one. An operator shown "e.g. a description of your users" writes a
// description of their users; one shown "Shift supervisors at 4 care homes"
// writes something a design can be built from.
export const INTAKE_FIELDS = Object.freeze([
  {
    key: 'audience',
    label: 'Who is this for?',
    placeholder: 'Shift supervisors at 4 care homes',
    hint: 'The people who will open it, not the department that paid for it.',
  },
  {
    key: 'summary',
    label: 'What does it do?',
    placeholder: 'Tracks who is covering which shift, and flags the gaps',
    hint: 'One sentence. This also becomes how the app describes itself on its own sign-in screen.',
  },
  {
    key: 'problem',
    label: 'What problem does it solve?',
    placeholder: 'Uncovered shifts are found at handover, when it is too late to fill them',
    hint: 'What goes wrong today. This is what tells a design which screen matters most.',
  },
]);

export const INTAKE_KEYS = Object.freeze(INTAKE_FIELDS.map((f) => f.key));
const MAX_ANSWER_CHARS = 600;

// The steps, in order. `id` is stable (it is persisted in dismissals and read
// by the panel); `title` is what the operator sees.
export const SETUP_STEPS = Object.freeze([
  {
    id: 'project',
    title: 'Project',
    blurb: 'Named, provisioned, and its base app deployed.',
  },
  {
    id: 'account',
    title: 'Your account',
    blurb: 'The first account belongs to you — the build is not allowed to create it.',
  },
  {
    id: 'brand',
    title: 'Logo & favicon',
    blurb: 'The mockup is designed around your logo rather than a placeholder mark.',
  },
  {
    id: 'about',
    title: 'About this app',
    blurb: 'Three questions that shape the first mockup and become the app’s own description of itself.',
  },
  {
    id: 'design',
    title: 'The design',
    blurb: 'Describe what you want. This produces the mockup everything else is measured against.',
  },
  {
    id: 'approve',
    title: 'Approve',
    blurb: 'Approving the design is what unlocks Build.',
  },
]);

export const SETUP_STEP_IDS = Object.freeze(SETUP_STEPS.map((s) => s.id));

// ---- the stored shape ----

// parseSetupIntake — tolerant read of the project's stored intake.
// A missing, empty or hand-edited value is an ordinary outcome; the answer to
// all of them is an empty intake, never a throw.
export function parseSetupIntake(json) {
  let doc = null;
  try { doc = typeof json === 'string' ? JSON.parse(json) : json; } catch { doc = null; }
  const src = (doc && typeof doc === 'object') ? doc : {};
  const answers = {};
  for (const k of INTAKE_KEYS) answers[k] = String(src[k] ?? '').trim().slice(0, MAX_ANSWER_CHARS);
  return {
    ...answers,
    // Dismissed = "stop showing me the panel". Distinct from finished: an
    // operator who skips everything has dismissed it, not completed it, and
    // conflating those would make "you skipped 5 steps" read as "done".
    dismissed: src.dismissed === true,
    // Whether the composed context has been pushed into the app's own branding
    // row yet. Stored because the app may be unreachable when the answers are
    // given — see pushAppContext.
    pushedAt: typeof src.pushedAt === 'string' ? src.pushedAt : null,
  };
}

export function renderSetupIntake(intake) {
  const out = {};
  for (const k of INTAKE_KEYS) if (intake?.[k]) out[k] = String(intake[k]).slice(0, MAX_ANSWER_CHARS);
  if (intake?.dismissed) out.dismissed = true;
  if (intake?.pushedAt) out.pushedAt = intake.pushedAt;
  return JSON.stringify(out);
}

export function hasIntakeAnswers(intake) {
  return INTAKE_KEYS.some((k) => String(intake?.[k] || '').trim());
}

// ---- step state ----

// setupStepStates(facts) → [{ id, title, blurb, done, blocked, detail }]
//
// Every `done` is derived from something that exists for another reason — an
// account the app knows about, an asset row, a file in the container, a column
// on the project. There is no progress counter to fall out of step with
// reality, which is what makes closing the tab safe.
export function setupStepStates({
  provisioned = false,
  appReachable = false,
  hasRealAdmin = false,
  hasLogo = false,
  intake = null,
  hasMockup = false,
  designApproved = false,
} = {}) {
  const answered = hasIntakeAnswers(intake);
  return SETUP_STEPS.map((s) => {
    switch (s.id) {
      case 'project':
        return { ...s, done: !!provisioned, blocked: false, detail: provisioned ? null : 'Provisioning the container and deploying the base app — about a minute.' };
      case 'account':
        return {
          ...s,
          done: !!hasRealAdmin,
          // Needs the app SERVING, which it is not while provisioning runs.
          // Blocked is not failed: the panel says why and lets you move on,
          // because nothing between here and the first build needs this.
          blocked: !appReachable,
          detail: appReachable ? null : 'Waiting for the app to come online — you can carry on and do this later.',
        };
      case 'brand':
        return { ...s, done: !!hasLogo, blocked: false, detail: null };
      case 'about':
        // Answerable the moment you think of it: the answers land on the
        // project row, not in the app, so provisioning does not gate them.
        return { ...s, done: answered, blocked: false, detail: null };
      case 'design':
        return { ...s, done: !!hasMockup, blocked: !provisioned, detail: provisioned ? null : 'Available once the app is online.' };
      case 'approve':
        return { ...s, done: !!designApproved, blocked: !hasMockup, detail: hasMockup ? null : 'Approve once there is a mockup to look at.' };
      default:
        return { ...s, done: false, blocked: false, detail: null };
    }
  });
}

// The step the panel should be showing: the first that is neither done nor
// blocked, else the first not done, else null (setup finished).
export function currentSetupStep(states = []) {
  return states.find((s) => !s.done && !s.blocked) || states.find((s) => !s.done) || null;
}

export function setupComplete(states = []) {
  return states.length > 0 && states.every((s) => s.done);
}

// setupProgress — what the header shows. Counting DONE rather than "current
// index" so a skipped step does not inflate the number.
export function setupProgress(states = []) {
  return { done: states.filter((s) => s.done).length, total: states.length };
}

// Should the panel be shown at all? Off when the flow is set to classic, when
// the operator dismissed it, or when every step is done — never because of a
// stored "seen" flag, which is the thing that goes stale.
export function shouldShowSetup({ mode = 'guided', intake = null, states = [] } = {}) {
  if (mode !== 'guided') return false;
  if (intake?.dismissed) return false;
  return !setupComplete(states);
}

// ---- what the answers are FOR ----

// composeAppContext(intake) → the { summary, audience } the app publishes about
// itself on its sign-in screen.
//
// `problem` has no field of its own in the platform's AppContext contract, and
// inventing one would fork a shape the generated apps already implement and
// that every build is told to keep current. It belongs in the summary anyway:
// "what this does" and "why anyone needs it" are one sentence to a reader who
// has never seen the app before. The raw answer is kept on the project row, so
// the brief still gets it verbatim.
export function composeAppContext(intake) {
  const summary = String(intake?.summary || '').trim();
  const problem = String(intake?.problem || '').trim();
  const audience = String(intake?.audience || '').trim();
  if (!summary && !problem && !audience) return null;
  const sentences = [];
  if (summary) sentences.push(summary.replace(/\s*[.]?\s*$/, '.'));
  if (problem) sentences.push(`It exists because ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`.replace(/\s*[.]?\s*$/, '.'));
  return {
    summary: sentences.join(' ').slice(0, 1000),
    audience: audience.slice(0, 500),
  };
}

// intakeBriefPreamble(intake) — what rides the MOCKUP render.
//
// Placed before the operator's own prompt as context, never instead of it: the
// prompt is what they asked for, this is who it is for. A design that knows its
// audience picks a different screen to make big.
export function intakeBriefPreamble(intake) {
  if (!hasIntakeAnswers(intake)) return '';
  const lines = [];
  if (intake.audience) lines.push(`WHO THIS IS FOR: ${intake.audience}`);
  if (intake.summary) lines.push(`WHAT IT DOES: ${intake.summary}`);
  if (intake.problem) lines.push(`THE PROBLEM IT SOLVES: ${intake.problem}`);
  return `${lines.join('\n')}\n\nDesign for those people and that problem: the screen that answers it is the one that should be biggest, densest and first. Do not restate any of this back as body copy on the screen.`;
}

// intakeBuildSection(intake) — what rides the FIRST BUILD's instruction.
//
// This is the change with the evidence behind it. The initial build instruction
// is a template that says "implement every screen, field and action the
// inventory defines" — the instruction that took 110 turns and $9.65 on project
// 46, against 39 turns and $2.53 for a brief that said what to build. The
// template cannot be made specific in general, but it CAN carry who the app is
// for, so the build knows what it is optimising for before its first decision.
export function intakeBuildSection(intake) {
  if (!hasIntakeAnswers(intake)) return '';
  const bits = [];
  if (intake.audience) bits.push(`It is for ${intake.audience}.`);
  if (intake.summary) bits.push(intake.summary.replace(/\s*[.]?\s*$/, '.'));
  if (intake.problem) bits.push(`It exists because ${intake.problem.charAt(0).toLowerCase()}${intake.problem.slice(1)}`.replace(/\s*[.]?\s*$/, '.'));
  return `\n\nWHO AND WHAT THIS IS FOR (the operator's own words — use it to decide what to make prominent, dense and immediate; it does not add scope): ${bits.join(' ')}`;
}

// The line shown above the prompt box at the design step, so the operator can
// see what the render is working from before they spend a mockup on it.
export function intakeDesignHint(intake) {
  const audience = String(intake?.audience || '').trim();
  const problem = String(intake?.problem || '').trim();
  if (!audience && !problem) return '';
  if (audience && problem) return `Designing for ${audience} — ${problem}`;
  return audience ? `Designing for ${audience}` : `Designing to solve: ${problem}`;
}
