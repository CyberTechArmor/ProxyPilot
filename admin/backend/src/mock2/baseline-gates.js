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
// The approved design must actually be consumed. Deliberately blunt: it does
// not judge taste, spacing or hierarchy — the design review does that. It only
// fires on the unambiguous signatures of "the approved design was ignored".
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
for f in public/*.html; do
  [ -f "$f" ] || continue
  grep -q 'base.css' "$f" || continue
  grep -q 'design.css' "$f" || continue
  DPOS=$(grep -n 'design.css' "$f" | head -1 | cut -d: -f1)
  BPOS=$(grep -n 'base.css' "$f" | head -1 | cut -d: -f1)
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
APP="$WORK/app.css"
: > "$APP"
for f in public/*.css; do
  [ -f "$f" ] || continue
  case "$f" in */base.css|*/design.css|*/platform.css) continue ;; esac
  cat "$f" >> "$APP"
done
APPBYTES=$(wc -c < "$APP" | tr -d ' ')

# Declared variables on each side, and the approved ones the app actually reads.
grep -o -- '--[A-Za-z0-9_-]*[[:space:]]*:' "$DESIGN" | sed 's/[[:space:]]*:$//' | sort -u > "$WORK/approved"
grep -o -- '--[A-Za-z0-9_-]*[[:space:]]*:' "$APP"    | sed 's/[[:space:]]*:$//' | sort -u > "$WORK/appdef"
grep -o -- 'var([[:space:]]*--[A-Za-z0-9_-]*' "$APP" | sed 's/.*--/--/'         | sort -u > "$WORK/appuse"

APPROVED=$(wc -l < "$WORK/approved" | tr -d ' ')
USED=$(comm -12 "$WORK/appuse" "$WORK/approved" | wc -l | tr -d ' ')
OWN=$(comm -23 "$WORK/appdef" "$WORK/approved" | wc -l | tr -d ' ')

echo "design-adherence: \${APPROVED} approved variable(s); the app uses \${USED} of them, declares \${OWN} of its own, in \${APPBYTES} bytes of its own CSS."

# Too little approved design to judge against (a preset-only project).
if [ "$APPROVED" -lt 8 ]; then
  echo "design-adherence: fewer than 8 approved variables — not enough of a design system to enforce."
  if [ "$SHELLFAIL" -ne 0 ]; then exit 1; fi
  echo "design-adherence: the shell is driven by the approved design. Passed."
  exit 0
fi
# The app has not written stylesheets of its own yet.
if [ "$APPBYTES" -lt 2000 ]; then
  echo "design-adherence: the app has not written substantial CSS of its own."
  if [ "$SHELLFAIL" -ne 0 ]; then exit 1; fi
  echo "design-adherence: the shell is driven by the approved design. Passed."
  exit 0
fi

FAIL=$SHELLFAIL
if [ "$USED" -eq 0 ]; then
  echo "FAIL: the app's stylesheets reference NONE of the \${APPROVED} approved design variables."
  echo "      state/design.css is loaded and ignored. Restyle the screens on var(--...) from state/design.css"
  echo "      instead of a parallel palette; state/mockups/current.html is the visual contract."
  FAIL=1
elif [ "$OWN" -ge 12 ] && [ $((USED * 4)) -lt "$APPROVED" ]; then
  echo "FAIL: the app declares \${OWN} design variables of its own while using only \${USED} of \${APPROVED} approved ones."
  echo "      That is a second palette; the two will drift. Delete the parallel tokens and consume state/design.css."
  FAIL=1
fi

# A dropped dark theme is a broken shipped feature, not a style opinion.
if grep -q 'data-theme' "$DESIGN" && [ "$OWN" -ge 8 ] && ! grep -q 'data-theme' "$APP"; then
  echo "FAIL: the approved design defines a dark theme; the app's own \${OWN} variables have no dark variant,"
  echo "      so the theme toggle changes nothing for them. Add the [data-theme=\\"dark\\"] values or use the approved ones."
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "design-adherence: the app builds on the approved design, and the shell is bridged onto it. Passed."
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
if [ ! -s "$CSS" ]; then
  echo "mobile-overflow: no app stylesheets to check. Skipped."
  exit 0
fi

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

# The viewport meta is what makes any of the above matter.
for f in public/*.html; do
  [ -f "$f" ] || continue
  grep -qi '<head' "$f" || continue
  if ! grep -qi 'name=["'"'"']*viewport' "$f"; then
    echo "FAIL: $f has no viewport meta — a phone renders it at desktop width and zooms out."
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "mobile-overflow: no fixed widths, uncollapsible grids, or missing viewport. Passed."
exit 0
`;

// ---- no-dead-controls ----
//
// The build prompt already binds this ("anything you do NOT implement must be
// VISIBLY marked — a disabled control with a small 'Not built yet' badge").
// Nothing enforced it, so unimplemented features shipped as buttons that did
// nothing at all — the single worst thing a demo can do.
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

// ---- the registry ----

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
  { name: MOBILE_OVERFLOW_GATE_NAME, script: MOBILE_OVERFLOW_GATE_SCRIPT, tier: 'mvp', advisoryIn: [] },
  // 'mvp' because it is squarely "does the app look and act right", and the
  // fix is small and local — exactly the kind of thing an MVP build should be
  // made to do rather than leave for a later pass.
  { name: NO_NATIVE_DIALOGS_GATE_NAME, script: NO_NATIVE_DIALOGS_GATE_SCRIPT, tier: 'mvp', advisoryIn: [] },
  { name: NO_DEAD_CONTROLS_GATE_NAME, script: NO_DEAD_CONTROLS_GATE_SCRIPT, tier: 'mvp', advisoryIn: [] },
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
