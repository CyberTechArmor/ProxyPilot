#!/usr/bin/env bash
# proxypilot-storage-restore-guest <dataset@snapshot> <new-guest-name> <incus-pool>
#
# Turn a ZFS-level snapshot of an Incus guest's dataset (a sanoid autosnap,
# a syncoid snapshot, a manual one — anything Incus does not know about) into
# a NEW guest, without touching the original:
#
#   1. zfs clone the snapshot to a scratch dataset mounted under a temp dir
#   2. package it as an Incus backup tarball (backup/index.yaml + the
#      instance directory: backup.yaml, rootfs/, metadata.yaml, templates/)
#   3. incus import <tarball> <new-guest-name>   (Incus renames on import)
#   4. destroy the clone and the tarball
#
# For Incus's own snapshots (snapshot-<name>) ProxyPilot uses `incus copy
# guest/snap new` instead; this helper is only reached for the others.
# Called by restore_guest_from_snapshot after the plan/confirm flow.
set -euo pipefail
SNAP="${1:-}"; NEW="${2:-}"; POOL="${3:-}"
WORK="${PROXYPILOT_STORAGE_STATE_DIR:-/var/lib/proxypilot/storage}/restore"

usage() { echo "usage: $0 <dataset@snapshot> <new-guest-name> <incus-pool>" >&2; exit 64; }
[[ "$SNAP" =~ ^[A-Za-z][A-Za-z0-9_.:/-]*@[A-Za-z0-9_.:-]+$ ]] || usage
[[ "$NEW" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$ ]] || usage
[[ -z "$POOL" || "$POOL" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$ ]] || usage

DATASET="${SNAP%@*}"
zfs list -H -o name -t snapshot "$SNAP" >/dev/null || { echo "snapshot $SNAP does not exist" >&2; exit 66; }
if incus info "$NEW" >/dev/null 2>&1; then echo "guest $NEW already exists" >&2; exit 73; fi
if [[ -z "$POOL" ]]; then POOL="$(incus profile device get default root pool 2>/dev/null || echo default)"; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CLONE="${DATASET%/*}/pp-restore-${NEW}-${STAMP}"
MNT="$WORK/$NEW-$STAMP"
TAR="$WORK/$NEW-$STAMP.tar"
mkdir -p "$MNT"
cleanup() {
  set +e
  umount "$MNT" 2>/dev/null
  zfs destroy -r "$CLONE" 2>/dev/null
  rm -rf "$MNT" "$TAR"
}
trap cleanup EXIT

echo "cloning $SNAP -> $CLONE"
zfs clone -o mountpoint=legacy -o canmount=noauto "$SNAP" "$CLONE"
mount -t zfs "$CLONE" "$MNT"
[[ -f "$MNT/backup.yaml" ]] || { echo "$SNAP does not look like an Incus instance dataset (no backup.yaml)" >&2; exit 65; }
[[ -d "$MNT/rootfs" ]] || { echo "$SNAP has no rootfs directory" >&2; exit 65; }

# index.yaml: the instance's backup.yaml nested under `config`, plus the
# header fields `incus export` writes. Snapshots are deliberately not
# carried (the new guest starts with none). The type is read from the
# instance section (container | virtual-machine).
python3 - "$MNT/backup.yaml" "$MNT/index.yaml" "$NEW" "$POOL" <<'PY'
import sys
try:
    import yaml
except ImportError:
    from ruamel import yaml as ryaml
    class yaml:  # minimal shim over ruamel
        @staticmethod
        def safe_load(s): return ryaml.YAML(typ="safe").load(s)
        @staticmethod
        def safe_dump(d, stream, **kw): ryaml.YAML(typ="safe").dump(d, stream)
src, dst, name, pool = sys.argv[1:5]
with open(src) as f:
    cfg = yaml.safe_load(f) or {}
# Keep whichever key this Incus version wrote ("instance" on current Incus,
# "container" on older / LXD-era backups); only the name changes.
key = "instance" if "instance" in cfg else "container"
inst = cfg.get(key) or {}
inst["name"] = name
cfg[key] = inst
cfg["snapshots"] = []
if isinstance(cfg.get("pool"), dict):
    cfg["pool"]["name"] = pool
if isinstance(cfg.get("volume"), dict):
    cfg["volume"]["name"] = name
cfg["volume_snapshots"] = []
# Fields of the Info struct Incus reads from backup/index.yaml (internal/server/backup/backup_info.go):
# name, backend, pool, snapshots, optimized, optimized_header, type, config.
index = {"name": name, "backend": "zfs", "pool": pool, "snapshots": [], "optimized": False, "optimized_header": False,
         "type": inst.get("type", "container"), "config": cfg}
with open(dst, "w") as f:
    yaml.safe_dump(index, f, default_flow_style=False, sort_keys=False)
with open(src, "w") as f:
    yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)
PY

echo "packaging $TAR"
# Layout Incus expects: backup/index.yaml + backup/container/{backup.yaml,rootfs,metadata.yaml,templates}
tar -C "$MNT" --xattrs --acls --numeric-owner \
  --transform='s,^index\.yaml$,backup/index.yaml,' \
  --transform='s,^\(backup\.yaml\|rootfs\|metadata\.yaml\|templates\)\(/\|$\),backup/container/\1\2,' \
  -cf "$TAR" index.yaml backup.yaml rootfs $( [[ -f "$MNT/metadata.yaml" ]] && echo metadata.yaml ) $( [[ -d "$MNT/templates" ]] && echo templates )

echo "importing as $NEW into pool $POOL"
incus import "$TAR" "$NEW" --storage "$POOL"
echo "restored $NEW from $SNAP"
