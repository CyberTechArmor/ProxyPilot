#!/bin/bash
# ProxyPilot Admin Dashboard - Reset/Recovery Tool
# Use this script to reset password, TOTP, or recover access

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Installation directory
INSTALL_DIR="/opt/proxypilot"
ENV_FILE="${INSTALL_DIR}/.env"

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

# Check if ProxyPilot is installed
check_installed() {
    if [[ ! -f "$ENV_FILE" ]]; then
        log_error "ProxyPilot is not installed or .env file not found"
        log_info "Run install.sh first to install ProxyPilot"
        exit 1
    fi
}

# Generate secure random password
generate_password() {
    local length=${1:-32}
    openssl rand -base64 48 | tr -dc 'a-zA-Z0-9!@#$%^&*' | head -c "$length"
}

# Generate TOTP secret (valid base32, 32 characters = 160 bits)
generate_totp_secret() {
    # Generate 20 random bytes (160 bits) and encode as base32
    # This produces exactly 32 base32 characters
    python3 -c "
import secrets
import base64
random_bytes = secrets.token_bytes(20)
secret = base64.b32encode(random_bytes).decode('ascii').rstrip('=')
print(secret[:32])
"
}

# Generate QR code for TOTP (ASCII)
generate_totp_qr() {
    local secret=$1
    local username=$2
    local issuer="ProxyPilot"
    local uri="otpauth://totp/${issuer}:${username}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30"

    if command -v qrencode &> /dev/null; then
        echo ""
        log_info "Scan this QR code with your authenticator app:"
        echo ""
        qrencode -t ANSIUTF8 "$uri"
        echo ""
    else
        log_warn "qrencode not installed. Install it with: apt install qrencode"
    fi

    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}  ${GREEN}TOTP Manual Entry Details${NC}                                    ${CYAN}║${NC}"
    echo -e "${CYAN}╠════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║${NC}  Secret Key: ${GREEN}${secret}${NC}                ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Account:    ${username}                                          ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Issuer:     ProxyPilot                                      ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Algorithm:  SHA1                                            ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Digits:     6                                               ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Period:     30 seconds                                      ${CYAN}║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# Get current username from env
get_username() {
    grep "^ADMIN_USERNAME=" "$ENV_FILE" | cut -d'=' -f2
}

# Reset password
reset_password() {
    log_info "Resetting admin password..."

    local username=$(get_username)
    local new_password=$(generate_password 24)

    # Update the .env file with new password
    sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${new_password}/" "$ENV_FILE"

    # Delete the database to force re-initialization with new password
    rm -f "${INSTALL_DIR}/data/proxypilot.db"

    # Restart the container
    log_info "Restarting ProxyPilot..."
    cd "$INSTALL_DIR"
    docker compose restart

    # Wait for container to be ready
    sleep 5

    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║${NC}                   ${GREEN}PASSWORD RESET COMPLETE${NC}                      ${GREEN}║${NC}"
    echo -e "${GREEN}╠════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║${NC}                                                                ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  Username: ${CYAN}${username}${NC}                                           ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}                                                                ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  New Password:                                                 ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${YELLOW}${new_password}${NC}         ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}                                                                ${GREEN}║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}IMPORTANT: Save this password securely! It will not be shown again.${NC}"
    echo ""
}

# Reset TOTP
reset_totp() {
    log_info "Resetting TOTP secret..."

    local username=$(get_username)
    local new_totp=$(generate_totp_secret)

    # Update the .env file with new TOTP secret
    sed -i "s/^ADMIN_TOTP_SECRET=.*/ADMIN_TOTP_SECRET=${new_totp}/" "$ENV_FILE"

    # Delete the database to force re-initialization with new TOTP
    rm -f "${INSTALL_DIR}/data/proxypilot.db"

    # Restart the container
    log_info "Restarting ProxyPilot..."
    cd "$INSTALL_DIR"
    docker compose restart

    # Wait for container to be ready
    sleep 5

    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║${NC}                    ${GREEN}TOTP RESET COMPLETE${NC}                         ${GREEN}║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    generate_totp_qr "$new_totp" "$username"

    echo -e "${YELLOW}IMPORTANT: Save this TOTP secret securely!${NC}"
    echo ""
}

