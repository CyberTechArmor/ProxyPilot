// Baseline gates — backend-owned, appended to every battery, PURE (risk R9:
// these are strings and a selector; no DB, no container, no native module).
//
// WHY THEY EXIST. The framework's gates_json is operator-owned, so nothing in
// it is guaranteed. These four are guaranteed, because each one catches a
// failure that shipped silently and that no human review reliably caught:
//
//   design-adherence  the app referenced ZERO of its approved design variables,
//                     declared 32 of its own and dropped the dark theme.
//   platform-intact   the app came back missing the base app's own features —
//                     theme, branding, legal pages, assets, API keys, read-only
//                     SQL — because nothing checked they survived.
//   mobile-overflow   screens scrolled sideways on a phone.
//   no-dead-controls  buttons that do nothing, with no "Not built yet" badge.
//
// TIERS. A gate declares the LIGHTEST profile it belongs to; profiles are
// cumulative (quick ⊂ mvp ⊂ full). `advisoryIn` names profiles where the gate
// runs but cannot red the build — that is how design-adherence rides a quick
// update without an app's pre-existing debt wedging a one-line edit.
//
// Each script runs with cwd = the app dir, under `sh`, and exits 0/1.

import { e2eGateScript } from './scaffold-e2e.js';

export const GATE_TIERS = Object.freeze(['quick', 'mvp', 'full']);

export function tierRank(tier) {
  const i = GATE_TIERS.indexOf(String(tier));
  return i === -1 ? GATE_TIERS.length : i; // unknown → stricter than 'full'
}

// A gate whose script is wrapped so a red exit prints its verdict but returns
// 0. Used for advisory placement: the finding reaches the model and the report
// without blocking the finish.
export function asAdvisory(script, name) {
  // The gate MUST run in a subshell. Every gate script ends in `exit 0` or
  // `exit 1`, and `exit` terminates the whole shell — wrapping inline meant the
  // lines below were never reached and the "advisory" gate blocked exactly like
  // a normal one. A subshell's exit is its own, so $? is readable after it.
  return `# ADVISORY placement of ${name}: reported, never blocking.\n`
    + `(\n${String(script).replace(/\n*$/, '\n')})\n`
    + 'rc=$?\n'
    + `if [ "$rc" -ne 0 ]; then echo ""; echo "(advisory: ${name} is not blocking in this build mode — fix it in the next full build)"; fi\n`
    + 'exit 0\n';
}

// ---- design-adherence ----
//
// DRIFT, NOT BREADTH (redesigned per docs/gate-audit.md #1, evidence P47).
// The old gate scored adoption breadth — "42 of 109 approved component
// classes, 9 of 60 approved variables" — and its cheapest pass was to spray
// approved class names onto elements to raise the count, while a small,
// well-built app could never win the denominator. What actually indicates
// drift is a HARDCODED value where a token exists, and a re-made component
// where an approved class already covers the case. That is what this scores.
//
// CHEAPEST PASS: use var(--...) from state/design.css for colors/spacing and
// put the approved class on the element instead of re-making it — which is
// exactly following the design. There is no count to inflate: adoption
// numbers are REPORTED, never scored, so class-spraying buys nothing.
//
// BLOCKING ONLY ON NEW DRIFT: literals/shadow-classes that exist at HEAD are
// pre-existing debt — reported, never blocking — so old drift cannot wedge an
// unrelated change (in a fresh tree with no git history, everything is new).
// The shell checks (--app-* bridge, design.css-last, dark theme) stay
// blocking: each is a direct, unambiguous defect, not a breadth score.
export const DESIGN_ADHERENCE_GATE_NAME = 'design-adherence';

