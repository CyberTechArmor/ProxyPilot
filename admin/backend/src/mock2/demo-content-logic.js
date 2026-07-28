// Mock2 DEMO CONTENT — the pure half.
//
// WHY THIS EXISTS. The design review signs in as the platform's capture account
// and screenshots an EMPTY app. So it can only ever critique chrome — and that
// is exactly what its findings are: footer links, the theme toggle, native
// select boxes, contrast. It has never once seen the notes list with twelve
// notes in it.
//
// The evidence is two notes apps built from a byte-identical starting
// instruction. The one that came out well had a list showing a PINNED note with
// 3 to-dos next to one from 40 minutes ago and one from a week ago, and a to-do
// carrying a MUTED reminder. Somebody had to decide what pinned looks like next
// to unpinned, and what "1w ago" looks like next to "40m ago". Those decisions
// only get made when those cases exist. The other app's home screen held one
// note called "test" and 800px of nothing — and its empty middle was never a
// style choice, it was an unmade decision.
//
// THE CONTENT GOES IN THROUGH THE APP'S OWN API, never by writing rows. Same
// principle as the first-administrator bootstrap: validation, defaults, derived
// fields and audit entries stay the app's, and the platform gets no privileged
// shortcut it would then have to be trusted with. It also means the seed
// exercises the app's real write path, so a broken create endpoint shows up
// here rather than in a screenshot two builds later.
//
// AND ONLY INTO THE CAPTURE ACCOUNT. "not the super admin or any users." The
// requests are sent with the @fixture.invalid session and nothing else, so the
// operator's own account stays exactly as they left it.
//
// PURE (stub-first, risk R9): prompt, parse, safety fence. No I/O.
// Terminology (risk R7): nothing here is named "agent".

// Where the marker lives, so a project is seeded once rather than on every
// review. In the container with the rest of state/, so restoring a checkpoint
// restores the fact too.
export const DEMO_SEED_MARKER = 'state/demo-seeded.json';

export const MAX_CALLS = 24;
export const CALL_TIMEOUT_S = 10;

// Methods that CREATE. No DELETE and no bare PUT to a collection: a seeder that
// can remove things is a seeder that can empty an app somebody was using, and
// the whole point is that this runs unattended before a review.
export const SAFE_METHODS = Object.freeze(['POST', 'PUT', 'PATCH']);

export function buildDemoContentPrompt() {
  return `You fill a freshly built web app with realistic demo content, by calling its own API.

WHY IT MATTERS: an empty app cannot be designed. Nobody can decide what a list
looks like with twelve rows, what a long title does to a card, or what an item
with no children looks like next to one with nine, until those exist. Your
content is what makes those questions askable.

You are given the app's route list and its screen inventory. Return the HTTP
calls that create the content, in dependency order (a parent before its child).

WHAT GOOD CONTENT LOOKS LIKE — this is the whole job, so do not phone it in:
- REAL SUBJECTS. Things a person would actually keep in this app, written the
  way people write: "Q3 pricing — call with Dana", "renew the domain before the
  14th". Never "Test 1", "Sample note", "Lorem ipsum", "Item A".
- VARIETY THAT FORCES DECISIONS. Include, deliberately:
  · one item with a very long title and one with a two-word title
  · one with a lot of body text and one with almost none
  · one with many children (to-dos, comments, tags) and several with none
  · at least one of every flag the app supports (pinned, archived, done,
    muted, favourite) AND items without it, so both states are visible
- ENOUGH TO SCROLL. Around ${'${count}'} top-level items unless the app clearly
  wants fewer. A list of three never reveals a list problem.
- SPREAD IN TIME where the app records time, so relative timestamps show their
  range rather than twelve identical "just now" rows.

RULES:
- Use ONLY endpoints that appear in the route list. Never invent one.
- Method must be POST, PUT or PATCH. Never DELETE.
- Paths must be relative and begin with "/" — no host, no scheme.
- Send the fields the route actually accepts. Omit anything you are unsure of
  rather than guessing a name.
- If an id is needed from an earlier call, reference it as "$1.id" where 1 is
  the 1-based index of the call that created it.
- Nothing offensive, nothing that looks like real personal data, no real email
  addresses or phone numbers.

Reply with STRICT JSON only — no prose, no code fences:

{
  "calls": [
    { "method": "POST", "path": "/api/notes", "body": { "title": "...", "content": "..." }, "note": "why this one exists" }
  ]
}`;
}

