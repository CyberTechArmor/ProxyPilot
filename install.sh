#!/bin/bash
# ProxyPilot Admin Dashboard Installer
# This script installs and configures the ProxyPilot admin dashboard

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

# Docker compose command wrapper - detects and uses correct version
DOCKER_COMPOSE_CMD=""
get_docker_compose_cmd() {
    if [[ -n "$DOCKER_COMPOSE_CMD" ]]; then
        echo "$DOCKER_COMPOSE_CMD"
        return
    fi

    if docker compose version &> /dev/null; then
        DOCKER_COMPOSE_CMD="docker compose"
    elif command -v docker-compose &> /dev/null; then
        DOCKER_COMPOSE_CMD="docker-compose"
    else
        log_error "Docker Compose not found!"
        exit 1
    fi
    echo "$DOCKER_COMPOSE_CMD"
}

# Run docker compose with the correct command
run_docker_compose() {
    local cmd=$(get_docker_compose_cmd)
    $cmd "$@"
}

# Check if a port is in use
is_port_in_use() {
    local port=$1
    if command -v ss &> /dev/null; then
        ss -tuln | grep -q ":${port} " && return 0
    elif command -v netstat &> /dev/null; then
        netstat -tuln | grep -q ":${port} " && return 0
    elif command -v lsof &> /dev/null; then
        lsof -i ":${port}" &> /dev/null && return 0
    fi
    return 1
}

# Find next available port
find_available_port() {
    local start_port=$1
    local port=$start_port
    while is_port_in_use $port; do
        ((port++))
        if [[ $port -gt 65535 ]]; then
            echo ""
            return 1
        fi
    done
    echo $port
}

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (use sudo)"
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

    echo -e "${CYAN}Manual entry details:${NC}"
    echo -e "  Secret Key: ${GREEN}${secret}${NC}"
    echo -e "  Account: ${username}"
    echo -e "  Issuer: ${issuer}"
    echo -e "  Algorithm: SHA1"
    echo -e "  Digits: 6"
    echo -e "  Period: 30 seconds"
    echo ""
    echo -e "${YELLOW}IMPORTANT: Save this secret key securely! You will need it to recover access.${NC}"
}

