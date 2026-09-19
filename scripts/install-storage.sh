#!/usr/bin/env bash
# install-storage.sh — the one-time host preparation for ProxyPilot's ZFS
# storage management (Storage page, storage MCP tools). Run once as root on
# the host after install.sh / update.sh:
#
#   sudo bash scripts/install-storage.sh
#
# What it does (each step idempotent):
#   1. apt-get install zfsutils-linux smartmontools sanoid  (+ lvm2, mdadm are
#      NOT installed: lsblk/libblkid detects their signatures without them)
#   2. loads the zfs kernel module and enables zfs-import/zfs-mount services
#   3. installs the ProxyPilot units: proxypilot-zfs-scrub@.{service,timer},
#      proxypilot-syncoid@.{service,timer}
#   4. installs the helpers: /usr/local/sbin/proxypilot-storage-replicate,
#      /usr/local/sbin/proxypilot-storage-restore-guest
#   5. seeds /etc/sanoid/sanoid.conf (empty policy: no datasets yet) and
#      enables sanoid.timer; creates /etc/proxypilot/storage and
#      /var/lib/proxypilot/storage
#   6. restarts proxypilot-agent so the SupplementaryGroups=disk change in
#      its unit takes effect
#
# Nothing here touches a disk: pools are created only through the Storage
# page / create_zpool after the operator has seen and confirmed the plan.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive

# --- distribution facts ------------------------------------------------------
. /etc/os-release 2>/dev/null || true
DISTRO="${ID:-unknown}"
DISTRO_LIKE="${ID_LIKE:-}"
is_debian() { [[ "$DISTRO" == debian ]] || [[ "$DISTRO_LIKE" == *debian* && "$DISTRO" != ubuntu ]]; }
is_ubuntu() { [[ "$DISTRO" == ubuntu ]] || [[ "$DISTRO_LIKE" == *ubuntu* ]]; }

# The apt candidate for a package, or the empty string when there is none.
apt_candidate() {
  local c
  c=$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/{print $2; exit}')
  [[ -z "$c" || "$c" == "(none)" ]] && return 1
  printf '%s' "$c"
}

