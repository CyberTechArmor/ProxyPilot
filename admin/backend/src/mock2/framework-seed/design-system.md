# Mock2 Design System — v1 (PROVISIONAL starting point, risk R8)

> This is the one seed field with genuine operator input: the tokens below are
> transcribed from the operator's chat→mockup design reference
> (`docs/mock2/design/07-chat-mockup-design-reference.md`, 2026-07-09). It is
> still marked **provisional** — the full locked design system that constrains
> the mockups the model generates is owed by the operator. Treat this as a
> starting point, not the final locked system.

## Scope

This document is the design system the **mockups the model generates** must
obey (ADR-003). It is distinct from the ProxyPilot Studio *chrome* around those
mockups, which uses the app's existing shadcn/Tailwind theme.

## Tokens (studio/build-view reference palette)

- **Surfaces:** base `#070b11`; panels `#0a0f18` / `#0d1420` / `#0f1621`;
  hairline `rgba(255,255,255,.06)`.
- **Primary:** green `#22c55e`.
- **Phase accents:** cyan `#22d3ee` (design), amber `#f59e0b` (building),
  emerald `#34d399` (live).
- **Text:** `#e8edf4`; muted `#8a97a8`; faint `#5d6b7d`.
- **Type:** Manrope, falling back to `system-ui`.
- **Shape:** generous radii (9–16px), soft shadows.

## Rules (provisional)

1. Mockups are HTML artifacts committed under `state/mockups/` and served
   through the project's preview URL path (M7).
2. Tappable choices (suggestion chips, rule-question options) are ≥44×44px —
   `MOBILE_FIRST.md` is a merge gate.
3. A generated app renders cleanly at 360/375px in a single column.

_Replace with the operator's full locked design system when it is supplied._
