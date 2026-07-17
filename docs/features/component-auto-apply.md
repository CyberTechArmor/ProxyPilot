# Component auto-apply (`component_auto_apply`)

## Why

The original component flow was suggest-and-confirm: a published component was
only offered to a project when the design inventory's extracted capabilities
happened to match the component's `requires_when` contract, and it only
installed after an editor tapped "Use the standard component". In practice that
meant a library of known-good, pre-built components mostly sat unused while
builds re-implemented the same capability from scratch — burning build credits
and time on solved problems.

## What it does

With auto-apply **on** (the default), the platform confirms **every published
component** for **every build**:

- The confirm happens at the single choke point every build passes through —
  `preinstallComponents` (`component-install.js`), called from
  `proceedToBuild` and the "install now" route. Rows are recorded with
  `origin = 'auto'` (migration 528 extends the CHECK).
- Installation is the existing deterministic, zero-token pre-install: files
  land sha256-verified, migrations renumber to append, declared npm deps
  install, non-secret `.env` defaults merge, contract connections pre-declare
  in `state/integrations.json` — all before the build runner's first model
  turn. The build's AI budget is spent wiring the design to the installed
  APIs, and the `component-reuse` gate blocks re-implementation.
- Define-time `component_suggestion` questions are skipped while auto-apply is
  on (`audit.js`) — they would only block the build to ask about components
  that will install regardless.

Human decisions still win:

- A component an editor/operator **declined** stays declined — auto-apply
  never overrides it.
- Keep-existing install semantics are unchanged: a file an earlier build
  adapted is never overwritten by a re-install.

## The admin toggle

- **UI:** Admin queue → "Auto-apply standard components" card (on/off switch).
- **API:** `GET/POST /api/mock2/settings/component-auto-apply`
  (`{ enabled: boolean }`, admin-gated, audited as
  `MOCK2_SETTING_COMPONENT_AUTO_APPLY`).
- **Storage/precedence:** `mock2_settings.component_auto_apply` →
  `MOCK2_COMPONENT_AUTO_APPLY` env → `'on'`.

Turning it **off** restores the previous behavior exactly: suggestion on
capability match, per-project confirm, operator direct pick.

## Notes

- A failed component install still blocks the build (a half-installed
  component is worse than none); with auto-apply installing the whole catalog,
  a broken published component blocks all builds — deprecate it in the
  library, or turn auto-apply off, while fixing it.
- Pure decision logic (`normalizeComponentAutoApply`,
  `selectAutoApplyComponents`) lives in `component-logic.js` and is covered by
  `mock2-component-auto-apply.test.js`.
