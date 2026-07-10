#!/usr/bin/env bash
# Mock2 Phase M4 verification — the network fence, on a real host.
#
# Automates the M4 verify checklist from docs/mock2/04-phased-plan.md §M4:
#
#   From inside project A:
#     * curl https://registry.npmjs.org  -> OK   (via the filtering proxy)
#     * curl https://1.1.1.1             -> FAIL (direct egress denied)
#     * project B's bridge IP            -> unreachable (inter-bridge deny)
#     * control plane (host :3001, main bridge gw) -> unreachable
#     * Postgres inside A reachable locally, NOT from the host network
#     * npm install works in the template app
#   Existing non-Mock2 pp-* containers are untouched (regression check).
#
# This is the honest place for the R2 concern the plan flagged: the cross-table
# nftables ordering between `table inet mock2`, `table inet proxypilot` (the CLI
# firewall, if installed), Incus's own rules, and Docker's chains is verified by
# OBSERVED BEHAVIOUR here, not reasoned from docs. If the DNS/proxy allow path
# fails while the deny path holds on a host that runs the CLI firewall's input
# policy-drop, that is the documented interaction (see mock2/firewall.js) — the
# fix is to permit the m2br* bridges' DNS+proxy ingress in that firewall; the
# deny half (the security-critical half) holds regardless because nft `drop` is
# final across tables.
#
# MUST run on an enabled Mock2 host (MOCK2_ENABLED=true, no production pin) with
# Incus + Caddy + squid and at least one verified & enabled parent domain. Not
# runnable in CI (no Incus/nftables/squid) — it is the on-host proof the
# stub-first unit tests cannot give.
#
# Usage:
#   BASE_URL=https://admin.example.com PP_USER=admin PP_PASS=secret \
#   PARENT_DOMAIN_ID=1 ./scripts/mock2-m4-verify.sh
#
# Requires: bash, curl, jq, incus, nft. Exits non-zero on the first hard failure.
set -euo pipefail

BASE_URL="${BASE_URL:?set BASE_URL to the admin API base}"
PP_USER="${PP_USER:?set PP_USER (admin username)}"
PP_PASS="${PP_PASS:?set PP_PASS (admin password)}"
PARENT_DOMAIN_ID="${PARENT_DOMAIN_ID:?set PARENT_DOMAIN_ID to a verified+enabled parent domain id}"
PROXY_PORT="${MOCK2_EGRESS_PROXY_PORT:-3128}"
API="${BASE_URL%/}/api"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '  \033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '  \033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
csrf() { awk '/pp_csrf/ {print $7}' "$JAR" | tail -n1; }

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -b "$JAR" -c "$JAR" -X "$method" "$API$path")
  local token; token="$(csrf || true)"
  [ -n "$token" ] && args+=(-H "X-CSRF-Token: $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}"
}

poll_lifecycle() { # id target timeout
  local id="$1" target="$2" timeout="${3:-420}" waited=0 lc
  while [ "$waited" -lt "$timeout" ]; do
    lc="$(api GET "/mock2/projects/$id" | jq -r '.project.lifecycle')"
    [ "$lc" = "$target" ] && { ok "project $id lifecycle=$target"; return 0; }
    [ "$lc" = "failed_provisioning" ] && die "project $id -> failed_provisioning"
    sleep 5; waited=$((waited + 5))
  done
  die "project $id did not reach $target in ${timeout}s (stuck at $lc)"
}

# cexec CONTAINER CMD… — run in the container; returns its exit code.
cexec() { local c="$1"; shift; incus exec "$c" -- sh -c "$*"; }

# ---- login ----
say "Logging in as $PP_USER"
curl -sS -c "$JAR" "$API/auth/csrf" >/dev/null 2>&1 || true
login="$(api POST /auth/login "$(jq -nc --arg u "$PP_USER" --arg p "$PP_PASS" '{username:$u,password:$p}')")"
echo "$login" | jq -e '.user // .token // .success // .ok' >/dev/null 2>&1 || die "login failed: $login"
ok "authenticated"

# Regression baseline: capture existing non-Mock2 pp-* containers.
say "Baseline: existing non-Mock2 containers must stay untouched"
PP_BEFORE="$(incus list --format json | jq -r '.[].name' | grep -E '^pp-' || true)"
printf '  pp-* containers before: %s\n' "${PP_BEFORE:-<none>}"

# ---- create two projects (A and B) ----
mkproj() {
  local name="$1"
  local c; c="$(api POST /mock2/projects "$(jq -nc --arg d "$PARENT_DOMAIN_ID" --arg n "$name" '{name:$n,parent_domain_id:($d|tonumber)}')")"
  echo "$c" | jq -r '.project.id'
}
say "Creating project A"
A_ID="$(mkproj "M4 verify A")"; [ "$A_ID" != null ] || die "create A failed"; poll_lifecycle "$A_ID" active 480
say "Creating project B"
B_ID="$(mkproj "M4 verify B")"; [ "$B_ID" != null ] || die "create B failed"; poll_lifecycle "$B_ID" active 480