# Check and install NGINX
install_nginx() {
    log_info "Checking NGINX installation..."

    if command -v nginx &> /dev/null; then
        log_success "NGINX is already installed ($(nginx -v 2>&1 | cut -d'/' -f2))"
    else
        log_info "Installing NGINX..."
        apt-get update -y
        apt-get install -y nginx
        log_success "NGINX installed successfully"
    fi

    # Clean up any broken NGINX configurations before starting
    cleanup_broken_nginx_configs

    # Ensure NGINX is enabled
    systemctl enable nginx 2>/dev/null || true

    # Test NGINX config before starting
    if ! nginx -t 2>/dev/null; then
        log_warn "NGINX config test failed, attempting to fix..."
        fix_nginx_config
    fi

    # Start NGINX
    systemctl start nginx 2>/dev/null || true

    # Verify NGINX is running
    if ! systemctl is-active --quiet nginx; then
        log_warn "NGINX service not running, attempting recovery..."
        # Last resort: restore default config
        if [[ -f /etc/nginx/nginx.conf.backup ]]; then
            cp /etc/nginx/nginx.conf.backup /etc/nginx/nginx.conf
        fi
        # Remove all custom sites
        rm -f /etc/nginx/sites-enabled/* 2>/dev/null || true
        ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default 2>/dev/null || true

        systemctl start nginx || {
            log_error "Failed to start NGINX. Check: journalctl -xeu nginx"
            exit 1
        }
    fi
    log_success "NGINX is running"
}

# Clean up broken NGINX configurations
cleanup_broken_nginx_configs() {
    log_info "Cleaning up any broken NGINX configurations..."

    # Remove broken symlinks in sites-enabled
    if [[ -d /etc/nginx/sites-enabled ]]; then
        find /etc/nginx/sites-enabled -xtype l -delete 2>/dev/null || true
    fi

    # Remove configs that reference missing SSL certificates
    for conf in /etc/nginx/sites-enabled/*.conf; do
        [[ -f "$conf" ]] || continue

        # Check if config references SSL cert that doesn't exist
        if grep -q "ssl_certificate" "$conf" 2>/dev/null; then
            cert_path=$(grep -oP "ssl_certificate\s+\K[^;]+" "$conf" | head -1)
            if [[ -n "$cert_path" && ! -f "$cert_path" ]]; then
                log_warn "Removing config with missing SSL cert: $(basename "$conf")"
                rm -f "$conf"
                # Also remove from sites-available
                rm -f "/etc/nginx/sites-available/$(basename "$conf")" 2>/dev/null || true
            fi
        fi
    done

    # Ensure default site exists if no other sites
    if [[ -z "$(ls -A /etc/nginx/sites-enabled 2>/dev/null)" ]]; then
        if [[ -f /etc/nginx/sites-available/default ]]; then
            ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
            log_info "Re-enabled default NGINX site"
        fi
    fi
}

# Fix NGINX configuration issues
fix_nginx_config() {
    log_info "Attempting to fix NGINX configuration..."

    # Temporarily disable all custom sites
    for conf in /etc/nginx/sites-enabled/*.conf; do
        [[ -f "$conf" ]] || continue
        log_warn "Disabling problematic config: $(basename "$conf")"
        rm -f "$conf"
    done

    # Ensure default site is enabled
    if [[ -f /etc/nginx/sites-available/default ]]; then
        ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default 2>/dev/null || true
    fi

    # Test again
    if nginx -t 2>/dev/null; then
        log_success "NGINX configuration fixed"
    else
        log_error "Could not fix NGINX configuration automatically"
    fi
}

# Configure NGINX global settings
configure_nginx_global() {
    local max_upload=$1

    log_info "Configuring NGINX global settings..."

    # Backup original config
    if [[ ! -f /etc/nginx/nginx.conf.backup ]]; then
        cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.backup
    fi

    # Check if client_max_body_size is already set in http block
    if grep -q "client_max_body_size" /etc/nginx/nginx.conf; then
        sed -i "s/client_max_body_size.*/client_max_body_size ${max_upload};/" /etc/nginx/nginx.conf
    else
        # Add it inside http block
        sed -i "/http {/a\\    client_max_body_size ${max_upload};" /etc/nginx/nginx.conf
    fi

    # Test and reload NGINX
    if nginx -t 2>/dev/null; then
        systemctl reload nginx 2>/dev/null || systemctl restart nginx
        log_success "NGINX configured with max upload size: ${max_upload}"
    else
        log_warn "NGINX config test failed, but continuing (will be fixed after SSL setup)"
    fi
}

# Check and install Docker
install_docker() {
    log_info "Checking Docker installation..."

    if command -v docker &> /dev/null; then
        log_success "Docker is already installed ($(docker --version | cut -d' ' -f3 | tr -d ','))"
    else
        log_info "Installing Docker..."

        # Install prerequisites
        apt-get update -y
        apt-get install -y ca-certificates curl gnupg lsb-release

        # Add Docker's official GPG key
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg

        # Set up the repository
        echo \
          "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
          $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
          tee /etc/apt/sources.list.d/docker.list > /dev/null

        # Install Docker Engine
        apt-get update -y
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

        systemctl enable docker
        systemctl start docker

        log_success "Docker installed successfully"
    fi
}

