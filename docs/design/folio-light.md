# Folio Light — the Atelier design register (binding)

Extracted from the `<style>` block of `docs/reference/atelier-prototype.html` (the design
authority) and the port-mission summary. **Binding for all Atelier UI work.** When a value
here and the prototype CSS disagree, the prototype wins — update this file, don't fork it.

## The register in one paragraph

White chrome (`#fff`) on a cool gallery wash (`#f2f3f6`). Structure comes from 1px hairline
dividers (`#e6e8ee`) and generous margins — **not boxes or heavy cards**. **One cobalt**
(`#2140d9`) is the only interactive accent: links, active states, primary buttons, focus,
the stage rail's current stop. Georgia serif for display and document moments; system sans
for UI. Soft pill status chips (tinted background, no borders). Pastel avatar tones (ink for
the owner). Floating micro-toolbars appear on selection. Proposal and report pages render as
warm paper (`#fdfbf6`) with running heads, dotted-leader TOC and print-faithful CSS —
content reads like print, chrome reads like software. The pipeline is the navigation:
numbered stage rail 01–08, checkmarks on completed stages. Every screen keeps at least one
signature detail. Client-facing surfaces must stay clean at 360px.

## Tokens

```css
:root{
  --wash:#f2f3f6;          /* cool gallery wash — app background */
  --chrome:#ffffff;        /* white chrome — sidebar, topbar, cards */
  --ink:#191b20;           /* primary text */
  --ink2:#4b5160;          /* secondary text */
  --mute:#8a90a0;          /* muted text */
  --faint:#b6bac6;         /* faintest text / disabled */
  --hair:#e6e8ee;          /* hairline divider — THE structural device */
  --hair2:#d8dbe4;         /* stronger hairline (borders, inputs) */
  --cobalt:#2140d9;        /* THE accent — the only interactive color */
  --cobalt-ink:#1a34b0;    /* cobalt hover */
  --cobalt-wash:#eef1fd;   /* cobalt tint background */
  --paper:#fdfbf6;         /* warm proposal/report paper */
  --paper-ink:#22201b;     /* ink on paper */
  --ok:#177a4c;   --ok-wash:#e7f4ec;
  --warn:#9a6a12; --warn-wash:#faf1dd;   /* amber — also the client-badge family */
  --bad:#b3383e;  --bad-wash:#fbeaea;
  --violet:#6d5bd0; --violet-wash:#efedfa;
  --teal:#177a86; --teal-wash:#e5f3f4;
  --serif:Georgia,'Times New Roman',serif;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  --sh-pop:0 8px 28px rgba(25,27,32,.13),0 2px 6px rgba(25,27,32,.08);  /* popovers/modals */
  --sh-soft:0 1px 3px rgba(25,27,32,.07);                               /* cards */
  --r:8px;
}
```

Paper-context neutrals (used only on paper surfaces): rules `#e2ddd2`/`#eae6db`, muted ink
`#6f6a5c`, faint ink `#9b968a`, TOC dot leader `#c9c3b4`. Sticky note: `#fff7d6` with
`#eadfa8` border. Paper backdrop behind pages: `#e9e7e1`.

Semantic color mapping (never re-hue): stage chips — inquiry neutral, brief teal, concept
violet, estimate warn, proposal/production cobalt, delivery ok, report neutral. Phase
colors — Discovery `#6d5bd0`, Design `#2140d9`, Production `#177a86`, Delivery `#177a4c`.
Calendar — task cobalt-wash, booking teal-wash, meeting violet-wash, milestone plain ink
bold with ◆. Avatar tones — ink `#191b20` (owner), sky `#dde8f2/#2b4a68`, peach
`#f4e2d7/#7c4a2d`, mint `#dcece5/#28584a`, plum `#e9e0eb/#5d3f63`, sand `#ede5d4/#6b5426`.

## Typography

- **Sans (UI):** base `14px/1.5`; small `12px`/`12.5px`, tiny `11px`; tabular numerals
  (`font-variant-numeric:tabular-nums`) on every money/number column.
- **Serif (display + documents):** page titles `26–29px` weight 400; section heads `16–18px`
  weight 400; doc titles `34px`; doc body `15px/1.65`; stat values `27px`; paper h1 `38px`.
- **Editorial page header pattern** (every content screen): uppercase cobalt **eyebrow**
  (`10.5px`, letter-spacing `.16em`, weight 700) → serif title as a short editorial
  statement ("One river, eight bends.") → *italic serif* subtitle in `--ink2`.
- **Labels/table headers:** `10.5px` uppercase, letter-spacing `.1–.12em`, weight 600,
  muted.
- **Signature script** (typed e-signature): `'Segoe Script','Snell Roundhand',cursive`.

## Component rules

