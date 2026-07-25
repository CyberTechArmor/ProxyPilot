# Upload Doc — Physician Credentialing Portal: Frontend Extraction

## 0. File topology (important for the brief)

| File | Role |
|---|---|
| `/root/work/app/app/public/index.html` | The real app shell. 19 lines. Loads `/style.css?v=48`, then `/portal.js?v=48`, then `/app.js?v=48`. Declares 5 mount points: `#root`, `#toasts`, `#modalRoot`, `#modalRoot2`, `#globalToasts`. |
| `/root/work/app/app/public/app.js` | IIFE. Auth SPA controller + app shell + **admin console**. Owns `#root`, `#globalToasts`, and `#modalRoot` (for its own `modal()`). |
| `/root/work/app/app/public/portal.js` | IIFE exposing `window.Portal = { render(container, identity, opts), currentRole() }` and `window.openCalendar`. Owns the credentialing portal (physician checklist + team roster/detail/reports + document drawer + date picker). |
| `/root/work/app/app/public/style.css` | 598 lines, single stylesheet, all tokens. |
| `/root/work/app/app/public/portal.html` | **Standalone disposable prototype** (1802 lines: CSS lines 1–402 inline, body 404–427, inline JS 428–1802). Not loaded by the app. Has a `#demobar` "Prototype demo — view as:" role switcher and an "Other party currently online" toggle, hardcoded sample physicians, and a hand-rolled `demoPacketPdf()` byte-builder. It is an earlier snapshot of `portal.js` + `style.css`; `style.css` is a strict superset (see §1.13). |

---

# 1. DESIGN SYSTEM

## 1.1 Color palette — complete `:root` token list

`style.css:1-10` (identical block at `portal.html:8-17`):

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

**Roles:**

| Token | Value | Role |
|---|---|---|
| `--blue-900` | `#0a3d6e` | Gradient origin only (`.split .left`, `.screen` background) |
| `--blue-700` | `#0b5cad` | Brand wordmark, active-nav text, headings on tinted chips, button hover fill |
| `--blue-600` | `#1466b8` | **Primary action.** Button fill, links, avatar bg, selected calendar day, progress gradient start, active tab underline |
| `--blue-500` | `#2f80d8` | Focus/hover border color; `today` ring; `paper-band.pending` |
| `--blue-100` | `#e7f1fb` | Focus ring (`0 0 0 3px`), active nav pill bg, `b-pending` badge bg, drag-active drop zone |
| `--blue-50` | `#f3f8fd` | Softest tint: hover rows, preview column bg, `.fv-media` bg, gate panel, chips |
| `--teal` | `#12a3a3` | Secondary accent: logo gradient end, progress gradient end, `.avatar.team`, demo switch "on" |
| `--teal-100` | `#e2f6f5` | Team role-card icon bg |
| `--ink` | `#12263f` | Primary text |
| `--slate` | `#5a6b81` | Secondary/muted text, table headers, icons |
| `--line` | `#e2e8f1` | All borders/dividers |
| `--bg` | `#f5f8fc` | Page background |
| `--white` | `#fff` | Surfaces |
| `--green` / `--green-100` | `#1f9d57` / `#e5f6ec` | Approved / success / "deal Active" / matrix `on` cell |
| `--amber` / `--amber-100` | `#c9820a` / `#fdf3e1` | Review / gate tag / expiring-soon / "SYSTEM" tag / "also emailed" via-label |
| `--red` / `--red-100` | `#d24545` / `#fbe9e9` | Attention / expired / destructive / notification dot & count |
| `--gray-100` | `#eef2f7` | Neutral fill: subtle buttons, `.xbtn`, segmented-control track, disabled input bg, progress track |

**Hardcoded (non-token) colors worth cataloging:**

| Hex | Where |
|---|---|
| `#08243f` | `#demobar` background (prototype only) |
| `#0e344f`, `#9fb8d0`, `#33506b`, `#cfe0f2` | demobar internals |
| `#37c978` | demobar live "dot" |
| `#0b2a49` | `.toast` background (dark navy) |
| `#c9dbf0` | `.toast .tb` body text |
| `#dbe9f7`, `#cfe0f2`, `#a9c4de` | `.split .left` lede / plist sub / foot text on gradient |
| `#f2cccc` | Danger button border, `.notes-chip.hot` border, `.alert.err` border |
| `#f7dede` | `.btn.danger-soft:hover` |
| `#e3e9f1` | `.btn.subtle:hover`, `.xbtn:hover` |
| `#a5292b` | `.alert.err` text |
| `#cfe2f7` | `.alert.info` border |
| `#bfe6cd` | `.alert.ok` border |
| `#fbecec` | `.matrix td.off` |
| `rgba(10,25,45,.5)` | `.modal-bg` scrim |

**Gradients:**
- Logo tile: `linear-gradient(135deg,var(--blue-600),var(--teal))`
- Auth left panel / `.screen`: `linear-gradient(160deg,#0a3d6e,#0b5cad 55%,#12a3a3)` (`.screen` uses `60%`)
- Progress fill & stepper: `linear-gradient(90deg,var(--blue-600),var(--teal))`
- Glow orb: `radial-gradient(circle,rgba(255,255,255,.16),transparent 70%)`, 380×380, `right:-120px;top:-90px`
- Mobile sticky action bar: `linear-gradient(to top,var(--blue-50) 70%,transparent)`

## 1.2 Typography

**Single stack, no webfonts:**
```css
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif
```
`-webkit-font-smoothing:antialiased`, `line-height:1.5` on body. Mono stack for keys/IPs: `.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}`.

**Global:** `h1,h2,h3{margin:0;font-weight:700;letter-spacing:-.01em}`.

**Size/weight scale (note the half-pixel sizes — a signature of this system):**

| px | Weight | Usage |
|---|---|---|
| 38 | 700 | `.split .left h1` (hero); →30 @768, →26 @640, →23 @400 |
| 28 | 800, `-.02em` | `.stat .n`; →20 @640 |
| 26 | 800 | `.pv-access .pv-a-ic` |
| 24 | 700 | Page `h1` (inline `style="font-size:24px"`), `.screen h1` |
| 22 | 700 | `.screen .brand.big`, auth `h2` (inline) |
| 21 | 700 | prototype authForm `h2` |
| 20 | 700 | Profile/detail `h2` (inline) |
| 18 | 800, `-.02em` | `.brand`; →16 @768 |
| 17 | 800 | `.paper .paper-title` |
| 16 | 700 | Modal/drawer `h3` (inline), `.pv-info-v` (600), `.pv-access .pv-a-t` |
| 15.5 | 800 | `.otp-cta` |
| 15 | 700 | `.card .card-h h3`, `.sec-h h3`, `.rolecard .rc-t`, `.cal-title`, `.cal-selected-date`, `.field input.deal-date-modal` (600) |
| 14.5 | 700 | `.plist b` |
| 14 | 600/400 | Buttons, nav, inputs, `.item .dt`, table `td`, `.kv` |
| 13.5 | 600 | `.authtab`, `.drawer-tab`, `.admin-subtabs button`, `.nmsg .bubble`, `.ff-row` inputs, `.alert`, `.notes-composer textarea`, `.cal-day`/`.cal-cell` |
| 13 | 600 | `.field label`, `.backlink`, `.whoami`, `#demobar`, `.logout-btn`, `.exp-control input`, `.cal-link`, `.dfbtn` |
| 12.5 | — | `.small` utility, `.rc-s`, `.roletag`, `.filter-chip`, `.chip`(12), `.stat .l`, `.audit-row`, `.gate-lbl`, `.b-*` context |
| 12 | 700, uppercase, `.03–.04em` | `.sectitle`, `table.roster th`, `.ff-view-l`, `.pv-info-h`, `.stamp`(`.06em`), `.gate-st` |
| 11.5 | 600 | `.badge`, `.exp`, `.admin-subtabs .st-count` |
| 11 | 700, uppercase, `.03em` | `.cal-dowc`, `.ff-by`, `.gate-tag` |
| 10.5 | 700 | `.bell .cnt`, `.nmsg .meta`, `.tag-sys` |
| 10 | 600 | `.nmsg .via` |

## 1.3 Spacing / radius / shadow