export const DESIGN_ADHERENCE_GATE_SCRIPT = `# Baseline gate (ProxyPilot): the approved design must actually be consumed.
set -u
DESIGN=state/design.css
if [ ! -f "$DESIGN" ]; then
  echo "design-adherence: no state/design.css — nothing approved to adhere to. Skipped."
  exit 0
fi

# ---- THE SHELL ----
# These run BEFORE the app-CSS analysis below, because they are about
# design.css and the pages themselves. Behind the "no app CSS yet" early exit
# they never ran on a fresh project, which is exactly when they matter most.
SHELLFAIL=0

# The shell (base.css) and the platform CSS style the header, nav, buttons,
# cards, theme toggle, legal footer and sign-in page from the --app-* family.
# design.css must DRIVE that family, either directly (a preset-derived design)
# or through the generated ==bridge== block (a mockup-derived one). If it does
# not, the approved palette reaches only the screens the build wrote and the
# whole frame around them stays on hardcoded defaults — a two-palette app.
for v in --app-bg --app-text --app-surface --app-primary; do
  if ! grep -q -- "$v[[:space:]]*:" state/design.css; then
    echo "FAIL: state/design.css does not define $v, so the app SHELL ignores the approved design."
    echo "      The header, nav, buttons, theme toggle, legal footer and sign-in page would render in"
    echo "      hardcoded defaults. Re-approve the design to regenerate the bridge; do not hand-edit design.css."
    SHELLFAIL=1
  fi
done

# design.css must LOAD LAST, or base.css re-declares names the design defines
# and the platform silently overrides the approved values.
#
# Matched on the LINK, not on the filename appearing anywhere in the file. The
# plain grep read HTML comments as stylesheet links: login.html links only
# design.css and says so in a comment that names base.css, and the gate failed
# it for a load order it does not have. A gate about <link> order must look at
# <link> tags.
LINKRE='<link[^>]*href=["'"'"']*[^"'"'"'>]*'
for f in public/*.html; do
  [ -f "$f" ] || continue
  grep -Eq "\${LINKRE}base\.css" "$f" || continue
  grep -Eq "\${LINKRE}design\.css" "$f" || continue
  DPOS=$(grep -En "\${LINKRE}design\.css" "$f" | head -1 | cut -d: -f1)
  BPOS=$(grep -En "\${LINKRE}base\.css" "$f" | head -1 | cut -d: -f1)
  if [ "$DPOS" -lt "$BPOS" ]; then
    echo "FAIL: $f links design.css BEFORE base.css, so the platform defaults win over the approved design."
    echo "      Link base.css first and design.css last."
    SHELLFAIL=1
  fi
done

# A private scratch dir: fixed /tmp names collide when two gate runs overlap
# (harmless in a per-project container, but it made the test suite flake and it
# is one shared host away from being a real corruption).
WORK=$(mktemp -d 2>/dev/null || echo /tmp/pp-$$)
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
# The app's OWN styling, wherever it lives.
#
# This used to be public/*.css and nothing else — so a build that wrote 328
# lines of HTML and NO stylesheet measured as "the app has not written
# substantial CSS of its own" and took the free pass below. Project 39 did
# exactly that: the shipped screens looked nothing like the mockup, the gate
# said "passed", and it cost less than the build before it. Whatever else this
# gate does, it must never be cheaper to skip the design than to follow it.
#
# Inline <style> blocks count as app CSS. The MARKUP is collected too: the real
# question is whether the built screens use the approved design's components,
# and that is answered by the class names in the HTML, not by a stylesheet.
APP="$WORK/app.css"
: > "$APP"
for f in public/*.css; do
  [ -f "$f" ] || continue
  case "$f" in */base.css|*/design.css|*/platform.css) continue ;; esac
  cat "$f" >> "$APP"
done

HTML="$WORK/app.html"
: > "$HTML"
for f in public/*.html; do
  [ -f "$f" ] || continue
  # The platform's own pages are not the build's work.
  case "$f" in */login.html|*/admin.html|*/profile.html) continue ;; esac
  # app-shell.html is the scaffold's placeholder UNTIL a build replaces it. Its
  # marker sentence is the test: while it is still there the page is platform
  # content and must not count as "the build shipped screens", or a project that
  # has built nothing yet would be judged for the placeholder's markup.
  case "$f" in
    */app-shell.html)
      grep -q 'This is the base application shell' "$f" && continue
      ;;
  esac
  cat "$f" >> "$HTML"
done
# <style> blocks in the markup are app CSS by another name.
# index() rather than a /regex/ literal: a regex literal here needs an escaped
# slash, and an escaped slash does not survive the JS template literal this
# script is emitted from — which is how the first version of this silently
# appended nothing at all.
if [ -s "$HTML" ]; then
  awk 'BEGIN{p=0} index($0,"<style"){p=1} p{print} index($0,"</style>"){p=0}' "$HTML" >> "$APP"
fi
APPBYTES=$(wc -c < "$APP" | tr -d ' ')
HTMLBYTES=$(wc -c < "$HTML" | tr -d ' ')

# Declared variables on each side, and the approved ones the app actually reads.
grep -o -- '--[A-Za-z0-9_-]*[[:space:]]*:' "$DESIGN" | sed 's/[[:space:]]*:$//' | sort -u > "$WORK/approved"
grep -o -- '--[A-Za-z0-9_-]*[[:space:]]*:' "$APP"    | sed 's/[[:space:]]*:$//' | sort -u > "$WORK/appdef"
cat "$APP" "$HTML" > "$WORK/appall" 2>/dev/null || cp "$APP" "$WORK/appall"
grep -o -- 'var([[:space:]]*--[A-Za-z0-9_-]*' "$WORK/appall" | sed 's/.*--/--/'  | sort -u > "$WORK/appuse"

APPROVED=$(wc -l < "$WORK/approved" | tr -d ' ')
USED=$(comm -12 "$WORK/appuse" "$WORK/approved" | wc -l | tr -d ' ')
OWN=$(comm -23 "$WORK/appdef" "$WORK/approved" | wc -l | tr -d ' ')

# ---- DRIFT SIGNAL A: hardcoded COLOUR literals where a token exists ----
#
# The direct measure of "the theme is off": a colour typed in does not follow
# the theme and does not change when the design does. var(--x, #fallback)
# fallbacks are legitimate (the token bridge is built from them), so literals
# inside a var() are stripped before counting.
# NO BACKSLASHES in this pipeline. It is emitted from a JS template literal,
# where a backslash-b becomes a literal backspace character and an escaped
# paren collapses into a capture group — which is exactly how an earlier
# version of this counted zero colours in a file full of them. Bracket
# expressions express the same thing with nothing to escape.
sed 's/var([^)]*)//g' "$APP" | grep -o -E '#[0-9a-fA-F]{3,8}|rgba?[(][^)]*[)]|hsla?[(][^)]*[)]' | sort -u > "$WORK/lits"
HARD=$(wc -l < "$WORK/lits" | tr -d ' ')

# ---- DRIFT SIGNAL B: hardcoded SPACING literals where a spacing token exists ----
# Only counted when the approved design actually publishes spacing tokens —
# an app cannot be marked down for not using a token that does not exist.
SPACETOK=$(grep -c -E -- '--(space|spacing|gap|pad)[A-Za-z0-9_-]*[[:space:]]*:' "$DESIGN" 2>/dev/null || true)
: > "$WORK/space"
if [ "$SPACETOK" -gt 0 ]; then
  sed 's/var([^)]*)//g' "$APP" | grep -o -E '(margin|padding|gap)[a-z-]*[[:space:]]*:[^;}]*' \\
    | grep -o -E '[0-9][0-9]*px' | grep -v -E '^0px$' | sort -u > "$WORK/space" || true
fi
SPACE=$(wc -l < "$WORK/space" | tr -d ' ')

# ---- DRIFT SIGNAL C: a RE-MADE component — an app-defined class whose stem
# duplicates an approved class name (.note-card2 / .note-card-alt beside the
# approved .note-card). A genuinely NEW element is welcome (the system
# growing); re-making a covered one is drift by construction.
grep -o -E '[.][A-Za-z][A-Za-z0-9_-]{2,}' "$DESIGN" | sed 's/^[.]//' | tr 'A-Z' 'a-z' | sort -u > "$WORK/dclass"
grep -o -E 'class="[^"]*"' "$HTML" 2>/dev/null | sed 's/class="//; s/"$//' | tr ' ' '\\n' \\
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' | tr 'A-Z' 'a-z' | sort -u > "$WORK/hclass"
grep -o -E '[.][A-Za-z][A-Za-z0-9_-]{2,}' "$APP" 2>/dev/null | sed 's/^[.]//' | tr 'A-Z' 'a-z' | sort -u > "$WORK/aclass" || : > "$WORK/aclass"
DCLASS=$(wc -l < "$WORK/dclass" | tr -d ' ')
UCLASS=$(comm -12 "$WORK/dclass" "$WORK/hclass" 2>/dev/null | wc -l | tr -d ' ')
comm -23 "$WORK/aclass" "$WORK/dclass" > "$WORK/newcls" 2>/dev/null || : > "$WORK/newcls"
NEWCLS=$(wc -l < "$WORK/newcls" | tr -d ' ')
: > "$WORK/shadow"
while IFS= read -r c; do
  [ -n "$c" ] || continue
  s=$(printf '%s' "$c" | sed -E 's/[-_]?(v2|alt|new|copy|custom|2)$//')
  [ "$s" = "$c" ] && continue
  if grep -qxF "$s" "$WORK/dclass" 2>/dev/null; then
    printf '%s (approved: .%s)\\n' "$c" "$s" >> "$WORK/shadow"
  fi
done < "$WORK/newcls"

# ---- NEW-THIS-CYCLE scoping: drift already at HEAD is debt, not this build ----
# The container tree is a git checkout whose HEAD is the last checkpoint, so
# "introduced by this cycle" is exactly "present now, absent at HEAD". With no
# git history (a fresh tree), everything counts as new.
: > "$WORK/headapp"
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  for f in public/*.css; do
    [ -f "$f" ] || continue
    case "$f" in */base.css|*/design.css|*/platform.css) continue ;; esac
    git show "HEAD:$f" >> "$WORK/headapp" 2>/dev/null || true
  done
  for f in public/*.html; do
    [ -f "$f" ] || continue
    case "$f" in */login.html|*/admin.html|*/profile.html) continue ;; esac
    git show "HEAD:$f" 2>/dev/null | awk 'BEGIN{p=0} index($0,"<style"){p=1} p{print} index($0,"</style>"){p=0}' >> "$WORK/headapp" || true
  done
fi
sed 's/var([^)]*)//g' "$WORK/headapp" | grep -o -E '#[0-9a-fA-F]{3,8}|rgba?[(][^)]*[)]|hsla?[(][^)]*[)]' | sort -u > "$WORK/headlits" || true
comm -23 "$WORK/lits" "$WORK/headlits" > "$WORK/newlits" 2>/dev/null || cp "$WORK/lits" "$WORK/newlits"
NEWLITS=$(wc -l < "$WORK/newlits" | tr -d ' ')
: > "$WORK/headspace"
if [ "$SPACETOK" -gt 0 ]; then
  sed 's/var([^)]*)//g' "$WORK/headapp" | grep -o -E '(margin|padding|gap)[a-z-]*[[:space:]]*:[^;}]*' \\
    | grep -o -E '[0-9][0-9]*px' | grep -v -E '^0px$' | sort -u > "$WORK/headspace" || true
fi
comm -23 "$WORK/space" "$WORK/headspace" > "$WORK/newspace" 2>/dev/null || cp "$WORK/space" "$WORK/newspace"
NEWSPACE=$(wc -l < "$WORK/newspace" | tr -d ' ')
grep -o -E '[.][A-Za-z][A-Za-z0-9_-]{2,}' "$WORK/headapp" 2>/dev/null | sed 's/^[.]//' | tr 'A-Z' 'a-z' | sort -u > "$WORK/headcls" || : > "$WORK/headcls"
: > "$WORK/newshadow"
while IFS= read -r line; do
  [ -n "$line" ] || continue
  c=\${line%% *}
  grep -qxF "$c" "$WORK/headcls" 2>/dev/null || printf '%s\\n' "$line" >> "$WORK/newshadow"
done < "$WORK/shadow"
NEWSHADOW=$(wc -l < "$WORK/newshadow" | tr -d ' ')

# ---- the report (adoption is REPORTED, never scored) ----
echo "design-adherence: $APPROVED approved variable(s); the app uses $USED, declares $OWN of its own, in $APPBYTES bytes of its own CSS (reported, not scored)."
echo "design-adherence: drift — $HARD hardcoded colour(s) total, $NEWLITS introduced by this change; $SPACE spacing literal(s), $NEWSPACE new."
echo "design-adherence: the approved design defines $DCLASS component class(es); the built screens use $UCLASS; the build defines $NEWCLS of its own, $NEWSHADOW re-making an approved one."

# Too little approved design to judge against (a preset-only project).
if [ "$APPROVED" -lt 8 ]; then
  echo "design-adherence: fewer than 8 approved variables — not enough of a design system to enforce."
  if [ "$SHELLFAIL" -ne 0 ]; then exit 1; fi
  echo "design-adherence: the shell is driven by the approved design. Passed."
  exit 0
fi
# Nothing built yet — no styling AND no screens. That is an early cycle, not a
# defect.
if [ "$APPBYTES" -lt 2000 ] && [ "$HTMLBYTES" -lt 2000 ]; then
  echo "design-adherence: the app has not written screens or CSS of its own yet."
  if [ "$SHELLFAIL" -ne 0 ]; then exit 1; fi
  echo "design-adherence: the shell is driven by the approved design. Passed."
  exit 0
fi

FAIL=$SHELLFAIL

# NEW colour drift. Four literals of allowance on purpose — a shadow, an
# overlay scrim and a focus ring are legitimately literal.
if [ "$NEWLITS" -gt 4 ]; then
  echo "FAIL: this change introduces $NEWLITS hardcoded colour literal(s) where the approved design provides tokens:"
  head -10 "$WORK/newlits" | sed 's/^/        /'
  echo "      Hardcoded colours do not follow the theme. Replace each with var(--...) from state/design.css."
  echo "      (Pre-existing literals are reported above but do not block — only what this change adds does.)"
  FAIL=1
fi

# NEW spacing drift — only when the design actually publishes spacing tokens.
if [ "$SPACETOK" -gt 0 ] && [ "$NEWSPACE" -gt 6 ]; then
  echo "FAIL: this change introduces $NEWSPACE hardcoded spacing value(s) while the approved design provides spacing tokens:"
  head -8 "$WORK/newspace" | sed 's/^/        /'
  echo "      Use var(--space-...) / the approved spacing tokens so rhythm follows the design."
  FAIL=1
fi

# NEW re-made components.
if [ "$NEWSHADOW" -gt 0 ]; then
  echo "FAIL: this change re-makes component(s) the approved design already covers:"
  head -6 "$WORK/newshadow" | sed 's/^/        .../'
  echo "      Put the approved class on the element instead of defining a near-copy — a parallel"
  echo "      component drifts from the design the first time either one changes."
  FAIL=1
fi

# Screens with NO styling anywhere — project 39's exact shape (LEARNINGS 52):
# substantial markup, no CSS of the app's own, and ZERO approved component
# classes on it. This is an absolute-zero detector, not a breadth ratio: it
# must never be cheaper to skip the design than to follow it.
if [ "$HTMLBYTES" -ge 4000 ] && [ "$APPBYTES" -lt 500 ] && [ "$UCLASS" -eq 0 ] && [ "$DCLASS" -ge 6 ]; then
  echo "FAIL: the app ships $HTMLBYTES bytes of screens with $APPBYTES bytes of styling and none of the approved component classes."
  echo "      Unstyled markup on the base shell cannot look like state/mockups/current.html."
  echo "      Either use the approved component classes or write the screens' CSS on var(--...)."
  FAIL=1
fi

# A dropped dark theme is a broken shipped feature, not a style opinion.
if grep -q 'data-theme' "$DESIGN" && [ "$OWN" -ge 8 ] && ! grep -q 'data-theme' "$APP"; then
  echo "FAIL: the approved design defines a dark theme; the app's own $OWN variables have no dark variant,"
  echo "      so the theme toggle changes nothing for them. Add the [data-theme=\\"dark\\"] values or use the approved ones."
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then exit 1; fi

# Pre-existing drift is reported as debt, never blocking (the operator decides
# when to spend a cycle on it).
if [ "$HARD" -gt 4 ] || [ -s "$WORK/shadow" ]; then
  echo "design-adherence: pre-existing drift on file ($HARD hardcoded colour(s), $(wc -l < "$WORK/shadow" | tr -d ' ') re-made class(es)) — not introduced by this change; not blocking. Passed."
  exit 0
fi

echo "design-adherence: no drift — the app builds on the approved design, and the shell is bridged onto it. Passed."
exit 0
`;

