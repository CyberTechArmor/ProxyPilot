---
name: design-reference
description: LOOKUP REFERENCE for ProxyPilot's four flagship design themes (Portal Blue, Folio Warm, Folio Light, Folio Dark), their art-direction contracts, craft rules, and the design taste rubric. Use when a conversation discusses design quality, themes, registers, palettes, typography pairings, or "make it look like X" for ProxyPilot projects or generated apps — to check or cite the house standard. This is a reference to consult, NOT an instruction to build everything in these themes.
---

# ProxyPilot design reference

This is the house design standard as a **lookup**, not a mandate. Consult it to
answer "which register fits this app?", "what does our warm editorial theme
specify?", or "why does this screen read as a B instead of an A?" — then cite
the relevant contract. Never apply a theme to a project that has chosen a
different direction; the project's own approved design always wins.

Source of truth in code: `admin/backend/src/mock2/design-presets.js`
(tokens + `artDirection` contracts), `design-review-logic.js` (taste rubric).
If this file and the code disagree, the code wins — update this file.

## The core thesis (why form lags function, and the fix)

Generated apps used to score "function A-, form B." The B had mechanical
causes, learned by comparing against reference-grade output:

1. **No committed art direction** — semantic tokens (primary/surface/danger)
   keep a look *consistent*; a **named palette with usage roles** (rust does
   selection, nothing else gets a hue) makes it *designed*.
2. **One font family** — a register comes from a **pairing**: a display face
   used only in display moments against a UI face for all chrome.
3. **No signature details** — the crafted touch that makes an app itself
   (a selection treatment, a leader line, paper-on-desk layering).
4. **Minimal-diff iteration** — quick updates preserve existing mediocrity;
   form needs dedicated polish passes.

## Choosing a register

| App smells like… | Theme | Register |
|---|---|---|
| Portal, admin, ops, records, credentialing | **Portal Blue** | Dense, legible SaaS — working software |
| Publishing, editorial, portfolio, hospitality, studio tools | **Folio Warm** | Warm editorial studio — calm, tactile |
| Collaboration, review, docs, approval flows | **Folio Light** | Light gallery — airy, precise |
| Focused creative work, media review, night-use tools | **Folio Dark** | Dark studio — theatrical about the work |

## The four flagship contracts

### Portal Blue — SaaS portal (the base-app look)

Named palette: `portal-blue #1466b8` (the ONE interactive accent — buttons,
links, active nav) · `teal #12a3a3` (data highlights only, never controls) ·
`cool-wash #f5f8fc` (page) · `card-white #ffffff` (surfaces) ·
`slate-ink #12263f` (all text) · `hairline #e2e8f1` (borders).

Type: deliberately **single-face** (system sans). Hierarchy from weight
(800 brand / 700 headings / 600 labels) and size steps — never a second family.

Signature details: pill status badges with a leading colored dot · numbered
section cards with slim progress meters in the header · primary buttons carry
a small leading icon.

### Folio Warm — editorial studio (paper & rust)

Named palette: `ink #1d1b18` (text) · `ink-soft #6e675f` (captions) ·
`rust #a74f36` (**THE** accent: selection, primary actions, live indicators —
nothing else gets a hue) · `rust-pale #ead3ca` (chips/soft fills) ·
`paper #fbf6ea` (the working sheet) · `shell #d8d2c8` (the desk behind it) ·
`rail #eee8de` (side panels) · `line #c9c0b4` (hairlines).

Type pairing: **Georgia serif display / Inter-class sans UI.** Georgia ONLY in
display moments — page titles, pull quotes, page-number furniture, big
numerals. Every control and label is the sans. The serif/sans rhythm IS the
register.

Signature details: paper-on-desk layering (the work floats as a lighter sheet
above a darker surround) · dashed selection frames with small square corner
handles · one rust accent — everything else earns attention through type and
spacing.

### Folio Light — light gallery

Named palette: `gallery-wash #f6f7f9` (page) · `paper-white #ffffff`
(surfaces) · `ink #17181c` (text) · `quiet #697077` (secondary) ·
`cobalt #2563eb` (**THE** accent) · `leaf #16a34a` (positive chips only) ·
`hairline #e4e7eb` (dividers carry the structure — not boxes).

Type pairing: Georgia display for document titles and content; sans for all
chrome. Content reads like print, chrome reads like software.

Signature details: structure from hairline dividers and generous margins ·
status in soft pill chips (tinted fill, darker text) · floating micro-toolbars
appear on selection, close to the work.

### Folio Dark — dark studio

Named palette: `char #141511` (the studio) · `panel #1b1d17` (chrome) ·
`parchment #f3ecd9` (the WORK canvas — the one bright thing on screen) ·
`bone #e8e4d8` (text) · `ash #98988a` (secondary) · `moss #a3b53c`
(**THE** accent: selection, ticks, leader lines) · `seam #2a2c24` (borders).

Type pairing: Georgia lives on the parchment; the dark chrome is all sans.
The two worlds — warm work, dark studio — never swap type.

Signature details: contrast reserved for the work itself (parchment canvas on
near-black) · dashed leader lines connect comments/annotations to their
targets · selected items get a thin moss frame with square handles.

## Craft rules (apply in every register)

- ONE spacing scale (multiples of the spacing unit); no ad-hoc gaps.
- ONE accent does interactive emphasis; status colors appear only on status.
- The display face appears only in display moments — never on controls.
- Every screen has one focal point and one clear primary action.
- A new look must be DECLARED before it is used: named palette (5–8 tokens
  with roles), a type pairing with its rule, one signature detail — then
  followed on every screen.

## The taste rubric (how form is graded)

When reviewing a screen, grade beyond fidelity and defects:

1. **Typographic rhythm** — display and UI faces where they belong; sizes on
   a scale, not one-off values.
2. **Palette restraint** — one accent doing the interactive work; no orphan
   hues that belong to no role.
3. **Register coherence** — an editorial app must not sprout dashboard
   chrome; a console must not sprout marketing type.
4. **Signature detail** — at least one per screen; its absence is what makes
   a screen generic.

## External reference points (steal judiciously)

Linear (keyboard-first, command palette) · Stripe Dashboard (quiet data
design) · Notion Calendar (scheduling UI) · Figma (comments/presence,
selection affordances) · tldraw (canvas interaction) · Typst/print for paged
output. Cite these for *interaction* patterns; palettes and type come from
the contracts above.

## Where this lives at runtime

- Theme picker: project creation / design chat ("On theme / New look").
- Contract injection: `applyDesignPreset` / `applyExploreDesign`
  (admin toggle "Art-direction contract", on by default).
- Review grading: `buildReviewPrompt` taste rubric (admin toggle, on).
- Admin switches: Admin queue → **Design quality** card.
