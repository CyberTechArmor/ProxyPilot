#!/bin/sh
# Disposable A3 LXC smoke probe. Never use as a worker launch script.
set -eu
umask 077

work=/tmp/a3-lxc-probe
mkdir -p "$work"
cleanup() {
  rm -f "$work/fill.bin"
  rmdir "$work" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

printf 'memory.max=%s\n' "$(cat /sys/fs/cgroup/memory.max)"
printf 'memory.swap.max=%s\n' "$(cat /sys/fs/cgroup/memory.swap.max)"
printf 'cpu.max=%s\n' "$(cat /sys/fs/cgroup/cpu.max)"
printf 'cpuset.cpus.effective=%s\n' "$(cat /sys/fs/cgroup/cpuset.cpus.effective)"
printf 'pids.max=%s\n' "$(cat /sys/fs/cgroup/pids.max)"
if test -S /dev/incus/sock; then echo 'guest_api_socket=present'; else echo 'guest_api_socket=absent'; fi

# A 160 MiB actual write must be refused by a 128 MiB writable-space cap.
dd if=/dev/zero of="$work/fill.bin" bs=1048576 count=160 status=none
printf 'disk_write_bytes=%s\n' "$(wc -c < "$work/fill.bin")"

# Stay safely below host process capacity while exceeding a one-browser-tree
# policy. Each child has a fixed three-second lifetime.
i=0
pids=''
while test "$i" -lt 32; do
  sleep 3 &
  pids="$pids $!"
  i=$((i + 1))
done
printf 'spawned_children=%s\n' "$i"
printf 'pids.current.during_probe=%s\n' "$(cat /sys/fs/cgroup/pids.current)"
for pid in $pids; do wait "$pid"; done
echo 'children_reaped=yes'
