# ProxyPilot

A tool to automate NGINX configuration, SSL certificate setup, and renewal with Certbot. **ProxyPilot** simplifies server setups by generating ready-to-run Bash scripts that configure reverse proxies or static sites and secure your domains—perfect for developers and sysadmins who want fast, reproducible web server management.

## Test it!
https://cybertecharmor.github.io/ProxyPilot/

---

## What is ProxyPilot? 🛠️🚀

**ProxyPilot** is a powerful script generator that automates:

- Creating **NGINX** server blocks for one or more domains
- Obtaining **Let’s Encrypt** TLS certificates with **Certbot**
- Enabling renewals and safe reloads
- Handling **reverse proxy** and **static site** workflows with sensible defaults

No more copy-pasting configs—generate a single script, run it on your server, and you’re online. 🧰

---

## Features ✨

- **Two Modes**
  - **Reverse Proxy (address:port):** Point a domain at an upstream app (e.g., `127.0.0.1:3000`), with optional WebSocket headers.
  - **Static Site (directory):** Serve files directly from a directory on disk.
    - **Path is mandatory** (e.g., `/home/user/websites/mysite`). There is **no** `/var/www/{domain}` fallback.
- **Force HTTPS by Default:** HTTP → HTTPS redirect is **ON** unless you turn it off.
- **Safer Cert Flow (Static):** Uses `certbot certonly --webroot` and a **temporary HTTP-only site** for ACME challenges, then writes a **single canonical** HTTPS config.
- **One-shot & Idempotent:** Scripts clean up prior configs for the domain, test NGINX, and reload safely.
- **Home Directory Traversal Fixes:** When the static root is under `/home/...`, parent directories get safe execute bits so NGINX can traverse to your files.
- **Quality of Life:**
  - WebSocket support toggle for reverse proxy mode
  - Custom `client_max_body_size`
  - Copy-to-clipboard and TTY-aware pause on errors

---

## Getting Started 🏁

### Prerequisites

- A Debian/Ubuntu-like server with `sudo` access
- **NGINX** and **Certbot** available via apt (the generated scripts will install them if missing)
- Your DNS `A/AAAA` record already pointing to the server

### Install / Clone ⚙️

```bash
git clone https://github.com/cybertecharmor/ProxyPilot.git
cd ProxyPilot
# open index.html in a browser or serve it via any static host
````

Or use the hosted demo:

* [https://cybertecharmor.github.io/ProxyPilot/](https://cybertecharmor.github.io/ProxyPilot/)

---

## Usage 🚦

1. Open **ProxyPilot** in your browser.
2. Choose **Deployment Mode**:

   * **Reverse Proxy (address\:port)**

     * Enter **Server Name** (domain)
     * Enter **Backend IP/Host** (e.g., `127.0.0.1` or `localhost`)
     * Enter **Backend Port** (e.g., `3000`)
     * (Optional) Leave **WebSocket Support** enabled if your app upgrades connections
   * **Static Site (directory)**

     * Enter **Server Name** (domain)
     * Enter **Root Directory** (absolute path, **required**), e.g., `/home/user/websites/mysite`

       * If under `/home`, the script will safely apply execute bits on parent folders so NGINX can traverse to files
3. **Force HTTPS** is **enabled by default**; uncheck only if you need plain HTTP during testing.
4. Click **Generate Script**, copy it, and run on the target server:

   ```bash
   bash ./generated-script.sh
   ```
5. Verify:

   ```bash
   curl -I http://your.domain
   curl -I https://your.domain
   ```

---

## What the Scripts Do 🔧

### Reverse Proxy Mode

* Writes an HTTP server block for ACME + proxy pass to your app
* Runs `certbot --nginx` (can also add `--redirect` when HTTPS is forced)
* Reloads NGINX and enables Certbot renewal timer

### Static Site Mode

* Creates your specified **WEBROOT** (no fallback), adds a simple `index.html` if missing
* Fixes directory permissions for traversal (especially under `/home/...`)
* Writes a **temporary HTTP-only** site for ACME challenge
* Runs `certbot certonly --webroot`
* Replaces the temp config with a **single canonical** config:

  * HTTP: either redirect to HTTPS (default) or serve content, based on your toggle
  * HTTPS: serves the site from your WEBROOT
* Reloads NGINX and enables renewals

---

## Example: Reverse Proxy Script (excerpt) 📝

```bash
#!/bin/bash
set -uo pipefail

DOMAIN="app.example.com"
UPSTREAM_HOST="127.0.0.1"
UPSTREAM_PORT="3000"
EMAIL="you@example.com"
FORCE_REDIRECT=1

echo "Installing NGINX & Certbot..."
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo rm -f /etc/nginx/sites-enabled/default || true

