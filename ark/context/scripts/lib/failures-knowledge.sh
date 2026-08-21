#!/usr/bin/env bash

ctx_failures_value_safe() {
  local value=${1:-}
  [ -n "$value" ] || return 1
  printf '%s' "$value" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1 && return 1
  command -v iconv >/dev/null 2>&1 || return 1
  printf '%s' "$value" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
}

ctx_failures_private_file() {
  local directory=$1
  local old_umask target create_status
  old_umask=$(umask)
  umask 077
  target=$(mktemp "$directory/.failures-inbox.XXXXXX" 2>/dev/null)
  create_status=$?
  umask "$old_umask"
  [ "$create_status" -eq 0 ] && [ -n "$target" ] || return 1
  chmod 600 "$target" || { command rm -f "$target" 2>/dev/null || :; return 1; }
  ctx_validate_xdg_file "$target" || { command rm -f "$target" 2>/dev/null || :; return 1; }
  printf '%s\n' "$target"
}

ctx_session_failures_inbox_initialize() {
  local session=${1:-}
  local canonical inbox old_umask create_status
  ctx_validate_xdg_dir "$session" || return 1
  canonical=$(cd "$session" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$session" ] || return 1
  inbox="$session/failures-inbox.md"
  if [ -e "$inbox" ] || [ -L "$inbox" ]; then
    ctx_validate_xdg_file "$inbox"
    return $?
  fi
  old_umask=$(umask)
  umask 077
  (set -C; : >"$inbox") 2>/dev/null
  create_status=$?
  umask "$old_umask"
  if [ "$create_status" -ne 0 ]; then
    ctx_validate_xdg_file "$inbox"
    return $?
  fi
  chmod 600 "$inbox" || return 1
  ctx_validate_xdg_file "$inbox"
}

ctx_failures_inbox_append() {
  local session=${1:-}
  local knowledge=${2:-}
  local work_id=${3:-}
  local session_id=${4:-}
  local canonical errors summary inbox lock parsed replacement line tool error_type count first last evidence
  local extra separator hash_input marker hash marker_count parsed_count empty_seen appended_count lock_pid lock_token

  case "$session_id" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#session_id}" -eq 32 ] || return 1
  case "$work_id" in
    issue-[0-9]*)
      case "${work_id#issue-}" in ''|*[!0-9]*) return 1 ;; esac
      ;;
    'なし（flow 外）') ;;
    ''|*[!a-z0-9-]*|*-|*--*|-*) return 1 ;;
  esac
  ctx_validate_xdg_dir "$session" || return 1
  canonical=$(cd "$session" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$session" ] || return 1
  errors="$session/errors"
  ctx_validate_xdg_dir "$errors" || return 1
  summary="$errors/summary.md"
  ctx_validate_xdg_file "$summary" || return 1
  command -v iconv >/dev/null 2>&1 || return 1
  iconv -f UTF-8 -t UTF-8 "$summary" >/dev/null 2>&1 || return 1

  ctx_validate_xdg_dir "$knowledge" || return 1
  canonical=$(cd "$knowledge" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$knowledge" ] || return 1
  lock="$knowledge/failures-inbox.lock"
  [ -d "$lock" ] && [ ! -L "$lock" ] || return 1
  ctx_validate_repo_path "$lock" directory required || return 1
  lock_pid=${FLOW_LOCK_ACQUIRED_PID:-}
  lock_token=${FLOW_LOCK_ACQUIRED_TOKEN:-}
  case "$lock_pid" in ''|*[!0-9]*) return 1 ;; esac
  ctx_failures_value_safe "$lock_token" || return 1
  [ "$(command cat "$lock/pid" 2>/dev/null)" = "$lock_pid" ] || return 1
  [ "$(command cat "$lock/token" 2>/dev/null)" = "$lock_token" ] || return 1

  parsed=$(ctx_failures_private_file "$errors") || return 1
  parsed_count=0
  empty_seen=0
  IFS= read -r line <"$summary" || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
  [ "$line" = 'Error summary (mechanical)' ] || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
  {
    IFS= read -r line
    while [ -n "${line:-}" ]; do
      case "$line" in
        'LLM summary (opt-in)')
          break
          ;;
        '- なし')
          [ "$parsed_count" -eq 0 ] && [ "$empty_seen" -eq 0 ] \
            || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          empty_seen=1
          ;;
        '- tool: '*)
          [ "$empty_seen" -eq 0 ] || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          tool=${line#- tool: }
          IFS= read -r line || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          case "$line" in '  error_type: '*) error_type=${line#  error_type: } ;; *) command rm -f "$parsed" 2>/dev/null || :; return 1 ;; esac
          IFS= read -r line || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          case "$line" in '  count: '*) count=${line#  count: } ;; *) command rm -f "$parsed" 2>/dev/null || :; return 1 ;; esac
          IFS= read -r line || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          case "$line" in '  first_line: '*) first=${line#  first_line: } ;; *) command rm -f "$parsed" 2>/dev/null || :; return 1 ;; esac
          IFS= read -r line || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          case "$line" in '  last_line: '*) last=${line#  last_line: } ;; *) command rm -f "$parsed" 2>/dev/null || :; return 1 ;; esac
          IFS= read -r line || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          case "$line" in '  詳細: '*) evidence=${line#  詳細: } ;; *) command rm -f "$parsed" 2>/dev/null || :; return 1 ;; esac
          ctx_failures_value_safe "$tool" && ctx_failures_value_safe "$error_type" \
            || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          case "$count" in ''|*[!0-9]*|0) command rm -f "$parsed" 2>/dev/null || :; return 1 ;; esac
          case "$first" in ''|*[!0-9]*|0) command rm -f "$parsed" 2>/dev/null || :; return 1 ;; esac
          case "$last" in ''|*[!0-9]*|0) command rm -f "$parsed" 2>/dev/null || :; return 1 ;; esac
          [ "$first" -le "$last" ] || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          [ "$evidence" = "errors/raw.log:L$first-L$last" ] \
            || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          printf '%s\t%s\t%s\t%s\t%s\n' "$tool" "$error_type" "$count" "$first" "$last" >>"$parsed" \
            || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
          parsed_count=$((parsed_count + 1))
          ;;
        *)
          command rm -f "$parsed" 2>/dev/null || :
          return 1
          ;;
      esac
      IFS= read -r line || line=
    done
  } < <(sed -n '2,$p' "$summary")

  [ "$parsed_count" -gt 0 ] || {
    command rm -f "$parsed" 2>/dev/null || :
    [ "$empty_seen" -eq 1 ]
    return $?
  }
  inbox="$knowledge/failures-inbox.md"
  if [ -e "$inbox" ] || [ -L "$inbox" ]; then
    ctx_validate_xdg_file "$inbox" || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
    iconv -f UTF-8 -t UTF-8 "$inbox" >/dev/null 2>&1 \
      || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
  fi

  # The caller-held lock checked above covers this same-directory replacement.
  replacement=$(ctx_failures_private_file "$knowledge") \
    || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
  if [ -e "$inbox" ]; then
    command cat "$inbox" >"$replacement" \
      || { command rm -f "$replacement" "$parsed" 2>/dev/null || :; return 1; }
  fi

  separator=$(printf '\037')
  appended_count=0
  while IFS=$(printf '\t') read -r tool error_type count first last extra || [ -n "$tool$error_type$count$first$last${extra:-}" ]; do
    [ -n "$tool" ] && [ -n "$error_type" ] && [ -n "$count" ] && [ -n "$first" ] && [ -n "$last" ] \
      && [ -z "${extra:-}" ] || { command rm -f "$replacement" "$parsed" 2>/dev/null || :; return 1; }
    hash_input="$session_id$separator$tool$separator$error_type$separator$first$separator$last"
    hash=$(ctx_sha256 "$hash_input") \
      || { command rm -f "$replacement" "$parsed" 2>/dev/null || :; return 1; }
    case "$hash" in *[!0-9a-f]*) command rm -f "$replacement" "$parsed" 2>/dev/null || :; return 1 ;; esac
    [ "${#hash}" -eq 64 ] \
      || { command rm -f "$replacement" "$parsed" 2>/dev/null || :; return 1; }
    marker="<!-- ark-context-candidate:$hash -->"
    if grep -F -x "$marker" "$replacement" >/dev/null 2>&1; then continue; fi
    if [ -s "$replacement" ]; then
      printf '\n' >>"$replacement" \
        || { command rm -f "$replacement" "$parsed" 2>/dev/null || :; return 1; }
    fi
    {
      printf '%s\n' "$marker"
      printf '%s\n' "### Candidate: $tool / $error_type"
      printf '%s\n' "- Tool: $tool"
      printf '%s\n' "- Error type: $error_type"
      printf '%s\n' "- Count: $count"
      printf '%s\n' "- Evidence: errors/raw.log:L$first-L$last"
      printf '%s\n' "- WORK_ID: $work_id"
      printf '%s\n' "- Session ID: $session_id"
    } >>"$replacement" \
      || { command rm -f "$replacement" "$parsed" 2>/dev/null || :; return 1; }
    marker_count=$(grep -F -x -c "$marker" "$replacement") \
      || { command rm -f "$replacement" "$parsed" 2>/dev/null || :; return 1; }
    [ "$marker_count" -eq 1 ] \
      || { command rm -f "$replacement" "$parsed" 2>/dev/null || :; return 1; }
    appended_count=$((appended_count + 1))
  done <"$parsed"
  command rm -f "$parsed" 2>/dev/null || :

  if [ "$appended_count" -eq 0 ]; then
    command rm -f "$replacement" 2>/dev/null || :
    iconv -f UTF-8 -t UTF-8 "$inbox" >/dev/null 2>&1 || return 1
    ctx_validate_xdg_file "$inbox"
    return $?
  fi
  ctx_validate_xdg_file "$replacement" \
    || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  iconv -f UTF-8 -t UTF-8 "$replacement" >/dev/null 2>&1 \
    || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  command mv "$replacement" "$inbox" \
    || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  ctx_validate_xdg_file "$inbox"
}