// ---- platform-intact ----
//
// The base app's platform module is load-bearing and continuously updated by
// the platform itself. A build that deletes it, or grows a second branding /
// settings / api-key store beside it, has thrown away features the operator
// already paid for and broken the upgrade path.
export const PLATFORM_INTACT_GATE_NAME = 'platform-intact';

export const PLATFORM_INTACT_GATE_SCRIPT = `# Baseline gate (ProxyPilot): the base app's platform module must survive.
set -u
FAIL=0

# The module is optional only for a project seeded before it existed: if NONE
# of it is present this is a legacy app, not a deletion, and the gate stands
# down rather than failing a build that never had it.
PRESENT=0
for f in src/platform/schema.ts src/platform/branding.ts src/platform/readonly.ts; do
  [ -f "$f" ] && PRESENT=$((PRESENT + 1))
done
if [ "$PRESENT" -eq 0 ]; then
  echo "platform-intact: this project has no src/platform module (seeded before it existed). Skipped."
  exit 0
fi

MISSING=""
for f in src/platform/schema.ts src/platform/branding.ts src/platform/api-keys.ts \\
         src/platform/api-key-auth.ts src/platform/readonly.ts \\
         migrations/0100_platform.sql public/theme.js public/platform.js \\
         public/platform-admin.js; do
  [ -f "$f" ] || MISSING="$MISSING $f"
done
# push.ts / push.js arrived with platform v4, so a project seeded earlier does
# not have them yet and must not fail for it. The rule here is therefore
# narrower and exactly right: fail only if the build DELETED a file this
# project already had at HEAD.
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  for f in src/platform/push.ts public/push.js; do
    if git cat-file -e "HEAD:$f" 2>/dev/null && [ ! -f "$f" ]; then MISSING="$MISSING $f"; fi
  done
fi

if [ -n "$MISSING" ]; then
  echo "FAIL: the platform module lost files:$MISSING"
  echo "      Those are the base app's own features (theme, branding, legal pages, assets, API keys, read-only SQL)."
  echo "      Restore them instead of re-implementing: git checkout HEAD -- src/platform migrations/0100_platform.sql public/theme.js public/platform.js"
  FAIL=1
fi

# Exports the rest of the app (and the platform's own upgrades) depend on.
check_export() {
  [ -f "$1" ] || return 0
  if ! grep -qE "export (async )?(function|const|class) $2[^A-Za-z0-9_]" "$1"; then
    echo "FAIL: $1 no longer exports $2 — something downstream imports it."
    FAIL=1
  fi
}
check_export src/platform/schema.ts branding
check_export src/platform/schema.ts legalPages
check_export src/platform/schema.ts assets
check_export src/platform/schema.ts apiKeys
check_export src/platform/branding.ts ensureSeeded
check_export src/platform/branding.ts getBranding
check_export src/platform/api-keys.ts verifyKey
check_export src/platform/api-key-auth.ts withApiKey
check_export src/platform/readonly.ts ensureViews

# Still wired in? The module can be present and completely unmounted.
if [ -f src/app.ts ] && [ -f src/platform/routes.ts ]; then
  for sym in publicPlatformRoutes platformRoutes adminPlatformRoutes withApiKey; do
    if ! grep -q "$sym" src/app.ts; then
      echo "FAIL: src/app.ts no longer mounts $sym — the platform routes are unreachable."
      FAIL=1
    fi
  done
fi
if [ -f src/server.ts ]; then
  for sym in ensureSeeded ensureViews; do
    if ! grep -q "$sym" src/server.ts; then
      echo "FAIL: src/server.ts no longer calls $sym — branding/legal seeding or the read-only views never initialise."
      FAIL=1
    fi
  done
fi

# A SECOND store for something the platform already owns. These four table
# names are the platform's own; declaring them outside src/platform is a
# parallel system, not an app-specific table that happens to share a word.
DUP=$(find src -name '*.ts' -not -path 'src/platform/*' -exec grep -lE "pgTable\\([\\"']( branding|branding|legal_pages|api_keys|assets)[\\"']" {} + 2>/dev/null || true)
if [ -n "$DUP" ]; then
  echo "FAIL: a second store for data the platform already owns, in:"
  echo "$DUP" | sed 's/^/        /'
  echo "      Extend src/platform instead — a parallel table means the admin screens edit one copy and the app reads the other."
  FAIL=1
fi

# The admin console carries the platform's own settings cards; if it stops
# loading their script they render as dead inputs that silently discard edits.
if [ -f public/admin.html ] && grep -q 'pf-save' public/admin.html; then
  if ! grep -q 'platform-admin.js' public/admin.html; then
    echo "FAIL: public/admin.html has the platform settings cards but does not load /platform-admin.js —"
    echo "      branding, legal pages, assets, API keys and read-only SQL would all be dead inputs."
    FAIL=1
  fi
fi

# Every full HTML page must load theme.js, or the theme toggle does nothing on
# that screen — the single most common way a new page breaks the base app.
for f in public/*.html; do
  [ -f "$f" ] || continue
  grep -qi '<head' "$f" || continue
  if ! grep -q 'theme.js' "$f"; then
    echo "FAIL: $f has a <head> but does not load /theme.js — the theme toggle will not apply to this page."
    echo "      Add the same head lines the other pages use."
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "platform-intact: the platform module is present, exported, wired and unduplicated. Passed."
exit 0
`;

