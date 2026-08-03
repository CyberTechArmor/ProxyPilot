# Spec B — Runtime observation and symptom-chase escalation

**Status:** ready to implement · **Audience:** Claude Sonnet · **Source:** Prompt B in `docs/harness-fix-prompts.md`
**Plan reference:** fixes #1 and #7 in `docs/harness-report-verification.md`

B1 ships first and alone. B2 depends on it. Ground rules from Spec A apply
(`node:test`, flat tests, no `describe`, pure logic in `*-logic.js`, never import
`db.js` from a test).

---

# Load-bearing finding: what the probes will actually see

**Nothing starts the app during a cycle.** The app is served by a persistent
systemd unit `mock2-dev.service` (written by `buildDevServiceUnit`,
`deploy-logic.js:91-115`, path `deploy.js:38`) that was started by the **previous
deploy**. `deployStage` (`runner.js:3533`) runs only *after* `finish` and green
gates. `runner.js` contains **zero** HTTP probes today.

So a mid-cycle probe observes **the last deployed build, not the working tree.**

This is not a defect to engineer around — it is exactly right for the primary use
case. The operator reports "the export menu doesn't open"; the build probes the
running app, sees `display:none`, and fixes the cause. That is the `docs2` saga
ending on cycle one.

But it is wrong for the secondary use case (confirming your own fix before
finishing). Both must be supported and the difference must be **impossible to
confuse**, or the runner will "verify" a fix against code that does not contain
it — a worse failure than having no probe at all.

**Decision.** Both tools take a required `target` parameter:

- `target: "deployed"` — probe the running unit as-is. What the operator sees.
- `target: "working"` — restart `mock2-dev.service` from the working tree first,
  then probe. Confirms this cycle's edits.

Every probe result **states which target ran, in the returned text**, so a stale
observation cannot be silently reasoned over. `working` is best-effort: if the
restart fails, return the failure and **do not fall back to `deployed`**.

---

# B1 — Two new runner tools

## B1.1 Where the tool system lives

Confirmed anchors:

| Thing | Location |
|---|---|
| `RUNNER_TOOLS` | `runner-logic.js:25-262`, entries are `{ name, description, input_schema }` — **`input_schema`, snake_case** |
| `RUNNER_TOOL_NAMES` | `runner-logic.js:264` — auto-derived, no change needed |
| `READ_ONLY_TOOLS` | `runner-logic.js:279-281` — parallel-execution allowlist |
| `runnerToolsForCycle` | `runner-logic.js:309-320` — strips `run_gates` on fast lanes |
| `classifyTurn` | `runner-logic.js:1263` — control-flow tools only; **no change needed** |
| `describeRunnerStep` | `runner-logic.js:1349-1369` — per-tool log label; **needs a case** |
| `executeTool` | `runner.js:3123-3277` — one `switch (call.name)` |
| `truncateToolResult` | `runner-logic.js:407-417`, cap `MAX_TOOL_RESULT_CHARS` = 200 000 |
| Copilot harness | `harness-copilot.js:115` `COPILOT_DROP` — a new tool is auto-exposed there unless dropped |

`executeTool` contract, which the new cases must honour exactly:
- always resolve to `{ content: string }` (only `run_gates` adds `gateReports`);
- **never throw** — there is no try/catch at the call sites; errors return as
  `content` strings prefixed `error: `;
- call `touchLock(cycle.project_id, holder)` for anything slow.

## B1.2 `http_probe`

Runs **inside the container** via `execInContainer`, so the base URL is
`http://127.0.0.1:${webPort}` — the same shape `smoke.js:74` (`httpSmoke`) and
`deploy.js:240` already use.

Add to `RUNNER_TOOLS` immediately after `run_gates`:

```js
  {
    name: 'http_probe',
    description:
      'Send ONE HTTP request to the app\'s own endpoint inside the container and return the real status, headers and body. Use this to OBSERVE what the API actually does instead of reasoning about what it should do — a wrong content-type, a 500 with a stack, an empty body. target "deployed" hits the app currently running (what the operator sees; use this to reproduce a reported bug). target "working" restarts the app from your working tree first (use this to confirm YOUR change). The URL is always this app on localhost — external hosts are not reachable from the fence.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['deployed', 'working'], description: 'Which build to probe. "deployed" = the running app. "working" = restart from your edits first.' },
        path: { type: 'string', description: 'Path on the app, e.g. "/api/notes" or "/login". Must start with "/".' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method. Default GET.' },
        body: { type: 'string', description: 'Request body, sent verbatim. Pair with a content-type header.' },
        headers: {
          type: 'object',
          description: 'Request headers as a flat string map, e.g. {"content-type": "application/json"}.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['target', 'path'],
      additionalProperties: false,
    },
  },
```