**Radius ladder** (no scale variable beyond `--radius:12px`):
`50%` (avatar, dots, glow, `.deact-ic`, `.pv-a-ic`, `.carousel-nav`) · `20px` (all pills/badges/progress/switches) · `18px` (`.screen .panel`) · `16px` (`.modal`; `16px 16px 0 0` for mobile bottom sheet) · `14px` (`.cal`, `.rolecard`, `.fv-doc .di`) · `12px` (`--radius`, `.drop`, `.toast`, `.pv-file`, `.fv-media`, `.authtabs`, `.rc-ic`) · `10px` (`.bell`, `.paper`, `.alert`, `.notes-composer textarea`, `.exp-control`, `.sec-gate`, `.cal-selected`, `.fv-zoom`, `.admin-subtabs`, `.deal-date-modal`) · `9px` (`.btn`, `.field input`, `.ff-in`, `.cal-day`, `.cal-cell`, `.cal-nav button`, `.rolechk`, `.avatar-adjacent tiles`, `.logout-btn`) · `8px` (`.btn.sm`, `.xbtn`, `.grip`, `.notes-chip`, `.yn`, `.deal-date`, `.exp-control input`, `.cal-title-btn`, brand logo, `.sec-h .num`, `.tic`) · `7px` (`.tabsplit button`, `.stamp`, `.fv-zbtn`, `.admin-subtabs button`, `.switch-btn`) · `6px` (`.grip:hover`, `.cal-link`, `.fv-media img`) · `5px` (`.fv-dot.on`, `.paper-lines i`) · `4px` (`.stepper .st`; bubble tails via `border-bottom-*-radius:4px`).

**Padding conventions:**
- Card: header `15px 20px`, body `18px 20px`
- Modal: header `18px 22px`, body `22px`, footer `16px 22px`
- Page wrap: `.wrap{max-width:1080px;margin:0 auto;padding:26px 26px 90px}` → `18px 16px 80px` @768 → `14px 12px 72px` @400
- Table: `th 10px 14px`, `td 13px 14px`
- Item row: `12px 4px` with `border-top:1px solid var(--line)`
- Section header: `13px 18px`; section body `2px 18px 6px`

**Fixed heights:** demobar `44px`; `header.app` `62px` (→`auto/min-height:56px` @768); avatar `34px` (roster `36px`, profile `56–58px`); `.bell` `38×38`; `.xbtn` `32×32`; `.cal-day` `38px`; `.cal-cell` `44px`; `.cal-nav button` `32×32`; `.carousel-nav` `36×36`; `.prog` `8px`; `.stepper .st` `5px`; `.gate-sw` `38×22` knob `18px` translate `16px`; demobar switch `34×19` knob `15px` translate `15px`.

**Shadows:**
- `--shadow` (cards/stats/paper/deal-bar/cal): `0 1px 2px rgba(16,42,72,.06),0 8px 24px rgba(16,42,72,.07)`
- Modal/panel: `0 24px 60px rgba(8,20,40,.35)`
- Toast: `0 10px 30px rgba(8,20,40,.35)`
- Floating controls (`.fv-zoom`, `.carousel-nav`): `0 4px 12px rgba(8,20,40,.16)`
- Mobile bottom sheet: `0 -6px 24px rgba(8,20,40,.18)`
- Selected calendar day: `0 2px 6px rgba(20,102,184,.35)`
- OTP CTA rest/hover: `0 4px 16px rgba(20,102,184,.08)` → `0 8px 24px rgba(20,102,184,.16)`
- Focus ring pattern: `box-shadow:0 0 0 3px var(--blue-100)` (inputs) / `0 0 0 4px var(--blue-100),0 0 0 6px rgba(20,102,184,.28)` (`.profile-avatar:focus-visible`)
- Tab "lifted white pill": `0 1px 3px rgba(0,0,0,.08)` / `0 1px 2px rgba(16,24,40,.08)`

## 1.4 Buttons — full variant table

Base `.btn`: `border:1px solid var(--blue-600);background:var(--blue-600);color:#fff;padding:9px 16px;border-radius:9px;font-weight:600;font-size:14px;display:inline-flex;align-items:center;gap:7px;white-space:nowrap`

| Variant | Definition |
|---|---|
| `.btn` (primary) | blue-600 fill; hover → blue-700 fill + border |
| `.btn.ghost` | `#fff` bg, blue-700 text, blue-600 border; hover `--blue-50` |
| `.btn.subtle` | `--gray-100` bg+border, `--ink` text; hover `#e3e9f1` |
| `.btn.danger-soft` | `--red-100` bg+border, `--red` text; hover `#f7dede`/`#f2cccc` |
| `.btn.danger` | white bg, `--red` text, `#f2cccc` border; hover → solid red fill, white text |
| `.btn.sm` | `padding:6px 11px;font-size:12.5px;border-radius:8px` |
| `.btn[disabled]` | `opacity:.6;cursor:not-allowed` |
| `.otp-cta` | Full-width outlined CTA: `1.5px` blue-600 border, `border-radius:12px`, `padding:14px 18px`, `font-weight:800;font-size:15.5px`, 20×20 icon, lift on hover (`translateY(-1px)`), `.primary` inverts to filled |
| `.linkbtn` | Bare underlined blue-600 text button, `font-size:12px` |
| `.backlink` | Bare slate 600/13px with `gap:6px` icon; hover blue-700 |
| `.logout-btn` | White, `--line` border, slate, `radius 9px`, `8px 13px` |
| `.switch-btn` | Micro button `3px 9px`, 12px |
| `.xbtn` | 32×32 gray-100 close square |
| `.dfbtn` | Pill filter button (`radius 20px; 7px 13px`); `.on` → blue-600 fill; `.clear` → red text / `#f2cccc` border |
| `.cal-link` | Bare blue-600 "Today" link |
| `.packet-download` | `min-width:180px;justify-content:center`; `.is-loading{cursor:wait;opacity:.82}` |

## 1.5 Form inputs

```css
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--ink)}
.field input,.field select,.field textarea{width:100%;border:1px solid var(--line);border-radius:9px;padding:10px 12px;font-size:14px;font-family:inherit;color:var(--ink);background:#fff}
.field input:focus,...{outline:none;border-color:var(--blue-500);box-shadow:0 0 0 3px var(--blue-100)}
```
Parallel class for the drawer field-form: `.ff-in` (same treatment; `:disabled{background:var(--gray-100);color:var(--ink)}` — i.e. disabled keeps full-contrast text). `textarea.ff-in{resize:vertical;min-height:44px}`.

Checkbox row: `.rolechk{display:flex;gap:9px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;margin-bottom:8px;font-size:13.5px}`, input `16×16`, `.rolechk.dis{opacity:.55}`.

Native date input styling (`.field input.deal-date-modal`) restyles `::-webkit-datetime-edit` and `::-webkit-calendar-picker-indicator` (hover: `opacity:1;background:var(--blue-100)`) — but the app almost always uses the **custom** picker instead.

## 1.6 Cards / panels

```css
.card{background:var(--white);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.card .card-h{padding:15px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px}
.card .card-h h3{font-size:15px}
.card .card-b{padding:18px 20px}
```
Utilities: `.muted{color:var(--slate)}`, `.small{font-size:12.5px}`, `.sectitle` (12px uppercase 700 slate, `.04em`), `.kv` (`grid-template-columns:130px 1fr;gap:8px 14px`), `.detail-grid` (`minmax(0,1fr) 320px;gap:22px;align-items:start`).

Specialised panels: `.pv-info`, `.pv-access` (with `.pv-a-ic` 56px circle; `.yes` green-100, `.no` gray-100), `.pv-file`, `.paper` (fake-document mock with `.paper-band` 8px status stripe, `.paper-lines i` skeleton bars at 92/78/85/60/88/44% widths, and a rotated `-4deg` `.stamp`), `.deal-bar` (`.ready` gets a green `0 0 0 2px var(--green-100)` halo), `.locked-note` (`border-style:dashed`), `.item-fields` (gray-100 inset editor).

## 1.7 Tables

```css
table.roster{width:100%;border-collapse:collapse}
table.roster th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--slate);padding:10px 14px;border-bottom:1px solid var(--line)}
table.roster td{padding:13px 14px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:middle}
table.roster tr.rowlink:hover{background:var(--blue-50);cursor:pointer}
```
Person cell pattern: `.who > .avatar + (.nm/.sp)`. Mobile: `.card .card-b{overflow-x:auto}` + `table.roster{min-width:560px}`.

Permission matrix table `.matrix`: full 1px grid, `td.on{background:var(--green-100)}`, `td.off{background:#fbecec}`, `.ovr{outline:2px solid var(--amber);outline-offset:-2px}`, first column left-aligned.

Audit log is NOT a table — it's `.audit-row{display:grid;grid-template-columns:135px 150px 1fr;gap:10px;align-items:baseline}` collapsing to `1fr` @768.

