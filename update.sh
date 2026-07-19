#!/bin/bash

# ProxyPilot Update Script
# This script updates ProxyPilot from the GitHub repository

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/admin/backend"
FRONTEND_DIR="$SCRIPT_DIR/admin/frontend"
LOG_FILE="/tmp/proxypilot-update.log"

# Pre-update DB backup state (populated by backup_db, consumed by restore_db on failure)
DB_BACKUP_FILE=""
DB_BACKUP_SOURCE=""
BACKUPS_TO_KEEP=5

# Globally-set during the restart phase so on_error can attempt docker
# compose up -d on the existing image after a failed rebuild.
INSTALL_DIR=""

# Concurrent-run guard. Two update.sh invocations will race on the DB
# backup, the git pull, and the docker rebuild. flock is in util-linux
# on every Debian/Ubuntu we support; if it's missing we just warn and
# continue.
LOCK_FILE="/var/lock/proxypilot-update.lock"
if command -v flock &>/dev/null; then
    exec 200>"$LOCK_FILE" 2>/dev/null || true
    if ! flock -n 200 2>/dev/null; then
        echo -e "\033[0;31m[ERROR]\033[0m Another update.sh is already running (lock: $LOCK_FILE)."
        echo "If you're sure no other process is running:"
        echo "  rm $LOCK_FILE && retry"
        exit 1
    fi
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parse arguments
FORCE_REBUILD=false
SKIP_RESTART=false
VERBOSE=false
ENABLE_MOCK2=false
for arg in "$@"; do
    case $arg in
        --rebuild|--force|-f)
            FORCE_REBUILD=true
            ;;
        --no-restart)
            SKIP_RESTART=true
            ;;
        --verbose|-v)
            VERBOSE=true
            ;;
        --enable-mock2)
            ENABLE_MOCK2=true
            ;;
        --help|-h)
            echo "ProxyPilot Update Script"
            echo ""
            echo "Usage: ./update.sh [options]"
            echo ""
            echo "Options:"
            echo "  --rebuild, --force, -f   Force rebuild even if code is up to date"
            echo "  --no-restart             Don't restart after update"
            echo "  --enable-mock2           Turn on the Mock2 dev/build module (sets"
            echo "                           MOCK2_ENABLED=true in the deployed .env). The"
            echo "                           'Projects' section appears for admins after"
            echo "                           the restart. A production pin still forces it off."
            echo "  --verbose, -v            Show verbose output"
            echo "  --help, -h               Show this help message"
            exit 0
            ;;
    esac
done

log() {
    echo -e "$1"
    echo -e "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE" 2>/dev/null || true
}

log_verbose() {
    if [ "$VERBOSE" = true ]; then
        echo -e "${CYAN}[DEBUG]${NC} $1"
    fi
    echo -e "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] $1" >> "$LOG_FILE" 2>/dev/null || true
}

# Find command in common paths
find_command() {
    local cmd=$1
    local paths="/usr/local/bin/$cmd /usr/bin/$cmd /bin/$cmd /opt/homebrew/bin/$cmd"

    # First try which
    if command -v $cmd &> /dev/null; then
        command -v $cmd
        return 0
    fi

    # Then try common paths
    for path in $paths; do
        if [ -x "$path" ]; then
            echo "$path"
            return 0
        fi
    done

    return 1
}

resolve_env_path() {
    # Find the deployed .env. Same search order as resolve_db_path.
    for candidate in \
        "/opt/proxypilot/.env" \
        "$SCRIPT_DIR/.env" \
        "$(dirname "$SCRIPT_DIR")/.env"; do
        if [ -f "$candidate" ]; then
            echo "$candidate"
            return
        fi
    done
    echo ""
}

