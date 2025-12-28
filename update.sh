#!/bin/bash

# ProxyPilot Update Script
# This script updates ProxyPilot from the GitHub repository

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/admin/backend"
FRONTEND_DIR="$SCRIPT_DIR/admin/frontend"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}       ProxyPilot Update Script        ${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: git is not installed${NC}"
    echo "Please install git first:"
    echo "  Ubuntu/Debian: sudo apt-get install git"
    echo "  CentOS/RHEL: sudo yum install git"
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm is not installed${NC}"
    echo "Please install Node.js and npm first"
    exit 1
fi

# Change to project directory
cd "$SCRIPT_DIR"

# Get current version
CURRENT_VERSION=$(node -p "require('./admin/backend/package.json').version" 2>/dev/null || echo "unknown")
echo -e "Current version: ${YELLOW}v${CURRENT_VERSION}${NC}"
echo ""

# Check for uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
    echo -e "${YELLOW}Warning: You have uncommitted changes${NC}"
    echo "These files have local modifications:"
    git status --short
    echo ""
    read -p "Do you want to continue? This may cause merge conflicts. (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}Update cancelled${NC}"
        exit 1
    fi
fi

# Fetch and pull latest changes
echo -e "${BLUE}[1/5] Fetching latest changes...${NC}"
git fetch origin main

# Check if there are updates
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo -e "${GREEN}Already up to date!${NC}"
    exit 0
fi

echo -e "${BLUE}[2/5] Pulling latest code...${NC}"
git pull origin main

# Get new version
NEW_VERSION=$(node -p "require('./admin/backend/package.json').version" 2>/dev/null || echo "unknown")
echo -e "New version: ${GREEN}v${NEW_VERSION}${NC}"
echo ""

# Install backend dependencies
echo -e "${BLUE}[3/5] Installing backend dependencies...${NC}"
cd "$BACKEND_DIR"
npm install --silent

# Install frontend dependencies
echo -e "${BLUE}[4/5] Installing frontend dependencies...${NC}"
cd "$FRONTEND_DIR"
npm install --silent

# Build frontend
echo -e "${BLUE}[5/5] Building frontend...${NC}"
npm run build --silent

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}       Update completed successfully!   ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Updated from ${YELLOW}v${CURRENT_VERSION}${NC} to ${GREEN}v${NEW_VERSION}${NC}"
echo ""
echo -e "${YELLOW}Please restart ProxyPilot to apply changes:${NC}"
echo "  $SCRIPT_DIR/restart.sh"
echo ""

# Ask if user wants to restart now
read -p "Do you want to restart ProxyPilot now? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}Restarting ProxyPilot...${NC}"
    "$SCRIPT_DIR/restart.sh"
fi
