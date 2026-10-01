# Editing the dashboard theme

The shared palette lives in `src/index.css`: `:root` defines **Office** colors and
shared defaults; `[data-theme="latte"]` overrides **Latte** colors; `.dark` applies
the unchanged **Midnight** palette. These are exactly three color-only themes.
Typography, icons, layout, spacing and behavior are shared. Values are HSL channels, without
an `hsl()` wrapper. `tailwind.config.js` maps these variables to semantic utility
names. Change palette values in CSS rather than adding color literals to pages.

| Role | CSS token | Consumer |
| --- | --- | --- |
| Page and recessed inputs | `--background` | `bg-background` |
| Raised cards | `--card`, `--card-foreground` | Card primitive |
| Popovers | `--popover`, `--popover-foreground` | Popover primitives |
| Sidebar | `--sidebar` | `bg-sidebar`; light aliases card |
| Mobile drawer scrim | `--navigation-backdrop` | `bg-navigation-backdrop`; includes alpha |
| Secondary/hover surfaces | `--secondary`, `--muted`, `--accent` | Corresponding semantic utilities |
| Primary text | `--foreground` | `text-foreground` |
| Helpers, placeholders, inactive navigation | `--muted-foreground` | `text-muted-foreground` |
| Card dividers | `--border` | `border-border` |
| Input outlines | `--input` | `border-input` |
| Actions and focus | `--primary`, `--primary-foreground`, `--ring` | Buttons and focus rings |
| Error surfaces/text | `--destructive`, `--destructive-foreground` | Destructive variants |

For example, change `.dark`'s `--card: 0 0% 16%` to adjust every token-based dark
card. Change `--muted-foreground` to tune secondary text, then recheck it against
page, card, sidebar and hover surfaces. Override `--navigation-backdrop` in `.dark`
only if the two modes should differ. Disabled controls keep their existing opacity;
do not use muted text to represent a disabled control.

Spacing uses existing Tailwind scale tokens, not pixel literals. Profile's outer
container uses `max-w-3xl`, `space-y-6 lg:space-y-8`; its password form uses
`space-y-4 lg:space-y-6`. These are the bounded controls for Profile density. Keep
default breakpoints and the mobile requirements in `MOBILE_FIRST.md`. The close
button and recovery disclosures use `h-11`/`min-h-11` for 44px targets.

The palette is separate from operator branding. Saved names, logos and favicons
remain authoritative through `src/lib/branding.js`. The stock rocket SVG and PNG
assets are separate artwork; changing `--primary` does not recolor saved artwork
or raster icons. Do not alter those assets as an incidental palette edit.

This is the shared dashboard theme, not a conversion of every legacy one-off
status color or embedded editor palette. Preserve those separate semantics unless
a later task explicitly includes them.

After changing tokens, run the frontend build and existing branding/PWA tests,
then review stock/custom login, Profile, desktop sidebar and mobile drawer in all three
themes. Check 360, 375, 390, 768, 1280 and 1920px layouts with the overflow guard
disabled, keyboard focus, error states, placeholders and disabled states. Require
Lighthouse mobile accessibility >=90 and report remaining findings. A palette
edit is not authorization to change authentication, PWA contracts or live branding.

## Preference and selector

The accessible Color theme menu in the desktop sidebar and mobile header offers
Midnight, Latte and Office. The existing `pp-theme` preference persists the
selected ID. Legacy `dark` maps to Midnight and `light` to Office. Missing,
invalid or unavailable storage keeps Midnight, the historical default.
`index.html` sets both `data-theme` and the `dark` class before paint;
`ThemeContext` uses the same normalization and synchronizes storage changes.
Native controls receive `color-scheme: dark` only for Midnight.

Latte uses ivory surfaces, charcoal text and muted sand-gold actions. Office
uses white/cool surfaces and blue actions. These palettes do not modify
operator branding, fonts, icons or layout. The supplied palette image could
only be read as extracted text in the cloud; no exact image color sampling
is claimed.

Validation: `node --test test/theme.test.mjs`;
`node tests/broker-connections.browser.mjs` exercises persisted selection,
keyboard use, modal colors, rendered text contrast and responsive layout.
Set `LIGHTHOUSE_DIR` to a temporary Lighthouse installation to run optional
accessibility snapshots as part of those browser journeys.

## Bounded rendered contrast evidence (2026-10-01)

The broker browser journey samples Chromium's computed colors from the actual
focused Connection name input, unavailable-status banner and submission error.
Focus visibility and its rendered shadow are checked in addition to the color
ratio. Office/Latte functional input outlines use the adjusted `--input` token.

New broker/setup forms and catalogue errors use the `.broker-colors` scope,
including both portaled connection dialogs. Its semantic roles are
`--broker-control-outline` and `--broker-error-text`. Office/Latte use the
existing input/destructive roles. Midnight borrows its existing
`--muted-foreground` for functional outlines and `--foreground` for errors.
**No original Midnight palette value changes, new dark color values, geometry
changes or copied components are involved.** Error messages remain explicit
and announced through `role="alert"`; color is not their only indication.

| Theme | Input focus ring | Functional input outline | Status text | Error text |
| --- | ---: | ---: | ---: | ---: |
| Midnight | 5.28:1 | 9.77:1 | 11.21:1 | 16.63:1 |
| Latte | 5.72:1 | 3.24:1 | 10.45:1 | 6.55:1 |
| Office | 6.46:1 | 3.70:1 | 17.43:1 | 4.59:1 |

All measured broker roles meet 3:1 for focus indicators/functional input
outlines and 4.5:1 for normal status/error text. The browser checks enforce
those thresholds for all three themes, with no Midnight broker exception.
Card grouping outlines are decorative and are reported separately; they do
not replace a control's functional outline or its text label.

The initial probe found 1.87:1 for the original global Midnight input token
and 1.74:1 for its global destructive-text token against the modal surface.
The scoped aliases resolve those failures for newly added broker controls.
Unrelated legacy/native dark controls and original global tokens remain
unchanged; this is not an accessibility clearance for those older surfaces,
every legacy status color, or embedded editors. Lighthouse normal-state
snapshots complement rather than replace the focused/error-state checks.