// ---- mobile-overflow ----
//
// A screen that scrolls sideways on a phone is a defect, not a preference. The
// design review already measures this with a real browser; this is the cheap
// static half so it can gate an MVP build without launching chromium.
export const MOBILE_OVERFLOW_GATE_NAME = 'mobile-overflow';

export const MOBILE_OVERFLOW_GATE_SCRIPT = `# Baseline gate (ProxyPilot): nothing may force a phone to scroll sideways.
set -u
FAIL=0
WORK=$(mktemp -d 2>/dev/null || echo /tmp/pp-$$)
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
CSS="$WORK/mobile.css"
: > "$CSS"
for f in public/*.css; do
  [ -f "$f" ] || continue
  case "$f" in */base.css|*/platform.css) continue ;; esac
  cat "$f" >> "$CSS"
done
# Inline <style> blocks are stylesheets too. Reading only public/*.css meant a
# build that styled its screens in the markup — or did not style them at all —
# skipped this gate entirely (project 39: "no app stylesheets to check").
for f in public/*.html; do
  [ -f "$f" ] || continue
  case "$f" in */login.html|*/admin.html|*/profile.html) continue ;; esac
  awk 'BEGIN{p=0} index($0,"<style"){p=1} p{print} index($0,"</style>"){p=0}' "$f" >> "$CSS"
done
# NOTE the ordering below: the HTML checks (viewport meta, fixed inline widths)
# run WHETHER OR NOT there is CSS. The early exit used to sit here and skip the
# whole gate, so a build that shipped screens with no stylesheet — project 39's
# shape — was never asked whether its pages even declare a viewport. Only the
# CSS-specific checks may be skipped for want of CSS.
HAS_CSS=1
[ -s "$CSS" ] || HAS_CSS=0

if [ "$HAS_CSS" -eq 1 ]; then
# A fixed pixel width wider than the narrowest phone we support (390px) cannot
# fit, whatever the container does. min-width is worse: it cannot even shrink.
WIDE=$(grep -nE '(^|[;{[:space:]])(min-)?width[[:space:]]*:[[:space:]]*[0-9]{3,}px' "$CSS" \\
       | awk -F'[^0-9]*' '{ for (i = 1; i <= NF; i++) if ($i + 0 > 430) { print; break } }' | head -20)
if [ -n "$WIDE" ]; then
  echo "FAIL: fixed widths wider than a 390px phone:"
  echo "$WIDE" | sed 's/^/        /'
  echo "      Use max-width with a percentage/auto base so the rule collapses on a phone."
  FAIL=1
fi

# A grid whose columns are declared as a fixed repeat() never collapses to one
# column; MOBILE_FIRST requires a single column at phone width.
COLS=$(grep -nE 'grid-template-columns[[:space:]]*:[[:space:]]*repeat\\([0-9]+,' "$CSS" | head -10)
if [ -n "$COLS" ]; then
  if ! grep -q '@media' "$CSS"; then
    echo "FAIL: fixed multi-column grids with no @media rule anywhere — they cannot collapse on a phone:"
    echo "$COLS" | sed 's/^/        /'
    echo "      Add a single-column rule under @media (max-width: 640px), or use repeat(auto-fit, minmax(...))."
    FAIL=1
  fi
fi

fi

# ---- HTML checks: these run WHATEVER the stylesheet situation is ------------
# The viewport meta is what makes any of the above matter, and a fixed width
# typed into a style attribute overflows exactly like one in a stylesheet.
for f in public/*.html; do
  [ -f "$f" ] || continue
  grep -qi '<head' "$f" || continue
  if ! grep -qi 'name=["'"'"']*viewport' "$f"; then
    echo "FAIL: $f has no viewport meta — a phone renders it at desktop width and zooms out."
    FAIL=1
  fi
  INLINE=$(grep -noE 'style="[^"]*(min-)?width[[:space:]]*:[[:space:]]*[0-9]{3,}px' "$f" \
           | awk -F'[^0-9]*' '{ for (i = 2; i <= NF; i++) if ($i + 0 > 430) { print; break } }' | head -5)
  if [ -n "$INLINE" ]; then
    echo "FAIL: $f has inline fixed widths wider than a 390px phone:"
    echo "$INLINE" | sed 's/^/        /'
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then exit 1; fi
if [ "$HAS_CSS" -eq 0 ]; then
  echo "mobile-overflow: no app stylesheets; the pages declare a viewport and no inline fixed widths. Passed."
  exit 0
fi
echo "mobile-overflow: no fixed widths, uncollapsible grids, or missing viewport. Passed."
exit 0
`;

