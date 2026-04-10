# Mobile-First UI Guidelines

As of Phase 1 of the core infrastructure upgrade, **every UI change to the ProxyPilot admin dashboard must be mobile-friendly by default.** The dashboard is expected to work cleanly at 360px, 375px, 390px, and 768px viewport widths, not only on desktop monitors.

This document is the single source of truth for how to build and review mobile-friendly UI in `admin/frontend/`. Treat it as a merge gate: a PR that adds a new page, dialog, grid, or form must pass this checklist before it can ship.

---

## Breakpoints

We use the Tailwind defaults — do not override them in `tailwind.config.js`:

| Token | Width    | Typical device         |
|-------|----------|------------------------|
| (none) | `<640px` | Phone (portrait)        |
| `sm:`  | `≥640px` | Phone (landscape), small tablet |
| `md:`  | `≥768px` | Tablet, small laptop    |
| `lg:`  | `≥1024px`| Laptop, desktop         |
| `xl:`  | `≥1280px`| Large desktop           |

**Default style is mobile.** Desktop overrides are always `sm:`, `md:`, `lg:` prefixed. Never write a desktop-first class and then try to "undo" it at `<md`.

---

## Hard rules

### 1. Page layout
- Every top-level page route must render at **360px** without triggering `document.documentElement.scrollWidth > clientWidth`.
- The `Layout` component provides a drawer sidebar at `<md` and a 256px fixed sidebar at `md+`. Do **not** reintroduce `pl-64` without an `md:` prefix.
- The outer content wrapper uses `p-4 md:p-8`. Pages should assume they get 16px padding on mobile and 32px on desktop — do not add another `p-4` on top.

### 2. Grids
- Never use a bare `grid-cols-N` where `N > 1`. Always start at 1 column and add more at `sm:` / `md:` / `lg:`:
  ```jsx
  // Good
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
  // Bad
  <div className="grid grid-cols-3">
  ```
- For dense key/value grids (e.g. resource readouts) prefer `grid-cols-1 sm:grid-cols-2` so labels and values don't get squished on phones.

### 3. Dialogs (`DialogContent`)
- The base `DialogContent` primitive (`admin/frontend/src/components/ui/dialog.jsx`) is already mobile-overridable: at `<sm` there is no `max-w` or `max-h` cap and no border-radius, at `sm+` it defaults to `max-w-lg max-h-[90vh] rounded-lg`.
- For dialogs containing anything bigger than a two-field form (wizards, editors, settings panels, terminal, compose, discover, etc.), opt in to a full-screen layout on `<sm` by prefixing the className:
  ```jsx
  <DialogContent className="max-w-full h-full rounded-none sm:max-w-4xl sm:h-[90vh] sm:rounded-lg flex flex-col">
  ```
- `tailwind-merge` handles responsive overrides correctly, so passing `sm:max-w-4xl` on top of the base `sm:max-w-lg` works as expected.
- Small confirmation dialogs (delete, TOTP, simple yes/no) should still opt in via `max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg` — the user never wants to hunt for a cramped 320px modal in the middle of a 360px screen.

### 4. Rows with action buttons
- A row like "label on the left, actions on the right" must stack on `<sm`. The canonical pattern:
  ```jsx
  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border rounded-lg">
    <div className="min-w-0 flex-1">…label…</div>
    <div className="flex gap-1 flex-wrap">…actions…</div>
  </div>
  ```
- Long inline meta text (IP / timestamps / badges) must use `flex-wrap items-center gap-x-4 gap-y-1` so it wraps instead of overflowing.
- If your row title can be long, give its container `min-w-0` and the title `truncate` so it doesn't push the action buttons off screen.

### 5. Touch targets
- **Primary actions** (Add, Save, Delete, Logout, Create, Install, Start/Stop on a main card) must hit **44×44px** on mobile. Use `h-11 w-11 sm:h-10 sm:w-10` (or `sm:h-9 sm:w-9` if the desktop density requires it) on `Button size="icon"` instances.
- **Dense-list secondary actions** (e.g. expand/collapse chevrons, notification close X, version-history view/revert in a scrollable list) may stay `h-9 w-9` or smaller. Use judgment: if a mobile user would be frustrated tapping it, bump it.
- The shadcn Input default (`h-10` = 40px) is acceptable for text inputs because the wrapping `<Label>` expands the effective tap area.
- 6-digit TOTP inputs should get `inputMode="numeric" className="h-12 text-center tracking-[0.5em] text-lg" autoComplete="one-time-code"` so phones pop up the numeric keyboard and the code is easy to paste.

