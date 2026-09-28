#!/bin/sh
# Stage one reviewed A3 commit on the ProxyPilot candidate slot, as root.
#
#   sh a3-stage-candidate.sh <candidate-dir> <reviewed-commit> [base]
#
# The candidate already carries some A3 files (identical bytes, possibly a
# different file mode) and live-only changes, so a plain cherry-pick can stop
# on add/add conflicts. This copies exactly the reviewed commit's version of
# every path that commit changed since GitHub main, except the MCP policy file
# (the candidate's copy carries live-only lines and the same self-check line).
# It refuses when any such candidate file differs from both the base and the
# reviewed commit, so no candidate-only change is overwritten. It aborts only
# an interrupted cherry-pick, and it never touches the live checkout.
set -eu
dir=${1:?candidate directory}
code=${2:?reviewed commit}
base=${3:-12ad1392845630eec56705776bae444f54eac58a}
policy=admin/backend/src/lib/mcp-policy/mcp-extended-policy.json
cd "$dir"
if [ -f "$(git rev-parse --git-path CHERRY_PICK_HEAD)" ]; then
  git cherry-pick --abort
  echo "aborted the interrupted cherry-pick"
fi
[ -z "$(git status --porcelain)" ] || { echo "candidate has uncommitted changes; refusing" >&2; exit 1; }
git cat-file -e "$code^{commit}"
git merge-base --is-ancestor "$base" HEAD
git merge-base --is-ancestor "$base" "$code"
paths=$(git diff --name-only --no-renames "$base" "$code" -- . ":(exclude)$policy")
[ -n "$paths" ] || { echo "reviewed commit changes nothing" >&2; exit 1; }
for p in $paths; do
  have=$(git rev-parse -q --verify "HEAD:$p" || echo none)
  old=$(git rev-parse -q --verify "$base:$p" || echo none)
  new=$(git rev-parse -q --verify "$code:$p" || echo none)
  [ "$new" != none ] || { echo "reviewed commit deletes $p; refusing" >&2; exit 1; }
  [ "$have" = "$old" ] || [ "$have" = "$new" ] || {
    echo "candidate differs from both base and reviewed commit: $p" >&2; exit 1; }
done
grep -q 'prepare-self-check-native.mjs' "$policy" || {
  echo "candidate policy lacks the self-check install line" >&2; exit 1; }
before=$(git rev-parse HEAD)
# shellcheck disable=SC2086 # paths are git-listed repository paths without spaces
git checkout "$code" -- $paths
if git diff --cached --quiet; then
  echo "candidate already matches $code"
else
  git -c user.name="ProxyPilot operator" -c user.email=operator@proxypilot \
    commit -q -m "Stage reviewed A3 commit $code"
fi
# shellcheck disable=SC2086
git diff --quiet "$code" HEAD -- $paths || { echo "staged tree differs from $code" >&2; exit 1; }
echo "staged $(git rev-parse HEAD) (was $before) from $code; $(echo "$paths" | wc -l) paths match exactly"
