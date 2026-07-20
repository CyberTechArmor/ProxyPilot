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
