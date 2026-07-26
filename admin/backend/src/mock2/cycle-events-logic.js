// Mock2 cycle-event content budgets — PURE (risk R9: no DB, no native module),
// so the "how much of a build's evidence survives into the downloadable log"
// rules are unit-testable on any host.

// How much of a tool result / AI message we persist.
//
// This was a flat 8,000 chars, which quietly made the downloaded build log
// useless as evidence: the model receives up to MAX_TOOL_RESULT_CHARS
// (200,000) per tool result, so what the build actually saw and what the
// operator can read back diverged by more than an order of magnitude. Reviewing
// "why did this build turn out badly" meant reading a log where every file
// write, every test run and every exec dump stopped mid-sentence.
//
// Budgets are now per kind — a tool result is the evidence and gets the most,
// an AI message is prose and rarely needs more than a few thousand lines — and
// truncation keeps the HEAD AND THE TAIL. Head-only clipping threw away the
// end of an exec dump, which is exactly where the error message is.
export const MAX_EVENT_CONTENT_CHARS = 8000; // retained: the floor for unclassified kinds

export const EVENT_CONTENT_BUDGETS = {
  tool_result: 64_000,
  ai_message: 32_000,
  tool_call: 16_000,
  task: 16_000,
  gate: 16_000,
};
// Bounded by the same order as the model's own tool-result cap, not by row
// aesthetics: a build writes a few hundred events, so even a pathological one
// stays in the low tens of MB in a WAL-mode SQLite file.
export const MAX_EVENT_CONTENT_CHARS_CEILING = 64_000;

export function eventContentBudget(kind) {
  const override = Number(process.env.MOCK2_MAX_EVENT_CHARS);
  if (Number.isFinite(override) && override > 0) return Math.min(override, MAX_EVENT_CONTENT_CHARS_CEILING);
  return EVENT_CONTENT_BUDGETS[String(kind)] || MAX_EVENT_CONTENT_CHARS;
}

// Head + tail, so the beginning of the command and the end of the failure both
// survive. The marker states how much went missing so nobody reads a truncated
// dump as a complete one.
export function clipEventContent(text, kind = null) {
  const s = String(text ?? '');
  const budget = eventContentBudget(kind);
  if (s.length <= budget) return s;
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  const dropped = s.length - budget;
  return `${s.slice(0, head)}\n…[truncated ${dropped} chars — ${head} kept from the start, ${tail} from the end]…\n${s.slice(-tail)}`;
}
