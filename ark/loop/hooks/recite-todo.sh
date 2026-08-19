#!/usr/bin/env bash

# Keep this guard before stdin reads and before all optional environment use.
if [ -z "${ARK_SESSION_DIR:-}" ] || [ -z "${ARK_CACHE_DIR:-}" ]; then
  exit 0
fi

loop_hook_stat() {
  local value mode
  value=$(stat -c '%u %a' "$1" 2>/dev/null) \
    || value=$(stat -f '%u %Lp' "$1" 2>/dev/null) \
    || return 1
  set -- $value
  [ "$#" -eq 2 ] || return 1
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  case "$2" in ''|*[!0-7]*) return 1 ;; esac
  mode=$2
  while [ "${mode#0}" != "$mode" ]; do mode=${mode#0}; done
  printf '%s %s\n' "$1" "${mode:-0}"
}

loop_hook_safe_dir() {
  local value
  [ -n "$1" ] && [ "${1#/}" != "$1" ] && [ ! -L "$1" ] && [ -d "$1" ] || return 1
  case "$1" in *"
"*|*""*|*"	"*) return 1 ;; esac
  value=$(loop_hook_stat "$1") || return 1
  set -- $value
  [ "$1" = "$(id -u)" ] && [ "$2" = 700 ]
}

loop_hook_safe_file() {
  local value
  [ ! -L "$1" ] && [ -f "$1" ] || return 1
  value=$(loop_hook_stat "$1") || return 1
  set -- $value
  [ "$1" = "$(id -u)" ] && [ "$2" = 600 ]
}

loop_step_discard_lock() {
  local directory=$1
  command rm -rf "$directory" 2>/dev/null
}

loop_step_reclaim_stale() {
  local directory=$1
  local reclaim_token=$2
  local owner observed_token mtime now moved_owner moved_token reclaim
  owner=
  observed_token=
  [ ! -f "$directory/pid" ] || IFS= read -r owner <"$directory/pid"
  [ ! -f "$directory/token" ] || IFS= read -r observed_token <"$directory/token"
  case "$owner" in ''|*[!0-9]*) owner= ;; esac
  mtime=$(stat -c %Y "$directory" 2>/dev/null) \
    || mtime=$(stat -f %m "$directory" 2>/dev/null) \
    || return 1
  now=$(date +%s 2>/dev/null) || return 1
  case "$mtime" in ''|*[!0-9]*) return 1 ;; esac
  [ $((now - mtime)) -ge 30 ] || return 1
  [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null || return 1
  reclaim="${directory}.reclaim.${reclaim_token}"
  [ ! -e "$reclaim" ] || return 1
  command mv "$directory" "$reclaim" 2>/dev/null || return 1
  moved_owner=
  moved_token=
  [ ! -f "$reclaim/pid" ] || IFS= read -r moved_owner <"$reclaim/pid"
  [ ! -f "$reclaim/token" ] || IFS= read -r moved_token <"$reclaim/token"
  case "$moved_owner" in ''|*[!0-9]*) moved_owner= ;; esac
  if [ "$moved_owner" != "$owner" ] || [ "$moved_token" != "$observed_token" ] \
    || { [ -n "$moved_owner" ] && kill -0 "$moved_owner" 2>/dev/null; }; then
    [ -e "$directory" ] || command mv "$reclaim" "$directory" 2>/dev/null || true
    return 1
  fi
  loop_step_discard_lock "$reclaim"
}