// ---- no-dead-controls ----
//
// A control that LOOKS clickable and does nothing is the single worst thing a
// demo can do — so a rendered control either works, or is honestly disabled.
//
// SCOPE (binding, and the reason this gate is safe): it applies ONLY to
// controls the build CHOSE to render. It never asks for a control to exist,
// never counts the inventory, and never fails an app for leaving a capability
// out. CHEAPEST PASS: wire the controls you rendered, or render fewer — both
// make the app better.
//
// THE PAIR (gate-audit.md #4 called the combination HARMFUL; reviewed together
// with action parity in runner.js on 2026-07-29): read jointly, the old pair
// said "render every contract action; badge the ones you did not build" —
// which is how the notes app became a form. The pair cannot force
// render-everything any more, because each side gave up one half of that
// instruction: action parity accepts a capability placed in a menu or any
// secondary surface, and accepts "left out + stated in the finish summary"
// (it warns the operator instead of demanding a control); this gate only ever
// looks at what is already on screen. Neither check, alone or together, can
// require a control the design does not show.
export const NO_DEAD_CONTROLS_GATE_NAME = 'no-dead-controls';

export const NO_DEAD_CONTROLS_GATE_SCRIPT = `# Baseline gate (ProxyPilot): a control either works or says it does not yet.
set -u
FAIL=0
FILES=$(find public src -name '*.html' 2>/dev/null | head -100)
if [ -z "$FILES" ]; then
  echo "no-dead-controls: no HTML pages to check. Skipped."
  exit 0
fi

# A <button> with no type=submit, no id, no name, no data-* hook, no onclick and
# no class the scripts could select is unreachable by any handler: it is dead by
# construction, not merely unwired at runtime. Anything disabled is exempt — a
# disabled control is the honest way to ship "not built yet".
for f in $FILES; do
  [ -f "$f" ] || continue
  DEAD=$(sed 's/>/>\\n/g' < "$f" \\
    | grep -i '<button' \\
    | grep -vi 'disabled' \\
    | grep -vi 'type=["'"'"']*submit' \\
    | grep -viE '(id|name|onclick|class|data-[a-z-]+)=')
  if [ -n "$DEAD" ]; then
    echo "FAIL: $f has button(s) nothing can reach — no id, name, class, data-* hook, onclick or submit:"
    echo "$DEAD" | head -5 | sed 's/^/        /'
    echo "      Wire it, or ship it disabled with a \\"Not built yet\\" badge."
    FAIL=1
  fi
done

# href="#" is the other shape: a link that navigates nowhere and is not a
# button. Exempt when it carries a handler hook.
for f in $FILES; do
  [ -f "$f" ] || continue
  HASH=$(sed 's/>/>\\n/g' < "$f" \\
    | grep -iE '<a[^>]+href=["'"'"']*#["'"'"']*[[:space:]>]' \\
    | grep -viE '(onclick|data-[a-z-]+|role=["'"'"']*button)=?')
  if [ -n "$HASH" ]; then
    echo "FAIL: $f has link(s) to href=\\"#\\" with no handler — they look clickable and do nothing:"
    echo "$HASH" | head -5 | sed 's/^/        /'
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "no-dead-controls: every control is reachable, submits, or is honestly disabled. Passed."
exit 0
`;

