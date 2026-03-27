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

# Source .env early to get PORT
ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    set -a; source "$ENV_FILE" 2>/dev/null; set +a
fi
PORT_TO_FREE=${PORT:-3001}

# Stop existing processes and free the port
echo "Stopping existing ProxyPilot processes..."

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
echo "Waiting for port ${PORT_TO_FREE} to be free..."
for i in $(seq 1 15); do
    if $NODE_CMD -e "const s=require('net').createServer();s.listen(${PORT_TO_FREE},'0.0.0.0',()=>{s.close();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
        echo "Port ${PORT_TO_FREE} is free"
        break
    fi
    if [ "$i" -eq 15 ]; then
        echo -e "${YELLOW}Warning: Port ${PORT_TO_FREE} may still be in use${NC}"
    fi
    sleep 1
done

# Start the backend
echo ""
echo "Starting ProxyPilot backend..."
cd "$BACKEND_DIR"

# Ensure DATABASE_PATH is absolute (relative paths break when CWD differs)
if [ -n "$DATABASE_PATH" ] && [[ "$DATABASE_PATH" != /* ]]; then
    export DATABASE_PATH="$SCRIPT_DIR/$DATABASE_PATH"
fi
# Default DATABASE_PATH if not set
if [ -z "$DATABASE_PATH" ]; then
    export DATABASE_PATH="$SCRIPT_DIR/data/proxypilot.db"
fi
# Ensure data directory exists
mkdir -p "$(dirname "$DATABASE_PATH")"

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
    sleep 3

    # Verify it started
    if kill -0 $NEW_PID 2>/dev/null; then
        echo -e "${GREEN}Started in background (PID: $NEW_PID)${NC}"
        echo "Logs: /tmp/proxypilot.log"
    else
        echo -e "${RED}Failed to start - see error below:${NC}"
        echo ""
        tail -20 /tmp/proxypilot.log 2>/dev/null || echo "  (no log output)"
        echo ""
        echo -e "${YELLOW}Try starting manually:${NC}"
        echo "  cd $BACKEND_DIR && source $ENV_FILE && node src/index.js"
        exit 1
    fi
fi

echo ""
echo -e "${GREEN}ProxyPilot restart complete!${NC}"
