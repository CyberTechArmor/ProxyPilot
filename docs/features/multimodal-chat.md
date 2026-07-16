# Multi-modal chat — image attachments (paste / drag / +)

Migration 526. Every mock2 composer accepts images alongside text: the
**concept/design chat** (design references, screenshots of apps to imitate),
the **build composer** (screenshots of the bug to fix), and the **ask lane**
(a screenshot or an API-doc capture with the question). Attach by **pasting**
into the message box, **dragging** a file onto it, or the **+** button.

## The efficiency pipeline

Every stage is sized so images stay cheap:

1. **Browser downscale first** (`admin/frontend/src/lib/chat-images.js`):
   before anything is uploaded, the image is resized to at most **1568px on
   the long edge** — the vision models' token sweet spot (≈1.1–1.6k tokens per
   image; larger inputs cost up to ~3× the tokens for little gain) — and
   re-encoded WebP (JPEG fallback; small PNGs stay PNG; animated GIFs ≤2MB
   pass through). A 12MB phone photo leaves the browser as ~150–400KB.
2. **Server re-validation** (`chat-image-logic.js`): media-type allowlist
   (JPEG/PNG/WebP/GIF — never SVG), ≤4 images per message, ≤2.5MB decoded per
   image, base64 integrity. A bypassed client can't stuff megabytes into a
   model call. The three routes get a 16MB body limit; the global 1MB default
   is untouched.
3. **Disk storage, content-addressed** (`chat-images.js`): bytes land ONCE at
   `MOCK2_DATA_DIR/chat-images/<projectId>/<sha256>.<ext>` (re-pasting the same
   screenshot dedupes); DB rows carry only small descriptors
   (`attachments_json`: `[{id, bytes, name}]`) — never base64 in SQLite.
4. **Immutable serving**: `GET /api/mock2/projects/:id/chat-images/:imageId`
   (viewer-gated) responds `Cache-Control: immutable` — the browser downloads
   each thumbnail exactly once.
5. **Bounded transcript replay**: in the design chat, only the
   **6 most recent** images ride the model transcript as real image blocks;
   older attachments become a stable one-line placeholder. The Anthropic
   prompt cache then makes the replayed images ~0.1× cost after their first
   turn (the transcript renders byte-identically between turns).

## Where the images go

| Surface | Model calls that see the images |
| --- | --- |
| Concept/design chat | The design-partner turn (with bounded history replay) **and** the mockup render — a pasted design reference directly shapes the generated mockup |
| Build composer | The define **audit** call, and the **build runner's first task turn**. Images attach to the *request* row, so a build deferred behind rule questions — or resumed later — re-hydrates the same images |
| Ask lane | The ask's first turn (an ask is a fresh transcript, so they're paid for once) |

Provider mapping (`model-client.js`): Anthropic `image` blocks, OpenAI-compatible
`image_url` data URIs, Gemini `inlineData` — all with images before text (the
recommended vision order). Ollama models without vision reject the call with a
normal model error. Images never enter the project container.

## UI

- Composers: paste/drop onto the textarea or use **+**; thumbnails preview
  with tap-to-remove (44px+ targets, MOBILE_FIRST) before sending.
- Chat bubbles render attachment thumbnails (click opens full size).
- Build resume mode doesn't offer images (a resume message carries none — the
  original request's images already re-hydrate onto the resumed cycle).

## Files

- `admin/backend/src/mock2/chat-image-logic.js` — pure validation/planning
  (tested: `src/__tests__/mock2-chat-images.test.js`).
- `admin/backend/src/mock2/chat-images.js` — disk half + transcript hydration.
- `admin/backend/src/mock2/model-client.js` — per-provider image blocks.
- `admin/backend/src/mock2/{concept,ask,audit,runner}.js` — lane wiring.
- `admin/frontend/src/lib/chat-images.js` — client downscale/encode.
- `admin/frontend/src/components/mock2/ImageAttachments.jsx` — composer hook + bar.

## Known limits

- The SDK build runner (`BUILD_RUNNER=sdk`, flag-off by default) does not yet
  forward task images.
- Chat images are not part of backup packs (they are conversation context,
  not app state); a restored project simply shows missing thumbnails for old
  messages.
