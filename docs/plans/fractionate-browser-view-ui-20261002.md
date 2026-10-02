# Browser view UI release — 2026-10-02

The Browser pane can enter native fullscreen, with a fixed viewport fallback when the browser refuses that API. The existing video element, viewer and control transport remain mounted. Escape and Exit restore keyboard focus. Run metadata, practice badges, starter/time/guide, control explanations and operation status move below the viewport into the Browser information area. The title/state/actions row remains compact. Ended sessions show their recorded outcome without a current pending-approval banner.

Operations uses a fixed viewport shell. Browser content, Activity, Details, project content and project lists scroll inside their panes. Keyboard users can focus bounded scrolling regions. Other dashboard pages keep their existing scrolling behavior.

Based on shipped main `9b88f8f03925ee4c4cf097e40429897be9195e2f` (PR724). This slice changes frontend presentation only. The broader selected-site browser executor, hard-rule parser, host setup, credentials and backend APIs are separate work.

## Evidence

- Production Vite build passed; existing chunk-size/dynamic-import warnings remain.
- Existing `agent-run-deck.test.js` and `agent-live-client.test.js`: 8/8 passed.
- Actual Layout + RunDeck/project/detail fixtures: no document scroll or horizontal overflow at 360,375,768,1280,1920px, including reload. Eight fullscreen cycles test actual640px resize, Escape/Exit/focus restore; API refusal fallback and frame dialog Escape pass. Three mock live viewer cycles keep the same video node and one connection. Ended-session approval suppression passes. Native and fallback fullscreen Give back opens the production portaled confirmation after exiting fullscreen; Cancel preserves the controller, same video/viewer and trigger focus. Populated help and eight reconciliation decisions retain internal scrolling at360×640,375×667,768×640,1280×640 and1920×800. Actual approval digest entry/Cancel passes at each size; keyboard scrolling and reload pass at375×450. No page errors.
- Mobile Lighthouse accessibility: 100 for deck, project and project index. Audit timestamps are retained; these numerical audits preceded the final metadata move. Frozen-source behavior verification was rerun after that move.
- [Verification report](evidence/browser-view-20261002/verification.json), [source and artifact hashes](evidence/browser-view-20261002/manifest.json), [375px screenshot](evidence/browser-view-20261002/phone-375.png), [1280px screenshot](evidence/browser-view-20261002/desktop-1280.png).

The initial resize report is retained as `verification-superseded.json`: its helper reset the requested height to900px. It is superseded by revision2, which records actual heights. The corrected frozen code was built and behavior-checked again. The keyboard assertion waits for Chromium to finish its bounded scroll animation before reading the result; both this slice and the broader integrated UI pass the same check. [Give back at375×640](evidence/browser-view-20261002/give-back-375x640.png) and [populated review at375×640](evidence/browser-view-20261002/populated-review-375x640.png) show the corrected cases.

Reference Library identities are preserved in the manifest. The parent inspected the actual source images and supplied the precise annotated placement. Signed materialization downloads repeatedly failed in this worker's saved cloud environment; it did not claim to inspect those unavailable originals. The root inspected actual locally rendered fixture screenshots. The retained frame and Neko viewer are scripted test fixtures, not proof of live production video or a connected external browser.

## Reproduce

```sh
cd admin/frontend
npm ci
npm run build
cd ../..
node --test admin/backend/src/__tests__/agent-run-deck.test.js admin/backend/src/__tests__/agent-live-client.test.js
```

For the viewport fixture, start Vite on port5178. Install `playwright-core` and `@axe-core/playwright` in a disposable tools directory, set `BROWSER_TEST_TOOLS` to it, then run `node admin/frontend/tests/operations-viewport-check.mjs`. The checker uses `/usr/bin/chromium` and contacts only the local fixture. No production browser task, deployment or host mutation was performed.
