#!/bin/bash
# ProxyPilot self-update runner — the root-owned half of "Update now".
#
# Who runs it:
#   * systemd, as root, through deploy/proxypilot-update.path →
#     deploy/proxypilot-update.service, whenever the host-side agent drops a
#     request file at /run/proxypilot-update/request.json (no arguments);
#   * install.sh / update.sh directly, with `record-source <checkout>` and
#     `check`, so the recorded checkout facts exist before the first request.
#
# Why it exists: the dashboard backend runs inside Docker and dies at the
# `docker compose down` that update.sh performs, and the agent is an
# unprivileged NoNewPrivileges service. Neither can run update.sh. systemd
# owns this process, so it survives the restart it causes. The request file
# is the whole privilege boundary: only the agent can write into
# /run/proxypilot-update (0750, proxypilot-agent), every request is validated
# (owner, freshness, nonce, flag allowlist) before anything runs, and the only
# thing a valid request can do is run `update.sh --yes` with allowlisted flags
# — never --discard-local, never an arbitrary command.
#
# Contract (docs/features/self-update.md):
#   request.json    {"id","action":"update|check","requested_by",
#                    "requested_at","requested_at_unix","nonce","flags"}
#   nonce.<id>      the same nonce, written by the agent next to the request
#   state.json      the latest run; state.<id>.json one file per run
#   <id>.log        the full update.sh output of that run
#   done.<id>       touched when a run has finished (success or failed)
#   installed.json  checkout facts (branch, sha, dirty…) refreshed by `check`
#   source-dir      absolute path of the git checkout update.sh lives in
#
# Every function is defined before main is called on the LAST line, so bash
# has parsed the whole file before anything runs: update.sh replaces this
# script mid-run on a self-update, and a half-read script must not matter.

set -uo pipefail

RUN_DIR="${PROXYPILOT_UPDATE_RUN_DIR:-/run/proxypilot-update}"
STATE_DIR="${PROXYPILOT_UPDATE_STATE_DIR:-/var/lib/proxypilot/update}"
LOCK_FILE="${PROXYPILOT_UPDATE_LOCK:-/var/lock/proxypilot-update.lock}"
# The only user allowed to author a request (the agent's service user). Tests
# set it to the invoking user; an empty value disables the owner check.
REQUEST_OWNER="${PROXYPILOT_UPDATE_REQUEST_OWNER-proxypilot-agent}"
REQUEST_MAX_AGE="${PROXYPILOT_UPDATE_REQUEST_MAX_AGE:-120}"
ALLOWED_FLAGS="--rebuild --enable-mock2"
PHASE_TOTAL=7
HISTORY_KEEP=10

SOURCE_DIR=""

# Run state (globals so the pipeline subshell that tracks phases inherits them).
S_ID="" S_ACTION="" S_STATUS="" S_PHASE="" S_PHASE_INDEX=0
S_STARTED_AT="" S_STARTED_UNIX=0 S_FINISHED_AT="" S_EXIT=""
S_REQUESTED_BY="" S_FROM_SHA="" S_TO_SHA="" S_FROM_VERSION="" S_TO_VERSION=""
S_FLAGS="" S_REASON="" S_LOG="" S_UP_TO_DATE=false

log() {
    printf '%s proxypilot-update-runner: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2
}

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
now_unix() { date -u '+%s'; }

# Escape a value for use inside a JSON string literal.
json_str() {
    local s="$1"
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/\\r}
    s=${s//$'\t'/\\t}
    printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037'
}

# "value" or null for optional string fields.
json_opt_str() {
    if [ -n "$1" ]; then printf '"%s"' "$(json_str "$1")"; else printf 'null'; fi
}

# number or null for optional numeric fields.
json_opt_num() {
    if [[ "$1" =~ ^-?[0-9]+$ ]]; then printf '%s' "$1"; else printf 'null'; fi
}

strip_ansi() {
    sed -E $'s/\x1b\\[[0-9;?]*[ -\\/]*[@-~]//g'
}

# First "key":"string" value in a one-line JSON file. Only used on files this
# runner or the agent wrote; every extracted value is re-validated by regex.
json_field() {
    sed -nE "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\1/p" "$1" 2>/dev/null | head -n1
}

