#!/bin/sh
# One-shot disposable LXC memory overrun probe; not a worker program.
set -u
umask 077
marker=/opt/a3-probe/.memory-probe-attempted
fill=/dev/shm/a3-memory-probe
if test -e "$marker"; then
  echo 'memory_probe=already_attempted'
  exit 0
fi
touch "$marker"
trap 'rm -f "$fill"' EXIT HUP INT TERM
printf 'memory.events.before=%s\n' "$(tr '\n' ',' < /sys/fs/cgroup/memory.events)"
timeout 12s dd if=/dev/zero of="$fill" bs=1048576 count=600 status=none
result=$?
printf 'memory_write_exit=%s\n' "$result"
printf 'memory.events.after=%s\n' "$(tr '\n' ',' < /sys/fs/cgroup/memory.events)"
exit 0
