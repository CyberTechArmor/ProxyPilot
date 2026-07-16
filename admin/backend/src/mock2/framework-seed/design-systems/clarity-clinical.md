# Clarity Clinical — Design Framework

A calm, trustworthy design system for healthcare and compliance-oriented web apps
(credentialing, onboarding, document collection, provider/admin portals). It reads as
professional and clinical without feeling cold: deep blues and a teal accent, generous
whitespace, soft shadows, pill-shaped status badges, and a document-centric interaction
model. It is a LIGHT theme (cool off-white app background, white cards).

## 1. Design principles

1. **Trust over flash.** Muted, desaturated blues; no hard black; soft shadows instead of
   heavy borders. Nothing shouts except a genuine problem (which turns red).
2. **Status is always visible.** Every object of work carries a colored pill badge and, where
   relevant, a progress bar. The user should never wonder "where does this stand?"
3. **Work happens on the object, not in a side channel.** Conversation, review, and preview
   are attached to the individual document — not a separate inbox. This is the framework's
   signature interaction (see §7).
4. **One accent gradient.** Blue → teal (135°) is the brand signature — used on the logo mark,
   progress fills, and hero panels, and nowhere else. It keeps a large UI feeling like one system.
5. **Roomy, scannable rows.** Content is expressed as icon + title + subtitle + right-aligned
   actions. Lists breathe; density comes from grouping, not cramming.
6. **Graceful escalation.** Neutral → informational (blue) → attention (red). Color is reserved
   for meaning, never decoration.

## 2. Design tokens

Implemented as CSS custom properties on `:root`.

### Color

| Token | Value | Role |
|---|---|---|
| `--blue-900` | `#0a3d6e` | Darkest brand; hero gradient start, deep headings |
| `--blue-700` | `#0b5cad` | Brand primary text/links on light, active nav text |
| `--blue-600` | `#1466b8` | **Primary action** (buttons), progress start |
| `--blue-500` | `#2f80d8` | Focus ring border, mid-tone accents |
| `--blue-100` | `#e7f1fb` | Info badge bg, active-nav pill bg, icon tiles |
| `--blue-50`  | `#f3f8fd` | Subtle hover fills, preview surfaces |
| `--teal`     | `#12a3a3` | **Secondary accent**; gradient end, "team" avatars |
| `--teal-100` | `#e2f6f5` | Teal icon tiles / soft fills |
| `--ink`      | `#12263f` | Primary text (never pure black) |
| `--slate`    | `#5a6b81` | Secondary/muted text, subtitles, icons |
| `--line`     | `#e2e8f1` | Hairline borders, row dividers |
| `--bg`       | `#f5f8fc` | App background (cool off-white) |
| `--white`    | `#ffffff` | Card/surface background |
| `--gray-100` | `#eef2f7` | Neutral chips, "subtle" buttons, empty progress track |
| `--green` / `--green-100` | `#1f9d57` / `#e5f6ec` | Success / approved |
| `--amber` / `--amber-100` | `#c9820a` / `#fdf3e1` | In-review / caution, "also emailed" hint |
| `--red` / `--red-100` | `#d24545` / `#fbe9e9` | Needs-attention, notification dots, errors |

**Semantic status → color mapping** (used everywhere status appears):

| Status | Text/Fill | Background | Meaning |
|---|---|---|---|
| Approved / complete | `--green` | `--green-100` | Done, verified |
| Pending / in review | `--blue-700` | `--blue-100` | Submitted, awaiting action |
| In review (soft) | `--amber` | `--amber-100` | Optional secondary "processing" state |
| Needs attention | `--red` | `--red-100` | Action required |
| Not provided / empty | `--slate` | `--gray-100` | Nothing yet (neutral, not alarming) |

### Elevation

| Token | Value | Use |
|---|---|---|
| `--shadow` | `0 1px 2px rgba(16,42,72,.06), 0 8px 24px rgba(16,42,72,.07)` | All cards, stat tiles, primary surfaces |
| Toast | `0 10px 30px rgba(8,20,40,.35)` | Floating toasts |
| Modal / drawer | `0 24px 60px rgba(8,20,40,.35)` | Dialogs |

Shadows are blue-tinted (not gray) and low-opacity — surfaces feel lifted, not boxed.

### Radius

| Token | Value | Use |
|---|---|---|
| `--radius` | `12px` | Cards, stat tiles, large surfaces |
| Buttons | `9px` (sm: `8px`) | |
| Inputs | `9–10px` | |
| Chips / icon tiles | `8–10px` | |
| Badges & progress | `20px` (full pill) | |
| Modal / drawer | `16px` | |
| Avatars | `50%` | |

### The signature gradient

```css
/* brand mark, progress fills, hero panels */
background: linear-gradient(135deg, var(--blue-600), var(--teal));   /* mark */
background: linear-gradient(90deg,  var(--blue-600), var(--teal));   /* progress */
background: linear-gradient(160deg, #0a3d6e, #0b5cad 55%, #12a3a3);  /* hero / auth banner */
```

## 3. Typography