### Execution

New case in `executeTool`:

```js
      case 'http_probe': {
        touchLock(cycle.project_id, holder);
        const out = await runHttpProbe({ containerName, webPort, input: call.input || {} });
        return { content: out };
      }
```

`webPort` is **not currently in `executeTool`'s scope.** Thread it through:
`executeTool({ call, cycle, containerName, holder, gateScripts, webPort })` and
update **all four call sites** — `runner.js:3084-3096` (the main loop, both the
parallel and single branches) and the three drain paths at **1948-1951**,
**1960-1963**, **2005-2008**. Source the value as `project.web_port || 3000`,
matching `runner.js:1366`.

New helper in `runner.js`, near `execInContainer`:

```js
// runHttpProbe — one curl round-trip against the app's own port inside the
// container. The fence already blocks external egress; this never leaves
// loopback because the URL is CONSTRUCTED here, not taken from the model.
async function runHttpProbe({ containerName, webPort, input })
```

Behaviour:
1. Validate via the pure `httpProbePlan` (B1.4). On `{ error }`, return
   `` `error: ${error}` ``.
2. If `target === 'working'`, call `restartDevFromWorkingTree(containerName)`
   (B1.5) first. On failure return the failure text and stop — **no fallback**.
3. Build the command. Construct the URL in JS, never from model input:
   ```js
   const url = `http://127.0.0.1:${Number(webPort) || 3000}${plan.path}`;
   ```
   Use `curl -sS -i --max-time 10 -X <METHOD>` with `-H` per header and
   `--data-raw` for a body. **Shell-quote every interpolated value with
   single quotes and escape embedded single quotes** — model input reaches a
   shell here.
4. Run with `execInContainer(containerName, cmd)`.
5. Format the reply through the pure `formatHttpProbeResult` (B1.4): the target
   that ran, the request line, the status line, the headers, then the body
   capped at 8 000 chars with an explicit `…[body truncated, N chars total]`.

**`curl` is denylisted.** `harness-safety.js:19` blocks `/\bcurl\b|\bwget\b/`, but
that denylist is applied by `commandAllowed()` in the `run_terminal` case
(`runner.js:3157-3164`) — **not** in `execInContainer`. `http_probe` therefore
works without touching `DEFAULT_COMMAND_DENYLIST`. **Do not modify
`harness-safety.js`.** Confirm this by reading `runner.js:3157` before you start;
if `commandAllowed` has moved into `execInContainer`, stop and report rather than
loosening the denylist.

## B1.3 `browser_probe`

Playwright runs in the **backend process**, not in the container
(`ui-checks.js:67` lazily imports `playwright-core`). So this tool must reach the
container over its IP, exactly as smoke does: `resolveBrowserTarget(containerName,
webPort)` (`smoke.js:109-132`) — which exists precisely because
`http://127.0.0.1:3000/` failed with `ERR_CONNECTION_REFUSED` from the host.

**The step vocabulary has no computed-style assertion.** `STEP_KINDS`
(`ui-check-logic.js:32-56`) is eight kinds; the only `getComputedStyle` use is
inside `expect_no_scroll` (`ui-checks.js:162-186`). So computed style is genuinely
new capability — the highest-value part of this tool and the thing that would have
ended the `docs2` saga.

```js
  {
    name: 'browser_probe',
    description:
      'Open a page of the running app in a real browser and report what is ACTUALLY there: console errors, failed network requests, whether a selector is visible, its computed style, and a DOM excerpt. This is how you find out WHY something does not appear — a control hidden by a CSS rule, a handler that threw, a request that 404ed — instead of guessing. target "deployed" is what the operator sees; target "working" restarts the app from your edits first. Prefer this over reasoning about behaviour: read what the page is doing.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['deployed', 'working'] },
        path: { type: 'string', description: 'Page path, e.g. "/" or "/notes". Must start with "/".' },
        role: { type: 'string', description: 'Optional role to sign in as first, using state/ui-checks.json login users (e.g. "admin").' },
        selectors: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string' },
          description: 'CSS selectors to inspect. For each: found, visible, and the computed display/visibility/opacity/position/z-index/overflow.',
        },
        dom_selector: { type: 'string', description: 'Optional selector whose outerHTML to return (capped). Use to see what actually rendered.' },
      },
      required: ['target', 'path'],
      additionalProperties: false,
    },
  },
```

