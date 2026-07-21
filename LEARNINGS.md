# Harness learnings registry

The ratchet principle: **every human-caught defect becomes a template, a
rule, or a machine check** — so each failure class can only happen once.
When a human review finds a defect in generated output, triage it into one
of those three destinations and record it here (project of origin, defect,
mechanism, and what now prevents it). A learning that lives only in chat
history prevents nothing. `HARNESS-INVESTIGATION.md` holds the full
evidence trail for the project-32 batch.

| # | Origin | Defect | Mechanism | Prevented by |
| --- | --- | --- | --- | --- |
| 1 | Project 32 (Spec Ops Hub) | Shipped app had zero edit/delete capability — permanent workflow dead ends (barrier task could never unblock) | Extractor told to be literal; static mockups can't show mutation flows; nothing compensated | **Machine check + template:** `completeInventoryCrud` adds implied edit/delete/status actions (marked inferred) at approval; `lintInventory` warns on suspicious shapes; extraction prompt's MUTATION COVERAGE rule |
| 2 | Project 32 | Demo-pressed "Blocked" chip recorded as the default state and shipped that way | Inventory had no default-vs-demonstrated structure; mockups had no annotation channel | **Template + rule:** `data-demo-state` annotation contract in the mockup renderer; required `default_state` per screen; lint flags screens without one |
| 3 | Project 32 | MVP build skipped exactly the Define step that owns editability rules | `isFastBuildMode` fast path: zero-cost define segment, no floor | **Rule:** standard CRUD rules pack (`rules-pack-logic.js`) injected into every fast build as a binding floor; inventory/instruction outrank explicit deviations |
| 4 | Project 32 | Inventory actions could be silently dropped by the build (nothing diffed contract vs shipped) | No parity check between inventory and implementation | **Machine check:** action-parity finish gate — every mutation action must be surfaced in UI source (implemented or visibly badged "Not built yet"); silently-missing rejects the finish |
| 5 | Project 32 | Anomaly tripwire fired after deploy, as a note — the under-verified change was already live | Tripwire ran post-`finishCycle`, "never blocks" by design | **Machine check:** `anomalySignals` now runs before deploy and HOLDS it (flag + "review, then press Deploy"); previous deploy keeps serving |
| 6 | Project 32 | Authored acceptance scenarios were never executed — smoke ran a generic pass | Finish acceptance was prose; the `requiredIds` execution path existed but nothing fed it from the builder side | **Machine check:** finish `acceptance_ids` → checks added to `state/ui-checks.json` are hard-executed against the deployed app; an undefined id fails smoke |
| 7 | Project 32 | Diff-accurate summary rejected by the over-claim detector (brace shorthand, slash-joined lists, word runs) | Low-precision path-claim extractor | **Machine check (fixed):** brace expansion, file-list splitting, prose-run rejection, directory-prefix coverage; the exact rejected summary is the regression test |
| 8 | Projects 25–27 (earlier) | Baked-in dark/neon theme overrode per-project design specs ("geometry obeyed, color ignored") | Locked design system + "obey EXACTLY" prompt + prior-mockup style inheritance | **Template + rule:** brief-outranks-system precedence; restyle briefs strip inherited styles and render at full depth; light-first token design system v2 |
| 9 | Projects 25–27 (earlier) | Generated mockups shipped layout defects (overlapping columns, unfilled bars) that only human review caught | Design bar was prose-only | **Machine check:** `mockup-checks-logic.js` battery on every saved render (tokens-only colors, themes+toggle, data-bound bars, canonical rows, detail bands, computed AA) + `scripts/verify-mockup.mjs` runtime layout checks |
| 10 | Project 33 (Spec Ops Hub v2) | Theme/empty-state mockup sections became standalone screens; each burned a full per-screen build (a dark-mode COPY shipped as its own route with a second theme switch) | Extractor splits every section into a screen; screen plan fans out per screen | **Template + machine check:** SCREEN SECTIONS contract forbids variant sections; `mergeVariantScreens` folds "(Light)/(Dark)/(Empty)/…" into the base screen at approval AND at plan time |
| 11 | Project 33 | Anomaly tripwire held all six feature deploys as 'bugfix' cycles (false-positive storm) | Stale `state/acceptance.json` from an earlier bugfix cycle persisted in the working tree and fed `acceptanceRecord`'s kind | **Machine check (fixed):** a spec the cycle didn't write never feeds the record/tripwire kind; held deploys log the hold instead of a false "No run contract" |
| 12 | Harness Controls session (budget removal) | `modelMaxOutputTokens is not defined` at runtime — a paid design turn failed on the Notes project | Helper wired into concept.js without its import; `node --check` can't see undefined identifiers, and the sandbox can't import concept.js (better-sqlite3) so no test executed the path | **Machine check:** `mock2-import-check.test.js` — native-free static scan: any mock2 module that CALLS a listed cross-module helper must import or declare it; the original defect shape is the regression case |
| 13 | Notes project (annotate screenshot) | Opening the annotate-on-screenshot dialog crashed the backend — the operator's running 4-hour build was marked "orphaned by restart" and failed | `captureOneScreenshot` launches Playwright in the backend process; Node exits on any unhandled async rejection, and the backend had no global handlers, so one stray driver error killed the server mid-build | **Rule + machine check:** global `unhandledRejection`/`uncaughtException` log-and-keep-serving net in index.js (registered before listen); `backend-safety-net.test.js` asserts it stays; Chromium launches now run `--disable-dev-shm-usage --disable-gpu` with a 30s launch timeout |
| 14 | Notes project (annotate screenshot, root cause) | design-review.js could never LOAD: it shipped importing `costCentsForUsage` from usage-logic.js (lives in quota-logic.js) and `effectivePrice` (lives in connectors.js) — every dynamic import rejected, which crashed the backend pre-net (#13) and hung the dialog after; four rounds of timeout hardening were treating the symptom | The module was only ever imported dynamically, the sandbox can't load it (better-sqlite3 chain), and no static check verified that named imports exist in their source module | **Machine check:** `mock2-import-check.test.js` now verifies every same-dir named import resolves to a real export (template-factory files excluded — their template strings embed the generated app's own imports); the broken import is fixed at the source |

## Triage guidance (binding for future findings)

When a human review catches a defect in generated output:

1. Name the failure class, not the instance.
2. Pick the destination — **template** (the generator can no longer produce
   the shape), **rule** (a binding instruction/rules-pack line), or
   **machine check** (a gate/linter that catches it before a human would).
   Prefer them in that order; prose guidance alone is not a destination.
3. Land it with a test that encodes the original instance, and add a row
   here.
