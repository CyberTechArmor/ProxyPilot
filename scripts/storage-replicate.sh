#!/usr/bin/env bash
# proxypilot-storage-replicate <job> — run one syncoid replication job and
# record its outcome where ProxyPilot reads it.
#
#   config:  /etc/proxypilot/storage/replication-<job>.conf  (KEY='value' lines,
#            written by the Storage page / set_replication_target; the SSH key
#            path lives only here)
#   status:  /var/lib/proxypilot/storage/replication/<job>.json
#   log:     /var/lib/proxypilot/storage/replication/<job>.log (last run)
#
# Runs from proxypilot-syncoid@<job>.service (timer) or directly from
# run_replication. Exit code is syncoid's.
set -u
JOB="${1:-}"
CONF_DIR="${PROXYPILOT_STORAGE_CONF_DIR:-/etc/proxypilot/storage}"
STATE_DIR="${PROXYPILOT_STORAGE_STATE_DIR:-/var/lib/proxypilot/storage}/replication"
SYNCOID="${SYNCOID_BIN:-$(command -v syncoid || echo /usr/sbin/syncoid)}"

if [[ -z "$JOB" || ! "$JOB" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]]; then
  echo "usage: $0 <job-name>" >&2; exit 64
fi
CONF="$CONF_DIR/replication-$JOB.conf"
if [[ ! -r "$CONF" ]]; then echo "no such job: $CONF" >&2; exit 66; fi

mkdir -p "$STATE_DIR"
STATUS="$STATE_DIR/$JOB.json"
LOG="$STATE_DIR/$JOB.log"
LOCK="$STATE_DIR/$JOB.lock"

# Only ever source the generated KEY='value' file; refuse anything else.
if grep -qvE "^(#.*|\s*|PP_REPL_[A-Z_]+='[^']*')$" "$CONF"; then
  echo "refusing to source $CONF: unexpected content" >&2; exit 65
fi
# shellcheck disable=SC1090
source "$CONF"

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$(sed 's/["\\]/\\&/g' | tr -d '\n')"; }
# A JSON string or null. Do NOT write ${v:+"\"$v\""}${v:-null}: when v IS set
# the second expansion yields v again, not null, so every successful run wrote
# "finished_at":"…""…" — invalid JSON, and replication_status then reported the
# job as never having succeeded.
json_str() { if [[ -z "${1:-}" ]]; then printf 'null'; else printf '"%s"' "$1"; fi; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
prev_success() { [[ -r "$STATUS" ]] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("last_success_at") or "")' "$STATUS" 2>/dev/null || true; }

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "job $JOB is already running" >&2; exit 75
fi

STARTED="$(now_iso)"
LAST_OK="$(prev_success)"
write_status() { # $1 running(true/false) $2 ok(true/false/null) $3 exit $4 error $5 finished
  local tail; tail="$(tail -c 4000 "$LOG" 2>/dev/null | json_escape)"
  local err; err="$(printf '%s' "$4" | json_escape)"
  cat > "$STATUS.tmp" <<JSON
{"name":"$JOB","started_at":$(json_str "$STARTED"),"finished_at":$(json_str "${5:-}"),"running":$1,"ok":$2,"exit_code":${3:-null},"error":$err,"last_success_at":$(json_str "${LAST_OK:-}"),"target":"$PP_REPL_TARGET","sources":"$PP_REPL_SOURCES","log_tail":$tail}
JSON
  # A status file that does not parse is worse than none: the dashboard would
  # read the job as never having run. Refuse to publish one.
  if command -v python3 >/dev/null 2>&1 && ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$STATUS.tmp" 2>/dev/null; then
    echo "refusing to write malformed status for $JOB" >&2
    rm -f "$STATUS.tmp"
    return 0
  fi
  mv -f "$STATUS.tmp" "$STATUS"
}

: > "$LOG"
write_status true null null "" ""

ARGS=()
[[ "${PP_REPL_RECURSIVE:-1}" == "1" ]] && ARGS+=(--recursive)
ARGS+=(--no-privilege-elevation --sendoptions=Lce --create-bookmark)
if [[ "${PP_REPL_KIND:-local}" == "remote" ]]; then
  # Compression is a network concern: a local target pipes straight through, so
  # the zstd binary is not a dependency of local replication.
  ARGS+=(--compress=zstd-fast)
else
  ARGS+=(--compress=none)
fi
if [[ "${PP_REPL_KIND:-local}" == "remote" && -n "${PP_REPL_SSH_KEY:-}" ]]; then
  ARGS+=(--sshkey="$PP_REPL_SSH_KEY")
  [[ -n "${PP_REPL_SSH_PORT:-}" ]] && ARGS+=(--sshport="$PP_REPL_SSH_PORT")
fi
# extra args are validated by ProxyPilot (--flag[=value] only) before they reach this file
for a in ${PP_REPL_EXTRA_ARGS:-}; do ARGS+=("$a"); done

rc=0
for src in $PP_REPL_SOURCES; do
  # target dataset = <target>/<last path component of the source>
  leaf="${src##*/}"
  dest="$PP_REPL_TARGET/$leaf"
  echo "== $(now_iso) syncoid ${ARGS[*]} $src $dest" >> "$LOG"
  # NOT `if ! cmd; then rc=$?`: inside that branch $? is the status of the `!`
  # negation, which is 0, so a failed replication reported itself successful.
  "$SYNCOID" "${ARGS[@]}" "$src" "$dest" >> "$LOG" 2>&1 || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "== failed with exit $rc" >> "$LOG"
    break
  fi
done

FINISHED="$(now_iso)"
if [[ $rc -eq 0 ]]; then
  LAST_OK="$FINISHED"
  write_status false true 0 "" "$FINISHED"
else
  # skip the wrapper's own "== " markers so the reason is syncoid's own words
  errline="$(grep -iE 'cannot|error|denied|refused|failed' "$LOG" | grep -v '^== ' | tail -n 1)"
  write_status false false "$rc" "${errline:-syncoid exit $rc}" "$FINISHED"
fi
exit $rc