### Execution

New helper module **`admin/backend/src/mock2/browser-probe.js`** — do **not** add
this to `ui-checks.js`, which is the smoke executor and is imported by
`smoke.js`; keeping the probe separate avoids coupling the cycle path to the smoke
path.

```js
// browser-probe.js — mid-cycle observation of the running app. Reuses ui-checks'
// launcher, context and login so a probe sees the same app the smoke connector
// does, but answers a different question: not "does this check pass" but "what is
// actually on this page".
export async function runBrowserProbe({ baseUrl, spec = null, input = {} })
  // → { ok, unavailable?, target, url, consoleErrors[], networkFailures[],
  //     selectors: [{ selector, found, visible, computed: {...} }],
  //     dom: string|null, detail?: string }
```

Reuse verbatim from `ui-checks.js`: `loadChromium()` (67), `launchOptions()` (50),
`AUTOMATION_CONTEXT` (242), `gotoStable()` (265), `loginAs()` (367). Import them —
`AUTOMATION_CONTEXT`, `gotoStable` and `loginAs` are currently **module-private**;
export them from `ui-checks.js` rather than copying. Copying is the one thing that
must not happen: two divergent login paths is a defect factory.

Collection rules:
- Console errors: copy the listener block at `ui-checks.js:404-412` exactly,
  including the favicon exemption and the 300-char cap.
- Network failures: `page.on('requestfailed')` and `page.on('response')` for
  status ≥ 400 — record `${method} ${url} → ${status|errorText}`, cap 20.
- Per selector: `found` (count > 0), `visible` (`isVisible()`), and
  `getComputedStyle` for `display`, `visibility`, `opacity`, `position`,
  `zIndex`, `overflow`, `pointerEvents`. Never throw — a bad selector yields
  `{ selector, found: false, error: '<message>' }`.
- `dom`: `outerHTML` capped at 4 000 chars.
- Always `close()` the context and browser in `finally`, as `ui-checks.js:428,436`
  does.
- Playwright missing → `{ ok: false, unavailable: true, detail: … }`, mirroring
  `ui-checks.js:387-389`. The tool must then return a plain-language
  `error: the browser connector is not installed …`, never a crash.

`executeTool` case:

```js
      case 'browser_probe': {
        touchLock(cycle.project_id, holder);
        const out = await runBrowserProbeTool({ cycle, containerName, webPort, input: call.input || {} });
        return { content: out };
      }
```

`runBrowserProbeTool` in `runner.js`: validate via `browserProbePlan`, honour
`target`, resolve `baseUrl` via `resolveBrowserTarget`, read
`state/ui-checks.json` for the login spec when `role` is set (reuse
`parseUiChecks`), call `runBrowserProbe`, and format via
`formatBrowserProbeResult`.

## B1.4 Pure logic — `admin/backend/src/mock2/probe-logic.js`

Everything decidable goes here so it is testable native-free.

```js
export const PROBE_TARGETS = Object.freeze(['deployed', 'working']);
export const PROBE_MAX_PER_CYCLE = 10;          // combined across both tools
export const PROBE_BODY_CAP = 8000;
export const PROBE_DOM_CAP = 4000;

// Validate + normalise http_probe input. Never trusts the model's string.
export function httpProbePlan(input = {})
  // → { path, method, headers: [[k,v]], body, target } | { error }

// Same for browser_probe.
export function browserProbePlan(input = {})
  // → { path, target, role, selectors: string[], domSelector } | { error }

// Shell-safe single-quoted argument.
export function shellQuote(value)

// Human-readable results. Both MUST begin with the target line.
export function formatHttpProbeResult({ target, method, path, raw })
export function formatBrowserProbeResult(result)

// Per-cycle cap.
export function probeBudget(used, max = PROBE_MAX_PER_CYCLE)
  // → { allowed: boolean, message: string|null }
```