ctx_session_failures_inbox_append() {
  local session=${1:-}
  local knowledge=${2:-}
  local work_id=${3:-}
  local session_id=${4:-}
  local canonical source source_size confirmed_size content inbox lock lock_pid lock_token
  local separator hash marker replacement marker_count

  case "$session_id" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#session_id}" -eq 32 ] || return 1
  case "$work_id" in
    issue-[0-9]*)
      case "${work_id#issue-}" in ''|*[!0-9]*) return 1 ;; esac
      ;;
    'なし（flow 外）') ;;
    ''|*[!a-z0-9-]*|*-|*--*|-*) return 1 ;;
  esac

  ctx_validate_xdg_dir "$session" || return 1
  canonical=$(cd "$session" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$session" ] || return 1
  source="$session/failures-inbox.md"
  [ -e "$source" ] || [ -L "$source" ] || return 0
  # A model-written candidate is optional. Unsafe, invalid, or oversized input is
  # ignored whole so teardown can continue without publishing partial content.
  ctx_validate_xdg_file "$source" >/dev/null 2>&1 || return 0
  source_size=$(wc -c <"$source" 2>/dev/null | tr -d ' ') || return 0
  case "$source_size" in ''|*[!0-9]*) return 0 ;; esac
  [ "$source_size" -le 65536 ] 2>/dev/null || return 0
  content=$(command cat "$source" 2>/dev/null) || return 0
  ctx_validate_xdg_file "$source" >/dev/null 2>&1 || return 0
  confirmed_size=$(wc -c <"$source" 2>/dev/null | tr -d ' ') || return 0
  [ "$confirmed_size" = "$source_size" ] || return 0
  [ -n "$content" ] || return 0
  ctx_failures_value_safe "$content" || return 0

  ctx_validate_xdg_dir "$knowledge" || return 1
  canonical=$(cd "$knowledge" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$knowledge" ] || return 1
  lock="$knowledge/failures-inbox.lock"
  [ -d "$lock" ] && [ ! -L "$lock" ] || return 1
  ctx_validate_repo_path "$lock" directory required || return 1
  lock_pid=${FLOW_LOCK_ACQUIRED_PID:-}
  lock_token=${FLOW_LOCK_ACQUIRED_TOKEN:-}
  case "$lock_pid" in ''|*[!0-9]*) return 1 ;; esac
  ctx_failures_value_safe "$lock_token" || return 1
  [ "$(command cat "$lock/pid" 2>/dev/null)" = "$lock_pid" ] || return 1
  [ "$(command cat "$lock/token" 2>/dev/null)" = "$lock_token" ] || return 1

  inbox="$knowledge/failures-inbox.md"
  if [ -e "$inbox" ] || [ -L "$inbox" ]; then
    ctx_validate_xdg_file "$inbox" || return 1
    command -v iconv >/dev/null 2>&1 || return 1
    iconv -f UTF-8 -t UTF-8 "$inbox" >/dev/null 2>&1 || return 1
  fi
  separator=$(printf '\037')
  hash=$(ctx_sha256 "session-inbox-v1$separator$content") || return 1
  case "$hash" in *[!0-9a-f]*) return 1 ;; esac
  [ "${#hash}" -eq 64 ] || return 1
  marker="<!-- ark-context-session-candidate:$hash -->"
  if [ -e "$inbox" ] && grep -F -x "$marker" "$inbox" >/dev/null 2>&1; then return 0; fi

  replacement=$(ctx_failures_private_file "$knowledge") || return 1
  if [ -e "$inbox" ]; then
    command cat "$inbox" >"$replacement" \
      || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  fi
  if [ -s "$replacement" ]; then
    printf '\n' >>"$replacement" \
      || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  fi
  {
    printf '%s\n' "$marker"
    printf '%s\n' '### Session candidate'
    printf '%s\n' "- WORK_ID: $work_id"
    printf '%s\n' "- Session ID: $session_id"
    printf '%s\n\n' '- Source: session failures-inbox.md'
    printf '%s\n' "$content"
  } >>"$replacement" \
    || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  marker_count=$(grep -F -x -c "$marker" "$replacement") \
    || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  [ "$marker_count" -eq 1 ] \
    || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  ctx_validate_xdg_file "$replacement" \
    || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  iconv -f UTF-8 -t UTF-8 "$replacement" >/dev/null 2>&1 \
    || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  command mv "$replacement" "$inbox" \
    || { command rm -f "$replacement" 2>/dev/null || :; return 1; }
  ctx_validate_xdg_file "$inbox"
}