## 1.8 Badges / status pills

```css
.badge{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:20px;white-space:nowrap}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.85}
.b-approved{background:var(--green-100);color:var(--green)}
.b-pending{background:var(--blue-100);color:var(--blue-700)}
.b-attention{background:var(--red-100);color:var(--red)}
.b-missing{background:var(--gray-100);color:var(--slate)}
.b-review{background:var(--amber-100);color:var(--amber)}
```
The `::before` dot inheriting `currentColor` is the notable trick — one rule gives every status pill a matching dot.

JS status map (`portal.js:143`): `approved→"Approved"/b-approved`, `pending→"Pending review"/b-pending`, `attention→"Needs attention"/b-attention`, `missing→"Not provided"/b-missing`. Access-type items override to "Not answered" / "Has access" / "No access".

**Expiry pills** (`.exp`, `1px 8px`, 11.5px, no dot): `.exp-ok` gray · `.exp-soon` amber · `.exp-expired` red · `.exp-unset` blue-50 with **`border:1px dashed var(--blue-100)`**.

**Other pill families:** `.chip` / `.chip.gray` · `.filter-chip` · `.roletag` · `.pill-check` · `.gate-tag` (amber, 11px/700) · `.tag-sys` (amber, 10.5px/700) · `.notes-chip` (`.hot` → red) · `.st-count` (count badge inside sub-tabs) · `.bell .cnt` (red counter, `min-width:17px`, `border:2px solid #fff`) · `.ndot` (11px red dot with 2px white ring, absolutely positioned `top:-3px;right:-3px` on the file icon) · `.stamp` (rotated outline stamp, color-matched to status).

## 1.9 Modals / drawers

Two stacked layers by design:

| Layer | Root | z-index |
|---|---|---|
| Layer 1 | `#modalRoot` | `.modal-bg` `z-index:1500` |
| Layer 2 | `#modalRoot2` | `#modalRoot2 .modal-bg{z-index:1700}` |

```css
.modal-bg{position:fixed;inset:0;background:rgba(10,25,45,.5);z-index:1500;display:flex;align-items:center;justify-content:center;padding:22px}
.modal{background:#fff;border-radius:16px;max-width:460px;width:100%;box-shadow:0 24px 60px rgba(8,20,40,.35);overflow:hidden}
.modal .m-h{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
.modal .m-b{padding:22px}
.modal .m-f{padding:16px 22px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:10px}
```

The review **drawer** (`.modal.drawer`) is responsive-adaptive in three modes:

- **Desktop ≥901px** (`style.css:390-404`): becomes fullscreen. `#modalRoot .modal-bg:has(.modal.drawer){padding:0;align-items:stretch;justify-content:stretch}` — a **`:has()` selector** is load-bearing here. Drawer goes `width:100%;height:100vh;height:100dvh;border-radius:0`. `.drawer-b{grid-template-columns:minmax(0,1fr) 360px}`, preview column centered with `max-width:820px` (viewer `1100px`), `.fv-media{min-height:58vh}`, note composer grows to `height:96px;max-height:220px`.
- **Default/tablet**: `.drawer{max-width:880px}`, `.drawer-b{display:grid;grid-template-columns:1fr 340px;min-height:420px}`, `.pv-col`/`.notes-col{max-height:66vh}`. `.drawer-tabs{display:none}`.
- **≤768px**: becomes a **bottom sheet**. `.modal-bg:has(.modal.drawer){padding:0;align-items:flex-end}`; drawer `height:90vh;height:90svh` (comment explicitly notes `svh` avoids reflow flicker when the mobile toolbar shows/hides), `border-radius:16px 16px 0 0`. `.drawer-tabs` appear; `.drawer-b` switches from grid to `flex-direction:column`; panels toggled by attribute selector: `.drawer-b[data-dtab="preview"] .notes-col{display:none}` / `[data-dtab="notes"] .pv-col{display:none}`. Team review buttons relocate from `.team-actions--head` (hidden) to `.team-actions--foot`, a sticky bottom bar with a gradient fade.

**Body scroll lock** (`portal.js:712-714`): `lockBodyScroll()` saves `window.scrollY`, sets `body.style.top = -Y`, adds `body.drawer-open{position:fixed;left:0;right:0;width:100%;overflow:hidden}`; `unlockBodyScroll()` restores and `scrollTo`. CSS comment states `position:fixed` is required for iOS Safari.

`app.js modal()` is a separate, simpler generic: `max-width:520px;max-height:88vh;display:flex;flex-direction:column` with `.m-b{overflow:auto}`, `[data-mclose]`/`[data-msave]`/`[data-mbg]` hooks, backdrop-click close.

## 1.10 Toasts

Two containers, both bottom-right stacked columns with `gap:10px`:
- `#toasts{right:20px;bottom:22px;z-index:3000}` — used by `portal.js`
- `#globalToasts{right:20px;bottom:22px;z-index:4000}` — used by `app.js`

```css
.toast{background:#0b2a49;color:#fff;border-radius:12px;padding:14px 16px;min-width:300px;max-width:380px;box-shadow:0 10px 30px rgba(8,20,40,.35);display:flex;gap:12px;animation:slidein .25s ease}
.toast .tic{width:34px;height:34px;border-radius:8px;background:rgba(255,255,255,.14);...}
.toast .tt{font-weight:700;font-size:13.5px;margin-bottom:2px}
.toast .tb{font-size:12.5px;color:#c9dbf0;line-height:1.45}
@keyframes slidein{from{transform:translateX(40px);opacity:0}to{transform:translateX(0);opacity:1}}
```
Dismissal: JS sets `transition:opacity .3s; opacity:0` then removes after 300ms. Lifetime **5400ms** in `portal.js` (`opts.ms` override) vs **4200ms** in `app.js`. `portal.js` toasts accept an SVG icon (`opts.icon`, defaults `ICON.mail`) and permit raw HTML in the body (`<b>` used liberally); `app.js` toasts escape everything and use a plain `✓`/`!` glyph plus a `kind==='err'` argument. Mobile: `#toasts,#globalToasts{left:14px;right:14px;bottom:14px;align-items:stretch}` and `.toast{min-width:0;max-width:100%}`.

## 1.11 Alerts / empty states / loading states

**Alerts** (inline, in auth forms and admin test panels):
```css
.alert{border-radius:10px;padding:11px 14px;font-size:13.5px;margin:6px 0 14px;display:flex;gap:9px;align-items:flex-start}
.alert.err{background:var(--red-100);color:#a5292b;border:1px solid #f2cccc}
.alert.info{background:var(--blue-100);color:var(--blue-700);border:1px solid #cfe2f7}
.alert.ok{background:var(--green-100);color:var(--green);border:1px solid #bfe6cd}
```

**Empty states:**
- `.pv-empty{background:#fff;border:2px dashed var(--line);border-radius:12px;padding:34px 18px;text-align:center}` with a 48px `.di` icon tile — used for "Nothing uploaded yet" / "Nothing provided yet" plus an inline upload CTA.
- `.notes-empty{text-align:center;color:var(--slate);font-size:13px;padding:26px 10px}` — "No notes on this document yet.<br>Start the conversation below."
- Table empty rows are inline `<td colspan>` with `padding:26–34px;text-align:center;class="muted"`. Reports empty state literally ends with 🎉 (`\uD83C\uDF89`).
- `.locked-note` — dashed card for gated sections.
- Detail-filter empty: "Nothing matches this filter." card.

**Loading states (three distinct spinners):**
1. `.spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.5);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite}` — inline in buttons during auth submit; overridden inline to blue for on-white contexts (`border-color:rgba(20,102,184,.3);border-top-color:var(--blue-600)`).
2. `.packet-spinner{13×13;border:2px solid currentColor;border-top-color:transparent;animation:packet-spin .7s linear infinite}` + `.packet-download.is-loading` — currentColor-based so it works on any button variant.
3. Plain `body.innerHTML = '<div class="muted">Loading…</div>'` for every admin tab.

Button-level busy pattern is consistent: disable, swap `innerHTML` to `<span class="spin"></span> Verb…`, restore label on completion. The packet button additionally sets `aria-busy="true"` and restores in a `finally` block.

## 1.12 Responsive / breakpoints