Validation rules (all enforced in `httpProbePlan` / `browserProbePlan`):
- `target` must be in `PROBE_TARGETS` — no default, it is required.
- `path` must be a string starting with `/`. Reject `//` (protocol-relative) and
  any string containing `://`.
- `method` uppercased, default `GET`, must be in the enum.
- Headers: string keys and values only; reject any key or value containing a
  newline (header injection); cap 20.
- `selectors`: cap 10, each a non-empty string ≤ 200 chars.

`shellQuote` wraps in `'…'` and replaces `'` with `'\''`. Every value
interpolated into the curl command goes through it.

### Cap enforcement

Track `probeCalls` alongside the existing per-cycle counters in `runner.js`
(near `gateFailStreak`, line 1577). On exceeding `PROBE_MAX_PER_CYCLE`, return
this content rather than executing — a plain-language redirect, not a bare error:

> `error: probe budget spent (10 probes this cycle). You have observed enough to act — make the change, or halt with what you found. If you still cannot see the cause, halt and say exactly what evidence you need.`

## B1.5 Restarting from the working tree

New helper in `runner.js`:

```js
// restartDevFromWorkingTree — make mock2-dev.service serve THIS cycle's edits so
// a probe observes the working tree rather than the last deploy. Deliberately
// NOT a deploy: no migrations, no gates, no checkpoint — just build + restart.
async function restartDevFromWorkingTree(containerName)
  // → { ok: boolean, detail: string }
```

Run the app's own build then restart the unit:

```sh
npm run build 2>&1 | tail -20
systemctl restart mock2-dev.service
```

then poll readiness with the existing shape from `deploy.js:240`
(`curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${webPort}/"`,
accepting any code that is not `000` and is `< 500`), bounded to ~20 attempts ×
1 s. Return `{ ok: false, detail }` with the build output tail on failure — that
output is itself useful evidence.

Do **not** reuse `deployStage`: it migrates, redeploys and is queued per container
(`deploy.js:95`). A probe must not have those side effects.

## B1.6 Prompt changes

Three edits in `runner-logic.js`. The system prompt and `buildRunnerClaudeMd`
(line 1641) are pinned to agree by an existing no-drift test
(`mock2-build-contract.test.js`) — **update both**.

**(a) New section constant**, defined next to `EDITING_MECHANICS_SECTION` (867):

```js
// Observation before theory. The measured failure mode: builds that could not
// see the running app shipped a plausible guess, were told it was still broken,
// and guessed again — five cycles on one CSS rule in the worst case. The fix
// that worked always came from READING something. These tools are the reading.
export const OBSERVATION_SECTION = `# Observe before you theorise
- When something "does not work", LOOK at it before you reason about it.
  browser_probe opens the page in a real browser and tells you the console
  errors, the failed requests, whether your selector is visible and its COMPUTED
  STYLE. http_probe sends a real request to your own endpoint and returns the
  real status, headers and body.
- Reproduce first, then fix. Probe with target "deployed" to see what the
  operator sees. Probe with target "working" to confirm your own change — it
  restarts the app from your edits first.