export function buildDemoContentTask({ appName = 'the app', routes = '', inventory = '', count = 12 } = {}) {
  const parts = [`App: ${appName}`, `Aim for about ${count} top-level items.`];
  if (routes) parts.push(`The app's routes:\n${String(routes).slice(0, 8000)}`);
  if (inventory) parts.push(`Its screen inventory:\n${String(inventory).slice(0, 6000)}`);
  parts.push('Return the JSON object of calls. Order matters — parents before children.');
  return parts.join('\n\n');
}

// parseDemoCalls — tolerant of fences, strict about safety.
//
// Every fence here is a thing the seeder must not be able to do, not a thing
// the model is unlikely to ask for. It runs unattended against a live app.
export function parseDemoCalls(text, { allowedPaths = null } = {}) {
  let s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let doc;
  try { doc = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const raw = Array.isArray(doc?.calls) ? doc.calls : [];
  const calls = [];
  for (const c of raw) {
    const method = String(c?.method || '').trim().toUpperCase();
    const path = String(c?.path || '').trim();
    if (!SAFE_METHODS.includes(method)) continue;
    // Relative, same-origin, no traversal. A path that can leave the app is a
    // path that can reach anything the container can.
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) continue;
    if (/[\s"'`\\]/.test(path)) continue;
    // When the caller knows the app's real routes, refuse anything else — an
    // invented endpoint is at best a 404 and at worst a route the seeder was
    // never meant to touch.
    if (allowedPaths && !matchesAllowed(path, allowedPaths)) continue;
    if (c?.body !== undefined && (typeof c.body !== 'object' || c.body === null || Array.isArray(c.body))) continue;
    calls.push({ method, path, body: c.body ?? {}, note: String(c?.note || '').slice(0, 160) });
    if (calls.length >= MAX_CALLS) break;
  }
  return calls.length ? { calls } : null;
}

// A route list carries patterns like `/api/notes/:id`. Compare structurally so
// `/api/notes/7` matches, and `/api/admin/users` does not match `/api/notes`.
export function matchesAllowed(path, allowed) {
  const got = path.split('?')[0].split('/').filter(Boolean);
  return (allowed || []).some((pat) => {
    const want = String(pat).split('?')[0].split('/').filter(Boolean);
    if (want.length !== got.length) return false;
    return want.every((seg, i) => seg.startsWith(':') || seg === got[i]);
  });
}

// Resolve "$1.id" references against what earlier calls returned. Unresolvable
// references drop the CALL rather than sending the literal string — a body
// carrying "$1.id" where an id belongs is a row that looks seeded and is not.
export function resolveRefs(body, results) {
  let ok = true;
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = /^\$(\d+)(?:\.(\w+))?$/.exec(v.trim());
      if (!m) return v;
      const prior = results[Number(m[1]) - 1];
      const val = m[2] ? prior?.[m[2]] : prior;
      if (val === undefined || val === null) { ok = false; return v; }
      return val;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  const resolved = walk(body);
  return ok ? resolved : null;
}

// The in-container runner's labelled lines, read back. Pure so the sandbox can
// test it without the container half's database imports.
export function parseSeedRun(stdout) {
  const text = String(stdout || '');
  const noauth = /SEED:noauth:(.*)/.exec(text);
  if (noauth) return { ok: false, created: 0, failed: 0, reason: `could not sign in as the capture account (${noauth[1].trim()})` };
  const done = /SEED:done:(\d+):(\d+):(\d+)/.exec(text);
  if (!done) return { ok: false, created: 0, failed: 0, reason: 'the seeder produced no result' };
  const created = Number(done[1]);
  return { ok: created > 0, created, failed: Number(done[2]), reason: created ? null : 'every call was refused by the app' };
}

// The chat note. Says what went in and, honestly, what did not.
export function demoSeedNote({ created = 0, failed = 0, account = '', skipped = 0 } = {}) {
  if (!created) {
    return 'No demo content could be created — the app\'s own API refused every call. '
      + 'Nothing was changed. This usually means the create endpoints are not working yet, which is worth knowing.';
  }
  const lines = [
    `Filled the app with ${created} item(s) of demo content, signed in as ${account || 'the capture account'}.`,
    '',
    'The design review screenshots this account, so it can now see what the screens look like with real '
      + 'content in them — long titles, empty children, a spread of dates — instead of critiquing an empty page. '
      + 'Your own account is untouched.',
  ];
  if (failed || skipped) {
    lines.push('', `${failed + skipped} call(s) did not land (${failed} refused by the app, ${skipped} dropped as unsafe or unresolvable).`);
  }
  return lines.join('\n');
}