loop_step_lock_acquire() {
  local directory=$1
  local token attempt observed delay_index delay
  token=$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n') || return 2
  case "$token" in *[!0-9a-f]*) return 2 ;; esac
  [ "${#token}" -eq 32 ] || return 2
  attempt=0
  while [ "$attempt" -lt 11 ]; do
    if mkdir "$directory" 2>/dev/null; then
      printf '%s\n' "$$" >"$directory/pid" 2>/dev/null || { loop_step_discard_lock "$directory"; return 2; }
      printf '%s\n' "$token" >"$directory/token" 2>/dev/null || { loop_step_discard_lock "$directory"; return 2; }
      observed=
      IFS= read -r observed <"$directory/token" || true
      [ "$observed" = "$token" ] || return 2
      LOOP_STEP_LOCK_DIR=$directory
      LOOP_STEP_LOCK_PID=$$
      LOOP_STEP_LOCK_TOKEN=$token
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 11 ] || break
    if [ "$attempt" -eq 10 ] && loop_step_reclaim_stale "$directory" "$token" >/dev/null 2>&1; then
      continue
    fi
    # Five pid-phased sleeps preserve the 50ms request budget while consecutive
    # mkdir attempts avoid five extra process launches on the contended path.
    if [ $((attempt % 2)) -eq 1 ]; then
      delay_index=$((((attempt - 1) / 2 + ($$ % 5)) % 5))
      case "$delay_index" in
        0) delay=0.006 ;; 1) delay=0.008 ;; 2) delay=0.010 ;;
        3) delay=0.012 ;; 4) delay=0.014 ;;
      esac
      /bin/sleep "$delay" 2>/dev/null || return 2
    fi
  done
  return 2
}

loop_step_lock_release() {
  local owner token
  [ -d "$LOOP_STEP_LOCK_DIR" ] || return 0
  owner=
  token=
  [ ! -f "$LOOP_STEP_LOCK_DIR/pid" ] || IFS= read -r owner <"$LOOP_STEP_LOCK_DIR/pid"
  [ ! -f "$LOOP_STEP_LOCK_DIR/token" ] || IFS= read -r token <"$LOOP_STEP_LOCK_DIR/token"
  [ "$owner" = "$LOOP_STEP_LOCK_PID" ] && [ "$token" = "$LOOP_STEP_LOCK_TOKEN" ] || return 1
  loop_step_discard_lock "$LOOP_STEP_LOCK_DIR"
}

loop_step_read_count() {
  local file=$1
  local line lines
  LOOP_STEP_CURRENT=0
  [ -e "$file" ] || return 0
  lines=0
  while IFS= read -r line || [ -n "$line" ]; do
    lines=$((lines + 1))
    LOOP_STEP_CURRENT=$line
  done <"$file"
  if [ "$lines" -ne 1 ]; then LOOP_STEP_CURRENT=0; return 0; fi
  case "$LOOP_STEP_CURRENT" in ''|*[!0-9]*) LOOP_STEP_CURRENT=0 ;; esac
  [ "$LOOP_STEP_CURRENT" -le 999999999 ] 2>/dev/null || LOOP_STEP_CURRENT=0
}

# step_count records observed batches and output attempts, never delivery receipts.
loop_step_increment() {
  local count_file new_file next old_umask write_status
  count_file="${ARK_CACHE_DIR:-}/step_count"
  new_file="${ARK_CACHE_DIR:-}/step_count.new"
  # Validate an existing count before entering the serialized section. Atomic
  # rename preserves that validated owner/mode while peer hooks advance it.
  if [ -e "$count_file" ] || [ -L "$count_file" ]; then loop_hook_safe_file "$count_file" || return 1; fi
  loop_step_lock_acquire "${ARK_CACHE_DIR:-}/step_count.lock" || return 2
  if ! loop_step_read_count "$count_file"; then loop_step_lock_release >/dev/null 2>&1; return 1; fi
  next=$((LOOP_STEP_CURRENT + 1))
  if [ -e "$new_file" ] || [ -L "$new_file" ]; then
    loop_hook_safe_file "$new_file" || { loop_step_lock_release >/dev/null 2>&1; return 1; }
  fi
  old_umask=$(umask)
  umask 077
  printf '%s\n' "$next" >"$new_file" 2>/dev/null
  write_status=$?
  umask "$old_umask"
  [ "$write_status" -eq 0 ] || { loop_step_lock_release >/dev/null 2>&1; return 1; }
  command mv "$new_file" "$count_file" 2>/dev/null || { loop_step_lock_release >/dev/null 2>&1; return 1; }
  LOOP_STEP_NEXT=$next
  loop_step_lock_release || return 1
}

loop_sanitize_line() {
  local cleaned expression
  cleaned=$(printf '%s' "$1" | LC_ALL=C tr '\001-\037\177' ' ') || return 1
  expression=$(printf 's/\302[\200-\237]/ /g')
  printf '%s' "$cleaned" | LC_ALL=C sed "$expression"
}