- A cause you OBSERVED goes in assumptions.verified, naming what you saw ("the
  computed display of .popover.menu is none"). A cause you inferred is ASSUMED,
  and you say so.
- If two attempts at the same symptom have failed, stop guessing: probe for the
  mechanism, or halt and say exactly what evidence you need. Do not ship a third
  guess.`;
```

Interpolate it directly after `EDITING_MECHANICS_SECTION` (prompt line 1054).

**(b) Amend the contradicting paragraph.** The block at `runner-logic.js:1105-1130`
("What ProxyPilot runs FOR you after you finish") currently says **"do not write
throwaway curl/psql round-trips to prove the app works end to end"** (1122) and
"do not boot the server by hand". Left alone, that directly contradicts the new
tools and the model will obey the older, more specific instruction.

Rewrite that clause to preserve its intent (don't hand-roll a deploy) while
carving out observation:

> `- Do not boot the server by hand or hand-roll a deploy to prove the app works end to end — ProxyPilot deploys and smoke-tests after you finish. DO use http_probe and browser_probe to OBSERVE the running app while you work: that is diagnosis, not deployment, and it is how you find a cause instead of guessing at one.`

Keep the surrounding definition of "Verified" (that you read the source this
cycle) and **extend** it: an observation through a probe also counts as verified,
provided the summary names what was observed.

**(c) `describeRunnerStep`** (1349-1369): add labels so probes read clearly in
the cycle feed — `http_probe` → `probing the API`, `browser_probe` → `looking at
the page`.

## B1.7 Wiring decisions, stated

1. **Not read-only.** Do **not** add either tool to `READ_ONLY_TOOLS` (279).
   They are side-effecting (a probe can POST; `working` restarts a service) and
   must not run concurrently with each other via
   `groupToolCallsForExecution` (293).
2. **Available on fast lanes.** `runnerToolsForCycle` (309) strips `run_gates`
   for quick/MVP. Probes must stay — the quick lane is where the repeat-fix
   sagas happen.
3. **Copilot harness inherits them.** `COPILOT_TOOLS`
   (`harness-copilot.js:122`) auto-includes anything not in `COPILOT_DROP`
   (115). Leave them in: the copilot benefits equally. State this in the commit
   message so it is a decision, not an accident.
4. **No schema change** to `schemas/build-outcome.schema.json` — that file
   enumerates *terminal* tools; these are observational.

## B1.8 Tests

**`admin/backend/src/__tests__/mock2-probe-logic.test.js`** — pure, native-free:

```
test('httpProbePlan: requires an explicit target')
test('httpProbePlan: rejects a path that does not start with /')
test('httpProbePlan: rejects an absolute URL (:// anywhere)')
test('httpProbePlan: rejects a protocol-relative path (//evil.example)')
test('httpProbePlan: rejects a header value containing a newline')
test('httpProbePlan: uppercases the method and defaults to GET')
test('browserProbePlan: caps selectors at 10')
test('shellQuote: wraps in single quotes and escapes embedded quotes')
test("shellQuote: a path of '; rm -rf / #' survives as one literal argument")
test('probeBudget: allows up to the cap, then returns the redirect message')
test('formatHttpProbeResult: the first line names which target was probed')
test('formatBrowserProbeResult: the first line names which target was probed')
test('formatHttpProbeResult: caps the body and says how much was dropped')
```

**Extend `admin/backend/src/__tests__/mock2-cycles.test.js`** (its
`RUNNER_TOOLS` block is at 153-160):

```
test('RUNNER_TOOLS: http_probe and browser_probe are present and well-formed')
test('the probe tools are NOT in READ_ONLY_TOOLS (they are side-effecting)')
test('runnerToolsForCycle keeps the probes on the quick lane')
```

**New `admin/backend/src/__tests__/mock2-observation-prompt.test.js`**, following
`mock2-build-contract.test.js`:

```
test('OBSERVATION_SECTION rides BOTH prompt builders verbatim (no drift)')
test('the prompt no longer forbids probing the running app')
  — assert.doesNotMatch(sys, /do not write throwaway curl/i)
  — assert.match(sys, /http_probe|browser_probe/)
```

That second assertion **fails on today's tree** — the regression fixture.

**New `admin/backend/src/__tests__/mock2-browser-probe.e2e.test.js`**, following
the skip-when-Playwright-absent pattern of `mock2-ui-checks.e2e.test.js`. Fixture
app: one static page with `.popover-menu { display: none }` on an element that is
present in the DOM, plus a route returning 500.

```
test('browser_probe reports computed display:none for a present-but-hidden element')
  — the docs2 .popover.menu regression fixture: five cycles of reasoning
    missed what one probe returns
test('browser_probe collects a console error thrown on page load')
test('http_probe returns the 500 status and the body excerpt')
```

## B1.9 Acceptance checklist — B1

- [ ] `probe-logic.js` added with all seven exports
- [ ] `browser-probe.js` added; `AUTOMATION_CONTEXT`, `gotoStable`, `loginAs` **exported** from `ui-checks.js` and imported (not copied)
- [ ] Both tools in `RUNNER_TOOLS` with `input_schema`, `target` required
- [ ] `executeTool` gains both cases; `webPort` threaded through **all four** call sites
- [ ] `restartDevFromWorkingTree` added; `deployStage` untouched
- [ ] Per-cycle cap enforced with the redirect message
- [ ] `OBSERVATION_SECTION` in both prompt builders; the contradicting curl clause rewritten
- [ ] `describeRunnerStep` labels added
- [ ] `harness-safety.js` **unchanged** — confirm and state it in the commit message
- [ ] All test files added; the prompt-contradiction test failed before and passes after

---

# B2 — Cap symptom-chasing at two attempts

**Do not start B2 until B1 is merged and exercised on one real project.** A cap
without observation escalates to a human with a list of ruled-out theories; a cap
with observation escalates with evidence.

## B2.1 What exists, and why none of it has run

| Piece | Location | State |
|---|---|---|
| `consultTrigger` | `consult-logic.js:52` | complete |
| `consultAllowed`, caps | `consult-logic.js:63`, `42-43` | complete |
| `MOCK2_CONSULT` | `consult-logic.js:21` | **defaults OFF** |
| `gateFailStreak` | `runner.js:1577`, incremented `3101` | **within-cycle only** |
| `reHaltSameReason` | read at `runner.js:3662` | **dead — never fed** |
| `diagnose-logic` | complete | fires **only** from smoke failure (`runner.js:410`) |

The sole `haltCycle` call site that passes signals (`runner.js:1966`) sends
`consultSignals: { gateFailStreak }`. `reHaltSameReason` is therefore always
`false` and `'same_reason_rehalt'` has never fired in production.

Cycles carry `request_id` and `segment` (`migrations.js:659-692`), so cross-cycle
state is **derivable at read time**. Do not add a migration.

## B2.2 Normalisation and the attempt counter

Add to **`consult-logic.js`** (it already owns the trigger vocabulary):

```js
// A halt reason reduced to its stable core, so "blocked: cannot read foo.ts at
// line 42" and "blocked: cannot read foo.ts at line 88" are recognised as the
// same wall. Deliberately aggressive: digits, hex, quoted spans and paths carry
// the incidental detail; what remains is the shape of the blocker.
export function normalizeHaltReason(reason)

// Was this request already halted for the same reason?
export function reHaltSameReason({ reason, priorReasons = [] })

// How many prior cycles in this request attacked the same symptom?
export function symptomAttemptCount({ instruction, priorInstructions = [] })

export const SYMPTOM_CAP = 2;   // the third attempt does not build
```

`normalizeHaltReason` steps, each individually tested:
1. lowercase, collapse whitespace;
2. strip quoted spans (`'…'`, `"…"`, `` `…` ``);
3. replace digit runs with `#`;
4. replace path-like tokens (containing `/` and a `.`) with `<path>`;
5. trim to 200 chars.

`symptomAttemptCount` reuses the same normalisation over instructions and counts
prior entries whose token-overlap exceeds 0.6. **Reuse `payloadSimilarity` from
`finish-guard-logic.js:210`** rather than writing a second similarity function —
export it if it is private.

## B2.3 Feeding the signal

At `runner.js:1966`, replace the signal object:

```js
consultSignals: { gateFailStreak, reHaltSameReason: priorHaltReasons.length > 0 && reHaltSameReason({ reason: decision.haltReason, priorReasons: priorHaltReasons }) }
```

`priorHaltReasons` is derived once near the top of the cycle run from the sibling
cycles of this `request_id` — their `error` column where `halt_reason` is
non-null. Add a small reader beside the existing cycle queries in `cycles.js`:

```js
export function listCyclesForRequest(requestId)   // if absent; routes.js already uses one
```

Apply the same `consultSignals` shape at the other `haltCycle` call sites that
currently pass none (`runner.js:1909, 1982, 2085, 2125, 2150, 2468, 2599, 3066`).
A single `haltSignals()` closure defined once in the run scope keeps this to one
line per site.

## B2.4 The third-attempt escalation

Intercept in **`startBuild`** (`audit.js:229`), between the readiness guards
(ending 257) and `insertRequest` (262) — refusing after 262 orphans a request row.

When `symptomAttemptCount(...) >= SYMPTOM_CAP` for the incoming instruction
against the project's recent cycles:

1. **Do not create a cycle.**
2. Run the existing `diagnose-logic` pass against the most recent failed attempt's
   evidence — its changed files, its finish summary, and (new, from B1) any probe
   observations recorded in that cycle's events.
3. Post the diagnosis to chat via `insertMessage({ kind: 'system', … })` using
   `diagnosisChatMessage`, prefixed with what has been ruled out:

> **Third attempt at the same symptom — diagnosing instead of building.**
> Two builds have already tried this and the symptom persists. Rather than pay
> for a third guess, here is a root-cause diagnosis of the last attempt.
> *Ruled out so far:* `<one line per prior attempt's summary>`
> *(then the ROOT CAUSE / WHY / FIX INSTRUCTION block)*
> Send the FIX INSTRUCTION above to build from the cause, or press Build again to
> override.

4. Return `{ status: 'refused', error: 'third attempt at the same symptom — diagnosed instead of built' }`.
   The route layer already renders a `'refused'` as `200` with a reason
   (`routes.js:3445-3447`).

**Override must exist.** A repeat instruction sent within 10 minutes of a
diagnosis message bypasses the cap — the operator has seen the diagnosis and
chosen to proceed. Without this the cap becomes a wall.

## B2.5 Flag matrix — stated explicitly

The two escalations have different costs and get different defaults:

| Escalation | Model | Cost | Flag | Default |
|---|---|---|---|---|
| Third-attempt diagnosis | review tier (`diagnose-logic`) | ~$0.10–0.25 | `MOCK2_SYMPTOM_CAP` | **on** |
| Frontier consult | `MODEL_FRONTIER` | frontier-priced | `MOCK2_CONSULT` | **off, unchanged** |

The diagnosis is cheaper than the build it replaces, so defaulting it on is
strictly cost-reducing. The consult is not, so it stays opt-in.
`MOCK2_SYMPTOM_CAP=off` disables the cap entirely; the cap must fail open on any
error in the matcher or the diagnosis call.

## B2.6 Tests

**`admin/backend/src/__tests__/mock2-symptom-cap.test.js`** — pure:

```
test('normalizeHaltReason: digits and paths collapse to placeholders')
test('normalizeHaltReason: two halts differing only by line number normalise equal')
test('reHaltSameReason: returns true for a repeated wall')
test('reHaltSameReason: returns false for a genuinely different blocker')
test('consultTrigger returns same_reason_rehalt when a request re-halts the same way')
  — REGRESSION FIXTURE: cannot pass today, the signal is never fed
test('symptomAttemptCount: three near-identical instructions count as three attempts')
test('symptomAttemptCount: a different instruction on the same file does not count')
test('SYMPTOM_CAP: the third attempt is refused, the first two are not')
test('the cap fails open when the matcher throws')
```

Use the run-taxonomy report's real sagas as fixtures: the `docs2` export-menu
instructions (5 attempts) must trip at the third; `convert`'s ffmpeg-then-CORS
sequence describes *different* symptoms and must **not** trip.

## B2.7 Acceptance checklist — B2

- [ ] B1 merged and exercised first
- [ ] `normalizeHaltReason`, `reHaltSameReason`, `symptomAttemptCount`, `SYMPTOM_CAP` in `consult-logic.js`
- [ ] `payloadSimilarity` reused (exported if needed), not reimplemented
- [ ] `reHaltSameReason` fed at every `haltCycle` call site via one `haltSignals()` closure
- [ ] Third-attempt intercept in `startBuild` between lines 257 and 262
- [ ] Diagnosis posts ruled-out list + FIX INSTRUCTION; returns `'refused'`
- [ ] Override path works (repeat within 10 min of a diagnosis)
- [ ] `MOCK2_SYMPTOM_CAP` on by default; `MOCK2_CONSULT` unchanged
- [ ] Fail-open verified by test
- [ ] The `same_reason_rehalt` regression fixture failed before and passes after

---

# Verification for Spec B

```bash
cd admin/backend
npm test
node --test src/__tests__/mock2-probe-logic.test.js
node --test src/__tests__/mock2-observation-prompt.test.js
node --test src/__tests__/mock2-symptom-cap.test.js
node --test src/__tests__/mock2-browser-probe.e2e.test.js   # skips without Playwright
```

**Operator-visible check.** On a project with a known UI defect, send the symptom
in plain language. The cycle feed should show *looking at the page* before any
edit, and the change record's `assumptions.verified` should name what was observed
(a computed style, a status code) rather than asserting a mechanism. Compare
cycles-to-green against the same defect on the pre-B1 harness.
