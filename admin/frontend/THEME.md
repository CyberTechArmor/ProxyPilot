# Editing the dashboard theme

The shared palette lives in `src/index.css`: `:root` defines light colors and
shared defaults; `.dark` overrides dark colors. Values are HSL channels, without
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
| Green actions and focus | `--primary`, `--primary-foreground`, `--ring` | Buttons and focus rings |
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
then review stock/custom login, Profile, desktop sidebar and mobile drawer in both
themes. Check 360, 375, 390, 768, 1280 and 1920px layouts with the overflow guard
disabled, keyboard focus, error states, placeholders and disabled states. Require
Lighthouse mobile accessibility >=90 and report remaining findings. A palette
edit is not authorization to change authentication, PWA contracts or live branding.