loop_limit_utf8() {
  local value=$1
  local maximum=$2
  local bytes count candidate
  bytes=$(printf '%s' "$value" | wc -c | tr -d ' ')
  if [ "$bytes" -le "$maximum" ]; then printf '%s' "$value"; return 0; fi
  count=$maximum
  while [ "$count" -ge $((maximum - 3)) ]; do
    candidate=$(printf '%s' "$value" | dd bs=1 count="$count" 2>/dev/null | iconv -f UTF-8 -t UTF-8 2>/dev/null) && {
      printf '%s' "$candidate"
      return 0
    }
    count=$((count - 1))
  done
  return 1
}

loop_task_parse() {
  local task=$1
  local section line goal_count now_count item
  loop_hook_safe_file "$task" || return 1
  iconv -f UTF-8 -t UTF-8 "$task" >/dev/null 2>&1 || return 1
  section=
  goal_count=0
  now_count=0
  LOOP_TASK_GOAL=
  LOOP_TASK_NOW=
  LOOP_TASK_REMAINING=0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in
      '## Goal') section=goal; continue ;;
      '## Plan') section=plan; continue ;;
      '## '*) section=other; continue ;;
    esac
    if [ "$section" = goal ] && [ -n "$line" ]; then
      goal_count=$((goal_count + 1))
      LOOP_TASK_GOAL=$line
    elif [ "$section" = plan ]; then
      case "$line" in '- [ ] '*) LOOP_TASK_REMAINING=$((LOOP_TASK_REMAINING + 1)) ;; esac
      case "$line" in
        '- [ ] '*' ← NOW'|'- [x] '*' ← NOW')
          now_count=$((now_count + 1))
          item=${line#- \[ \] }
          [ "$item" != "$line" ] || item=${line#- \[x\] }
          LOOP_TASK_NOW=${item% ← NOW}
          ;;
      esac
    fi
  done <"$task"
  [ "$goal_count" -eq 1 ] && [ "$now_count" -eq 1 ] || return 1
  [ "$LOOP_TASK_REMAINING" -le 999999 ] || return 1
  LOOP_TASK_GOAL=$(loop_sanitize_line "$LOOP_TASK_GOAL") || return 1
  LOOP_TASK_NOW=$(loop_sanitize_line "$LOOP_TASK_NOW") || return 1
  LOOP_TASK_GOAL=$(loop_limit_utf8 "$LOOP_TASK_GOAL" 180) || return 1
  LOOP_TASK_NOW=$(loop_limit_utf8 "$LOOP_TASK_NOW" 300) || return 1
}

loop_recite_main() {
  local interval output bytes
  loop_hook_safe_dir "${ARK_SESSION_DIR:-}" || return 1
  loop_hook_safe_dir "${ARK_CACHE_DIR:-}" || return 1
  interval=${ARK_RECITE_INTERVAL:-10}
  case "$interval" in ''|*[!0-9]*) return 1 ;; esac
  [ "$interval" -ge 1 ] 2>/dev/null && [ "$interval" -le 100000 ] 2>/dev/null || return 1
  loop_step_increment
  increment_status=$?
  if [ "$increment_status" -eq 2 ]; then
    printf '%s\n' 'ark-loop recite: step_count lock unavailable' >&2
    return 0
  fi
  [ "$increment_status" -eq 0 ] || return 1
  [ $((LOOP_STEP_NEXT % interval)) -eq 0 ] || return 0
  # additionalContext is best-effort: a due batch is attempted once and never retried.
  loop_task_parse "${ARK_SESSION_DIR:-}/task.md" || return 0
  output="Goal: $LOOP_TASK_GOAL
NOW: $LOOP_TASK_NOW
Remaining: $LOOP_TASK_REMAINING"
  bytes=$(printf '%s\n' "$output" | wc -c | tr -d ' ')
  [ "$bytes" -le 600 ] || return 0
  printf '%s\n' "$output"
}

if ! loop_recite_main; then
  printf '%s\n' 'ark-loop recite: unexpected failure' >&2
fi
exit 0
