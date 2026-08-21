#!/usr/bin/env bash

loop_failures_value_safe() {
  local value=${1:-}
  [ -n "$value" ] || return 1
  printf '%s' "$value" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1 && return 1
  command -v iconv >/dev/null 2>&1 || return 1
  printf '%s' "$value" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
}

loop_failures_private_file() {
  local directory=$1
  local old_umask target create_status
  old_umask=$(umask)
  umask 077
  target=$(mktemp "$directory/.failures-inbox.XXXXXX" 2>/dev/null)
  create_status=$?
  umask "$old_umask"
  [ "$create_status" -eq 0 ] && [ -n "$target" ] || return 1
  chmod 600 "$target" || { command rm -f "$target" 2>/dev/null || :; return 1; }
  loop_validate_xdg_file "$target" || { command rm -f "$target" 2>/dev/null || :; return 1; }
  printf '%s\n' "$target"
}

loop_failures_inbox_append() {
  local session=${1:-}
  local knowledge=${2:-}
  local work_id=${3:-}
  local session_id=${4:-}
  local canonical errors summary inbox lock parsed block line tool error_type count first last evidence
  local extra separator hash_input marker hash parsed_count empty_seen lock_pid lock_token old_umask create_status

  case "$session_id" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#session_id}" -eq 32 ] || return 1
  case "$work_id" in
    issue-[0-9]*)
      case "${work_id#issue-}" in ''|*[!0-9]*) return 1 ;; esac
      ;;
    'なし（flow 外）') ;;
    ''|*[!a-z0-9-]*|*-|*--*|-*) return 1 ;;
  esac
  loop_validate_xdg_dir "$session" || return 1
  canonical=$(cd "$session" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$session" ] || return 1
  errors="$session/errors"
  loop_validate_xdg_dir "$errors" || return 1
  summary="$errors/summary.md"
  loop_validate_xdg_file "$summary" || return 1
  command -v iconv >/dev/null 2>&1 || return 1
  iconv -f UTF-8 -t UTF-8 "$summary" >/dev/null 2>&1 || return 1

  loop_validate_xdg_dir "$knowledge" || return 1
  canonical=$(cd "$knowledge" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$knowledge" ] || return 1
  lock="$knowledge/failures-inbox.lock"
  [ -d "$lock" ] && [ ! -L "$lock" ] || return 1
  loop_validate_repo_path "$lock" directory required || return 1
  lock_pid=${FLOW_LOCK_ACQUIRED_PID:-}
  lock_token=${FLOW_LOCK_ACQUIRED_TOKEN:-}
  case "$lock_pid" in ''|*[!0-9]*) return 1 ;; esac
  loop_failures_value_safe "$lock_token" || return 1
  [ "$(command cat "$lock/pid" 2>/dev/null)" = "$lock_pid" ] || return 1
  [ "$(command cat "$lock/token" 2>/dev/null)" = "$lock_token" ] || return 1

  parsed=$(loop_failures_private_file "$errors") || return 1
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
          loop_failures_value_safe "$tool" && loop_failures_value_safe "$error_type" \
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
    loop_validate_xdg_file "$inbox" || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
    iconv -f UTF-8 -t UTF-8 "$inbox" >/dev/null 2>&1 \
      || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
  else
    old_umask=$(umask)
    umask 077
    (set -C; : >"$inbox") 2>/dev/null
    create_status=$?
    umask "$old_umask"
    [ "$create_status" -eq 0 ] || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
    chmod 600 "$inbox" || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
    loop_validate_xdg_file "$inbox" || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
  fi

  separator=$(printf '\037')
  while IFS=$(printf '\t') read -r tool error_type count first last extra || [ -n "$tool$error_type$count$first$last${extra:-}" ]; do
    [ -n "$tool" ] && [ -n "$error_type" ] && [ -n "$count" ] && [ -n "$first" ] && [ -n "$last" ] \
      && [ -z "${extra:-}" ] || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
    hash_input="$session_id$separator$tool$separator$error_type$separator$first$separator$last"
    hash=$(loop_sha256 "$hash_input") || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
    case "$hash" in *[!0-9a-f]*) command rm -f "$parsed" 2>/dev/null || :; return 1 ;; esac
    [ "${#hash}" -eq 64 ] || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
    marker="<!-- ark-loop-candidate:$hash -->"
    if grep -F -x "$marker" "$inbox" >/dev/null 2>&1; then continue; fi
    block=$(loop_failures_private_file "$errors") \
      || { command rm -f "$parsed" 2>/dev/null || :; return 1; }
    {
      printf '%s\n' "$marker"
      printf '%s\n' "### Candidate: $tool / $error_type"
      printf '%s\n' "- Tool: $tool"
      printf '%s\n' "- Error type: $error_type"
      printf '%s\n' "- Count: $count"
      printf '%s\n' "- Evidence: errors/raw.log:L$first-L$last"
      printf '%s\n' "- WORK_ID: $work_id"
      printf '%s\n' "- Session ID: $session_id"
    } >"$block" || { command rm -f "$block" "$parsed" 2>/dev/null || :; return 1; }
    chmod 600 "$block" || { command rm -f "$block" "$parsed" 2>/dev/null || :; return 1; }
    loop_validate_xdg_file "$block" || { command rm -f "$block" "$parsed" 2>/dev/null || :; return 1; }
    if [ -s "$inbox" ]; then printf '\n' >>"$inbox" || { command rm -f "$block" "$parsed" 2>/dev/null || :; return 1; }; fi
    command cat "$block" >>"$inbox" \
      || { command rm -f "$block" "$parsed" 2>/dev/null || :; return 1; }
    command rm -f "$block" 2>/dev/null || :
  done <"$parsed"
  command rm -f "$parsed" 2>/dev/null || :
  iconv -f UTF-8 -t UTF-8 "$inbox" >/dev/null 2>&1 || return 1
  loop_validate_xdg_file "$inbox"
}
