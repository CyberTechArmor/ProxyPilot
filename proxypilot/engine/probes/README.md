# Probe cache

The engine writes each entry's `playbook.detect.probe` here on first
read so an operator can inspect or re-run the exact script the engine
executed. Files are named `<CVE-ID>.sh` and overwritten when the inbox
spec changes; this directory is purely a cache, never authoritative.

The runner today inlines the probe via `/bin/sh -e -c` and does not
read from this cache — it exists for operator audit and as a hook for
a future `probe-from-cache` mode if probe execution needs to be
sandboxed.
