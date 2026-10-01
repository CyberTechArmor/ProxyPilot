#!/bin/bash
# ProxyPilot pinned-build contract: 1
# Scoped Git checks for update.sh. Do not enable pipefail globally in the
# legacy operator script: many of its best-effort probes depend on that.

pp_update_result() {
    # This path is supplied by the root runner, never by an RPC caller.
    [ -n "${PROXYPILOT_UPDATE_RESULT_FILE:-}" ] || return 0
    local tmp="${PROXYPILOT_UPDATE_RESULT_FILE}.tmp.$$"
    printf '{"expected_sha":"%s","status":"%s","outcome":"%s","reason":"%s"}\n' \
        "${EXPECTED_UPDATE_SHA:-}" "$1" "${UPDATE_OUTCOME:-}" "${2:-}" > "$tmp" &&
        mv -f "$tmp" "$PROXYPILOT_UPDATE_RESULT_FILE"
}

pp_git_failure() {
    log "Update refused: $*"
    pp_update_result failed "$*" || true
    return 1
}

pp_git_logged() {
    local rc=0
    (set -o pipefail; "$GIT_CMD" -C "$SCRIPT_DIR" "$@" 2>&1 | tee -a "$LOG_FILE") || rc=$?
    if [ "$rc" -ne 0 ]; then
        pp_git_failure "git $1 failed (exit $rc); no successful update is recorded."
        return "$rc"
    fi
}

pp_verify_update_head() {
    local actual branch
    actual=$("$GIT_CMD" -C "$SCRIPT_DIR" rev-parse --verify HEAD) || return 1
    branch=$("$GIT_CMD" -C "$SCRIPT_DIR" symbolic-ref -q HEAD || true)
    if [ "$actual" != "$EXPECTED_UPDATE_SHA" ] || [ "$branch" != "$EXPECTED_UPDATE_BRANCH" ]; then
        pp_git_failure "HEAD postcondition failed at $1: expected $EXPECTED_UPDATE_SHA, observed $actual; checkout or branch changed."
        return 1
    fi
}

pp_prepare_update_target() {
    LOCAL=$("$GIT_CMD" -C "$SCRIPT_DIR" rev-parse --verify HEAD) || return 1
    EXPECTED_UPDATE_BRANCH=$("$GIT_CMD" -C "$SCRIPT_DIR" symbolic-ref -q HEAD || true)
    if [ -n "${BUILD_CURRENT_SHA:-}" ]; then
        EXPECTED_UPDATE_SHA="$BUILD_CURRENT_SHA"
        UPDATE_OUTCOME=build-current
        pp_verify_update_head build-current || return 1
        local status
        status=$("$GIT_CMD" -C "$SCRIPT_DIR" status --porcelain --untracked-files=all) || { pp_git_failure 'Could not verify pinned checkout status.'; return 1; }
        if [ -n "$status" ]; then
            pp_git_failure 'Pinned build-current requires a clean checkout, including lockfiles and untracked files.'
            return 1
        fi
    elif [ "${PROXYPILOT_UPDATE_REEXEC:-}" = 1 ]; then
        EXPECTED_UPDATE_SHA="${PROXYPILOT_UPDATE_EXPECTED_SHA:-}"
        if ! [[ "$EXPECTED_UPDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || \
            [ "$EXPECTED_UPDATE_BRANCH" != "${PROXYPILOT_UPDATE_EXPECTED_BRANCH:-}" ]; then
            pp_git_failure 'Self-update re-exec has no valid pinned target or its branch changed; rerun from SSH or console.'
            return 1
        fi
        UPDATE_OUTCOME=updated
        pp_verify_update_head re-exec || return 1
    else
        # Use a private ref, not the shared FETCH_HEAD/origin/main that another
        # fetch can move. Resolve once and merge only that immutable commit.
        local target_ref="refs/proxypilot-update/$$-$RANDOM-$RANDOM"
        log "${BLUE}[1/7] Fetching latest changes...${NC}"
        if ! pp_git_logged fetch --no-tags --no-recurse-submodules origin "refs/heads/main:$target_ref"; then
            "$GIT_CMD" -C "$SCRIPT_DIR" update-ref -d "$target_ref" || true
            return 1
        fi
        EXPECTED_UPDATE_SHA=$("$GIT_CMD" -C "$SCRIPT_DIR" rev-parse --verify "${target_ref}^{commit}") || return 1
        "$GIT_CMD" -C "$SCRIPT_DIR" update-ref -d "$target_ref" "$EXPECTED_UPDATE_SHA" || return 1
        if ! "$GIT_CMD" -C "$SCRIPT_DIR" merge-base --is-ancestor "$LOCAL" "$EXPECTED_UPDATE_SHA"; then
            pp_git_failure "Checkout $LOCAL cannot fast-forward to fetched main $EXPECTED_UPDATE_SHA; preserve local history and reconcile separately."
            return 1
        fi
        UPDATE_OUTCOME=updated
        [ "$LOCAL" != "$EXPECTED_UPDATE_SHA" ] || UPDATE_OUTCOME=already-current
    fi
    REMOTE="$EXPECTED_UPDATE_SHA"
    log "Pinned update target: $EXPECTED_UPDATE_SHA ($UPDATE_OUTCOME)"
    pp_update_result running || return 1
}

pp_advance_update_target() {
    local actual branch
    actual=$("$GIT_CMD" -C "$SCRIPT_DIR" rev-parse --verify HEAD) || return 1
    branch=$("$GIT_CMD" -C "$SCRIPT_DIR" symbolic-ref -q HEAD || true)
    if [ "$actual" != "$LOCAL" ] || [ "$branch" != "$EXPECTED_UPDATE_BRANCH" ]; then
        pp_git_failure 'Checkout changed after fetch; refusing to advance a raced HEAD or branch.'
        return 1
    fi
    log "${BLUE}[2/7] Pulling latest code (fast-forward to pinned target)...${NC}"
    pp_git_logged merge --ff-only "$EXPECTED_UPDATE_SHA" || return $?
    pp_verify_update_head advance
}

pp_complete_update() {
    pp_verify_update_head completion || return 1
    pp_update_result success
}