json_number() {
    sed -nE "s/.*\"$2\"[[:space:]]*:[[:space:]]*(-?[0-9]+(\.[0-9]+)?).*/\1/p" "$1" 2>/dev/null | head -n1
}

write_atomic() {
    # $1 path, $2 content, $3 mode
    local tmp="$1.tmp.$$"
    printf '%s\n' "$2" > "$tmp" && chmod "${3:-0644}" "$tmp" && mv -f "$tmp" "$1"
}

# Write state.<id>.json and, unless another run is live in state.json, state.json.
write_state() {
    local json
    json=$(printf '{"id":"%s","action":"%s","status":"%s","phase":"%s","phase_index":%s,"phase_total":%s,"started_at":"%s","started_at_unix":%s,"finished_at":%s,"exit_code":%s,"requested_by":"%s","from_sha":"%s","to_sha":"%s","from_version":"%s","to_version":"%s","flags":"%s","reason":%s,"up_to_date":%s,"log":"%s","runner_pid":%s,"updated_at":"%s"}' \
        "$(json_str "$S_ID")" "$(json_str "$S_ACTION")" "$(json_str "$S_STATUS")" \
        "$(json_str "$S_PHASE")" "${S_PHASE_INDEX:-0}" "$PHASE_TOTAL" \
        "$(json_str "$S_STARTED_AT")" "${S_STARTED_UNIX:-0}" \
        "$(json_opt_str "$S_FINISHED_AT")" "$(json_opt_num "$S_EXIT")" \
        "$(json_str "$S_REQUESTED_BY")" "$(json_str "$S_FROM_SHA")" "$(json_str "$S_TO_SHA")" \
        "$(json_str "$S_FROM_VERSION")" "$(json_str "$S_TO_VERSION")" "$(json_str "$S_FLAGS")" \
        "$(json_opt_str "$S_REASON")" "$S_UP_TO_DATE" "$(json_str "$S_LOG")" "$$" "$(now_iso)")
    write_atomic "$STATE_DIR/state.$S_ID.json" "$json"
    # A refusal must not clobber the record of a run that is still going.
    if [ "$S_STATUS" = "refused" ] && [ -f "$STATE_DIR/state.json" ]; then
        local cur_status cur_id
        cur_status=$(json_field "$STATE_DIR/state.json" status)
        cur_id=$(json_field "$STATE_DIR/state.json" id)
        if [ "$cur_status" = "running" ] && [ "$cur_id" != "$S_ID" ]; then
            return 0
        fi
    fi
    write_atomic "$STATE_DIR/state.json" "$json"
}

# Locate the git checkout update.sh lives in. install.sh/update.sh record it;
# /opt/proxypilot is accepted when it is itself a checkout.
resolve_source_dir() {
    SOURCE_DIR=""
    local cand=""
    if [ -f "$STATE_DIR/source-dir" ]; then
        cand=$(head -n1 "$STATE_DIR/source-dir" | tr -d '\r')
    fi
    local d
    for d in "$cand" /opt/proxypilot; do
        if [ -n "$d" ] && [ -f "$d/update.sh" ] && [ -e "$d/.git" ]; then
            SOURCE_DIR="$d"
            return 0
        fi
    done
    return 1
}

git_env() {
    # Git as root over a checkout that may be owned by the operator's user:
    # trust exactly that directory. HOME may be unset under systemd.
    export HOME="${HOME:-/root}"
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$SOURCE_DIR"
}

