#!/bin/bash

# ProxyPilot Restart Script
# This script restarts the ProxyPilot backend service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/admin/backend"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Find node command
find_node() {
    if command -v node &> /dev/null; then
        command -v node
        return 0
    fi
    for path in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node; do
        if [ -x "$path" ]; then
            echo "$path"
            return 0
        fi
    done
    return 1
}

echo -e "${BLUE}Restarting ProxyPilot...${NC}"

# Find node
NODE_CMD=$(find_node)
if [ -z "$NODE_CMD" ]; then
    echo -e "${RED}Error: node not found${NC}"
    exit 1
fi

# Check if PM2 is managing ProxyPilot
if command -v pm2 &> /dev/null; then
    PM2_PROCESS=$(pm2 list 2>/dev/null | grep -E "proxypilot|ProxyPilot" | head -1)
    if [ -n "$PM2_PROCESS" ]; then
        echo "Detected PM2 process, restarting via PM2..."
        pm2 restart proxypilot 2>/dev/null || pm2 restart ProxyPilot 2>/dev/null || pm2 restart all
        echo -e "${GREEN}PM2 restart complete${NC}"
        exit 0
    fi
fi

# Check if systemd service exists
if systemctl list-units --type=service 2>/dev/null | grep -q proxypilot; then
    echo "Detected systemd service, restarting via systemctl..."
    sudo systemctl restart proxypilot
    echo -e "${GREEN}Systemd restart complete${NC}"
    exit 0
fi

# Find and kill existing Node process running the backend
echo "Looking for existing ProxyPilot process..."

# Multiple patterns to catch the process
PIDS=""
for pattern in "node.*src/index.js" "node src/index.js" "proxypilot.*index.js"; do
    FOUND=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [ -n "$FOUND" ]; then
        PIDS="$PIDS $FOUND"
    fi
done

# Remove duplicates
PIDS=$(echo $PIDS | tr ' ' '\n' | sort -u | tr '\n' ' ')

if [ -n "$PIDS" ] && [ "$PIDS" != " " ]; then
    echo "Found existing process(es):$PIDS"
    echo "Stopping existing process..."
    for PID in $PIDS; do
        kill $PID 2>/dev/null || sudo kill $PID 2>/dev/null || true
    done
    sleep 2

    # Force kill if still running
    STILL_RUNNING=""
    for pattern in "node.*src/index.js" "node src/index.js"; do
        FOUND=$(pgrep -f "$pattern" 2>/dev/null || true)
        if [ -n "$FOUND" ]; then
            STILL_RUNNING="$STILL_RUNNING $FOUND"
        fi
    done

    if [ -n "$STILL_RUNNING" ] && [ "$STILL_RUNNING" != " " ]; then
        echo "Force stopping..."
        for PID in $STILL_RUNNING; do
            kill -9 $PID 2>/dev/null || sudo kill -9 $PID 2>/dev/null || true
        done
        sleep 1
    fi
else
    echo "No existing ProxyPilot process found"
fi

# Start the backend
echo ""
echo "Starting ProxyPilot backend..."
cd "$BACKEND_DIR"

# Source .env from install root if it exists
ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    echo "Loading environment from $ENV_FILE"
    set -a; source "$ENV_FILE"; set +a
fi

# Check if we should use PM2
if command -v pm2 &> /dev/null; then
    echo "Starting with PM2..."
    pm2 delete proxypilot 2>/dev/null || true
    pm2 start "$NODE_CMD" --name "proxypilot" -- src/index.js
    pm2 save 2>/dev/null || true
    echo -e "${GREEN}Started with PM2${NC}"
else
    # Start in background with nohup
    echo "Starting in background with nohup..."
    nohup $NODE_CMD src/index.js > /tmp/proxypilot.log 2>&1 &
    NEW_PID=$!
    sleep 2

    # Verify it started
    if kill -0 $NEW_PID 2>/dev/null; then
        echo -e "${GREEN}Started in background (PID: $NEW_PID)${NC}"
        echo "Logs: /tmp/proxypilot.log"
    else
        echo -e "${RED}Failed to start - check /tmp/proxypilot.log${NC}"
        tail -20 /tmp/proxypilot.log 2>/dev/null || true
        exit 1
    fi
fi

echo ""
echo -e "${GREEN}ProxyPilot restart complete!${NC}"
