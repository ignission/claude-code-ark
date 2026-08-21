#!/usr/bin/env bash

ctx_handoff_has_control() {
  printf '%s' "$1" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1
}

ctx_handoff_validate_session() {
  local session=${1:-}
  local canonical
  [ -n "$session" ] && [ "${session#/}" != "$session" ] || return 1
  ctx_has_control "$session" && return 1
  ctx_validate_xdg_dir "$session" || return 1
  canonical=$(cd "$session" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$session" ]
}

ctx_handoff_parse_task() {
  local task=${1:-}
  local section line content now_item
  local goal_seen plan_seen artifacts_seen goal_count now_count plan_count
  ctx_validate_xdg_file "$task" || return 1
  command -v iconv >/dev/null 2>&1 || return 1
  iconv -f UTF-8 -t UTF-8 "$task" >/dev/null 2>&1 || return 1

  section=
  goal_seen=0
  plan_seen=0
  artifacts_seen=0
  goal_count=0
  now_count=0
  plan_count=0
  CTX_HANDOFF_GOAL=
  CTX_HANDOFF_COMPLETED=
  CTX_HANDOFF_PENDING=
  CTX_HANDOFF_NOW=
  CTX_HANDOFF_INCOMPLETE=0

  while IFS= read -r line || [ -n "$line" ]; do
    ctx_handoff_has_control "$line" && return 1
    case "$line" in
      '## Goal')
        [ "$goal_seen" -eq 0 ] && [ "$plan_seen" -eq 0 ] && [ "$artifacts_seen" -eq 0 ] || return 1
        goal_seen=1; section=goal; continue ;;
      '## Plan')
        [ "$goal_seen" -eq 1 ] && [ "$plan_seen" -eq 0 ] && [ "$artifacts_seen" -eq 0 ] || return 1
        plan_seen=1; section=plan; continue ;;
      '## Artifacts')
        [ "$goal_seen" -eq 1 ] && [ "$plan_seen" -eq 1 ] && [ "$artifacts_seen" -eq 0 ] || return 1
        artifacts_seen=1; section=artifacts; continue ;;
      '## '*) section=other; continue ;;
    esac

    if [ "$section" = goal ] && [ -n "$line" ]; then
      goal_count=$((goal_count + 1))
      CTX_HANDOFF_GOAL=$line
      continue
    fi
    if [ "$section" = plan ]; then
      case "$line" in
        '- [ ] '*)
          content=${line#- \[ \] }
          [ -n "$content" ] || return 1
          plan_count=$((plan_count + 1))
          CTX_HANDOFF_INCOMPLETE=$((CTX_HANDOFF_INCOMPLETE + 1))
          CTX_HANDOFF_PENDING="${CTX_HANDOFF_PENDING}${CTX_HANDOFF_PENDING:+$'\n'}$line"
          case "$content" in
            *' ← NOW')
              now_count=$((now_count + 1))
              now_item=${content% ← NOW}
              [ -n "$now_item" ] || return 1
              CTX_HANDOFF_NOW=$now_item ;;
          esac
          ;;
        '- [x] '*|'- [X] '*)
          content=${line#- \[x\] }
          [ "$content" != "$line" ] || content=${line#- \[X\] }
          [ -n "$content" ] || return 1
          plan_count=$((plan_count + 1))
          CTX_HANDOFF_COMPLETED="${CTX_HANDOFF_COMPLETED}${CTX_HANDOFF_COMPLETED:+$'\n'}$line"
          case "$content" in
            *' ← NOW')
              now_count=$((now_count + 1))
              now_item=${content% ← NOW}
              [ -n "$now_item" ] || return 1
              CTX_HANDOFF_NOW=$now_item ;;
          esac
          ;;
        ''|'# '*) ;;
        '- ['*) return 1 ;;
      esac
    else
      case "$line" in '- [ ] '*|'- [x] '*|'- [X] '*) return 1 ;; esac
    fi
  done <"$task"

  [ "$goal_seen" -eq 1 ] && [ "$plan_seen" -eq 1 ] && [ "$artifacts_seen" -eq 1 ] || return 1
  [ "$goal_count" -eq 1 ] && [ "$plan_count" -gt 0 ] && [ "$now_count" -eq 1 ] || return 1
  if [ "$CTX_HANDOFF_INCOMPLETE" -gt 0 ]; then
    printf '%s\n' "$CTX_HANDOFF_PENDING" | grep -F -- "← NOW" >/dev/null 2>&1 || return 1
  fi
}

ctx_task_has_incomplete() {
  ctx_handoff_parse_task "${1:-}" || return 1
  [ "$CTX_HANDOFF_INCOMPLETE" -gt 0 ]
}

ctx_work_id_from_repo() {
  local repo=${1:-}
  local canonical branch rest issue
  canonical=$(ctx_resolve_repo "$repo") || return 1
  branch=$(git -C "$canonical" branch --show-current 2>/dev/null) || return 1
  ctx_handoff_has_control "$branch" && return 1
  case "$branch" in
    feature/issue-[0-9]*/*|fix/issue-[0-9]*/*|chore/issue-[0-9]*/*)
      rest=${branch#*/}
      issue=${rest%%/*}
      case "$issue" in issue-[0-9]*)
        case "${issue#issue-}" in ''|*[!0-9]*) return 1 ;; esac
        printf '%s\n' "$issue"
        return 0
      esac
      ;;
    feature/*|fix/*|chore/*)
      rest=${branch#*/}
      case "$rest" in ''|*[!a-z0-9-]*|*-|*--*|-*) ;;
        *) printf '%s\n' "$rest"; return 0 ;;
      esac
      ;;
  esac
  printf '%s\n' 'なし（flow 外）'
}

