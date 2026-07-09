#!/usr/bin/env bash
# Mock2 Phase M3 verification — archive and rehydrate, proven.
#
# This automates the M3 verify checklist from docs/mock2/04-phased-plan.md §M3:
#
#   create project → modify files in the container → archive → rehydrate →
#   modified state is back at the SAME URL. Then: archive → delete the container
#   image cache → rehydrate still works (proves NO snapshot dependency — ADR-006).
#
# It MUST run on an enabled Mock2 host (MOCK2_ENABLED=true, no production pin)
# that has Incus + Caddy and at least one verified & enabled parent domain. It
# drives the real /api/mock2 routes over HTTP and shells into the container with
# `incus exec`, so it cannot run in CI (no Incus) — it is the on-host proof the
# unit tests (stub-first) cannot give.
#
# Usage:
#   BASE_URL=https://admin.example.com \
#   PP_USER=admin PP_PASS=secret \
#   PARENT_DOMAIN_ID=1 \
#   ./scripts/mock2-m3-verify.sh
#
# Requires: bash, curl, jq. Exits non-zero on the first failed assertion.
set -euo pipefail

BASE_URL="${BASE_URL:?set BASE_URL to the admin API base, e.g. https://admin.example.com}"
PP_USER="${PP_USER:?set PP_USER (admin username)}"
PP_PASS="${PP_PASS:?set PP_PASS (admin password)}"
PARENT_DOMAIN_ID="${PARENT_DOMAIN_ID:?set PARENT_DOMAIN_ID to a verified+enabled parent domain id}"
API="${BASE_URL%/}/api"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '  \033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

csrf() { awk '/pp_csrf/ {print $7}' "$JAR" | tail -n1; }

# api METHOD PATH [json-body] → response body on stdout
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -b "$JAR" -c "$JAR" -X "$method" "$API$path")
  local token; token="$(csrf || true)"
  [ -n "$token" ] && args+=(-H "X-CSRF-Token: $token")
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' -d "$body"); fi
  curl "${args[@]}"
}

poll_lifecycle() { # id target-lifecycle timeout-seconds
  local id="$1" target="$2" timeout="${3:-300}" waited=0 lc
  while [ "$waited" -lt "$timeout" ]; do
    lc="$(api GET "/mock2/projects/$id" | jq -r '.project.lifecycle')"
    [ "$lc" = "$target" ] && { ok "project $id reached lifecycle=$target"; return 0; }
    [ "$lc" = "failed_provisioning" ] && die "project $id landed in failed_provisioning"
    sleep 5; waited=$((waited + 5))
  done
  die "project $id did not reach $target within ${timeout}s (stuck at $lc)"
}

# ---- login ----
say "Logging in as $PP_USER"
# Prime the CSRF cookie, then authenticate.
curl -sS -c "$JAR" "$API/auth/csrf" >/dev/null 2>&1 || true
login="$(api POST /auth/login "$(jq -nc --arg u "$PP_USER" --arg p "$PP_PASS" '{username:$u,password:$p}')")"
echo "$login" | jq -e '.user // .token // .success // .ok' >/dev/null 2>&1 || die "login failed: $login"
ok "authenticated"

# ---- 1. create a project, wait for it to come online ----
say "Creating a project on parent domain $PARENT_DOMAIN_ID"
create="$(api POST /mock2/projects "$(jq -nc --arg d "$PARENT_DOMAIN_ID" '{name:"M3 verify", description:"archive/rehydrate proof", parent_domain_id:($d|tonumber)}')")"
PID="$(echo "$create" | jq -r '.project.id')"
[ -n "$PID" ] && [ "$PID" != "null" ] || die "create failed: $create"
ok "created project id=$PID"
poll_lifecycle "$PID" active 420

proj="$(api GET "/mock2/projects/$PID")"
CNAME="$(echo "$proj" | jq -r '.project.container_name')"
URL="$(echo "$proj" | jq -r '.project.url')"
[ -n "$CNAME" ] && [ "$CNAME" != "null" ] || die "no container_name on project"
ok "container=$CNAME url=$URL"

# ---- 2. modify a file INSIDE the container (do not commit — archive commits it) ----
MARK="m3-verify-$RANDOM$RANDOM"
say "Writing marker '$MARK' into the container working tree"
incus exec "$CNAME" -- sh -c "printf '%s' '$MARK' > /srv/app/public/index.html"
ok "modified /srv/app/public/index.html in $CNAME"

# ---- 3. archive → rehydrate → the marker is back at the same URL ----
say "Archiving"
api POST "/mock2/projects/$PID/archive" >/dev/null
poll_lifecycle "$PID" archived 180
incus info "$CNAME" >/dev/null 2>&1 && die "container still exists after archive" || ok "container destroyed"

say "Rehydrating"
api POST "/mock2/projects/$PID/rehydrate" >/dev/null
poll_lifecycle "$PID" active 420

say "Fetching the URL — the marker must have survived archive→rehydrate"
sleep 5
body="$(curl -sS "$URL" || true)"
echo "$body" | grep -q "$MARK" && ok "marker present after rehydrate — modified state recovered from the bare repo" \
  || die "marker MISSING after rehydrate (got: $(echo "$body" | head -c 120))"

# ---- 4. NO SNAPSHOT DEPENDENCY: delete the image cache, archive, rehydrate ----
say "Archiving again, then deleting the base image cache (proving no snapshot dependency)"
api POST "/mock2/projects/$PID/archive" >/dev/null
poll_lifecycle "$PID" archived 180
# Remove every cached image so rehydrate must re-pull/rebuild from scratch.
for FP in $(incus image list --format json | jq -r '.[].fingerprint'); do
  incus image delete "$FP" 2>/dev/null || true
done
ok "image cache cleared"

say "Rehydrating with a cold image cache"
api POST "/mock2/projects/$PID/rehydrate" >/dev/null
poll_lifecycle "$PID" active 600
sleep 5
body="$(curl -sS "$URL" || true)"
echo "$body" | grep -q "$MARK" && ok "marker STILL present — rehydrate rebuilt from the bare repo, not a snapshot" \
  || die "marker missing after cold-cache rehydrate"

say "PASS — Phase M3 verified (archive + rehydrate, no snapshot dependency)"
printf '  project %s left active at %s (archive/delete it manually to clean up)\n' "$PID" "$URL"