# Compare keys in .env.example (the canonical set) against the deployed
# .env. Any key in the example but missing from the deployed file is
# appended; existing values are preserved. For known secret keys
# (TOTP_ENCRYPTION_KEY, JWT_SECRET, SESSION_SECRET) with placeholder
# defaults, a real value is auto-generated rather than appended as
# CHANGE_ME — the placeholder would be parsed by the app's startup
# guards and crash boot.
sync_env_keys() {
    local example="$SCRIPT_DIR/.env.example"
    local deployed
    deployed="$(resolve_env_path)"

    if [ ! -f "$example" ]; then
        log_verbose ".env.example not present in this version — skipping env sync"
        return 0
    fi
    if [ -z "$deployed" ]; then
        log_verbose "No deployed .env found — skipping env sync (fresh install will create one)"
        return 0
    fi

    local missing_keys=()
    while IFS= read -r line; do
        # Skip comments and blank lines; pull KEY from KEY=VALUE.
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// }" ]] && continue
        local key="${line%%=*}"
        key="${key// }"
        [ -z "$key" ] && continue
        if ! grep -qE "^[[:space:]]*${key}=" "$deployed"; then
            missing_keys+=("$key")
        fi
    done < "$example"

    if [ ${#missing_keys[@]} -eq 0 ]; then
        log_verbose "Env keys are in sync"
        return 0
    fi

    # Build the appended block in a tmp file rather than a brace-group
    # redirect — log() inside `{ ... } >> "$deployed"` would write its
    # own output into the .env file, corrupting it. (Caught the hard
    # way: a poisoned .env crashed `docker compose` parse and required
    # operator intervention to recover.)
    local tmp_block
    tmp_block=$(mktemp)
    local key default_line value generated_keys=() todo_keys=()
    {
        echo ""
        echo "# === Added by update.sh on $(date '+%Y-%m-%d %H:%M:%S') ==="
        for key in "${missing_keys[@]}"; do
            default_line=$(grep -E "^[[:space:]]*${key}=" "$example" | head -1)
            value="${default_line#*=}"
            case "$key" in
                TOTP_ENCRYPTION_KEY)
                    if [[ "$value" == CHANGE_ME* ]] || [ -z "$value" ]; then
                        if command -v openssl &>/dev/null; then
                            value=$(openssl rand -hex 32)
                        else
                            value=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
                        fi
                        echo "${key}=${value}"
                        generated_keys+=("$key")
                    else
                        echo "${default_line}"
                    fi
                    ;;
                JWT_SECRET|SESSION_SECRET)
                    if [[ "$value" == CHANGE_ME* ]] || [ -z "$value" ]; then
                        value=$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9!@#$%^&*' | head -c 64)
                        echo "${key}=${value}"
                        generated_keys+=("$key")
                    else
                        echo "${default_line}"
                    fi
                    ;;
                *)
                    # Non-secret: copy the example line verbatim. The review
                    # marker goes on its OWN line ABOVE the key — never inline.
                    # An inline `KEY=value  # note` is stripped by dotenv but
                    # NOT by docker-compose env_file / systemd EnvironmentFile,
                    # which load the raw line into the environment first; dotenv
                    # then leaves the already-set (polluted) value alone. For an
                    # empty-valued key that turned `MOCK2_PUBLIC_IP=` into a
                    # literal `# TODO: review` value and broke domain verification.
                    echo "# TODO: review — appended by update.sh from .env.example"
                    echo "${default_line}"
                    todo_keys+=("$key")
                    ;;
            esac
        done
    } > "$tmp_block"

    cat "$tmp_block" >> "$deployed"
    rm -f "$tmp_block"

    log "${YELLOW}Synced ${#missing_keys[@]} new environment variable(s) into ${deployed}:${NC}"
    if [ ${#generated_keys[@]} -gt 0 ]; then
        for key in "${generated_keys[@]}"; do
            log "  - ${key} (auto-generated secret)"
        done
    fi
    if [ ${#todo_keys[@]} -gt 0 ]; then
        for key in "${todo_keys[@]}"; do
            log "  - ${key} (placeholder — review before next restart)"
        done
    fi
}

# Set KEY=VALUE in the deployed .env: replace the first matching line in
# place, or append the key if it is absent. Used by the --enable-mock2 flag
# to flip an existing MOCK2_ENABLED=false to true on an upgrade (sync_env_keys
# never changes an existing value, so an operator who wants to enable a module
# on a running host needs this explicit opt-in). Preserves the rest of the file
# and, like sync_env_keys, writes via a tmp file rather than sed -i (portable
# across GNU/BSD, and avoids any brace-redirect corruption).
set_env_key() {
    local key="$1" value="$2" deployed
    deployed="$(resolve_env_path)"
    if [ -z "$deployed" ]; then
        log_verbose "No deployed .env found — cannot set ${key}"
        return 1
    fi
    if grep -qE "^[[:space:]]*${key}=" "$deployed"; then
        local tmp
        tmp=$(mktemp)
        awk -v k="$key" -v v="$value" '
            !done && $0 ~ ("^[[:space:]]*" k "=") { print k "=" v; done=1; next }
            { print }
        ' "$deployed" > "$tmp" && cat "$tmp" > "$deployed"
        rm -f "$tmp"
    else
        printf '\n%s=%s\n' "$key" "$value" >> "$deployed"
    fi
}

# ensure_mock2_infra: make the host-side prerequisites for the Mock2 module
# present + correct. Idempotent, best-effort. Called on EVERY update when Mock2
# is enabled (self-healing), and by --enable-mock2. Covers the two things that
# live outside the container image: the /etc/caddy/mock2 bind-mount and retiring
# the legacy squid egress proxy (Mock2 now uses the bridge NAT + nftables logging).
ensure_mock2_infra() {
    local deployed="$1"
    [ -n "$deployed" ] || return 0

    # Caddy dir + bind-mount: the backend writes one site file per parent domain
    # to /etc/caddy/mock2; without the mount those files never reach the host
    # Caddy and domain verification hangs at "cert pending".
    install -d -m 0755 /etc/caddy/mock2 2>/dev/null || true
    local compose; compose="$(dirname "$deployed")/docker-compose.yml"
    if [ -f "$compose" ] && ! grep -q '/etc/caddy/mock2:/etc/caddy/mock2' "$compose"; then
        if sed -i '\#Caddyfile:/etc/caddy/Caddyfile#a\      - /etc/caddy/mock2:/etc/caddy/mock2' "$compose" 2>/dev/null \
           && grep -q '/etc/caddy/mock2:/etc/caddy/mock2' "$compose"; then
            log "${GREEN}Added /etc/caddy/mock2 bind-mount to ${compose}.${NC}"
        else
            log "${YELLOW}Could not auto-add the /etc/caddy/mock2 bind-mount to ${compose}.${NC}"
            log "${YELLOW}Add this under the proxypilot service 'volumes:' + re-run 'docker compose up -d':${NC}"
            log "      - /etc/caddy/mock2:/etc/caddy/mock2"
        fi
    fi

    # Mock2 egress (M4/ADR-010 — post-squid): project containers reach the
    # internet via their bridge's Incus NAT; the nftables fence logs + contains
    # egress. squid is no longer used — retire a leftover/broken squid the old
    # build installed. Idempotent; a no-op on a host that never had squid.
    local egress_script="${SCRIPT_DIR}/scripts/mock2-egress-cleanup.sh"
    if [ -f "$egress_script" ]; then
        install -d -m 0700 /var/lib/proxypilot/mock2 2>/dev/null || true
        if bash "$egress_script" >>"$LOG_FILE" 2>&1; then
            log_verbose "Mock2 legacy squid retired (or already absent)."
        else
            log "${YELLOW}Mock2 squid cleanup reported an issue (non-fatal). See: sudo bash ${egress_script}${NC}"
        fi
    fi
}

# On every update, keep an ENABLED host's Mock2 infra in sync (squid + Caddy
# mount) so operators don't have to remember to re-run the enable script.
sync_mock2_infra() {
    local deployed; deployed="$(resolve_env_path)"
    [ -n "$deployed" ] || return 0
    local enabled; enabled="$(grep -E '^[[:space:]]*MOCK2_ENABLED=' "$deployed" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
    [ "$enabled" = "true" ] || return 0
    ensure_mock2_infra "$deployed"
}

# retrofit_smoke_browser: make the Mock2 browser smoke connector RUNNABLE and
# re-enable it. Historically SMOKE_BROWSER_ENABLED got set to 0/false because
# the connector could never run (playwright wasn't a dependency and no Chromium
# was installed) and enabled-but-unrunnable fails builds. This version ships
# playwright-core in admin/backend/package.json and Chromium in the Docker
# image; host (non-Docker) deployments get Chromium via apt here. Idempotent,
# best-effort — the dashboard toggle (Admin queue → Browser verification)
# overrides the env value either way.
retrofit_smoke_browser() {
    local deployed; deployed="$(resolve_env_path)"
    [ -n "$deployed" ] || return 0

    # Host (non-Docker) deployments run playwright on the host — install a
    # system Chromium if none is present. Docker deployments (compose file next
    # to the .env — same heuristic as ensure_mock2_infra; IS_DOCKER_DEPLOY is
    # computed later in the script) get Chromium from the image rebuild
    # (admin/Dockerfile apk list) and skip the host install.
    local compose_probe; compose_probe="$(dirname "$deployed")/docker-compose.yml"
    if [ ! -f "$compose_probe" ]; then
        if ! command -v chromium &>/dev/null && ! command -v chromium-browser &>/dev/null; then
            if command -v apt-get &>/dev/null; then
                log "Installing Chromium for the Mock2 browser verification check…"
                if apt-get install -y chromium >>"$LOG_FILE" 2>&1 || apt-get install -y chromium-browser >>"$LOG_FILE" 2>&1; then
                    log "${GREEN}Chromium installed (browser verification can run).${NC}"
                else
                    log "${YELLOW}Could not install Chromium automatically — browser verification will report 'not ready' until you install it (apt-get install chromium) or set SMOKE_BROWSER_EXECUTABLE.${NC}"
                fi
            fi
        fi
    fi

    # Re-enable the connector in .env if a previous install turned it off to
    # avoid unrunnable-check failures. The operator can turn it back off from
    # the dashboard (which wins over this value) or by editing .env again.
    local current
    current="$(grep -E '^[[:space:]]*SMOKE_BROWSER_ENABLED=' "$deployed" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
    case "$current" in
        0|false|no|off)
            set_env_key "SMOKE_BROWSER_ENABLED" "true"
            log "${GREEN}Browser verification re-enabled (SMOKE_BROWSER_ENABLED=true) — it is now installable and runnable. Toggle it anytime under Admin queue → Browser verification.${NC}"
            ;;
    esac
}

# --enable-mock2: opt an upgrading host into the Mock2 dev/build module.
# Runs after sync_env_keys so the key exists (as false) before we flip it.
maybe_enable_mock2() {
    [ "$ENABLE_MOCK2" = true ] || return 0
    local deployed pin_file="/etc/proxypilot/mock2.production.pin"
    deployed="$(resolve_env_path)"
    if [ -z "$deployed" ]; then
        log "${YELLOW}--enable-mock2: no deployed .env found; skipping.${NC}"
        return 0
    fi
    set_env_key "MOCK2_ENABLED" "true"
    log "${GREEN}Mock2 dev/build module enabled (MOCK2_ENABLED=true in ${deployed}).${NC}"

    ensure_mock2_infra "$deployed"

    if [ -f "$pin_file" ]; then
        log "${YELLOW}Note: production pin ${pin_file} is present — Mock2 stays OFF at runtime until it is removed.${NC}"
    fi
    log "${CYAN}The 'Projects' section appears for admin users once the restart completes.${NC}"
}

resolve_db_path() {
    # Prefer DATABASE_PATH if set in env. Otherwise look in known install
    # locations. Returns the path on stdout, empty string if nothing found.
    # Both new (data/db/proxypilot.db) and legacy (data/proxypilot.db)
    # layouts are checked so resolve_db_path stays useful before AND
    # after migrate_db_layout has run.
    if [ -n "${DATABASE_PATH:-}" ] && [ -f "$DATABASE_PATH" ]; then
        echo "$DATABASE_PATH"
        return
    fi
    for candidate in \
        "/opt/proxypilot/data/db/proxypilot.db" \
        "$SCRIPT_DIR/data/db/proxypilot.db" \
        "$(dirname "$SCRIPT_DIR")/data/db/proxypilot.db" \
        "/opt/proxypilot/data/proxypilot.db" \
        "$SCRIPT_DIR/data/proxypilot.db" \
        "$(dirname "$SCRIPT_DIR")/data/proxypilot.db"; do
        if [ -f "$candidate" ]; then
            echo "$candidate"
            return
        fi
    done
    echo ""
}

# Migrate from the legacy `data/proxypilot.db` layout to the new
# `data/db/proxypilot.db` layout. Idempotent: returns 0 immediately
# when nothing to do.
#
# The legacy layout chmod'd `data/` to 0700 (db.js getDb), which blocks
# Caddy (uid != root) from traversing into `data/services/<svc>/` — every
# static service site returns 403. Separating the DB into its own
# subdir lets `data/` go back to 0755 while `data/db/` stays 0700.
#
# Order:
#   1. Detect legacy layout (DB file directly under data/, no data/db/).
#   2. Make data/db/, set 0700.
#   3. Move DB + WAL + SHM into data/db/ (atomic per-file mv on the
#      same filesystem — open file descriptors held by the running
#      backend follow the inode, so this is safe even if the backend
#      hasn't been stopped yet).
#   4. Rewrite DATABASE_PATH in the deployed .env to the new path.
#   5. Loosen `data/` to 0755 so Caddy can traverse to services/.
#
# On failure between steps the originals stay where they were —
# DATABASE_PATH is rewritten LAST, so if anything before that fails
# the next backend boot still finds the DB at the legacy path.
migrate_db_layout() {
    local install_dir
    if [ -d "/opt/proxypilot" ] && [ -f "/opt/proxypilot/.env" ]; then
        install_dir="/opt/proxypilot"
    elif [ -f "$SCRIPT_DIR/.env" ]; then
        install_dir="$SCRIPT_DIR"
    elif [ -f "$(dirname "$SCRIPT_DIR")/.env" ]; then
        install_dir="$(dirname "$SCRIPT_DIR")"
    else
        log_verbose "migrate_db_layout: no deployed .env found, skipping"
        return 0
    fi

    local data_dir="$install_dir/data"
    local legacy_db="$data_dir/proxypilot.db"
    local new_dir="$data_dir/db"
    local new_db="$new_dir/proxypilot.db"
    local deployed_env="$install_dir/.env"

    # Already migrated, nothing to do.
    if [ -f "$new_db" ] && [ ! -f "$legacy_db" ]; then
        log_verbose "migrate_db_layout: already on new layout"
        return 0
    fi

    # Fresh install with neither DB present — let db.js create it in
    # the new location.
    if [ ! -f "$legacy_db" ]; then
        log_verbose "migrate_db_layout: no legacy DB at $legacy_db, nothing to migrate"
        return 0
    fi

    # Both files present means a partial migration on a previous run.
    # Refuse to clobber the new DB; require operator intervention.
    if [ -f "$legacy_db" ] && [ -f "$new_db" ]; then
        log "${RED}migrate_db_layout: BOTH ${legacy_db} and ${new_db} exist.${NC}"
        log "${RED}This usually means a previous migration crashed mid-run.${NC}"
        log "${RED}Inspect both DB files; keep the newer one; delete the other; re-run update.sh.${NC}"
        return 1
    fi

    log "${BLUE}[migrate] Separating SQLite DB from served-content directory${NC}"
    log "  Old: $legacy_db"
    log "  New: $new_db"

    mkdir -p "$new_dir" || { log "${RED}migrate_db_layout: mkdir $new_dir failed${NC}"; return 1; }
    chmod 0700 "$new_dir" 2>/dev/null || true

    if ! mv "$legacy_db" "$new_db"; then
        log "${RED}migrate_db_layout: failed to move $legacy_db -> $new_db${NC}"
        return 1
    fi
    [ -f "${legacy_db}-wal" ] && mv "${legacy_db}-wal" "${new_db}-wal" || true
    [ -f "${legacy_db}-shm" ] && mv "${legacy_db}-shm" "${new_db}-shm" || true

    # Migrate any pre-update DB backups that lived alongside the legacy
    # file (e.g. "proxypilot.db.backup-*") into the new dir as well —
    # they hold copies of full DB state and shouldn't end up world-
    # readable when we relax `data/` below.
    for backup in "$data_dir"/proxypilot.db.backup-*; do
        [ -f "$backup" ] || continue
        mv "$backup" "$new_dir/" 2>/dev/null || log_verbose "could not move $backup"
    done

    # Update DATABASE_PATH in the deployed .env. Whatever the existing
    # value (likely /data/proxypilot.db, possibly absolute), rewrite
    # the line to point at /data/db/proxypilot.db inside the container.
    if [ -f "$deployed_env" ]; then
        local tmp_env
        tmp_env=$(mktemp)
        # Preserve a sentinel so the awk script can tell whether the
        # key existed at all and append it if missing.
        awk '
          BEGIN { found = 0 }
          /^[[:space:]]*DATABASE_PATH=/ { print "DATABASE_PATH=/data/db/proxypilot.db"; found = 1; next }
          { print }
          END { if (!found) print "DATABASE_PATH=/data/db/proxypilot.db" }
        ' "$deployed_env" > "$tmp_env"
        cat "$tmp_env" > "$deployed_env"
        rm -f "$tmp_env"
        chmod 600 "$deployed_env" 2>/dev/null || true
        log "  Rewrote DATABASE_PATH in $deployed_env"
    else
        log "${YELLOW}migrate_db_layout: no .env at $deployed_env to update — backend may need DATABASE_PATH set manually${NC}"
    fi

    # Relax `data/` so Caddy can traverse it. The DB now lives in
    # `data/db/` which stays 0700; the live DB FILE itself is locked
    # to 0600 by db.js on every backend boot.
    chmod 0755 "$data_dir" 2>/dev/null || true

    log "${GREEN}migrate_db_layout: complete${NC}"
}

backup_db() {
    local db_path="$1"
    if [ -z "$db_path" ] || [ ! -f "$db_path" ]; then
        log_verbose "No existing database found — skipping backup"
        return 0
    fi
    local backup_dir
    backup_dir="$(dirname "$db_path")/backups"
    mkdir -p "$backup_dir"
    local ts
    ts=$(date +%Y%m%d-%H%M%S)
    local backup_file="${backup_dir}/proxypilot.db.pre-update-${ts}"

    # Copy main DB plus WAL/SHM if present so we can restore the exact state.
    cp "$db_path" "$backup_file"
    [ -f "${db_path}-wal" ] && cp "${db_path}-wal" "${backup_file}-wal"
    [ -f "${db_path}-shm" ] && cp "${db_path}-shm" "${backup_file}-shm"
    chmod 600 "$backup_file" "${backup_file}-wal" "${backup_file}-shm" 2>/dev/null || true

    DB_BACKUP_FILE="$backup_file"
    DB_BACKUP_SOURCE="$db_path"
    log "${GREEN}Database backed up to: ${backup_file}${NC}"

    # Rotate: keep most recent BACKUPS_TO_KEEP
    if command -v ls &>/dev/null; then
        ls -t "${backup_dir}"/proxypilot.db.pre-update-* 2>/dev/null \
            | grep -v '\-wal$\|\-shm$' \
            | tail -n +$((BACKUPS_TO_KEEP + 1)) \
            | while read -r old; do
                rm -f "$old" "${old}-wal" "${old}-shm"
                log_verbose "Pruned old backup: $old"
            done
    fi
}

restore_db() {
    if [ -z "$DB_BACKUP_FILE" ] || [ ! -f "$DB_BACKUP_FILE" ]; then
        log_verbose "No backup to restore"
        return 0
    fi
    if [ -z "$DB_BACKUP_SOURCE" ]; then
        log_verbose "No source path recorded — cannot restore"
        return 0
    fi
    log "${YELLOW}Restoring database from: ${DB_BACKUP_FILE}${NC}"
    # Guard each cp explicitly. If the restore itself fails, surface
    # the path the operator must hand-restore from rather than letting
    # the trap exit silently.
    if ! cp "$DB_BACKUP_FILE" "$DB_BACKUP_SOURCE"; then
        log "${RED}!! Restore failed copying ${DB_BACKUP_FILE} -> ${DB_BACKUP_SOURCE}${NC}"
        log "${RED}!! Hand-restore: cp \"$DB_BACKUP_FILE\" \"$DB_BACKUP_SOURCE\"${NC}"
        return 1
    fi
    [ -f "${DB_BACKUP_FILE}-wal" ] && cp "${DB_BACKUP_FILE}-wal" "${DB_BACKUP_SOURCE}-wal" || true
    [ -f "${DB_BACKUP_FILE}-shm" ] && cp "${DB_BACKUP_FILE}-shm" "${DB_BACKUP_SOURCE}-shm" || true
    log "${YELLOW}Database restored. Operator should investigate the failure before retrying.${NC}"
}

on_error() {
    local exit_code=$?
    log "${RED}Update failed (exit ${exit_code}). Attempting recovery...${NC}"
    restore_db

    # If we got far enough to set INSTALL_DIR (i.e. past npm install/build
    # and into the docker rebuild phase) AND there's a docker-compose.yml,
    # try to bring the OLD container back online. `docker compose build`
    # with --no-cache does NOT replace the existing image until the new
    # build succeeds, so on a build failure the previous image is still
    # tagged and `up -d` will restart with it.
    #
    # This closes the gap where a failed rebuild left the user actively
    # offline: down had succeeded, build failed, up -d never ran, and the
    # script just exited.
    if [ -n "${INSTALL_DIR:-}" ] && [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
        log "${YELLOW}Attempting to restart with the existing (pre-update) docker image...${NC}"
        local DC_CMD="docker compose"
        if ! docker compose version &>/dev/null; then
            DC_CMD="docker-compose"
        fi
        (cd "$INSTALL_DIR" && $DC_CMD up -d 2>&1 | tee -a "$LOG_FILE") || \
            log "${RED}Could not auto-restart. Manual: cd $INSTALL_DIR && $DC_CMD up -d${NC}"
    fi
    exit "$exit_code"
}

echo ""
log "${BLUE}========================================${NC}"
log "${BLUE}       ProxyPilot Update Script        ${NC}"
log "${BLUE}========================================${NC}"
log ""
log "Log file: $LOG_FILE"
log ""

# Check if running as root or with sudo for restart
if [ "$EUID" -ne 0 ] && [ "$SKIP_RESTART" = false ]; then
    log "${YELLOW}Note: Running without sudo. You may need sudo for restart.${NC}"
fi

# Find git
log_verbose "Looking for git..."
GIT_CMD=$(find_command git) || true
if [ -z "$GIT_CMD" ]; then
    log "${RED}Error: git is not installed${NC}"
    log "Please install git first:"
    log "  Ubuntu/Debian: sudo apt-get install git"
    log "  CentOS/RHEL: sudo yum install git"
    exit 1
fi
log_verbose "Found git: $GIT_CMD"

# Find npm
log_verbose "Looking for npm..."
NPM_CMD=$(find_command npm) || true
if [ -z "$NPM_CMD" ]; then
    log "${RED}Error: npm is not installed${NC}"
    log "Please install Node.js and npm first"
    exit 1
fi
log_verbose "Found npm: $NPM_CMD"

# Find node
log_verbose "Looking for node..."
NODE_CMD=$(find_command node) || true
if [ -z "$NODE_CMD" ]; then
    log "${RED}Error: node is not installed${NC}"
    log "Please install Node.js first"
    exit 1
fi
log_verbose "Found node: $NODE_CMD"

# Change to project directory
cd "$SCRIPT_DIR"
log_verbose "Working directory: $SCRIPT_DIR"

# Get current version
CURRENT_VERSION=$($NODE_CMD -p "require('./admin/backend/package.json').version" 2>/dev/null || echo "unknown")
log "Current version: ${YELLOW}v${CURRENT_VERSION}${NC}"
log ""

# Check for uncommitted changes
if [ -n "$($GIT_CMD status --porcelain 2>/dev/null)" ]; then
    log "${YELLOW}Warning: You have uncommitted changes${NC}"
    log "These files have local modifications:"
    $GIT_CMD status --short
    log ""
    read -p "Do you want to continue? This may cause merge conflicts. (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log "${RED}Update cancelled${NC}"
        exit 1
    fi
fi

# Backup the database before any code changes. From this point on, any
# error triggers on_error which restores the backup so a half-applied
# migration cannot brick the install.
#
# When this run was re-exec'd by the self-update bootstrap below, the
# pre-pull process already created the backup. Inherit its state via
# env vars instead of cutting a second backup.
if [ -n "${PROXYPILOT_DB_BACKUP_FILE:-}" ]; then
    DB_BACKUP_FILE="$PROXYPILOT_DB_BACKUP_FILE"
    DB_BACKUP_SOURCE="$PROXYPILOT_DB_BACKUP_SOURCE"
    log_verbose "Inherited DB backup state from pre-pull process: $DB_BACKUP_FILE"
else
    DB_PATH_FOUND="$(resolve_db_path)"
    log "${BLUE}[0/7] Backing up database...${NC}"
    backup_db "$DB_PATH_FOUND"
fi
trap 'on_error' ERR
trap 'log "${YELLOW}Update interrupted${NC}"; restore_db; exit 130' INT TERM

# Fetch latest changes
log "${BLUE}[1/7] Fetching latest changes...${NC}"
log_verbose "Running: $GIT_CMD fetch origin main"
if ! $GIT_CMD fetch origin main 2>&1 | tee -a "$LOG_FILE"; then
    log "${RED}Error: Failed to fetch from remote${NC}"
    exit 1
fi

# Check if there are updates
LOCAL=$($GIT_CMD rev-parse HEAD 2>/dev/null)
REMOTE=$($GIT_CMD rev-parse origin/main 2>/dev/null)
log_verbose "Local commit: $LOCAL"
log_verbose "Remote commit: $REMOTE"

if [ "$LOCAL" = "$REMOTE" ]; then
    if [ "$FORCE_REBUILD" = true ]; then
        log "${YELLOW}Code is up to date, but rebuilding as requested...${NC}"
    else
        log "${GREEN}Code is already up to date!${NC}"
        log ""
        read -p "Do you want to rebuild anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log "${BLUE}No changes made. Use --rebuild to force rebuild.${NC}"
            exit 0
        fi
    fi
else
    log "${BLUE}[2/7] Pulling latest code...${NC}"
    log_verbose "Running: $GIT_CMD pull origin main"
    if ! $GIT_CMD pull origin main 2>&1 | tee -a "$LOG_FILE"; then
        log "${RED}Error: Failed to pull from remote${NC}"
        exit 1
    fi

    # Self-update bootstrap. bash reads update.sh from disk in chunks;
    # any logic past this point that the git pull just changed (e.g.
    # the Docker-detection block at [4/7]) may still come from the
    # pre-pull copy in bash's read buffer. Re-exec the freshly-pulled
    # script so the new logic runs in the current session instead of
    # waiting for the operator's next manual run. Pass through the
    # backup state and force --rebuild so the re-exec'd run doesn't
    # bail on LOCAL==REMOTE or duplicate the DB backup.
    if [ -z "${PROXYPILOT_UPDATE_REEXEC:-}" ]; then
        # Decide the docker build cache mode for the re-exec'd run. A from-scratch
        # (--no-cache) rebuild is only needed when a dependency/toolchain file
        # changed — the backend package manifest/lockfile or the Dockerfile —
        # because those invalidate the native better-sqlite3/node-pty compile.
        # When this pull only touched frontend or backend src, the cached build
        # reuses the compiled node_modules layer and finishes in seconds (the COPY
        # layers for the new dist/src are checksum-keyed, so they still refresh).
        # Computed HERE (in SCRIPT_DIR, the git checkout, with $LOCAL still the
        # pre-pull commit) and passed to the re-exec; unset ⇒ conservative no-cache.
        if $GIT_CMD diff --name-only "$LOCAL" HEAD 2>/dev/null \
            | grep -Eq '^(admin/backend/package\.json|admin/backend/package-lock\.json|admin/Dockerfile)$'; then
            export PROXYPILOT_DEP_CHANGED=1
        else
            export PROXYPILOT_DEP_CHANGED=0
        fi
        export PROXYPILOT_UPDATE_REEXEC=1
        export PROXYPILOT_DB_BACKUP_FILE="$DB_BACKUP_FILE"
        export PROXYPILOT_DB_BACKUP_SOURCE="$DB_BACKUP_SOURCE"
        log_verbose "Re-executing update.sh with the freshly-pulled version"
        exec bash "$SCRIPT_DIR/update.sh" --rebuild "$@"
    fi
fi

# After pulling, sync .env against the new version's .env.example. Any
# newly-introduced keys are appended to the deployed .env with a TODO
# marker so the operator notices them before the next restart.
sync_env_keys

# Honor --enable-mock2 (after sync_env_keys, so the key exists to flip).
maybe_enable_mock2
# Keep an already-enabled host's Mock2 host-side infra (Caddy mount + squid cleanup) in
# sync on every update, so it self-heals without needing --enable-mock2.
sync_mock2_infra
# Browser smoke connector: it used to be unrunnable (playwright was never a
# dependency and no Chromium was installed), so installs disabled it in .env to
# stop builds failing "unavailable". This version bundles playwright-core (npm
# dep) + Chromium (Docker image apk / host apt below), so RE-ENABLE it — the
# dashboard toggle (Admin queue → Browser verification) is the operator's
# switch from here on and overrides the env either way.
retrofit_smoke_browser

# Get new version
NEW_VERSION=$($NODE_CMD -p "require('./admin/backend/package.json').version" 2>/dev/null || echo "unknown")
if [ "$LOCAL" != "$REMOTE" ]; then
    log "New version: ${GREEN}v${NEW_VERSION}${NC}"
fi
log ""

# Check and install Incus if not present
log "${BLUE}[3/7] Checking Incus installation...${NC}"
if command -v incus &> /dev/null; then
    log "${GREEN}Incus is already installed ($(incus version 2>/dev/null || echo 'unknown'))${NC}"
else
    log "${YELLOW}Incus is not installed. Installing...${NC}"

    if [ "$EUID" -ne 0 ]; then
        log "${YELLOW}Note: Installing Incus requires root privileges. Attempting with sudo...${NC}"
    fi

    # Try installing from default repos first (Ubuntu 24.04+, Debian Trixie+)
    INSTALL_CMD="apt-get"
    if [ "$EUID" -ne 0 ]; then
        INSTALL_CMD="sudo apt-get"
    fi

    $INSTALL_CMD update -y 2>&1 | tee -a "$LOG_FILE"
    if $INSTALL_CMD install -y incus 2>/dev/null; then
        log "${GREEN}Incus installed from default repositories${NC}"
    else
        # Fall back to Zabbly repository
        log "Adding Zabbly repository for Incus..."

        SUDO_CMD=""
        if [ "$EUID" -ne 0 ]; then
            SUDO_CMD="sudo"
        fi

        $SUDO_CMD mkdir -p /etc/apt/keyrings/
        curl -fsSL https://pkgs.zabbly.com/key.asc | $SUDO_CMD gpg --dearmor -o /etc/apt/keyrings/zabbly.gpg

        CODENAME=$(. /etc/os-release && echo "${VERSION_CODENAME}")

        $SUDO_CMD tee /etc/apt/sources.list.d/zabbly-incus-stable.sources > /dev/null <<REPOEOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: ${CODENAME}
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.gpg
REPOEOF

        $INSTALL_CMD update -y 2>&1 | tee -a "$LOG_FILE"
        if ! $INSTALL_CMD install -y incus 2>&1 | tee -a "$LOG_FILE"; then
            log "${RED}Failed to install Incus. LXC container features will not be available.${NC}"
            log "${YELLOW}You can install manually: sudo apt install incus${NC}"
        else
            log "${GREEN}Incus installed from Zabbly repository${NC}"
        fi
    fi

    # Enable and start Incus if installed
    if command -v incus &> /dev/null; then
        $SUDO_CMD systemctl enable incus 2>/dev/null || true
        $SUDO_CMD systemctl start incus 2>/dev/null || true

        # Minimal initialization if not already set up
        if ! incus storage list --format json 2>/dev/null | grep -q '"name"'; then
            log "Initializing Incus with minimal configuration..."
            $SUDO_CMD incus admin init --minimal 2>&1 | tee -a "$LOG_FILE" || true
        fi

        log "${GREEN}Incus is ready ($(incus version 2>/dev/null))${NC}"
    fi
fi
log ""

# Phase A host-side agent — in-place migration on existing deploys.
#
# install.sh installs the agent on fresh boxes; update.sh's job is to
# bring an existing install up to the same posture. Five idempotent
# steps:
#
#   1. Install Go (>= AGENT_GO_VERSION) if missing or too old.
#   2. Create proxypilot-agent system user + group if missing.
#   3. Build /usr/local/bin/proxypilot-agent from cmd/agent/.
#   4. Install + enable the systemd unit, restart on binary refresh.
#   5. Patch the deployed docker-compose.yml to add the socket bind
#      mount, group_add, and PROXYPILOT_AGENT_SOCKET env var. Step 5
#      runs further down where INSTALL_DIR is known.
#
# Phase A is dual-track: nothing in the dashboard's production code
# path actually calls the agent yet. The migration is a scaffold so
# Phases B-E can flip individual operations onto the agent behind
# feature flags without touching the deploy mechanics.
log "${BLUE}[3.5/7] Installing host-side agent (Phase A scaffold)...${NC}"

AGENT_GO_VERSION="1.21.13"

# Detect installed Go version (system PATH first, then /usr/local/go).
# Returns empty string if absent.
agent_detect_go_version() {
    local raw
    if raw=$(go version 2>/dev/null); then
        echo "$raw" | awk '{print $3}' | sed 's/^go//'
    elif raw=$(/usr/local/go/bin/go version 2>/dev/null); then
        echo "$raw" | awk '{print $3}' | sed 's/^go//'
    else
        echo ""
    fi
}

# Returns 0 if $1 (have) >= $2 (want), 1 otherwise.
agent_go_ge() {
    local have="$1" want="$2"
    [[ -z "$have" ]] && return 1
    if [[ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -n1)" == "$want" ]]; then
        return 0
    fi
    return 1
}

agent_resolve_go_bin() {
    if command -v go >/dev/null 2>&1; then
        command -v go
    elif [[ -x /usr/local/go/bin/go ]]; then
        echo "/usr/local/go/bin/go"
    else
        echo ""
    fi
}

# 1. Toolchain.
CURRENT_GO=$(agent_detect_go_version)
if agent_go_ge "$CURRENT_GO" "$AGENT_GO_VERSION"; then
    log "${GREEN}Go ${CURRENT_GO} already installed (>= ${AGENT_GO_VERSION})${NC}"
else
    log "${YELLOW}Installing Go ${AGENT_GO_VERSION} for proxypilot-agent build...${NC}"
    case "$(uname -m)" in
        x86_64|amd64) GO_ARCH="amd64" ;;
        aarch64|arm64) GO_ARCH="arm64" ;;
        armv7l|armv6l) GO_ARCH="armv6l" ;;
        *) log "${RED}Unsupported architecture for Go install: $(uname -m)${NC}"; exit 1 ;;
    esac
    GO_TARBALL="go${AGENT_GO_VERSION}.linux-${GO_ARCH}.tar.gz"
    GO_TMPDIR=$(mktemp -d)
    if ! curl -fsSL -o "${GO_TMPDIR}/${GO_TARBALL}" "https://go.dev/dl/${GO_TARBALL}" 2>&1 | tee -a "$LOG_FILE"; then
        log "${RED}Failed to download Go tarball${NC}"
        rm -rf "$GO_TMPDIR"
        exit 1
    fi
    rm -rf /usr/local/go
    tar -C /usr/local -xzf "${GO_TMPDIR}/${GO_TARBALL}"
    rm -rf "$GO_TMPDIR"
    INSTALLED_GO=$(agent_detect_go_version)
    if ! agent_go_ge "$INSTALLED_GO" "$AGENT_GO_VERSION"; then
        log "${RED}Go installation appears to have failed (detected: '${INSTALLED_GO}')${NC}"
        exit 1
    fi
    log "${GREEN}Go ${INSTALLED_GO} installed at /usr/local/go${NC}"