package_version() {
    local f="$1/admin/backend/package.json"
    [ -f "$f" ] || { printf ''; return; }
    grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$f" | head -n1 | sed -E 's/.*"([^"]+)"$/\1/'
}

# installed.json — the read-only facts the dashboard's "Update" block shows.
record_installed() {
    local checked_at checked_unix
    checked_at=$(now_iso); checked_unix=$(now_unix)
    if ! resolve_source_dir; then
        write_atomic "$STATE_DIR/installed.json" \
            "$(printf '{"configured":false,"checked_at":"%s","checked_at_unix":%s,"source_dir":"","error":"%s"}' \
                "$checked_at" "$checked_unix" \
                "$(json_str "No ProxyPilot git checkout recorded. Run install.sh or update.sh once from the checkout (it records the path in $STATE_DIR/source-dir).")")"
        return 1
    fi
    git_env
    local branch sha short cdate subject remote version
    branch=$(git -C "$SOURCE_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')
    sha=$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo '')
    short=$(git -C "$SOURCE_DIR" rev-parse --short=10 HEAD 2>/dev/null || echo '')
    cdate=$(git -C "$SOURCE_DIR" log -1 --format=%cI 2>/dev/null || echo '')
    subject=$(git -C "$SOURCE_DIR" log -1 --format=%s 2>/dev/null || echo '')
    remote=$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || echo '')
    version=$(package_version "$SOURCE_DIR")
    # package-lock.json drift is generated and auto-restored by update.sh, so
    # it does not count as a local change (mirrors update.sh's own check).
    local dirty_lines dirty_count files_json="" n=0 line
    dirty_lines=$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null | grep -vE 'package-lock\.json$' || true)
    dirty_count=0
    if [ -n "$dirty_lines" ]; then
        dirty_count=$(printf '%s\n' "$dirty_lines" | wc -l | tr -d ' ')
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            n=$((n + 1))
            [ "$n" -gt 20 ] && break
            [ -n "$files_json" ] && files_json="$files_json,"
            files_json="$files_json\"$(json_str "$line")\""
        done <<< "$dirty_lines"
    fi
    local dirty=false
    [ "$dirty_count" -gt 0 ] && dirty=true
    write_atomic "$STATE_DIR/installed.json" \
        "$(printf '{"configured":true,"checked_at":"%s","checked_at_unix":%s,"source_dir":"%s","branch":"%s","head_sha":"%s","head_short":"%s","head_date":"%s","head_subject":"%s","remote_url":"%s","dirty":%s,"dirty_count":%s,"dirty_files":[%s],"installed_version":"%s"}' \
            "$checked_at" "$checked_unix" "$(json_str "$SOURCE_DIR")" "$(json_str "$branch")" \
            "$(json_str "$sha")" "$(json_str "$short")" "$(json_str "$cdate")" "$(json_str "$subject")" \
            "$(json_str "$remote")" "$dirty" "$dirty_count" "$files_json" "$(json_str "$version")")"
    log "recorded checkout facts: $SOURCE_DIR @ $short (dirty=$dirty)"
}

record_source() {
    local dir="${1:-}"
    if [ -z "$dir" ] || [ ! -f "$dir/update.sh" ] || [ ! -e "$dir/.git" ]; then
        log "record-source: '$dir' is not a ProxyPilot git checkout (needs update.sh and .git)"
        return 2
    fi
    dir=$(cd "$dir" && pwd -P)
    write_atomic "$STATE_DIR/source-dir" "$dir"
    log "recorded source checkout: $dir"
}

prune_history() {
    # Keep the newest HISTORY_KEEP runs (state.<id>.json + log + done marker).
    local f id n=0
    # shellcheck disable=SC2012
    for f in $(ls -t "$STATE_DIR"/state.*.json 2>/dev/null); do
        n=$((n + 1))
        [ "$n" -le "$HISTORY_KEEP" ] && continue
        id=$(basename "$f" .json); id=${id#state.}
        rm -f "$f" "$STATE_DIR/$id.log" "$STATE_DIR/done.$id"
    done
}

# Reads update.sh output line by line: append to the run log, echo to the
# journal, and turn the "[n/7]" markers into the phase in state.json.
track_output() {
    local line idx text
    while IFS= read -r line; do
        printf '%s\n' "$line" >> "$S_LOG"
        printf '%s\n' "$line"
        case "$line" in
            *'['[0-9]*'/'"$PHASE_TOTAL"']'*)
                idx=$(printf '%s' "$line" | sed -nE "s/.*\[([0-9]+(\.[0-9]+)?)\/${PHASE_TOTAL}\].*/\1/p")
                text=$(printf '%s' "$line" | strip_ansi | sed -E "s/.*\[[0-9.]+\/${PHASE_TOTAL}\][[:space:]]*//; s/\.\.\.[[:space:]]*$//")
                if [ -n "$idx" ]; then
                    S_PHASE_INDEX="$idx"
                    S_PHASE="$text"
                    write_state
                fi
                ;;
        esac
    done
}

