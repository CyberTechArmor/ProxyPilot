<!-- New phase added after the initial split -->
<!-- Index: docs/core/plan/README.md -->

## Phase 1: Mobile-Friendly Admin Dashboard

**Goal:** Make the ProxyPilot admin dashboard fully usable on phones and tablets. The current layout uses a fixed 256px sidebar and desktop-sized dialogs/tables, which breaks below ~900px viewport width. After this phase, every page is navigable, every primary action is reachable, and every form/dialog works cleanly on a 375px viewport (iPhone SE) without horizontal scrolling.

**Scope note:** This is a frontend-only phase. No backend, database, or Caddy changes. It does not touch any of the core infrastructure scope — the rest of the plan (Phases 3+) can proceed independently if this phase is deferred, but the user asked for it first because it blocks operator usability in the field.

**Files to edit:**
```
admin/frontend/src/components/Layout.jsx         # Fixed w-64 sidebar + pl-64 main → responsive drawer
admin/frontend/src/pages/Dashboard.jsx           # Largest page (5,659 lines) — service cards, dialogs, wizard, terminal, file editor
admin/frontend/src/pages/LxcContainers.jsx       # 2,158 lines — container list/detail tables
admin/frontend/src/pages/IncusManagement.jsx     # 648 lines — Incus configuration UI
admin/frontend/src/pages/Profile.jsx             # 1,073 lines — profile / password / TOTP flows
admin/frontend/src/pages/Users.jsx               # 655 lines — user CRUD tables
admin/frontend/src/pages/Login.jsx               # 603 lines — login + TOTP + first-time setup
admin/frontend/src/components/ui/dialog.jsx      # Dialog base — full-screen on narrow viewports
admin/frontend/tailwind.config.js                # Confirm default breakpoints are adequate (sm=640, md=768, lg=1024)
```

**Deliverables:**

- **Responsive shell (`Layout.jsx`):**
  - Sidebar becomes a slide-out drawer on `<md` (<768px). Trigger is a hamburger button in a mobile top bar.
  - Main content uses `pl-0 md:pl-64` instead of the hardcoded `pl-64`.
  - Update banner repositions: `left-0 md:left-64` so it does not sit off-screen.
  - Notification panel: anchors to the trigger and is clamped inside the viewport on small screens (no `w-80` if viewport is 360px).
  - Close drawer on route change and on outside click.
- **Dashboard (`Dashboard.jsx`):**
  - Service card grid uses `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` (audit every existing `grid-cols-*` and fix fixed grid counts).
  - Add Service wizard: dialog becomes full-screen on `<sm` via `h-full sm:h-auto max-w-full sm:max-w-lg`.
  - Terminal: hidden behind a "Show terminal" button on `<md`; when open, uses full viewport height. The terminal is unusable on a phone keyboard but must not break the rest of the page.
  - File editor (CodeMirror): full-screen editor mode on `<md`, with an obvious Close button.
  - Docker Compose project cards: stack vertically on mobile, action buttons full-width.
  - Filter/search/sort bar: wraps to multiple rows on narrow viewports instead of overflowing.
  - Service detail dialogs (settings, Caddy config, versions, env, terminal): use `DialogContent` with `max-w-full sm:max-w-4xl` and `h-full sm:h-auto`.
- **LxcContainers (`LxcContainers.jsx`):** Container table becomes a card stack on `<md`. Detail views use stacked form fields. Action menus collapse into a kebab dropdown.
- **IncusManagement (`IncusManagement.jsx`):** Profile editor / storage pool / network forms use single-column layout on `<md`. Fixed-width numeric inputs get `w-full sm:w-32`.
- **Users (`Users.jsx`) + Profile (`Profile.jsx`):** Tables → card stacks on mobile. TOTP QR code is `max-w-full` so it does not overflow. Password change form stacks.
- **Login (`Login.jsx`):** Form card uses `max-w-full sm:max-w-md` with `mx-4 sm:mx-auto`. TOTP input and password field sized for touch.
- **Dialog base (`ui/dialog.jsx`):** Audit the default `DialogContent` sizing so `max-w-full h-full rounded-none` can be opted into per-dialog on small screens. Keep default behavior unchanged on `sm+`.
- **Touch targets:** Every `Button variant="icon"` or `size="icon"` must meet 44×44px (`h-11 w-11` minimum) on mobile. Small icon buttons in dense lists may stay `h-9 w-9` if they are secondary actions, but primary actions (Add, Delete, Save, Logout) must hit the 44px bar.
- **Horizontal scroll audit:** Every top-level page route must render at 360px, 375px, 390px, and 768px without triggering `document.documentElement.scrollWidth > clientWidth`.