# ZFS is not in the default component on either distribution: Debian keeps it
# in `contrib` and the installer does not enable that, Ubuntu keeps it in
# `universe`. Without it apt says "Package 'zfsutils-linux' has no installation
# candidate" and the install dies before anything is installed. Add the
# component to the EXISTING stanza rather than writing a competing source, so
# the archive URI and signing key stay exactly as the operator has them, and
# keep a .bak of whatever is edited.
add_component() {
  local want="$1" changed=false f
  # Debian 13 and Ubuntu 24.04 use the deb822 format by default.
  for f in /etc/apt/sources.list.d/*.sources; do
    [[ -e "$f" ]] || continue
    grep -q '^Components:' "$f" || continue
    grep -Eq "^Components:.*[[:space:]]${want}([[:space:]]|\$)" "$f" && continue
    cp -n "$f" "$f.proxypilot.bak" 2>/dev/null || true
    sed -i -E "s/^(Components:.*)\$/\1 ${want}/" "$f"
    echo "  added '${want}' to Components in $f (backup: $f.proxypilot.bak)"
    changed=true
  done
  # The older one-line format, still present on upgraded hosts.
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
    [[ -e "$f" ]] || continue
    grep -Eq "^deb[[:space:]].*[[:space:]]main([[:space:]]|\$)" "$f" || continue
    grep -Eq "^deb[[:space:]].*[[:space:]]${want}([[:space:]]|\$)" "$f" && continue
    cp -n "$f" "$f.proxypilot.bak" 2>/dev/null || true
    sed -i -E "s/^(deb[[:space:]].*[[:space:]]main)([[:space:]].*)?\$/\1\2 ${want}/" "$f"
    echo "  added '${want}' to $f (backup: $f.proxypilot.bak)"
    changed=true
  done
  [[ "$changed" == true ]]
}

echo "[1/6] packages"
apt-get update -qq

if ! apt_candidate zfsutils-linux >/dev/null; then
  component=""
  if is_ubuntu; then component=universe; elif is_debian; then component=contrib; fi
  if [[ -z "$component" ]]; then
    echo "ERROR: zfsutils-linux has no installation candidate and this is not Debian or Ubuntu (ID=${DISTRO})." >&2
    echo "       Install the ZFS user tools with this distribution's package manager, then re-run." >&2
    exit 4
  fi
  echo "  zfsutils-linux has no candidate; enabling the '${component}' component"
  if ! add_component "$component"; then
    echo "ERROR: could not find an apt source to add '${component}' to." >&2
    echo "       Add it by hand to /etc/apt/sources.list.d/*.sources or /etc/apt/sources.list, run apt-get update, then re-run." >&2
    exit 4
  fi
  apt-get update -qq
  if ! apt_candidate zfsutils-linux >/dev/null; then
    echo "ERROR: zfsutils-linux still has no installation candidate after enabling '${component}'." >&2
    echo "       Check that the archive is reachable and that apt-get update succeeded, then re-run." >&2
    exit 4
  fi
fi

PKGS=(zfsutils-linux smartmontools sanoid pv mbuffer lzop)
if is_debian; then
  # Debian ships no in-tree ZFS: the module is built by DKMS, which needs the
  # headers for the running kernel. Prefer the exact version, fall back to the
  # arch meta package that tracks linux-image-<arch>.
  PKGS+=(zfs-dkms zfs-zed)
  if apt_candidate "linux-headers-$(uname -r)" >/dev/null; then
    PKGS+=("linux-headers-$(uname -r)")
  elif apt_candidate "linux-headers-$(dpkg --print-architecture)" >/dev/null; then
    PKGS+=("linux-headers-$(dpkg --print-architecture)")
  else
    echo "  WARNING: no kernel headers package found; the zfs-dkms build will fail" >&2
  fi
fi
echo "  installing: ${PKGS[*]}"
# DKMS compiles the module here, which takes a few minutes on a small host.
if ! apt-get install -y "${PKGS[@]}"; then
  echo "ERROR: apt-get install failed. The output above has the reason; nothing else was changed." >&2
  exit 5
fi
# sanoid's package ships sanoid.timer (15 min) and the syncoid binary.

echo "[2/6] zfs module + import services"
MODULE_OK=true
if ! modprobe zfs 2>/dev/null; then
  # A fresh DKMS build sometimes needs depmod before the module is findable.
  depmod -a 2>/dev/null || true
  modprobe zfs 2>/dev/null || MODULE_OK=false
fi
if [[ "$MODULE_OK" == true ]]; then
  systemctl enable --now zfs-import-cache.service zfs-import.target zfs-mount.service zfs.target 2>/dev/null || true
else
  echo "  WARNING: the zfs module is not loaded yet." >&2
fi

echo "[3/6] units"
for u in proxypilot-zfs-scrub@.service proxypilot-zfs-scrub@.timer proxypilot-syncoid@.service proxypilot-syncoid@.timer; do
  install -m 0644 "$SCRIPT_DIR/deploy/$u" "/etc/systemd/system/$u"
done
# the agent unit gained SupplementaryGroups=disk (lets lsblk / zpool label scans read devices)
if [[ -f "$SCRIPT_DIR/deploy/proxypilot-agent.service" ]] && ! cmp -s "$SCRIPT_DIR/deploy/proxypilot-agent.service" /etc/systemd/system/proxypilot-agent.service; then
  install -m 0644 "$SCRIPT_DIR/deploy/proxypilot-agent.service" /etc/systemd/system/proxypilot-agent.service
fi
systemctl daemon-reload

echo "[4/6] helpers"
install -m 0755 "$SCRIPT_DIR/scripts/storage-replicate.sh" /usr/local/sbin/proxypilot-storage-replicate
install -m 0755 "$SCRIPT_DIR/scripts/storage-restore-guest.sh" /usr/local/sbin/proxypilot-storage-restore-guest

echo "[5/6] sanoid + directories"
mkdir -p /etc/sanoid /etc/proxypilot/storage /var/lib/proxypilot/storage/replication /var/lib/proxypilot/storage/restore /var/lib/proxypilot/storage/destroyed
chmod 0750 /etc/proxypilot/storage
if [[ ! -f /etc/sanoid/sanoid.conf ]]; then
  cat > /etc/sanoid/sanoid.conf <<'CONF'
# Generated by ProxyPilot (Storage → Backup policy). Empty until a managed pool exists.
CONF
fi
systemctl enable --now sanoid.timer 2>/dev/null || echo "sanoid.timer not available — check the sanoid package" >&2

echo "[6/6] agent restart"
systemctl try-restart proxypilot-agent.service 2>/dev/null || true

if [[ "${MODULE_OK:-true}" != true ]]; then
  echo
  echo "========================================================================"
  echo "Packages, units and helpers are installed, but the ZFS kernel module is"
  echo "NOT loaded. On Debian the module is built by DKMS against the running"
  echo "kernel; if the build ran against a newer kernel than the one booted, a"
  echo "REBOOT loads it. Check with:  dkms status ; journalctl -b | grep -i zfs"
  echo "Nothing can read or create a pool until 'modprobe zfs' succeeds."
  echo "========================================================================"
  exit 3
fi

echo
echo "Done. Next, in the dashboard: Storage → Devices → Create pool (or set an existing pool as managed),"
echo "then Pools → Set as Incus storage pool, then Backup & replication."
echo "For replication over SSH create a key on this host (ssh-keygen -t ed25519 -f /root/.ssh/pp_replication -N '')"
echo "and authorize its public key on the target for a user allowed to run 'zfs receive' (sudo or zfs allow)."