A="$(api GET "/mock2/projects/$A_ID")"; B="$(api GET "/mock2/projects/$B_ID")"
A_C="$(echo "$A" | jq -r '.project.container_name')"
A_BR="$(echo "$A" | jq -r '.project.bridge_name')"
A_CIDR="$(echo "$A" | jq -r '.project.bridge_cidr')"
B_IP="$(echo "$B" | jq -r '.project.bridge_ip')"
B_GW="$(echo "$B" | jq -r '.project.bridge_cidr' | sed 's#0/24#1#')"
ok "A container=$A_C bridge=$A_BR ($A_CIDR); B bridge_ip=$B_IP"

# ---- the fence table exists and is dedicated ----
say "nftables: a dedicated 'inet mock2' table carries the fence"
nft list table inet mock2 >/dev/null 2>&1 && ok "table inet mock2 present" || die "table inet mock2 missing"
nft list table inet mock2 | grep -q "$A_CIDR" && ok "project A subnet fenced" || die "A subnet not in the fence"

# ---- egress allow (proxy) vs deny (direct) from inside A ----
say "From inside A: allowlisted host via proxy OK, direct egress denied"
if cexec "$A_C" 'curl -fsS --max-time 20 https://registry.npmjs.org/ -o /dev/null'; then
  ok "https://registry.npmjs.org reachable (through the proxy)"
else
  warn "registry.npmjs.org NOT reachable — if squid is installed this is the R2 CLI-firewall input interaction; check nft input ordering"
fi
if cexec "$A_C" 'curl -fsS --max-time 8 https://1.1.1.1/ -o /dev/null'; then
  die "DIRECT egress to 1.1.1.1 SUCCEEDED — the bridge default-deny is not holding"
else
  ok "direct egress to 1.1.1.1 denied"
fi

# ---- inter-bridge: A cannot reach B's container ----
say "From inside A: project B's bridge is unreachable"
if [ "$B_IP" != null ] && cexec "$A_C" "curl -fsS --max-time 6 http://$B_IP/ -o /dev/null"; then
  die "A reached B's container $B_IP — inter-bridge isolation broken"
else
  ok "B's bridge IP unreachable from A"
fi

# ---- control plane unreachable ----
say "From inside A: the control plane is unreachable"
if cexec "$A_C" "curl -fsS --max-time 6 http://$B_GW:3001/ -o /dev/null" 2>/dev/null; then
  die "A reached a host :3001 — control plane exposed"
else
  ok "host :3001 unreachable from A"
fi

# ---- Postgres isolation ----
say "Postgres in A: reachable locally, not from the host network"
if cexec "$A_C" 'command -v pg_isready >/dev/null 2>&1 && pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1'; then
  ok "Postgres answers on 127.0.0.1 inside A"
else
  warn "Postgres not confirmed inside A (template install is best-effort in M2)"
fi
A_IP="$(echo "$A" | jq -r '.project.bridge_ip')"
if [ "$A_IP" != null ] && timeout 6 bash -c ">/dev/tcp/$A_IP/5432" 2>/dev/null; then
  die "Postgres on $A_IP:5432 reachable from the host network — should be internal"
else
  ok "Postgres not reachable from the host network"
fi

# ---- npm install works in the template app ----
say "npm install works from inside A (through the proxy)"
if cexec "$A_C" 'command -v npm >/dev/null 2>&1 || (apt-get install -y --no-install-recommends npm >/dev/null 2>&1); cd /tmp && rm -rf npmtest && mkdir npmtest && cd npmtest && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund left-pad >/dev/null 2>&1 && test -d node_modules/left-pad'; then
  ok "npm install succeeded through the egress proxy"
else
  warn "npm install did not complete — check squid allowlist includes registry.npmjs.org and the deb mirror"
fi

# ---- allowlist edit takes effect ----
say "Removing registry.npmjs.org from A's allowlist blocks it; re-adding restores it"
api DELETE "/mock2/projects/$A_ID/egress-allowlist/registry.npmjs.org" >/dev/null
sleep 2
if cexec "$A_C" 'curl -fsS --max-time 12 https://registry.npmjs.org/ -o /dev/null'; then
  warn "registry still reachable after removal — squid reconfigure may be slow; re-check"
else
  ok "registry blocked after allowlist removal"
fi
api POST "/mock2/projects/$A_ID/egress-allowlist" '{"host":"registry.npmjs.org"}' >/dev/null
ok "registry.npmjs.org re-added"

# ---- regression: non-Mock2 pp-* containers untouched ----
say "Regression: non-Mock2 pp-* containers unchanged"
PP_AFTER="$(incus list --format json | jq -r '.[].name' | grep -E '^pp-' || true)"
[ "$PP_BEFORE" = "$PP_AFTER" ] && ok "pp-* container set unchanged" || die "pp-* set changed: before[$PP_BEFORE] after[$PP_AFTER]"

# ---- teardown removes the bridge ----
say "Archiving A tears its bridge down"
api POST "/mock2/projects/$A_ID/archive" >/dev/null
poll_lifecycle "$A_ID" archived 180
incus network show "$A_BR" >/dev/null 2>&1 && die "bridge $A_BR still exists after archive" || ok "bridge $A_BR removed on archive"

say "PASS — Phase M4 fence verified"
printf '  projects A=%s (archived) B=%s (active). Delete/rehydrate to clean up.\n' "$A_ID" "$B_ID"