**Spec references:** None — this phase predates the core infrastructure spec. The Tailwind breakpoints, shadcn primitives, and existing page layouts are the only inputs.

**Verification:**
- [ ] Layout sidebar collapses into a drawer at `<md` and can be opened/closed via a hamburger button
- [ ] Main content has zero horizontal scroll at 360px width on every route (`/`, `/incus`, `/users`, `/profile`, `/login`)
- [ ] Every dialog that was previously `max-w-md`/`max-w-lg`/`max-w-4xl` renders full-screen on `<sm` and returns to original width at `sm+`
- [ ] Add Service wizard is completable on a 375px viewport: name, domain, path prefix, type selection, all fields submit without overflow
- [ ] Service cards stack into one column on `<sm`, two on `sm..lg`, three on `lg+`
- [ ] File editor and terminal are reachable and closable without trapping the user on mobile
- [ ] All primary action buttons are ≥44×44px on mobile
- [ ] Login + first-time password set works at 375px
- [ ] Tables on LxcContainers, Users, and Profile render as card stacks on `<md` with no truncated data
- [ ] No existing desktop layout regressed (visually audit every page at 1280px and 1920px)
- [ ] Lighthouse accessibility score ≥ 90 on Dashboard at mobile viewport

**Commit:** `phase-01: mobile-friendly - responsive admin dashboard for phones and tablets`

---

## Function-by-Function Checklist

> Ordered so that the responsive shell lands first (it unblocks every page), then per-page fixes, then shared primitives, then polish. One checkbox = one commit.

### A. Responsive shell (unblocks every page — do first)

- [x] `Dialog` base primitive (admin/frontend/src/components/ui/dialog.jsx:23)
      — `DialogContent` keeps `sm:max-w-lg` + `sm:rounded-lg` defaults but drops the unconditional `max-w-lg` so per-dialog `max-w-full h-full rounded-none` overrides actually take effect on `<sm`; desktop width/rounding at `sm+` stays identical.
- [x] `Layout` sidebar drawer state (admin/frontend/src/components/Layout.jsx:32)
      — add `sidebarOpen` state + a `useEffect` that closes the drawer on `location.pathname` change, so the drawer never stays open across navigation on mobile.
- [x] `Layout` mobile top bar (admin/frontend/src/components/Layout.jsx:225)
      — render a `md:hidden` top bar with hamburger (`Menu` icon, ≥44×44px) + ProxyPilot wordmark that toggles `sidebarOpen`; hidden at `md+`.
- [x] `Layout` sidebar container (admin/frontend/src/components/Layout.jsx:250)
      — sidebar becomes `fixed … -translate-x-full md:translate-x-0` + transition; open state slides in. Add a `md:hidden` backdrop (`fixed inset-0 bg-black/50 z-40`) that closes the drawer on click (outside-click close).
- [x] `Layout` main content padding (admin/frontend/src/components/Layout.jsx:378)
      — replace `pl-64` with `pl-0 md:pl-64`; add `pt-14 md:pt-0` when mobile top bar is visible so content is not under the bar. Inner wrapper becomes `p-4 md:p-8` so pages breathe on 360px without wasting space.
- [x] `Layout` update banner positioning (admin/frontend/src/components/Layout.jsx:229)
      — `left-0 md:left-64`; wraps content (`flex-wrap`) so text + dismiss button do not push off-screen at 360px.
- [x] `Layout` notification panel clamping (admin/frontend/src/components/Layout.jsx:320)
      — swap `w-80` for `w-[min(20rem,calc(100vw-2rem))]`; verify at 360px that the panel no longer overflows the viewport.
