#!/usr/bin/env bash

ARK_SOURCE_ROOT=$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd -P) || exit 1
CLAUDE_PROJECT_DIR=$ARK_SOURCE_ROOT
export CLAUDE_PROJECT_DIR
# shellcheck source=/dev/null
. "$ARK_SOURCE_ROOT/.claude/lib/state-io.sh"
set +eu
set +o pipefail
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/runtime.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/config.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/task-template.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/handoff.sh"
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/failures-knowledge.sh"
. "$ARK_SOURCE_ROOT/ark/context/adapters/claude-code/settings.sh"

session_disabled() {
  local reason=$1
  reason=${reason//$'\n'/ }
  reason=${reason//$'\r'/ }
  reason=${reason//$'\t'/ }
  printf 'enabled\t0\nreason\t%s\n' "$reason"
  exit 0
}

owner_pid_valid() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  case "$1" in *[1-9]*) return 0 ;; *) return 1 ;; esac
}

owner_read() {
  local owner=$1 line extra
  OWNER_SESSION=
  OWNER_PID=
  [ -e "$owner" ] || return 1
  ctx_validate_xdg_file "$owner" || return 2
  IFS= read -r line <"$owner" || return 2
  IFS=$'\t' read -r OWNER_SESSION OWNER_PID extra <<EOF
$line
EOF
  case "$OWNER_SESSION" in *[!0-9a-f]*) return 2 ;; esac
  [ "${#OWNER_SESSION}" -eq 32 ] || return 2
  owner_pid_valid "$OWNER_PID" || return 2
  [ -z "${extra:-}" ] || return 2
}

owner_write() {
  local owner=$1 session=$2 pid=$3 new old_umask write_status
  new="$CTX_REPO_STATE_DIR/owner.new"
  if [ -e "$new" ] || [ -L "$new" ]; then ctx_validate_xdg_file "$new" || return 1; fi
  old_umask=$(umask); umask 077
  printf '%s\t%s\n' "$session" "$pid" >"$new"
  write_status=$?
  umask "$old_umask"
  [ "$write_status" -eq 0 ] || { command rm -f "$new" 2>/dev/null || true; return 1; }
  chmod 600 "$new" || { command rm -f "$new" 2>/dev/null || true; return 1; }
  ctx_validate_xdg_file "$new" || { command rm -f "$new" 2>/dev/null || true; return 1; }
  command mv "$new" "$owner" || { command rm -f "$new" 2>/dev/null || true; return 1; }
}

repo=
owner_pid=
requested_session=
restart_session=
goal=
constraints=
plans=
review=0
while [ "$#" -gt 0 ]; do
  option=$1; shift
  case "$option" in
    --review)
      [ "$review" -eq 0 ] || session_disabled "invalid arguments"
      review=1
      ;;
    --repo|--owner-pid|--session-id|--restart|--goal|--constraint|--plan-item)
      [ "$#" -gt 0 ] || session_disabled "invalid arguments"
      value=$1; shift
      case "$option" in
        --repo) [ -z "$repo" ] || session_disabled "invalid arguments"; repo=$value ;;
        --owner-pid) [ -z "$owner_pid" ] || session_disabled "invalid arguments"; owner_pid=$value ;;
        --session-id) [ -z "$requested_session" ] || session_disabled "invalid arguments"; requested_session=$value ;;
        --restart) [ -z "$restart_session" ] || session_disabled "invalid arguments"; restart_session=$value ;;
        --goal) [ -z "$goal" ] || session_disabled "invalid arguments"; goal=$value ;;
        --constraint) constraints="${constraints}${constraints:+$'\n'}$value" ;;
        --plan-item) plans="${plans}${plans:+$'\n'}$value" ;;
      esac
      ;;
    *) session_disabled "invalid arguments" ;;
  esac
done
[ -n "$repo" ] && [ -n "$owner_pid" ] || session_disabled "invalid arguments"
[ "$review" -eq 0 ] || [ -z "$plans" ] || session_disabled "review task does not accept plan items"
owner_pid_valid "$owner_pid" || session_disabled "invalid owner pid"
kill -0 "$owner_pid" 2>/dev/null || session_disabled "owner pid is not alive"
[ -z "$goal" ] || ctx_task_input_valid "$goal" 200 || session_disabled "invalid task input"
if [ -n "$constraints" ]; then while IFS= read -r value || [ -n "$value" ]; do ctx_task_input_valid "$value" 400 || session_disabled "invalid task input"; done <<EOF
$constraints
EOF
fi
if [ -n "$plans" ]; then while IFS= read -r value || [ -n "$value" ]; do ctx_task_input_valid "$value" 400 || session_disabled "invalid task input"; done <<EOF
$plans
EOF
fi
for value in "$requested_session" "$restart_session"; do
  [ -z "$value" ] && continue
  case "$value" in *[!0-9a-f]*) session_disabled "invalid session id" ;; esac
  [ "${#value}" -eq 32 ] || session_disabled "invalid session id"
