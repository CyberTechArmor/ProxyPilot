# ProxyPilot Default Design Brief — "Upload Doc" System

**Status:** Default design reference. Use this brief when a project does not specify its own design direction. If the user or project spec provides any design guidance (brand colors, a component library, a mockup, "make it look like X"), that guidance wins — this brief fills gaps, it never overrides. It is a starting point, not a mandate.

**Provenance:** Extracted from the Upload Doc credentialing portal (vanilla HTML/CSS/JS, zero frontend dependencies, single stylesheet). The system is proven in production-style use: enterprise-clean, light-only, blue/teal healthcare-professional aesthetic.

---

## 1. Design personality

Calm, trustworthy, enterprise-professional without being sterile. White cards on a cool near-white background, one confident brand blue, a teal secondary used sparingly (gradients, accents), and semantic green/amber/red reserved strictly for status. Density is moderate: generous card padding, compact tables. Motion is minimal and fast (120–250ms), used for feedback, never decoration. No dark mode.

## 2. Color tokens

Define exactly these CSS custom properties on `:root`:

```css
:root{
  --blue-900:#0a3d6e; --blue-700:#0b5cad; --blue-600:#1466b8; --blue-500:#2f80d8;
  --blue-100:#e7f1fb; --blue-50:#f3f8fd;
  --teal:#12a3a3; --teal-100:#e2f6f5;
  --ink:#12263f; --slate:#5a6b81; --line:#e2e8f1; --bg:#f5f8fc; --white:#fff;
  --green:#1f9d57; --green-100:#e5f6ec; --amber:#c9820a; --amber-100:#fdf3e1;
  --red:#d24545; --red-100:#fbe9e9; --gray-100:#eef2f7;
  --shadow:0 1px 2px rgba(16,42,72,.06),0 8px 24px rgba(16,42,72,.07);
  --radius:12px;
}
```

Role assignments:

- `--blue-600` is the single primary action color: button fills, links, selected states, active tab underlines, avatars.
- `--blue-700` for hover fills and brand text; `--blue-500` for focus/hover borders; `--blue-100` for the 3px focus ring and tinted pills; `--blue-50` for hover rows and soft panel backgrounds.
- `--teal` is a secondary accent only: gradient endpoints, "team/internal" avatar variant, progress gradient end. Never a button color.
- `--ink` primary text, `--slate` secondary text/labels/icons, `--line` every border and divider, `--bg` page background, white surfaces.
- Semantic pairs (solid + `-100` tint): green = approved/success, amber = in-review/warning/override, red = attention/expired/destructive. Each status pill uses tint background + solid text.
- `--gray-100` for neutral fills: subtle buttons, disabled inputs, progress tracks, "missing/none" states.

Signature gradients: brand/logo tile `linear-gradient(135deg,var(--blue-600),var(--teal))`; hero/auth panel `linear-gradient(160deg,#0a3d6e,#0b5cad 55%,#12a3a3)`; progress fills `linear-gradient(90deg,var(--blue-600),var(--teal))`. Modal scrim `rgba(10,25,45,.5)`. Dark toast surface `#0b2a49`.

## 3. Typography

System stack only — no webfonts: `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`, `line-height:1.5`, antialiased. Mono for keys/IDs/IPs: `ui-monospace,SFMono-Regular,Menlo,monospace` at 12px.

Scale (weights 600–800 dominate; body content 13–14px; half-pixel sizes are intentional):

- Hero: 38px/700 (scales to 30 → 26 → 23 at breakpoints). Stat numbers: 28px/800, letter-spacing -.02em.
- Page titles 24px/700; section/card headers 15px/700; modal titles 16px/700.
- Body and inputs 14px; buttons 14px/600; secondary rows/tabs 13.5px/600; labels 13px/600; fine print `.small` 12.5px.
- Overline labels (table headers, section titles): 12px/700, uppercase, letter-spacing .03–.04em, slate.
- Badges 11.5px/600; micro-tags 10–11px/700 uppercase.
- All headings: `margin:0; font-weight:700; letter-spacing:-.01em`.

## 4. Shape, depth, spacing

- Radius ladder: cards/drops 12px (`--radius`), modals 16px, calendar/feature panels 14px, inner panels/alerts 10px, buttons/inputs 9px, small buttons/chips 8px, micro-elements 6–7px, pills/badges/switches 20px, avatars 50%.
- Shadows: cards use `--shadow`; modals `0 24px 60px rgba(8,20,40,.35)`; toasts `0 10px 30px rgba(8,20,40,.35)`; floating controls `0 4px 12px rgba(8,20,40,.16)`. Never use borders + heavy shadow together beyond the 1px `--line` border on cards.
- Focus ring everywhere: `outline:none; border-color:var(--blue-500); box-shadow:0 0 0 3px var(--blue-100)`.
- Page wrap: `max-width:1080px; margin:0 auto; padding:26px 26px 90px`. Sticky app header 62px.
- Card anatomy: header `15px 20px` with bottom border, body `18px 20px`. Modal: header `18px 22px`, body `22px`, footer `16px 22px` right-aligned buttons with 10px gap.
- Key-value grids: `grid-template-columns:130px 1fr; gap:8px 14px`. Detail layouts: `minmax(0,1fr) 320–360px` two-column.

## 5. Core components

**Buttons.** Base: blue-600 fill, white text, `padding:9px 16px`, radius 9px, 600 weight, inline-flex with 7px icon gap. Variants: `.ghost` (white bg, blue border/text), `.subtle` (gray-100 fill, ink text), `.danger` (white bg red text → solid red on hover), `.danger-soft` (red-100 fill), `.sm` (`6px 11px`, 12.5px), disabled at `opacity:.6`. Busy pattern: disable + swap label to `<spinner> Verb…` + restore in `finally`; set `aria-busy`.

