#!/bin/sh
# Disposable LXC setup-runner descendant probe; not an A3 worker.
setsid sleep 45 </dev/null >/dev/null 2>&1 &
printf 'detached_child_pid=%s\n' "$!"
exit 17