- **Family:** system stack — `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`. No web-font dependency; renders crisp everywhere.
- **Smoothing:** `-webkit-font-smoothing: antialiased`.
- **Base:** 14px body, `line-height: 1.5`, color `--ink`.
- **Headings:** weight 700 (hero 800), `letter-spacing: -0.01em` (tight display: `-0.02em`).

| Role | Size | Weight | Notes |
|---|---|---|---|
| Hero display | 38–40px | 800 | Split-screen banner |
| Page title (h1) | 24px | 700 | |
| Section / card title (h3) | 15px | 700 | |
| Body | 14px | 400/600 | 600 for row titles |
| Small / meta | 12.5px | 400/600 | `--slate` |
| Micro (badges, stamps) | 11.5–12px | 600/700 | Often UPPERCASE with `letter-spacing: .03–.06em` |
| Eyebrow / section label | 12px | 700 | UPPERCASE, `letter-spacing: .04em`, `--slate` |

Utility classes: `.muted` (`--slate`), `.small` (12.5px), `.sectitle` (uppercase eyebrow).

## 4. Layout archetypes

**App background** is `--bg`; content sits on white cards. Max content width `1080px`,
horizontal padding `26px`, generous bottom padding (`~90px`) so the last card clears the fold.

1. **Split auth / marketing screen.** Full-height two-column: left half is the brand gradient
   panel (logo, headline, 3 icon+text value props, fine-print footer, a soft radial "glow"
   in a corner); right half is a neutral surface centering a ~380px auth card. Collapses to
   stacked on narrow screens. *This is the framework's front door.*
2. **Sticky app header (62px).** White, hairline bottom border. Left: gradient logo mark +
   wordmark (+ optional context badge like "Team console"). Center-left: text nav tabs
   (active tab = `--blue-100` pill). Right: optional notification bell with count, then an
   identity cluster (name + role + avatar). Header sticks below any top utility bar.
3. **Content well.** Centered `1080px` column of stacked cards.
4. **Master detail.** A roster table → a detail view with a summary header card + the same
   grouped content. Optional right rail via `.detail-grid` (`minmax(0,1fr) 320px`), collapsing
   to one column ≤900px.
5. **Grouped accordion.** Long forms/checklists are split into numbered, collapsible section
   cards, each with its own mini progress bar. Prevents the "endless form" feeling.
6. **KPI row.** 4-up stat tiles (`repeat(4, 1fr)`, 2-up on narrow) — big number + small label,
   number tinted by semantic color.

## 5. Component library

### Buttons

Base: `--blue-600` fill, white text, `9px` radius, weight 600, `padding: 9px 16px`; inline-flex
with a 7px gap for a leading icon. Hover darkens to `--blue-700`.

- `.ghost` — white fill, `--blue-700` text (secondary).
- `.subtle` — `--gray-100` fill, `--ink` text (tertiary/neutral).
- `.sm` — `padding: 6px 11px`, `12.5px`, `8px` radius.

Convention: neutral/idle rows use **subtle** actions; rows needing action use the **filled** primary.

### Status badge

Pill (`border-radius: 20px`), `11.5–12px`/600, with a **leading 7px dot** made from a `::before`
in `currentColor` at 0.85 opacity. Background + text from the status map in §2. This dot-pill is
the most repeated atom in the system.

### Cards

White, `1px solid --line`, `--radius`, `--shadow`. Optional `.card-h` header row (title left,
actions/meta right, hairline underneath) and `.card-b` body (`18–20px` padding).

### Progress bar

8px track, `--gray-100`, fully rounded; fill is the blue→teal 90° gradient. Appears at three
scopes: overall (page header), per-section (accordion header), per-row (roster mini-bar, ~130px
wide paired with a `done/total` count).

### List row ("item row")

The workhorse. `display:flex`, `~12px` vertical padding, hairline top divider, hover = `--blue-50`
with rounded corners. Anatomy: **icon tile** (38px, `--blue-50`/`--blue-700`, rounded) → **info**
(600 title + `--slate` subtitle, truncating) → **right actions** (wrap-friendly, right-aligned):
a notes chip, a status badge, and a context action. The whole row is clickable to open the object;
inner buttons `stopPropagation`.

### Notification dot & note chip

- **Dot:** 11px red (`--red`) circle with a 2px white ring, absolutely pinned to an item's icon
  tile top-right. Signals "something here needs *you*."
- **Note chip:** small outlined pill (`--line` border, chat glyph + count or the word "Note").
  Turns red-tinted (`.hot`) when that item is awaiting the viewer.

### Icon tile

Square (34–46px), rounded (`8–12px`), soft tinted bg with a matching-hue stroke icon. Blue for
default, teal for secondary, semantic tints for status contexts. Used in feature lists, empty
states, toasts, modal headers.

### Avatar

Circle with 2-letter initials. `--blue-600` for primary users, `--teal` for internal/admin — a
quick way to distinguish audiences.

### Table (roster)

Borderless except hairline row dividers. Uppercase `12px` `--slate` column heads. Rows hover
`--blue-50` and are fully clickable. Cells mix an identity cluster (avatar + name + sub), inline
mini-progress, badges, and a trailing action.

### Yes/No segmented toggle