fi
GO_BIN=$(agent_resolve_go_bin)
if [[ -z "$GO_BIN" ]]; then
    log "${RED}Go toolchain not found after install; refusing to continue${NC}"
    exit 1
fi

# 2. System user + group.
if ! getent group proxypilot-agent >/dev/null 2>&1; then
    groupadd --system proxypilot-agent
    log "Created system group: proxypilot-agent"
fi
if ! getent passwd proxypilot-agent >/dev/null 2>&1; then
    useradd --system --gid proxypilot-agent --no-create-home \
        --home-dir /nonexistent --shell /usr/sbin/nologin \
        proxypilot-agent
    log "Created system user: proxypilot-agent"
fi

# 3. Build the binary from the source tree we just pulled.
AGENT_SRC="${SCRIPT_DIR}/cmd/agent"
if [[ ! -d "$AGENT_SRC" ]]; then
    log "${YELLOW}cmd/agent not found at ${AGENT_SRC}; this build of update.sh predates Phase A — skipping agent install${NC}"
else
    log "Building proxypilot-agent..."
    (
        cd "$AGENT_SRC"
        GOFLAGS=-mod=mod "$GO_BIN" build -o /usr/local/bin/proxypilot-agent .
    )
    chmod 0755 /usr/local/bin/proxypilot-agent
    log "${GREEN}Agent binary at /usr/local/bin/proxypilot-agent${NC}"

    # 4. Systemd unit.
    UNIT_SRC="${SCRIPT_DIR}/deploy/proxypilot-agent.service"
    UNIT_DST="/etc/systemd/system/proxypilot-agent.service"
    if [[ ! -f "$UNIT_SRC" ]]; then
        log "${YELLOW}Missing systemd unit at ${UNIT_SRC}${NC}"
    else
        if ! cmp -s "$UNIT_SRC" "$UNIT_DST" 2>/dev/null; then
            cp "$UNIT_SRC" "$UNIT_DST"
            chmod 0644 "$UNIT_DST"
            systemctl daemon-reload
            log "Installed systemd unit: ${UNIT_DST}"
        fi
        if ! systemctl is-enabled --quiet proxypilot-agent 2>/dev/null; then
            systemctl enable proxypilot-agent 2>&1 | tee -a "$LOG_FILE"
        fi
        # Restart so the freshly-built binary is the running one.
        systemctl restart proxypilot-agent
        log "${GREEN}proxypilot-agent service running${NC}"
    fi
