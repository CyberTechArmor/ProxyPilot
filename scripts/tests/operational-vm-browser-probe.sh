#!/bin/sh
# Disposable A3 VM browser viability probe; never use as a worker launcher.
set -eu
umask 077
export DEBIAN_FRONTEND=noninteractive

log=/tmp/a3-browser-install.log
dom=/tmp/a3-browser-dom.html
err=/tmp/a3-browser-stderr.log
profile=/tmp/a3-browser-profile
cleanup() {
  rm -f "$log" "$dom" "$err"
  rm -rf "$profile"
}
trap cleanup EXIT HUP INT TERM

if ! command -v chromium >/dev/null 2>&1; then
  if ! timeout 180s apt-get update -qq >"$log" 2>&1 ||
     ! timeout 180s apt-get install -y --no-install-recommends chromium ca-certificates >>"$log" 2>&1; then
    echo 'browser_install=failed'
    tail -n 12 "$log"
    exit 1
  fi
fi
echo "browser_version=$(chromium --version)"
if ! id -u a3browser >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/sh a3browser
fi
set +e
runuser -u a3browser -- timeout 15s chromium --headless=new --disable-gpu \
  --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --disable-background-networking --disable-component-update \
  --user-data-dir="$profile" --dump-dom 'data:text/html,<html><body>A3-local</body></html>' \
  >"$dom" 2>"$err"
local_status=$?
set -e
echo "browser_local_exit=$local_status"
echo "browser_local_dom_bytes=$(wc -c < "$dom")"
if grep -q 'A3-local' "$dom"; then echo 'browser_local_dom=yes'; else echo 'browser_local_dom=no'; fi
if test "$local_status" -ne 0; then tail -n 8 "$err"; fi
rm -rf "$profile"
set +e
runuser -u a3browser -- timeout 25s chromium --headless=new --disable-gpu \
  --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --disable-background-networking --disable-component-update \
  --virtual-time-budget=10000 --user-data-dir="$profile" \
  --dump-dom https://demo.fractionate.ai >"$dom" 2>"$err"
status=$?
set -e
echo "browser_exit=$status"
echo "browser_dom_bytes=$(wc -c < "$dom")"
if grep -qi '<html' "$dom"; then echo 'browser_dom_html=yes'; else echo 'browser_dom_html=no'; fi
if test "$status" -ne 0; then tail -n 12 "$err"; fi
free -m
