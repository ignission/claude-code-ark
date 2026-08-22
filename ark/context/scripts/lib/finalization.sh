#!/usr/bin/env bash

ctx_finalization_add_failure() {
  local stage=$1
  CTX_FINALIZATION_FAILED_STAGES="${CTX_FINALIZATION_FAILED_STAGES}${CTX_FINALIZATION_FAILED_STAGES:+,}$stage"
}

ctx_finalization_empty_task_scaffold() {
  local task=$1
  ctx_validate_xdg_file "$task" || return 1
  awk '
    BEGIN { section = ""; goal = 0; plan = 0; artifacts = 0; invalid = 0 }
    /^## Goal$/ { goal++; section = "goal"; next }
    /^## Constraints$/ { section = "constraints"; next }
    /^## Plan$/ { plan++; section = "plan"; next }
    /^## Artifacts$/ { artifacts++; section = "artifacts"; next }
    /^## / { section = "other"; next }
    section == "goal" && length($0) > 0 { invalid = 1 }
    section == "plan" && length($0) > 0 { invalid = 1 }
    END { exit !(goal == 1 && plan == 1 && artifacts == 1 && invalid == 0) }
  ' "$task"
}

ctx_finalization_record_failure() {
  local session=$1 phase=$2 attempt=$3 stage=$4 raw marker
  case "$phase" in teardown|recovery) ;; *) return 1 ;; esac
  case "$stage" in summary|handoff|inbox) ;; *) return 1 ;; esac
  case "$attempt" in ''|*[!0-9]*) return 1 ;; esac
  raw="$session/errors/raw.log"
  marker='"tool":"ark/context","error_type":"session_finalization_failed","exit_code":null,"is_interrupt":null,"error":"session finalization failed","details":{"attempt":'"$attempt"',"phase":"'"$phase"'","stage":"'"$stage"'"}}'
  if ctx_validate_xdg_file "$raw" >/dev/null 2>&1 \
    && grep -F "$marker" "$raw" >/dev/null 2>&1; then
    return 0
  fi
  printf '%s\n' \
    '{"tool":"ark/context","error_type":"session_finalization_failed","exit_code":null,"is_interrupt":null,"error":"session finalization failed","details":{"attempt":'"$attempt"',"phase":"'"$phase"'","stage":"'"$stage"'"}}' \
    | env ARK_SESSION_DIR="$session" /bin/bash "$ARK_SOURCE_ROOT/ark/context/hooks/capture-error.sh" \
      >/dev/null 2>&1
  ctx_validate_xdg_file "$raw" >/dev/null 2>&1 \
    && grep -F "$marker" "$raw" >/dev/null 2>&1
}

ctx_finalization_record_abandoned() {
  local session=$1 attempt=$2 stages=$3 raw marker
  case "$attempt" in ''|*[!0-9]*) return 1 ;; esac
  case "$stages" in
    summary|handoff|inbox|summary,handoff|summary,inbox|handoff,inbox|summary,handoff,inbox) ;;
    *) return 1 ;;
  esac
  raw="$session/errors/raw.log"
  marker='"tool":"ark/context","error_type":"session_finalization_abandoned","exit_code":null,"is_interrupt":null,"error":"pending session finalization abandoned","details":{"attempt":'"$attempt"',"stages":"'"$stages"'"}}'
  if ctx_validate_xdg_file "$raw" >/dev/null 2>&1 \
    && grep -F "$marker" "$raw" >/dev/null 2>&1; then
    return 0
  fi
  printf '%s\n' \
    '{"tool":"ark/context","error_type":"session_finalization_abandoned","exit_code":null,"is_interrupt":null,"error":"pending session finalization abandoned","details":{"attempt":'"$attempt"',"stages":"'"$stages"'"}}' \
    | env ARK_SESSION_DIR="$session" /bin/bash "$ARK_SOURCE_ROOT/ark/context/hooks/capture-error.sh" \
      >/dev/null 2>&1
  ctx_validate_xdg_file "$raw" >/dev/null 2>&1 \
    && grep -F "$marker" "$raw" >/dev/null 2>&1
}