fi
log ""

# Detect Docker deployment so we can skip the host-side backend npm
# install. node-pty's prebuild falls back to node-gyp rebuild on hosts
# without make/g++, which prints a noisy gyp ERR! block even though the
# Dockerfile's alpine builder does its own `npm install --omit=dev`
# with python3+make+g++ available. Frontend deps still install on the
# host because vite build runs there.
IS_DOCKER_DEPLOY=false
for candidate in "/opt/proxypilot" "$SCRIPT_DIR" "$(dirname "$SCRIPT_DIR")"; do
    if [[ -f "${candidate}/docker-compose.yml" ]] && grep -q proxypilot "${candidate}/docker-compose.yml" 2>/dev/null; then
        IS_DOCKER_DEPLOY=true
        break
    fi
done

# Install backend dependencies
log "${BLUE}[4/7] Installing backend dependencies...${NC}"
if [ "$IS_DOCKER_DEPLOY" = "true" ]; then
    log "Docker deployment detected — skipping host-side backend npm install (Dockerfile installs deps in alpine builder)"
else
    cd "$BACKEND_DIR"
    log_verbose "Running: $NPM_CMD install in $BACKEND_DIR"
    if ! $NPM_CMD install 2>&1 | tee -a "$LOG_FILE"; then
        log "${RED}Error: Failed to install backend dependencies${NC}"
        exit 1
    fi