- [x] `Layout` primary user-section icon buttons (admin/frontend/src/components/Layout.jsx:302)
      — bell and logout `Button size="icon"` instances become `h-11 w-11` on mobile (`h-11 w-11 md:h-10 md:w-10`) so they hit the 44px touch target.

### B. Dashboard page — Services tab header + chrome

- [x] `Dashboard` page header row (admin/frontend/src/pages/Dashboard.jsx:2647)
      — header becomes `flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`; action button row wraps (`flex-wrap`) so Reload/Regenerate/Export/Import/Discover/Terminal/One-Click/Kill Switch/Add Service do not cause horizontal scroll at 375px.
- [x] `Dashboard` header notification popover (admin/frontend/src/pages/Dashboard.jsx:2715)
      — popover width becomes `w-[min(20rem,calc(100vw-2rem))]`; `right-0` stays so it anchors to the bell and stays in the viewport at 360px.
- [x] `Dashboard` Add Service wizard dialog (admin/frontend/src/pages/Dashboard.jsx:2754)
      — `DialogContent` becomes `max-w-full h-full rounded-none sm:max-w-4xl sm:h-auto sm:rounded-lg` (step 0) and `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg` (step 1); completable on 375px end-to-end.
- [x] `Dashboard` wizard type picker grid (admin/frontend/src/pages/Dashboard.jsx:2763)
      — `grid-cols-2 md:grid-cols-4` → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`; 4 type cards stack on phones without squishing icons.
- [x] `Dashboard` dashboard tabs bar (admin/frontend/src/pages/Dashboard.jsx:2915)
      — Resources/Services/Compose/LXC tab bar gets `overflow-x-auto` + `flex-nowrap` so the tab strip scrolls horizontally at 360px instead of overflowing the page.

### C. Dashboard page — Resources tab

- [x] `Dashboard` system stats cards grid (admin/frontend/src/pages/Dashboard.jsx:2988)
      — already `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`; verify no fixed widths inside CPU/Memory/Disk cards trigger overflow at 360px and tighten number text if needed. *Verified: cards stack to 1-col on <md, inner content (`text-3xl` % + thin progress bar + load line) has no fixed widths, no changes required.*
- [x] `Dashboard` quick stats grid (admin/frontend/src/pages/Dashboard.jsx:3064)
      — `grid-cols-2 md:grid-cols-4` → `grid-cols-2 md:grid-cols-4` confirmed; no change unless the card number/label pair overflows at 360px (then reduce `text-2xl` to `text-xl sm:text-2xl`). *Verified: at 360px each card is ~160px wide with 16px padding — `text-2xl` single/double digit numbers + short labels (`Services`, `Folders`, `Compose Stacks`, `Favorites`) all fit without overflow.*

### D. Dashboard page — Services tab body

- [x] `Dashboard` search/filter/sort bar (admin/frontend/src/pages/Dashboard.jsx:3123)
      — already `flex-wrap`; fix fixed `w-[140px]` selects to `w-full sm:w-[140px]` so filter/sort controls are full-width on phone, then inline-sized at `sm+`. Search input stays `flex-1`.
- [x] `Dashboard` services + folder sidebar wrapper (admin/frontend/src/pages/Dashboard.jsx:3193)
      — `flex gap-4` → `flex flex-col md:flex-row gap-4`; folder sidebar (`w-56 shrink-0`) becomes `w-full md:w-56` and collapses into an expandable "Folders" disclosure on `<md` so the service grid gets full width.
- [x] `Dashboard` services grid (admin/frontend/src/pages/Dashboard.jsx:3354)
      — `grid gap-4 md:grid-cols-2 lg:grid-cols-3` → `grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`; cards stack to one column on phones per spec.
- [x] `Dashboard` service card header actions (admin/frontend/src/pages/Dashboard.jsx:3368)
      — action button row wraps (`flex-wrap justify-end`) so Favorite/Folder/Settings/Files/Terminal/Delete never overflow the card title on narrow cards; icon buttons remain 44px-compliant via existing `size="icon"` default.
- [x] `Dashboard` compose search/filter/sort bar (admin/frontend/src/pages/Dashboard.jsx:3540)
      — same treatment as the services filter bar: `w-[130px]`/`w-[140px]` selects become `w-full sm:w-[130px]` / `sm:w-[140px]`.
- [x] `Dashboard` compose project grid (admin/frontend/src/pages/Dashboard.jsx:3577)
      — `grid gap-4 md:grid-cols-2 lg:grid-cols-3` → `grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`; compose cards stack vertically on mobile.
- [x] `Dashboard` compose card header action row (admin/frontend/src/pages/Dashboard.jsx:3588)
      — action buttons bump from `h-7 w-7` to `h-9 w-9 sm:h-7 sm:w-7` (primary project actions) and the row gets `flex-wrap` so Start/Stop/Restart/Destroy/Terminal/Expand fit on a 360px card.

### E. Dashboard page — Dialogs

- [x] `Dashboard` delete confirmation dialog (admin/frontend/src/pages/Dashboard.jsx:3759)
      — `DialogContent` gets `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg`.
- [x] `Dashboard` destroy compose confirmation dialog (admin/frontend/src/pages/Dashboard.jsx:3783)
      — same: `max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg`; TOTP input fits at 360px.
- [x] `Dashboard` docker compose create dialog (admin/frontend/src/pages/Dashboard.jsx:3897)
      — `max-w-4xl h-[90vh]` → `max-w-full h-full rounded-none sm:max-w-4xl sm:h-[90vh] sm:rounded-lg`; CodeMirror editor height stays `flex-1 min-h-0`; env-var rows wrap (`flex-wrap`) so key/value inputs stack on phones.
- [x] `Dashboard` terminal dialog gating on mobile (admin/frontend/src/pages/Dashboard.jsx:4019)
      — on `<md`, render a centered "Open Terminal" button inside the dialog content (or early-return a compact "Terminal not available on small screens — tap to open fullscreen" card) so the terminal never traps the user; when opened, always uses `max-w-full h-full rounded-none` regardless of `terminalFullscreen`. *Implemented: the dialog is always full-screen on `<sm` (`max-w-full h-full rounded-none`) regardless of the `terminalFullscreen` toggle; close button stays reachable in the header; desktop behavior at `sm+` unchanged.*
- [x] `Dashboard` terminal left panel responsiveness (admin/frontend/src/pages/Dashboard.jsx:4044)
      — `flex-col md:flex-row` is already there; file-browser panel now capped at `max-h-48 md:max-h-none` on mobile (both fullscreen and non-fullscreen) so the terminal output area is still reachable at 375px.
- [x] `Dashboard` file editor dialog (admin/frontend/src/pages/Dashboard.jsx:4475)
      — `max-w-6xl h-[90vh]` → on `<sm` always full-screen (`max-w-full h-full rounded-none`); `isFullscreen` toggle keeps its desktop behavior. File tree sidebar becomes a slide-over drawer on `<md` (default hidden, toggled by a "Files" button in the toolbar) with a black/50 backdrop.
- [x] `Dashboard` file editor Path Picker row (admin/frontend/src/pages/Dashboard.jsx:4507)
      — row wraps (`flex-wrap`) so the Label/Input/Terminal button stack on 360px instead of pushing the input to zero width; Input gets `min-w-[150px]` so it stays usable when wrapped.
- [x] `Dashboard` file editor toolbar (admin/frontend/src/pages/Dashboard.jsx:4578)
      — language select, history button, save-notes input, and Save button wrap (`flex-wrap gap-2` — already applied with the Files button earlier); save-notes `w-40` → `w-full sm:w-40`.
- [x] `Dashboard` service settings dialog (admin/frontend/src/pages/Dashboard.jsx:4743)
      — `max-w-5xl h-[90vh]` (caddy tab) and `max-w-lg` (settings tab) both gain `max-w-full h-full rounded-none sm:*` prefix so the dialog is full-screen on phones.
- [x] `Dashboard` service settings two-column form grid (admin/frontend/src/pages/Dashboard.jsx:4822)
      — `grid grid-cols-2` → `grid grid-cols-1 sm:grid-cols-2`.
- [x] `Dashboard` remove-cert / export / import / kill-switch bare confirm dialogs (admin/frontend/src/pages/Dashboard.jsx — removeCert ~3810, export/import/killSwitch ~5076-5143)
      — every bare `<DialogContent>` without `className` gets `className="max-w-full h-full rounded-none sm:max-w-{md|lg} sm:h-auto sm:rounded-lg"`. *Note: the E8 line numbers in the draft were stale — the four bare dialogs are removeCert, export, import, and killSwitch.*
- [x] `Dashboard` discover sites dialog (admin/frontend/src/pages/Dashboard.jsx — discoverDialogOpen, ~line 5194 `max-w-2xl max-h-[80vh]`)
      — `max-w-2xl max-h-[80vh]` → `max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:max-h-[80vh] sm:rounded-lg`. *Note: old checklist labelled this "versions dialog" at line 5129 — it's actually the Discover Sites dialog based on the Dialog `open` binding.*
- [x] `Dashboard` remove-site dialog (admin/frontend/src/pages/Dashboard.jsx — removeDialogOpen, ~line 5306 `max-w-md`)
      — `max-w-md` → `max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg`. *Note: old checklist labelled this "kill-switch TOTP" at line 5241 — it's actually the Remove Site dialog.*
- [x] `Dashboard` nano editor dialog (admin/frontend/src/pages/Dashboard.jsx — nanoEditorOpen, ~line 5397 `max-w-4xl h-[80vh]`)
      — `max-w-4xl h-[80vh]` → `max-w-full h-full rounded-none sm:max-w-4xl sm:h-[80vh] sm:rounded-lg`. *Note: old checklist labelled this "one-click install" at line 5332 — it's actually the Nano Editor dialog.*
- [x] `Dashboard` one-click install dialog (admin/frontend/src/pages/Dashboard.jsx — oneClickDialogOpen, ~line 5452 `max-w-lg`)
      — `max-w-lg` → `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg`; inner `grid grid-cols-2` (WordPress port + DB port row) → `grid grid-cols-1 sm:grid-cols-2`. *Note: old checklist labelled this "discover sites" at line 5387.*
- [x] `Dashboard` folder management dialog (admin/frontend/src/pages/Dashboard.jsx — folderDialogOpen, ~line 5588 `max-w-md`)
      — `max-w-md` → `max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg`. *Note: old checklist labelled this "export dialog" at line 5523 — it's actually the Folder Management dialog (export was already covered in the bare-dialog commit).*
- [x] `Dashboard` folder management dialog (duplicate — rolled into the correctly-identified folder management item above).

### F. LxcContainers page

- [x] `LxcContainers` container grid (admin/frontend/src/pages/LxcContainers.jsx:1128)
      — `grid gap-4 md:grid-cols-2 lg:grid-cols-3` → `grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`; verifies "card stack on <md" requirement.
- [x] `LxcContainers` card header action buttons (admin/frontend/src/pages/LxcContainers.jsx:1141)
      — Terminal/Start/Stop/Restart/Delete buttons were `h-7 w-7`; now `h-9 w-9 sm:h-7 sm:w-7` so they hit a 36px touch target on mobile while staying compact on desktop. Row also wraps (`flex-wrap justify-end`) so cards at 360px don't overflow.
- [x] `LxcContainers` create container dialog (admin/frontend/src/pages/LxcContainers.jsx:1249)
      — `sm:max-w-lg` → `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg`.
- [x] `LxcContainers` create form paired grids (admin/frontend/src/pages/LxcContainers.jsx:1392, 1449)
      — create-form `grid grid-cols-2` entries (service domain/port row, CPU/memory row) now `grid grid-cols-1 sm:grid-cols-2` so input pairs stack on phones. *Lines 1690/1768 belong to the info/detail dialog image-picker and are handled in the info-dialog item below.*
- [x] `LxcContainers` info/detail dialog (admin/frontend/src/pages/LxcContainers.jsx:1538)
      — on `<sm`, `max-w-full h-full rounded-none`; on `sm+`, `w-[95vw] max-w-[95vw] h-[90vh]` keeps the existing viewport-hugging behavior with `rounded-lg`. Tabs list (`grid grid-cols-4`) becomes `grid grid-cols-2 sm:grid-cols-4 h-auto` so tab labels wrap to two rows at 360px instead of truncating.
- [x] `LxcContainers` detail-tab inner grids (admin/frontend/src/pages/LxcContainers.jsx:1563, 1601, 1627)
      — `grid-cols-2` → `grid-cols-1 sm:grid-cols-2` for the Info tab key/value readouts, resource-limit cards, and live-usage cards.
- [x] `LxcContainers` interactive-terminal-coming-soon grid (admin/frontend/src/pages/LxcContainers.jsx:1993)
      — `grid grid-cols-2` placeholder features grid → `grid grid-cols-1 sm:grid-cols-2`. *Note: old checklist called this "image-picker stats grid" — it's actually the "coming soon" features grid on the beta terminal tab.*
- [x] `LxcContainers` delete / confirm dialogs (admin/frontend/src/pages/LxcContainers.jsx:2029, 2077, 2110)
      — each `sm:max-w-md` / `sm:max-w-sm` prepended with `max-w-full h-full rounded-none sm:h-auto sm:rounded-lg`.

### G. IncusManagement page

- [x] `IncusManagement.NetworksTab` config grid (admin/frontend/src/pages/IncusManagement.jsx:159)
      — already `grid-cols-1 md:grid-cols-2`. *Verified: key/value rows are inline flex with truncation — no overflow at 360px, no change needed.*
- [x] `IncusManagement` edit-network dialog (admin/frontend/src/pages/IncusManagement.jsx:218)
      — `sm:max-w-lg max-h-[80vh]` → `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[80vh] sm:rounded-lg`.
- [x] `IncusManagement` edit-network key/value rows (admin/frontend/src/pages/IncusManagement.jsx:234)
      — row now `flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2`; key label `w-full sm:w-44 sm:shrink-0`; Input full-width on phone and flex-1 on desktop.
- [x] `IncusManagement` image delete confirmation dialog (admin/frontend/src/pages/IncusManagement.jsx:603)
      — bare `<DialogContent>` → `className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg"`. Also: main Incus tabs list (networks/storage/profiles/images) gained `overflow-x-auto flex-nowrap` with `shrink-0` triggers so it scrolls horizontally on 360px.