| Query | Behavior |
|---|---|
| `min-width:901px` | Review drawer goes fullscreen (`:has()`), 2-col `minmax(0,1fr) 360px`, roomier composer |
| `max-width:900px` | `.split` stacks; `.stats` → 2 cols; `.drawer-b` → 1 col; `.pv-col` border-right→bottom; `.detail-grid` → 1 col (`!important`) |
| `max-width:768px` | Header wraps, nav becomes an order-3 full-width horizontally-scrolling row; `header.app{position:static}` except `.appshell header.app` stays sticky; `.wrap` → `18px 16px 80px`; `.kv` → 1 col; roster gets horizontal scroll; `.audit-row` stacks; drawer becomes a bottom sheet with tabs; team actions move to sticky foot; toasts go edge-to-edge |
| `max-width:640px` | Demobar wraps; `.stats` 2×2 with `.stat` becoming `display:flex;align-items:baseline` so number+label sit inline ("cut dead space"); `.whoami > div:first-child{display:none}` (hides name block, keeps avatar); `.item{flex-wrap:wrap}` with `.dact` wrapping full-width at `padding-left:51px` (aligning under the 38px icon + 13px gap); modal footer buttons flex to equal width |
| `max-width:400px` | `.wrap` `14px 12px 72px`; hero 23px; nav 13px; `.btn` `8px 13px/13.5px` |

**Sticky offsets:** `header.app{position:sticky;top:44px}` (below demobar) in the prototype; `.appshell header.app{position:sticky;top:0}` in the real app, with `.appshell .wrap{padding-top:22px}` and `.page{padding-top:44px}` (→`0` @768).

## 1.13 Dark mode

**None.** No `prefers-color-scheme`, no `.dark` class, no theme toggle. Also **no `prefers-reduced-motion`** guard — a gap worth flagging in the brief.

## 1.14 Transitions & animations (complete list)

- Keyframes: `slidein` (toast, `.25s ease`), `sp` (spinner, `.7s linear infinite`), `packet-spin` (same timing).
- `.12s` transitions: `.profile-avatar` (transform/box-shadow/filter), `.dfbtn`, `.cal-title-btn`, `.cal-cell`, `.cal-day`, `.cal-nav button`, `.deal-date-modal`, `.otp-cta`, `button.stat` (border-color/box-shadow), `.fv-scale{transition:transform .12s ease}`, webkit picker indicator.
- `.15s`: `#demobar .switch` + knob, `.gate-sw` + `.gate-knob`, `.sec .chev`, `.drop` (border/background), `.authtab`, `.fv-dot` (width+background — the dot **stretches** to a 20px pill when active).
- `.06s`: `button.stat:active` transform.
- `.3s`: toast fade-out (JS-applied).
- Micro-lifts: `.rolecard:hover{transform:translateY(-1px)}`, `.otp-cta:hover{transform:translateY(-1px)}`, `.profile-avatar:hover{transform:translateY(-1px);filter:brightness(.96)}`, `button.stat:active{transform:translateY(1px)}`.
- Rotations: `.sec.collapsed .chev{transform:rotate(-90deg)}`, `.stamp{transform:rotate(-4deg)}`.
- Drag feedback: `.cat-section.dragging,.cat-item.dragging{opacity:.5}`; `.cat-section.dragging>.card{outline:2px dashed var(--blue-500);outline-offset:2px}`; `.cat-item.dragging{background:var(--blue-50);border-radius:8px}`.

---

# 2. DATE PICKER (`openCalendar`) — the standout widget

Defined `portal.js:1164-1244`, exported via `window.openCalendar=openCalendar` (line 1244) **specifically so `app.js`'s admin console can reuse it** (comment: "Expose the stylized picker so the admin console (app.js) can reuse it"). It replaces native `<input type=date>` everywhere it matters.

## 2.1 CSS classes (`style.css:185-212`)

```css
.cal-selected{background:var(--blue-50);border:1px solid var(--blue-100);border-radius:10px;padding:9px 14px;margin-bottom:12px}
.cal-selected-date{font-weight:700;font-size:15px;color:var(--blue-700);margin-top:2px}
.cal{border:1px solid var(--line);border-radius:14px;padding:12px;background:#fff;box-shadow:var(--shadow)}
.cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 2px}
.cal-title{font-weight:700;font-size:15px;color:var(--ink)}
.cal-title-group{display:flex;gap:4px}
.cal-title-btn{border:none;background:transparent;cursor:pointer;font-family:inherit;padding:4px 8px;border-radius:8px;transition:background .12s,color .12s}
.cal-title-btn:hover{background:var(--blue-50);color:var(--blue-700)}
.cal-pick{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:4px 0}
.cal-pick-yr{grid-template-columns:repeat(4,1fr)}
.cal-cell{border:none;background:transparent;border-radius:9px;height:44px;font-size:13.5px;font-weight:600;color:var(--ink);cursor:pointer;font-family:inherit;transition:background .12s,color .12s}
.cal-cell:hover:not(.sel){background:var(--blue-50);color:var(--blue-700)}
.cal-cell.sel{background:var(--blue-600);color:#fff;box-shadow:0 2px 6px rgba(20,102,184,.35)}
.cal-nav{display:flex;gap:6px}
.cal-nav button{width:32px;height:32px;border:1px solid var(--line);background:#fff;border-radius:9px;color:var(--slate);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.12s}
.cal-nav button:hover{background:var(--blue-50);color:var(--blue-700);border-color:var(--blue-100)}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.cal-dow{margin-bottom:2px}
.cal-dowc{text-align:center;font-size:11px;font-weight:700;color:var(--slate);text-transform:uppercase;letter-spacing:.03em;padding:2px 0}
.cal-day{border:none;background:transparent;border-radius:9px;height:38px;font-size:13.5px;font-weight:600;color:var(--ink);cursor:pointer;font-family:inherit;transition:background .12s,color .12s}
.cal-day:hover:not(:disabled):not(.sel){background:var(--blue-50);color:var(--blue-700)}
.cal-day.muted{visibility:hidden;cursor:default}
.cal-day.today{box-shadow:inset 0 0 0 1.5px var(--blue-500)}
.cal-day.sel{background:var(--blue-600);color:#fff;box-shadow:0 2px 6px rgba(20,102,184,.35)}
.cal-foot{display:flex;justify-content:flex-end;margin-top:8px;padding:0 2px}
.cal-link{border:none;background:transparent;color:var(--blue-600);font-weight:600;font-size:13px;cursor:pointer;padding:4px 6px;border-radius:6px}
.cal-link:hover{background:var(--blue-50)}
```

## 2.2 API

```js
openCalendar({ title, subtitle, note, selectedLabel, value, confirmLabel,
               confirmIcon, headIcon, headBg, headColor, allowClear, onConfirm(isoOrEmpty) })
```
Module state: `let _cal={sel:"",y:0,m:0,cb:null}` (+ `mode`). Constants: `CAL_MONTHS` (12 full names), `CAL_DOW=["Su","Mo","Tu","We","Th","Fr","Sa"]`, `CAL_PREV`/`CAL_NEXT` inline chevron SVGs (`stroke-width:2.4`).

It renders into **layer-2** (`openModal2`) so it can stack on top of an already-open drawer/modal. Chrome: `.m-h` with a 34×34 tinted icon tile (`headBg`/`headColor` themable — e.g. green for "Mark deal Active"), `.cal-selected` readout box above the grid, footer with optional `Clear date` (`btn ghost`, `margin-right:auto`), `Cancel` (`btn subtle`), and confirm (`btn`).

## 2.3 Three-mode construction (`renderCalendar`)

**`mode:"days"` (default):** `startDow=new Date(y,m,1).getDay()`; `daysInMonth=new Date(y,m+1,0).getDate()`; leading blanks rendered as `<button class="cal-day muted" disabled>` (hidden via `visibility:hidden`, so grid alignment is preserved without `opacity` hacks). Header holds a `.cal-title-group` of **two independently clickable title buttons** — month → `mode:"months"`, year → `mode:"years"` — plus a `.cal-nav` prev/next pair that rolls the month with year carry (`if(--_cal.m<0){_cal.m=11;_cal.y--}`). Footer has a `Today` link that sets selection + jumps the view.

**`mode:"months"`:** 3×4 grid (`.cal-pick`) of 3-letter month abbreviations; header shows the year as a clickable button (→ years) with prev/next **year** steppers.

**`mode:"years"`:** 4×4 = **16-year page**, aligned by `const start=y-Math.floor(((y%16)+16)%16)` (the double-modulo handles negative years). Title reads `${start} – ${start+15}`; steppers move ±16 years.

Drill-down is the classic day → month → year, and drilling back down is year → month → day.

## 2.4 Notable properties