done
[ -z "$restart_session" ] || [ "$restart_session" != "$requested_session" ] || session_disabled "restart must use a new session"

placeholder=${requested_session:-00000000000000000000000000000000}
ctx_runtime_paths "$repo" "$placeholder" >/dev/null 2>&1 || session_disabled "runtime resolution failed"
ctx_runtime_prepare_base >/dev/null 2>&1 || session_disabled "runtime preparation failed"
lock="$CTX_REPO_STATE_DIR/settings.lock"
flow_lock_acquire "$lock" 9 5 30 mkdir-direct >/dev/null 2>&1 || session_disabled "settings lock unavailable"
lock_backend=$FLOW_LOCK_ACQUIRED_BACKEND
lock_pid=$FLOW_LOCK_ACQUIRED_PID
lock_token=$FLOW_LOCK_ACQUIRED_TOKEN
release_lock() { flow_lock_release "$lock" "$lock_backend" "$lock_pid" "$lock_token" >/dev/null 2>&1 || true; }

owner="$CTX_REPO_STATE_DIR/owner"
same_owner=0
if owner_read "$owner"; then
  if kill -0 "$OWNER_PID" 2>/dev/null; then
    if { [ -n "$requested_session" ] && [ "$requested_session" = "$OWNER_SESSION" ]; } \
      || { [ -z "$requested_session" ] && [ "$owner_pid" = "$OWNER_PID" ]; }; then
      requested_session=$OWNER_SESSION
      same_owner=1
    else
      release_lock
      session_disabled "another live session owns this repo"
    fi
  else
    old_session="$CTX_DATA_ROOT/sessions/$OWNER_SESSION"
    old_cache="$CTX_CACHE_ROOT/$OWNER_SESSION"
    old_session_safe=0
    if ctx_validate_xdg_dir "$old_session" >/dev/null 2>&1; then
      old_session_canonical=$(cd "$old_session" 2>/dev/null && pwd -P) || old_session_canonical=
      [ "$old_session_canonical" = "$old_session" ] && old_session_safe=1
    fi
    if [ "$old_session_safe" -eq 1 ]; then
      ARK_SESSION_ID=$OWNER_SESSION
      ARK_SESSION_DIR=$old_session
      ARK_CACHE_DIR=$old_cache
      export ARK_SESSION_ID ARK_SESSION_DIR ARK_CACHE_DIR
      env ARK_SESSION_DIR="$ARK_SESSION_DIR" CTX_CONFIG_FILE="$CTX_CONFIG_FILE" \
        /bin/bash "$ARK_SOURCE_ROOT/ark/context/scripts/summarize-errors.sh" >/dev/null 2>&1 || true
      ctx_handoff_write "$ARK_SESSION_DIR" "$repo" "$OWNER_SESSION" >/dev/null 2>&1 || true
      old_work_id=$(ctx_work_id_from_repo "$repo" 2>/dev/null) || old_work_id=
      if [ -n "$old_work_id" ]; then
        knowledge_lock="$ARK_KNOWLEDGE_DIR/failures-inbox.lock"
        if flow_lock_acquire "$knowledge_lock" 8 5 30 mkdir-direct >/dev/null 2>&1; then
          knowledge_backend=$FLOW_LOCK_ACQUIRED_BACKEND
          knowledge_pid=$FLOW_LOCK_ACQUIRED_PID
          knowledge_token=$FLOW_LOCK_ACQUIRED_TOKEN
          ctx_failures_inbox_append "$ARK_SESSION_DIR" "$ARK_KNOWLEDGE_DIR" \
            "$old_work_id" "$OWNER_SESSION" >/dev/null 2>&1 || true
          flow_lock_release "$knowledge_lock" "$knowledge_backend" "$knowledge_pid" "$knowledge_token" \
            >/dev/null 2>&1 || true
        fi
      fi
      if ctx_validate_xdg_dir "$ARK_CACHE_DIR" >/dev/null 2>&1 \
        && ctx_validate_xdg_dir "$ARK_CACHE_DIR/steps" >/dev/null 2>&1; then
        command rm -rf "$ARK_CACHE_DIR/steps" 2>/dev/null || true
      fi
      if ctx_validate_xdg_file "$ARK_SESSION_DIR/stop_once" >/dev/null 2>&1; then
        command rm -f "$ARK_SESSION_DIR/stop_once" 2>/dev/null || true
      fi
    fi
    CLAUDE_SETTINGS_FAILURE_REASON=
    if ! claude_settings_restore "$repo" "$CTX_REPO_STATE_DIR" >/dev/null 2>&1; then
      reason=${CLAUDE_SETTINGS_FAILURE_REASON:-orphan settings restore failed}
      release_lock
      session_disabled "$reason"
    fi
    command rm -f "$owner" || { release_lock; session_disabled "orphan owner cleanup failed"; }
  fi
