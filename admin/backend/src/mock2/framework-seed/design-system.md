# Mock2 Design System — v1 (locked)

This is the locked design system the **mockups the model generates in Stage 1**
must obey (constitution §6.1; ADR-003). A mockup that departs from these tokens
and rules is non-conforming. It is distinct from the ProxyPilot Studio *chrome*
around those mockups, which uses the app's existing shadcn/Tailwind theme.

> Source: the operator's chat→mockup design reference
> (`docs/mock2/design/07-chat-mockup-design-reference.md`, 2026-07-09) plus the
> framework's Stage-1 rules (§4). This is the operator's real design surface;
> revisions publish a new framework version (append-only — never edit v1 in place).

## Color tokens

- **Surfaces:** base `#070b11`; panels `#0a0f18` / `#0d1420` / `#0f1621`;
  hairline dividers `rgba(255,255,255,.06)`.
- **Primary:** green `#22c55e` (the single accent for primary actions).
- **Phase accents (status only, never decoration):** cyan `#22d3ee` (design),
  amber `#f59e0b` (building), emerald `#34d399` (live).
- **Text:** default `#e8edf4`; muted `#8a97a8`; faint `#5d6b7d`.

## Type & shape

- **Type:** Manrope, falling back to `system-ui`. One type family; weight and
  size carry hierarchy, not additional families.
- **Shape:** generous corner radii (9–16px); soft, low-contrast shadows; no hard
  1px borders except the hairline divider token.
- **Spacing:** an 8px rhythm (4/8/12/16/24/32).

## Rules (binding)

1. **Mockups are non-functional.** Forms, buttons, views, and navigation are
   interactive, but there is no data persistence and no integration — a mockup
   demonstrates the idea, it does not run it.
2. **One palette, one type family.** Use only the tokens above. Do not introduce
   gradients-as-decoration, second accent colors, or additional typefaces. If a
   Builder asks for a look these tokens forbid, honor the system and say so.
3. **Mobile-first.** Every screen renders cleanly at 360/375px in a single
   column; multi-column layouts collapse to one column on small viewports.
4. **Touch targets ≥ 44×44px.** Suggestion chips, rule-question options, and any
   tappable control meet the minimum (this mirrors the platform's `MOBILE_FIRST`
   merge gate).
5. **Self-contained artifacts.** A mockup is a single HTML file with inline CSS
   and JS — no external hosts, fonts, scripts, or images (embed as data URIs).
   Mockups are committed under `state/mockups/` and served through the project's
   preview URL path.
6. **The inventory is the contract, not the pixels.** On design approval the
   system extracts the design inventory (screens, fields-with-types, actions,
   states) and discards the mockup code. Design consistency is enforced by these
   tokens; behavior is enforced by the rules, never by the mockup's markup.
