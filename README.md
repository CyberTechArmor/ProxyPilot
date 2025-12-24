# ProxyPilot

A comprehensive NGINX management solution with an admin dashboard for managing proxy services, SSL certificates, and domains. **ProxyPilot** includes both a standalone script generator and a full-featured admin dashboard with TOTP authentication.

## Features

### Standalone Script Generator (index.html)
- Generate ready-to-run Bash scripts for NGINX configuration
- Support for reverse proxies and static sites
- Automatic SSL certificate setup with Let's Encrypt
- WebSocket support for real-time applications
- [Try it online](https://cybertecharmor.github.io/ProxyPilot/)

### Admin Dashboard (New!)
- **Web-based management UI** for all your proxy services
- **Secure authentication** with password + TOTP two-factor authentication
- **Service management**: Add, edit, and delete proxy services
- **Docker integration**: Manage Docker containers as proxy targets
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
1. Check and install NGINX (if not present)
2. Configure global NGINX settings
3. Install Docker and Docker Compose (if not present)
4. Set up the admin dashboard on your chosen port
5. Generate secure credentials and TOTP secret
6. Configure SSL with Let's Encrypt
7. Start the dashboard in a Docker container

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

- Ubuntu/Debian-based Linux server
- Root access (sudo)
- Domain name pointing to your server
- Ports 80 and 443 available

### Installation Options

During installation, you'll be prompted for:

| Option | Description | Default |
|--------|-------------|---------|
| Max Upload Size | Global NGINX client_max_body_size | 1G |
| Dashboard Port | Port for the admin dashboard | 3001 |
| Admin Username | Login username | (required) |
| Domain | Domain for the admin dashboard | (required) |
| Email | Email for Let's Encrypt certificates | (required) |

### Post-Installation

After installation, you'll receive:
- Dashboard URL (https://your-domain)
- Admin username and generated password
- TOTP QR code and secret key

**Important:** Save these credentials securely! The password is only shown once.

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
3. Configure options (SSL, HTTPS redirect, WebSocket support)
4. Click "Generate Script"
5. Copy and run the script on your server

### Generated Script Features

- Installs NGINX and Certbot if needed
- Configures NGINX server blocks
- Obtains SSL certificates via Let's Encrypt
- Sets up automatic certificate renewal
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
    │           ├── services.js # Service CRUD
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

---

## Troubleshooting

### Dashboard won't start
```bash
# Check Docker logs
docker compose -f /opt/proxypilot/docker-compose.yml logs

# Check if port is in use
ss -tlnp | grep 3001
```

### Certificate issues
```bash
# Test certificate renewal
sudo certbot renew --dry-run

# Check NGINX configuration
sudo nginx -t
```

### Database issues
```bash
# Database location
ls -la /opt/proxypilot/data/

# Reset database (WARNING: loses all data)
rm /opt/proxypilot/data/proxypilot.db
docker compose -f /opt/proxypilot/docker-compose.yml restart
```

---

## Contributing

Issues and PRs are welcome! If you'd like to improve **ProxyPilot**, open an issue or submit a pull request.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- Thanks to the open-source community for **NGINX** and **Certbot**
- Built with React, shadcn/ui, Express, and SQLite
- Special thanks to contributors and testers

---

If this project helps you, please consider starring it. We hope **ProxyPilot** makes your server management easier and more secure!
