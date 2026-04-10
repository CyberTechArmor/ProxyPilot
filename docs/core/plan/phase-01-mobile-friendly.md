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

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