- **Timezone-safe parsing**: always `new Date(iso+"T00:00:00")` for display, and dates are constructed as strings via `${y}-${String(m+1).padStart(2,"0")}-${String(dnum).padStart(2,"0")}` rather than `toISOString()` on a local date — avoiding the classic off-by-one-day bug. (`_cal.sel` initialization and the `Today` button do use `new Date().toISOString().slice(0,10)`, which is UTC-based.)
- **Live readout**: `sync()` updates `#calReadout` with a long-form label — `calFmt` → `toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})`, i.e. "Friday, July 25, 2026". Shows `—` when unset.
- **Confirm-then-commit**: selection only fires `onConfirm` on the confirm button; `Clear date` fires `onConfirm("")`.
- **Keyboard support: none.** There is no `keydown` handler, no arrow-key navigation, no focus trap, no `roving tabindex`, no Escape handler on layer 2 (only backdrop-click and `[data-close2]`). Every cell is a real `<button>` so Tab order works, and nav buttons carry `aria-label` ("Previous month", "Next year", "Earlier years"…) — but the days grid has **no `aria-label` per day** and no `role="grid"`. This is the picker's main accessibility gap.
- **`.today` marker** uses an *inset* ring so it doesn't shift layout; selected uses solid fill + drop shadow.

## 2.5 Call sites

| Site | File:line | Config highlights |
|---|---|---|
| Mark deal Active (`openActiveModal`) | `portal.js:1245` | Green theme (`headBg:'var(--green-100)'`, `headColor:'var(--green)'`), `confirmIcon:ICON.shield`, `confirmLabel:"Confirm active"` |
| Per-file expiry / renew-by (`pickFileExpiry`) | `portal.js:1084` | `allowClear:true`; PATCHes `/api/files/:id/review` with `expiresAt` |
| Catalog item custom `date` field (drawer) | `portal.js:1352` | `allowClear:true`; writes to a hidden input and relabels the trigger button |
| Admin: catalog item **default expiry date** | `app.js:1120` | Guarded by `if (_eb && window.openCalendar)` — the cross-module reuse |

There is also a legacy native-date path (`#drawerExpiry` + `saveDrawerExpiry`, `.exp-control input[type=date]`, `.deal-date`, `.deal-date-modal`) still styled in CSS.

---

# 3. DOCUMENT VIEWER

## 3.1 Structure

`documentViewerHTML(p,def,d)` (`portal.js:754`) renders a **single-file viewer with a carousel** over `d.files[]` (a document holds *many* files, each reviewed individually):

```html
<div class="fileviewer">
  <div class="fv-media"><div class="fv-scale" style="transform:scale(z)">…media…</div>
    <button class="carousel-nav prev" data-fileprev>…</button>
    <button class="carousel-nav next" data-filenext>…</button>
    <div class="fv-zoom">…</div>
  </div>
  <div class="fv-dots"><span class="fv-count">File 2 of 5</span><div class="fv-dot-row">…</div></div>
  <div class="fv-controls">…file controls…</div>
</div>
```
`.fv-media{min-height:340px;background:var(--blue-50);overflow:auto;padding:10px}` (→`min-height:58vh` on desktop drawer).

## 3.2 Media type branching (`fileMediaHTML`, `portal.js:783`)

| Condition | Rendering |
|---|---|
| `f.mime.indexOf("image/")===0` | `<img src=f.url>` — `max-width/height:100%;object-fit:contain;border-radius:6px` |
| `f.mime==="application/pdf"` | `<iframe src=f.url>` — `width/height:100%;min-height:340px;border:0;border-radius:8px;background:#fff` (native browser PDF viewer, **inline**) |
| `f.office` | `.fv-doc` card: 52px icon tile, filename, "Microsoft Office document." + button `Open in Microsoft viewer` (`data-viewfid`) |
| otherwise | `.fv-doc` card: "Uploaded document." + generic `Open` button |

## 3.3 Zoom / magnifier

`zoomable = mime is image/* or application/pdf`. Controls float bottom-right (`.fv-zoom`, `position:absolute;bottom:12px;right:12px;z-index:4`) as a 3-button white pill: `data-zoom="out"` / `data-zoom="reset"` (shows `%` as its own label, `.fv-zlabel`) / `data-zoom="in"`.

Handler (`portal.js:1343-1349`): step **0.25**, clamped `Math.max(0.5, …)` / `Math.min(4, …)` → **50%–400%**. Notably it mutates `.fv-scale`'s `style.transform` and the reset button's `textContent` **directly, without re-rendering** the drawer — so the scroll position inside `.fv-media` is preserved. `state.fileZoom` resets to `1` on every carousel navigation and on `openDrawer`.

## 3.4 Carousel

`.fv-dot{8×8;border-radius:50%;background:var(--line);transition:width .15s,background .15s}` → `.fv-dot.on{background:var(--blue-600);width:20px;border-radius:5px}` — the active dot morphs into a pill. `data-fileprev`/`data-filenext` wrap modularly (`(idx-1+len)%len`), `data-filego="{i}"` jumps directly. `.fv-count` reads "File N of M". Nav arrows reuse `CAL_PREV`/`CAL_NEXT` — the same chevrons as the date picker.

## 3.5 Microsoft Office viewer integration

**Client** (`portal.js:1102-1123`):
```js
async function officeViewerUrl(fileId){
  const res=await fetch("/api/files/"+encodeURIComponent(fileId)+"/office-url",{credentials:"same-origin"});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.message||"Could not prepare the Microsoft viewer.");
  return "https://view.officeapps.live.com/op/view.aspx?src="+encodeURIComponent(location.origin+data.url);
}
function openOfficeFile(fileId){
  const tab=window.open("about:blank","_blank");
  if(tab) tab.opener=null;
  officeViewerUrl(fileId).then(url=>{
    if(tab) tab.location.replace(url);
    else window.open(url,"_blank","noopener");
  }).catch(e=>{
    if(tab) tab.close();
    toast("Microsoft viewer unavailable",esc(e.message||"Please download the file instead."));
  });
}
```

Three details worth reusing:
1. **Popup-blocker-safe async tab**: opens `about:blank` *synchronously* on the click, then `location.replace()`s it once the async token fetch returns — and `tab.close()`s it on failure. Fallback path re-opens with `noopener` if the tab handle was null.
2. **`tab.opener=null`** manually severs the opener reference (belt-and-braces alongside `noopener`).
3. **Signed, expiring public URL.** `officeapps.live.com` must fetch the file itself, so it can't use the session cookie. Server (`server.js:421-436`) issues `GET /api/files/:id/office-url` → `{code:'OK', url:"/api/public/files/:id?token=…", expiresIn}` via `makeOfficePreviewToken`, gated on `files.OFFICE_EXT.has(rec.ext)` (else `400 NOT_OFFICE`) and `canReadFile` (else `403 FORBIDDEN`). The public endpoint re-verifies the token (`403 PREVIEW_EXPIRED`) and streams with `{forceInline:true}`. Client composes `location.origin + data.url`.

## 3.6 Download vs inline

- **Inline**: `GET /api/files/:id` streams normally; the `?dl=1` query flag flips it (`server.js:418`: `const download = /[?&]dl=1/.test(req.url)` → `files.stream(res, rec.id, {download})`, which sets `Content-Disposition: attachment`).
- Viewer control bar (`fileControlsHTML`, `portal.js:813-818`) renders both side by side:
  - `<button class="btn subtle sm" data-viewfid="…">Open</button>` — routes through `openFileById` → Office viewer or `window.open(f.url,"_blank","noopener")`
  - `<a class="btn ghost sm" href="${f.url}?dl=1" download="${f.name}">Download</a>` — an anchor styled as a button
- `openFile(d)` is the document-level equivalent used by row-level `View` buttons.
- **Packet download** (`gather`, `portal.js:1141`): `GET /api/providers/:id/packet` → `res.blob()` → `URL.createObjectURL` → synthetic `<a download="{sanitized-name}-credentialing-packet.zip">` → click → `URL.revokeObjectURL` + `a.remove()` after 1000ms. Filename sanitizer: `.replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"")||"provider"`. Server sets `Content-Disposition: attachment; filename="…-credentialing-packet.zip"`.

Upload accept list (`portal.js:980`):
```
.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx
```
Copy states "PDF, image, Word, Excel or PowerPoint up to 25 MB".

---

# 4. VIEWS & LAYOUT

## 4.1 Routing model

**No hash routing, no History API routing.** Both modules are pure state-machine SPAs re-rendering `innerHTML` on a container.