# Check and install Docker Compose
check_docker_compose() {
    log_info "Checking Docker Compose..."

    # Check for docker compose plugin (v2)
    if docker compose version &> /dev/null; then
        log_success "Docker Compose plugin is available ($(docker compose version --short 2>/dev/null || echo 'v2'))"
        return 0
    fi

    # Check for standalone docker-compose (v1)
    if command -v docker-compose &> /dev/null; then
        log_warn "Found standalone docker-compose. Consider upgrading to Docker Compose plugin."
        log_success "Docker Compose is available ($(docker-compose version --short 2>/dev/null || echo 'v1'))"
        return 0
    fi

    # Neither found, try to install docker-compose-plugin
    log_warn "Docker Compose not found, attempting to install..."

    if command -v apt-get &> /dev/null; then
        apt-get update -y
        apt-get install -y docker-compose-plugin || {
            # Fallback: try installing standalone docker-compose
            log_warn "Plugin install failed, trying standalone docker-compose..."
            apt-get install -y docker-compose || {
                log_error "Failed to install Docker Compose. Please install manually:"
                log_error "  apt-get install docker-compose-plugin"
                log_error "  OR: apt-get install docker-compose"
                exit 1
            }
        }
    elif command -v yum &> /dev/null; then
        yum install -y docker-compose-plugin || yum install -y docker-compose || {
            log_error "Failed to install Docker Compose. Please install manually."
            exit 1
        }
    else
        log_error "Could not install Docker Compose automatically."
        log_error "Please install docker-compose-plugin or docker-compose manually."
        exit 1
    fi

    # Verify installation
    if docker compose version &> /dev/null; then
        log_success "Docker Compose plugin installed successfully"
    elif command -v docker-compose &> /dev/null; then
        log_success "Docker Compose installed successfully"
    else
        log_error "Docker Compose installation verification failed"
        exit 1
    fi
}

# Install additional dependencies
install_dependencies() {
    log_info "Installing additional dependencies..."
    apt-get install -y certbot python3-certbot-nginx qrencode jq
    log_success "Dependencies installed"
}

# Ensure SSL options file exists (created by certbot or manually)
ensure_ssl_options() {
    local ssl_options="/etc/letsencrypt/options-ssl-nginx.conf"
    local ssl_dhparams="/etc/letsencrypt/ssl-dhparams.pem"

    if [[ ! -f "$ssl_options" ]]; then
        log_info "Creating SSL options file..."
        mkdir -p /etc/letsencrypt

        cat > "$ssl_options" <<'SSLOPTS'
# Certbot SSL options for NGINX
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;

ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;

ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384";
SSLOPTS
        log_success "SSL options file created"
    fi

    if [[ ! -f "$ssl_dhparams" ]]; then
        log_info "Creating DH parameters (this may take a moment)..."
        openssl dhparam -out "$ssl_dhparams" 2048 2>/dev/null
        log_success "DH parameters created"
    fi
}

# Setup SSL certificate
setup_ssl() {
    local domain=$1
    local email=$2

    log_info "Setting up SSL certificate for ${domain}..."

    # Create temporary NGINX config for ACME challenge
    cat > "/etc/nginx/sites-available/${domain}-acme" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }

    location / {
        return 404;
    }
}
EOF

    mkdir -p /var/www/letsencrypt
    ln -sf "/etc/nginx/sites-available/${domain}-acme" "/etc/nginx/sites-enabled/${domain}"
    nginx -t && systemctl reload nginx

    # Obtain certificate
    certbot certonly --webroot -w /var/www/letsencrypt \
        -d "$domain" --agree-tos -m "$email" --non-interactive

    # Remove temporary config
    rm -f "/etc/nginx/sites-enabled/${domain}"
    rm -f "/etc/nginx/sites-available/${domain}-acme"

    log_success "SSL certificate obtained for ${domain}"
}

