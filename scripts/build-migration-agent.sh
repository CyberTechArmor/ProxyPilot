#!/usr/bin/env bash
# Cross-build the migration agent for the architectures a SOURCE host might
# be, and put them where the backend serves them from.
#
#   /var/lib/proxypilot/agent/proxypilot-agent-linux-amd64
#   /var/lib/proxypilot/agent/proxypilot-agent-linux-arm64
#   …plus a .sha256 beside each, which the bootstrap script bakes in and the
#   source host verifies before it runs anything.
#
# This is the same binary as the host agent (cmd/agent), built with
# CGO_ENABLED=0 so it is fully static and runs on a source host of any vintage
# — an old CentOS with a 2.17 glibc included. install.sh and update.sh call
# this; running it by hand is fine and idempotent.
#
# Usage: build-migration-agent.sh [source-dir] [output-dir]
set -euo pipefail

SRC_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT_DIR="${2:-/var/lib/proxypilot/agent}"
AGENT_SRC="${SRC_DIR}/cmd/agent"

if [[ ! -f "${AGENT_SRC}/go.mod" ]]; then
  echo "build-migration-agent: no Go module at ${AGENT_SRC}" >&2
  exit 1
fi

# Find a Go toolchain the same way install.sh does.
GO_BIN=""
for candidate in "$(command -v go 2>/dev/null || true)" /usr/local/go/bin/go; do
  [[ -n "$candidate" && -x "$candidate" ]] && { GO_BIN="$candidate"; break; }
done
if [[ -z "$GO_BIN" ]]; then
  echo "build-migration-agent: no Go toolchain found (install.sh installs one) — skipping the cross-build" >&2
  exit 0
fi

BUILD_SHA="$(git -C "$SRC_DIR" rev-parse --short=10 HEAD 2>/dev/null || echo unknown)"
mkdir -p "$OUT_DIR"
chmod 0755 "$OUT_DIR"

built=0
for arch in amd64 arm64; do
  out="${OUT_DIR}/proxypilot-agent-linux-${arch}"
  tmp="${out}.new"
  # A failed cross-build for one architecture must not take the other one
  # down: a host with no arm64 sources still deserves a working amd64 agent.
  if ( cd "$AGENT_SRC" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" GOFLAGS=-mod=mod \
        "$GO_BIN" build -trimpath \
        -ldflags "-s -w -X github.com/cybertecharmor/proxypilot/cmd/agent/methods.AgentVersion=${BUILD_SHA} -X github.com/cybertecharmor/proxypilot/cmd/agent/migrate.Version=${BUILD_SHA}" \
        -o "$tmp" . ); then
    mv -f "$tmp" "$out"
    chmod 0755 "$out"
    sha256sum "$out" | cut -d' ' -f1 > "${out}.sha256"
    echo "  migration agent: linux/${arch} $(cut -c1-12 < "${out}.sha256")… ($(stat -c%s "$out") bytes)"
    built=$((built + 1))
  else
    rm -f "$tmp"
    echo "  migration agent: linux/${arch} build FAILED — that architecture cannot be migrated from until it is fixed" >&2
  fi
done

[[ "$built" -gt 0 ]] || { echo "build-migration-agent: no architecture built" >&2; exit 1; }
exit 0