- `app.js`: module-level `ME`, `authRole`, `adminTab`, `usersSubTab`, `usersSearch`, `usersPage`. Render functions call each other directly (`renderLogin()`, `renderShell(view)`). The **only** URL involvement is **read-only query params consumed at boot** and then scrubbed:
  - `?reset=<token>` → `renderReset(token)`
  - `?otp=<token>` → `renderOtpLogin(token)`
  - `clearParam(name)` deletes the param via `window.history.replaceState({}, document.title, u.pathname+u.search+u.hash)`.
- `portal.js`: one `state` object (`portal.js:119-127`) and a 3-branch `render()`:
  ```js
  function render(){
    if(state.view==="landing") app.innerHTML=viewLanding();
    else if(state.view==="portal") app.innerHTML=viewPortal();
    else if(state.view==="team") app.innerHTML=viewTeam();
    bind(); saveNav();
  }
  ```
  All interactivity is re-bound from scratch each render via `bind()` walking `data-*` attributes (`data-tab`, `data-goroster`, `data-open-p`, `data-sec`, `data-provide`, `data-review`, …).

**Persistence (two independent localStorage layers):**
- `app.js`: `updoc.shell.<userId>` = `'portal' | 'internal' | 'admin'` — remembers the top-level shell tab, re-validated against permissions on restore.
- `portal.js`: `navKey() = "updoc.nav." + identityId + "." + source` storing `{teamView, physTab, selectedId, detailFilter, rosterFilter, collapsed, drawer, drawerTab}`. `restoreNav()` runs before first render; `restoreDrawer()` runs after `loadData()` and **re-opens the exact document drawer and tab you had open before a refresh** (bailing safely if the doc no longer exists).

## 4.2 `index.html` + `app.js` — screens

**Boot decision tree** (`boot()`, `app.js:72`):
```
?reset  → renderReset
?otp    → renderOtpLogin
GET /api/setup/status → needsSetup → renderSetup
GET /api/auth/me → 200 → enterApp
                 → 403 ACCOUNT_DEACTIVATED → renderDeactivated
                 → else renderRoleChoice
```

**Unauthenticated screens** — all wrapped by `authLayout(rightInner)`, the split-screen marketing layout (`.split.authsplit`): left gradient panel with `.glow` orb, brand pinned `position:absolute;top:54px;left:52px`, centered `.authhero` (h1 "Physician credentialing, without the paperwork chase." + `.lede` + 3-item `.plist`); right `.right > .authbox` (max 380px).

| Screen | Fn | Contents |
|---|---|---|
| First-run setup | `renderSetup` | 2-segment `.stepper` (both `.on`), "Create the super administrator", fields name/username/email/password/confirm, `#setupAlert`. POST `/api/setup` → 201 → `enterApp()` |
| Role choice | `renderRoleChoice` | Two `.rolecard`s: `.phys` ("I'm a physician") and `.team` ("I'm on the credentialing team"), each with `.rc-ic`/`.rc-t`/`.rc-s`/`.rc-go`. Physician → `renderSignup()`; team → `renderLogin()` |
| Sign in | `renderLogin` | `.backlink` + `.roletag`; physicians get `.authtabs` (Create account / Sign in); username-or-email + password; primary "Log in"; `.otp-cta` "Email one-time sign-in link"; physician-only "Forgot your password?"; team gets `.center-note` "Accounts are provisioned by an administrator." |
| OTP request | `renderOtpRequest(prefill)` | Email field prefilled from the login box; `.otp-cta.primary` "Email one-time link". Always returns a neutral message (no account enumeration) |
| Sign up | `renderSignup` | Physician only. Name / email / password / confirm. POST `/api/auth/register` |
| Set password | `renderSetPassword(login)` | First-login flow for admin-provisioned accounts (`mustSetPassword`) |
| MFA | `renderMfa(login)` | 6-digit code field. **Explicitly labeled a stub**: `.alert.info` "(Verification endpoint is a stub in this build.)"; the only button reloads |
| Forgot password | `renderForgot` | Email → POST `/api/auth/forgot` → `.alert.ok` neutral message |
| Reset password | `renderReset(token)` | From `?reset=`; new + confirm; auto-signs-in on success and clears the param |
| OTP consume | `renderOtpLogin(token)` | From `?otp=`; auto-POSTs immediately, shows `.alert.info` with a spinner "Opening Upload Doc…"; on failure shows error + "Back to sign in" |
| Deactivated | `renderDeactivated` | **Not** the split layout — uses `.screen > .panel.deact-wrap`: 74px red `.deact-ic` lock, "Account deactivated", support alert (`support@uploaddoc.io`), and a `.pill-check` with a blue spinner "Checking for reactivation…" |

**Authenticated shell** (`renderShell(view)`, `app.js:410`): `.appshell > header.app + #appContent`. Header = brand, `<nav>` of up to 3 permission-gated buttons, `.headspace`, `.whoami` (name + `roleLabel · provider`), `.avatar.profile-avatar` (click → change-password modal; `.team` teal variant if reviewer/internal), `.logout-btn`.

Three shell views, each permission-gated and self-healing (`renderShell` rewrites `view` if the permission is missing):

| Nav button | View | Renders |
|---|---|---|
| **Portal** (`portal.view`) | `portal` | `window.Portal.render(#appContent, ME, {mode:'providers'})` |
| **Internal Credentialing** (`internal.review`) | `internal` | `window.Portal.render(…, {mode:'internal'})` |
| **Admin console** (any of `users.view, roles.view, perms.manage, ldap.manage, smtp.manage, catalog.manage, audit.view`) | `admin` | `renderAdmin(#appContent)` |

**Admin console** (`renderAdmin`) — `.admin-tabs` (underline-style tab bar) filtered by permission:

| Tab | Perm | Contents |
|---|---|---|
| Users | `users.view` | `.admin-subtabs` (Users / Deleted with `.st-count` counts), live search over name/username/email/provider/roleLabel/status, **client-side pagination** (`USERS_PAGE_SIZE = 6`, Prev/Next + "1-6 of 23" + "Page 1 of 4"), roster table with avatar, provider `.chip.gray`, role `.chip`s, status badge, relative last-login (`fmtLastLogin`: Just now / N min / N hr / N day / date, with a `title` of the full timestamp). Row actions: Roles, Reset (password), OTP (login link), Deactivate/Activate, Delete — each with conditional `disabled title="…"` explaining why. Self-deactivation and self-delete are blocked in the UI. Deleted sub-tab offers Restore |
| Roles | `roles.view` | Card list per role with effective-permission count, `.tag-sys` SYSTEM / `.chip.gray` locked / protected flags, `key: <span class="mono">`, Edit/Delete; role modal groups permission checkboxes by `p.group` with uppercase group headers |
| Permissions | `roles.view` (manage = `perms.manage`) | `.matrix` table, permissions × roles. Cells show `✓`/`✕` plus `*` for overrides. Click cycles **allow → deny → clear override** (`cycleOverride`: `!overridden→true`, `allowed→false`, `else→null`) via `PUT /api/admin/overrides` |
| Directory (LDAP) | `ldap.manage` | Host/Port (2-col `.detail-grid`), Base DN, Bind DN, Bind password (with "(saved — leave blank to keep)"), user search filter defaulting to `(userPrincipalName=%u)` with Entra ID/Azure AD guidance and `%u` / `%(user)s` placeholder docs, Use TLS + Verify TLS cert checkboxes, default-roles chip checkboxes, Save + **Test connection** (renders `.alert.info` with spinner then `.alert.ok`/`.alert.err` showing `code — reason`) |
| Email (SMTP) | `smtp.manage` | Provider `<select>` with **presets** (`SMTP_PRESETS`): SendGrid (`smtp.sendgrid.net:587`, user `apikey`), Resend (`smtp.resend.com:465` secure, user `resend`), Custom. Changing it auto-fills host/port/secure/username and swaps the password label ("API key" vs "Password") and hint text. Plus implicit-TLS/verify checkboxes, From name/email, optional test-to address, Save + Send test email |
| Documents / Internal Documents | `catalog.manage` | Two instances of `adminCatalog` — the internal one passes `{base:'/api/admin/internal-catalog', title:'Internal Documents', audience:'employee'}`. Drag-reorderable sections and items (see §6) |
| Audit log | `audit.view` | `.audit-row` grid: action + timestamp / actor + provider mono / target + reason chip + outcome badge + IP mono |
| 3rd Party Login | `audit.view` | Non-team users only (`!us.isTeam`), sorted by `lastLoginAt` desc, with a client-side search that re-`draw()`s only the `<tbody>` |

## 4.3 `portal.js` — screens

`state.view ∈ {landing, portal, team}`.

