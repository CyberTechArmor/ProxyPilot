# LXC Workspace — Flightdeck's files/editor/preview/terminal on a container

The container dialog (LXC → a container → **Workspace**) is the Flightdeck
workspace over one operator container: file explorer, CodeMirror editor,
live preview of the container's published route, and the PTY — everything
Flightdeck has except the build chat. It replaced the dialog's separate
**Terminal** and **Files** tabs (2026-09); anything that still opens the
dialog on `terminal` or `files` lands on `workspace`.

## Reuse, not a rebuild

| Instrument | Flightdeck (Projects) | LXC Workspace | Shared code |
|---|---|---|---|
| Explorer | `FlightdeckFileTree` over `mock2FlightdeckFs(projectId)` | same component over `lxcWorkspaceFs(name, root)` | `components/mock2/FlightdeckFileTree.jsx` |
| Editor | `FlightdeckEditor` | same component | `components/mock2/FlightdeckEditor.jsx` |
| Preview | `PreviewPanel` on the project URL | `PreviewPanel` on `https://<domain><pathPrefix>` of the container's route(s) | `components/mock2/ProjectPreview.jsx` |
| Terminal | `/api/terminal/mock2/:id` | `/api/terminal/lxc/:name` (unchanged) | `components/InteractiveTerminal.jsx` |
| Narrow bottom bar | `MobilePanelBar` | same | `components/mock2/MobilePanelBar.jsx` |
| File API | `mock2/flightdeck.js` at `/srv/app` | `routes/lxc-workspace.js` at an operator-chosen root | `mock2/flightdeck-logic.js` (tree, find, language, binary guard) |

The tree and editor talk to files through one small adapter interface
(`admin/frontend/src/lib/flightdeck.js`: `tree / read / save / create /
rename / remove`, plus a `key` whose change means "different files"). That is
the whole seam: `FlightdeckFileTree` and `FlightdeckEditor` take `fs=` and
fall back to the Mock2 adapter when given `projectId`, so Flightdeck itself is
unchanged.

## The root

A project sandbox has a fixed app directory; an operator's LXC does not. The
workspace is rooted at an **absolute directory inside the guest**, remembered
per container in the browser (`lxc:workspace-root:<name>`). With nothing
remembered the backend picks: the registered startup unit's working directory
→ `/opt/app` → `/srv/app` → `/var/www` → `/root` (first that exists). The
folder button in the explorer header opens another directory. Every relative
path is joined onto the root through Flightdeck's `safeRelPath` guard, so
nothing can reach above it; the root itself is validated by `validAbsDir`
(`lib/lxc-workspace-logic.js`, unit-tested in `__tests__/lxc-workspace.test.js`).

## API (`/api/lxc/containers/:name/workspace/*`)

Registered on `lxcRouter` after its `requireProxyAccess` gate, so the same
people who could use the old Files tab can use this. Guest paths ride as
`sh -c` positional parameters, never interpolated; file bytes go over
stdin/stdout only.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `workspace/tree?root=` | `root` optional | `{ root, tree }`; without `root` the default is resolved and echoed |
| GET | `workspace/file?root=&path=` | | 404 not a file, 413 > 2 MB, 415 binary |
| PUT | `workspace/file` | `{ root, path, content }` | creates parent dirs; audit `LXC_WORKSPACE_SAVE` |
| POST | `workspace/create` | `{ root, path, type: file\|dir, content? }` | 409 if it exists |
| POST | `workspace/rename` | `{ root, from, to }` | 404 / 409 |
| DELETE | `workspace/file?root=&path=` | | recursive for folders; never the root |

Upload, ZIP upload (two-phase, with optional startup script) and download keep
using the existing `/files/upload`, `/zip-upload` and `/files/download`
routes; the explorer header and row menu (right-click, or the `⋯` button on a
touch screen) expose them.

## Layout

- **lg+**: explorer | editor/preview tabs over a docked, resizable terminal;
  the terminal can go full-height, the preview can take the terminal's space.
- **< lg**: one panel at a time — Files / Editor / Preview / Terminal — from
  a ≥44 px bottom bar. All four stay mounted (CSS-hidden), so open tabs,
  unsaved edits and the PTY survive a panel switch.
- The dialog force-mounts the tab and CSS-hides it, so a trip to **Details**
  keeps the shell alive; it mounts lazily on the first visit, so opening the
  dialog for Details never dials a PTY. The whole component is a lazy chunk
  (CodeMirror + xterm stay out of the page bundle).
- "Open terminal here" on a folder reconnects the shell in that directory.
- Saving a file bumps the preview's reload key.
- The explorer header has **up one directory** (parent of the root) and
  **open another directory**, which is a dialog (full-screen below `sm`) with
  the conventional roots as one-tap suggestions — not the browser's `prompt`.
- Below `lg` the terminal carries a key bar (`InteractiveTerminal
  mobileKeys`): Tab, Esc, ^C, ^D and the arrows — keys a phone keyboard cannot
  type. Tab sends two tabs, so one tap completes a unique prefix and lists
  the candidates (readline's double-tab), i.e. it shows suggestions. The
  buttons cancel `pointerdown` so the on-screen keyboard stays up.
- The preview iframe delegates device permissions (`allow="camera;
  microphone; display-capture; …"` + `allowFullScreen`), so an app that asks
  for the camera — a video meeting — gets the browser's prompt instead of an
  automatic denial. The user still decides at the prompt.

## Preview framing

Every rendered site file used to pin `X-Frame-Options: SAMEORIGIN`, so the
dashboard itself was refused ("<domain> refused to connect"). Since 2026-09
the site header block, when the admin domain is known, allows exactly one
extra embedder — the ProxyPilot dashboard (`siteSecurityHeaderLines` in
`lib/caddy-site-file.js`): `X-Frame-Options` is dropped, an app's own
`frame-ancestors` is rewritten to `'self' https://<admin-domain>`, and a
`Content-Security-Policy: frame-ancestors 'self' https://<admin-domain>`
header is always added (multiple CSP headers intersect, so an app without one
is still fenced). No third-party site can frame the app; this is the same
scoped allowance the Mock2 module gives project apps for the Flightdeck
preview. The operator's per-route `allowFraming` / `frameAncestors` escape
hatch still wins when set.

Site files are a cache of the route table, so a renderer change reaches
existing files through the **render contract**: `CADDY_SITE_RENDER_CONTRACT`
is compared with `app_settings.caddy_site_render_contract` at boot and, when
different, every managed domain is regenerated once (validated, reloaded,
reverted on failure) via `regenerateAllSiteConfigs` — the same function behind
`POST /api/services/caddy/regenerate-all`.

## Terminal working directory

The LXC shell's starting directory is a guest path, so it is applied inside
the guest (`lib/pty-logic.js` → `sh -c 'cd "$1" …' sh <dir>`), never as the
host-side pty `cwd` — that spelling made bash fail on the host with
`chdir(2) failed: No such file or directory` before the shell ever started.
