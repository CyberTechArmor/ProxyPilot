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

APP=/tmp/pp-app.css
: > "$APP"
for f in public/*.css; do
  [ -f "$f" ] || continue
  case "$f" in */base.css|*/design.css|*/platform.css) continue ;; esac
  cat "$f" >> "$APP"
done
APPBYTES=$(wc -c < "$APP" | tr -d ' ')

# Declared variables on each side, and the approved ones the app actually reads.
grep -o -- '--[A-Za-z0-9_-]*[[:space:]]*:' "$DESIGN" | sed 's/[[:space:]]*:$//' | sort -u > /tmp/pp-approved
grep -o -- '--[A-Za-z0-9_-]*[[:space:]]*:' "$APP"    | sed 's/[[:space:]]*:$//' | sort -u > /tmp/pp-appdef
grep -o -- 'var([[:space:]]*--[A-Za-z0-9_-]*' "$APP" | sed 's/.*--/--/'         | sort -u > /tmp/pp-appuse

APPROVED=$(wc -l < /tmp/pp-approved | tr -d ' ')
USED=$(comm -12 /tmp/pp-appuse /tmp/pp-approved | wc -l | tr -d ' ')
OWN=$(comm -23 /tmp/pp-appdef /tmp/pp-approved | wc -l | tr -d ' ')

echo "design-adherence: \${APPROVED} approved variable(s); the app uses \${USED} of them, declares \${OWN} of its own, in \${APPBYTES} bytes of its own CSS."

# Too little approved design to judge against (a preset-only project).
if [ "$APPROVED" -lt 8 ]; then
  echo "design-adherence: fewer than 8 approved variables — not enough of a design system to enforce. Passed."
  exit 0
fi
# The app has not written stylesheets of its own yet.
if [ "$APPBYTES" -lt 2000 ]; then
  echo "design-adherence: the app has not written substantial CSS of its own. Passed."
  exit 0
fi

FAIL=0
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
echo "design-adherence: the app builds on the approved design. Passed."
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
         migrations/0100_platform.sql public/theme.js public/platform.js; do
  [ -f "$f" ] || MISSING="$MISSING $f"
done
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
CSS=/tmp/pp-mobile.css
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
