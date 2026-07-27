# Mock2 Design System — v2 (light-first tokens)

This is the design system Stage-1 mockups load by default (constitution §6.1;
ADR-003). It replaces the v1 near-black + neon-green theme, which is retired:
that palette repeatedly overrode per-project design instructions ("geometry
obeyed, color ignored"). v2 is a system of DEFAULTS, resolved by precedence:

1. **The brief's explicit visual spec** (token tables, palette, theme,
   typography named in the brief) — always wins, everywhere it speaks.
2. **The project's chosen base theme** (design preset picked at creation) —
   wins where the brief is silent.
3. **This file** — governs everything neither of the above covers.

Ignore any pre-existing theme, brand colors, or prior mockup styling; the
design-system tokens replace them entirely. Light is the reference theme;
render light first. This file is never a veto: if a Builder asks for a look,
they get it.

## §1 Principles

- **Light first, dark mandatory.** `:root` carries the light values (the
  reference theme, shown by default); `[data-theme="dark"]` on `<html>`
  carries the derived dark values — soft dark surfaces (never pure black),
  muted accent, the same stage hues. Every mockup ships a working header
  theme toggle that flips the attribute.
- **Tokens are the only source of color.** Every color is defined once as a
  CSS custom property inside the token blocks and consumed via `var(--…)`.
  Zero hard-coded hex values in component styles. A brief or base theme that
  overrides the look RE-VALUES the properties (same names); nothing bypasses
  them.
- **Earn every default.** Hierarchy from type and spacing, not boxes; every
  color has a job; hard states proven with data.

## §2 Type, spacing, shape

- **Type:** Manrope, falling back to `system-ui`. One family; weight and size
  carry hierarchy. Ramp: 22/700 page title · 16/600 item title · 14 body ·
  13 secondary (`--text-2`) · 12/600 uppercase labels (`--text-3`). Tabular
  figures for all numbers.
- **Spacing:** an 8px rhythm (4/8/12/16/24/32).
- **Shape:** radii 10–12px; hairline dividers (`--hairline`) instead of hard
  borders; soft, low shadows (`--shadow-1`).
- **Motion:** three durations (`--dur-fast` 120ms · `--dur-base` 200ms ·
  `--dur-slow` 320ms) and three easings (`--ease-standard` for a state change
  in place, `--ease-entrance` decelerating, `--ease-exit` accelerating).
  **Select motion, do not write it:** use the shipped classes — `.enter` and
  `.enter-fade` for something arriving, `.stagger` (set `--i` per row) for a
  list arriving in order, `.press` for a control acknowledging a press,
  `.pulse-once` for drawing the eye ONCE to something that just changed.
  Hand-rolled `@keyframes` with their own timing are how an app ends up
  moving at a different speed on every screen. Nothing loops, nothing exceeds
  1s, nothing animates a value while someone is reading it, and everything
  degrades under `prefers-reduced-motion` (the classes already do).

## §3 Token tables (the only source of color)

All pairings below are computed AA (≥ 4.5:1), not eyeballed — keep them AA if
you adjust lightness within-hue.

### Light (reference — `:root`)

| Token | Value | Job |
| --- | --- | --- |
| `--bg` | `#F6F8F8` | page wash |
| `--surface-1` | `#FFFFFF` | cards, rows, toolbar |
| `--surface-2` | `#EFF3F3` | inset panels, quiet controls |
| `--surface-3` | `#E6EDEC` | deepest inset (ladders, wells) |
| `--text-1` | `#16201F` | primary text |
| `--text-2` | `#3F4F4D` | secondary text, value statements |
| `--text-3` | `#5F716E` | labels, metadata |
| `--hairline` | `rgba(22,32,31,.12)` | dividers |
| `--accent` | `#0F766E` | clinical teal — the single action/emphasis color |
| `--accent-on` | `#FFFFFF` | text on accent fills |
| `--danger` / `--warn` / `--ok` | `#B42318` / `#9A5B00` / `#067647` | status only |