**Inputs.** Full-width, 1px `--line` border, radius 9px, `padding:10px 12px`, 14px; label above at 13px/600 with 6px gap; field rows separated by 14px. Disabled: gray-100 background, full-contrast text. Checkbox rows are bordered 9px-radius tiles.

**Cards.** White, 1px `--line`, radius 12px, `--shadow`. Section title style for grouping. Stat tiles can be `<button>`s acting as filters: `aria-pressed`, hover border, `:active{transform:translateY(1px)}`, active ring `0 0 0 2px var(--blue-100)` composed with the token shadow.

**Tables.** Collapsed borders; uppercase 12px slate headers `10px 14px`; cells `13px 14px` with row bottom borders; clickable rows hover `--blue-50` with pointer cursor; horizontal scroll wrapper + `min-width` on mobile. Person cells = 34–36px avatar + name/subline stack.

**Badges / status pills.** `11.5px/600`, `4px 10px`, radius 20px, tint bg + solid text, and a leading dot via `::before { width:7px;height:7px;border-radius:50%;background:currentColor }` so every status auto-matches. Statuses: approved (green), pending (blue), attention (red), missing (gray), review (amber). Expiry pills: ok gray / soon amber / expired red / unset dashed blue.

**Modals.** Two stacked mount points (`#modalRoot` z-1500, `#modalRoot2` z-1700) so pickers and confirmations can open above a drawer. Centered card max-width 460–520px, backdrop-click close. Large "drawer" variant: two-column (content + 340–360px side panel), fullscreen on desktop ≥901px (via `.modal-bg:has(.modal.drawer)`), bottom sheet at ≤768px (`height:90svh`, radius `16px 16px 0 0`, tab bar to switch panels, sticky action footer with gradient fade). iOS-safe body scroll lock: save scrollY, `body{position:fixed;top:-Y}`, restore on close. Themable header icon tile (34×34, rounded, bg/color per intent: blue = neutral, green = confirm/activate, amber = warning/fix).

**Toasts.** Bottom-right column, dark navy `#0b2a49`, white title 13.5px/700, `#c9dbf0` body 12.5px, 34px icon tile, radius 12px, slide-in from right .25s, auto-dismiss ~4–5s with .3s fade. Full-width at mobile.

**Alerts (inline).** Radius 10px, `11px 14px`, 13.5px, icon + text flex: `.err` red-100/`#a5292b`, `.info` blue-100/blue-700, `.ok` green-100/green — each with a slightly darker 1px border.

**Empty states.** Dashed 2px border card, centered, 48px icon tile, muted copy, inline CTA. Loading: 16px border-spinner (white on filled buttons, blue on white), or `Loading…` muted text for panels.

**Progress.** 8px track (gray-100, radius 20px) with blue→teal gradient fill; pair with "N of M" + percentage labels.

**Date picker.** Custom calendar modal (never native `<input type=date>` for primary flows): month grid with 38px day cells, inset ring for today, solid blue + shadow for selected, clickable month/year titles that drill to a 3×4 month grid and 4×4 16-year page, prev/next steppers, live long-form readout ("Friday, July 25, 2026"), Today link, optional Clear, confirm-then-commit. Timezone-safe: build ISO strings manually, parse with `new Date(iso+"T00:00:00")`.

**File drop zone.** Dashed border panel, click-to-browse + drag classes (`dragenter/over` add `.drag` → blue-100 tint), chosen filename echoed in bold blue.

## 6. Layout patterns

- Auth screens: split layout — left gradient brand panel (hero headline, 3-point value list, soft glow orb), right white column with a ≤380px form box. Role-picker cards for multi-audience entry.
- App shell: sticky white header (brand, permission-gated nav buttons, identity block, avatar, logout), content in the 1080px wrap.
- Admin: underlined tab bar, sub-tabs as segmented pills with count badges, search + client-side pagination (page size ~6–10, "1–6 of 23" + Prev/Next).
- Breakpoints: 900px (stack two-column layouts), 768px (header wraps, nav scrolls horizontally, drawer → bottom sheet, toasts full-width), 640px (stats 2×2 with inline number+label, action rows wrap), 400px (tighten paddings).

## 7. Interaction & motion rules

- Transitions .12s for hover states, .15s for switches/chevrons/dots, .25s toast entry. Micro-lifts `translateY(-1px)` on hover for card-buttons; `translateY(1px)` on `:active`.
- Optimistic, re-render-free updates where scroll position matters (e.g. zoom mutates transform directly).
- Confirmation UX: destructive actions get red styling and explicit verbs; disabled buttons carry `title="why"` explanations instead of disappearing.
- Popup-blocker-safe external opens: `window.open('about:blank')` synchronously on click, set `tab.opener=null`, `location.replace(url)` after async work, `tab.close()` on failure.
- Realtime feedback: SSE-driven toasts and immediate route changes (e.g. deactivation kicks to a lock screen with auto-restore polling).

## 8. Voice & copy

Sentence case everywhere. Direct, calm, second-person ("You do not have permission to perform this action."). Errors are machine-coded for the client, human-readable for the person; clients branch on codes, never message text. Neutral responses for anything enumerable ("If an account exists for that email…"). Explain consequences in-place ("Your name is recorded on any field you change."). Empty-state copy is encouraging, never blank.

## 9. Known gaps — improve when building new work

These are inherited limitations; new projects should do better without changing the visual language: add `prefers-reduced-motion` guards; add focus traps + Escape handling to modals; give the date picker keyboard navigation (`role="grid"`, arrow keys, per-day `aria-label`); replace remaining `window.prompt/confirm` with styled modals; ensure the HTML escaper covers quotes; optional dark mode only if requested.
