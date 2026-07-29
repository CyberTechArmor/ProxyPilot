// Mock2 FIRST-RUN STATE — "not yet possible" is not the same as "failed".
//
// THE REPORT THAT CAUSED THIS. Project 46 build 129 finished with 5 of 7 checks
// reporting `locator.waitFor: Timeout 5000ms exceeded`, including the
// platform's own `platform-baseline-signin-legal`. The build had done nothing
// wrong. The app was in first-run state.
//
// WHY FIRST-RUN BLOCKS EVERY SESSION CHECK, even now that the fixtures exist.
// The first administrator belongs to the OPERATOR: the platform must never
// create it, so the auth component's "a real user exists" guard is
// `email NOT LIKE '%@fixture.invalid'` and the seeded fixtures deliberately do
// not satisfy it. Until a real admin exists, `/login` renders the
// create-administrator form and HIDES the sign-in form. So:
//
//   - a check declaring a role cannot sign in — there is no form to fill;
//   - a baseline check asserting a sign-in selector times out on an element
//     that is legitimately absent.
//
// Seeding the fixture rows (which goes straight to Postgres, not through the
// API) fixed the "the user does not exist" half. This is the other half: the
// door itself is shut, and no amount of correct credentials opens it.
//
// WHAT THIS IS NOT. It is not an excuse generator. Three things keep it honest:
//
//   1. It only ever speaks when first-run is POSITIVELY confirmed — the app
//      itself answered 200 with `canCreateSuperadmin: true`. An unreachable
//      app, a non-200, a malformed body, a missing field: all leave the report
//      exactly as it was. A probe that fails must never turn a red build green.
//   2. It only reclassifies checks that NEED A SESSION (`role` declared). A
//      check that runs anonymously and fails, fails — first-run explains
//      nothing about it.
//   3. It reclassifies FAILURES only. A session check that somehow passed is
//      left alone; if it passed, the premise was wrong and the passing result
//      is the better evidence.
//
// PURE (stub-first, risk R9). Terminology (risk R7): nothing here is an "agent".

// The probe. Deliberately NOT accessStateScript from app-access-logic.js: that
// one also shells out to psql for the whole user roster, which the panel needs
// and the smoke gate does not. This is one curl, and it is only ever run when
// something already failed — the green path pays nothing for it.
export function firstRunProbeScript({ port = 3000 } = {}) {
  const base = `http://127.0.0.1:${Number(port) || 3000}`;
  return [
    'set -u',
    `C=$(curl -sS -o /tmp/pp-firstrun.json -w '%{http_code}' --max-time 8 "${base}/api/auth/bootstrap/status" 2>/dev/null)`,
    'echo "STATUS:${C:-000}"',
    'echo "BODY:$(head -c 400 /tmp/pp-firstrun.json 2>/dev/null | tr -d "\\n")"',
    'rm -f /tmp/pp-firstrun.json',
    '',
  ].join('\n');
}

// parseFirstRun — the labelled lines above → a decision. Never throws.
//
// `known` is the whole safety property: false means "we did not get a
// trustworthy answer", and every caller must then change nothing.
export function parseFirstRun(stdout) {
  const text = String(stdout || '');
  const statusM = text.match(/STATUS:(\d{3})/);
  const status = statusM ? Number(statusM[1]) : null;
  if (status !== 200) {
    return { known: false, firstRun: false, code: status, reason: status ? `bootstrap status returned ${status}` : 'the app did not answer' };
  }
  const bodyM = text.match(/BODY:(.*)/);
  let body = null;
  try { body = JSON.parse((bodyM?.[1] || '').trim()); } catch { body = null; }
  if (!body || typeof body.canCreateSuperadmin !== 'boolean') {
    return { known: false, firstRun: false, code: 200, reason: 'bootstrap status did not carry canCreateSuperadmin' };
  }
  return {
    known: true,
    firstRun: body.canCreateSuperadmin === true,
    code: 200,
    reason: body.canCreateSuperadmin
      ? 'the app has no first administrator yet, so the sign-in form is not rendered'
      : 'a first administrator exists',
  };
}

// A check needs a session iff it declares a role. parseUiChecks resolves the
// `"login": "someone@fixture.invalid"` spelling to a role too, so this one
// field covers both.
export function needsSession(check) {
  return !!(check && check.role);
}

// firstRunVerdict — reclassify. Returns the same results plus a `notPossible`
// flag on the ones first-run actually explains, and the counts to report.
//
// Callers pass `checks` so a result can be matched to its declaration; a result
// whose check cannot be found is left alone rather than guessed at.
export function firstRunVerdict({ results = [], checks = [], firstRun = false } = {}) {
  const roleById = new Map((checks || []).filter(Boolean).map((c) => [c.id, needsSession(c)]));
  const out = (results || []).map((r) => {
    const blocked = firstRun === true && r && r.ok === false && roleById.get(r.id) === true;
    return blocked ? { ...r, ok: false, notPossible: true } : r;
  });
  const notPossible = out.filter((r) => r.notPossible);
  // What is STILL a real failure after the excuse is applied. If this is
  // non-empty the gate must stay red — first-run explains some of the report,
  // never all of it by fiat.
  const stillFailed = out.filter((r) => !r.ok && !r.notPossible);
  return { results: out, notPossible, stillFailed, blocked: notPossible.length, remaining: stillFailed.length };
}

// The sentence an operator reads. Names the cause, the count, and the way out —
// the original bug was not that the checks failed but that nothing said why,
// so an operator read "5 of 7 failed" and went looking through their diff.
export function firstRunDetail({ blocked = 0, total = 0, stillFailed = [] } = {}) {
  if (!blocked) return '';
  const head = `no first administrator yet — ${blocked} of ${total} check(s) could not run`;
  const why = 'until someone creates the first admin account, /login shows the create-administrator form and hides the sign-in form, '
    + 'so every check that signs in has no form to fill. The fixture users exist; the door is shut. '
    + 'Create the first administrator (App access → it is the operator\'s account, never the platform\'s) and re-run.';
  if (stillFailed.length) {
    return `${head}, AND ${stillFailed.length} genuinely failed: ${stillFailed.map((r) => r.id).slice(0, 5).join(', ')}. ${why}`;
  }
  return `${head} — nothing else failed. ${why}`;
}

// The log line, so a build record still carries the fact.
export function firstRunLogLines({ blocked = 0, notPossible = [] } = {}) {
  if (!blocked) return [];
  return [`ui-check not-yet-possible: ${blocked} session check(s) skipped (no first administrator): ${notPossible.map((r) => r.id).slice(0, 8).join(', ')}`];
}