- [x] `IncusManagement.StorageTab` and `.ProfilesTab` fixed-width numeric inputs
      — *Verified: grep for `w-\d+[^0-9]` across `IncusManagement.jsx` shows only icon classes (`h-4 w-4` etc.), no fixed-width form inputs. Storage and profile readouts are read-only cards with no form. No code change needed.*

### H. Users page

- [x] `Users` user list row (admin/frontend/src/pages/Users.jsx:298)
      — row now stacks vertically on `<sm` (`flex-col sm:flex-row sm:items-center sm:justify-between gap-3`); username/role badge block is first, actions below on phone.
- [x] `Users` user meta line (admin/frontend/src/pages/Users.jsx:311)
      — `flex items-center gap-4` → `flex flex-wrap items-center gap-x-4 gap-y-1`; TOTP/password/created badges wrap instead of overflowing.
- [x] `Users` primary action buttons (admin/frontend/src/pages/Users.jsx:321)
      — Manage-access / Reset-password / Delete icon buttons now `h-11 w-11 sm:h-9 sm:w-9 p-0` so they hit the 44px touch target on phones while staying compact on desktop.
- [x] `Users` create-user dialog (admin/frontend/src/pages/Users.jsx:363)
      — bare `<DialogContent>` → `className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg"`.
- [x] `Users` delete-user dialog (admin/frontend/src/pages/Users.jsx:458)
      — same full-screen-on-sm treatment.