- **`landing`** (`viewLanding`): the prototype's own split-screen + role picker + `authForm` (Log in / Sign up `.tabsplit`). In the real app this is dead code — `applyIdentity()` always sets `view` to `portal` or `team`.
- **`portal`** (physician). Two tabs via `appHeader(false)`: **My checklist** / **Profile**.
  - `physChecklist(p)`: title + a right-aligned overall progress block ("**N** of M approved" / "P%") over `.prog`; a red "N documents need your response" alert card if `notifCount(p,'physician')`; a one-line count summary ("X approved · Y in review · Z needs attention · W not started"); then `visibleSections(p).map(sectionCard)`; then `lockedNotice(p)`.
  - `physProfile(p)`: back-link, avatar card, and a `.kv` Account card (Full name / Specialty / NPI / Email / Phone / Location) with a non-functional Edit button.
- **`team`** (credentialing team / internal). `state.teamView ∈ {roster, reports, detail}`. Header tabs: **All physicians** / **Reports** (Reports is suppressed in internal mode).
  - `teamRoster()`: 4 **clickable stat tiles** acting as filters — `all` (Active physicians) / `complete` (Files complete) / `review` (Items in review) / `attention` (Need attention) — plus a `.filter-bar` chip + "Clear filter ✕" when filtered; then a roster table (Physician / Completeness mini-progress / Deal / Detail / Notes / Open). The Deal column is hidden in internal mode.
  - `teamReports()`: two `.stats` rows — "Pipeline & deals" (Providers / In pipeline / Deals completed / Deals cancelled) and "Readiness & expirations" (Files complete / Expired documents / Expiring ≤30 days) — plus a "Needs attention (expiring / expired)" table.
  - `teamDetail(p)`: back-link, provider header card (avatar, name, specialty · NPI · email, progress, **Download packet + files**), a `.deal-bar`, a `.detail-filters` row (Not provided / Pending approval / Needs attention / Note added, each with a count in `<b>`), and every section card with gate controls.

**Audience copy switching** (`audience()`, `portal.js:135`) swaps every user-facing noun between physician-mode and internal-mode: singular/plural/title/intro/all/active/empty/search/person. Internal mode also swaps the API base (`/api/internal/catalog`, `/api/internal/employees`) and reuses the `specialty` field to display email.

**Section card** (`sectionCard`): `.card.sec` with `.sec-h` (numbered `.num` tile, title, optional `.gate-tag`, mini progress, `.chev`), optional `gateControls`, and `.sec-b` of `.item` rows. Collapse logic (`isSecCollapsed`): a filter forces everything open; team mode defaults expanded; **physicians default to collapsed except the section they're currently working on** (`physCurrentN` = first visible incomplete section); an explicit toggle overrides and persists.

**Item row** (`itemRow`): `.fic` icon tile (with `.ndot` if unread) + `.dinfo` (`.dt` name / `.ds` contextual detail from `rowDetail` + expiry pill) + `.dact` (notes chip, status badge, View, team Approve/Approve all, and a context-labeled action button — Upload / Add file / Add / Edit — or a Yes/No `.yn` segmented toggle for `access`-type items). The whole row opens the drawer; every action button calls `e.stopPropagation()`.

---

# 5. UX FLOWS

## 5.1 Login variants (all in `app.js`)

**Code-driven branching** — the header comment states it explicitly: *"Clients branch on machine-readable codes, never on message text."* `doLogin()` inspects `r.data.code`:

| Code | UI response |
|---|---|
| `OK` (200) | `ME = user; enterApp()` |
| `PASSWORD_SETUP_REQUIRED` | → `renderSetPassword(login)` |
| `PASSWORD_RESET_REQUIRED` | Inline `.alert.err` telling the user to use the admin's link |
| `MFA_REQUIRED` | → `renderMfa(login)` (stub) |
| `ACCOUNT_DEACTIVATED` | → `renderDeactivated()` |
| `RATE_LIMITED` | Inline error with the server's message |
| anything else | Generic "Sign-in failed." |

Variants: (a) **local password**, (b) **LDAP** — same form, server-side provider resolution; the login copy says "Use your local account or directory (LDAP) credentials", and `changePasswordModal()` refuses non-`local` providers with "Change your password with your directory administrator"; (c) **email one-time link (OTP)** — request at `POST /api/auth/otp/request`, consume via `?otp=` → `POST /api/auth/otp`; (d) **forgot password** → `POST /api/auth/forgot` → `?reset=` → `POST /api/auth/reset` (auto-signs-in); (e) **admin-issued links** — Reset and OTP buttons in the users table call `/api/admin/users/:id/password-reset` and `/login-link`, then `showIssuedLink()` displays the raw link in a readonly input with a **Copy link** button (`navigator.clipboard.writeText` with `document.execCommand('copy')` fallback), and the toast title varies on `r.data.emailed`.

**Token lifecycle:** `api()` wraps `rawApi()` with **one silent refresh retry on 401** (skipped for `/api/auth/refresh` and `/api/auth/login`). `scheduleRefresh()` runs `POST /api/auth/refresh` every **8 minutes**; on non-200 it probes `/api/auth/me` (403 → deactivated screen, 401 → back to role choice), and it also honors `r.data.active === false`.

## 5.2 Setup wizard

Only a single step is implemented, but it's presented with a 2-segment `.stepper` (both filled). Gated on `GET /api/setup/status → needsSetup`. Copy: "This one-time step creates the first administrator account. You will not see this screen again."

## 5.3 Registration

Physician-only, self-serve, from the role picker → `renderSignup` → `POST /api/auth/register` → 201 + `code:'OK'` → straight into the app (no email verification step). Team members get "Accounts are provisioned by an administrator." Client-side validation: email required, password ≥ 8, passwords match. Same three checks appear in setup, set-password, reset, and change-password — consistently.

## 5.4 Checklist / upload flow

1. Row action or `.pv-empty` CTA → `openProvide(key, replaceId)` opens a **layer-2** modal titled `Upload — X` / `Replace file — X` / `Provide — X`.
2. **Drop zone** `.drop#dropZone`: click-to-browse (`dz.onclick=()=>fi.click()`), plus `dragenter`/`dragover` → `.drag` class, `dragleave`/`drop` → remove. Selected filename echoes into `#fileChosen` as bold blue text. Hidden `<input type=file accept=UPLOAD_ACCEPT>`.
3. `confirmProvide()` disables the button and swaps its label to "Uploading…", then `POST /api/files` with the **raw File as the body** and metadata in headers: `X-Filename`, `X-Dockey`, `Content-Type`, and `X-Owner` when a team member uploads on a provider's behalf.
4. On replace: uploads the new file *first*, then `DELETE`s the old one, then filters it out locally — new file always wins.
5. New file is **prepended** (`d.files=[fileEntry(data.file)].concat(d.files||[])`), `state.fileIdx=0`, `recomputeDoc(d)` recalculates aggregate status and mirrors primary-file fields, modal closes, toast fires.
6. On error: button re-enables with its original label and an error toast appears.

**Aggregate status rule** (`aggStatus`): any `attention` → `attention`; else any `pending` → `pending`; else `approved`; empty → `missing`.

**Typed-field items** (`fieldsFormHTML` / `saveFields`): non-document catalog items render a `.fieldform` of `.ff-view` rows. Field types: `text, textarea, date, number, email, phone, select, upload`. Saves via `PUT /api/fields/:key` (with `X-Owner` for team-on-behalf), optimistic local update reconciled against the server response. **Per-field authorship** is displayed with `.ff-by` (`.by-team` blue "Filled in by staff" / `.by-phys` green "Provided by physician") plus name and `fmtWhen` timestamp. Team intro copy: *"You can complete or correct these fields on behalf of the provider — your name is recorded on any field you change."*

## 5.5 Review flow (approve / request fix)

Three granularities:

- **Per-file** (`reviewFile`, the primary path): Approve is one click; "Request fix" uses a **`window.prompt`** seeded with "Please re-upload a clear, current copy." (returns early on cancel). PATCHes `/api/files/:id/review` with `{status, note}`, then `recomputeDoc`. Rejected-file notes render below the control bar in red.
- **Per-document, info items** (`drawerReview`): Approve applies directly; "Request fix" opens a **layer-2 modal** with an amber-themed header, a prefilled textarea (`#fixNote`), and the disclosure "Posted as a note on this document and sent to the physician (also emailed, since they're offline)". `confirmFix()` sets `status:'attention'`, persists, **pushes a note into the thread** (`Action needed on {name}: {note}`), sets `d.notif.physician=true`, and toasts differently depending on online state.
- **Approve all** (roster/detail row button `data-review`): iterates `d.files`, approving each non-approved file with its own PATCH, then recomputes.