cat <<'NGINX' | sudo tee /etc/nginx/sites-available/${DOMAIN}
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    client_max_body_size 1G;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }

    location / {
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300;
        proxy_connect_timeout 60;
        proxy_send_timeout 300;
        proxy_buffering off;
        proxy_pass http://${UPSTREAM_HOST}:${UPSTREAM_PORT};
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
sudo nginx -t && sudo systemctl reload nginx

EXTRA=""
if [ "${FORCE_REDIRECT}" = "1" ]; then EXTRA="--redirect"; fi
sudo certbot --nginx --non-interactive --agree-tos --email "${EMAIL}" -d "${DOMAIN}" ${EXTRA}

sudo certbot renew --dry-run || true
sudo systemctl enable certbot.timer || true

echo "✅ Reverse proxy ready at https://${DOMAIN}"
```

---

## Example: Static Site Script (excerpt)

```bash
#!/bin/bash
set -euo pipefail

DOMAIN="www.example.com"
WEBROOT="/home/user/websites/mysite"   # REQUIRED: absolute path
EMAIL="you@example.com"
FORCE_REDIRECT=1

echo "[1/8] Ensure WEBROOT and sample index..."
sudo mkdir -p "${WEBROOT}/.well-known/acme-challenge"
if [ ! -f "${WEBROOT}/index.html" ]; then
  sudo tee "${WEBROOT}/index.html" >/dev/null <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>It works</title></head>
<body style="font-family:system-ui;margin:2rem"><h1>✅ It works!</h1></body></html>
HTML
fi

echo "[2/8] Ownership & traversal..."
sudo chown -R www-data:www-data "${WEBROOT}"
sudo chmod -R 755 "${WEBROOT}"
if [[ "${WEBROOT}" == /home/* ]]; then
  sudo chmod 755 /home || true
  USERDIR="/home/$(echo "${WEBROOT}" | cut -d/ -f3)"
  [ -d "${USERDIR}" ] && sudo chmod 755 "${USERDIR}" || true
  LIMIT="/home"; CUR="${WEBROOT}"; PATHS=()
  while [ "${CUR}" != "${LIMIT}" ] && [ "${CUR}" != "/" ]; do PATHS=("${CUR}" "${PATHS[@]}"); CUR="$(dirname "${CUR}")"; done
  PATHS=("${LIMIT}" "${PATHS[@]}")
  for d in "${PATHS[@]}"; do [ -d "${d}" ] && sudo chmod 755 "${d}" || true; done
fi

echo "[3/8] Install NGINX/Certbot..."
sudo apt-get update -y
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo rm -f /etc/nginx/sites-enabled/default || true

echo "[4/8] Temp HTTP-only site for ACME..."
cat <<NGINX | sudo tee /etc/nginx/sites-available/${DOMAIN}-acme
server {
  listen 80; listen [::]:80;
  server_name ${DOMAIN};
  root ${WEBROOT}; index index.html;

  location ^~ /.well-known/acme-challenge/ {
    root ${WEBROOT}; default_type "text/plain";
  }
  location / { try_files \$uri \$uri/ /index.html; }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/${DOMAIN}-acme /etc/nginx/sites-enabled/${DOMAIN}-acme
sudo nginx -t && sudo systemctl reload nginx

echo "[6/8] Obtain certificate (webroot)..."
sudo certbot certonly --non-interactive --agree-tos --email "${EMAIL}" -d "${DOMAIN}" --webroot -w "${WEBROOT}"

CERT="/etc/letsencrypt/live/${DOMAIN}"
FULLCHAIN="${CERT}/fullchain.pem"; PRIVKEY="${CERT}/privkey.pem"; CHAIN="${CERT}/chain.pem"

echo "[7/8] Final canonical config..."
cat <<NGINX | sudo tee /etc/nginx/sites-available/${DOMAIN}
# HTTP ${FORCE_REDIRECT:+redirect}
server {
  listen 80; listen [::]:80;
  server_name ${DOMAIN};
  root ${WEBROOT}; index index.html;

  location ^~ /.well-known/acme-challenge/ { default_type "text/plain"; allow all; }
  location / { ${FORCE_REDIRECT:+return 301 https://$host$request_uri;} ${FORCE_REDIRECT:+"#"}${FORCE_REDIRECT:+" else: try_files \$uri \$uri/ /index.html;"} }
}

server {
  listen 443 ssl http2; listen [::]:443 ssl http2;
  server_name ${DOMAIN};
  root ${WEBROOT}; index index.html;

  ssl_certificate           ${FULLCHAIN};
  ssl_certificate_key       ${PRIVKEY};
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_trusted_certificate   ${CHAIN};

  location / { try_files \$uri \$uri/ /index.html; }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
sudo rm -f /etc/nginx/sites-enabled/${DOMAIN}-acme /etc/nginx/sites-available/${DOMAIN}-acme || true
sudo nginx -t && sudo systemctl reload nginx

sudo systemctl enable certbot.timer || true
echo "✅ Static site ready at https://${DOMAIN}"
```

---

## Contributing 🤝

Issues and PRs are welcome! If you’d like to improve **ProxyPilot**, open an issue or submit a pull request.

## License 📜

MIT — see [LICENSE](LICENSE).

## Acknowledgments 🙏

* Thanks to the open-source community for **NGINX** and **Certbot**
* Special thanks to contributors and testers

---

⭐ If this project helps you, please consider starring it. We hope **ProxyPilot** makes your server setup easier and more secure!

```
```
