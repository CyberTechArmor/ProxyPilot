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
- [ ] `Layout` mobile top bar (admin/frontend/src/components/Layout.jsx:225)
      — render a `md:hidden` top bar with hamburger (`Menu` icon, ≥44×44px) + ProxyPilot wordmark that toggles `sidebarOpen`; hidden at `md+`.
- [ ] `Layout` sidebar container (admin/frontend/src/components/Layout.jsx:250)
      — sidebar becomes `fixed … -translate-x-full md:translate-x-0` + transition; open state slides in. Add a `md:hidden` backdrop (`fixed inset-0 bg-black/50 z-40`) that closes the drawer on click (outside-click close).
- [ ] `Layout` main content padding (admin/frontend/src/components/Layout.jsx:378)
      — replace `pl-64` with `pl-0 md:pl-64`; add `pt-14 md:pt-0` when mobile top bar is visible so content is not under the bar. Inner wrapper becomes `p-4 md:p-8` so pages breathe on 360px without wasting space.
- [ ] `Layout` update banner positioning (admin/frontend/src/components/Layout.jsx:229)
      — `left-0 md:left-64`; wraps content (`flex-wrap`) so text + dismiss button do not push off-screen at 360px.
- [ ] `Layout` notification panel clamping (admin/frontend/src/components/Layout.jsx:320)
      — swap `w-80` for `w-[min(20rem,calc(100vw-2rem))]`; verify at 360px that the panel no longer overflows the viewport.
- [ ] `Layout` primary user-section icon buttons (admin/frontend/src/components/Layout.jsx:302)
      — bell and logout `Button size="icon"` instances become `h-11 w-11` on mobile (`h-11 w-11 md:h-10 md:w-10`) so they hit the 44px touch target.

### B. Dashboard page — Services tab header + chrome

- [ ] `Dashboard` page header row (admin/frontend/src/pages/Dashboard.jsx:2647)
      — header becomes `flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`; action button row wraps (`flex-wrap`) so Reload/Regenerate/Export/Import/Discover/Terminal/One-Click/Kill Switch/Add Service do not cause horizontal scroll at 375px.
- [ ] `Dashboard` header notification popover (admin/frontend/src/pages/Dashboard.jsx:2715)
      — popover width becomes `w-[min(20rem,calc(100vw-2rem))]`; `right-0` stays so it anchors to the bell and stays in the viewport at 360px.
- [ ] `Dashboard` Add Service wizard dialog (admin/frontend/src/pages/Dashboard.jsx:2754)
      — `DialogContent` becomes `max-w-full h-full rounded-none sm:max-w-4xl sm:h-auto sm:rounded-lg` (step 0) and `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg` (step 1); completable on 375px end-to-end.