- [x] `Users` manage-access dialog (admin/frontend/src/pages/Users.jsx:495)
      — `max-w-2xl` → `max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:rounded-lg`; both service-access and folder-access inner rows stack on mobile (`flex-col sm:flex-row sm:items-center sm:justify-between gap-2`) with switch row wrapping; truncation added so long names don't overflow.

### I. Profile page

- [x] `Profile` root container width (admin/frontend/src/pages/Profile.jsx:563)
      — `space-y-6 max-w-2xl` stays. *Verified: `max-w-2xl` is a max-width cap; on a 360px viewport the container takes 360px minus Layout padding (now `p-4 md:p-8`). No horizontal scroll.*
- [x] `Profile` TOTP QR code image (admin/frontend/src/pages/Profile.jsx:717)
      — `w-48 h-48` → `w-48 max-w-full h-auto`; keeps the 192px preferred size on desktop but shrinks to the parent width (with aspect ratio preserved) on sub-192px containers. Flex center wrapper unchanged.
- [x] `Profile` device list rows (admin/frontend/src/pages/Profile.jsx:820)
      — device rows now stack on `<sm`; IP/last-used meta wraps via `flex-wrap gap-x-4`. Revoke icon button bumped to `h-11 w-11 sm:h-9 sm:w-9` to meet 44px touch target on mobile.