fi

# Install frontend dependencies
log "${BLUE}[5/7] Installing frontend dependencies...${NC}"
cd "$FRONTEND_DIR"
log_verbose "Running: $NPM_CMD install in $FRONTEND_DIR"
# Same PIPESTATUS-vs-tee gotcha as the build step below: `if ! cmd | tee`
# checks tee's exit code, not npm's, so a failed install would silently
# proceed to a build that's missing dependencies.  Use PIPESTATUS to
# read the real npm exit code.
$NPM_CMD install 2>&1 | tee -a "$LOG_FILE"
install_status=${PIPESTATUS[0]}
if [[ "$install_status" -ne 0 ]]; then
    log "${RED}Error: Failed to install frontend dependencies (npm exit ${install_status})${NC}"
    exit 1
fi

# Build frontend
log "${BLUE}[6/7] Building frontend...${NC}"
log_verbose "Running: $NPM_CMD run build in $FRONTEND_DIR"
# `if ! cmd | tee` evaluates the pipeline's last exit code — tee almost
# always exits 0, so an `npm run build` failure (e.g. a vite resolve
# error) gets silently swallowed and the rebuild proceeds with a stale
# admin/frontend/dist/.  An operator then sees a successful Docker
# image build that ships the previous version's UI.  Use PIPESTATUS to
# check npm's actual exit code instead.
$NPM_CMD run build 2>&1 | tee -a "$LOG_FILE"
build_status=${PIPESTATUS[0]}
if [[ "$build_status" -ne 0 ]]; then
    log "${RED}Error: Failed to build frontend (npm exit ${build_status})${NC}"
    log "${RED}Refusing to continue — Docker rebuild would copy a stale dist/${NC}"
    log "${RED}into the image, shipping the previous version's UI even though${NC}"
    log "${RED}the container would appear healthy.  Fix the build error above${NC}"
    log "${RED}and rerun update.sh.${NC}"
    exit 1
fi
if [[ ! -f "$FRONTEND_DIR/dist/index.html" ]]; then
    log "${RED}Error: build reported success but $FRONTEND_DIR/dist/index.html is missing${NC}"
    exit 1
fi

# Return to project root
cd "$SCRIPT_DIR"

# ── ProxyPilot CLI + firewall manager refresh ──────────────────────────
# update.sh runs in-place under SCRIPT_DIR (typically /opt/proxypilot).
# We refresh CLI deps, re-emit the /usr/local/bin/proxypilot wrapper to
# point at the current source tree, and re-run install-firewall.sh to
# ensure the latest unit files are in place. install-firewall.sh is
# idempotent: it overwrites the unit files, runs daemon-reload, and
# restarts the timers. It also runs `proxypilot firewall reconcile`,
# which is a no-op when state and live are already in sync.
if [[ -d "$SCRIPT_DIR/cli" ]]; then
    log "${BLUE}Refreshing ProxyPilot CLI...${NC}"
    cd "$SCRIPT_DIR/cli"
    if ! $NPM_CMD install --omit=dev --silent 2>&1 | tee -a "$LOG_FILE"; then
        log "${YELLOW}Warning: CLI dep install reported issues — see $LOG_FILE${NC}"
    fi
    cat > /usr/local/bin/proxypilot <<EOF
#!/bin/sh
exec /usr/bin/env node "${SCRIPT_DIR}/cli/bin/proxypilot.js" "\$@"
EOF
    chmod 0755 /usr/local/bin/proxypilot
    cd "$SCRIPT_DIR"

    if [[ -x "$SCRIPT_DIR/scripts/install-firewall.sh" ]]; then
        log "${BLUE}Refreshing host firewall units...${NC}"
        if ! PROXYPILOT_BIN=/usr/local/bin/proxypilot \
            "$SCRIPT_DIR/scripts/install-firewall.sh" 2>&1 | tee -a "$LOG_FILE"; then
            log "${YELLOW}Warning: firewall refresh reported issues — see $LOG_FILE${NC}"
        fi
    fi

    if [[ -x "$SCRIPT_DIR/scripts/install-vpn.sh" ]]; then
        log "${BLUE}Refreshing WireGuard prerequisites...${NC}"
        if ! "$SCRIPT_DIR/scripts/install-vpn.sh" 2>&1 | tee -a "$LOG_FILE"; then
            log "${YELLOW}Warning: VPN prereq refresh reported issues — see $LOG_FILE${NC}"
        fi
    fi

    # Docker on Debian 13 / Ubuntu 24.04+ (Linux 6.x): the kernel no
    # longer auto-loads br_netfilter, which Docker's default bridge
    # networking depends on.  Operators who installed ProxyPilot
    # before the install.sh fix landed see docker.service fail on
    # boot with a cryptic 'bridge: filtering via arp/ip/ip6tables
    # is no longer available by default' kernel hint.  Self-heal
    # here so an `update.sh` run picks them up retroactively.
    if [[ ! -f /etc/modules-load.d/proxypilot-docker.conf ]]; then
        log "${BLUE}Pinning Docker kernel modules (br_netfilter, overlay)...${NC}"
        cat > /etc/modules-load.d/proxypilot-docker.conf <<'KMODS'
# Loaded by ProxyPilot's update.sh — Docker's default bridge
# networking needs br_netfilter; the overlay storage driver needs
# overlay.  Linux 6.x removed automatic loading; we pin them here.
br_netfilter
overlay
KMODS
        modprobe br_netfilter 2>/dev/null || \
            log "${YELLOW}Warning: br_netfilter modprobe failed — reboot recommended${NC}"
        modprobe overlay 2>/dev/null || true
        # If docker.service is currently in failed state, try to
        # bring it back up now that the modules are loaded.  Ignore
        # systemctl exit codes; a failed start here just means the
        # operator will see the same error they were seeing before
        # the update + a reboot will pick up the persisted modules.
        if systemctl is-failed --quiet docker 2>/dev/null; then
            log "${BLUE}Restarting docker.service (was in failed state)...${NC}"
            systemctl reset-failed docker 2>/dev/null || true
            systemctl start docker 2>/dev/null || \
                log "${YELLOW}docker.service failed to start; reboot to apply module changes${NC}"
        fi
    fi

    if [[ -x "$SCRIPT_DIR/scripts/install-ssh-access.sh" ]]; then
        log "${BLUE}Refreshing SSH access manager...${NC}"
        if ! PROXYPILOT_BIN=/usr/local/bin/proxypilot \
            PROXYPILOT_INSTALL_DIR="$SCRIPT_DIR" \
            "$SCRIPT_DIR/scripts/install-ssh-access.sh" 2>&1 | tee -a "$LOG_FILE"; then
            log "${YELLOW}Warning: SSH access refresh reported issues — see $LOG_FILE${NC}"
        fi
    fi
fi

log ""
log "${GREEN}========================================${NC}"
log "${GREEN}       Update completed successfully!   ${NC}"
log "${GREEN}========================================${NC}"
log ""
if [ "$LOCAL" != "$REMOTE" ]; then
    log "Updated from ${YELLOW}v${CURRENT_VERSION}${NC} to ${GREEN}v${NEW_VERSION}${NC}"
else
    log "Rebuilt version ${GREEN}v${NEW_VERSION}${NC}"
fi
log ""

# Restart
if [ "$SKIP_RESTART" = true ]; then
    log "${YELLOW}Skipping restart (--no-restart specified)${NC}"
    log "Run manually: sudo $SCRIPT_DIR/restart.sh"