- **Structure:** hairline `border-bottom: 1px solid var(--hair)` between rows/sections;
  cards only where a surface truly floats (kanban cards, portal cards, rails) — white,
  1px hairline border, radius 9–12px, `--sh-soft`. Never heavy borders, never gray boxes.
- **Buttons:** default = white, `--hair2` border, radius 7px, 13px/500; primary = solid
  cobalt (hover `--cobalt-ink`); ghost = borderless; small = `3px 9px`/12px; danger = red
  text only. Disabled = 45% opacity.
- **Chips:** pill (radius 99px), tinted wash background, tone-colored text, **no border**,
  optional leading dot; `11.5px/500`. Exception — the **client chip**: `#fdf3e4` amber wash,
  `#9a6a12` text, **1px dashed `#e5cf9e` border** — the one dashed border in the system,
  marking client presence everywhere (comment badges, share states).
- **Inputs:** white, `--hair2` border, radius 7px; focus = cobalt border +
  `0 0 0 3px rgba(33,64,217,.12)` ring. Bare variant (inline titles): borderless until
  focus, then cobalt underline only.
- **Modals:** centered, radius 12px, `--sh-pop`, backdrop `rgba(20,22,28,.4)` + 2px blur;
  serif title; hairline header/footer. ≤ 480px (720px wide variant); full-width at <760px.
- **Floating micro-toolbar** (`.mtb`): pill, white, hairline border, `--sh-pop`, appears on
  selection with a 120ms pop animation. Toasts: ink pill, bottom-center; automation toasts
  carry a cobalt ⚡.
- **Empty states:** centered; dashed-circle glyph (44px), serif title, muted 12.5px
  subtitle, primary action button. Every list has one (R5).
- **Menus/popovers:** white, hairline, radius 9px, `--sh-pop`, uppercase section labels.
- **Tables:** uppercase muted header row over `--hair2` rule; rows separated by `--hair`;
  row hover = `rgba(33,64,217,.03)`; clickable rows get pointer.
- **Segmented control:** hairline-bordered pill group; active segment cobalt-wash + cobalt.
- **Toggle switch:** 32×18 pill, cobalt when on.
- **Avatars:** circles with initials, pastel tones above; presence stack overlaps −6px with
  white 2px ring + green status dot.

## The stage rail (the pipeline is the navigation)

Full-width bar under the topbar on project screens: an overview home stop, then the eight
stages, numbered `01–08` in 22px circles. Done = cobalt-wash circle with checkmark; current
= solid cobalt circle, cobalt label, 2px cobalt underline; upcoming = muted. Horizontally
scrollable on small screens (no scrollbar).

## Paper surfaces (proposal, report)

A4-proportioned pages (794×1123 desktop) on the `#e9e7e1` backdrop, `--paper` background,
serif throughout, running heads (uppercase, letter-spaced, `#9b968a`) and page numbers,
dotted-leader TOC, grouped investment table with heavy top/bottom rules, signature box
(`#fffdf9`, `#d9d3c4` border) with baseline rule. Print CSS makes `#printarea` the page:
exact same markup exports to PDF. Content reads like print; chrome (`.noprint`) reads like
software. At <760px pages go full-width with reduced padding.

## Signature details (keep at least one per screen)

- Estimate: drag-fill corner handle on selected numeric cells + live margin meter vs target.
- Timeline: dependency bezier arrows + cobalt today-line + translucent phase bars.
- Boards: comment pins (amber = client, cobalt = team), minimap with viewport rect, left
  tool rail.
- Docs: drag-handle block reorder + slash menu + selection micro-toolbar.
- Threads: amber dashed client badges.
- Dashboard: utilization heat row (amber over 95%), single-hue funnel (opacity ramp).
- Portal: serif welcome that changes with pending work; on-track chip.
- Canvas/flow editors: dotted-grid background (`radial-gradient(var(--hair2) 1px, transparent 1px)` / 22px).

## Motion

Tiny and purposeful only: `pop` (120–180ms ease-out, 4px rise + 0.97 scale) for popovers/
toolbars/toasts; `slidein` (160ms) for the comments drawer; 120ms transitions on switches.
No page transitions, no parallax, nothing over 200ms.

## Responsive & accessibility floors

- Default breakpoints in use: 1100/1000/900/760/640/520; sidebar becomes an overlay drawer
  ≤900px; side rails stack ≤1000px; kanban columns `82vw` ≤760px.
- **Portal at 360px: zero horizontal scroll on every screen** (R5, gate G5). Grids collapse
  to one column; file split stacks; drawer goes full-width.
- Touch: pan/zoom surfaces set `touch-action:none`; one-finger pan on canvas; touch targets
  ≥44×44 where tappable (per repo mobile rules).
- Focus states always visible (cobalt ring); `::selection` is cobalt at 16%.
