#!/usr/bin/env bash

loop_task_input_valid() {
  local value=${1-}
  local maximum=${2:-400}
  local bytes
  [ -n "$value" ] || return 1
  case "$value" in *'{{'*'}}'*) return 1 ;; esac
  loop_has_control "$value" && return 1
  if LC_ALL=C printf '%s' "$value" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then return 1; fi
  command -v iconv >/dev/null 2>&1 || return 1
  printf '%s' "$value" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 || return 1
  bytes=$(printf '%s' "$value" | wc -c | tr -d ' ')
  [ "$bytes" -le "$maximum" ] 2>/dev/null
}

loop_task_render() {
  local session=${1:-}
  local goal=${2:-}
  local previous=${3:-}
  local task constraints plans constraint_count plan_count option value marker new old_umask write_status
  shift 3 2>/dev/null || { loop_error "invalid task input"; return 1; }
  loop_validate_xdg_dir "$session" || return 1
  task="$session/task.md"
  if [ -e "$task" ] || [ -L "$task" ]; then
    loop_validate_xdg_file "$task"
    return $?
  fi
  loop_task_input_valid "$goal" 200 || { loop_error "invalid task input"; return 1; }
  [ -n "$previous" ] || { loop_error "invalid task input"; return 1; }
  printf '%s' "$previous" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 \
    || { loop_error "invalid task input"; return 1; }

  constraints=
  plans=
  constraint_count=0
  plan_count=0
  while [ "$#" -gt 0 ]; do
    option=$1
    shift
    [ "$#" -gt 0 ] || { loop_error "invalid task input"; return 1; }
    value=$1
    shift
    loop_task_input_valid "$value" 400 || { loop_error "invalid task input"; return 1; }
    case "$option" in
      --constraint)
        constraints="${constraints}- $value
"
        constraint_count=$((constraint_count + 1))
        ;;
      --plan-item)
        if [ "$plan_count" -eq 0 ]; then marker=' ← NOW'; else marker=; fi
        plans="${plans}- [ ] $value$marker
"
        plan_count=$((plan_count + 1))
        ;;
      *) loop_error "invalid task input"; return 1 ;;
    esac
  done
  [ "$constraint_count" -gt 0 ] && [ "$plan_count" -gt 0 ] \
    || { loop_error "invalid task input"; return 1; }

  new="$session/task.md.new"
  if [ -e "$new" ] || [ -L "$new" ]; then loop_validate_xdg_file "$new" || return 1; fi
  old_umask=$(umask)
  umask 077
  {
    printf '# Task\n\n## Goal\n%s\n\n## Constraints\n' "$goal"
    printf '%s' "$constraints"
    printf '\nPrevious failure summary: %s\n\n## Plan\n' "$previous"
    printf '%s' "$plans"
    printf '\n## Artifacts\n- (なし)\n'
  } >"$new"
  write_status=$?
  umask "$old_umask"
  [ "$write_status" -eq 0 ] || { loop_error "task create failed"; return 1; }
  chmod 600 "$new" || { loop_error "task create failed"; return 1; }
  loop_validate_xdg_file "$new" || return 1
  command mv "$new" "$task" || { loop_error "task publish failed"; return 1; }
  loop_validate_xdg_file "$task"
}

loop_utf8_file_prefix() {
  local source_file=$1
  local total count prefix
  command -v iconv >/dev/null 2>&1 || return 1
  iconv -f UTF-8 -t UTF-8 "$source_file" >/dev/null 2>&1 || return 1
  total=$(wc -c <"$source_file" | tr -d ' ')
  if [ "$total" -le 2000 ]; then command cat "$source_file"; return $?; fi
  count=2000
  while [ "$count" -ge 1997 ]; do
    prefix=$(dd if="$source_file" bs=1 count="$count" 2>/dev/null | iconv -f UTF-8 -t UTF-8 2>/dev/null) && {
      printf '%s' "$prefix"
      return 0
    }
    count=$((count - 1))
  done
  return 1
}

loop_previous_failure_summary() {
  local old_session=${1:-}
  local summary="$old_session/errors/summary.md"
  local raw="$old_session/errors/raw.log"
  local prefix canonical errors
  [ -n "$old_session" ] && [ "${old_session#/}" != "$old_session" ] || { loop_error "unsafe XDG directory"; return 1; }
  loop_validate_xdg_dir "$old_session" || return 1
  canonical=$(cd "$old_session" 2>/dev/null && pwd -P) || { loop_error "unsafe XDG directory"; return 1; }
  [ "$canonical" = "$old_session" ] || { loop_error "unsafe XDG directory"; return 1; }
  errors="$old_session/errors"
  loop_validate_xdg_dir "$errors" || return 1
  loop_validate_xdg_file "$summary" || return 1
  if [ -e "$raw" ] || [ -L "$raw" ]; then loop_validate_xdg_file "$raw" || return 1; fi
  prefix=$(loop_utf8_file_prefix "$summary") || { loop_error "invalid failure summary"; return 1; }
  prefix=$(printf '%s' "$prefix" | LC_ALL=C tr '\001-\037\177' ' ') \
    || { loop_error "invalid failure summary"; return 1; }
  printf '%s; raw log: %s\n' "$prefix" "$raw"
}

loop_knowledge_initialize() {
  local session=${1:-}
  local host=${2:-}
  local target source old_umask copy_status
  loop_validate_xdg_dir "$session" || return 1
  loop_secure_dir "$session/knowledge" || return 1
  target="$session/knowledge/failures.md"
  if [ -e "$target" ] || [ -L "$target" ]; then loop_validate_xdg_file "$target"; return $?; fi
  source="$host/failures.md"
  if [ -e "$source" ] || [ -L "$source" ]; then loop_validate_xdg_file "$source" || return 1; fi
  old_umask=$(umask)
  umask 077
  if [ -f "$source" ]; then command cp "$source" "$target"; else : >"$target"; fi
  copy_status=$?
  umask "$old_umask"
  [ "$copy_status" -eq 0 ] || { loop_error "knowledge copy failed"; return 1; }
  chmod 600 "$target" || { loop_error "knowledge copy failed"; return 1; }
  # Host knowledge is copied by init only; session consumers treat it as logically read-only.
  loop_validate_xdg_file "$target"
}