// ---- no-native-dialogs ----
//
// A build shipped `prompt("New to-do")`. The browser's own dialog appeared,
// titled with the raw hostname — "n2.dev.fractionate.ai says" — over an app
// that had just been styled to a signed-off design. It reads as unfinished,
// and it is: the shell already ships .modal and .drawer, and the build prompt
// already says to reuse those classes. Nothing enforced it.
//
// alert / confirm / prompt are also BLOCKING and unstyleable, they cannot be
// themed, and on mobile they look nothing like the app around them.
export const NO_NATIVE_DIALOGS_GATE_NAME = 'no-native-dialogs';

export const NO_NATIVE_DIALOGS_GATE_SCRIPT = `# Baseline gate (ProxyPilot): no browser alert/confirm/prompt in a built app.
#
# NO BACKSLASHES IN THE PATTERNS, on purpose. This script is a JS template
# literal that becomes a shell script that feeds grep -E: an escape has to
# survive three layers, and the first version of this gate lost hers — every
# grep died with "Unmatched ( or \\(" and the gate PASSED EVERYTHING. A false
# negative is worse than no gate. [(] and [.] are ERE character classes that
# mean exactly the same thing and cannot be mangled.
set -u
FAIL=0
FILES=$(find public src -type f 2>/dev/null \
        | grep -E '[.](js|ts|html)$' \
        | grep -v -E '/(theme|platform|platform-admin|push|sw|install|build-id|pp-annotate-bridge)[.]js$' \
        | head -200)
if [ -z "$FILES" ]; then
  echo "no-native-dialogs: no app scripts to check. Skipped."
  exit 0
fi

for f in $FILES; do
  [ -f "$f" ] || continue
  # A CALL, not a mention: the name followed by an opening paren. The leading
  # class stops it matching a property (obj.confirm(), this.alert()) while
  # still catching a bare call and the window.-prefixed form.
  # Comment lines are excluded — a doc block that MENTIONS prompt() is not a
  # call, and the platform's own dialog helpers describe what they replace.
  HITS=$(grep -nE '(^|[^.[:alnum:]_$]|window[.])(alert|confirm|prompt)[[:space:]]*[(]' "$f" \
         | grep -v -E '^[0-9]+:[[:space:]]*([*]|//|#)' \
         | grep -v -E 'pp[.](alert|confirm|prompt)' \
         | head -5)
  if [ -n "$HITS" ]; then
    echo "FAIL: $f uses a browser dialog:"
    echo "$HITS" | cut -c1-140 | sed 's/^/        /'
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "      alert() / confirm() / prompt() show the BROWSER's box, titled with the raw"
  echo "      hostname, ignoring the app's design entirely — and they block the page."
  echo "      base.css already ships .modal and .drawer. For a value, render a real form"
  echo "      field in a .modal; for a confirmation, a .modal with two buttons; for a"
  echo "      message, a .toast."
  exit 1
fi
echo "no-native-dialogs: no browser dialogs. Passed."
exit 0
`;

