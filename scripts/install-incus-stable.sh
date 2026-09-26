#!/usr/bin/env bash
# Install Incus from Zabbly's stable channel on a fresh Debian/Ubuntu host.
# Existing Incus installations are deliberately left to a separate upgrade
# with a full Incus data backup: newer daemons may migrate the database.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo 'install-incus-stable.sh must run as root' >&2
    exit 1
fi
if command -v incus >/dev/null 2>&1; then
    echo 'Incus is already installed; back up its data before a separate upgrade' >&2
    exit 1
fi

. /etc/os-release
case "${ID:-}:${VERSION_CODENAME:-}" in
    debian:bookworm|debian:trixie|ubuntu:jammy|ubuntu:noble|ubuntu:resolute) ;;
    *) echo "Unsupported Zabbly Incus stable suite: ${ID:-unknown}/${VERSION_CODENAME:-unknown}" >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg
key_file=$(mktemp)
trap 'rm -f "$key_file"' EXIT
curl --fail --show-error --silent --location https://pkgs.zabbly.com/key.asc -o "$key_file"
fingerprint=$(gpg --show-keys --with-colons "$key_file" | awk -F: '$1 == "fpr" { print $10; exit }')
if [ "$fingerprint" != '4EFC590696CB15B87C73A3AD82CC8797C838DCFD' ]; then
    echo 'Zabbly signing key fingerprint mismatch' >&2
    exit 1
fi
install -d -m 0755 /etc/apt/keyrings
gpg --batch --yes --dearmor -o /etc/apt/keyrings/zabbly.gpg "$key_file"
chmod 0644 /etc/apt/keyrings/zabbly.gpg
cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: ${VERSION_CODENAME}
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.gpg
EOF
apt-get update -y
candidate=$(apt-cache policy incus | awk '/Candidate:/ { print $2; exit }')
if [ -z "$candidate" ] || [ "$candidate" = '(none)' ]; then
    echo 'No Incus candidate in the Zabbly stable channel' >&2
    exit 1
fi
apt-get install -y --no-install-recommends incus
echo "Installed Incus stable candidate $candidate"