# Full reset (password + TOTP)
full_reset() {
    log_info "Performing full credential reset..."

    local username=$(get_username)
    local new_password=$(generate_password 24)
    local new_totp=$(generate_totp_secret)

    # Update the .env file
    sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${new_password}/" "$ENV_FILE"
    sed -i "s/^ADMIN_TOTP_SECRET=.*/ADMIN_TOTP_SECRET=${new_totp}/" "$ENV_FILE"

    # Delete the database to force re-initialization
    rm -f "${INSTALL_DIR}/data/proxypilot.db"

    # Restart the container
    log_info "Restarting ProxyPilot..."
    cd "$INSTALL_DIR"
    docker compose restart

    # Wait for container to be ready
    sleep 5

    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║${NC}                  ${GREEN}FULL RESET COMPLETE${NC}                           ${GREEN}║${NC}"
    echo -e "${GREEN}╠════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║${NC}                                                                ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  Username: ${CYAN}${username}${NC}                                           ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}                                                                ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  New Password:                                                 ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${YELLOW}${new_password}${NC}         ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}                                                                ${GREEN}║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    generate_totp_qr "$new_totp" "$username"

    echo -e "${YELLOW}IMPORTANT: Save these credentials securely! They will not be shown again.${NC}"
    echo ""
}

# Show current credentials (from .env file)
show_credentials() {
    log_info "Current credentials from configuration:"
    echo ""

    local username=$(get_username)
    local password=$(grep "^ADMIN_PASSWORD=" "$ENV_FILE" | cut -d'=' -f2)
    local totp=$(grep "^ADMIN_TOTP_SECRET=" "$ENV_FILE" | cut -d'=' -f2)
    local domain=$(grep "^DOMAIN=" "$ENV_FILE" | cut -d'=' -f2)

    echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}                   ${CYAN}CURRENT CREDENTIALS${NC}                           ${CYAN}║${NC}"
    echo -e "${CYAN}╠════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║${NC}                                                                ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Dashboard URL: ${GREEN}https://${domain}${NC}"
    echo -e "${CYAN}║${NC}                                                                ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Username: ${GREEN}${username}${NC}"
    echo -e "${CYAN}║${NC}                                                                ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Password:                                                     ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  ${YELLOW}${password}${NC}"
    echo -e "${CYAN}║${NC}                                                                ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  TOTP Secret:                                                  ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  ${YELLOW}${totp}${NC}"
    echo -e "${CYAN}║${NC}                                                                ${CYAN}║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    generate_totp_qr "$totp" "$username"
}

# Show status
show_status() {
    log_info "ProxyPilot Status:"
    echo ""

    cd "$INSTALL_DIR"
    docker compose ps

    echo ""
    log_info "Recent logs:"
    docker compose logs --tail=20
}

# Show help
show_help() {
    echo ""
    echo -e "${CYAN}ProxyPilot Reset/Recovery Tool${NC}"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  password    Reset admin password"
    echo "  totp        Reset TOTP secret"
    echo "  full        Reset both password and TOTP"
    echo "  show        Show current credentials"
    echo "  status      Show service status and logs"
    echo "  help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  sudo $0 password   # Generate new password"
    echo "  sudo $0 totp       # Generate new TOTP secret"
    echo "  sudo $0 show       # Display current credentials"
    echo ""
}

# Main menu
show_menu() {
    clear
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║                                                               ║"
    echo "║     🔧 ProxyPilot Reset/Recovery Tool                         ║"
    echo "║                                                               ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo "Select an option:"
    echo ""
    echo "  1) Reset Password"
    echo "  2) Reset TOTP"
    echo "  3) Full Reset (Password + TOTP)"
    echo "  4) Show Current Credentials"
    echo "  5) Show Status"
    echo "  6) Exit"
    echo ""
    read -rp "Enter choice [1-6]: " choice

    case $choice in
        1) reset_password ;;
        2) reset_totp ;;
        3) full_reset ;;
        4) show_credentials ;;
        5) show_status ;;
        6) exit 0 ;;
        *) log_error "Invalid choice"; exit 1 ;;
    esac
}

# Main
main() {
    check_root
    check_installed

    case "${1:-}" in
        password) reset_password ;;
        totp) reset_totp ;;
        full) full_reset ;;
        show) show_credentials ;;
        status) show_status ;;
        help|--help|-h) show_help ;;
        "") show_menu ;;
        *) log_error "Unknown command: $1"; show_help; exit 1 ;;
    esac
}

main "$@"