### Dark (`[data-theme="dark"]`)

| Token | Value | Job |
| --- | --- | --- |
| `--bg` | `#101617` | soft dark wash — never `#000` |
| `--surface-1` | `#161D1E` | cards, rows, toolbar |
| `--surface-2` | `#1D2627` | inset panels |
| `--surface-3` | `#243030` | deepest inset |
| `--text-1` | `#E6EBEA` | primary text |
| `--text-2` | `#AEBCB9` | secondary text |
| `--text-3` | `#8FA09D` | labels, metadata |
| `--hairline` | `rgba(230,235,234,.12)` | dividers |
| `--accent` | `#3FB8AC` | muted teal |
| `--accent-on` | `#06201D` | text on accent fills |
| `--danger` / `--warn` / `--ok` | `#E5756A` / `#E0A64E` / `#58B98A` | status only |

### Stage palette (complete — no stage falls through to a default color)

Badge = tinted background + same-hue text (darker in light, lighter in dark).
Tokens: `--stage-<key>-bg` / `--stage-<key>-text` in both theme blocks.

| Stage | Hue | Light bg / text | Dark bg / text |
| --- | --- | --- | --- |
| Ideation | slate | `#E7EBF0` / `#44546A` | `#232B36` / `#AAB9CC` |
| MVP | indigo | `#E6E9F9` / `#3F48A8` | `#262A4A` / `#AEB6F2` |
| Testing | muted amber | `#F6EDD9` / `#7A5A14` | `#37301B` / `#D9BA6E` |
| Iterating | orange-tan | `#F6E7D9` / `#8A4A1F` | `#382A1E` / `#DCA97C` |
| Rollout | muted teal | `#DFF0ED` / `#0E5F58` | `#1C3330` / `#82CCC2` |
| Maintenance | calm green | `#E3F0E5` / `#2E6B3B` | `#223026` / `#96CDA5` |

## §4 Component specs

- **Toolbar:** one `--surface-1` bar; page title left; at most a search field,
  one quiet filter control (a menu — never an always-visible pill bank), the
  theme toggle, and at most ONE primary action right. 44×44px minimum targets.
- **List rows — the canonical pattern (`.list-row`), REQUIRED for all
  list/table rows:** a fixed 5-column grid —
  `Stage badge | Identity | Headline metric | Position | Lead · Updated`.
  Identity stacks the title (16px/600) above a one-line value statement
  (13px, `--text-2`, `white-space: nowrap`, `text-overflow: ellipsis`, with
  `min-width: 0` on the cell so truncation actually engages). Columns never
  overlap at any viewport ≥ 1280px; below `sm` the grid collapses to a
  stacked card.
- **One metric per item.** A row or card headlines exactly ONE metric — the
  stage-appropriate one (§5). More metrics belong on the detail page.
- **Metric formatting:** `value → unit → descriptor`, in that order — a
  tabular-figure value, a quiet unit, a `--text-3` descriptor
  (`42 · hrs/wk · staff time reclaimed`). Never a bare number, never a
  sentence.
- **Bars carry data (`.bar`):** a bar's fill binds to a real value via the
  `--fill` custom property; sibling bars must have visibly different lengths.
  A bar with no value behind it is not rendered. No per-card progress bars in
  lists.
