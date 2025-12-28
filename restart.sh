#!/bin/bash

# ProxyPilot Restart Script
# This script restarts the ProxyPilot backend service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/admin/backend"

echo "Restarting ProxyPilot..."

# Check if PM2 is managing ProxyPilot
if command -v pm2 &> /dev/null; then
    PM2_PROCESS=$(pm2 list 2>/dev/null | grep -E "proxypilot|ProxyPilot" | head -1)
    if [ -n "$PM2_PROCESS" ]; then
        echo "Detected PM2 process, restarting via PM2..."
        pm2 restart proxypilot 2>/dev/null || pm2 restart ProxyPilot 2>/dev/null || pm2 restart all
        echo "PM2 restart complete"
        exit 0
    fi
fi

# Check if systemd service exists
if systemctl list-units --type=service 2>/dev/null | grep -q proxypilot; then
    echo "Detected systemd service, restarting via systemctl..."
    sudo systemctl restart proxypilot
    echo "Systemd restart complete"
    exit 0
fi

# Find and kill existing Node process running the backend
echo "Looking for existing ProxyPilot process..."
PIDS=$(pgrep -f "node.*src/index.js" 2>/dev/null)

if [ -n "$PIDS" ]; then
    echo "Found existing process(es): $PIDS"
    echo "Stopping existing process..."
    kill $PIDS 2>/dev/null
    sleep 2

    # Force kill if still running
    PIDS=$(pgrep -f "node.*src/index.js" 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "Force stopping..."
        kill -9 $PIDS 2>/dev/null
        sleep 1
    fi
fi

# Start the backend
echo "Starting ProxyPilot backend..."
cd "$BACKEND_DIR"

# Check if we should use PM2
if command -v pm2 &> /dev/null; then
    echo "Starting with PM2..."
    pm2 start npm --name "proxypilot" -- start
    pm2 save
    echo "Started with PM2"
else
    # Start in background with nohup
    echo "Starting in background with nohup..."
    nohup npm start > /tmp/proxypilot.log 2>&1 &
    echo "Started in background (PID: $!)"
    echo "Logs: /tmp/proxypilot.log"
fi

echo "ProxyPilot restart complete!"
