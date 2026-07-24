# Flightdeck — build-phase IDE workspace

Flightdeck is the Copilot-style IDE shown in the Projects **build phase** (after
the mockup) and set as the **default** build view. It models the VS-Code-class
experience — AI build chat, file explorer, code editor, integrated terminal, and
an optional preview — over a single shared project sandbox.

Name: one constant `WORKSPACE_NAME = 'Flightdeck'` in
`admin/frontend/src/lib/flightdeck.js`. No "VS"/"VSCode" strings in the UI.

## One shared workspace (reuse, don't rebuild)

Flightdeck is an **assembly of existing instruments**, not a new agent:

- **AI chat (right)** — the existing `BuildChat` component, which already fronts
  the build harness (`startCycle` / Ask) with live token streaming. Model
  routing, cost caps, safety, and self-correcting edits come for free.
- **Terminal (bottom)** — the existing `ProjectTerminal` (node-pty + xterm over
  WebSocket, scoped to the project's container at `/srv/app`, editor-gated).
- **Preview (center tab)** — the existing `ProjectPreview` (`PreviewPanel` /
  `LiveAppBar`).
- **Editor (center)** — CodeMirror (already in the stack; the repo ships
  `@uiw/react-codemirror` + language packs). *Deviation from the original
  spec's Monaco* — chosen to reuse the installed editor and avoid a second heavy
  editor dependency; no "VS" branding either way.
- **File explorer (left)** and the **file API** are the only genuinely new
  pieces.

Because the editor, tree, and terminal all operate on the **same container
sandbox** the agent edits, an agent edit shows up live in the editor (external-
change reconciliation) and the tree (refresh on cycle activity).

## Placement, default, deep-link

`ProjectDetail.jsx` renders `<Flightdeck>` by default when a project is in the
build phase (`design_approved`), with a **Classic view** toggle to the original
`BuildMode`. The choice is remembered per project (`localStorage`
`mock2:flightdeck:<id>`) and deep-linkable via `?view=classic` / `?view=flightdeck`.

## Backend file API (the new piece)

`admin/backend/src/mock2/flightdeck.js`, mounted on the mock2 router, operates on
the project **container** (`incus exec`, reusing the runner's base64-wrapped host
round-trip — no host FS bytes):

| Method | Path | Role |
|---|---|---|
| GET | `/projects/:id/flightdeck/tree` | viewer |
| GET | `/projects/:id/flightdeck/file?path=` | viewer |
| PUT | `/projects/:id/flightdeck/file` | editor |
| POST | `/projects/:id/flightdeck/create` | editor |
| POST | `/projects/:id/flightdeck/rename` | editor |
| DELETE | `/projects/:id/flightdeck/file?path=` | editor |

Pure logic in `flightdeck-logic.js` (unit-tested): `safeRelPath` traversal guard,
`find`-listing parse + tree assembly (dirs-first; noise dirs kept-but-muted),
language-by-extension, binary/large-file guards.

## Security (cid-security)

- **AuthZ on every call** — inherits `authenticateToken` + `blockPendingRole` +
  CSRF + rate-limit from the mock2 mount; each route adds `requireMock2Role`
  (viewer read / editor write) + `refuseIfArchived`; container must be online.
- **Path safety** — every path funnels through `safeRelPath` (rejects
  absolute / `..` / NUL); container payloads base64-decode paths in-shell so
  nothing user-supplied is interpolated raw.
- **Sandbox** — all file/terminal/agent work runs inside the project's fenced
  container, never the host. Provider keys stay server-side (the chat sends only
  a model id). Terminal output is secret-redacted by the existing PTY layer.
- **Audit** — every write is `logAudit`-ed (`MOCK2_FLIGHTDECK_*`).
- WS auth (terminal) reuses `verifyWsUpgrade` (pp_token cookie) + the per-project
  authorizer, unchanged.

## Streaming model

ProxyPilot has **no SSE/WebSocket for chat/build** — the whole app streams by
**polling in-memory job snapshots** (`setJob`/`getCycleJobStatus`, whose `partial`
field is fed by server-side `onDelta`). Flightdeck follows suit: the chat reuses
`BuildChat`'s poll, and the file tree/editor re-fetch on demand and on cycle
activity. The terminal is the one true WebSocket, reused as-is.

## Persistence

Per project (`localStorage`): panel sizes + collapse state
(`mock2:flightdeck-layout:<id>`) and the view choice (`mock2:flightdeck:<id>`).
Chat history and model selection persist server-side (existing behavior).

## Not verified in this build

The frontend was authored to the repo's conventions but **could not be compiled
or run here** (no frontend `node_modules` in this environment; node-pty/xterm are
native/already-installed on real hosts). The backend file API and its pure logic
are unit-tested; the full IDE experience needs a real frontend build to verify.