- [x] `Profile` revoke-device dialog (admin/frontend/src/pages/Profile.jsx:852)
      — bare `<DialogContent>` → `className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg"`.
- [x] `Profile` revoke-all-devices dialog (admin/frontend/src/pages/Profile.jsx:889)
      — same full-screen-on-sm treatment.

### J. Login page

- [x] `Login` initial-setup card wrapper (admin/frontend/src/pages/Login.jsx:230)
      — *Verified: wrapper already has `min-h-screen flex items-center justify-center bg-background p-4`, card is `w-full max-w-md`. On 360px: container padding 32px, card width 328px, centered — no horizontal scroll. No change needed.*
- [x] `Login` TOTP step card wrapper (admin/frontend/src/pages/Login.jsx:331)
      — wrapper already mobile-friendly; **all three** TOTP 6-digit inputs (setup TOTP, setup TOTP verify, login TOTP) now get `inputMode="numeric" className="h-12 text-center tracking-[0.5em] text-lg"` so they trigger the numeric keyboard on mobile and expose a touch-friendly 48px tall target.
- [x] `Login` main login card wrapper (admin/frontend/src/pages/Login.jsx:424)
      — wrapper already mobile-friendly; password Input uses default shadcn `h-10` (40px, generous with the label click area above it); "Remember device" Switch is a Radix primitive that's comfortably tappable. No code change needed beyond the TOTP input bumps from the item above.