- [ ] `Dashboard` wizard type picker grid (admin/frontend/src/pages/Dashboard.jsx:2763)
      — `grid-cols-2 md:grid-cols-4` → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`; 4 type cards stack on phones without squishing icons.
- [ ] `Dashboard` dashboard tabs bar (admin/frontend/src/pages/Dashboard.jsx:2915)
      — Resources/Services/Compose/LXC tab bar gets `overflow-x-auto` + `flex-nowrap` so the tab strip scrolls horizontally at 360px instead of overflowing the page.

### C. Dashboard page — Resources tab

- [ ] `Dashboard` system stats cards grid (admin/frontend/src/pages/Dashboard.jsx:2988)
      — already `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`; verify no fixed widths inside CPU/Memory/Disk cards trigger overflow at 360px and tighten number text if needed.
- [ ] `Dashboard` quick stats grid (admin/frontend/src/pages/Dashboard.jsx:3064)
      — `grid-cols-2 md:grid-cols-4` → `grid-cols-2 md:grid-cols-4` confirmed; no change unless the card number/label pair overflows at 360px (then reduce `text-2xl` to `text-xl sm:text-2xl`).

### D. Dashboard page — Services tab body

- [ ] `Dashboard` search/filter/sort bar (admin/frontend/src/pages/Dashboard.jsx:3123)
      — already `flex-wrap`; fix fixed `w-[140px]` selects to `w-full sm:w-[140px]` so filter/sort controls are full-width on phone, then inline-sized at `sm+`. Search input stays `flex-1`.
- [ ] `Dashboard` services + folder sidebar wrapper (admin/frontend/src/pages/Dashboard.jsx:3193)
      — `flex gap-4` → `flex flex-col md:flex-row gap-4`; folder sidebar (`w-56 shrink-0`) becomes `w-full md:w-56` and collapses into an expandable "Folders" disclosure on `<md` so the service grid gets full width.
- [ ] `Dashboard` services grid (admin/frontend/src/pages/Dashboard.jsx:3354)
      — `grid gap-4 md:grid-cols-2 lg:grid-cols-3` → `grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`; cards stack to one column on phones per spec.
- [ ] `Dashboard` service card header actions (admin/frontend/src/pages/Dashboard.jsx:3368)
      — action button row wraps (`flex-wrap justify-end`) so Favorite/Folder/Settings/Files/Terminal/Delete never overflow the card title on narrow cards; icon buttons remain 44px-compliant via existing `size="icon"` default.
- [ ] `Dashboard` compose search/filter/sort bar (admin/frontend/src/pages/Dashboard.jsx:3540)
      — same treatment as the services filter bar: `w-[130px]`/`w-[140px]` selects become `w-full sm:w-[130px]` / `sm:w-[140px]`.
- [ ] `Dashboard` compose project grid (admin/frontend/src/pages/Dashboard.jsx:3577)
      — `grid gap-4 md:grid-cols-2 lg:grid-cols-3` → `grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`; compose cards stack vertically on mobile.
- [ ] `Dashboard` compose card header action row (admin/frontend/src/pages/Dashboard.jsx:3588)
      — action buttons bump from `h-7 w-7` to `h-9 w-9 sm:h-7 sm:w-7` (primary project actions) and the row gets `flex-wrap` so Start/Stop/Restart/Destroy/Terminal/Expand fit on a 360px card.

### E. Dashboard page — Dialogs

- [ ] `Dashboard` delete confirmation dialog (admin/frontend/src/pages/Dashboard.jsx:3759)
      — `DialogContent` gets `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg`.
- [ ] `Dashboard` destroy compose confirmation dialog (admin/frontend/src/pages/Dashboard.jsx:3783)
      — same: `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg`; TOTP input fits at 360px.
- [ ] `Dashboard` docker compose create dialog (admin/frontend/src/pages/Dashboard.jsx:3897)
      — `max-w-4xl h-[90vh]` → `max-w-full h-full rounded-none sm:max-w-4xl sm:h-[90vh] sm:rounded-lg`; CodeMirror editor height stays `flex-1 min-h-0`; env-var rows wrap (`flex-wrap`) so key/value inputs stack on phones.
- [ ] `Dashboard` terminal dialog gating on mobile (admin/frontend/src/pages/Dashboard.jsx:4019)
      — on `<md`, render a centered "Open Terminal" button inside the dialog content (or early-return a compact "Terminal not available on small screens — tap to open fullscreen" card) so the terminal never traps the user; when opened, always uses `max-w-full h-full rounded-none` regardless of `terminalFullscreen`.
- [ ] `Dashboard` terminal left panel responsiveness (admin/frontend/src/pages/Dashboard.jsx:4044)
      — `flex-col md:flex-row` is already there; ensure the file-browser panel collapses (`max-h-48 md:max-h-none`) so the terminal output area is still reachable at 375px.
- [ ] `Dashboard` file editor dialog (admin/frontend/src/pages/Dashboard.jsx:4475)
      — `max-w-6xl h-[90vh]` → on `<md` always full-screen (`max-w-full h-full rounded-none`); `isFullscreen` toggle keeps its desktop behavior. File tree sidebar becomes a slide-over drawer on `<md` (`hidden md:flex` by default, toggled by a "Files" button in the toolbar).
- [ ] `Dashboard` file editor Path Picker row (admin/frontend/src/pages/Dashboard.jsx:4507)
      — row wraps (`flex-wrap`) so the Label/Input/Terminal button stack on 360px instead of pushing the input to zero width.
- [ ] `Dashboard` file editor toolbar (admin/frontend/src/pages/Dashboard.jsx:4578)
      — language select, history button, save-notes input, and Save button wrap (`flex-wrap gap-2`); save-notes `w-40` → `w-full sm:w-40`.
- [ ] `Dashboard` service settings dialog (admin/frontend/src/pages/Dashboard.jsx:4743)
      — `max-w-5xl h-[90vh]` (caddy tab) and `max-w-lg` (settings tab) both gain `max-w-full h-full rounded-none sm:*` prefix so the dialog is full-screen on phones.
- [ ] `Dashboard` service settings two-column form grid (admin/frontend/src/pages/Dashboard.jsx:4822)
      — `grid grid-cols-2` → `grid grid-cols-1 sm:grid-cols-2`.
- [ ] `Dashboard` remove-cert / regenerate / misc simple confirm dialogs (admin/frontend/src/pages/Dashboard.jsx:5011, 5048, 5078)
      — every bare `<DialogContent>` without `className` in this range gets `className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg"`.
