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

RUNNING_KERNEL="$(uname -r)"
HEADERS_FOR_RUNNING=false
PKGS=(zfsutils-linux smartmontools sanoid pv mbuffer lzop)
if is_debian; then
  PKGS+=(zfs-dkms zfs-zed)
  # Debian ships no in-tree ZFS: DKMS builds the module against a kernel's
  # headers. Install those in their OWN transaction first — zfs-dkms's postinst
  # skips the build when the headers are not configured YET, and apt does not
  # order two unrelated packages for us, so a single combined install can
  # silently produce no module at all.
  hdr=""
  if apt_candidate "linux-headers-${RUNNING_KERNEL}" >/dev/null; then
    hdr="linux-headers-${RUNNING_KERNEL}"
    HEADERS_FOR_RUNNING=true
  elif apt_candidate "linux-headers-$(dpkg --print-architecture)" >/dev/null; then
    # Debian's archive carries only the CURRENT kernel build, so the running
    # kernel's headers are often gone. The arch meta tracks the current one;
    # the module then matches after a reboot into that kernel.
    hdr="linux-headers-$(dpkg --print-architecture)"
    echo "  note: no headers in the archive for the running kernel ${RUNNING_KERNEL}; using ${hdr}"
    echo "        (Debian keeps only the current kernel build, so a reboot will be needed)"
  fi
  if [[ -n "$hdr" ]]; then
    echo "  installing kernel headers first: $hdr"
    if ! apt-get install -y "$hdr"; then
      echo "ERROR: could not install $hdr; DKMS cannot build the ZFS module without it." >&2
      exit 5
    fi
  else
    echo "  WARNING: no kernel headers package is available; the zfs-dkms build will fail" >&2
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
# Which kernels actually have a zfs module on disk. Answers "built but for the
# wrong kernel", which is the difference between "reboot" and "the build failed".
kernels_with_zfs() {
  local d k
  for d in /lib/modules/*/; do
    [[ -d "$d" ]] || continue
    k="$(basename "$d")"
    if compgen -G "${d}updates/dkms/zfs.ko*" >/dev/null || compgen -G "${d}extra/zfs.ko*" >/dev/null || compgen -G "${d}kernel/zfs/zfs.ko*" >/dev/null; then
      echo "$k"
    fi
  done
}

if is_debian && command -v dkms >/dev/null 2>&1; then
  # Explicit build: idempotent, and it covers the case where zfs-dkms's own
  # postinst ran before the headers were configured and skipped silently.
  echo "  building the module with dkms (this takes a few minutes)"
  if [[ "$HEADERS_FOR_RUNNING" == true ]]; then
    dkms autoinstall -k "$RUNNING_KERNEL" 2>&1 | tail -n 20 || true
  else
    dkms autoinstall 2>&1 | tail -n 20 || true
  fi
fi

depmod -a 2>/dev/null || true
MODULE_OK=true
modprobe zfs 2>/dev/null || MODULE_OK=false

if [[ "$MODULE_OK" == true ]]; then
  systemctl enable --now zfs-import-cache.service zfs-import.target zfs-mount.service zfs.target 2>/dev/null || true
  echo "  zfs module loaded ($(modinfo -F version zfs 2>/dev/null || echo 'version unknown'))"
else
  BUILT_FOR="$(kernels_with_zfs | tr '\n' ' ' | sed 's/ *$//')"
  SECURE_BOOT="$(mokutil --sb-state 2>/dev/null | head -n1 || echo 'unknown')"
  echo "  WARNING: the zfs module is not loaded." >&2
  echo "    running kernel : ${RUNNING_KERNEL}" >&2
  echo "    module built for: ${BUILT_FOR:-nothing}" >&2
  echo "    secure boot     : ${SECURE_BOOT}" >&2
  [[ -n "$BUILT_FOR" ]] && echo "    dkms: $(dkms status zfs 2>/dev/null | tr '\n' ';' || echo unavailable)" >&2
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
  echo "Packages, units and helpers are installed. The ZFS module is NOT loaded."
  echo
  if [[ -n "${BUILT_FOR:-}" ]]; then
    echo "A module IS built, for: ${BUILT_FOR}"
    echo "You are running:        ${RUNNING_KERNEL}"
    echo
    echo "A module only loads into the kernel it was built for, so this needs a"
    echo "REBOOT into ${BUILT_FOR%% *}. That kernel is already installed, so:"
    echo
    echo "    sudo reboot"
    echo
    echo "After the reboot, open Storage and press Install once more: it will"
    echo "find everything present and the module loaded, and finish green."
  elif [[ "${SECURE_BOOT:-}" == *enabled* ]]; then
    echo "Secure Boot is ENABLED and the DKMS module is not signed, so the kernel"
    echo "refuses to load it. Either enrol a MOK signing key for DKMS, or disable"
    echo "Secure Boot in firmware, then run the installer again."
  else
    echo "No module was built for any installed kernel, so the DKMS build failed."
    echo "The reason is in:  /var/lib/dkms/zfs/*/build/make.log"
    echo "Check 'dkms status' and that the headers match a kernel you can boot."
  fi
  echo
  echo "Nothing can read or create a pool until 'modprobe zfs' succeeds."
  echo "========================================================================"
  exit 3
fi

echo
echo "Done. Next, in the dashboard: Storage → Devices → Create pool (or set an existing pool as managed),"
echo "then Pools → Set as Incus storage pool, then Backup & replication."
echo "For replication over SSH create a key on this host (ssh-keygen -t ed25519 -f /root/.ssh/pp_replication -N '')"
echo "and authorize its public key on the target for a user allowed to run 'zfs receive' (sudo or zfs allow)."