else
    log "${BLUE}[7/7] Restarting ProxyPilot...${NC}"
    log ""

    # Check if running via Docker - check multiple possible locations.
    # INSTALL_DIR is a global (declared near the top) so on_error can see
    # it and attempt to restart the old container after a failed rebuild.
    for candidate in "/opt/proxypilot" "$SCRIPT_DIR" "$(dirname "$SCRIPT_DIR")"; do
        if [[ -f "${candidate}/docker-compose.yml" ]] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q proxypilot-admin; then
            INSTALL_DIR="$candidate"
            break
        fi
        # Also check if docker-compose.yml exists even if container isn't running
        if [[ -f "${candidate}/docker-compose.yml" ]] && grep -q proxypilot "${candidate}/docker-compose.yml" 2>/dev/null; then
            INSTALL_DIR="$candidate"
            break
        fi
    done

    if [[ -n "$INSTALL_DIR" ]]; then
        log "Detected Docker deployment at ${INSTALL_DIR}"

        # Copy updated admin files to install directory (if running from a different dir)
        if [[ "$SCRIPT_DIR" != "$INSTALL_DIR" ]]; then
            log "Copying updated files from ${SCRIPT_DIR} to ${INSTALL_DIR}..."
            cp -r "${SCRIPT_DIR}/admin" "${INSTALL_DIR}/"
            # CVE engine package — the new admin/Dockerfile COPYs
            # proxypilot/ from the build context, so it must live
            # alongside admin/ in the install dir. install.sh already
            # copies it on fresh installs; this catches existing
            # installs being upgraded.
            if [[ -d "${SCRIPT_DIR}/proxypilot" ]]; then
                rm -rf "${INSTALL_DIR}/proxypilot"
                cp -r "${SCRIPT_DIR}/proxypilot" "${INSTALL_DIR}/"
            fi
            # Operator scripts (scripts/mock2-enable-egress.sh, patch helpers) —
            # deploy them to the install root so the `run scripts/…` guidance in
            # logs/UI errors resolves on the host. Refresh so a re-run picks up
            # fixes (e.g. the http_port sanitizer).
            if [[ -d "${SCRIPT_DIR}/scripts" ]]; then
                rm -rf "${INSTALL_DIR}/scripts"
                cp -r "${SCRIPT_DIR}/scripts" "${INSTALL_DIR}/"
                chmod +x "${INSTALL_DIR}"/scripts/*.sh 2>/dev/null || true
            fi
        fi

        # In-place migration of the deployed docker-compose.yml: the
        # B1 cap-drop refactor (cap_drop:ALL + cap_add:[SYS_ADMIN,
        # SYS_PTRACE] + security_opt) didn't actually reduce the
        # attack surface (pid:host + docker.sock = privileged-
        # equivalent regardless) and surfaced a long tail of
        # AppArmor/seccomp edge cases that broke nsenter on real
        # deploys. Restore `privileged: true` for installs that have
        # the buggy block. Idempotent: skips if `privileged: true` is
        # already present.
        COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"

        # Strip the obsolete `version: '3.x'` key — it's been
        # ignored since Compose v2 and recent compose CLIs warn on
        # every invocation ("the attribute `version` is obsolete,
        # it will be ignored, please remove it to avoid potential
        # confusion"). Idempotent: only fires when the line is
        # actually present.
        if [ -f "$COMPOSE_FILE" ] && grep -qE "^version:[[:space:]]*['\"]?[0-9.]+['\"]?[[:space:]]*$" "$COMPOSE_FILE"; then
            log "${YELLOW}Patching docker-compose.yml: removing obsolete \`version:\` key${NC}"
            sed -i -E "/^version:[[:space:]]*['\"]?[0-9.]+['\"]?[[:space:]]*$/d" "$COMPOSE_FILE"
            log "${GREEN}docker-compose.yml: \`version\` key removed${NC}"
        fi

        # CVE engine migration. The Dockerfile now expects the install
        # root as its build context (so it can COPY both admin/ and
        # proxypilot/), and the production stage carries the engine's
        # Python deps + nsenter for the host pivot. Existing compose
        # files have:
        #     context: ./admin
        #     dockerfile: Dockerfile
        # Rewrite to:
        #     context: .
        #     dockerfile: admin/Dockerfile
        # Idempotent — only fires when the old shape is present.
        if [ -f "$COMPOSE_FILE" ] && grep -qE "^[[:space:]]+context:[[:space:]]+\./admin[[:space:]]*$" "$COMPOSE_FILE"; then
            log "${YELLOW}Patching docker-compose.yml: build context for new admin/Dockerfile${NC}"
            sed -i -E \
                -e "s#^([[:space:]]+)context:[[:space:]]+\./admin[[:space:]]*\$#\\1context: .#" \
                -e "s#^([[:space:]]+)dockerfile:[[:space:]]+Dockerfile[[:space:]]*\$#\\1dockerfile: admin/Dockerfile#" \
                "$COMPOSE_FILE"
            log "${GREEN}docker-compose.yml: build context migrated to install root${NC}"
        fi

        # Inbox bind-mount — required so the dashboard listing endpoint
        # can read /var/lib/proxypilot/cve-inbox/ entries authored on
        # the host. Idempotent: only adds if missing.
        if [ -f "$COMPOSE_FILE" ] && ! grep -qE "/var/lib/proxypilot:/var/lib/proxypilot" "$COMPOSE_FILE"; then
            if grep -qE "/var/run/docker.sock:/var/run/docker.sock" "$COMPOSE_FILE"; then
                log "${YELLOW}Patching docker-compose.yml: adding /var/lib/proxypilot bind mount${NC}"
                # Insert the inbox mount right after the docker.sock
                # mount so it ends up grouped with the other host-shared
                # volumes. sed -i with literal newline via $'\n' on
                # GNU sed.
                sed -i -E \
                    "/^[[:space:]]+- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock[[:space:]]*\$/a\\
      - /var/lib/proxypilot:/var/lib/proxypilot" \
                    "$COMPOSE_FILE"
                # Also ensure the inbox dir exists on the host so the
                # bind-mount doesn't auto-create it as an empty dir
                # owned by docker's daemon UID.
                install -d -m 0755 /var/lib/proxypilot/cve-inbox 2>/dev/null || true
                log "${GREEN}docker-compose.yml: inbox bind-mount wired${NC}"
            fi
        fi

        # Engine env vars: install dir + hostname so the engine can
        # locate itself on host pivots and look up hosts.<name>.action_class.
        if [ -f "$COMPOSE_FILE" ] && ! grep -qE "PROXYPILOT_INSTALL_DIR=" "$COMPOSE_FILE"; then
            HOST_HN=$(hostname)
            log "${YELLOW}Patching docker-compose.yml: adding engine env vars${NC}"
            sed -i -E \
                "/^[[:space:]]+- DOCKER_CONTAINER=true[[:space:]]*\$/a\\
      - PROXYPILOT_INSTALL_DIR=${INSTALL_DIR}\\
      - PROXYPILOT_HOSTNAME=${HOST_HN}" \
                "$COMPOSE_FILE"
            log "${GREEN}docker-compose.yml: engine env vars added${NC}"
        fi

        if [ -f "$COMPOSE_FILE" ] && ! grep -q "^[[:space:]]*privileged: true" "$COMPOSE_FILE"; then
            if grep -qE "cap_drop:|cap_add:|security_opt:" "$COMPOSE_FILE"; then
                log "${YELLOW}Patching docker-compose.yml: replacing cap-drop block with privileged: true${NC}"
                # Strip the cap_drop / cap_add / security_opt blocks
                # added by B1, replace with a single `privileged: true`
                # line right after `restart: always`.
                python3 - "$COMPOSE_FILE" <<'PYEOF' || true
import sys, re
path = sys.argv[1]
with open(path) as f:
    text = f.read()
# Drop the three blocks B1 added (each is a key followed by indented
# list items). Match the key line plus all immediately-following lines
# whose indent is deeper than the key's.
def strip_block(text, key):
    pat = re.compile(
        rf"(?m)^([ \t]+){re.escape(key)}:[ \t]*\n((?:\1[ \t]+- .*\n)+)"
    )
    return pat.sub("", text)
for k in ("cap_drop", "cap_add", "security_opt"):
    text = strip_block(text, k)
# Ensure `privileged: true` appears once, right after `restart:` line.
if "privileged: true" not in text:
    text = re.sub(
        r"(?m)^([ \t]+)(restart:\s*\S+)\s*\n",
        lambda m: f"{m.group(0)}{m.group(1)}privileged: true\n",
        text,
        count=1,
    )
with open(path, "w") as f:
    f.write(text)
PYEOF
                log "${GREEN}docker-compose.yml patched. Container will pick up on rebuild.${NC}"
            fi
        fi

        # CVE engine — host-side requirements for the AUTO_PATCH /
        # ONE_CLICK execution lanes. The dashboard's read-only paths
        # (paste, validate) run inside the container and don't need
        # any of this. poll / run-one / inventory pivot to the host
        # via nsenter and need:
        #
        #   - python3 + python3-ruamel.yaml: engine runtime.
        #   - The proxypilot/ Python package on disk at $INSTALL_DIR
        #     (already copied above by `cp -r ${SCRIPT_DIR}/proxypilot`).
        #   - systemd timers (inventory hourly, poll every 5 min) so
        #     AUTO_PATCH actually runs without a dashboard click.
        #
        # All idempotent — re-running update.sh on a fully-installed
        # host is a no-op.
        if command -v apt-get >/dev/null 2>&1; then
            need_deps=()
            command -v python3 >/dev/null 2>&1 || need_deps+=("python3")
            python3 -c "import ruamel.yaml" 2>/dev/null || need_deps+=("python3-ruamel.yaml")
            if [ ${#need_deps[@]} -gt 0 ]; then
                log "${YELLOW}Installing host-side CVE engine deps: ${need_deps[*]}${NC}"
                DEBIAN_FRONTEND=noninteractive apt-get install -y "${need_deps[@]}" \
                    >/dev/null 2>&1 || \
                    log "${YELLOW}Some engine deps failed to install; AUTO_PATCH may not work until you run apt-get install ${need_deps[*]}${NC}"
            fi
        fi

        if [[ -d "${SCRIPT_DIR}/deploy" ]]; then
            engine_units_changed=0
            for unit in proxypilot-engine-inventory.service \
                        proxypilot-engine-inventory.timer \
                        proxypilot-engine-poll.service \
                        proxypilot-engine-poll.timer; do
                src="${SCRIPT_DIR}/deploy/${unit}"
                dst="/etc/systemd/system/${unit}"
                [ -f "$src" ] || continue
                # Patch ExecStart= to set PYTHONPATH=$INSTALL_DIR so
                # the engine module resolves without a system pip
                # install.
                tmp=$(mktemp)
                sed "s#ExecStart=/usr/bin/python3#ExecStart=/usr/bin/env PYTHONPATH=${INSTALL_DIR} /usr/bin/python3#" \
                    "$src" > "$tmp"
                if [ ! -f "$dst" ] || ! cmp -s "$tmp" "$dst"; then
                    install -m 0644 "$tmp" "$dst"
                    engine_units_changed=1
                fi
                rm -f "$tmp"
            done
            if [ "$engine_units_changed" = "1" ]; then
                log "${YELLOW}CVE engine systemd units changed; reloading${NC}"
                systemctl daemon-reload
                systemctl enable --now proxypilot-engine-inventory.timer 2>/dev/null || true
                systemctl enable --now proxypilot-engine-poll.timer 2>/dev/null || true
                log "${GREEN}CVE engine timers active${NC}"
            fi
        fi

        # Inbox dir — bind-mounted into the container above. Must
        # exist on the host before docker-compose up or Docker auto-
        # creates it as an empty dir owned by root.
        install -d -m 0755 /var/lib/proxypilot/cve-inbox 2>/dev/null || true

        # Retired git CVE feed cleanup. The read-only sync-git source
        # was replaced by the dashboard's built-in AI research routine;
        # this drops any inbox entries it imported (stamped
        # _proxypilot.origin: git) and its staging clone dir. Entries
        # pasted by an operator or filed by AI research are untouched.
        # Idempotent — a clean inbox is a no-op.
        if command -v python3 >/dev/null 2>&1 && [ -d "${INSTALL_DIR}/proxypilot" ]; then
            purge_out=$(PYTHONPATH="${INSTALL_DIR}" python3 -m proxypilot.engine \
                purge-git-origin 2>/dev/null) || true
            if echo "$purge_out" | grep -q '"removed": \[\]'; then
                log_verbose "No git-origin CVE entries to purge"
            elif [ -n "$purge_out" ]; then
                log "${YELLOW}Purged retired git-feed CVE entries: ${purge_out}${NC}"
            fi
        fi

        # Phase A — patch the deployed docker-compose.yml so the
        # container can reach the host-side agent. Two idempotent
        # passes:
        #
        #   FRESH INSTALL (no agent wiring yet):
        #     * volume bind:  /run/proxypilot-agent:/run/proxypilot-agent
        #     * group_add:    [<numeric-gid-of-proxypilot-agent>]
        #     * env var:      PROXYPILOT_AGENT_SOCKET=/run/proxypilot-agent/proxypilot-agent.sock
        #
        #   MIGRATION from the original layout (single-file mount of
        #   /run/proxypilot-agent.sock at the root of /run): the file
        #   mount races with Docker on host reboot, so move to a
        #   directory mount that's stable under
        #   systemd RuntimeDirectory.
        #     * /run/proxypilot-agent.sock:/run/proxypilot-agent.sock
        #         → /run/proxypilot-agent:/run/proxypilot-agent
        #     * PROXYPILOT_AGENT_SOCKET old path → new path
        #
        # Phase A is dual-tracked, so this socket isn't called by any
        # production code path yet — the container can connect and
        # ping the agent, but nsenter still drives every host op.
        if [ -f "$COMPOSE_FILE" ] && getent group proxypilot-agent >/dev/null 2>&1; then
            AGENT_GID=$(getent group proxypilot-agent | cut -d: -f3)
            NEEDS_PATCH=false
            # Fresh-install markers
            grep -q '/run/proxypilot-agent:/run/proxypilot-agent' "$COMPOSE_FILE" || NEEDS_PATCH=true
            grep -q 'group_add' "$COMPOSE_FILE" || NEEDS_PATCH=true
            grep -q 'PROXYPILOT_AGENT_SOCKET=/run/proxypilot-agent/proxypilot-agent.sock' "$COMPOSE_FILE" || NEEDS_PATCH=true
            # Migration markers — old file-mount layout still present?
            grep -q '/run/proxypilot-agent\.sock:/run/proxypilot-agent\.sock' "$COMPOSE_FILE" && NEEDS_PATCH=true

            if [ "$NEEDS_PATCH" = true ]; then
                log "${YELLOW}Patching docker-compose.yml: wiring host-side agent (directory mount)${NC}"
                AGENT_GID="$AGENT_GID" python3 - "$COMPOSE_FILE" <<'PYEOF' || true
import os, sys, re
path = sys.argv[1]
gid = os.environ.get("AGENT_GID", "").strip()
if not gid:
    sys.exit(0)
with open(path) as f:
    text = f.read()

# A. Migrate the old single-file mount to the new directory mount.
text = re.sub(
    r"(?m)^([ \t]+)- /run/proxypilot-agent\.sock:/run/proxypilot-agent\.sock\s*\n",
    lambda m: f"{m.group(1)}- /run/proxypilot-agent:/run/proxypilot-agent\n",
    text,
)

# B. Migrate the old socket path env var to the new directory path.
text = re.sub(
    r"(?m)^([ \t]+)- PROXYPILOT_AGENT_SOCKET=/run/proxypilot-agent\.sock\s*$",
    lambda m: f"{m.group(1)}- PROXYPILOT_AGENT_SOCKET=/run/proxypilot-agent/proxypilot-agent.sock",
    text,
)

# C. Fresh install: ensure the directory mount is present. Insert
#    after the docker.sock line if not already there.
if "/run/proxypilot-agent:/run/proxypilot-agent" not in text:
    text = re.sub(
        r"(?m)^([ \t]+)- /var/run/docker\.sock:/var/run/docker\.sock\s*\n",
        lambda m: f"{m.group(0)}{m.group(1)}- /run/proxypilot-agent:/run/proxypilot-agent\n",
        text,
        count=1,
    )

# D. Fresh install: group_add block before environment: if missing.
if not re.search(r"(?m)^[ \t]+group_add:[ \t]*$", text):
    text = re.sub(
        r"(?m)^([ \t]+)environment:[ \t]*\n",
        lambda m: f"{m.group(1)}group_add:\n{m.group(1)}  - \"{gid}\"\n{m.group(0)}",
        text,
        count=1,
    )

# E. Fresh install: env var after DOCKER_CONTAINER=true if missing.
if "PROXYPILOT_AGENT_SOCKET" not in text:
    text = re.sub(
        r"(?m)^([ \t]+)- DOCKER_CONTAINER=true\s*\n",
        lambda m: f"{m.group(0)}{m.group(1)}- PROXYPILOT_AGENT_SOCKET=/run/proxypilot-agent/proxypilot-agent.sock\n",
        text,
        count=1,
    )

with open(path, "w") as f:
    f.write(text)
PYEOF
                log "${GREEN}docker-compose.yml: agent directory mount wired (gid=${AGENT_GID})${NC}"
            fi
        fi

        # Legacy path cleanup. The original Phase A layout put the
        # socket at /run/proxypilot-agent.sock; the new layout uses
        # /run/proxypilot-agent/proxypilot-agent.sock inside a
        # systemd-managed RuntimeDirectory. Anything left at the old
        # path is stale — it could be a stale socket file from the
        # old agent, or a directory from a Docker auto-create race.
        # Either way, nothing should reference it after this update,
        # so remove it. Safe regardless of file type because the
        # currently-running agent is on the new path.
        if [[ -e /run/proxypilot-agent.sock ]]; then
            log "Removing legacy /run/proxypilot-agent.sock (now uses /run/proxypilot-agent/proxypilot-agent.sock)"
            rm -rf /run/proxypilot-agent.sock
        fi

        # Rebuild frontend at the install location
        log "Rebuilding frontend..."
        cd "${INSTALL_DIR}/admin/frontend"
        $NPM_CMD ci 2>&1 | tee -a "$LOG_FILE"
        NODE_ENV=production $NPM_CMD run build 2>&1 | tee -a "$LOG_FILE"

        # Rebuild and restart Docker container
        log "Rebuilding Docker container..."
        cd "$INSTALL_DIR"

        # Determine docker compose command
        DC_CMD="docker compose"
        if ! docker compose version &>/dev/null; then
            DC_CMD="docker-compose"
        fi

        $DC_CMD down --remove-orphans 2>/dev/null || true

        # Backend is now stopped — safe window to relocate the SQLite
        # DB into its own subdirectory if this install is on the legacy
        # layout. Idempotent, no-op on already-migrated installs.
        if ! migrate_db_layout; then
            log "${RED}DB layout migration failed — aborting before rebuild${NC}"
            exit 1
        fi

        # Cached vs from-scratch build. PROXYPILOT_DEP_CHANGED is set in the
        # re-exec block above: 0 = this update touched only frontend/src, so the
        # cached build reuses the native better-sqlite3/node-pty compile layer
        # (~seconds); 1 (or unset) = a dependency/Dockerfile change, or we could
        # not prove otherwise, so recompile from source with --no-cache (minutes).
        # An operator who wants a guaranteed clean image can still force it:
        # `sudo ./update.sh --rebuild` on an up-to-date checkout takes the
        # --no-cache path (no re-exec ⇒ PROXYPILOT_DEP_CHANGED unset).
        if [ "${PROXYPILOT_DEP_CHANGED:-1}" = "0" ]; then
            log "No dependency/Dockerfile changes — building with the cache (reuses the native module compile)..."
            $DC_CMD build
        else
            log "Building with --no-cache..."
            $DC_CMD build --no-cache
        fi
        $DC_CMD up -d

        # docker compose up -d returns 0 once the daemon accepts the
        # request, even if the container immediately crash-loops. Poll
        # the health endpoint to confirm the new build is actually
        # serving — without this, a bad migration ships silently.
        # NOTE: this block runs in the script's top-level scope (not a
        # function), so `local` would be a syntax error in strict bash —
        # use plain assignments.
        HEALTH_PORT=3001
        if [ -f "${INSTALL_DIR}/.env" ]; then
            # Strip inline `# comment` and any whitespace before parsing —
            # `PORT=3001 # default` would otherwise become `3001#default`.
            ENV_PORT=$(grep -E '^PORT=' "${INSTALL_DIR}/.env" | head -1 | cut -d= -f2- | sed 's/#.*$//' | tr -d '[:space:]')
            [ -n "$ENV_PORT" ] && HEALTH_PORT="$ENV_PORT"
        fi

        log "Waiting for ProxyPilot to become healthy on port ${HEALTH_PORT}..."
        HEALTHY=false
        for i in $(seq 1 30); do
            if curl -fsS "http://127.0.0.1:${HEALTH_PORT}/api/health" >/dev/null 2>&1; then
                HEALTHY=true
                break
            fi
            sleep 2
        done

        if [ "$HEALTHY" != "true" ]; then
            log "${RED}Container did not become healthy within 60s. Last 50 log lines:${NC}"
            docker logs proxypilot-admin --tail 50 2>&1 || true
            log "${RED}Update will be rolled back via the ERR trap.${NC}"
            # Exit non-zero so the trap fires and restore_db runs.
            exit 1
        fi

        log "Container logs:"
        docker logs proxypilot-admin --tail 20 2>&1 || true

        log "${GREEN}Docker container rebuilt and restarted (healthy)${NC}"

        # Post-update cleanup. Only runs after the new build is
        # confirmed healthy — a failed update goes through the ERR
        # trap which restores the DB and tries to bring the OLD
        # container back, so we must NOT prune anything that might
        # be needed for that recovery path. By the time we reach
        # this line:
        #
        #   - The new image is tagged + active, so the old build
        #     of proxypilot-proxypilot is now dangling (untagged).
        #     `docker image prune -f` removes ONLY dangling images
        #     — it never touches anything with a tag, so other
        #     applications on this host's docker daemon are safe.
        #   - The build cache from the just-finished --no-cache
        #     rebuild is at peak size; `--keep-storage 1g` caps it.
        #   - The pre-update DB backup that on_error would have
        #     used is older than today's run; we keep the most
        #     recent N (default 30 days) and prune the rest so
        #     long-lived hosts don't accumulate dozens of GB.
        #
        # All three are best-effort — failures are logged but don't
        # fail the update.
        log "${BLUE}Post-update cleanup${NC}"

        if reclaimed_dangling=$(docker image prune -f 2>/dev/null | grep -E "Total reclaimed space:" | awk '{print $NF" "$(NF-1)}' | tr -d ',' ); then
            [ -n "$reclaimed_dangling" ] \
                && log "  Dangling images pruned: ${reclaimed_dangling}" \
                || log "  No dangling images to prune."
        else
            log "${YELLOW}  Image prune skipped (docker error).${NC}"
        fi

        if reclaimed_cache=$(docker builder prune -f --keep-storage 1g 2>/dev/null | grep -E "Total:" | awk '{print $2,$3}'); then
            [ -n "$reclaimed_cache" ] \
                && log "  Build cache trimmed to 1 GiB (freed ${reclaimed_cache})." \
                || log "  Build cache already within budget."
        else
            log "${YELLOW}  Build cache prune skipped (docker error).${NC}"
        fi

        BACKUP_DIR="${INSTALL_DIR}/data/db/backups"
        BACKUP_KEEP_DAYS="${PROXYPILOT_BACKUP_KEEP_DAYS:-30}"
        if [ -d "$BACKUP_DIR" ]; then
            removed=$(find "$BACKUP_DIR" -type f -name "*.bak*" -mtime "+${BACKUP_KEEP_DAYS}" -print -delete 2>/dev/null | wc -l)
            if [ "$removed" -gt 0 ]; then
                log "  DB backups: removed ${removed} file(s) older than ${BACKUP_KEEP_DAYS} day(s)."
            else
                log "  DB backups: nothing older than ${BACKUP_KEEP_DAYS} day(s) to remove."
            fi
        fi

        log ""
        log "${GREEN}========================================${NC}"
        log "${GREEN}       Restart completed!               ${NC}"
        log "${GREEN}========================================${NC}"
        log ""
        # Disarm the trap before the early exit (the trap-disarm at
        # the bottom of the script is unreachable on the Docker path).
        trap - ERR INT TERM
        if [ -n "$DB_BACKUP_FILE" ]; then
            log "Database backup retained at: $DB_BACKUP_FILE"
            log "To roll back manually: stop ProxyPilot, then cp \"$DB_BACKUP_FILE\" \"$DB_BACKUP_SOURCE\""
        fi
        exit 0
    fi

    # Non-Docker deployment: restart the process directly
    # Stop existing processes and free the port
    log "Stopping existing ProxyPilot processes..."
    PORT_TO_FREE=${PORT:-3001}

    # Step 1: Graceful kill by process name
    pgrep -f "node.*index.js" 2>/dev/null | xargs -r kill 2>/dev/null || true
    sleep 2

    # Step 2: Force kill by process name
    pgrep -f "node.*index.js" 2>/dev/null | xargs -r kill -9 2>/dev/null || true

    # Step 3: Kill anything holding the port using fuser (most reliable)
    fuser -k ${PORT_TO_FREE}/tcp 2>/dev/null || true
    sleep 1
    fuser -k -9 ${PORT_TO_FREE}/tcp 2>/dev/null || true

    # Step 4: Wait for port to be free (up to 15 seconds)
    log "Waiting for port ${PORT_TO_FREE} to be free..."
    for i in $(seq 1 15); do
        # Test if port is free by trying to bind to it briefly
        if $NODE_CMD -e "const s=require('net').createServer();s.listen(${PORT_TO_FREE},'0.0.0.0',()=>{s.close();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
            log "Port ${PORT_TO_FREE} is free"
            break
        fi
        if [ "$i" -eq 15 ]; then
            log "${YELLOW}Warning: Port ${PORT_TO_FREE} may still be in use${NC}"
        fi
        sleep 1
    done

    # Start the backend
    log "Starting ProxyPilot backend..."
    cd "$BACKEND_DIR"

    # Source .env from install root if it exists (provides env vars to the process)
    ENV_FILE="$SCRIPT_DIR/.env"
    if [ -f "$ENV_FILE" ]; then
        log "Loading environment from $ENV_FILE"
        set +e  # Don't exit on .env source errors
        set -a; source "$ENV_FILE" 2>/dev/null; set +a
        set -e
    fi

    # Ensure DATABASE_PATH is absolute (relative paths break when CWD
    # differs). Defensive ${DATABASE_PATH:-} guards against an
    # unset/sourced-as-empty .env so a future `set -u` doesn't kill us.
    if [ -n "${DATABASE_PATH:-}" ] && [[ "${DATABASE_PATH:-}" != /* ]]; then
        export DATABASE_PATH="$SCRIPT_DIR/$DATABASE_PATH"
        log_verbose "Resolved DATABASE_PATH to: $DATABASE_PATH"
    fi
    # Default DATABASE_PATH if not set
    if [ -z "${DATABASE_PATH:-}" ]; then
        export DATABASE_PATH="$SCRIPT_DIR/data/proxypilot.db"
        log_verbose "Using default DATABASE_PATH: $DATABASE_PATH"
    fi

    # Ensure data directory exists
    mkdir -p "$(dirname "$DATABASE_PATH")"

    # Check if PM2 is available
    if command -v pm2 &> /dev/null; then
        log "Using PM2..."
        pm2 delete proxypilot 2>/dev/null || true
        pm2 start src/index.js --name proxypilot
        pm2 save
        log "${GREEN}Started with PM2${NC}"
    else
        log "Using nohup..."
        nohup $NODE_CMD src/index.js > /tmp/proxypilot.log 2>&1 &
        NEW_PID=$!
        sleep 3

        # First gate: did the process even survive long enough to be
        # observed by kill -0? Catches immediate import / syntax errors.
        if ! kill -0 $NEW_PID 2>/dev/null; then
            log "${RED}Failed to start backend${NC}"
            log ""
            log "${YELLOW}Last 20 lines from /tmp/proxypilot.log:${NC}"
            tail -20 /tmp/proxypilot.log 2>/dev/null || log "  (no log output)"
            log ""
            log "${YELLOW}Try starting manually:${NC}"
            log "  cd $BACKEND_DIR && source $ENV_FILE && node src/index.js"
            exit 1
        fi
        log "${GREEN}Process alive (PID: $NEW_PID), polling /api/health...${NC}"
    fi

    # Second gate: poll /api/health to confirm the server actually
    # started serving — not just that the process didn't immediately
    # die. A backend that crashes during initDatabase() (for example,
    # the assertEncryptionKey() guard, a migration error, a missing
    # native module) would survive `kill -0` for the 3-second sleep
    # but never bind the port. Without this second gate the script
    # would report success and the operator would only find out later
    # that the dashboard is dead.
    log "Waiting for ProxyPilot to become healthy on port ${PORT_TO_FREE}..."
    HEALTHY=false
    for i in $(seq 1 30); do
        if curl -fsS "http://127.0.0.1:${PORT_TO_FREE}/api/health" >/dev/null 2>&1; then
            HEALTHY=true
            break
        fi
        sleep 2
    done
    if [ "$HEALTHY" != "true" ]; then
        log "${RED}Backend did not respond to /api/health within 60s.${NC}"
        log "${YELLOW}Last 30 lines from /tmp/proxypilot.log:${NC}"
        tail -30 /tmp/proxypilot.log 2>/dev/null || log "  (no log output)"
        log "${RED}Update will be rolled back via the ERR trap.${NC}"
        exit 1
    fi
    log "${GREEN}Backend is healthy on port ${PORT_TO_FREE}${NC}"

    if command -v pm2 &> /dev/null; then
        : # PM2 path already logged "Started with PM2" above
    else
        log "Logs: /tmp/proxypilot.log"
    fi

    log ""
    log "${GREEN}ProxyPilot restart complete!${NC}"
fi

# Update succeeded — disarm the restore trap. The backup is kept on disk
# (subject to rotation) so the operator can roll back manually if a
# regression surfaces after the fact.
trap - ERR INT TERM

log ""
log "Update log saved to: $LOG_FILE"
if [ -n "$DB_BACKUP_FILE" ]; then
    log "Database backup retained at: $DB_BACKUP_FILE"
    log "To roll back manually: stop ProxyPilot, then cp \"$DB_BACKUP_FILE\" \"$DB_BACKUP_SOURCE\""
fi