ctx_handoff_parse_artifacts() {
  local index=$1 line entry path summary
  CTX_HANDOFF_ARTIFACTS=
  if [ ! -e "$index" ] && [ ! -L "$index" ]; then return 0; fi
  ctx_validate_xdg_file "$index" || return 1
  command -v iconv >/dev/null 2>&1 || return 1
  iconv -f UTF-8 -t UTF-8 "$index" >/dev/null 2>&1 || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    ctx_handoff_has_control "$line" && return 1
    case "$line" in
      ''|'# '*) continue ;;
      '- '*' — '*)
        entry=${line#- }
        path=${entry%% — *}
        summary=${entry#* — }
        [ -n "$path" ] && [ -n "$summary" ] || return 1
        case "$path" in artifacts/*) ;; *) return 1 ;; esac
        case "$path" in *'..'*|/*) return 1 ;; esac
        CTX_HANDOFF_ARTIFACTS="${CTX_HANDOFF_ARTIFACTS}${CTX_HANDOFF_ARTIFACTS:+$'\n'}$line"
        ;;
      *) return 1 ;;
    esac
  done <"$index"
}

ctx_handoff_write() {
  local session=${1:-}
  local repo=${2:-}
  local session_id=${3:-}
  local task index summary handoff new work_id old_umask write_status
  case "$session_id" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#session_id}" -eq 32 ] || return 1
  ctx_handoff_validate_session "$session" || return 1
  task="$session/task.md"
  index="$session/artifacts/index.md"
  summary="$session/errors/summary.md"
  handoff="$session/handoff.md"
  new="$session/handoff.md.new"
  ctx_handoff_parse_task "$task" || return 1
  ctx_handoff_parse_artifacts "$index" || return 1
  if [ -e "$summary" ] || [ -L "$summary" ]; then
    ctx_validate_xdg_file "$summary" || return 1
    command -v iconv >/dev/null 2>&1 || return 1
    iconv -f UTF-8 -t UTF-8 "$summary" >/dev/null 2>&1 || return 1
  fi
  if [ -e "$handoff" ] || [ -L "$handoff" ]; then ctx_validate_xdg_file "$handoff" || return 1; fi
  if [ -e "$new" ] || [ -L "$new" ]; then
    ctx_validate_xdg_file "$new" || return 1
    : >"$new" || return 1
  else
    (set -C; : >"$new") 2>/dev/null || return 1
  fi
  work_id=$(ctx_work_id_from_repo "$repo") || { command rm -f "$new" 2>/dev/null || :; return 1; }

  old_umask=$(umask)
  umask 077
  {
    printf '%s\n' '# Handoff'
    printf '%s\n' "Goal: $CTX_HANDOFF_GOAL"
    if [ -n "$CTX_HANDOFF_COMPLETED" ]; then
      printf '%s\n' 'Completed Plan:'
      printf '%s\n' "$CTX_HANDOFF_COMPLETED"
    else
      printf '%s\n' 'Completed Plan: なし'
    fi
    if [ "$CTX_HANDOFF_INCOMPLETE" -gt 0 ]; then
      printf '%s\n' 'Pending Plan:'
      printf '%s\n' "$CTX_HANDOFF_PENDING"
      printf '%s\n' "Current NOW: $CTX_HANDOFF_NOW"
    else
      printf '%s\n' 'Pending Plan: なし（Plan 完了）'
      printf '%s\n' 'Current NOW: なし（Plan 完了）'
    fi
    if [ -n "$CTX_HANDOFF_ARTIFACTS" ]; then
      printf '%s\n' 'Artifacts:'
      printf '%s\n' "$CTX_HANDOFF_ARTIFACTS"
    else
      printf '%s\n' 'Artifacts: なし'
    fi
    if [ -f "$summary" ]; then
      printf '%s\n' "Latest error summary: $summary"
    else
      printf '%s\n' 'Latest error summary: なし'
    fi
    if [ "$CTX_HANDOFF_INCOMPLETE" -gt 0 ]; then
      printf '%s\n' "Next minimum action: $CTX_HANDOFF_NOW"
    else
      printf '%s\n' 'Next minimum action: なし（Plan 完了）'
    fi
    printf '%s\n' "WORK_ID: $work_id"
    printf '%s\n' "Session ID: $session_id"
  } >"$new"
  write_status=$?
  umask "$old_umask"
  [ "$write_status" -eq 0 ] || { command rm -f "$new" 2>/dev/null || :; return 1; }
  chmod 600 "$new" || { command rm -f "$new" 2>/dev/null || :; return 1; }
  ctx_validate_xdg_file "$new" || { command rm -f "$new" 2>/dev/null || :; return 1; }
  iconv -f UTF-8 -t UTF-8 "$new" >/dev/null 2>&1 \
    || { command rm -f "$new" 2>/dev/null || :; return 1; }
  if grep -E '^## ' "$new" >/dev/null 2>&1; then
    command rm -f "$new" 2>/dev/null || :
    return 1
  fi
  command mv "$new" "$handoff" || { command rm -f "$new" 2>/dev/null || :; return 1; }
  ctx_validate_xdg_file "$handoff"
}
