// Shared "was this the immediate follow-up to a refusal we just posted" check
// (run-taxonomy fix #6/D2.3) — factored out so the pre-build guardrails don't
// each hand-roll the same Date.now()-minus-timestamp window arithmetic. A hard
// block with no escape hatch is a wall, not a guardrail: the symptom-chase cap
// (B2), the Define-stage enforcement (C2), and the duplicate-work check (D2)
// each let an operator override a refusal by repeating the action within a
// short window — this is the ONE place that window math lives.
//
// Pure: takes the refusal timestamp, not a Map. Each guardrail keeps its OWN
// per-project (and per-kind) state — the guardrails are independent checks, so
// overriding the symptom cap must never silently also override the rule gate
// or the duplicate-work check.

// THE WINDOW RUNS ON THE OPERATOR'S CLOCK, not the machine's (project 55).
// Ten minutes sounds generous until you watch what an operator actually does
// with a refusal: they read it, go and look at the app, then answer it by
// composing the instruction it asked for. The press that was refused in
// project 55 was followed by a fifteen-line build instruction — written well
// inside the hour, and well outside ten minutes. The window exists to tie the
// override to THAT refusal, not to make the operator type fast; an hour does
// that job and stops the escape hatch expiring mid-sentence.
export const DEFAULT_OVERRIDE_WINDOW_MINUTES = 60;

// now is a parameter (not Date.now() called internally) so this stays pure and
// trivially testable; callers pass the wall-clock time they're checking against.
export function refusalOverrideActive({ refusedAt, now, withinMinutes = DEFAULT_OVERRIDE_WINDOW_MINUTES } = {}) {
  if (refusedAt == null) return false;
  const nowMs = Number.isFinite(now) ? now : Date.now();
  return (nowMs - Number(refusedAt)) <= withinMinutes * 60 * 1000;
}

// ---- who the guardrails are TALKING TO (project 55) ----
//
// Every one of these three refusals ends "press Build again within 10 minutes
// to override". That sentence is the whole design: a guardrail with an escape
// hatch. It also means the refusal is only meaningful when a PERSON is there
// to read it — and the harness queues builds of its own.
//
// Project 55's context handoff checkpointed a half-finished build, queued the
// continuation, and the rules gate refused it: "no confirmed rules — run
// Define first". Nothing can press Build on a queue's behalf, so the row was
// marked failed and the work abandoned mid-flight. The refusal ALSO armed the
// ten-minute window, so the next queued row inherited an override nobody
// granted — the gate dropped the build it should have run and waved through
// the one it should have questioned.
//
// Two separate questions, two separate answers:
//   preBuildGatesApply  — is this a NEW ASK that a human should be questioned
//                         about? A harness-queued continuation is the second
//                         half of work already authorized; it is also
//                         near-identical to the cycle that just checkpointed,
//                         which is exactly what the duplicate check and the
//                         symptom cap are built to refuse.
//   mayConsumeOverride  — was Build actually PRESSED? Draining a queue is not
//                         "pressing Build again", however legitimate the
//                         queued ask is.
export function preBuildGatesApply(origin) {
  return String(origin || 'operator') !== 'system';
}

export function mayConsumeOverride(origin) {
  return String(origin || 'operator') === 'operator';
}