# Create secure landing page for when ProxyPilot is secured/stopped
create_secure_landing_page() {
    local install_dir=$1

    log_info "Creating secure landing page..."

    mkdir -p "${install_dir}/secured"

    cat > "${install_dir}/secured/index.html" <<'SECUREDHTML'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ProxyPilot - Secured</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            color: #e2e8f0;
        }
        .container {
            text-align: center;
            padding: 3rem;
            max-width: 500px;
        }
        .shield-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 2rem;
            fill: #22c55e;
        }
        h1 {
            font-size: 2rem;
            font-weight: 600;
            margin-bottom: 1rem;
            color: #22c55e;
        }
        p {
            font-size: 1.1rem;
            color: #94a3b8;
            line-height: 1.6;
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            margin-top: 2rem;
            padding: 0.5rem 1rem;
            background: rgba(34, 197, 94, 0.1);
            border: 1px solid rgba(34, 197, 94, 0.3);
            border-radius: 9999px;
            font-size: 0.875rem;
            color: #22c55e;
        }
        .pulse {
            width: 8px;
            height: 8px;
            background: #22c55e;
            border-radius: 50%;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
    </style>
</head>
<body>
    <div class="container">
        <svg class="shield-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="2" fill="none"/>
            <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <h1>ProxyPilot has been secured.</h1>
        <p>The admin dashboard has been intentionally taken offline for security purposes. All configured services continue to operate normally.</p>
        <div class="status-badge">
            <span class="pulse"></span>
            Secure Mode Active
        </div>
    </div>
</body>
</html>
SECUREDHTML

    log_success "Secure landing page created"
}

# Create ProxyPilot NGINX config
create_proxypilot_nginx_config() {
    local domain=$1
    local port=$2

    log_info "Creating NGINX configuration for ProxyPilot..."

    cat > "/etc/nginx/sites-available/${domain}" <<EOF
# ProxyPilot Admin Dashboard
# Domain: ${domain}

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Secure landing page location (shown when backend is down)
    location = /secured.html {
        internal;
        root ${INSTALL_DIR}/secured;
        try_files /index.html =503;
    }

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300;
        proxy_connect_timeout 60;
        proxy_send_timeout 300;

        # Show secure landing page when backend is unavailable
        proxy_intercept_errors on;
        error_page 502 503 504 = /secured.html;
    }
}
EOF

    ln -sf "/etc/nginx/sites-available/${domain}" "/etc/nginx/sites-enabled/${domain}"
    nginx -t && systemctl reload nginx

    log_success "NGINX configuration created for ${domain}"
}

# Create environment file
create_env_file() {
    local install_dir=$1
    local port=$2
    local admin_user=$3
    local admin_pass=$4
    local totp_secret=$5
    local domain=$6
    local jwt_secret=$(generate_password 64)
    local session_secret=$(generate_password 64)

    log_info "Creating environment configuration..."

    cat > "${install_dir}/.env" <<EOF
# ProxyPilot Configuration
# Generated on $(date)

# Server Configuration
PORT=${port}
NODE_ENV=production
DOMAIN=${domain}

# Authentication
JWT_SECRET=${jwt_secret}
SESSION_SECRET=${session_secret}

# Admin User (hashed on first run)
ADMIN_USERNAME=${admin_user}
ADMIN_PASSWORD=${admin_pass}
ADMIN_TOTP_SECRET=${totp_secret}

# Database
DATABASE_PATH=/data/proxypilot.db

# NGINX Configuration Path
NGINX_SITES_AVAILABLE=/etc/nginx/sites-available
NGINX_SITES_ENABLED=/etc/nginx/sites-enabled
EOF

    chmod 600 "${install_dir}/.env"
    log_success "Environment file created"
}

# Create Docker Compose file
create_docker_compose() {
    local install_dir=$1
    local port=$2

    log_info "Creating Docker Compose configuration..."

    cat > "${install_dir}/docker-compose.yml" <<EOF
version: '3.8'

services:
  proxypilot:
    build:
      context: ./admin
      dockerfile: Dockerfile
    container_name: proxypilot-admin
    restart: unless-stopped
    privileged: true
    pid: host
    ports:
      - "127.0.0.1:${port}:${port}"
    volumes:
      - ./data:/data
      - /etc/nginx/sites-available:/etc/nginx/sites-available
      - /etc/nginx/sites-enabled:/etc/nginx/sites-enabled
      - /etc/letsencrypt:/etc/letsencrypt
      - /var/www/letsencrypt:/var/www/letsencrypt
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - NODE_ENV=production
      - SERVICES_DATA_DIR=/data/services
      - NGINX_STATIC_ROOT=${INSTALL_DIR}/data/services
      - DOCKER_CONTAINER=true
    env_file:
      - .env
    networks:
      - proxypilot-net
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${port}/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

networks:
  proxypilot-net:
    driver: bridge
EOF

    log_success "Docker Compose file created"
}

