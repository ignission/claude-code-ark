#!/usr/bin/env bash

ctx_task_input_valid() {
  local value=${1-}
  local maximum=${2:-400}
  local bytes
  [ -n "$value" ] || return 1
  case "$value" in *'{{'*'}}'*) return 1 ;; esac
  ctx_has_control "$value" && return 1
  if LC_ALL=C printf '%s' "$value" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then return 1; fi
  command -v iconv >/dev/null 2>&1 || return 1
  printf '%s' "$value" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 || return 1
  bytes=$(printf '%s' "$value" | wc -c | tr -d ' ')
  [ "$bytes" -le "$maximum" ] 2>/dev/null
}

ctx_task_render() {
  local session=${1:-}
  local goal=${2:-}
  local previous=${3:-}
  local task constraints plans constraint_count plan_count option value marker new old_umask write_status context_rules
  shift 3 2>/dev/null || { ctx_error "invalid task input"; return 1; }
  ctx_validate_xdg_dir "$session" || return 1
  task="$session/task.md"
  if [ -e "$task" ] || [ -L "$task" ]; then
    ctx_validate_xdg_file "$task"
    return $?
  fi
  [ -z "$goal" ] || ctx_task_input_valid "$goal" 200 \
    || { ctx_error "invalid task input"; return 1; }
  [ -n "$previous" ] || { ctx_error "invalid task input"; return 1; }
  printf '%s' "$previous" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 \
    || { ctx_error "invalid task input"; return 1; }
  context_rules="${ARK_SOURCE_ROOT:-}/ark/context/templates/context-rules.md"
  [ "${context_rules#/}" != "$context_rules" ] && [ -f "$context_rules" ] && [ ! -L "$context_rules" ] \
    || { ctx_error "context rules unavailable"; return 1; }
  ctx_has_control "$context_rules" && { ctx_error "context rules unavailable"; return 1; }

  constraints=
  plans=
  constraint_count=0
  plan_count=0
  while [ "$#" -gt 0 ]; do
    option=$1
    shift
    [ "$#" -gt 0 ] || { ctx_error "invalid task input"; return 1; }
    value=$1
    shift
    ctx_task_input_valid "$value" 400 || { ctx_error "invalid task input"; return 1; }
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
      *) ctx_error "invalid task input"; return 1 ;;
    esac
  done
  new="$session/task.md.new"
  if [ -e "$new" ] || [ -L "$new" ]; then ctx_validate_xdg_file "$new" || return 1; fi
  old_umask=$(umask)
  umask 077
  {
    printf '# Task\n\n## Goal\n%s\n\n## Constraints\n' "$goal"
    printf '%s' "$constraints"
    printf '\nContext rules: %s\n' "$context_rules"
    printf '\nPrevious failure summary: %s\n\n## Plan\n' "$previous"
    printf '%s' "$plans"
    printf '\n## Artifacts\n- (なし)\n'
  } >"$new"
  write_status=$?
  umask "$old_umask"
  [ "$write_status" -eq 0 ] || { ctx_error "task create failed"; return 1; }
  chmod 600 "$new" || { ctx_error "task create failed"; return 1; }
  ctx_validate_xdg_file "$new" || return 1
  command mv "$new" "$task" || { ctx_error "task publish failed"; return 1; }
  ctx_validate_xdg_file "$task"
}

ctx_artifacts_index_initialize() {
  local session=${1:-} artifacts index old_umask write_status
  ctx_validate_xdg_dir "$session" || return 1
  artifacts="$session/artifacts"
  ctx_validate_xdg_dir "$artifacts" || return 1
  index="$artifacts/index.md"
  if [ -e "$index" ] || [ -L "$index" ]; then
    ctx_validate_xdg_file "$index"
    return $?
  fi
  old_umask=$(umask)
  umask 077
  (set -C; : >"$index") 2>/dev/null
  write_status=$?
  umask "$old_umask"
  if [ "$write_status" -ne 0 ]; then
    ctx_validate_xdg_file "$index"
    return $?
  fi
  chmod 600 "$index" || { ctx_error "artifact index create failed"; return 1; }
  ctx_validate_xdg_file "$index"
}