- [ ] `Dashboard` versions dialog (admin/frontend/src/pages/Dashboard.jsx:5129)
      — `max-w-2xl max-h-[80vh]` → `max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:max-h-[80vh] sm:rounded-lg`.
- [ ] `Dashboard` kill-switch TOTP dialog (admin/frontend/src/pages/Dashboard.jsx:5241)
      — `max-w-md` → `max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg`.
- [ ] `Dashboard` one-click install dialog (admin/frontend/src/pages/Dashboard.jsx:5332)
      — `max-w-4xl h-[80vh]` → `max-w-full h-full rounded-none sm:max-w-4xl sm:h-[80vh] sm:rounded-lg`.
- [ ] `Dashboard` discover sites dialog (admin/frontend/src/pages/Dashboard.jsx:5387)
      — `max-w-lg` → `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg`; inner `grid grid-cols-1` stays but `grid grid-cols-2` at line 5449 becomes `grid grid-cols-1 sm:grid-cols-2`.
- [ ] `Dashboard` export dialog (admin/frontend/src/pages/Dashboard.jsx:5523)
      — `max-w-md` → `max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg`.
- [ ] `Dashboard` folder management dialog (admin/frontend/src/pages/Dashboard.jsx:3814)
      — `max-w-md` → `max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg`.

### F. LxcContainers page

- [ ] `LxcContainers` container grid (admin/frontend/src/pages/LxcContainers.jsx:1128)
      — `grid gap-4 md:grid-cols-2 lg:grid-cols-3` → `grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`; verifies "card stack on <md" requirement.
- [ ] `LxcContainers` card header action buttons (admin/frontend/src/pages/LxcContainers.jsx:1141)
      — Terminal/Start/Stop/Restart/Delete buttons are `h-7 w-7`; become `h-9 w-9 sm:h-7 sm:w-7` (still secondary actions in a dense list but meet the 36px minimum; if the verification audit flags these as primary, bump to `h-11 w-11`).
- [ ] `LxcContainers` create container dialog (admin/frontend/src/pages/LxcContainers.jsx:1249)
      — `sm:max-w-lg` → `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg`.
- [ ] `LxcContainers` create form paired grids (admin/frontend/src/pages/LxcContainers.jsx:1392, 1449, 1690, 1768)
      — every inner `grid grid-cols-2` becomes `grid grid-cols-1 sm:grid-cols-2` so name/value input pairs stack on phones.
- [ ] `LxcContainers` info/detail dialog (admin/frontend/src/pages/LxcContainers.jsx:1538)
      — `w-[95vw] max-w-[95vw] h-[90vh] max-h-[90vh]` is already viewport-hugging; add `rounded-none` at `<sm` and `sm:rounded-lg` at `sm+`. Tabs list (`grid grid-cols-4` at 1550) becomes `grid-cols-2 sm:grid-cols-4` so tab labels do not truncate at 360px.
- [ ] `LxcContainers` detail-tab inner grids (admin/frontend/src/pages/LxcContainers.jsx:1563, 1601, 1627)
      — `grid-cols-2` → `grid-cols-1 sm:grid-cols-2` for the Info tab key/value readouts.
- [ ] `LxcContainers` image-picker stats grid (admin/frontend/src/pages/LxcContainers.jsx:1993)
      — `grid grid-cols-2` stats row becomes `grid grid-cols-1 sm:grid-cols-2`.
- [ ] `LxcContainers` delete / confirm dialogs (admin/frontend/src/pages/LxcContainers.jsx:2029, 2077, 2110)
      — each `sm:max-w-md` / `sm:max-w-sm` prepended with `max-w-full h-full rounded-none sm:h-auto sm:rounded-lg`.

### G. IncusManagement page

- [ ] `IncusManagement.NetworksTab` config grid (admin/frontend/src/pages/IncusManagement.jsx:159)
      — already `grid-cols-1 md:grid-cols-2`; no change unless key/value rows overflow at 360px — then set key label `w-full md:w-44` (currently `w-44 shrink-0`).
- [ ] `IncusManagement` edit-network dialog (admin/frontend/src/pages/IncusManagement.jsx:218)
      — `sm:max-w-lg max-h-[80vh]` → `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[80vh] sm:rounded-lg`.
- [ ] `IncusManagement` edit-network key/value rows (admin/frontend/src/pages/IncusManagement.jsx:234)
      — `flex items-center gap-2` + `w-44 shrink-0` label becomes `flex flex-col sm:flex-row sm:items-center gap-2` and `w-full sm:w-44 sm:shrink-0`; Input keeps `flex-1` but is full-width on phone.
- [ ] `IncusManagement` other dialog at 603 (admin/frontend/src/pages/IncusManagement.jsx:603)
      — audit: if it is a form dialog, prepend `max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg`.
