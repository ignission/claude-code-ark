#!/usr/bin/env bash

ARK_SOURCE_ROOT=$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd -P) || exit 1
CLAUDE_PROJECT_DIR=$ARK_SOURCE_ROOT
export CLAUDE_PROJECT_DIR
# shellcheck source=/dev/null
. "$ARK_SOURCE_ROOT/.claude/lib/state-io.sh"
set +eu
set +o pipefail
. "$ARK_SOURCE_ROOT/ark/loop/scripts/lib/runtime.sh"
. "$ARK_SOURCE_ROOT/ark/loop/scripts/lib/config.sh"
. "$ARK_SOURCE_ROOT/ark/loop/scripts/lib/task-template.sh"
. "$ARK_SOURCE_ROOT/ark/loop/adapters/claude-code/settings.sh"

session_disabled() {
  local reason=$1
  reason=${reason//$'\n'/ }
  reason=${reason//$'\r'/ }
  reason=${reason//$'\t'/ }
  printf 'enabled\t0\nreason\t%s\n' "$reason"
  exit 0
}

owner_read() {
  local owner=$1 line extra
  OWNER_SESSION=
  OWNER_PID=
  [ -e "$owner" ] || return 1
  loop_validate_xdg_file "$owner" || return 2
  IFS= read -r line <"$owner" || return 2
  IFS=$'\t' read -r OWNER_SESSION OWNER_PID extra <<EOF
$line
EOF
  case "$OWNER_SESSION" in *[!0-9a-f]*) return 2 ;; esac
  [ "${#OWNER_SESSION}" -eq 32 ] || return 2
  case "$OWNER_PID" in ''|*[!0-9]*) return 2 ;; esac
  [ -z "${extra:-}" ] || return 2
}

owner_write() {
  local owner=$1 session=$2 pid=$3 new old_umask write_status
  new="$LOOP_REPO_STATE_DIR/owner.new"
  if [ -e "$new" ] || [ -L "$new" ]; then loop_validate_xdg_file "$new" || return 1; fi
  old_umask=$(umask); umask 077
  printf '%s\t%s\n' "$session" "$pid" >"$new"
  write_status=$?
  umask "$old_umask"
  [ "$write_status" -eq 0 ] || { command rm -f "$new" 2>/dev/null || true; return 1; }
  chmod 600 "$new" || { command rm -f "$new" 2>/dev/null || true; return 1; }
  loop_validate_xdg_file "$new" || { command rm -f "$new" 2>/dev/null || true; return 1; }
  command mv "$new" "$owner" || { command rm -f "$new" 2>/dev/null || true; return 1; }
}

repo=
owner_pid=
requested_session=
restart_session=
goal=
constraints=
plans=
while [ "$#" -gt 0 ]; do
  option=$1; shift
  case "$option" in
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
[ -n "$repo" ] && [ -n "$owner_pid" ] && [ -n "$goal" ] && [ -n "$constraints" ] && [ -n "$plans" ] \
  || session_disabled "invalid arguments"
case "$owner_pid" in *[!0-9]*) session_disabled "invalid owner pid" ;; esac
kill -0 "$owner_pid" 2>/dev/null || session_disabled "owner pid is not alive"
loop_task_input_valid "$goal" 200 || session_disabled "invalid task input"
while IFS= read -r value || [ -n "$value" ]; do loop_task_input_valid "$value" 400 || session_disabled "invalid task input"; done <<EOF
$constraints
EOF
while IFS= read -r value || [ -n "$value" ]; do loop_task_input_valid "$value" 400 || session_disabled "invalid task input"; done <<EOF
$plans
EOF
for value in "$requested_session" "$restart_session"; do
  [ -z "$value" ] && continue
  case "$value" in *[!0-9a-f]*) session_disabled "invalid session id" ;; esac
  [ "${#value}" -eq 32 ] || session_disabled "invalid session id"
done
[ -z "$restart_session" ] || [ "$restart_session" != "$requested_session" ] || session_disabled "restart must use a new session"

