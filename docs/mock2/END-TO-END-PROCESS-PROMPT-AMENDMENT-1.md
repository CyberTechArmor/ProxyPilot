# Amendment 1 to the ProxyPilot process paper & process map prompt

This amends `END-TO-END-PROCESS-PROMPT.md`. You (the writer / mapmaker) have
already produced a draft paper and a process map from that prompt — **do not
rewrite them**. Apply the targeted edits below, keeping the original's
structure, tone, and terminology rules. Three capabilities shipped since the
original prompt, and one existing feature needs a stronger mention.

---

## Edit 1 — NEW subsection: "The context sweet spot (the handoff loop)"

**Paper:** insert a new subsection immediately after "The model economy" and
before "The honesty machinery". Content to convey (keep it to 2–3 paragraphs):

Long builds have a hidden cost curve. Prompt caching makes re-reading the
conversation cheap (~0.1× input price), but every working turn re-reads *all*
of it — so a turn's floor cost grows linearly with the live context and a
run's total cost grows with the **square** of its turn count, while the
model's precision measurably degrades as the window fills. Past a measured
point, continuing in the same context is paying more for worse work.

So the platform doesn't grind past that point. At the **context sweet spot
(~140k tokens of live context)** the build pauses itself and runs **the
handoff loop**: the model — while it still holds the full context — writes a
handoff (*what is DONE as verified facts, the ordered NEXT STEPS, the
GOTCHAS the next run must know*), the work-in-progress is checkpointed into
git, and a **continuation build is queued automatically**, carrying the
handoff so it starts sharp in a fresh context. The chain is bounded (at most
3 automatic continuations per operator request; each rebuilds from the
operator's *original* instruction plus only the newest handoff, so nothing
nests or drifts) — past the cap it becomes an ordinary one-click Resume.
Numbers you may cite: restarting fresh pays for itself within ~3–5 turns;
the practical effect is that one $4 run grinding a degrading 190k window
becomes two or three sharp ~$1.50 runs that each begin from a written plan.

**Process map:** amend node 7→8. After "implement (lane-routed)", add a
decision diamond inside the Models/Platform lanes:

- ◇ *"Live context ≥ sweet spot (~140k)?"* — no → continue to node 8 checks
  as drawn; yes → Models: *write handoff (done / next / gotchas)* →
  Platform: *checkpoint WIP* → Platform: *queue continuation (run n of 3)* →
  loop back to node 7 (label the loop **"handoff loop"**) — with a small
  escape: ◇ *"chain cap reached?"* → Operator: *manual Resume*.

Draw this as a third named cycle alongside the existing three (design
iteration, build-check-diagnose, steady state).

---

## Edit 2 — the cheap tier is visible in the feed

**Paper:** in "The model economy", extend the sentence about every step being
tagged with its model. New fact to add: the *sizing* work is visible too —
each build's feed opens with a classifier row such as *"Sized by the
classifier: mechanical — the cheap-tier lane builds it"*, tagged with the
cheap-tier model that made the call. The reader should come away knowing the
operator can watch the whole economy: cheap tier sizing, top tier planning,
the routed lane executing — every row named.

**Process map:** in the Models lane at node 7, label the classifier step
explicitly *"classifier (cheap tier — visible in feed)"*. No new nodes.

---

## Edit 3 — the anomaly tripwire (deploy hold)

**Paper:** in "The honesty machinery", add one sentence to the post-build
sequence, between the finish guard and deploy: on a change whose shape looks
anomalous for what was asked (e.g. a small request producing a sweeping
diff, or a risky data-model swap), the **anomaly tripwire holds the deploy**
— the previous deploy keeps serving, the change record is presented for
review, and the operator releases it with one press. Frame it as the same
philosophy as pending verification: the platform ships claims it can stand
behind and *holds* the ones a human should glance at first.

**Process map:** in the Checks lane inside node 8, after "deploy", add a
small decision: ◇ *"anomaly tripwire?"* — held → Operator: *review + release
deploy* → continue; clear → continue. Keep it compact (one diamond, one
operator action).

---

## Edit 4 — small factual touch-ups to the original text

- In "The failure loop", the diagnosis covers **all failing checks in one
  pass** — one combined fix instruction for the whole set. If the draft
  implies one-check-at-a-time, correct it.
- In Stage 4's Redo description, keep: Redo **defaults to the routed
  harness ("Default — 5-phase routing")** and automatically carries what the
  prior attempt *did* (its change summary and diff) as context; an explicit
  model pick remains available as an operator escalation.
- Where the paper cites typical costs, you may now also cite: a failure
  diagnosis ~$0.10–0.25; a research pass ~$0.15–0.40; the measured
  before/after for diagnosis-led fixing ($1.07 of blind retries vs $0.29
  diagnosed-and-fixed).

## Unchanged

Terminology rules, tone rules, swimlanes, and all other nodes stand exactly
as in the original prompt. If any Edit above conflicts with draft prose,
the Edit wins; if it conflicts with an original-prompt rule, the rule wins.
