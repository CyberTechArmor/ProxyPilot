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

export const DEFAULT_OVERRIDE_WINDOW_MINUTES = 10;

// now is a parameter (not Date.now() called internally) so this stays pure and
// trivially testable; callers pass the wall-clock time they're checking against.
export function refusalOverrideActive({ refusedAt, now, withinMinutes = DEFAULT_OVERRIDE_WINDOW_MINUTES } = {}) {
  if (refusedAt == null) return false;
  const nowMs = Number.isFinite(now) ? now : Date.now();
  return (nowMs - Number(refusedAt)) <= withinMinutes * 60 * 1000;
}