// ---- e2e (the project's own Playwright suite) ----
//
// Lives in scaffold-e2e.js next to the config and specs it runs, so the gate
// and the thing it runs can never drift apart.
export const E2E_GATE_NAME = 'e2e';

// ---- the registry ----

// ---- signin-reachable ----
//
// The sign-in page must survive whatever the build mounted.
//
// Project 43 deployed, answered its health check, and NOBODY COULD SIGN IN:
// the live URL served a JSON error body and `GET /login` answered 401. The
// build had added an ordinary feature router —
//
//     const router = Router();
//     router.use(requireAuth);          // sensible, for its own routes
//     router.get('/api/notes', ...);    // full paths, so mounted at the root
//     app.use(notesRoutes);
//
// — at the root, ABOVE the line that serves the sign-in page. A router mounted
// with no path prefix runs its router-level middleware for EVERY request, not
// only the paths declared inside it, so requireAuth answered 401 to /login and
// to every stylesheet before the sign-in route was ever reached.
//
// Nothing caught it. It typechecks, it is internally consistent, and the app
// starts. Three resumed cycles and $9.81 went into chasing the console errors
// it produced downstream. The scaffold now registers /login above every router
// so a NEW project cannot be shadowed — this gate is for the projects whose
// app.ts already carries the old order, and for anything a build reorders.
export const SIGNIN_REACHABLE_GATE_NAME = 'signin-reachable';

