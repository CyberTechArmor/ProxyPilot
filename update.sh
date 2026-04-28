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
        --help|-h)
            echo "ProxyPilot Update Script"
            echo ""
            echo "Usage: ./update.sh [options]"
            echo ""
            echo "Options:"
            echo "  --rebuild, --force, -f   Force rebuild even if code is up to date"
            echo "  --no-restart             Don't restart after update"
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
                    # Non-secret: copy the example line verbatim with a TODO marker.
                    echo "${default_line}  # TODO: review"
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

resolve_db_path() {
    # Prefer DATABASE_PATH if set in env. Otherwise look in known install
    # locations. Returns the path on stdout, empty string if nothing found.
    if [ -n "${DATABASE_PATH:-}" ] && [ -f "$DATABASE_PATH" ]; then
        echo "$DATABASE_PATH"
        return
    fi
    for candidate in \
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
DB_PATH_FOUND="$(resolve_db_path)"
log "${BLUE}[0/7] Backing up database...${NC}"
backup_db "$DB_PATH_FOUND"
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
fi

# After pulling, sync .env against the new version's .env.example. Any
# newly-introduced keys are appended to the deployed .env with a TODO
# marker so the operator notices them before the next restart.
sync_env_keys

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

# Install backend dependencies
log "${BLUE}[4/7] Installing backend dependencies...${NC}"
cd "$BACKEND_DIR"
log_verbose "Running: $NPM_CMD install in $BACKEND_DIR"
if ! $NPM_CMD install 2>&1 | tee -a "$LOG_FILE"; then
    log "${RED}Error: Failed to install backend dependencies${NC}"
    exit 1
fi

# Install frontend dependencies
log "${BLUE}[5/7] Installing frontend dependencies...${NC}"
cd "$FRONTEND_DIR"
log_verbose "Running: $NPM_CMD install in $FRONTEND_DIR"
if ! $NPM_CMD install 2>&1 | tee -a "$LOG_FILE"; then
    log "${RED}Error: Failed to install frontend dependencies${NC}"
    exit 1
fi

# Build frontend
log "${BLUE}[6/7] Building frontend...${NC}"
log_verbose "Running: $NPM_CMD run build in $FRONTEND_DIR"
if ! $NPM_CMD run build 2>&1 | tee -a "$LOG_FILE"; then
    log "${RED}Error: Failed to build frontend${NC}"
    exit 1
fi

# Return to project root
cd "$SCRIPT_DIR"

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
        log "Building with --no-cache..."
        $DC_CMD build --no-cache
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
