# ProxyPilot

A comprehensive reverse proxy management solution with an admin dashboard for managing proxy services, SSL certificates, and domains. **ProxyPilot** uses **Caddy** as its reverse proxy backend with automatic TLS certificate management. It includes both a standalone script generator and a full-featured admin dashboard with TOTP authentication.

## Features

### Standalone Script Generator (index.html)
- Generate ready-to-run Bash scripts for Caddy configuration
- Support for reverse proxies and static sites
- Automatic SSL certificate management via Caddy's built-in ACME
- WebSocket support for real-time applications
- [Try it online](https://cybertecharmor.github.io/ProxyPilot/)

### Admin Dashboard
- **Web-based management UI** for all your proxy services
- **Secure authentication** with password + TOTP two-factor authentication
- **Service management**: Add, edit, and delete proxy services
- **Docker integration**: Manage Docker containers as proxy targets
- **Automatic TLS**: Caddy auto-obtains and renews SSL certificates
- **Audit logging**: Track all administrative actions
- **Profile management**: Change password and reset TOTP

---

## Quick Start

### Option 1: Standalone Script Generator

Open `index.html` in your browser or use the [hosted version](https://cybertecharmor.github.io/ProxyPilot/).

### Option 2: Admin Dashboard Installation

Run the install script on your server:

```bash
# Clone the repository
git clone https://github.com/cybertecharmor/ProxyPilot.git
cd ProxyPilot

# Run the installer (requires root)
sudo ./install.sh
```

The installer will:
1. Install Caddy (if not present)
2. Install Docker and Docker Compose (if not present)
3. Set up the admin dashboard on your chosen port
4. Generate secure credentials
5. Configure Caddy with automatic TLS
6. Start the dashboard

---

## Admin Dashboard

### Features

#### Dashboard
- View all configured proxy services
- See service status, type, and target
- Quick actions to add or remove services

#### Service Types
| Type | Description |
|------|-------------|
| **Reverse Proxy** | Route traffic to an upstream application (IP:Port) |
| **Static Site** | Serve files from a directory on disk |
| **Docker Container** | Proxy to a running Docker container |

#### Security
- Password authentication with bcrypt hashing
- TOTP two-factor authentication (Google Authenticator, Authy, etc.)
- TOTP required for deleting services
- Rate limiting on authentication endpoints
- Audit logging for all actions

#### Profile Management
- Change password (requires current password + TOTP)
- Reset/update TOTP secret with QR code generation

### Installation Requirements

- Debian/Ubuntu-based Linux server
- Root access (sudo)
- Domain name pointing to your server
- Ports 80 and 443 available

### Installation Options

During installation, you'll be prompted for:

| Option | Description | Default |
|--------|-------------|---------|
| Dashboard Port | Port for the admin dashboard | 3001 |
| Admin Username | Login username | (required) |
| Domain | Domain for the admin dashboard | (required) |

### Post-Installation

After installation, you'll receive:
- Dashboard URL (https://your-domain)
- Admin username (password set via web UI on first login)

### Managing the Dashboard

```bash
# View logs
docker compose -f /opt/proxypilot/docker-compose.yml logs -f

# Restart the dashboard
docker compose -f /opt/proxypilot/docker-compose.yml restart

# Stop the dashboard
docker compose -f /opt/proxypilot/docker-compose.yml down

# Start the dashboard
docker compose -f /opt/proxypilot/docker-compose.yml up -d
```

### Reset/Recovery Tool

If you lose access to the dashboard, use the reset tool:

```bash
# Interactive menu
sudo /opt/proxypilot/reset.sh

# Reset password only
sudo /opt/proxypilot/reset.sh password

# Reset TOTP only
sudo /opt/proxypilot/reset.sh totp

# Full reset (password + TOTP)
sudo /opt/proxypilot/reset.sh full

# Show current credentials
sudo /opt/proxypilot/reset.sh show

# Show status and logs
sudo /opt/proxypilot/reset.sh status
```

The reset tool provides:
- Password reset with new secure password generation
- TOTP reset with QR code display
- Full credential reset
- Display of current saved credentials
- Service status and log viewing

---

## Standalone Script Generator

### How It Works

1. Open the generator in your browser
2. Choose deployment mode:
   - **Reverse Proxy**: Enter backend IP and port
   - **Static Site**: Enter the absolute path to your files
3. Configure options (SSL is automatic with Caddy)
4. Click "Generate Script"
5. Copy and run the script on your server

### Generated Script Features

- Installs Caddy if needed
- Creates Caddyfile site configurations
- TLS certificates are automatically obtained and renewed by Caddy
- Handles directory permissions for static sites

---

## Architecture

```
ProxyPilot/
├── index.html              # Standalone script generator
├── install.sh              # Admin dashboard installer
├── README.md
├── LICENSE
└── admin/
    ├── Dockerfile          # Docker build configuration
    ├── backend/
    │   ├── package.json
    │   └── src/
    │       ├── index.js    # Express server
    │       ├── db.js       # SQLite database
    │       ├── middleware/
    │       │   └── auth.js # JWT authentication
    │       └── routes/
    │           ├── auth.js     # Login/logout endpoints
    │           ├── services.js # Service CRUD + Caddy config
    │           └── user.js     # Profile management
    └── frontend/
        ├── package.json
        ├── vite.config.js
        └── src/
            ├── App.jsx
            ├── components/     # shadcn UI components
            ├── context/        # Auth context
            ├── hooks/          # Custom hooks
            ├── lib/            # API client
            └── pages/          # Dashboard, Profile, Login
```

---

## API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login with username, password, TOTP |
| GET | `/api/auth/verify` | Verify JWT token |
| POST | `/api/auth/logout` | Logout (audit log) |

### Services
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/services` | List all services |
| GET | `/api/services/:id` | Get service details |
| POST | `/api/services` | Create new service |
| PUT | `/api/services/:id` | Update service |
| DELETE | `/api/services/:id` | Delete service (requires TOTP) |

### User
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/user/profile` | Get user profile |
| POST | `/api/user/change-password` | Change password |
| POST | `/api/user/totp/generate` | Generate new TOTP secret |
| POST | `/api/user/totp/verify` | Verify and save TOTP |
| GET | `/api/user/audit-log` | Get audit log |

---

## Security Considerations

- All passwords are hashed with bcrypt (cost factor 12)
- JWT tokens expire after 24 hours
- TOTP is required for destructive operations (delete)
- Rate limiting: 10 login attempts per 15 minutes
- API rate limiting: 100 requests per 15 minutes
- Security headers (X-Frame-Options, CSP, etc.)
- Audit logging for all administrative actions
- Caddy provides automatic HTTPS with OCSP stapling

---

## Troubleshooting

### Dashboard won't start
```bash
# Check Docker logs
docker compose -f /opt/proxypilot/docker-compose.yml logs

# Check if port is in use
ss -tlnp | grep 3001
```

### Caddy issues
```bash
# Validate Caddy configuration
sudo caddy validate --config /etc/caddy/Caddyfile

# Reload Caddy
sudo caddy reload --config /etc/caddy/Caddyfile

# Check Caddy status
sudo systemctl status caddy

# View Caddy logs
sudo journalctl -u caddy -f
```

### Database issues
```bash
# Database location
ls -la /opt/proxypilot/data/

# Reset database (WARNING: loses all data)
rm /opt/proxypilot/data/proxypilot.db
docker compose -f /opt/proxypilot/docker-compose.yml restart
```

### Backups + S3 storage + restore dry-run

The Housekeeping page exposes a **Backups** tab driving:

- **Three tiers** of on-demand or scheduled backup:
  - `config` (~50 KB): SQLite dump as JSON, `.env`, `cve-inbox/` YAMLs.
  - `config_plus_data` (~10-100 MB): adds `/etc/caddy/`,
    `/etc/wireguard/`, ACME certs, per-service Caddy file roots.
  - `full` (multi-GB): adds per-volume Docker tarballs +
    per-instance `incus export`.
- **S3-compatible storage** via the **Storage** tab — MinIO,
  Cloudflare R2, Backblaze B2, AWS S3, Wasabi all work; secrets
  encrypted at rest with the same envelope as TOTP secrets.
- **Schedules** (cron syntax) with serial-queue worker and
  retention pruning (`keep N` AND/OR `delete > N days`).
- **Restore dry-run**: Mode A (sandbox same host — extracts to a
  per-run sandbox dir, can re-import Incus instances under
  `-restore-<short-id>` on a private bridge) or Mode C
  (manifest-only — verifies every file's sha256 without touching
  disk).

Wire format: `[4 BE uint32 header_len][JSON header][AES-256-GCM
ciphertext][16 B GCM tag]`. Body is `gzip(tar(...))`. Header
carries the KDF (currently scrypt; argon2id swap is a versioning-
field flip away).

The passphrase used for backup encryption is **never** persisted
for on-demand backups; it is stored encrypted at rest for
schedules so the cron worker can run unattended. **Lose the
passphrase and the backup is unrecoverable.**

### WireGuard VPN: peer connects but throughput is poor or fragmented

ProxyPilot pins a WireGuard `MTU = 1280` on every generated config
(server-side `wg0.conf` and every `proxypilot vpn peer add` client
config). 1280 is IPv6's minimum guaranteed MTU and clears every
common encapsulation overhead stack (PPPoE, double-NAT, mobile
carriers, Cloudflare Tunnel, Tailscale-over-WG) without
fragmentation.

If you see a working handshake but stalled large transfers, check
that **both ends agree on MTU**:

```bash
# Server side
sudo wg show wg0
ip link show wg0          # MTU column should read 1280

# Client side (Linux)
ip link show wg0          # MTU should also be 1280
```

Operators on a known all-Ethernet path who want the extra throughput
can override the default by setting `PROXYPILOT_VPN_MTU=<n>` in the
shell that runs `proxypilot vpn peer add` (or that runs `update.sh`,
which retro-fits the value via `scripts/patch-wg-mtu.sh`). Valid
range is 576-9000; out-of-range values are silently ignored and the
1280 default is used instead.

To change the MTU on an already-deployed wg0 in place:

```bash
sudo PROXYPILOT_VPN_MTU=1380 \
    /opt/proxypilot/scripts/patch-wg-mtu.sh
```

The script is idempotent — re-running it on a config that already
has the desired MTU is a no-op.

---

## Contributing

Issues and PRs are welcome! If you'd like to improve **ProxyPilot**, open an issue or submit a pull request.

### UI changes must be mobile-friendly

The admin dashboard is expected to work on phones and tablets, not only on desktop. **Any PR that touches `admin/frontend/src/pages/` or `admin/frontend/src/components/` must follow the rules in [`admin/frontend/MOBILE_FIRST.md`](admin/frontend/MOBILE_FIRST.md)** and complete its pre-merge checklist (render at 360/375/768, every dialog completable on mobile, primary action buttons ≥44×44px, etc.). Reviewers should reject UI PRs that introduce fixed-width grids, bare desktop-only `DialogContent` widths, or icon-only primary actions smaller than 44px on mobile.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- Thanks to the open-source community for **Caddy** and its automatic HTTPS
- Built with React, shadcn/ui, Express, and SQLite
- Special thanks to contributors and testers

---

If this project helps you, please consider starring it. We hope **ProxyPilot** makes your server management easier and more secure!