// NOTE ON ESCAPES: this script is emitted from a JS template literal, so a
// shell ${VAR} would be read as an interpolation. Every expansion here is
// written without braces for that reason — the first version used ${b%%:*} and
// the module stopped parsing.
//
// THE BOUNDARY IS EVERY PLATFORM MOUNT, NOT THE SIGN-IN ROUTE.
//
// The first version of this gate checked only what sat above `app.get('/login')`,
// and a build cleared it by moving the sign-in page up while leaving its router
// above the platform's auth API:
//
//     app.get('/login', ...);        // moved up — the page renders
//     app.use(express.static(...));  // moved up — the assets load
//     app.use(notesRoutes);          // still here
//     app.use('/api', authRoutes);   // never reached
//
// The app LOOKED fixed. `/login` was 200 and styled. But
// `/api/auth/bootstrap/status` answered 401, and login.js reads a non-ok status
// as "a user already exists": it showed the sign-in form and hid the
// create-the-first-administrator link, with no message. On an app with no
// accounts that is a locked door with no handle — the operator's report was
// "it broke the first user signup to super admin".
//
// A path prefix does not save you either, which is the other half of the
// lesson: `app.use('/api', yours)` above `app.use('/api', authRoutes)` shadows
// `/api/auth/*` exactly the same way.
//
// So the rule is the simple one: THE BUILD'S ROUTERS GO LAST.
export const SIGNIN_REACHABLE_GATE_SCRIPT = `# Baseline gate (ProxyPilot): the platform's own routes must not be shadowed.
set -u

APPFILE=""
for f in src/app.ts src/server.ts src/index.ts src/app.js src/server.js; do
  [ -f "$f" ] || continue
  if grep -qE "app\\.get\\( *['\\"]/login['\\"]" "$f"; then APPFILE="$f"; break; fi
done
if [ -z "$APPFILE" ]; then
  echo "signin-reachable: no /login route found in the usual entry files; skipped."
  exit 0
fi

# The platform's own mounts and plumbing, by the identifiers it uses. A line
# naming any of these is the platform's, wherever it sits.
#
# The plumbing half matters as much as the routers: express.json(),
# securityHeaders and the /_preview mount all sit above the auth gate by
# design, and the first version of this list flagged all three on a freshly
# scaffolded app. A gate that reds the scaffold gets switched off.
#
# The express pattern keeps its dot on purpose: it matches express.json,
# express.static and express.urlencoded, and does NOT match a build's own
# router called expressNotes.
PLAT='withAuth|withApiKey|bootstrapGate|publicPlatformRoutes|platformRoutes|adminPlatformRoutes|authRoutes|adminAuthRoutes|externalAuthRoutes|adminExternalRoutes|healthRoutes|requireRole|express\\.|securityHeaders|cookieParser|bodyParser|helmet|cors|compression|morgan|pinoHttp|rateLimit|requestId|/_preview'

# THE PLATFORM'S PAGE ROUTES count as platform mounts too. /admin, /profile and
# / all redirect an anonymous visitor to the sign-in page; a router that 401s
# above them turns "you are not signed in, here is the door" into a JSON error
# at the root, which is what a first-time visitor lands on.
PAGES="app\\.get\\( *['\\"](/login|/admin|/profile|/)['\\"]"

# THE BOUNDARY: the last platform mount or page route in the file. Everything
# the build adds belongs after it — see the ADD YOUR ROUTES marker the scaffold
# ships at exactly this position.
BOUNDARY=$(grep -nE "^[[:space:]]*app\\.(use|get)\\(" "$APPFILE" \\
  | grep -E "$PLAT|$PAGES" | tail -1 | cut -d: -f1)
[ -n "$BOUNDARY" ] || BOUNDARY=$(grep -nE "app\\.get\\( *['\\"]/login['\\"]" "$APPFILE" | head -1 | cut -d: -f1)

BADFILE=$(mktemp 2>/dev/null || echo /tmp/pp-signin-$$)
trap 'rm -f "$BADFILE"' EXIT
: > "$BADFILE"

# Any app.use(...) above the boundary that is NOT one of the platform's.
# Path-prefixed mounts count: the shadowing is the same.
head -n $((BOUNDARY - 1)) "$APPFILE" | grep -nE "^[[:space:]]*app\\.use\\(" | while IFS= read -r hit; do
  echo "$hit" | grep -qE "$PLAT" && continue
  LN=$(echo "$hit" | cut -d: -f1)
  CALL=$(echo "$hit" | sed -E 's/^[0-9]+:[[:space:]]*//' | cut -c1-70)
  echo "line $LN — $CALL" >> "$BADFILE"
done

if [ -s "$BADFILE" ]; then
  echo "FAIL: $APPFILE mounts the build's routes ABOVE the platform's own (which end at line $BOUNDARY):"
  sed 's/^/      /' "$BADFILE"
  echo ""
  echo "      A router runs its router-level middleware for every request that reaches it and"
  echo "      matches its mount path. Above the platform's routes, a router.use(requireAuth)"
  echo "      answers 401 to /api/auth/bootstrap/status — and login.js reads that as \\"a user"
  echo "      already exists\\", so it shows the sign-in form and HIDES the create-the-first-"
  echo "      administrator link. On an app with no accounts, nobody can get in and nothing"
  echo "      says why. The same router above /login makes every page and stylesheet 401."
  echo ""
  echo "      Move your app.use(...) lines BELOW line $BOUNDARY — after every platform mount."
  echo "      A path prefix does not help on its own: app.use('/api', yours) above"
  echo "      app.use('/api', authRoutes) shadows /api/auth/* just the same. Last is what matters."
  exit 1
fi

echo "signin-reachable: the build's routes are mounted after the platform's in $APPFILE. Passed."
exit 0
`;

export const BASELINE_GATES = Object.freeze([
  {
    name: DESIGN_ADHERENCE_GATE_NAME,
    script: DESIGN_ADHERENCE_GATE_SCRIPT,
    // Runs on a quick update too, but ADVISORY there: an app carrying design
    // debt from before this gate existed must not be unable to take a
    // one-line fix. It blocks from the MVP build up, which is where the
    // design is actually being built.
    tier: 'quick',
    advisoryIn: ['quick'],
  },
  {
    name: PLATFORM_INTACT_GATE_NAME,
    script: PLATFORM_INTACT_GATE_SCRIPT,
    // Blocking everywhere, including a quick update: deleting the base app's
    // features is never the intent of a small change, and the fix is a
    // git checkout, not work.
    tier: 'quick',
    advisoryIn: [],
  },
  // 'quick' and never advisory: a shadowed sign-in page is a dead app, the
  // check is deterministic, and the fix is moving one line.
  { name: SIGNIN_REACHABLE_GATE_NAME, script: SIGNIN_REACHABLE_GATE_SCRIPT, tier: 'quick', advisoryIn: [] },
  { name: MOBILE_OVERFLOW_GATE_NAME, script: MOBILE_OVERFLOW_GATE_SCRIPT, tier: 'mvp', advisoryIn: [] },
  // 'mvp' because it is squarely "does the app look and act right", and the
  // fix is small and local — exactly the kind of thing an MVP build should be
  // made to do rather than leave for a later pass.
  { name: NO_NATIVE_DIALOGS_GATE_NAME, script: NO_NATIVE_DIALOGS_GATE_SCRIPT, tier: 'mvp', advisoryIn: [] },
  { name: NO_DEAD_CONTROLS_GATE_NAME, script: NO_DEAD_CONTROLS_GATE_SCRIPT, tier: 'mvp', advisoryIn: [] },
  // The project's OWN browser suite, run against a server it starts itself.
  // 'mvp' because it is the only gate that exercises the rendered DOM before a
  // deploy — which is precisely "does the website look and act right", the
  // thing MVP is for. It skips green when the tooling or the browser binary is
  // absent (an environment problem must never red a build), but never when a
  // test fails.
  { name: E2E_GATE_NAME, script: e2eGateScript(), tier: 'mvp', advisoryIn: [] },
]);

export const BASELINE_GATE_NAMES = Object.freeze(BASELINE_GATES.map((g) => g.name));

// baselineGatesForProfile — the baseline gates that belong in a profile, each
// already wrapped for advisory placement where that applies.
export function baselineGatesForProfile(profile) {
  const rank = tierRank(profile);
  return BASELINE_GATES
    .filter((g) => tierRank(g.tier) <= rank)
    .map((g) => ({
      name: g.name,
      script: (g.advisoryIn || []).includes(profile) ? asAdvisory(g.script, g.name) : g.script,
      advisory: (g.advisoryIn || []).includes(profile),
    }));
}
