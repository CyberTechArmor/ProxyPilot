#!/bin/bash
# Sourced by update.sh AFTER checkout/preflight, BEFORE application mutations.
# Keep this bootstrap in shell: the installed Node may be missing/too old to
# import the new CLI. No caller-supplied URL, version or package is accepted.

pp_node_candidates() {
    command -v node || true
    printf '%s\n' /usr/bin/node /usr/local/bin/node
}

pp_select_node_runtime() {
    local candidate npm_candidate
    while IFS= read -r candidate; do
        [[ -x "$candidate" ]] || continue
        if ! "$candidate" -e 'const [m,n]=process.versions.node.split(".").map(Number);process.exit((m===24||(m===22&&n>=15))?0:1)' >/dev/null 2>&1; then
            continue
        fi
        npm_candidate="$(dirname "$candidate")/npm"
        # Check npm with the selected Node, not its /usr/bin/env shebang.
        [[ -f "$npm_candidate" ]] || continue
        "$candidate" "$npm_candidate" --version >/dev/null 2>&1 || continue
        NODE_CMD="$candidate"
        NPM_CMD="$npm_candidate"
        export PATH="$(dirname "$NODE_CMD"):$PATH"
        hash -r
        return 0
    done < <(pp_node_candidates)
    return 1
}

pp_node_can_install() {
    [[ "$EUID" -eq 0 && -f /etc/debian_version ]] && command -v apt-get >/dev/null && command -v curl >/dev/null
}

pp_ensure_node_runtime() {
    if pp_select_node_runtime; then
        log "Using Node.js $($NODE_CMD --version) ($NODE_CMD) and its npm."
        return 0
    fi
    if ! pp_node_can_install; then
        log "Node.js 22.15+ or 24 LTS with npm is required. Automatic installation requires root on a Debian/Ubuntu host with apt-get and curl. Install a supported runtime locally, then retry Update. No application rebuild has started."
        return 1
    fi
    log "Installing Node.js 24 LTS and npm from the same NodeSource repository used by the installer..."
    local bootstrap_dir
    bootstrap_dir=$(mktemp -d) || return 1
    # Download fully before executing: a failed/truncated transfer must never
    # be hidden by a successful downstream shell in a curl | bash pipeline.
    if ! curl --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 180 --retry 2 -fsSL https://deb.nodesource.com/setup_24.x -o "$bootstrap_dir/setup.sh"; then
        rm -rf "$bootstrap_dir"
        log "Node.js runtime download failed. Check access to deb.nodesource.com, then retry Update; no application rebuild has started."
        return 1
    fi
    if ! env DEBIAN_FRONTEND=noninteractive bash "$bootstrap_dir/setup.sh"; then
        rm -rf "$bootstrap_dir"
        log "NodeSource repository setup failed. Check the package-manager output above, then retry Update; no application rebuild has started."
        return 1
    fi
    rm -rf "$bootstrap_dir"
    if ! env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs; then
        log "Node.js 24 installation failed. Check the package-manager output above, then retry Update; no application rebuild has started."
        return 1
    fi
    hash -r
    if ! pp_select_node_runtime; then
        log "Node.js installation did not produce a supported Node/npm pair. Check the host package installation before retrying Update; no application rebuild has started."
        return 1
    fi
    log "Node.js runtime ready: $($NODE_CMD --version) ($NODE_CMD)."
}

# A Node major upgrade changes the native-addon ABI. A plain npm install can
# retain old better-sqlite3/node-pty binaries. Always rebuild the dependency
# tree from the reviewed lockfile; propagate npm failures through tee.
pp_install_locked_dependencies() (
    set -o pipefail
    local directory="$1"
    shift
    cd "$directory" || exit 1
    "$NODE_CMD" "$NPM_CMD" ci "$@" 2>&1 | tee -a "$LOG_FILE"
)