elif [ "$?" -eq 2 ]; then
  release_lock
  session_disabled "invalid owner marker"
fi

if [ -z "$requested_session" ]; then
  requested_session=$(ctx_session_id_generate "$restart_session" 2>/dev/null) || { release_lock; session_disabled "session id unavailable"; }
fi
ctx_runtime_paths "$repo" "$requested_session" >/dev/null 2>&1 || { release_lock; session_disabled "runtime resolution failed"; }
owner_new=0
if [ "$same_owner" -eq 0 ]; then
  owner_write "$owner" "$requested_session" "$owner_pid" || { release_lock; session_disabled "owner creation failed"; }
  owner_new=1
fi

init_failed() {
  local reason=$1
  if [ "$owner_new" -eq 1 ]; then
    claude_settings_restore "$repo" "$CTX_REPO_STATE_DIR" >/dev/null 2>&1 || true
    command rm -f "$owner" "$CTX_REPO_STATE_DIR/owner.new" 2>/dev/null || true
  fi
  release_lock
  session_disabled "$reason"
}

ctx_config_ensure >/dev/null 2>&1 || init_failed "config initialization failed"
interval=$(ctx_config_read_recite_interval 2>/dev/null) || init_failed "config parse failed"
ctx_runtime_prepare_session >/dev/null 2>&1 || init_failed "session preparation failed"
ctx_artifacts_index_initialize "$ARK_SESSION_DIR" >/dev/null 2>&1 \
  || init_failed "artifact index initialization failed"
if [ -n "$restart_session" ]; then
  old_session="$CTX_DATA_ROOT/sessions/$restart_session"
  previous=$(ctx_previous_failure_summary "$old_session" 2>/dev/null) || init_failed "restart summary unavailable"
else
  previous='なし（通常起動）'
fi
set -- "$ARK_SESSION_DIR" "$goal" "$previous"
if [ -n "$constraints" ]; then while IFS= read -r value || [ -n "$value" ]; do set -- "$@" --constraint "$value"; done <<EOF
$constraints
EOF
fi
if [ -n "$plans" ]; then while IFS= read -r value || [ -n "$value" ]; do set -- "$@" --plan-item "$value"; done <<EOF
$plans
EOF
fi
if [ "$review" -eq 1 ]; then
  shift 3
  ctx_task_render_review "$ARK_SESSION_DIR" "$ARK_SESSION_ID" "$goal" "$previous" "$@" \
    >/dev/null 2>&1 || init_failed "review task initialization failed"
else
  ctx_task_render "$@" >/dev/null 2>&1 || init_failed "task initialization failed"
fi
ctx_knowledge_initialize "$ARK_SESSION_DIR" "$ARK_KNOWLEDGE_DIR" >/dev/null 2>&1 || init_failed "knowledge initialization failed"
CLAUDE_SETTINGS_FAILURE_REASON=
claude_settings_inject "$repo" "$CTX_REPO_STATE_DIR" "$ARK_SOURCE_ROOT" >/dev/null 2>&1 \
  || init_failed "${CLAUDE_SETTINGS_FAILURE_REASON:-settings injection failed}"
release_lock

printf 'enabled\t1\n'
printf 'ARK_SESSION_ID\t%s\n' "$ARK_SESSION_ID"
printf 'ARK_SESSION_DIR\t%s\n' "$ARK_SESSION_DIR"
printf 'ARK_CACHE_DIR\t%s\n' "$ARK_CACHE_DIR"
printf 'ARK_RECITE_INTERVAL\t%s\n' "$interval"
printf 'ARK_KNOWLEDGE_DIR\t%s\n' "$ARK_KNOWLEDGE_DIR"
printf 'ARK_REPO_KEY\t%s\n' "$ARK_REPO_KEY"
exit 0