refuse() {
    # $1 reason code, $2 human reason
    S_STATUS=refused
    S_REASON="$1: $2"
    S_FINISHED_AT=$(now_iso)
    S_PHASE="Refused"
    [ -n "$S_ID" ] || S_ID="unknown"
    [ -n "$S_STARTED_AT" ] || { S_STARTED_AT=$(now_iso); S_STARTED_UNIX=$(now_unix); }
    log "refused request ${S_ID}: ${S_REASON}"
    write_state
}

run_update() {
    S_ACTION=update
    S_STATUS=queued
    S_PHASE="Queued"
    S_PHASE_INDEX=0
    S_STARTED_AT=$(now_iso); S_STARTED_UNIX=$(now_unix)
    S_LOG="$STATE_DIR/$S_ID.log"
    : > "$S_LOG"; chmod 0644 "$S_LOG"

    if ! resolve_source_dir; then
        refuse source_dir_missing "no ProxyPilot git checkout recorded; run update.sh by hand once"
        return 1
    fi
    if command -v flock >/dev/null 2>&1; then
        flock -n -E 99 "$LOCK_FILE" true 2>/dev/null
        if [ $? -eq 99 ]; then
            refuse already_running "another update.sh holds $LOCK_FILE"
            return 1
        fi
    fi
    git_env
    S_FROM_SHA=$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo '')
    S_FROM_VERSION=$(package_version "$SOURCE_DIR")
    write_state

    S_STATUS=running
    S_PHASE="Starting update.sh"
    write_state
    log "run $S_ID: bash $SOURCE_DIR/update.sh --yes $S_FLAGS (requested by $S_REQUESTED_BY)"

    # shellcheck disable=SC2086  # $S_FLAGS is an allowlisted, space-separated list.
    (
        cd "$SOURCE_DIR" || exit 97
        export TERM="${TERM:-dumb}"
        export PROXYPILOT_UPDATE_RUNNER=1 PROXYPILOT_UPDATE_ID="$S_ID"
        exec bash ./update.sh --yes $S_FLAGS
    ) 2>&1 | track_output
    local rc=${PIPESTATUS[0]}

    # The phase tracker ran in the pipeline subshell; read back what it recorded.
    S_PHASE=$(json_field "$STATE_DIR/state.$S_ID.json" phase)
    S_PHASE_INDEX=$(json_number "$STATE_DIR/state.$S_ID.json" phase_index)
    [ -n "$S_PHASE_INDEX" ] || S_PHASE_INDEX=0
    S_TO_SHA=$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo '')
    S_TO_VERSION=$(package_version "$SOURCE_DIR")
    S_FINISHED_AT=$(now_iso)
    S_EXIT="$rc"
    if [ "$rc" -eq 0 ]; then
        S_STATUS=success
        S_PHASE="Update complete"
        S_PHASE_INDEX=$PHASE_TOTAL
        if grep -q 'Code is already up to date' "$S_LOG" 2>/dev/null && [ "$S_FROM_SHA" = "$S_TO_SHA" ]; then
            S_UP_TO_DATE=true
            S_PHASE="Already up to date"
        fi
    else
        S_STATUS=failed
        S_REASON=$(grep -v '^[[:space:]]*$' "$S_LOG" 2>/dev/null | tail -n 1 | strip_ansi | cut -c1-240)
        [ -n "$S_REASON" ] || S_REASON="update.sh exited with status $rc"
    fi
    write_state
    : > "$STATE_DIR/done.$S_ID"
    log "run $S_ID finished: $S_STATUS (exit $rc) $S_FROM_SHA -> $S_TO_SHA"
    record_installed || true
    prune_history
    [ "$rc" -eq 0 ]
}