ctx_review_plan_items() {
  local session_id=${1:-} seed review_id score tab sorted
  case "$session_id" in ''|*[!0-9a-f]*) ctx_error "invalid session id"; return 1 ;; esac
  [ "${#session_id}" -eq 32 ] || { ctx_error "invalid session id"; return 1; }
  seed=$(ctx_sha256 "$session_id") || return 1
  sorted=
  for review_id in diff rules artifacts errors goal inbox; do
    score=$(ctx_sha256 "$seed:$review_id") || return 1
    sorted="${sorted}${score}	${review_id}
"
  done
  tab=$(printf '\t')
  printf '%s' "$sorted" | LC_ALL=C sort | while IFS="$tab" read -r score review_id; do
    case "$review_id" in
      diff) printf '%s\n' 'diff 全ファイルを通読する' ;;
      rules) printf '%s\n' 'artifacts/index.md の更新を含む規約遵守を検査する' ;;
      artifacts) printf '%s\n' 'artifact 本文と artifacts/index.md の整合を検査する' ;;
      errors) printf '%s\n' 'エラー握りつぶしがないことを検査する' ;;
      goal) printf '%s\n' 'Goal からの逸脱がないことを検査する' ;;
      inbox) printf '%s\n' '再発性のある指摘を failures-inbox.md 候補にする' ;;
      *) return 1 ;;
    esac
  done
}

ctx_task_render_review() {
  local session=${1:-} session_id=${2:-} goal=${3:-} previous=${4:-} review_items item
  shift 4 2>/dev/null || { ctx_error "invalid task input"; return 1; }
  review_items=$(ctx_review_plan_items "$session_id") || return 1
  set -- "$session" "$goal" "$previous" "$@"
  while IFS= read -r item || [ -n "$item" ]; do
    [ -n "$item" ] || continue
    set -- "$@" --plan-item "$item"
  done <<EOF
$review_items
EOF
  ctx_task_render "$@"
}

ctx_utf8_file_prefix() {
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

ctx_previous_failure_summary() {
  local old_session=${1:-}
  local summary="$old_session/errors/summary.md"
  local raw="$old_session/errors/raw.log"
  local prefix canonical errors
  [ -n "$old_session" ] && [ "${old_session#/}" != "$old_session" ] || { ctx_error "unsafe XDG directory"; return 1; }
  ctx_validate_xdg_dir "$old_session" || return 1
  canonical=$(cd "$old_session" 2>/dev/null && pwd -P) || { ctx_error "unsafe XDG directory"; return 1; }
  [ "$canonical" = "$old_session" ] || { ctx_error "unsafe XDG directory"; return 1; }
  errors="$old_session/errors"
  ctx_validate_xdg_dir "$errors" || return 1
  ctx_validate_xdg_file "$summary" || return 1
  if [ -e "$raw" ] || [ -L "$raw" ]; then ctx_validate_xdg_file "$raw" || return 1; fi
  prefix=$(ctx_utf8_file_prefix "$summary") || { ctx_error "invalid failure summary"; return 1; }
  prefix=$(printf '%s' "$prefix" | LC_ALL=C tr '\001-\037\177' ' ') \
    || { ctx_error "invalid failure summary"; return 1; }
  printf '%s; raw log: %s\n' "$prefix" "$raw"
}

ctx_knowledge_initialize() {
  local session=${1:-}
  local host=${2:-}
  local target source old_umask copy_status
  ctx_validate_xdg_dir "$session" || return 1
  ctx_secure_dir "$session/knowledge" || return 1
  target="$session/knowledge/failures.md"
  if [ -e "$target" ] || [ -L "$target" ]; then ctx_validate_xdg_file "$target"; return $?; fi
  source="$host/failures.md"
  if [ -e "$source" ] || [ -L "$source" ]; then ctx_validate_xdg_file "$source" || return 1; fi
  old_umask=$(umask)
  umask 077
  if [ -f "$source" ]; then command cp "$source" "$target"; else : >"$target"; fi
  copy_status=$?
  umask "$old_umask"
  [ "$copy_status" -eq 0 ] || { ctx_error "knowledge copy failed"; return 1; }
  chmod 600 "$target" || { ctx_error "knowledge copy failed"; return 1; }
  # Host knowledge is copied by init only; session consumers treat it as logically read-only.
  ctx_validate_xdg_file "$target"
}