# Main installation function
main() {
    clear
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║                                                               ║"
    echo "║     🚀 ProxyPilot Admin Dashboard Installer                   ║"
    echo "║                                                               ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""

    check_root

    # Get installation directory
    INSTALL_DIR="/opt/proxypilot"

    # Gather user input
    echo -e "${CYAN}=== Configuration ===${NC}"
    echo ""

    # NGINX Max Upload Size
    read -rp "Enter default NGINX max upload size [1G]: " MAX_UPLOAD
    MAX_UPLOAD=${MAX_UPLOAD:-1G}

    # Port with availability check
    DEFAULT_PORT=3001
    if is_port_in_use $DEFAULT_PORT; then
        SUGGESTED_PORT=$(find_available_port $DEFAULT_PORT)
        log_warn "Port $DEFAULT_PORT is already in use!"
        if [[ -n "$SUGGESTED_PORT" ]]; then
            echo -e "  Suggested available port: ${GREEN}${SUGGESTED_PORT}${NC}"
        fi
    fi

    while true; do
        read -rp "Enter port for ProxyPilot dashboard [${SUGGESTED_PORT:-$DEFAULT_PORT}]: " PORT
        PORT=${PORT:-${SUGGESTED_PORT:-$DEFAULT_PORT}}

        if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 ]] || [[ "$PORT" -gt 65535 ]]; then
            log_error "Invalid port number. Please enter a number between 1 and 65535."
            continue
        fi

        if is_port_in_use $PORT; then
            log_warn "Port $PORT is already in use!"
            NEXT_PORT=$(find_available_port $PORT)
            if [[ -n "$NEXT_PORT" ]]; then
                echo -e "  Next available port: ${GREEN}${NEXT_PORT}${NC}"
            fi
            read -rp "Use a different port? [Y/n]: " CHANGE_PORT
            CHANGE_PORT=${CHANGE_PORT:-Y}
            if [[ "$CHANGE_PORT" =~ ^[Nn]$ ]]; then
                log_warn "Proceeding with port $PORT (may cause conflicts)"
                break
            fi
        else
            break
        fi
    done

    # Admin username
    read -rp "Enter admin username: " ADMIN_USER
    while [[ -z "$ADMIN_USER" ]]; do
        log_error "Username cannot be empty"
        read -rp "Enter admin username: " ADMIN_USER
    done

    # Generate password
    ADMIN_PASS=$(generate_password 24)
    echo ""
    log_info "Generated secure password for admin user"

    # Generate TOTP secret
    TOTP_SECRET=$(generate_totp_secret)

    # Domain
    read -rp "Enter domain for admin dashboard (e.g., admin.example.com): " DOMAIN
    while [[ -z "$DOMAIN" ]]; do
        log_error "Domain cannot be empty"
        read -rp "Enter domain for admin dashboard: " DOMAIN
    done

    # Email for Let's Encrypt
    read -rp "Enter email for Let's Encrypt SSL: " EMAIL
    while [[ -z "$EMAIL" ]]; do
        log_error "Email cannot be empty"
        read -rp "Enter email for Let's Encrypt SSL: " EMAIL
    done

    echo ""
    echo -e "${CYAN}=== Installation Summary ===${NC}"
    echo "  Max Upload Size: ${MAX_UPLOAD}"
    echo "  Dashboard Port: ${PORT}"
    echo "  Admin Username: ${ADMIN_USER}"
    echo "  Domain: ${DOMAIN}"
    echo "  Email: ${EMAIL}"
    echo ""

    read -rp "Proceed with installation? [Y/n]: " CONFIRM
    CONFIRM=${CONFIRM:-Y}
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        log_warn "Installation cancelled"
        exit 0
    fi

    echo ""
    echo -e "${CYAN}=== Starting Installation ===${NC}"
    echo ""

    # Install components
    install_nginx
    configure_nginx_global "$MAX_UPLOAD"
    install_docker
    check_docker_compose
    install_dependencies

    # Create installation directory
    log_info "Creating installation directory..."
    mkdir -p "$INSTALL_DIR/data"

    # Copy admin files
    log_info "Copying ProxyPilot files..."
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cp -r "${SCRIPT_DIR}/admin" "$INSTALL_DIR/"

    # Create configuration files
    create_env_file "$INSTALL_DIR" "$PORT" "$ADMIN_USER" "$ADMIN_PASS" "$TOTP_SECRET" "$DOMAIN"
    create_docker_compose "$INSTALL_DIR" "$PORT"

    # Ensure SSL options file exists before setting up SSL
    ensure_ssl_options

    # Setup SSL
    setup_ssl "$DOMAIN" "$EMAIL"

    # Create secure landing page
    create_secure_landing_page "$INSTALL_DIR"

    # Create NGINX config
    create_proxypilot_nginx_config "$DOMAIN" "$PORT"

    # Build and start Docker container
    log_info "Building and starting ProxyPilot..."
    cd "$INSTALL_DIR"
    run_docker_compose build
    run_docker_compose up -d

    # Wait for container to be healthy
    log_info "Waiting for ProxyPilot to start..."
    sleep 10

    # Copy reset script
    cp "${SCRIPT_DIR}/reset.sh" "$INSTALL_DIR/"
    chmod +x "$INSTALL_DIR/reset.sh"

    # Final output
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                                                                ║${NC}"
    echo -e "${GREEN}║     ✅ ProxyPilot Installation Complete!                       ║${NC}"
    echo -e "${GREEN}║                                                                ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo ""
    echo -e "${YELLOW}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║${NC}              ${RED}⚠️  SAVE THESE CREDENTIALS NOW ⚠️${NC}                ${YELLOW}║${NC}"
    echo -e "${YELLOW}╠════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${YELLOW}║${NC}                                                                ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}  Dashboard URL: ${CYAN}https://${DOMAIN}${NC}"
    echo -e "${YELLOW}║${NC}                                                                ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}  Username: ${GREEN}${ADMIN_USER}${NC}"
    echo -e "${YELLOW}║${NC}                                                                ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}  Password:                                                     ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}  ${GREEN}${ADMIN_PASS}${NC}"
    echo -e "${YELLOW}║${NC}                                                                ${YELLOW}║${NC}"
    echo -e "${YELLOW}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}                      ${CYAN}TOTP SETUP${NC}                                 ${CYAN}║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
    generate_totp_qr "$TOTP_SECRET" "$ADMIN_USER"
    echo ""
    echo ""
    # Determine correct docker compose command for display
    local dc_cmd=$(get_docker_compose_cmd)

    echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║${NC}                    ${BLUE}USEFUL COMMANDS${NC}                              ${BLUE}║${NC}"
    echo -e "${BLUE}╠════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${BLUE}║${NC}                                                                ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}  View logs:                                                    ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}    ${dc_cmd} -f ${INSTALL_DIR}/docker-compose.yml logs -f"
    echo -e "${BLUE}║${NC}                                                                ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}  Restart:                                                      ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}    ${dc_cmd} -f ${INSTALL_DIR}/docker-compose.yml restart"
    echo -e "${BLUE}║${NC}                                                                ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}  Start (after kill switch):                                    ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}    sudo docker start proxypilot-admin"
    echo -e "${BLUE}║${NC}                                                                ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}  Reset password/TOTP (if you lose access):                     ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}    sudo ${INSTALL_DIR}/reset.sh"
    echo -e "${BLUE}║${NC}                                                                ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}  Show saved credentials:                                       ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC}    sudo ${INSTALL_DIR}/reset.sh show"
    echo -e "${BLUE}║${NC}                                                                ${BLUE}║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Configuration files are in: ${INSTALL_DIR}${NC}"
    echo ""
    echo -e "${YELLOW}Press Enter to close...${NC}"
    read -r
}

# Run main function
main "$@"
