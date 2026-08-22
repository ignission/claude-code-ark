#!/usr/bin/env bash

ARK_SOURCE_ROOT=$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd -P) || exit 1
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/runtime.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/lock.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/handoff.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/failures-knowledge.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/finalization.sh"
. "$ARK_SOURCE_ROOT/ark/context/adapters/claude-code/settings.sh"

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
ctx_runtime_paths "$repo" "$session" >/dev/null 2>&1 || exit 0
ctx_runtime_prepare_base >/dev/null 2>&1 || exit 0
lock="$CTX_REPO_STATE_DIR/settings.lock"
ctx_lock_acquire "$lock" 9 5 30 mkdir-direct >/dev/null 2>&1 || exit 0
lock_backend=$CTX_LOCK_ACQUIRED_BACKEND
lock_pid=$CTX_LOCK_ACQUIRED_PID
lock_token=$CTX_LOCK_ACQUIRED_TOKEN
owner="$CTX_REPO_STATE_DIR/owner"
owned=0
if ctx_validate_xdg_file "$owner" >/dev/null 2>&1; then
  IFS= read -r line <"$owner" || line=
  owner_session=${line%%$'\t'*}
  [ "$owner_session" = "$session" ] && owned=1
fi

finalization_succeeded=0
if ctx_finalize_session_derivatives "$ARK_SESSION_DIR" "$repo" "$session" teardown 0; then
  finalization_succeeded=1
fi

restore_succeeded=0
if [ "$owned" -eq 1 ]; then
  if claude_settings_restore "$repo" "$CTX_REPO_STATE_DIR" >/dev/null 2>&1; then
    restore_succeeded=1
  fi
fi
if ctx_validate_xdg_dir "$ARK_CACHE_DIR" >/dev/null 2>&1 \
  && ctx_validate_xdg_dir "$ARK_CACHE_DIR/steps" >/dev/null 2>&1; then
  command rm -rf "$ARK_CACHE_DIR/steps" 2>/dev/null || true
fi
if ctx_validate_xdg_dir "$ARK_SESSION_DIR" >/dev/null 2>&1 \
  && ctx_validate_xdg_file "$ARK_SESSION_DIR/stop_once" >/dev/null 2>&1; then
  command rm -f "$ARK_SESSION_DIR/stop_once" 2>/dev/null || true
fi
if [ "$owned" -eq 1 ] && [ "$restore_succeeded" -eq 1 ] \
  && [ "$finalization_succeeded" -eq 1 ]; then
  command rm -f "$owner" "$CTX_REPO_STATE_DIR/owner.new" 2>/dev/null || true
fi
ctx_lock_release "$lock" "$lock_backend" "$lock_pid" "$lock_token" >/dev/null 2>&1 || true
exit 0
