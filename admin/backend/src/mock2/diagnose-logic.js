// Mock2 FAILURE DIAGNOSIS pure decision layer — what runs when a build fails
// its own acceptance checks. Native-free, unit-tested stub-first (risk R9).
//
// The problem, measured (project 54, the export saga): four fix builds
// ($1.07) each repaired something plausible-but-adjacent while the acceptance
// report named the exact failing selector every time — and the one build that
// started from a precise root-cause diagnosis fixed it for $0.17. The
// specificity already existed in the platform's own artifacts; nothing
// compiled it and nothing READ it before the next attempt.
//
// So: when a cycle fails with app-owned check failures, the platform now does
// what the successful human loop did — gather the evidence (the failing
// checks' exact steps, the build's claimed finish, the touched files' code),
// hand it to the TOP-TIER review model, and post the root cause + a
// build-ready fix instruction into the chat. Gathering is deterministic
// (zero model spend); only the diagnosis itself costs — one bounded top-tier
// call, roughly $0.10–0.25.
//
// Terminology (risk R7): nothing here is named "agent".

// Which checks are evidence: app-owned failures only. Platform baselines are
// the platform's to fix (their own shipped path says so), and passing checks
// prove the parts that work.
export function failingAppChecks(report) {
  const checks = report?.browser?.uiChecks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((c) => c && c.ok === false && !c.baseline)
    .map((c) => ({
      id: String(c.id || ''),
      name: String(c.name || ''),
      // The first failing step is the reproduction: what was clicked, what
      // never appeared.
      steps: (Array.isArray(c.steps) ? c.steps : []).map((s) => ({
        kind: String(s?.kind || ''), selector: String(s?.selector || ''), ok: !!s?.ok, detail: String(s?.detail || ''),
      })),
      consoleErrors: (Array.isArray(c.consoleErrors) ? c.consoleErrors : []).map((e) => String(e).slice(0, 300)).slice(0, 5),
    }));
}

// Which files to read as evidence: the product files this cycle changed —
// the defect is overwhelmingly in the diff that made the check fail. Build
// artifacts and state mirrors carry no logic.
export function diagnosisCandidateFiles(changedFiles = [], { max = 6 } = {}) {
  return (changedFiles || [])
    .map(String)
    .filter((f) => !/^state\//.test(f)
      && !/^public\/(build-id\.(js|txt)|sw\.js)$/.test(f)
      && !/package-lock\.json$/.test(f))
    .slice(0, Math.max(1, max));
}

export const DIAGNOSIS_SYSTEM_PROMPT = `You are reviewing a FAILED build of a web application. A browser acceptance
check failed after the build claimed to be finished. You are given: the build's
instruction, its claimed completion, each failing check with its exact steps
(what was clicked, what never appeared), and the full content of the files the
build changed.

Find the ROOT CAUSE in the code provided — the actual mechanism, not a
plausible neighbor. Trace the failing step through the code: what handler runs
on that click, what should change in the DOM, and why it does not. Prior fix
attempts on this surface repaired adjacent code while the named check kept
failing — do not repeat that; if the evidence is insufficient to be certain,
say exactly what to look at instead of guessing.

When SEVERAL checks fail, diagnose ALL of them in this one pass — group
failures that share a root cause, give each distinct cause its own ROOT
CAUSE/WHY pair — and write ONE combined FIX INSTRUCTION covering every
failure, so a single build clears the whole set instead of one check per
attempt.

Reply in EXACTLY this structure (plain text, no code fences around the whole
reply):

ROOT CAUSE: <the mechanism, naming file and function/handler — 2-4 sentences>

WHY THE CHECK FAILS: <trace from the check's failing step to the code path — 2-4 sentences>

FIX INSTRUCTION:
<a precise, build-ready Quick-update instruction: name the file(s), the exact
change(s), and the expected behavior that makes the named check pass. Smallest
correct fix — no refactors, no style changes, nothing the checks don't require.>`;

// The evidence document the diagnosis model reads. Bounded everywhere — the
// call must stay in the $0.10–0.25 band however big the app grows.
export function diagnosisEvidence({ instruction = '', finishSummary = '', checks = [], files = [] } = {}) {
  const parts = [];
  parts.push(`FAILED BUILD — its instruction was:\n${String(instruction || '').slice(0, 2000)}`);
  if (finishSummary) parts.push(`The build claimed on finishing:\n${String(finishSummary).slice(0, 600)}`);
  const checkBlocks = (checks || []).map((c) => {
    const steps = (c.steps || []).map((s) => `  - ${s.kind} ${s.selector} → ${s.ok ? 'ok' : `FAILED (${s.detail})`}`).join('\n');
    const cons = (c.consoleErrors || []).length ? `\n  console errors:\n${c.consoleErrors.map((e) => `  - ${e}`).join('\n')}` : '';
    return `CHECK "${c.id}" (${c.name}) FAILED:\n${steps}${cons}`;
  });
  if (checkBlocks.length) parts.push(checkBlocks.join('\n\n'));
  for (const f of files || []) {
    parts.push(`FILE ${f.path}:\n${String(f.content || '').slice(0, 24000)}`);
  }
  return parts.join('\n\n');
}

// The chat message the diagnosis lands as. The FIX INSTRUCTION section is
// what the operator sends (or one-taps via "Build this as a Quick update") —
// the whole point is that the next attempt starts from the root cause.
export function diagnosisChatMessage(text, { model = '' } = {}) {
  const body = String(text || '').trim();
  if (!body) return null;
  return `**Build diagnosis** — the failing check was reviewed against the changed code${model ? ` (${model})` : ''}.\n\n${body}\n\n_Send the FIX INSTRUCTION above as the next Quick update (or use its ⚡ shortcut) — it names the root cause, so the fix doesn't have to re-diagnose._`;
}
