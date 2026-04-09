#!/bin/bash

# ProxyPilot Update Script
# This script updates ProxyPilot from the GitHub repository

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/admin/backend"
FRONTEND_DIR="$SCRIPT_DIR/admin/frontend"
LOG_FILE="/tmp/proxypilot-update.log"

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

# Fetch latest changes
log "${BLUE}[1/6] Fetching latest changes...${NC}"
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
    log "${BLUE}[2/6] Pulling latest code...${NC}"
    log_verbose "Running: $GIT_CMD pull origin main"
    if ! $GIT_CMD pull origin main 2>&1 | tee -a "$LOG_FILE"; then
        log "${RED}Error: Failed to pull from remote${NC}"
        exit 1
    fi
fi

# Get new version
NEW_VERSION=$($NODE_CMD -p "require('./admin/backend/package.json').version" 2>/dev/null || echo "unknown")
if [ "$LOCAL" != "$REMOTE" ]; then
    log "New version: ${GREEN}v${NEW_VERSION}${NC}"
fi
log ""

# Install backend dependencies
log "${BLUE}[3/6] Installing backend dependencies...${NC}"
cd "$BACKEND_DIR"
log_verbose "Running: $NPM_CMD install in $BACKEND_DIR"
if ! $NPM_CMD install 2>&1 | tee -a "$LOG_FILE"; then
    log "${RED}Error: Failed to install backend dependencies${NC}"
    exit 1
fi

# Install frontend dependencies
log "${BLUE}[4/6] Installing frontend dependencies...${NC}"
cd "$FRONTEND_DIR"
log_verbose "Running: $NPM_CMD install in $FRONTEND_DIR"
if ! $NPM_CMD install 2>&1 | tee -a "$LOG_FILE"; then
    log "${RED}Error: Failed to install frontend dependencies${NC}"
    exit 1
fi

# Build frontend
log "${BLUE}[5/6] Building frontend...${NC}"
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
    log "${BLUE}[6/6] Restarting ProxyPilot...${NC}"
    log ""

    # Check if running via Docker (installed at /opt/proxypilot with docker-compose.yml)
    INSTALL_DIR="/opt/proxypilot"
    if [[ -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
        log "Detected Docker deployment at ${INSTALL_DIR}"

        # Copy updated admin files to install directory
        log "Copying updated files..."
        cp -r "${SCRIPT_DIR}/admin" "${INSTALL_DIR}/"

        # Rebuild frontend
        log "Rebuilding frontend..."
        cd "${INSTALL_DIR}/admin/frontend"
        $NPM_CMD ci 2>&1 | tee -a "$LOG_FILE"
        NODE_ENV=production $NPM_CMD run build 2>&1 | tee -a "$LOG_FILE"

        # Rebuild and restart Docker container
        log "Rebuilding Docker container..."
        cd "$INSTALL_DIR"
        docker compose down --remove-orphans 2>/dev/null || docker-compose down --remove-orphans 2>/dev/null || true
        docker compose build --no-cache 2>/dev/null || docker-compose build --no-cache 2>/dev/null
        docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null

        log "${GREEN}Docker container rebuilt and restarted${NC}"
        log ""
        log "${GREEN}========================================${NC}"
        log "${GREEN}       Restart completed!               ${NC}"
        log "${GREEN}========================================${NC}"
        log ""
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

    # Ensure DATABASE_PATH is absolute (relative paths break when CWD differs)
    if [ -n "$DATABASE_PATH" ] && [[ "$DATABASE_PATH" != /* ]]; then
        export DATABASE_PATH="$SCRIPT_DIR/$DATABASE_PATH"
        log_verbose "Resolved DATABASE_PATH to: $DATABASE_PATH"
    fi
    # Default DATABASE_PATH if not set
    if [ -z "$DATABASE_PATH" ]; then
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

        # Verify it started
        if kill -0 $NEW_PID 2>/dev/null; then
            log "${GREEN}Started in background (PID: $NEW_PID)${NC}"
            log "Logs: /tmp/proxypilot.log"
        else
            log "${RED}Failed to start backend${NC}"
            log ""
            log "${YELLOW}Last 20 lines from /tmp/proxypilot.log:${NC}"
            tail -20 /tmp/proxypilot.log 2>/dev/null || log "  (no log output)"
            log ""
            log "${YELLOW}Try starting manually:${NC}"
            log "  cd $BACKEND_DIR && source $ENV_FILE && node src/index.js"
            exit 1
        fi
    fi

    log ""
    log "${GREEN}ProxyPilot restart complete!${NC}"
fi

log ""
log "Update log saved to: $LOG_FILE"
