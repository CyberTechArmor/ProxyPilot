#!/bin/bash
# ProxyPilot Cleanup Script
# Removes ProxyPilot service while keeping NGINX and Docker installed

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

INSTALL_DIR="/opt/proxypilot"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    log_error "This script must be run as root (use sudo)"
    exit 1
fi

echo ""
echo -e "${YELLOW}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║           ProxyPilot Cleanup Script                           ║${NC}"
echo -e "${YELLOW}║                                                               ║${NC}"
echo -e "${YELLOW}║   This will remove ProxyPilot but keep NGINX and Docker       ║${NC}"
echo -e "${YELLOW}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Confirm cleanup
read -rp "Are you sure you want to remove ProxyPilot? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    log_info "Cleanup cancelled"
    exit 0
fi

# Stop and remove Docker containers
log_info "Stopping ProxyPilot Docker containers..."
if [[ -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
    cd "$INSTALL_DIR"
    docker compose down --remove-orphans 2>/dev/null || true
    log_success "Docker containers stopped"
else
    log_warn "No docker-compose.yml found, skipping container cleanup"
fi

# Remove Docker images
log_info "Removing ProxyPilot Docker images..."
docker images | grep -E "proxypilot|${INSTALL_DIR##*/}" | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true
log_success "Docker images removed"

# Get domain from .env before removing (for NGINX cleanup)
DOMAIN=""
if [[ -f "${INSTALL_DIR}/.env" ]]; then
    DOMAIN=$(grep "^DOMAIN=" "${INSTALL_DIR}/.env" 2>/dev/null | cut -d'=' -f2 || true)
fi

# Remove NGINX site configuration
log_info "Removing NGINX site configuration..."
if [[ -n "$DOMAIN" ]]; then
    rm -f "/etc/nginx/sites-enabled/${DOMAIN}.conf" 2>/dev/null || true
    rm -f "/etc/nginx/sites-available/${DOMAIN}.conf" 2>/dev/null || true
    log_success "NGINX site config for ${DOMAIN} removed"
else
    # Try to find and remove any proxypilot-related configs
    rm -f /etc/nginx/sites-enabled/proxypilot*.conf 2>/dev/null || true
    rm -f /etc/nginx/sites-available/proxypilot*.conf 2>/dev/null || true
    log_warn "Could not determine domain, removed any proxypilot*.conf files"
fi

# Reload NGINX
log_info "Reloading NGINX..."
if nginx -t 2>/dev/null; then
    systemctl reload nginx
    log_success "NGINX reloaded"
else
    log_warn "NGINX config test failed, attempting to restart anyway"
    systemctl restart nginx || true
fi

# Remove installation directory
log_info "Removing installation directory..."
if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    log_success "Removed ${INSTALL_DIR}"
else
    log_warn "Installation directory not found"
fi

# Optional: Remove SSL certificates
echo ""
read -rp "Do you also want to remove SSL certificates for ${DOMAIN:-the domain}? [y/N]: " remove_certs
if [[ "$remove_certs" =~ ^[Yy]$ ]] && [[ -n "$DOMAIN" ]]; then
    log_info "Removing SSL certificates..."
    certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null || true
    log_success "SSL certificates removed"
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Cleanup Complete!                                ║${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}║   ProxyPilot has been removed.                                ║${NC}"
echo -e "${GREEN}║   NGINX and Docker are still installed.                       ║${NC}"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}║   To reinstall, run: sudo ./install.sh                        ║${NC}"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