**Notes thread** (right column of the drawer): chat-bubble UI — `.nmsg.me` (blue-600 fill, right-aligned, `border-bottom-right-radius:4px`) vs `.nmsg.them` (blue-50, left-aligned, `border-bottom-left-radius:4px`), `.meta` byline, and an amber `.via` tag "✉ also emailed". Composer: auto-growing textarea (`42px` → `Math.min(scrollHeight,110)`), **Enter to send / Shift+Enter for newline**, auto-scroll to bottom, auto-focus on open. `.notes-note` above the composer states live delivery mode: *"{Other} is online — notes deliver in-app"* vs *"{Other} is offline — a note also emails them"*.

## 5.6 Realtime / SSE

`startRealtime()` (`app.js:477`) opens `new EventSource('/api/realtime')` with three named listeners:

| Event | UI reaction |
|---|---|
| `account.deactivated` | `stopRealtime(); renderDeactivated()` — **immediate kick** to the lock screen, no confirmation |
| `account.reactivated` | Re-fetch `/api/auth/me`; on 200 refresh `ME` and `enterApp()` |
| `permissions.changed` | Re-fetch `/api/auth/me` (through the refresh-retrying `api()`); on 200 → toast "Permissions updated / Your access was updated by an administrator." then `renderShell('portal')` (forces a re-evaluation of nav gating, self-healing to a permitted view); on 403 → `renderDeactivated()` |

`sse.onerror` is a deliberate no-op (comment: "EventSource auto-reconnects; nothing to do"), and the whole thing is `try`-wrapped ("SSE unsupported: refresh loop + guards still enforce").

**Defense in depth** — three overlapping mechanisms: (1) SSE push, (2) the 8-minute refresh loop, (3) `deactPoll` on the deactivated screen (`setInterval` every **5000ms** hitting `/api/auth/me`; on 200 it clears itself, toasts "Access restored / Welcome back." and enters the app). The screen's copy promises this: *"This page restores your session automatically the moment your account is reactivated — no need to sign in again."*

## 5.7 Section gating UX

The most distinctive product mechanic. A catalog section can carry `gate:true` (default `SECTIONS[0]` "Pre-LOI Documents" has it).

- **Rule** (`visibleSections`): iterate sections, push each; **break** after the first gated section that is neither complete nor acknowledged. So a physician sees everything up to and including the blocking section, and nothing after.
- `gateOpen(p,sec) = !sec.gate || sectionComplete(p,sec) || sectionAcked(p,sec)`; `sectionComplete` requires **every** item approved.
- **Physician side**: a `.card.locked-note` (dashed border, gray lock tile) reading *"N more sections unlock next. Finish **{title}** — once your credentialing team approves it (or unlocks it for you), the rest of the checklist appears here."*
- **Team side** (`gateControls`, rendered under the section header as `.sec-gate`): a `.gate-sw` toggle (`role="switch" aria-checked`) labeled "Hide later sections until complete or acknowledged" — this is **global**, applying to every provider (`POST /api/catalog/sections/:id/gate`) — plus a per-provider status region with four states:
  1. gate off → `.gate-st.muted` "Later sections always visible"
  2. complete → `.gate-st.ok` "✓ Complete — later sections unlocked"
  3. acknowledged → "✓ Unlocked by {name} · [Re-lock]" (`.linkbtn`)
  4. blocked → "Later sections hidden from {FirstName} · [Unlock sections]"
- Per-provider override (`setSectionAck`, `POST /api/providers/:id/section-ack`) stores `{by, name, at}` and toasts *"{FirstName} can now see the sections after '{title}'."*
- The section header shows an amber `.gate-tag` "🔒 Gate" with a tooltip.

## 5.8 Deal pipeline flow (team only, provider mode)

`.deal-bar` states: `pending` → "In pipeline" (`b-pending`), `completed` → "Active" (`b-approved`) `· since {date}`, `cancelled` → "Cancelled" (`b-attention`). When all documents are complete and the deal is still pending, the bar gets `.ready` (green halo) and the copy nudges: *"All documents are complete — ready to mark the deal Active."* Actions: **Mark Active** (opens the green-themed calendar), **Cancel deal** (uses a raw `window.prompt` for an optional reason), **Reopen pipeline** / **Restore to pipeline**. POSTs `/api/providers/:id/deal`.

---

# 6. NOTABLE MICRO-INTERACTIONS & REUSABLE WIDGETS

1. **Drag-and-drop catalog reorder** (`wireCatalogDnD`, `app.js:1024`) — two nested sortable levels (sections in `#cat_sections`, items in each `.cat-items`) with a shared `dragAfterElement(container, y, selector)` helper that finds the nearest sibling whose midpoint is below the cursor. Item drags `stopPropagation()` so they don't trigger a section drag, and the section `dragstart` bails via `if (e.target.closest('.cat-item')) return`. Order is committed on `dragend` (`PATCH .../sections/reorder` and `.../items/reorder`) with rollback-by-refetch on failure. Visual affordances: `.grip` handle (`cursor:grab` → `:active{cursor:grabbing}`, hover fills gray), `.dragging{opacity:.5}`, and a blue dashed outline on the dragged section card.

2. **File drop zone** — `.drop` / `.drop.drag` / `.drop .di`, with the dragover/dragleave class dance and a filename echo. Reusable as-is.

3. **The stretching carousel dot** — `.fv-dot` 8px circle → `.fv-dot.on` 20px×8px pill, animated via `transition:width .15s`.

4. **Re-render-free zoom** — mutating `.fv-scale`'s transform + the label's textContent directly, preserving scroll position inside `.fv-media`.

5. **Popup-blocker-safe async new tab** — `window.open('about:blank')` synchronously, `location.replace()` after the fetch, `tab.close()` on error (§3.5).

6. **Clickable stat tiles as filters** — `button.stat` with `aria-pressed`, hover border, `:active{transform:translateY(1px)}`, and `.active{box-shadow:0 0 0 2px var(--blue-100),var(--shadow)}` composing the token shadow with a ring.

7. **iOS-safe body scroll lock** — save scrollY → `body{position:fixed;top:-Y}` → restore + `scrollTo` (§1.9).

8. **`svh` bottom sheet** — `height:90vh;height:90svh` with an explicit comment about mobile-toolbar reflow flicker.

9. **`:has()`-driven layout switch** — `.modal-bg:has(.modal.drawer)` changes the backdrop's padding/alignment based on which modal is inside it, letting one modal shell be both a centered dialog and a fullscreen/bottom-sheet drawer.

10. **Auto-growing note composer** with Enter-to-send, `42px` → `110px` (→`220px` on desktop drawer).

11. **Two-layer modal stack** (`#modalRoot` z1500 / `#modalRoot2` z1700) letting the date picker and "request a fix" dialogs open *on top of* the review drawer.

12. **Themable dialog head-icon tile** — 34×34 rounded tile whose `headBg`/`headColor` are passed per call site (blue for dates, green for "Mark Active", amber for "Request a fix"), a cheap way to color-code intent.

13. **Password-manager-friendly `autocomplete`** — consistently `username`, `current-password`, `new-password`, `email`, `name` across every auth form; `inputmode="numeric"` on the MFA field.

14. **Conditional-disable with explanation** — admin buttons render `disabled title="Requires an active local account with email"` rather than hiding, so the constraint is discoverable.

15. **Search-preserving re-render** — the users search re-runs the whole async render then restores focus and caret: `s.focus(); s.setSelectionRange(s.value.length, s.value.length)`.

16. **SMTP provider presets** that rewrite five fields, a label, and a hint on `<select>` change.

17. **Tri-state permission cell** cycling allow → deny → clear on click, with `*` and an amber outline marking overrides and a `title` revealing the underlying default.

18. **Skeleton "paper" document mock** (`.paper` + `.paper-lines i` at hand-tuned widths + rotated `.stamp`) — a prototype artifact from `portal.html`, still fully styled in `style.css` and available for placeholder/print-preview use.

**Gaps worth flagging in the brief:** no dark mode; no `prefers-reduced-motion`; no focus trap or Escape handling in any modal layer; the date picker has no keyboard navigation; three destructive/annotative flows still use native `window.confirm`/`window.prompt` (`deleteFile`, `reviewFile` fix note, deal cancellation reason, role/section/item deletion) while others use styled modals; `portal.js`'s `esc()` does not escape `'`, and several toast bodies interpolate unescaped HTML by design.