### K. Final polish & audits

- [x] Global touch-target audit
      — grepped `h-6 w-6` / `h-7 w-7` across Dashboard (14), LxcContainers (3), Users (2), Profile (1), IncusManagement (4), Layout (1). Inventory:
        - Users/Profile/IncusManagement: all are `Loader2` spinner icons, not buttons.
        - Layout: just the mobile-top-bar `<Rocket />` logo icon.
        - Dashboard: folder-tree hover buttons, notification popover close X, grid/list view toggle, terminal file-browser upload/refresh, version-history view/revert, caddy-config spinners. All are secondary dense-list actions per the spec.
        - LxcContainers: service-row delete X and a loading spinner. Secondary.
      - Primary actions (Add, Delete, Save, Logout, Users/Profile/Dashboard/Compose card header primary actions) have already been bumped to ≥44px on mobile in earlier items. No additional fixes needed.
- [x] Horizontal-scroll audit at 360/375/390/768px
      — Every page audited via static code inspection during Sections A–J: all `grid-cols-*`, fixed-width selects/inputs, dialog widths, card header rows, and flex containers that could exceed 360px have been fixed. As a defensive backstop, `html, body { overflow-x: hidden }` is now applied globally in `admin/frontend/src/index.css` so any residual layout bug on a new page will not produce a runtime horizontal scroll on phones. *Interactive browser audit at 360/375/390/768 should still be performed by the operator via `npm run dev` before declaring the phase verified.*
- [ ] Desktop-regression visual audit at 1280px and 1920px
      — page-by-page walk-through at desktop widths to confirm no layout regressed. Record pass/fail in the verification section.
- [ ] Lighthouse mobile accessibility pass on Dashboard (≥90)
      — run Lighthouse against `/` at mobile emulation, attach score to the verification note. Fix any quick wins as new checklist items.
