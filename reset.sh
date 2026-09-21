#!/bin/bash
# ProxyPilot Admin Dashboard - Reset/Recovery Tool
#
# Restores a local administrator's access WITHOUT touching anything else.
# Every credential action below is `proxypilot recover admin …`
# (cli/src/commands/recover.js, docs/features/root-recovery.md): it edits one
# account in the live database, revokes that account's sessions, elevation
# grants and trusted devices, records an audit event, and leaves every other
# account, all application data, the .env and its encryption keys as they are.
#
# This script used to clear ADMIN_PASSWORD / ADMIN_TOTP_SECRET in .env and
# delete the database so first-boot setup ran again. It no longer deletes or
# rewrites anything: the .env is read only for the username and the domain.

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
INSTALL_DIR="${PROXYPILOT_INSTALL_DIR:-/opt/proxypilot}"
ENV_FILE="${INSTALL_DIR}/.env"
# The CLI wrapper install.sh drops at /usr/local/bin/proxypilot. Overridable
# so a checkout can run this script against its own cli/ (tests do).
PROXYPILOT_BIN="${PROXYPILOT_BIN:-/usr/local/bin/proxypilot}"

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
    if [[ ! -x "$PROXYPILOT_BIN" ]]; then
        log_error "ProxyPilot CLI not found at $PROXYPILOT_BIN"
        log_info "Run update.sh (it installs the CLI), or set PROXYPILOT_BIN=<path to cli/bin/proxypilot.js wrapper>"
        exit 1
    fi
}

get_username() {
    # ADMIN_USERNAME is the account install.sh created; the operator may name
    # another local administrator with USERNAME=<name>.
    if [[ -n "${USERNAME:-}" ]]; then
        printf '%s' "$USERNAME"
    else
        grep "^ADMIN_USERNAME=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '"'"'"
    fi
}

get_domain() {
    grep "^DOMAIN=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '"'"'"
}

# recover <flags…> — run the non-destructive recovery for the chosen account.
# The CLI prints its plan, asks for the username as confirmation on a
# terminal, takes a consistent copy of the database first, and shows a
# generated password exactly once. Nothing here handles a secret.
recover() {
    local username
    username=$(get_username)
    if [[ -z "$username" ]]; then
        log_error "No ADMIN_USERNAME in $ENV_FILE; run with USERNAME=<local administrator> $0 …"
        exit 1
    fi
    log_info "Recovering local administrator '${username}' (data, keys and other accounts are untouched)"
    "$PROXYPILOT_BIN" recover admin "$username" --install-dir "$INSTALL_DIR" "$@"
}

# Reset password — a new password is generated and shown once; a change is
# required at the next login. TOTP and passkeys stay as they are.
reset_password() {
    recover --password
}

# Reset TOTP — the second factor is cleared for this one account; the next
# password login enrols a new authenticator. The password is untouched.
reset_totp() {
    recover --totp
}

# Full reset — new password AND a fresh TOTP enrolment, for one account.
full_reset() {
    recover --password --totp
}

# Show current configuration (never the secrets)
show_credentials() {
    log_info "Current configuration:"
    echo ""
    echo -e "  Install dir: ${CYAN}${INSTALL_DIR}${NC}"
    echo -e "  Username:    ${CYAN}$(get_username)${NC}"
    echo -e "  Dashboard:   ${CYAN}https://$(get_domain)${NC}"
    echo ""
    "$PROXYPILOT_BIN" recover status --install-dir "$INSTALL_DIR"
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
    echo "Usage: [USERNAME=<local admin>] $0 [command]"
    echo ""
    echo "Commands:"
    echo "  password    New password for the administrator (shown once; change required at login)"
    echo "  totp        Clear the administrator's second factor (re-enrolled at next login)"
    echo "  full        Both of the above"
    echo "  show        Show the configured account, the dashboard URL and every account's standing"
    echo "  status      Show service status and logs"
    echo "  help        Show this help message"
    echo ""
    echo "Every command changes ONE local administrator and nothing else. For the"
    echo "full option set (unlock, passkeys, MCP keys, promote, create a new local"
    echo "administrator, dry run, password from a file):"
    echo "  sudo proxypilot recover admin --help"
    echo ""
    echo "Examples:"
    echo "  sudo $0 password                 # the account from .env"
    echo "  sudo USERNAME=ops $0 full        # another local administrator"
    echo "  sudo $0 show"
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
    echo "Account: $(get_username)   (set USERNAME=<name> to choose another local administrator)"
    echo ""
    echo "Select an option:"
    echo ""
    echo "  1) New password (shown once)"
    echo "  2) Reset TOTP (re-enrolled at next login)"
    echo "  3) Both"
    echo "  4) Show accounts and configuration"
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