### 6. Fixed-width form fields
- Never set `w-32`, `w-40`, `w-[140px]`, etc. without a responsive override. Use `w-full sm:w-32` so the field is full-width on a phone and inline-sized on desktop.
- The filter/sort `Select` trigger pattern is `className="w-full sm:w-[140px]"`.

### 7. Tab bars
- A `TabsList` with more than three triggers on a page header must either
  - wrap onto two rows (`grid grid-cols-2 sm:grid-cols-4 h-auto`), or
  - scroll horizontally (`flex flex-nowrap overflow-x-auto` with `shrink-0` on each trigger).
- Never rely on a tab label being readable when it's squashed into 60px.

### 8. Images and media
- Every `<img>` should either have a `max-w-full` or live inside a container with `overflow-hidden`. QR codes specifically should be `w-48 max-w-full h-auto` so they never overflow a 192px-or-narrower container.

### 9. Overflow guard
- `admin/frontend/src/index.css` sets `html, body { overflow-x: hidden }` as a defensive backstop. This is **not** an excuse to ship buggy layouts — it's there to catch residual bugs before they reach users. Your page must still pass the horizontal-scroll audit below with the guard disabled.

---

## Pre-merge checklist

Before merging a PR that touches anything in `admin/frontend/src/pages/` or `admin/frontend/src/components/`:

- [ ] Runs locally via `npm run dev` without build errors.
- [ ] At **360px** width (Chrome DevTools → Responsive → 360×640), every route involved in the PR renders with no horizontal scroll (`document.documentElement.scrollWidth === document.documentElement.clientWidth`).
- [ ] At **375px** (iPhone SE) every dialog the PR opens can be completed end-to-end — submit the form, tap every button, close via the X.
- [ ] At **768px** (tablet) the layout still looks sensible — not an upscaled phone, not a squished desktop.
- [ ] At **1280px** and **1920px** the original desktop layout is unchanged (overrides are additive, not replacements).
- [ ] Every new `Button size="icon"` that's a primary action meets the 44px touch target rule.
- [ ] Every new `DialogContent` either uses the full-screen-on-sm pattern or is a tiny confirmation dialog that fits a 360px viewport.
- [ ] Every new `grid-cols-N` starts at `grid-cols-1` and ramps up at `sm:`/`md:`/`lg:`.
- [ ] Lighthouse mobile accessibility score on any new/changed page is **≥ 90**.

If a PR adds a new page, also add a line to the Verification section of `docs/core/plan/phase-01-mobile-friendly.md` (or a successor doc) confirming it passes the horizontal-scroll audit at all four widths.

---

## Where to look for patterns

- `admin/frontend/src/components/Layout.jsx` — sidebar drawer, mobile top bar, update banner, notification panel clamping.
- `admin/frontend/src/components/ui/dialog.jsx` — base `DialogContent` mobile behavior.
- `admin/frontend/src/pages/Dashboard.jsx` — canonical examples of full-screen dialogs, responsive grids, filter-bar select widths, folder-sidebar mobile disclosure, file-editor drawer pattern.
- `admin/frontend/src/pages/LxcContainers.jsx` — canonical card-header action button row (wrap + touch targets).
- `admin/frontend/src/pages/Users.jsx` — canonical stacked row with truncation.
- `admin/frontend/src/pages/Profile.jsx` — canonical image max-width and device-row stacking.
- `admin/frontend/src/pages/Login.jsx` — canonical TOTP input with numeric keyboard.

If the pattern you need isn't here yet, copy one of these and adapt. **Do not invent a new convention.**

---

## History

- **Phase 1** (see `docs/core/plan/phase-01-mobile-friendly.md`) introduced the mobile-friendly overhaul and established these rules. Every pattern documented here has a working example somewhere in `admin/frontend/src/`.
