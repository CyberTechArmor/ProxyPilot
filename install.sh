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

# Check and install curl if not present
check_curl() {
    if ! command -v curl &> /dev/null; then
        log_info "curl not found, installing..."
        apt-get update -y
        apt-get install -y curl
        log_success "curl installed"
    fi
}

# Check and install sysstat (provides sar command for system monitoring)
check_sysstat() {
    if ! command -v sar &> /dev/null; then
        log_info "sysstat (sar) not found, installing for system monitoring..."
        if command -v apt-get &> /dev/null; then
            apt-get update -y
            apt-get install -y sysstat
        elif command -v yum &> /dev/null; then
            yum install -y sysstat
        elif command -v dnf &> /dev/null; then
            dnf install -y sysstat
        fi
        # Enable sysstat data collection
        if [ -f /etc/default/sysstat ]; then
            sed -i 's/ENABLED="false"/ENABLED="true"/' /etc/default/sysstat
            systemctl enable sysstat 2>/dev/null || true
            systemctl start sysstat 2>/dev/null || true
        fi
        log_success "sysstat installed"
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

# Check and install Incus (LXC container manager)
install_incus() {
    log_info "Checking Incus installation..."

    if command -v incus &> /dev/null; then
        log_success "Incus is already installed ($(incus version 2>/dev/null || echo 'unknown'))"
    else
        log_info "Installing Incus..."

        # Try installing from default repos first (Ubuntu 24.04+, Debian Trixie+)
        apt-get update -y
        if apt-get install -y incus 2>/dev/null; then
            log_success "Incus installed from default repositories"
        else
            # Fall back to Zabbly repository (official recommended source for Incus)
            log_info "Incus not in default repos, adding Zabbly repository..."

            # Install prerequisites
            apt-get install -y curl gpg

            # Create keyrings directory
            mkdir -p /etc/apt/keyrings/

            # Add Zabbly GPG key
            curl -fsSL https://pkgs.zabbly.com/key.asc | gpg --dearmor -o /etc/apt/keyrings/zabbly.gpg

            # Determine codename
            local codename
            codename=$(. /etc/os-release && echo "${VERSION_CODENAME}")

            # Add Zabbly repository
            cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<REPOEOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: ${codename}
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.gpg
REPOEOF

            apt-get update -y
            apt-get install -y incus

            log_success "Incus installed from Zabbly repository"
        fi
    fi

    # Enable and start Incus daemon
    systemctl enable incus 2>/dev/null || true
    if ! systemctl is-active --quiet incus; then
        log_info "Starting Incus daemon..."
        systemctl start incus
    fi

    # Run minimal initialization if not already initialized
    if ! incus storage list --format json 2>/dev/null | grep -q '"name"'; then
        log_info "Initializing Incus with minimal configuration..."
        incus admin init --minimal
        log_success "Incus initialized"
    else
        log_success "Incus is already initialized"
    fi

    # Verify Incus is running
    if incus version &> /dev/null; then
        log_success "Incus is running ($(incus version))"
    else
        log_error "Incus installation succeeded but daemon is not responding"
        log_error "Try: systemctl status incus"
    fi
}

# Check and install Caddy
install_caddy() {
    log_info "Checking Caddy installation..."

    if command -v caddy &> /dev/null; then
        log_success "Caddy is already installed ($(caddy version 2>/dev/null | head -1))"
    else
        log_info "Installing Caddy..."
        apt-get update -y
        apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -y
        apt-get install -y caddy
        log_success "Caddy installed successfully"
    fi

    # Create directories with correct ownership for caddy user.
    # /etc/caddy/sites is the ProxyPilot-managed dir (regenerated on
    # every service edit). /etc/caddy/custom is the operator-owned
    # extension dir — ProxyPilot creates it but never rewrites files
    # in it. Both get imported by the main Caddyfile.
    mkdir -p /etc/caddy/sites
    mkdir -p /etc/caddy/custom
    mkdir -p /var/log/caddy
    chown caddy:caddy /var/log/caddy 2>/dev/null || true

    # Drop a one-time README into /etc/caddy/custom so the operator
    # discovers the extension pattern. Backend's ensureCaddyStructure()
    # would also create this, but doing it at install time means a
    # fresh deploy is correct from boot 1.
    if [ ! -f /etc/caddy/custom/README.md ]; then
        cat > /etc/caddy/custom/README.md <<'CUSTOMEOF'
# ProxyPilot — Operator Custom Caddy Snippets

Files matching `*.caddy` in this directory are imported into the main
Caddyfile but never touched by ProxyPilot. Use this directory for
one-off route exceptions, experimental Caddy modules, or imports from
other config trees.

ProxyPilot regenerates files in /etc/caddy/sites on every service
edit; anything placed there is lost. Put hand-written config here
instead.

IMPORTANT: only files with the `.caddy` extension are imported.
README.md, .bak files, and editor swap files are ignored. Name your
snippets with a `.caddy` extension — for example, `mycustom.caddy`.

After editing, validate and reload:

    caddy adapt --config /etc/caddy/Caddyfile > /dev/null
    caddy reload --config /etc/caddy/Caddyfile
CUSTOMEOF
    fi

    # Create main Caddyfile
    log_info "Configuring Caddyfile..."
    cat > /etc/caddy/Caddyfile <<'CADDYEOF'
# ProxyPilot Caddy Configuration
{
    admin localhost:2019
}

import /etc/caddy/sites/*
import /etc/caddy/custom/*.caddy
CADDYEOF

    # Enable Caddy but don't start yet - will start after site config is written
    systemctl enable caddy 2>/dev/null || true
    # Stop any running instance so ports are free for later
    systemctl stop caddy 2>/dev/null || true
    log_success "Caddy is installed and enabled (will start after configuration)"
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

        # Pick the right Docker repo path. Hard-coding linux/ubuntu
        # 404s on Debian (e.g. trixie has no Ubuntu equivalent), so
        # branch on /etc/os-release's ID. Both distros use
        # VERSION_CODENAME for the suite; only the path between
        # download.docker.com/linux/ and the codename differs.
        local docker_id docker_codename
        docker_id=$(. /etc/os-release && echo "${ID:-}")
        docker_codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-}")
        case "${docker_id}" in
            debian|ubuntu) ;;
            *)
                log_error "Unsupported distro '${docker_id}' for Docker (need debian or ubuntu)"
                exit 1
                ;;
        esac
        if [[ -z "${docker_codename}" ]]; then
            log_error "VERSION_CODENAME missing from /etc/os-release; cannot configure Docker apt source"
            exit 1
        fi

        # Add Docker's official GPG key
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/${docker_id}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg

        # Set up the repository
        echo \
          "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${docker_id} \
          ${docker_codename} stable" | \
          tee /etc/apt/sources.list.d/docker.list > /dev/null

        # Install Docker Engine
        apt-get update -y
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

        systemctl enable docker
        systemctl start docker

        log_success "Docker installed successfully (${docker_id} ${docker_codename})"
    fi
}

# Check and install Docker Compose
check_docker_compose() {
    log_info "Checking Docker Compose..."

    # Check for docker compose plugin (v2) - PREFERRED
    if docker compose version &> /dev/null; then
        log_success "Docker Compose plugin is available ($(docker compose version --short 2>/dev/null || echo 'v2'))"
        DOCKER_COMPOSE_CMD="docker compose"
        return 0
    fi

    # Check for standalone docker-compose (v1) - has compatibility issues with newer Docker
    if command -v docker-compose &> /dev/null; then
        local dc_version=$(docker-compose version --short 2>/dev/null || echo "1.0.0")
        log_warn "Found standalone docker-compose v${dc_version}"
        log_warn "This version may have compatibility issues (KeyError: ContainerConfig)"
        log_info "Installing Docker Compose plugin (v2) for better compatibility..."

        # Try to install the plugin version
        if command -v apt-get &> /dev/null; then
            apt-get update -y
            if apt-get install -y docker-compose-plugin 2>/dev/null; then
                # Verify plugin works
                if docker compose version &> /dev/null; then
                    log_success "Docker Compose plugin installed ($(docker compose version --short 2>/dev/null || echo 'v2'))"
                    DOCKER_COMPOSE_CMD="docker compose"
                    return 0
                fi
            fi
        fi

        # If plugin install failed, continue with v1 but warn
        log_warn "Could not install Docker Compose plugin, using standalone version"
        log_warn "If you see 'ContainerConfig' errors, run: apt-get install docker-compose-plugin"
        DOCKER_COMPOSE_CMD="docker-compose"
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

    # Verify installation and set command
    if docker compose version &> /dev/null; then
        log_success "Docker Compose plugin installed successfully"
        DOCKER_COMPOSE_CMD="docker compose"
    elif command -v docker-compose &> /dev/null; then
        log_success "Docker Compose installed successfully"
        DOCKER_COMPOSE_CMD="docker-compose"
    else
        log_error "Docker Compose installation verification failed"
        exit 1
    fi
}

# Install additional dependencies
install_dependencies() {
    log_info "Installing additional dependencies..."
    apt-get install -y qrencode jq
    log_success "Dependencies installed"
}

# Required Go toolchain version for building the host-side agent.
# Bumping this is a deliberate decision — anything older predates
# language features the agent relies on.
AGENT_GO_VERSION="1.21.13"

# Print the installed Go version (e.g. "1.22.4") on stdout, or empty
# string if Go isn't available. Used by the version comparison below
# so we don't reinstall a working toolchain.
detect_go_version() {
    local raw
    if raw=$(go version 2>/dev/null); then
        # `go version` prints e.g. `go version go1.22.4 linux/amd64`.
        echo "$raw" | awk '{print $3}' | sed 's/^go//'
    elif raw=$(/usr/local/go/bin/go version 2>/dev/null); then
        echo "$raw" | awk '{print $3}' | sed 's/^go//'
    else
        echo ""
    fi
}

# Returns 0 if $1 (have) >= $2 (want), 1 otherwise. Pure-bash semver
# compare on dotted numeric strings.
go_version_ge() {
    local have="$1" want="$2"
    [[ -z "$have" ]] && return 1
    # `sort -V` on two lines: if `want` sorts first or equal, we're OK.
    if [[ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -n1)" == "$want" ]]; then
        return 0
    fi
    return 1
}

# Install (or upgrade) the Go toolchain to AGENT_GO_VERSION when the
# system Go is missing or too old. Drops the official upstream
# tarball into /usr/local/go and exposes it via /usr/local/go/bin/go.
# Idempotent: re-running a second time is a no-op.
ensure_go_toolchain() {
    local current
    current=$(detect_go_version)
    if go_version_ge "$current" "$AGENT_GO_VERSION"; then
        log_info "Go ${current} already installed (>= ${AGENT_GO_VERSION})"
        return 0
    fi

    log_info "Installing Go ${AGENT_GO_VERSION} for proxypilot-agent build..."
    local arch
    case "$(uname -m)" in
        x86_64|amd64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        armv7l|armv6l) arch="armv6l" ;;
        *) log_error "Unsupported architecture for Go install: $(uname -m)"; exit 1 ;;
    esac

    local tarball="go${AGENT_GO_VERSION}.linux-${arch}.tar.gz"
    local url="https://go.dev/dl/${tarball}"
    local tmpdir
    tmpdir=$(mktemp -d)
    if ! curl -fsSL -o "${tmpdir}/${tarball}" "$url"; then
        log_error "Failed to download Go from $url"
        rm -rf "$tmpdir"
        exit 1
    fi
    rm -rf /usr/local/go
    tar -C /usr/local -xzf "${tmpdir}/${tarball}"
    rm -rf "$tmpdir"

    local installed
    installed=$(detect_go_version)
    if ! go_version_ge "$installed" "$AGENT_GO_VERSION"; then
        log_error "Go installation appears to have failed (detected: '${installed}')"
        exit 1
    fi
    log_success "Go ${installed} installed at /usr/local/go"
}

# Resolve a working `go` binary path, preferring an existing one in
# PATH so an operator-managed install (Snap, Homebrew, apt) wins.
resolve_go_bin() {
    if command -v go >/dev/null 2>&1; then
        command -v go
    elif [[ -x /usr/local/go/bin/go ]]; then
        echo "/usr/local/go/bin/go"
    else
        echo ""
    fi
}

# Install the host-side agent — Phase A scaffold of the future B1
# fix. The agent is dual-tracked in this phase: the systemd service
# runs on the host and binds /run/proxypilot-agent.sock, but no
# production code path inside the dashboard container actually calls
# it yet. nsenter still drives caddy / incus / docker. Phases B-E
# migrate methods onto the agent behind feature flags; Phase F drops
# `privileged: true` once those flags have flipped and burned in.
#
# This function is idempotent — every step gates on "already done"
# before mutating, so re-runs of install.sh (or update.sh, which
# delegates to the same building blocks) leave a working install
# alone.
install_proxypilot_agent() {
    local script_dir=$1
    local agent_src="${script_dir}/cmd/agent"

    if [[ ! -d "$agent_src" ]]; then
        log_warn "cmd/agent not found at ${agent_src}, skipping agent install"
        return 0
    fi

    log_info "Installing ProxyPilot host-side agent (Phase A scaffold)..."

    # 1. Toolchain.
    ensure_go_toolchain
    local go_bin
    go_bin=$(resolve_go_bin)
    if [[ -z "$go_bin" ]]; then
        log_error "Go toolchain not found after install; refusing to continue"
        exit 1
    fi

    # 2. System user + group. The systemd unit runs ExecStart as this
    #    user; the Docker container will join the group via group_add
    #    in docker-compose.yml so it can read the 0660 socket.
    if ! getent group proxypilot-agent >/dev/null 2>&1; then
        groupadd --system proxypilot-agent
        log_info "Created system group: proxypilot-agent"
    fi
    if ! getent passwd proxypilot-agent >/dev/null 2>&1; then
        useradd --system --gid proxypilot-agent --no-create-home \
            --home-dir /nonexistent --shell /usr/sbin/nologin \
            proxypilot-agent
        log_info "Created system user: proxypilot-agent"
    fi

    # 3. Build the binary. `go build` is content-addressable enough
    #    that re-running on an unchanged source tree is fast (cache
    #    hit), so we don't bother gating on mtime.
    log_info "Building proxypilot-agent binary..."
    (
        cd "$agent_src"
        # GOFLAGS=-mod=mod so the build doesn't fail under a missing
        # vendor/ tree; the module has zero external deps so this is
        # equivalent to `-mod=readonly` in practice.
        GOFLAGS=-mod=mod "$go_bin" build -o /usr/local/bin/proxypilot-agent .
    )
    chmod 0755 /usr/local/bin/proxypilot-agent
    log_success "Agent binary installed at /usr/local/bin/proxypilot-agent"

    # 4. Systemd unit. Compare deploy/proxypilot-agent.service against
    #    the deployed copy and only rewrite + daemon-reload on diff.
    local unit_src="${script_dir}/deploy/proxypilot-agent.service"
    local unit_dst="/etc/systemd/system/proxypilot-agent.service"
    if [[ ! -f "$unit_src" ]]; then
        log_error "Missing systemd unit at ${unit_src}"
        exit 1
    fi
    if ! cmp -s "$unit_src" "$unit_dst"; then
        cp "$unit_src" "$unit_dst"
        chmod 0644 "$unit_dst"
        systemctl daemon-reload
        log_info "Installed systemd unit: ${unit_dst}"
    fi

    # 5. Enable + start. After a binary refresh we restart so the new
    #    bytes are running; on a first install `--now` covers both.
    if ! systemctl is-enabled --quiet proxypilot-agent 2>/dev/null; then
        systemctl enable proxypilot-agent
    fi
    systemctl restart proxypilot-agent
    log_success "proxypilot-agent service started"
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

# Create ProxyPilot Caddy config
create_proxypilot_caddy_config() {
    local domain=$1
    local port=$2
    local email=$3

    log_info "Creating Caddy site configuration for ProxyPilot..."

    mkdir -p /etc/caddy/sites
    mkdir -p /etc/caddy/custom
    mkdir -p /var/log/caddy

    # Update the global Caddyfile with ACME email for automatic TLS.
    # Caddy stores certs in its default data dir: /var/lib/caddy/.local/share/caddy/
    # This persists across ProxyPilot reinstalls since cleanup.sh preserves /var/lib/caddy.
    # The custom-import line is identical to the docker-path Caddyfile above
    # (operator-owned snippets that ProxyPilot never rewrites).
    cat > /etc/caddy/Caddyfile <<GLOBALEOF
# ProxyPilot Caddy Configuration
{
    admin localhost:2019
    email ${email}
}

import /etc/caddy/sites/*
import /etc/caddy/custom/*.caddy
GLOBALEOF

    cat > "/etc/caddy/sites/${domain}" <<EOF
# ProxyPilot Admin Dashboard
# Domain: ${domain}

${domain} {
    reverse_proxy 127.0.0.1:${port}

    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    log {
        output file /var/log/caddy/${domain}.log
    }
}
EOF

    # Ensure Caddy directories have correct ownership (caddy runs as 'caddy' user)
    mkdir -p /var/lib/caddy /var/log/caddy
    chown -R caddy:caddy /var/lib/caddy /var/log/caddy 2>/dev/null || true

    # Remove any stray placeholder files
    rm -f /etc/caddy/sites/.keep 2>/dev/null || true

    # Validate config syntax using 'caddy adapt' (never binds ports)
    log_info "Validating Caddy configuration..."
    if ! caddy adapt --config /etc/caddy/Caddyfile > /dev/null 2>&1; then
        log_error "Caddy config syntax error!"
        caddy adapt --config /etc/caddy/Caddyfile 2>&1 || true
    else
        log_success "Caddy configuration is valid"
    fi

    # The default Caddy systemd unit has ExecStartPre=caddy validate which
    # starts listeners and can fail with port conflicts. Override it to skip
    # the validate step (we already validated with 'caddy adapt' above).
    log_info "Configuring Caddy systemd service..."
    mkdir -p /etc/systemd/system/caddy.service.d
    cat > /etc/systemd/system/caddy.service.d/override.conf <<'OVERRIDE'
[Service]
# Clear the default ExecStartPre which runs 'caddy validate' and binds ports
ExecStartPre=
OVERRIDE
    systemctl daemon-reload

    # Ensure no stale Caddy processes
    systemctl stop caddy 2>/dev/null || true
    pkill -9 caddy 2>/dev/null || true
    fuser -k 80/tcp 2>/dev/null || true
    fuser -k 443/tcp 2>/dev/null || true
    sleep 1

    # Start Caddy
    log_info "Starting Caddy..."
    if ! systemctl start caddy; then
        log_warn "Caddy failed to start. Checking logs..."
        journalctl -u caddy --no-pager -n 15 2>/dev/null || true
        # One more attempt after full cleanup
        sleep 2
        fuser -k 80/tcp 2>/dev/null || true
        fuser -k 443/tcp 2>/dev/null || true
        sleep 1
        log_info "Retrying..."
        systemctl start caddy
    fi

    sleep 3

    # Verify Caddy is running
    if ! systemctl is-active --quiet caddy; then
        log_error "Caddy failed to start! Logs:"
        journalctl -u caddy --no-pager -n 20 2>/dev/null || true
    else
        log_success "Caddy is running"
    fi

    # Wait for TLS certificate
    log_info "Waiting for Caddy to obtain TLS certificate for ${domain}..."
    log_info "(Caddy contacts Let's Encrypt - this typically takes 10-30 seconds)"
    for i in $(seq 1 30); do
        # Any HTTPS response (even 502 = backend down) means cert was obtained
        local http_code
        http_code=$(curl -sSk --max-time 5 -o /dev/null -w '%{http_code}' "https://${domain}" 2>/dev/null || echo "000")
        if [[ "$http_code" != "000" ]]; then
            log_success "TLS certificate obtained for ${domain} (HTTPS responding: HTTP ${http_code})"
            break
        fi
        if [ "$i" -eq 15 ]; then
            log_info "Still waiting... Caddy logs:"
            journalctl -u caddy --no-pager -n 5 --since "1 min ago" 2>/dev/null || true
        fi
        if [ "$i" -eq 30 ]; then
            log_warn "TLS certificate not ready after 60s. Caddy logs:"
            journalctl -u caddy --no-pager -n 15 2>/dev/null || true
            echo ""
            log_warn "Common causes:"
            log_warn "  - DNS for ${domain} does not point to this server's IP"
            log_warn "  - Firewall blocking ports 80 or 443"
            log_warn "  - Another service using ports 80 or 443"
            log_warn ""
            log_warn "Caddy will keep retrying automatically."
        fi
        sleep 2
    done
}

# Create environment file
create_env_file() {
    local install_dir=$1
    local port=$2
    local admin_user=$3
    local admin_pass=$4
    local totp_secret=$5
    local domain=$6
    # Preserve existing secrets if .env already exists. Re-running
    # install.sh on top of an existing deployment must NOT regenerate
    # JWT_SECRET / SESSION_SECRET / TOTP_ENCRYPTION_KEY — the last of
    # those, in particular, is the only thing keeping existing TOTP
    # secrets decryptable. Losing it forces every user to re-enroll.
    local jwt_secret=""
    local session_secret=""
    local totp_encryption_key=""
    if [ -f "${install_dir}/.env" ]; then
        log_info "Existing .env detected — preserving secrets"
        # `|| true` on each pipe: install.sh runs under `set -euo pipefail`,
        # so if grep finds no match the pipe exits non-zero and pipefail
        # propagates it through the assignment, killing the install. This
        # bites when an operator hand-edits an .env that previously got
        # poisoned by the (now-fixed) sync_env_keys log-pollution bug —
        # they may have removed a key entirely. Defensive guards make the
        # missing-key path fall through to the regenerate-below logic.
        # shellcheck disable=SC1090
        jwt_secret=$(grep -E '^JWT_SECRET=' "${install_dir}/.env" | head -1 | cut -d= -f2- || true)
        session_secret=$(grep -E '^SESSION_SECRET=' "${install_dir}/.env" | head -1 | cut -d= -f2- || true)
        totp_encryption_key=$(grep -E '^TOTP_ENCRYPTION_KEY=' "${install_dir}/.env" | head -1 | cut -d= -f2- || true)
    fi

    [ -z "$jwt_secret" ]     && jwt_secret=$(generate_password 64)
    [ -z "$session_secret" ] && session_secret=$(generate_password 64)
    # 32 bytes = 64 hex chars. AES-256-GCM key for at-rest secrets.
    # Fallback to od if openssl is missing (xxd is not part of base
    # Debian; od is in coreutils so always present).
    if [ -z "$totp_encryption_key" ]; then
        if command -v openssl &>/dev/null; then
            totp_encryption_key=$(openssl rand -hex 32)
        else
            totp_encryption_key=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
        fi
    fi

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

# DB-at-rest encryption key for TOTP secrets. WARNING: losing this key
# means existing TOTP secrets cannot be decrypted — every user will need
# to re-enroll their authenticator. Back this up alongside your DB.
TOTP_ENCRYPTION_KEY=${totp_encryption_key}

# Admin User (hashed on first run)
ADMIN_USERNAME=${admin_user}
ADMIN_PASSWORD=${admin_pass}
ADMIN_TOTP_SECRET=${totp_secret}

# Database — lives in a dedicated subdirectory so the surrounding
# data/ directory can stay world-traversable for Caddy.
DATABASE_PATH=/data/db/proxypilot.db

# Caddy Configuration Path
CADDY_SITES_DIR=/etc/caddy/sites
CADDY_CONFIG_FILE=/etc/caddy/Caddyfile
CADDY_CUSTOM_DIR=/etc/caddy/custom
ACME_EMAIL=${ACME_EMAIL}
EOF

    chmod 600 "${install_dir}/.env"
    log_success "Environment file created"
}

# Create Docker Compose file
create_docker_compose() {
    local install_dir=$1
    local port=$2

    log_info "Creating Docker Compose configuration..."

    # Resolve the proxypilot-agent group's numeric GID on the host so
    # the container can join it via group_add. We use the GID rather
    # than the name because Docker resolves group_add names against
    # /etc/group inside the container — the proxypilot-admin image
    # doesn't carry a proxypilot-agent group, and even if we baked
    # one in the GID would have to match the host's, which differs
    # per install. A numeric GID is portable and works without
    # touching the Dockerfile.
    local agent_gid=""
    if getent group proxypilot-agent >/dev/null 2>&1; then
        agent_gid=$(getent group proxypilot-agent | cut -d: -f3)
    fi

    cat > "${install_dir}/docker-compose.yml" <<EOF
version: '3.8'

services:
  proxypilot:
    build:
      context: ./admin
      dockerfile: Dockerfile
    container_name: proxypilot-admin
    restart: always
    # ProxyPilot drives caddy / incus / docker / git / npm on the host
    # via `nsenter -t 1` from inside this container. That requires
    # crossing every namespace barrier the host kernel enforces — PID
    # (covered by pid:host), then mnt/uts/net/ipc (covered by setns
    # syscalls), plus reading /proc/1/ns/* (gated by AppArmor + ptrace).
    # The kernel-level requirement is CAP_SYS_ADMIN; the userspace-
    # policy requirements are NO AppArmor profile and NO seccomp filter.
    #
    # \`privileged: true\` grants all of the above in one switch. We
    # tried a finer-grained cap_drop:ALL + cap_add:[SYS_ADMIN, SYS_PTRACE]
    # + security_opt:[no-new-privileges, apparmor:unconfined] approach
    # and it surfaced edge after edge (default seccomp blocks setns
    # under some conditions, AppArmor differs by distro, etc.) without
    # actually reducing the attack surface — pid:host plus the Docker
    # socket mount means a container compromise still reaches host
    # root. Restoring privileged:true gives the bulletproof posture
    # Docker has tested for a decade; the only real isolation win
    # comes from a future host-side-agent architecture that removes
    # the nsenter-from-container model entirely. Phase A scaffolds
    # that agent (see docs/features/security-completion/master-spec.md);
    # Phase F is what drops privileged:true once Phases B-E have
    # migrated every host-call onto the agent socket below.
    privileged: true
    pid: host
    ports:
      - "127.0.0.1:${port}:${port}"
    volumes:
      - ./data:/data
      - /etc/caddy/sites:/etc/caddy/sites
      - /etc/caddy/custom:/etc/caddy/custom
      - /etc/caddy/Caddyfile:/etc/caddy/Caddyfile
      - /var/run/docker.sock:/var/run/docker.sock
      # Phase A host-side agent socket (read+write — :ro would block
      # the bidirectional unix-socket traffic). Owned by the
      # proxypilot-agent group on the host; the container joins that
      # group via group_add below so it can connect.
      - /run/proxypilot-agent.sock:/run/proxypilot-agent.sock
    group_add:
      # Numeric GID of the host's proxypilot-agent group, so the
      # container's processes are members of the group that owns
      # /run/proxypilot-agent.sock (mode 0660). install.sh creates
      # the group before this file is generated.
      - "${agent_gid}"
    environment:
      - NODE_ENV=production
      - SERVICES_DATA_DIR=/data/services
      - CADDY_STATIC_ROOT=${INSTALL_DIR}/data/services
      - DOCKER_CONTAINER=true
      - PROXYPILOT_AGENT_SOCKET=/run/proxypilot-agent.sock
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

    if [[ -z "$agent_gid" ]]; then
        log_warn "proxypilot-agent group not found at compose-write time; group_add line is empty. Phase A agent will be unreachable from the container until install.sh creates the group and re-runs create_docker_compose."
    fi

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
    check_curl
    check_sysstat

    # Get installation directory
    INSTALL_DIR="/opt/proxypilot"

    # Gather user input
    echo -e "${CYAN}=== Configuration ===${NC}"
    echo ""

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

    # Password will be set via the web UI on first login
    ADMIN_PASS=""
    echo ""
    log_info "You will create your password from the web dashboard on first login"

    # TOTP will also be set up via the web UI
    TOTP_SECRET=""

    # Domain
    read -rp "Enter domain for admin dashboard (e.g., admin.example.com): " DOMAIN
    while [[ -z "$DOMAIN" ]]; do
        log_error "Domain cannot be empty"
        read -rp "Enter domain for admin dashboard: " DOMAIN
    done

    # Email for ACME (Caddy automatic TLS)
    read -rp "Enter email for TLS certificates (ACME/Let's Encrypt): " EMAIL
    while [[ -z "$EMAIL" ]]; do
        log_error "Email cannot be empty"
        read -rp "Enter email for TLS certificates: " EMAIL
    done

    echo ""
    echo -e "${CYAN}=== Installation Summary ===${NC}"
    echo "  Dashboard Port: ${PORT}"
    echo "  Admin Username: ${ADMIN_USER}"
    echo "  Domain: ${DOMAIN}"
    echo "  ACME Email: ${EMAIL}"
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
    install_caddy
    install_docker
    check_docker_compose
    install_incus
    install_dependencies

    # Create installation directory layout. Sensitive content (SQLite DB,
    # WAL/SHM, pre-update backups) lives in `data/db/` and is locked to
    # 0700 root:root. Caddy-served content lives in `data/services/` and
    # must stay world-traversable so the `caddy` user can reach it. The
    # parent `data/` is therefore 0755 — the security-sensitive material
    # is gated by the inner `db/` dir, not by the parent.
    log_info "Creating installation directory..."
    mkdir -p "$INSTALL_DIR/data/db" "$INSTALL_DIR/data/services"
    chmod 755 "$INSTALL_DIR/data" 2>/dev/null || true
    chmod 700 "$INSTALL_DIR/data/db" 2>/dev/null || true
    chmod 755 "$INSTALL_DIR/data/services" 2>/dev/null || true
    if [ -f "$INSTALL_DIR/data/db/proxypilot.db" ]; then
        chmod 600 "$INSTALL_DIR/data/db/proxypilot.db" 2>/dev/null || true
        chmod 600 "$INSTALL_DIR/data/db/proxypilot.db-wal" 2>/dev/null || true
        chmod 600 "$INSTALL_DIR/data/db/proxypilot.db-shm" 2>/dev/null || true
    fi

    # Restore service data from backup if available (from previous cleanup)
    if [[ -d "/var/lib/proxypilot/services-backup" ]] && [[ -n "$(ls -A /var/lib/proxypilot/services-backup 2>/dev/null)" ]]; then
        log_info "Restoring service data from previous installation..."
        cp -r /var/lib/proxypilot/services-backup/* "$INSTALL_DIR/data/services/" 2>/dev/null || true
        log_success "Service data restored"
    fi

    # Copy admin files
    log_info "Copying ProxyPilot files..."
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cp -r "${SCRIPT_DIR}/admin" "$INSTALL_DIR/"

    # Install host-side agent (Phase A scaffold). Runs before
    # docker-compose creation so the Compose file can reference the
    # already-existing socket path + group. Dual-tracked: nsenter
    # path stays the production code path until Phases B-E migrate.
    install_proxypilot_agent "$SCRIPT_DIR"

    # Create configuration files
    ACME_EMAIL="$EMAIL"
    create_env_file "$INSTALL_DIR" "$PORT" "$ADMIN_USER" "$ADMIN_PASS" "$TOTP_SECRET" "$DOMAIN"
    create_docker_compose "$INSTALL_DIR" "$PORT"

    # Create secure landing page
    create_secure_landing_page "$INSTALL_DIR"

    # Create Caddy site config (TLS is handled automatically by Caddy)
    create_proxypilot_caddy_config "$DOMAIN" "$PORT" "$EMAIL"

    # Build frontend on host (faster than building in Docker)
    log_info "Building frontend..."
    cd "${INSTALL_DIR}/admin/frontend"
    if ! command -v node &> /dev/null; then
        log_info "Installing Node.js..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    fi
    npm ci
    NODE_ENV=production npm run build
    if [[ ! -f "${INSTALL_DIR}/admin/frontend/dist/index.html" ]]; then
        log_error "Frontend build failed - dist/index.html not found"
        exit 1
    fi
    log_success "Frontend built successfully"

    # ── ProxyPilot CLI + firewall manager ─────────────────────────────────
    # The CLI ships with the repo at cli/. We copy it under $INSTALL_DIR,
    # install its (non-dev) deps, and drop a thin wrapper at
    # /usr/local/bin/proxypilot so operators (and the firewall systemd
    # units below) have a stable path to invoke.
    if [[ -d "${SCRIPT_DIR}/cli" ]]; then
        log_info "Installing ProxyPilot CLI..."
        cp -r "${SCRIPT_DIR}/cli" "$INSTALL_DIR/"
        (cd "$INSTALL_DIR/cli" && npm ci --omit=dev --silent) || \
            (cd "$INSTALL_DIR/cli" && npm install --omit=dev --silent)
        cat > /usr/local/bin/proxypilot <<EOF
#!/bin/sh
exec /usr/bin/env node "${INSTALL_DIR}/cli/bin/proxypilot.js" "\$@"
EOF
        chmod 0755 /usr/local/bin/proxypilot
        log_success "ProxyPilot CLI installed at /usr/local/bin/proxypilot"

        # Emit firewall systemd units and run the initial reconcile.
        if [[ -x "${SCRIPT_DIR}/scripts/install-firewall.sh" ]]; then
            log_info "Configuring host firewall (nftables)..."
            PROXYPILOT_BIN=/usr/local/bin/proxypilot \
                "${SCRIPT_DIR}/scripts/install-firewall.sh"
            log_success "Host firewall configured"
        fi

        # Install VPN userspace + module prerequisites. Does NOT bring
        # wg0 up — operator opts in via `proxypilot vpn enable`.
        if [[ -x "${SCRIPT_DIR}/scripts/install-vpn.sh" ]]; then
            log_info "Installing WireGuard prerequisites..."
            "${SCRIPT_DIR}/scripts/install-vpn.sh"
            log_success "WireGuard prerequisites installed"
        fi

        # Emit ssh-access systemd units (last-seen scanner timer).
        # The CLI's `ssh access` subcommand group is already wired by
        # the proxypilot wrapper above; this script only sets up the
        # 5-min last-seen scanner timer.
        if [[ -x "${SCRIPT_DIR}/scripts/install-ssh-access.sh" ]]; then
            log_info "Configuring SSH access manager..."
            PROXYPILOT_BIN=/usr/local/bin/proxypilot \
                PROXYPILOT_INSTALL_DIR="${INSTALL_DIR}" \
                "${SCRIPT_DIR}/scripts/install-ssh-access.sh"
            log_success "SSH access manager configured"
        fi
    fi

    # Build and start Docker container
    log_info "Building and starting ProxyPilot..."
    cd "$INSTALL_DIR"

    # Stop and remove existing containers to avoid ContainerConfig error with docker-compose v1
    log_info "Cleaning up any existing containers..."
    docker stop proxypilot-admin 2>/dev/null || true
    docker rm proxypilot-admin 2>/dev/null || true
    # Also try compose down to clean up any orphaned resources
    run_docker_compose down --remove-orphans 2>/dev/null || true

    # Build with --no-cache to ensure frontend dist is included fresh
    run_docker_compose build --no-cache
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
    echo -e "${YELLOW}║${NC}              ${CYAN}🚀  NEXT STEPS${NC}                                     ${YELLOW}║${NC}"
    echo -e "${YELLOW}╠════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${YELLOW}║${NC}                                                                ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}  Dashboard URL: ${CYAN}https://${DOMAIN}${NC}"
    echo -e "${YELLOW}║${NC}                                                                ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}  Username: ${GREEN}${ADMIN_USER}${NC}"
    echo -e "${YELLOW}║${NC}                                                                ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}  ${CYAN}Open the dashboard URL above to:${NC}                              ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}    1. Create your admin password                               ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}    2. Set up two-factor authentication (TOTP)                  ${YELLOW}║${NC}"
    echo -e "${YELLOW}║${NC}                                                                ${YELLOW}║${NC}"
    echo -e "${YELLOW}╚════════════════════════════════════════════════════════════════╝${NC}"
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