- [ ] `IncusManagement.StorageTab` and `.ProfilesTab` fixed-width numeric inputs
      — any `<Input … className="w-32" />` or similar in storage pool / profile editor forms becomes `w-full sm:w-32`. One commit covers the whole page audit.

### H. Users page

- [ ] `Users` user list row (admin/frontend/src/pages/Users.jsx:298)
      — `flex items-center justify-between p-4 border rounded-lg` → `flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border rounded-lg`; username/role/meta block stays first, action button row wraps below on phone.
- [ ] `Users` user meta line (admin/frontend/src/pages/Users.jsx:311)
      — `flex items-center gap-4` → `flex flex-wrap items-center gap-x-4 gap-y-1`; TOTP/password/created badges wrap instead of overflowing.
- [ ] `Users` primary action buttons (admin/frontend/src/pages/Users.jsx:321)
      — Manage-access / Reset-password / Delete icon buttons become `h-11 w-11 sm:h-9 sm:w-9` so mobile users can actually tap them (these are primary actions).
- [ ] `Users` create-user dialog (admin/frontend/src/pages/Users.jsx:363)
      — bare `<DialogContent>` → `className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg"`.
- [ ] `Users` delete-user dialog (admin/frontend/src/pages/Users.jsx:458)
      — same full-screen-on-sm treatment.
- [ ] `Users` manage-access dialog (admin/frontend/src/pages/Users.jsx:495)
      — `max-w-2xl` → `max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:rounded-lg`; inner access rows (`flex items-center justify-between p-3` at 541 and 592) become `flex-col sm:flex-row sm:items-center sm:justify-between gap-2` so switches do not overflow.

### I. Profile page

- [ ] `Profile` root container width (admin/frontend/src/pages/Profile.jsx:563)
      — `space-y-6 max-w-2xl` stays; no change needed (Layout wrapper handles padding), but confirm `max-w-2xl` does not force horizontal scroll at 360px (it should not — `max-w-2xl` is a max, not a min).
- [ ] `Profile` TOTP QR code image (admin/frontend/src/pages/Profile.jsx:717)
      — `w-48 h-48` → `w-48 h-48 max-w-full` (plus `h-auto` on very narrow viewports); wrapping `flex justify-center` stays so the QR centers and never overflows.
- [ ] `Profile` device list rows (admin/frontend/src/pages/Profile.jsx:820)
      — `flex items-center justify-between p-3 border rounded-lg` → `flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border rounded-lg`; IP/last-used meta wraps (`flex-wrap gap-x-4`).
- [ ] `Profile` revoke-device dialog (admin/frontend/src/pages/Profile.jsx:852)
      — bare `<DialogContent>` → `className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg"`.
- [ ] `Profile` revoke-all-devices dialog (admin/frontend/src/pages/Profile.jsx:889)
      — same full-screen-on-sm treatment.

### J. Login page

- [ ] `Login` initial-setup card wrapper (admin/frontend/src/pages/Login.jsx:230)
      — wrapper `p-4` stays; `Card` already `w-full max-w-md`. Add `mx-4 sm:mx-auto` via wrapper to guarantee horizontal breathing room at 360px. Confirm `p-4` padding is retained.
- [ ] `Login` TOTP step card wrapper (admin/frontend/src/pages/Login.jsx:331)
      — same treatment; TOTP 6-digit Input gets `inputMode="numeric"` + `h-12 text-center tracking-[0.5em]` if not already set so it is easy to tap.
- [ ] `Login` main login card wrapper (admin/frontend/src/pages/Login.jsx:424)
      — same treatment; password Input and "Remember device" switch remain ≥44px tall on mobile.

### K. Final polish & audits

- [ ] Global touch-target audit
      — grep the three main pages for `size="sm"` and `h-7 w-7` / `h-6 w-6` button uses that are primary actions and bump them per the spec (primary ≥44px, dense-list secondary may stay `h-9 w-9`). One commit for the sweep.
- [ ] Horizontal-scroll audit at 360/375/390/768px
      — load `/`, `/incus`, `/users`, `/profile`, `/login` in dev (`npm run dev`) and assert `document.documentElement.scrollWidth === document.documentElement.clientWidth` on each; record pass/fail in the verification section. Fix offenders by adding new checklist items before marking the phase complete.
- [ ] Desktop-regression visual audit at 1280px and 1920px
      — page-by-page walk-through at desktop widths to confirm no layout regressed. Record pass/fail in the verification section.
- [ ] Lighthouse mobile accessibility pass on Dashboard (≥90)
      — run Lighthouse against `/` at mobile emulation, attach score to the verification note. Fix any quick wins as new checklist items.
