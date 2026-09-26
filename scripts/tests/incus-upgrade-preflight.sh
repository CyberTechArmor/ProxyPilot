#!/usr/bin/env bash
# Refusal tests run with mocked host commands; no Incus or apt mutation occurs.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
cat > "$fixture/id" <<'EOF'
#!/bin/sh
echo 0
EOF
cat > "$fixture/uname" <<'EOF'
#!/bin/sh
echo "$MOCK_KERNEL"
EOF
cat > "$fixture/incus" <<'EOF'
#!/bin/sh
case "$1" in
    version) echo 6.0.4 ;;
    list) echo '[]' ;;
    query)
        if [ "$MOCK_RESPONSE_STYLE" = wrapped ]; then
            printf '{"metadata":{"environment":{"server_clustered":%s}}}\n' "$MOCK_CLUSTERED"
        else
            printf '{"environment":{"server_clustered":%s}}\n' "$MOCK_CLUSTERED"
        fi ;;
    *) exit 99 ;;
esac
EOF
cat > "$fixture/apt-get" <<'EOF'
#!/bin/sh
touch "$MOCK_APT_MARKER"
exit 99
EOF
chmod +x "$fixture/id" "$fixture/uname" "$fixture/incus" "$fixture/apt-get"

case_refuses() {
    local cluster="$1" kernel="$2" expected="$3" style="${4:-raw}" output status
    rm -f "$fixture/apt-called"
    status=0
    output=$(PATH="$fixture:$PATH" MOCK_CLUSTERED="$cluster" MOCK_KERNEL="$kernel" MOCK_RESPONSE_STYLE="$style" \
        MOCK_APT_MARKER="$fixture/apt-called" bash "$root/scripts/upgrade-incus-stable.sh" 2>&1) || status=$?
    [ "$status" -ne 0 ] || { echo 'upgrader unexpectedly succeeded' >&2; exit 1; }
    [[ "$output" == *"$expected"* ]] || { printf 'unexpected refusal: %s\n' "$output" >&2; exit 1; }
    [ ! -e "$fixture/apt-called" ] || { echo 'apt ran before refusal' >&2; exit 1; }
}

case_refuses true 6.12.0 'cluster status is unknown or clustered' wrapped
case_refuses null 6.12.0 'cluster status is unknown or clustered'
case_refuses false 6.8.0 'below the Incus 7.x minimum'
echo 'Incus upgrade preflight refusals: PASS (3 cases)'