- **Detail pages — three bands, non-optional** for staged/lifecycle domains:
  ① opportunity canvas + audience impact bars (varied fills), ② metric stat
  tiles, ③ the rollout ladder — `Site → POD → Region → All org` with
  per-level counts, the current frontier accent-emphasized, exactly one
  filled **"Promote to next level"** button (the page's ONLY filled button),
  and a readiness checklist rendered as quiet checks.
- **Badges:** tinted background + same-hue text (the stage tokens); pill
  shape; 12px/600 text. Attention chips use `--warn`/`--danger` text on a
  tinted wash, only where semantically valid for the stage.

## §5 Content & sample-data integrity

- Each entity lives in exactly ONE lifecycle stage, with ONE consistent
  description across all screens.
- Stage-headline mapping (the one metric a row shows): Ideation → projected
  impact (est.); MVP → sites piloting; Testing → validation coverage;
  Iterating → adoption %; Rollout → units live (`n of m`); Maintenance →
  sustained coverage. 100% coverage belongs ONLY to Maintenance/completed —
  in-progress stages show partial completion.
- Attention chips (e.g. "Roller unassigned") only where semantically valid
  for the stage (a Rollout concern belongs on a Rollout row).
- Sample data lives only in the mockup; the built app starts empty.

## §6 Anti-patterns (presence is a failure)

Emoji as icons · unlabeled icons (every svg gets a `<title>` or is
`aria-hidden` beside a text label) · always-visible filter pill banks ·
per-card progress bars in lists · pure-black surfaces · a neon accent on
dark · one hue for every stage badge · empty uniform bar tracks · a layout
that only works with exactly four rows · internal/state-machine language
shown to end users.

## §7 Acceptance checks (a mockup ships only if all pass)

1. Zero hard-coded hex outside the `==tokens==` blocks; zero occurrences of
   the retired v1 palette (the neon greens and near-black surfaces — the
   harness check module carries the exact values).
2. Both themes render from the token tables; the header toggle flips every
   surface.
3. List rows use the canonical grid; no overlapping columns at ≥ 1280px;
   every value statement truncates.
4. Exactly one metric per row/card, formatted `value → unit → descriptor`.
5. Detail pages contain all three bands; ladder has one filled promote
   button; impact bars have varied, data-bound fills.
6. Every stage badge resolves to its stage tokens (no neutral fallback).
7. AA contrast holds for body text, `--text-3`, and stage-badge text in both
   themes (computed, not eyeballed).

## §8 Sample data — Spec Ops Hub (fixture reference)

Use this content for fixtures and calibration renders (never a live app):

| Initiative | Stage | Value statement | Headline metric | Position | Lead · Updated |
| --- | --- | --- | --- | --- | --- |
| Async intake triage | Ideation | Cut phone-tag on routine refill requests before they queue | `42 · hrs/wk · staff time reclaimed (proj.)` | Site · Northgate | M. Okafor · 2d |
| Barcode med checks | MVP | Scan-verify against the MAR at bedside before administration | `3 · sites · piloting` | POD · North | J. Reyes · 5h |
| Shift-handoff scripts | Testing | Structured handoffs so nothing rides on memory at 7am | `78 · % · handoffs using script` | POD · Central | A. Whitfield · 1d |
| Fall-risk rounding | Iterating | Hourly rounding tuned to each unit's actual fall pattern | `61 · % · rooms rounded on time` | Region · East | K. Tanaka · 3h |
| Rapid-response huddles | Rollout | Two-minute huddle when early-warning scores trip | `8 of 12 · PODs · live` | Region · East | (Roller unassigned) · 6d |
| Hand-hygiene audits | Maintenance | Passive audit loop keeping compliance from drifting | `100 · % · coverage sustained` | All org | S. Adeyemi · 12d |

Detail-page reference (Rapid-response huddles): canvas — problem, bet, and
audience impact bars (Nurses 82%, Physicians 54%, Techs 37%); stat tiles —
`4.2 · min · median response`, `31 · % · fewer code events`, `12 of 12 ·
PODs · trained`; ladder — Site 1/1 → POD 8/12 (frontier) → Region 0/4 →
All org 0/1, promote button, readiness checks (training complete, supplies
staged, escalation path signed off).

## §9 Mockup mechanics (carried from v1 — still binding)

1. **Mockups are non-functional.** Interactive, but no persistence and no
   integration — a mockup demonstrates the idea, it does not run it.
2. **Mobile-first.** Every screen renders cleanly at 360/375px in a single
   column; multi-column layouts collapse on small viewports.
3. **Touch targets ≥ 44×44px** for every tappable control.
4. **Self-contained artifacts.** One HTML file, inline CSS/JS, no external
   hosts/fonts/scripts/images (data URIs only), committed under
   `state/mockups/` and served through the project's preview URL.
5. **The inventory is the contract, not the pixels.** On approval the design
   inventory (screens, fields, actions, states) is extracted and the mockup
   code discarded; consistency is enforced by these tokens, behavior by the
   rules.


---

## §9 Default visual reference — the "Upload Doc" brief (DEFAULT, NOT MANDATORY)

Everything above is the token/theme CONTRACT every mockup must satisfy. This
section adds the default *visual language* — what a project should look like
when nobody has said what it should look like.

**Precedence (unchanged in spirit, stated exactly):**

1. **The project's own design direction wins, entirely.** Brand colors, a named
   component library or framework, a supplied mockup, a reference site, "make it
   look like X", or any explicit style request — follow it. This brief then only
   fills gaps that direction never addressed. It is never a veto and never a
   reason to argue with a Builder.
2. **The project's chosen design preset** wins where the direction is silent.
3. **This brief** governs everything neither of the above covers — i.e. it is the
   default for a project that specified no design direction at all.
4. **§1–§8 above** remain the structural contract underneath all three.

**One reconciliation, and it is deliberate.** The brief below was written for a
light-only system ("No dark mode"). ProxyPilot's mockup contract (§1) requires a
dark variant and a working theme toggle — that is a platform guarantee and a
machine check, not a style opinion. So: the brief's palette IS the light theme,
and the dark variant is derived from it per §1 (soft dark surfaces, never pure
black; same hues, muted).

**This is already done, and there is a reference implementation.** The base app
ships both themes — `public/style.css` declares the palette twice (`:root` and
`[data-theme="dark"]`, `color-scheme` set in each) and `public/theme.js` carries
the three-state preference. Read those rather than re-deriving the mapping.
Two rules that are easy to get wrong and are pinned by a test:

- Surfaces use `var(--surface)`, never `var(--white)`. `--white` is literal
  white in *both* themes on purpose — it is for text and icons on a solid
  coloured fill. Used as a background it stays white in dark mode.
- Load the theme script **synchronously, before the stylesheet**. Deferred, it
  applies after first paint and flashes white at every dark-mode user on every
  page load.

Nothing else in the brief changes.

Provenance: extracted from the Upload Doc credentialing portal, which is also
ProxyPilot's base application template — so a project that adopts both gets a
frontend that already matches the plumbing it is built on. The full component
inventory lives beside this file in `design-brief-appendix.md`.

### ProxyPilot Default Design Brief — "Upload Doc" System

**Status:** Default design reference. Use this brief when a project does not specify its own design direction. If the user or project spec provides any design guidance (brand colors, a component library, a mockup, "make it look like X"), that guidance wins — this brief fills gaps, it never overrides. It is a starting point, not a mandate.

**Provenance:** Extracted from the Upload Doc credentialing portal (vanilla HTML/CSS/JS, zero frontend dependencies, single stylesheet). The system is proven in production-style use: enterprise-clean, light-only, blue/teal healthcare-professional aesthetic.

---

#### 1. Design personality

Calm, trustworthy, enterprise-professional without being sterile. White cards on a cool near-white background, one confident brand blue, a teal secondary used sparingly (gradients, accents), and semantic green/amber/red reserved strictly for status. Density is moderate: generous card padding, compact tables. Motion is minimal and fast (120–250ms), used for feedback, never decoration. No dark mode.

#### 2. Color tokens

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

#### 3. Typography

System stack only — no webfonts: `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`, `line-height:1.5`, antialiased. Mono for keys/IDs/IPs: `ui-monospace,SFMono-Regular,Menlo,monospace` at 12px.

Scale (weights 600–800 dominate; body content 13–14px; half-pixel sizes are intentional):

- Hero: 38px/700 (scales to 30 → 26 → 23 at breakpoints). Stat numbers: 28px/800, letter-spacing -.02em.
- Page titles 24px/700; section/card headers 15px/700; modal titles 16px/700.
- Body and inputs 14px; buttons 14px/600; secondary rows/tabs 13.5px/600; labels 13px/600; fine print `.small` 12.5px.
- Overline labels (table headers, section titles): 12px/700, uppercase, letter-spacing .03–.04em, slate.
- Badges 11.5px/600; micro-tags 10–11px/700 uppercase.
- All headings: `margin:0; font-weight:700; letter-spacing:-.01em`.

#### 4. Shape, depth, spacing

- Radius ladder: cards/drops 12px (`--radius`), modals 16px, calendar/feature panels 14px, inner panels/alerts 10px, buttons/inputs 9px, small buttons/chips 8px, micro-elements 6–7px, pills/badges/switches 20px, avatars 50%.
- Shadows: cards use `--shadow`; modals `0 24px 60px rgba(8,20,40,.35)`; toasts `0 10px 30px rgba(8,20,40,.35)`; floating controls `0 4px 12px rgba(8,20,40,.16)`. Never use borders + heavy shadow together beyond the 1px `--line` border on cards.
- Focus ring everywhere: `outline:none; border-color:var(--blue-500); box-shadow:0 0 0 3px var(--blue-100)`.
- Page wrap: `max-width:1080px; margin:0 auto; padding:26px 26px 90px`. Sticky app header 62px.
- Card anatomy: header `15px 20px` with bottom border, body `18px 20px`. Modal: header `18px 22px`, body `22px`, footer `16px 22px` right-aligned buttons with 10px gap.
- Key-value grids: `grid-template-columns:130px 1fr; gap:8px 14px`. Detail layouts: `minmax(0,1fr) 320–360px` two-column.

#### 5. Core components

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

#### 6. Layout patterns

- Auth screens: split layout — left gradient brand panel (hero headline, 3-point value list, soft glow orb), right white column with a ≤380px form box. Role-picker cards for multi-audience entry.
- App shell: sticky white header (brand, permission-gated nav buttons, identity block, avatar, logout), content in the 1080px wrap.
- Admin: underlined tab bar, sub-tabs as segmented pills with count badges, search + client-side pagination (page size ~6–10, "1–6 of 23" + Prev/Next).
- Breakpoints: 900px (stack two-column layouts), 768px (header wraps, nav scrolls horizontally, drawer → bottom sheet, toasts full-width), 640px (stats 2×2 with inline number+label, action rows wrap), 400px (tighten paddings).

#### 7. Interaction & motion rules

- Transitions .12s for hover states, .15s for switches/chevrons/dots, .25s toast entry. Micro-lifts `translateY(-1px)` on hover for card-buttons; `translateY(1px)` on `:active`.
- Optimistic, re-render-free updates where scroll position matters (e.g. zoom mutates transform directly).
- Confirmation UX: destructive actions get red styling and explicit verbs; disabled buttons carry `title="why"` explanations instead of disappearing.
- Popup-blocker-safe external opens: `window.open('about:blank')` synchronously on click, set `tab.opener=null`, `location.replace(url)` after async work, `tab.close()` on failure.
- Realtime feedback: SSE-driven toasts and immediate route changes (e.g. deactivation kicks to a lock screen with auto-restore polling).

#### 8. Voice & copy

Sentence case everywhere. Direct, calm, second-person ("You do not have permission to perform this action."). Errors are machine-coded for the client, human-readable for the person; clients branch on codes, never message text. Neutral responses for anything enumerable ("If an account exists for that email…"). Explain consequences in-place ("Your name is recorded on any field you change."). Empty-state copy is encouraging, never blank.

#### 9. Known gaps — improve when building new work

These are inherited limitations; new projects should do better without changing the visual language: add `prefers-reduced-motion` guards; add focus traps + Escape handling to modals; give the date picker keyboard navigation (`role="grid"`, arrow keys, per-day `aria-label`); replace remaining `window.prompt/confirm` with styled modals; ensure the HTML escaper covers quotes; optional dark mode only if requested.