# Path-unit entry: take the request file, validate it, dispatch.
handle_request() {
    local req="$RUN_DIR/request.json"
    if [ ! -f "$req" ]; then
        log "no request at $req; nothing to do"
        return 0
    fi
    local owner taken
    owner=$(stat -c %U "$req" 2>/dev/null || echo '?')
    taken="$RUN_DIR/request.$(date +%s%N).taken"
    if ! mv -f "$req" "$taken"; then
        log "cannot take $req"
        return 1
    fi

    local id action requested_by requested_unix nonce flags
    id=$(json_field "$taken" id)
    action=$(json_field "$taken" action)
    requested_by=$(json_field "$taken" requested_by)
    requested_unix=$(json_number "$taken" requested_at_unix)
    nonce=$(json_field "$taken" nonce)
    flags=$(json_field "$taken" flags)
    rm -f "$taken"

    if [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        S_ID="$id"
    else
        S_ID="unknown"
        refuse malformed "request id is not a uuid"
        return 1
    fi
    S_REQUESTED_BY="$requested_by"
    S_FLAGS="$flags"
    S_ACTION="$action"
    local nonce_file="$RUN_DIR/nonce.$S_ID"

    if [ -n "$REQUEST_OWNER" ] && [ "$owner" != "$REQUEST_OWNER" ]; then
        rm -f "$nonce_file"
        refuse not_written_by_agent "request.json is owned by '$owner', not '$REQUEST_OWNER'"
        return 1
    fi
    case "$action" in
        update|check) ;;
        *) rm -f "$nonce_file"; refuse malformed "unknown action '$action'"; return 1 ;;
    esac
    if ! [[ "$requested_by" =~ ^[A-Za-z0-9._@:+-]{1,80}$ ]]; then
        rm -f "$nonce_file"
        refuse malformed "requested_by is missing or malformed"
        return 1
    fi
    local now age
    now=$(now_unix)
    if ! [[ "$requested_unix" =~ ^[0-9]+$ ]]; then
        rm -f "$nonce_file"
        refuse malformed "requested_at_unix is missing"
        return 1
    fi
    age=$((now - requested_unix))
    if [ "$age" -gt "$REQUEST_MAX_AGE" ] || [ "$age" -lt -60 ]; then
        rm -f "$nonce_file"
        refuse stale "request is ${age}s old (limit ${REQUEST_MAX_AGE}s)"
        return 1
    fi
    if ! [[ "$nonce" =~ ^[0-9a-f]{32,64}$ ]] || [ ! -f "$nonce_file" ]; then
        rm -f "$nonce_file"
        refuse nonce_mismatch "no nonce file for this request"
        return 1
    fi
    local nonce_owner expected
    nonce_owner=$(stat -c %U "$nonce_file" 2>/dev/null || echo '?')
    expected=$(head -n1 "$nonce_file" | tr -d '[:space:]')
    rm -f "$nonce_file"
    if [ -n "$REQUEST_OWNER" ] && [ "$nonce_owner" != "$REQUEST_OWNER" ]; then
        refuse nonce_mismatch "nonce file is owned by '$nonce_owner', not '$REQUEST_OWNER'"
        return 1
    fi
    if [ "$expected" != "$nonce" ]; then
        refuse nonce_mismatch "request nonce does not match the agent's nonce"
        return 1
    fi
    local f ok
    for f in $flags; do
        ok=false
        for a in $ALLOWED_FLAGS; do [ "$f" = "$a" ] && ok=true; done
        if [ "$ok" != true ]; then
            refuse invalid_flags "flag '$f' is not allowed (allowed: $ALLOWED_FLAGS)"
            return 1
        fi
    done

    case "$action" in
        check)
            log "check request $S_ID from $requested_by"
            record_installed
            ;;
        update)
            run_update
            ;;
    esac
}

usage() {
    cat <<'EOF'
ProxyPilot self-update runner (root)

  proxypilot-update-runner                 handle /run/proxypilot-update/request.json
                                           (what deploy/proxypilot-update.path runs)
  proxypilot-update-runner check           refresh /var/lib/proxypilot/update/installed.json
  proxypilot-update-runner record-source <checkout>
                                           record the git checkout update.sh lives in

Environment overrides (tests): PROXYPILOT_UPDATE_RUN_DIR, PROXYPILOT_UPDATE_STATE_DIR,
PROXYPILOT_UPDATE_LOCK, PROXYPILOT_UPDATE_REQUEST_OWNER, PROXYPILOT_UPDATE_REQUEST_MAX_AGE.
EOF
}

main() {
    umask 022
    mkdir -p "$STATE_DIR" 2>/dev/null || { log "cannot create $STATE_DIR"; exit 1; }
    chmod 0755 "$STATE_DIR" 2>/dev/null || true
    case "${1:-}" in
        "") handle_request ;;
        check) record_installed ;;
        record-source) record_source "${2:-}" ;;
        --help|-h) usage ;;
        *) usage >&2; exit 2 ;;
    esac
}

main "$@"
