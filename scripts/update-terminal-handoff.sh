#!/bin/bash
# Host terminal PTYs remain children of the dashboard container even after
# nsenter. Neither nohup nor ignoring SIGHUP moves a process out of that
# container's cgroup. A transient SYSTEM service gives the host manager
# ownership of the update before the dashboard or its PTY can disappear.

pp_dashboard_terminal_ancestor() {
    [[ "${PROXYPILOT_TERMINAL:-}" = host || "${DOCKER_CONTAINER:-}" = true ]] && return 0
    # sudo normally clears these variables. Check only these two exact markers
    # in the ancestor chain; never print or forward any environment contents.
    local pid=$$ parent depth=0
    while [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$depth" -lt 32 ]]; do
        if grep -zEq '^(PROXYPILOT_TERMINAL=host|DOCKER_CONTAINER=true)$' "/proc/$pid/environ" 2>/dev/null; then
            return 0
        fi
        parent=$(awk '$1 == "PPid:" { print $2 }' "/proc/$pid/status" 2>/dev/null) || return 1
        [[ "$parent" != "$pid" ]] || return 1
        pid="$parent"
        depth=$((depth + 1))
    done
    return 1
}

pp_handoff_terminal_update() {
    local checkout="$1" unit name
    shift
    if [[ "$EUID" -ne 0 ]] || ! command -v systemd-run >/dev/null || ! command -v systemctl >/dev/null; then
        log 'Cannot hand this terminal update to the host service manager. Run the updater as root from SSH or the server console; no update work has started.'
        return 1
    fi
    if ! systemctl show --property=Version --value >/dev/null 2>&1; then
        log 'Host systemd is unavailable. Refusing to restart ProxyPilot from its own terminal; use SSH or the server console. No update work has started.'
        return 1
    fi
    unit="proxypilot-terminal-update-$(date +%s)-$$"
    local -a options=(
        "--unit=$unit" --service-type=exec
        --property=StandardInput=null --property=StandardOutput=journal --property=StandardError=journal
        # Match the normal root runner: a native backend started by this
        # update must survive after the updater itself finishes.
        --property=KillMode=process
        "--working-directory=$checkout"
        --setenv=PROXYPILOT_UPDATE_RUNNER=1 --setenv=TERM=dumb --setenv=HOME=/root
        --setenv=PROXYPILOT_TERMINAL_HANDOFF=1
        --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/snap/bin
    )
    # Preserve intentional Compose selection/overrides without exporting the
    # dashboard's credentials or database/container environment to a root unit.
    for name in COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_PATH_SEPARATOR; do
        if [[ -v "$name" ]]; then options+=("--setenv=$name=${!name}"); fi
    done
    # No --pty/--pipe/--scope: output and lifetime must be independent of the
    # caller. --yes takes only safe defaults; --discard-local is never added.
    # An older updater may have acquired fd 200 before pulling/re-execing this
    # version. Release our copy before starting the independent lock owner.
    exec 200>&-
    if ! systemd-run "${options[@]}" -- /bin/bash ./update.sh --yes "$@"; then
        log 'Could not start the independent update service. Refusing to continue inside the dashboard terminal; no update work has started.'
        return 1
    fi
    log "Update handed to host service ${unit}.service. It is starting; completion has not been verified."
    log 'The terminal may disconnect during restart. The update continues on the host.'
    log "Follow progress over SSH/console: journalctl -fu ${unit}.service"
    log "Read its final log: journalctl -u ${unit}.service --no-pager -n 80"
    log 'The update log is also at /tmp/proxypilot-update.log.'
}

pp_report_update_completion() {
    if [[ "${SKIP_RESTART:-false}" = true ]]; then
        log 'Build completed; restart was skipped. Dashboard health has not been verified.'
    elif [[ "${HEALTHY:-false}" = true ]]; then
        log 'Update completed successfully — ProxyPilot restarted and its health check passed.'
    else
        log 'Update is not complete: dashboard health has not been verified.'
        return 1
    fi
}