placeholder=${requested_session:-00000000000000000000000000000000}
loop_runtime_paths "$repo" "$placeholder" >/dev/null 2>&1 || session_disabled "runtime resolution failed"
loop_runtime_prepare_base >/dev/null 2>&1 || session_disabled "runtime preparation failed"
lock="$LOOP_REPO_STATE_DIR/settings.lock"
flow_lock_acquire "$lock" 9 5 30 mkdir-direct >/dev/null 2>&1 || session_disabled "settings lock unavailable"
lock_backend=$FLOW_LOCK_ACQUIRED_BACKEND
lock_pid=$FLOW_LOCK_ACQUIRED_PID
lock_token=$FLOW_LOCK_ACQUIRED_TOKEN
release_lock() { flow_lock_release "$lock" "$lock_backend" "$lock_pid" "$lock_token" >/dev/null 2>&1 || true; }

owner="$LOOP_REPO_STATE_DIR/owner"
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
    claude_settings_restore "$repo" "$LOOP_REPO_STATE_DIR" >/dev/null 2>&1 || { release_lock; session_disabled "orphan settings restore failed"; }
    command rm -f "$owner" || { release_lock; session_disabled "orphan owner cleanup failed"; }
  fi
elif [ "$?" -eq 2 ]; then
  release_lock
  session_disabled "invalid owner marker"
fi

if [ -z "$requested_session" ]; then
  requested_session=$(loop_session_id_generate "$restart_session" 2>/dev/null) || { release_lock; session_disabled "session id unavailable"; }
fi
loop_runtime_paths "$repo" "$requested_session" >/dev/null 2>&1 || { release_lock; session_disabled "runtime resolution failed"; }
owner_new=0
if [ "$same_owner" -eq 0 ]; then
  owner_write "$owner" "$requested_session" "$owner_pid" || { release_lock; session_disabled "owner creation failed"; }
  owner_new=1
fi

init_failed() {
  local reason=$1
  if [ "$owner_new" -eq 1 ]; then
    claude_settings_restore "$repo" "$LOOP_REPO_STATE_DIR" >/dev/null 2>&1 || true
    command rm -f "$owner" "$LOOP_REPO_STATE_DIR/owner.new" 2>/dev/null || true
  fi
  release_lock
  session_disabled "$reason"
}

loop_config_ensure >/dev/null 2>&1 || init_failed "config initialization failed"
interval=$(loop_config_read_recite_interval 2>/dev/null) || init_failed "config parse failed"
loop_runtime_prepare_session >/dev/null 2>&1 || init_failed "session preparation failed"
if [ -n "$restart_session" ]; then
  old_session="$LOOP_DATA_ROOT/sessions/$restart_session"
  previous=$(loop_previous_failure_summary "$old_session" 2>/dev/null) || init_failed "restart summary unavailable"
else
  previous='なし（通常起動）'
fi
set -- "$ARK_SESSION_DIR" "$goal" "$previous"
while IFS= read -r value || [ -n "$value" ]; do set -- "$@" --constraint "$value"; done <<EOF
$constraints
EOF
while IFS= read -r value || [ -n "$value" ]; do set -- "$@" --plan-item "$value"; done <<EOF
$plans
EOF
loop_task_render "$@" >/dev/null 2>&1 || init_failed "task initialization failed"
loop_knowledge_initialize "$ARK_SESSION_DIR" "$ARK_KNOWLEDGE_DIR" >/dev/null 2>&1 || init_failed "knowledge initialization failed"
claude_settings_inject "$repo" "$LOOP_REPO_STATE_DIR" >/dev/null 2>&1 || init_failed "settings injection failed"
release_lock

printf 'enabled\t1\n'
printf 'ARK_SESSION_ID\t%s\n' "$ARK_SESSION_ID"
printf 'ARK_SESSION_DIR\t%s\n' "$ARK_SESSION_DIR"
printf 'ARK_CACHE_DIR\t%s\n' "$ARK_CACHE_DIR"
printf 'ARK_RECITE_INTERVAL\t%s\n' "$interval"
printf 'ARK_KNOWLEDGE_DIR\t%s\n' "$ARK_KNOWLEDGE_DIR"
exit 0
