#!/usr/bin/env bash

ARK_SOURCE_ROOT=$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd -P) || exit 1
CLAUDE_PROJECT_DIR=$ARK_SOURCE_ROOT
export CLAUDE_PROJECT_DIR
. "$ARK_SOURCE_ROOT/.claude/lib/state-io.sh"
set +eu
set +o pipefail
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/runtime.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/handoff.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/failures-knowledge.sh"
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
flow_lock_acquire "$lock" 9 5 30 mkdir-direct >/dev/null 2>&1 || exit 0
lock_backend=$FLOW_LOCK_ACQUIRED_BACKEND
lock_pid=$FLOW_LOCK_ACQUIRED_PID
lock_token=$FLOW_LOCK_ACQUIRED_TOKEN
owner="$CTX_REPO_STATE_DIR/owner"
owned=0
if ctx_validate_xdg_file "$owner" >/dev/null 2>&1; then
  IFS= read -r line <"$owner" || line=
  owner_session=${line%%$'\t'*}
  [ "$owner_session" = "$session" ] && owned=1
fi

env ARK_SESSION_DIR="$ARK_SESSION_DIR" CTX_CONFIG_FILE="$CTX_CONFIG_FILE" \
  /bin/bash "$ARK_SOURCE_ROOT/ark/context/scripts/summarize-errors.sh" >/dev/null 2>&1 || true
ctx_handoff_write "$ARK_SESSION_DIR" "$repo" "$session" >/dev/null 2>&1 || true
work_id=$(ctx_work_id_from_repo "$repo" 2>/dev/null) || work_id=
if [ -n "$work_id" ]; then
  knowledge_lock="$ARK_KNOWLEDGE_DIR/failures-inbox.lock"
  if flow_lock_acquire "$knowledge_lock" 8 5 30 mkdir-direct >/dev/null 2>&1; then
    knowledge_backend=$FLOW_LOCK_ACQUIRED_BACKEND
    knowledge_pid=$FLOW_LOCK_ACQUIRED_PID
    knowledge_token=$FLOW_LOCK_ACQUIRED_TOKEN
    ctx_failures_inbox_append "$ARK_SESSION_DIR" "$ARK_KNOWLEDGE_DIR" "$work_id" "$session" \
      >/dev/null 2>&1 || true
    ctx_session_failures_inbox_append "$ARK_SESSION_DIR" "$ARK_KNOWLEDGE_DIR" "$work_id" "$session" \
      >/dev/null 2>&1 || true
    flow_lock_release "$knowledge_lock" "$knowledge_backend" "$knowledge_pid" "$knowledge_token" \
      >/dev/null 2>&1 || true
  fi
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
if [ "$owned" -eq 1 ] && [ "$restore_succeeded" -eq 1 ]; then
  command rm -f "$owner" "$CTX_REPO_STATE_DIR/owner.new" 2>/dev/null || true
fi
flow_lock_release "$lock" "$lock_backend" "$lock_pid" "$lock_token" >/dev/null 2>&1 || true
exit 0