For binary/access questions: a `--gray-100` pill housing two buttons; selected "Yes" fills
`--green`, selected "No" fills `--slate`. Compact alternative to upload/status for boolean data.

### Toast (notification)

Bottom-right stack. **Dark navy** (`#0b2a49`) card — deliberately inverted from the light UI so
system feedback reads as "the system talking." Icon tile (translucent white) + bold title +
muted body line. Slides in from the right, auto-dismisses (~5s, fades). Used for every consequential
action and for the email-fallback notice (§7).

### Modal & drawer (two-layer stack)

- **Confirm modal:** centered ~460px card, `16px` radius, header (icon tile + title + sub) / body
  / right-aligned footer actions. For uploads, "request a fix," confirmations.
- **Object drawer:** wide (~880px) two-pane dialog — **preview** on the left over a `--blue-50`
  wash, **conversation** on the right. This is where an object is inspected and discussed.
- Two z-layers: a confirm modal can open *on top of* the drawer (drawer `z ~1500`, confirm `~1700`),
  so you can act without losing context. Backdrop is `rgba(10,25,45,.5)`; click-outside closes.

### Preview surfaces

Content-type-aware previews (never a raw filename):

- **Document** → a faux "paper": colored top band (status-tinted), title, subtitle, skeleton
  text lines, and a rotated outlined **stamp** (e.g. `APPROVED`, `NEEDS ATTENTION`).
- **Info field** → a clean key/value card.
- **Boolean/access** → a big circular ✓ / — / ? with a one-line verdict.
- Empty state → dashed-border tile with an icon and a single primary action.

### Empty states

Dashed `2px --line` border, centered icon tile, short bold line + faint hint + one action. Warm,
never a dead end.

## 6. Motion, focus & interaction

- **Transitions:** short and physical — `0.12–0.15s` on hover/selection; toasts slide `0.25s`.
  Cards may lift `translateY(-1px)` on hover (role cards). No long or bouncy easing.
- **Focus ring:** `border-color: --blue-500` + `box-shadow: 0 0 0 3px --blue-100` on inputs.
  Consistent, soft, on-brand — applied to every focusable field.
- **Hover language:** interactive rows/cards shift to `--blue-50`; buttons darken one step.
- **Auto-grow textareas** in composers (42→110px) so notes feel like chat, not a form.
- **Reveal-on-demand:** accordion sections and the object drawer keep the surface calm until the
  user asks for depth.

## 7. Signature pattern — object-attached conversation with presence-aware delivery

The interaction that most defines this framework:

- Every work object (a document, a field, a task) owns its **own note thread and preview**,
  opened in the two-pane drawer. There is **no global chat/inbox** — discussion is always
  in the context of the exact object, so nothing gets orphaned.
- Threads are chat-style bubbles: sender-aligned right (filled `--blue-600`), other party left
  (`--blue-50` outlined), each with a tiny author · time meta line.
- **Presence-aware delivery.** When a note is posted, the recipient is either present (in-app,
  instant) or absent (the note is *also emailed*). Emailed notes carry a small amber
  "also emailed" tag in the thread, and the sender gets a toast stating exactly what happened
  ("delivered in-app, no email" vs "emailed to …"). A presence flag drives the choice.
- **Directed notification.** An unresolved item shows the red dot + a hot note chip for whoever
  owes the next move, and a header **bell** aggregates the count for that person. Opening the
  object clears its flag for that viewer.

Reusable beyond credentialing: order comments, ticket/case notes, review requests, approval
workflows — anywhere back-and-forth should live on a specific record and reach people whether or
not they're online.

## 8. Responsive & accessibility notes

- **Single breakpoint at 900px** does most of the work: split-screen stacks, the drawer's two
  panes stack (preview over notes), detail rails collapse to one column, KPI grids go 2-up.
- Text on the gradient panel uses light tints (`#dbe9f7`, `#cfe0f2`) tuned for contrast on the
  dark half; body text is `--ink`/`--slate` on white for comfortable contrast.
- Status is **never encoded by color alone** — every badge pairs its color with a text label
  (and the icon tile/stamp reinforce it), which keeps it legible for color-vision deficiencies.
- Focus states are always visible (soft ring). Hit targets are row-sized, not icon-sized.

## 9. Microcopy & voice

- **Warm, plain, reassuring.** "Welcome back." "It only takes a minute." "Nothing uploaded yet —
  start below." Guidance, not jargon.
- **Say what just happened, concretely.** Toasts name the object and the outcome
  ("Your note on *Board Certification* was emailed to …").
- **Sentence case** for UI text; **UPPERCASE** reserved for tiny eyebrows, stamps, and column heads.
- **Progress framed positively** — "20 of 51 approved · 39%," not "31 missing."

## 10. Minimal token seed (drop-in starting point)

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
  --font: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
```

**Reproduce the look with:** these tokens · system font · dot-prefixed pill badges · blue→teal
gradient on mark/progress/hero · soft blue-tinted shadows on white cards · icon+title+subtitle+
actions rows · dark navy toasts · the two-pane object drawer (preview + object-attached notes)
with presence-aware email fallback.
