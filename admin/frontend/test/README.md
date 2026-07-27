# Phone-studio browser checks

There is no unit-test runner for the frontend, and two phone regressions in a
row got through review because the reasoning about Radix/Tailwind layout was
wrong — a component tree can be correct on paper and still render nothing.

These drive the REAL built SPA in a real browser at phone width:

```bash
npm run build
node test/ui-harness.mjs &            # STAGE=design (default) or STAGE=build
EXPECT_MODAL=1 node test/phone-studio-check.mjs
```

`ui-harness.mjs` serves `dist/` and stubs `/api/*` with one fixture project, so
no database, no auth and no containers are involved. `phone-studio-check.mjs`
asserts what MOBILE_FIRST.md's pre-merge checklist asks for on the surfaces that
have actually regressed:

- the assets modal appears (and is answerable) on a phone,
- the workspace bottom bar carries onto the Details page,
- the bar is on screen at the bottom rather than below the fold,
- tapping a panel returns from Details,
- no horizontal page scroll.

`design-chat-activity-check.mjs` drives a LIVE design turn (`JOB=live`) whose
narration advances and whose streamed reply grows, and asserts the design chat
narrates and follows the way the build chat does: an accumulating timeline
rather than one line each phase overwrites, following the newest content,
pausing when the reader scrolls up, and resuming when they come back. Start a
FRESH harness for it — the narration counter is per process, so a reused one
begins past the phases it looks for.

Run the phone-studio check in BOTH stages — `STAGE=design` (mockup workspace) and `STAGE=build`
(Flightdeck). The Details-bar bug existed in one and not the other, which is
exactly the kind of gap a single-stage check misses.
