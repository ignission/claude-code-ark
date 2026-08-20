#!/usr/bin/env bash

ARK_SOURCE_ROOT=$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd -P) || exit 1
CLAUDE_PROJECT_DIR=$ARK_SOURCE_ROOT
export CLAUDE_PROJECT_DIR
. "$ARK_SOURCE_ROOT/.claude/lib/state-io.sh"
set +eu
set +o pipefail
. "$ARK_SOURCE_ROOT/ark/loop/scripts/lib/runtime.sh"
. "$ARK_SOURCE_ROOT/ark/loop/adapters/claude-code/settings.sh"

repo=
session=
while [ "$#" -gt 0 ]; do
  option=$1; shift
  [ "$#" -gt 0 ] || exit 0
  value=$1; shift
  case "$option" in --repo) repo=$value ;; --session-id) session=$value ;; *) exit 0 ;; esac
done
[ -n "$repo" ] && [ -n "$session" ] || exit 0
case "$session" in *[!0-9a-f]*) exit 0 ;; esac
[ "${#session}" -eq 32 ] || exit 0
loop_runtime_paths "$repo" "$session" >/dev/null 2>&1 || exit 0
loop_runtime_prepare_base >/dev/null 2>&1 || exit 0
lock="$LOOP_REPO_STATE_DIR/settings.lock"
flow_lock_acquire "$lock" 9 5 30 mkdir-direct >/dev/null 2>&1 || exit 0
lock_backend=$FLOW_LOCK_ACQUIRED_BACKEND
lock_pid=$FLOW_LOCK_ACQUIRED_PID
lock_token=$FLOW_LOCK_ACQUIRED_TOKEN
owner="$LOOP_REPO_STATE_DIR/owner"
owned=0
if loop_validate_xdg_file "$owner" >/dev/null 2>&1; then
  IFS= read -r line <"$owner" || line=
  owner_session=${line%%$'\t'*}
  [ "$owner_session" = "$session" ] && owned=1
fi
if [ "$owned" -eq 1 ]; then
  if loop_validate_xdg_dir "$ARK_CACHE_DIR" >/dev/null 2>&1 \
    && loop_validate_xdg_dir "$ARK_CACHE_DIR/steps" >/dev/null 2>&1; then
    command rm -rf "$ARK_CACHE_DIR/steps" 2>/dev/null || true
  fi
  if claude_settings_restore "$repo" "$LOOP_REPO_STATE_DIR" >/dev/null 2>&1; then
    command rm -f "$owner" "$LOOP_REPO_STATE_DIR/owner.new" 2>/dev/null || true
  fi
fi
flow_lock_release "$lock" "$lock_backend" "$lock_pid" "$lock_token" >/dev/null 2>&1 || true
exit 0
