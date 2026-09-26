#!/usr/bin/env bash
# Upgrade a single-host Incus installation to Zabbly stable during ProxyPilot
# update. Refuse before apt if a complete local rollback checkpoint cannot be
# made. Do not try an automatic downgrade after a possible DB schema migration.
set -euo pipefail

say() { printf 'Incus upgrade: %s\n' "$*"; }
die() { say "REFUSED: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'root is required'
command -v incus >/dev/null 2>&1 || die 'Incus is not installed'
command -v python3 >/dev/null 2>&1 || die 'python3 is required for the inventory check'

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
before_version=$(incus version) || die 'the installed Incus daemon is not responding'
before_instances=$(incus list --all-projects --format json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))') || die 'cannot list instances across all projects'
server_json=$(incus query /1.0) || die 'cannot inspect the Incus server'
if ! printf '%s' "$server_json" | python3 -c 'import json,sys; o=json.load(sys.stdin); e=o.get("metadata",o)["environment"]; sys.exit(0 if e.get("server_clustered") is False else 1)'; then
    die 'cluster status is unknown or clustered; a coordinated Incus upgrade is required'
fi
# Incus 7.x requires Linux >= 6.12. Check before touching apt sources.
kernel=$(uname -r)
major=${kernel%%.*}
minor=${kernel#*.}; minor=${minor%%.*}
[[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || die "cannot parse kernel $kernel"
if (( major < 6 || (major == 6 && minor < 12) )); then
    die "kernel $kernel is below the Incus 7.x minimum of 6.12"
fi
[ -d /var/lib/incus/database ] || die '/var/lib/incus/database is missing'

# The only external driver this updater can checkpoint is ZFS. A dir pool is
# covered by the full /var/lib/incus archive only when it lives there.
pools_json=$(incus storage list --format json) || die 'cannot inventory storage pools'
sources=$(printf '%s' "$pools_json" | python3 -c '
import json, os, sys
pools=json.load(sys.stdin)
for pool in pools:
    driver=pool.get("driver")
    source=(pool.get("config") or {}).get("source", "")
    if driver == "zfs" and source and not source.startswith("/"):
        print(source)
    elif driver == "dir" and (not source or os.path.realpath(source).startswith("/var/lib/incus/")):
        continue
    else:
        print("UNSUPPORTED:"+str(pool.get("name"))+":"+str(driver)+":"+source)
') || die 'cannot parse Incus storage pools'
mapfile -t zfs_sources <<< "$sources"
for source in "${zfs_sources[@]}"; do
    [ -n "$source" ] || continue
    [[ "$source" != UNSUPPORTED:* ]] || die "storage pool $source cannot be safely checkpointed"
    command -v zfs >/dev/null 2>&1 || die 'zfs is required to checkpoint external Incus storage'
    zfs list -H -o name "$source" >/dev/null || die "ZFS source $source is unavailable"
done

say "installed: $before_version; instances: $before_instances; kernel: $kernel"
bash "$script_dir/install-incus-stable.sh" --repository-only
stable_version=$(bash "$script_dir/incus-stable-candidate.sh")
[ -n "$stable_version" ] || die 'no signed Zabbly stable Incus package is available'
installed_version=$(dpkg-query -W -f='${Version}' incus) || die 'cannot read installed Incus package version'

if dpkg --compare-versions "$installed_version" ge "$stable_version"; then
    say "package already at or ahead of Zabbly stable ($installed_version)"
else
    # The simulation is recorded in the update log. Package removals need an
    # operator review; none are allowed in an unattended host update.
    apt_plan=$(apt-get -s install "incus=$stable_version") || die 'apt simulation failed'
    printf '%s\n' "$apt_plan"
    while read -r package; do
        [ -z "$package" ] && continue
        case "$package" in
            incus|incus-base|incus-agent|incus-client) ;;
            *) die "apt would remove non-Incus package $package" ;;
        esac
    done < <(printf '%s\n' "$apt_plan" | awk '$1 == "Remv" {print $2}')

    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    backup_dir="/var/backups/proxypilot/incus/pre-upgrade-$stamp-$$"
    install -d -m 0700 "$backup_dir" || die 'cannot create Incus backup directory'
    needed=$(du -sxB1 --apparent-size /var/lib/incus | awk '{print $1}')
    free=$(df -PB1 "$backup_dir" | awk 'NR==2 {print $4}')
    [[ "$needed" =~ ^[0-9]+$ && "$free" =~ ^[0-9]+$ ]] || die 'cannot measure backup capacity'
    (( free > needed + 1073741824 )) || die "backup disk has $free bytes free; need at least $((needed + 1073741824))"

    incus admin sql local .dump > "$backup_dir/local.sql" || die 'local database dump failed'
    incus admin sql global .dump > "$backup_dir/global.sql" || die 'global database dump failed'
    [ -s "$backup_dir/local.sql" ] && [ -s "$backup_dir/global.sql" ] || die 'a database dump was empty'

    # Stop the socket first so new clients cannot mutate the DB during the
    # archive. The EXIT trap restores management access after any failure.
    incus_stopped=false
    restore_service() {
        if [ "$incus_stopped" = true ]; then
            systemctl start incus.socket incus.service || true
        fi
    }
    trap restore_service EXIT
    incus_stopped=true
    systemctl stop incus.socket incus.service || die 'cannot stop Incus for a consistent backup'
    [ "$(systemctl is-active incus.service || true)" = inactive ] || die 'Incus service did not stop'

    # Snapshot each external ZFS source. If sources overlap, snapshot the
    # ancestor only so descendants do not get duplicate snapshot names.
    mapfile -t snapshot_sources < <(printf '%s\n' "${zfs_sources[@]}" | sort -u | awk 'NF { if (p=="" || index($0,p"/")!=1) {print; p=$0} }')
    for source in "${snapshot_sources[@]}"; do
        zfs snapshot -r "$source@proxypilot-incus-pre-$stamp" || die "ZFS snapshot of $source failed"
        say "ZFS checkpoint: $source@proxypilot-incus-pre-$stamp"
    done

    tar --one-file-system --xattrs --acls --numeric-owner -C /var/lib -cpf "$backup_dir/incus.tar" incus || die 'full /var/lib/incus archive failed'
    tar -tf "$backup_dir/incus.tar" >/dev/null || die 'Incus archive could not be read back'
    for file in /etc/subuid /etc/subgid; do
        [ ! -f "$file" ] || cp -a "$file" "$backup_dir/"
    done
    # tar -tf has already read the entire archive. Record a checksum for later
    # recovery checks; hashing the same local file a second time here does not
    # make this checkpoint more consistent and can exceed the update deadline.
    (cd "$backup_dir" && sha256sum incus.tar local.sql global.sql > SHA256SUMS) || die 'backup checksum creation failed'
    say "rollback checkpoint: $backup_dir"

    # Debian-to-Zabbly transitions may replace the old Incus split packages.
    # The simulation above refuses removal of anything else.
    export DEBIAN_FRONTEND=noninteractive
    apt-get -y --no-install-recommends -o Dpkg::Options::=--force-confold \
        install "incus=$stable_version" || die "apt failed; checkpoint at $backup_dir"
    systemctl start incus.socket incus.service || die "new Incus daemon did not start; checkpoint at $backup_dir"
    incus_stopped=false
    trap - EXIT
    after_version=$(incus version) || die "new Incus daemon is unavailable; checkpoint at $backup_dir"
    after_instances=$(incus list --all-projects --format json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))') || die "cannot list instances after upgrade; checkpoint at $backup_dir"
    [ "$after_instances" = "$before_instances" ] || die "instance count changed from $before_instances to $after_instances; checkpoint at $backup_dir"
    say "upgraded to $after_version; verified $after_instances instances; checkpoint $backup_dir"
fi

# Pin the documented default explicitly. Previously cached alias images keep
# their per-image auto_update state; custom and fingerprint-pinned images are
# deliberately not rewritten. Future alias downloads use this setting.
incus config set images.auto_update_cached=true || die 'cannot enable cached-image auto-update'
incus config set images.auto_update_interval=6 || die 'cannot enable six-hour image refresh'
[ "$(incus config get images.auto_update_cached)" = true ] || die 'cached-image auto-update did not read back true'
[ "$(incus config get images.auto_update_interval)" = 6 ] || die 'image update interval did not read back six hours'
say 'cached remote alias images: automatic updates enabled; interval: six hours'