ctx_finalization_next_recovery_attempt() {
  local session=$1 raw attempts value max
  raw="$session/errors/raw.log"
  max=0
  if [ ! -e "$raw" ] && [ ! -L "$raw" ]; then
    printf '%s\n' 1
    return 0
  fi
  ctx_validate_xdg_file "$raw" || return 1
  attempts=$(jq -r '
    select(.tool == "ark/context"
      and .error_type == "session_finalization_failed"
      and .details.phase == "recovery")
    | .details.attempt
  ' "$raw") || return 1
  while IFS= read -r value || [ -n "$value" ]; do
    [ -n "$value" ] || continue
    case "$value" in ''|*[!0-9]*) return 1 ;; esac
    [ "$value" -le 3 ] || return 1
    [ "$value" -le "$max" ] || max=$value
  done <<EOF
$attempts
EOF
  [ "$max" -lt 3 ] || { printf '%s\n' 3; return 0; }
  printf '%s\n' "$((max + 1))"
}

ctx_finalize_session_derivatives() {
  local session=$1 repo=$2 session_id=$3 phase=$4 attempt=$5
  local work_id knowledge_lock knowledge_backend knowledge_pid knowledge_token inbox_failed stage
  CTX_FINALIZATION_FAILED_STAGES=

  env ARK_SESSION_DIR="$session" CTX_CONFIG_FILE="$CTX_CONFIG_FILE" \
    /bin/bash "$ARK_SOURCE_ROOT/ark/context/scripts/summarize-errors.sh" >/dev/null 2>&1 \
    || ctx_finalization_add_failure summary
  if ctx_finalization_empty_task_scaffold "$session/task.md" >/dev/null 2>&1; then
    :
  else
    ctx_handoff_write "$session" "$repo" "$session_id" >/dev/null 2>&1 \
      || ctx_finalization_add_failure handoff
  fi

  inbox_failed=0
  work_id=$(ctx_work_id_from_repo "$repo" 2>/dev/null) || inbox_failed=1
  if [ "$inbox_failed" -eq 0 ]; then
    knowledge_lock="$ARK_KNOWLEDGE_DIR/failures-inbox.lock"
    if ctx_lock_acquire "$knowledge_lock" 8 5 30 mkdir-direct >/dev/null 2>&1; then
      knowledge_backend=$CTX_LOCK_ACQUIRED_BACKEND
      knowledge_pid=$CTX_LOCK_ACQUIRED_PID
      knowledge_token=$CTX_LOCK_ACQUIRED_TOKEN
      ctx_failures_inbox_append "$session" "$ARK_KNOWLEDGE_DIR" "$work_id" "$session_id" \
        >/dev/null 2>&1 || inbox_failed=1
      ctx_session_failures_inbox_append "$session" "$ARK_KNOWLEDGE_DIR" "$work_id" "$session_id" \
        >/dev/null 2>&1 || inbox_failed=1
      ctx_lock_release "$knowledge_lock" "$knowledge_backend" "$knowledge_pid" "$knowledge_token" \
        >/dev/null 2>&1 || inbox_failed=1
    else
      inbox_failed=1
    fi
  fi
  [ "$inbox_failed" -eq 0 ] || ctx_finalization_add_failure inbox

  if [ -n "$CTX_FINALIZATION_FAILED_STAGES" ]; then
    while IFS= read -r stage || [ -n "$stage" ]; do
      [ -n "$stage" ] || continue
      ctx_finalization_record_failure "$session" "$phase" "$attempt" "$stage" >/dev/null 2>&1 || true
    done <<EOF
$(printf '%s\n' "$CTX_FINALIZATION_FAILED_STAGES" | tr ',' '\n')
EOF
    return 1
  fi
  return 0
}
