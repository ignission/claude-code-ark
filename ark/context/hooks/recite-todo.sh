#!/usr/bin/env bash

# Keep this guard before stdin reads and before all optional environment use.
if [ -z "${ARK_SESSION_DIR:-}" ] || [ -z "${ARK_CACHE_DIR:-}" ]; then
  exit 0
fi
if [ -n "${ZSH_VERSION:-}" ]; then
  setopt nonomatch 2>/dev/null || exit 0
fi

ctx_hook_stat() {
  local value uid mode extra
  value=$(stat -c '%u %a' "$1" 2>/dev/null) \
    || value=$(stat -f '%u %Lp' "$1" 2>/dev/null) \
    || return 1
  IFS=' ' read -r uid mode extra <<EOF
$value
EOF
  [ -n "$uid" ] && [ -n "$mode" ] && [ -z "$extra" ] || return 1
  case "$uid" in *[!0-9]*) return 1 ;; esac
  case "$mode" in *[!0-7]*) return 1 ;; esac
  while [ "${mode#0}" != "$mode" ]; do mode=${mode#0}; done
  printf '%s %s\n' "$uid" "${mode:-0}"
}

ctx_hook_safe_dir() {
  local value uid mode extra
  [ -n "$1" ] && [ "${1#/}" != "$1" ] && [ ! -L "$1" ] && [ -d "$1" ] || return 1
  case "$1" in *"
"*|*""*|*"	"*) return 1 ;; esac
  value=$(ctx_hook_stat "$1") || return 1
  IFS=' ' read -r uid mode extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$uid" = "$CTX_HOOK_UID" ] && [ "$mode" = 700 ]
}

ctx_hook_safe_runtime_dirs() {
  local first=$1 second=$2 values line count uid mode extra
  for line in "$first" "$second"; do
    [ -n "$line" ] && [ "${line#/}" != "$line" ] && [ ! -L "$line" ] && [ -d "$line" ] || return 1
    case "$line" in *"
"*|*""*|*"	"*) return 1 ;; esac
  done
  values=$(stat -c '%u %a' "$first" "$second" 2>/dev/null) \
    || values=$(stat -f '%u %Lp' "$first" "$second" 2>/dev/null) \
    || return 1
  count=0
  while IFS= read -r line || [ -n "$line" ]; do
    IFS=' ' read -r uid mode extra <<EOF
$line
EOF
    [ -n "$uid" ] && [ -n "$mode" ] && [ -z "$extra" ] || return 1
    while [ "${mode#0}" != "$mode" ]; do mode=${mode#0}; done
    [ "$uid" = "$CTX_HOOK_UID" ] && [ "$mode" = 700 ] || return 1
    count=$((count + 1))
  done <<EOF
$values
EOF
  [ "$count" -eq 2 ]
}

ctx_hook_safe_file() {
  local value uid mode extra
  [ ! -L "$1" ] && [ -f "$1" ] || return 1
  value=$(ctx_hook_stat "$1") || return 1
  IFS=' ' read -r uid mode extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$uid" = "$CTX_HOOK_UID" ] && [ "$mode" = 600 ]
}

CTX_STEP_BUCKET_LIMIT=64

ctx_step_prepare_directory() {
  local directory=$1 invalid create_status
  if mkdir -m 700 "$directory" 2>/dev/null; then
    ctx_hook_safe_dir "$directory"
    return
  fi
  ctx_hook_safe_dir "$directory" && return 0
  # Preserve the prior safe-corruption contract when a regular 0600 counter
  # occupies a directory path. Rename first so peers either see old or new.
  if ctx_hook_safe_file "$directory"; then
    invalid="${directory}.invalid.$$"
    [ ! -e "$invalid" ] && [ ! -L "$invalid" ] || return 1
    if command mv "$directory" "$invalid" 2>/dev/null; then
      mkdir -m 700 "$directory" 2>/dev/null
      create_status=$?
      [ "$create_status" -eq 0 ] || ctx_hook_safe_dir "$directory"
      create_status=$?
      command rm -f "$invalid" 2>/dev/null || true
      [ "$create_status" -eq 0 ] && ctx_hook_safe_dir "$directory"
      return
    fi
    ctx_hook_safe_dir "$directory"
    return
  fi
  return 1
}

ctx_step_scan_bucket() {
  local directory=$1 candidate name rest owner sequence count
  ctx_hook_safe_dir "$directory" || return 1
  count=0
  for candidate in "$directory"/step-*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    name=${candidate##*/}
    rest=${name#step-}
    owner=${rest%%-*}
    sequence=${rest#*-}
    [ "$owner" != "$rest" ] || return 1
    case "$owner" in ''|*[!0-9]*) return 1 ;; esac
    case "$sequence" in ''|*[!0-9]*) return 1 ;; esac
    [ ! -L "$candidate" ] && [ -d "$candidate" ] || return 1
    count=$((count + 1))
  done
  CTX_STEP_BUCKET_COUNT=$count
}

ctx_step_all_due_marked() {
  local directory=$1 base=$2 count=$3 interval=$4 due marker
  due=$((((base / interval) + 1) * interval))
  while [ "$due" -le $((base + count)) ]; do
    marker="$directory/emitted-$due"
    [ ! -L "$marker" ] && [ -d "$marker" ] || return 1
    due=$((due + interval))
  done
}

ctx_step_retire_sealed() {
  local steps=$1 sealed=$2 retired
  retired="$steps/retired-${sealed##*/}-$$"
  [ ! -e "$retired" ] && [ ! -L "$retired" ] || return 0
  if command mv "$sealed" "$retired" 2>/dev/null; then
    command rm -rf "$retired" 2>/dev/null || true
  fi
}

ctx_step_cleanup_retired() {
  local steps=$1 retired
  for retired in "$steps"/retired-*; do
    [ -e "$retired" ] || [ -L "$retired" ] || continue
    if ! ctx_hook_safe_dir "$retired"; then
      [ ! -e "$retired" ] && [ ! -L "$retired" ] && continue
      return 1
    fi
    command rm -rf "$retired" 2>/dev/null || true
  done
}

ctx_step_recover_sealed() {
  local steps=$1 interval=$2 sealed name rest base token end active
  for sealed in "$steps"/sealed-*; do
    [ -e "$sealed" ] || [ -L "$sealed" ] || continue
    name=${sealed##*/}
    rest=${name#sealed-}
    base=${rest%%-*}
    token=${rest#*-}
    [ "$token" != "$rest" ] || return 1
    case "$base" in ''|*[!0-9]*|0[0-9]*) return 1 ;; esac
    case "$token" in ''|*[!0-9]*) return 1 ;; esac
    ctx_step_scan_bucket "$sealed" || {
      [ ! -e "$sealed" ] && [ ! -L "$sealed" ] && continue
      return 1
    }
    end=$((base + CTX_STEP_BUCKET_COUNT))
    [ "$end" -le 999999999 ] || return 1
    active="$steps/bucket-$end"
    if ctx_step_all_due_marked "$sealed" "$base" "$CTX_STEP_BUCKET_COUNT" "$interval"; then
      ctx_step_prepare_directory "$active" || return 1
      ctx_step_retire_sealed "$steps" "$sealed"
    elif [ ! -e "$steps/bucket-$base" ] && [ ! -L "$steps/bucket-$base" ]; then
      command mv "$sealed" "$steps/bucket-$base" 2>/dev/null || true
    fi
  done
}

ctx_step_find_bucket() {
  local steps=$1 interval=$2 candidate name number highest found
  ctx_step_cleanup_retired "$steps" || return 1
  ctx_step_recover_sealed "$steps" "$interval" || return 1
  highest=0
  found=0
  for candidate in "$steps"/bucket-*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    name=${candidate##*/}
    number=${name#bucket-}
    case "$number" in ''|*[!0-9]*|0[0-9]*) return 1 ;; esac
    [ "$number" -le 999999999 ] 2>/dev/null || return 1
    if ! ctx_hook_safe_dir "$candidate"; then
      [ ! -e "$candidate" ] && [ ! -L "$candidate" ] && continue
      return 1
    fi
    if [ "$found" -eq 0 ] || [ "$number" -gt "$highest" ]; then highest=$number; fi
    found=1
  done
  if [ "$found" -eq 0 ]; then
    return 2
  fi
  CTX_STEP_BUCKET=$highest
}

ctx_step_claim_due() {
  local directory=$1 base=$2 count=$3 interval=$4 due marker
  [ "$CTX_STEP_DUE" -eq 0 ] || return 0
  due=$((((base / interval) + 1) * interval))
  while [ "$due" -le $((base + count)) ]; do
    marker="$directory/emitted-$due"
    if mkdir -m 700 "$marker" 2>/dev/null; then
      CTX_STEP_DUE=1
      return 0
    fi
    if [ ! -e "$marker" ] && [ ! -L "$marker" ]; then return 2; fi
    if ! ctx_hook_safe_dir "$marker"; then
      [ ! -e "$marker" ] && [ ! -L "$marker" ] && return 2
      ctx_hook_safe_dir "$marker" || return 1
    fi
    due=$((due + interval))
  done
}

ctx_step_compact() {
  local steps=$1 bucket=$2 base=$3 interval=$4 count sealed end
  [ "$CTX_STEP_BUCKET_COUNT" -ge "$CTX_STEP_BUCKET_LIMIT" ] || return 0
  ctx_step_all_due_marked "$bucket" "$base" "$CTX_STEP_BUCKET_COUNT" "$interval" || return 0
  sealed="$steps/sealed-$base-$$"
  [ ! -e "$sealed" ] && [ ! -L "$sealed" ] || return 0
  command mv "$bucket" "$sealed" 2>/dev/null || return 0
  if ! ctx_step_scan_bucket "$sealed"; then return 0; fi
  count=$CTX_STEP_BUCKET_COUNT
  if ! ctx_step_all_due_marked "$sealed" "$base" "$count" "$interval"; then
    command mv "$sealed" "$bucket" 2>/dev/null || true
    return 0
  fi
  end=$((base + count))
  [ "$end" -le 999999999 ] || { command mv "$sealed" "$bucket" 2>/dev/null || true; return 1; }
  ctx_step_prepare_directory "$steps/bucket-$end" || { command mv "$sealed" "$bucket" 2>/dev/null || true; return 1; }
  ctx_step_retire_sealed "$steps" "$sealed"
}

ctx_step_locate_entry() {
  local steps=$1 entry_name=$2 candidate name rest base
  for candidate in "$steps"/bucket-* "$steps"/sealed-*; do
    [ -d "$candidate/$entry_name" ] && [ ! -L "$candidate/$entry_name" ] || continue
    name=${candidate##*/}
    case "$name" in
      bucket-*) base=${name#bucket-} ;;
      sealed-*) rest=${name#sealed-}; base=${rest%%-*} ;;
      *) continue ;;
    esac
    case "$base" in ''|*[!0-9]*|0[0-9]*) return 1 ;; esac
    CTX_STEP_CONTAINER=$candidate
    CTX_STEP_CONTAINER_BASE=$base
    return 0
  done
  return 2
}

# Each process creates one private entry without contending on a lock. Emission
# markers reuse mkdir exclusion, and sealed buckets fold completed entries into
# the next bucket's numeric base so the persistent entry set remains bounded.
ctx_step_increment() {
  local interval=$1 steps bucket entry_name entry sequence find_status locate_status
  steps="${ARK_CACHE_DIR:-}/steps"
  ctx_step_prepare_directory "$steps" || return 1
  if [ ! -e "$steps/initialized" ] && [ ! -L "$steps/initialized" ]; then
    ctx_step_prepare_directory "$steps/bucket-0" || return 1
    ctx_step_prepare_directory "$steps/initialized" || return 1
  else
    ctx_hook_safe_dir "$steps/initialized" || return 1
  fi
  CTX_STEP_DUE=0
  sequence=1
  while :; do
    ctx_step_find_bucket "$steps" "$interval"
    find_status=$?
    [ "$find_status" -eq 2 ] && continue
    [ "$find_status" -eq 0 ] || return 1
    bucket="$steps/bucket-$CTX_STEP_BUCKET"
    entry_name="step-$$-$sequence"
    entry="$bucket/$entry_name"
    if mkdir -m 700 "$entry" 2>/dev/null; then break; fi
    if [ -e "$entry" ] || [ -L "$entry" ]; then
      ctx_hook_safe_dir "$entry" || return 1
      sequence=$((sequence + 1))
    fi
  done
  while :; do
    ctx_step_locate_entry "$steps" "$entry_name"
    locate_status=$?
    if [ "$locate_status" -eq 0 ]; then
      ctx_step_scan_bucket "$CTX_STEP_CONTAINER" || continue
      ctx_step_claim_due "$CTX_STEP_CONTAINER" "$CTX_STEP_CONTAINER_BASE" \
        "$CTX_STEP_BUCKET_COUNT" "$interval"
      locate_status=$?
      [ "$locate_status" -eq 2 ] && continue
      [ "$locate_status" -eq 0 ] || return 1
      case "${CTX_STEP_CONTAINER##*/}" in
        bucket-*) ctx_step_compact "$steps" "$CTX_STEP_CONTAINER" \
          "$CTX_STEP_CONTAINER_BASE" "$interval" >/dev/null 2>&1 || true ;;
      esac
      return 0
    fi
    [ "$locate_status" -eq 2 ] || return 1
    # A completed compaction already verified every due marker before deleting
    # this entry's sealed bucket, so no output attempt can remain outstanding.
    ctx_step_find_bucket "$steps" "$interval"
    find_status=$?
    [ "$find_status" -eq 2 ] && continue
    [ "$find_status" -eq 0 ] || return 1
    [ "$CTX_STEP_BUCKET" -gt 0 ] && return 0
  done
}

ctx_sanitize_line() {
  local cleaned expression
  cleaned=$(printf '%s' "$1" | LC_ALL=C tr '\001-\037\177' ' ') || return 1
  expression=$(printf 's/\302[\200-\237]/ /g')
  printf '%s' "$cleaned" | LC_ALL=C sed "$expression"
}

ctx_limit_utf8() {
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

ctx_task_parse() {
  local task=$1
  local section line goal_count now_count item
  ctx_hook_safe_file "$task" || return 1
  iconv -f UTF-8 -t UTF-8 "$task" >/dev/null 2>&1 || return 1
  section=
  goal_count=0
  now_count=0
  CTX_TASK_GOAL=
  CTX_TASK_NOW=
  CTX_TASK_REMAINING=0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in
      '## Goal') section=goal; continue ;;
      '## Plan') section=plan; continue ;;
      '## '*) section=other; continue ;;
    esac
    if [ "$section" = goal ] && [ -n "$line" ]; then
      goal_count=$((goal_count + 1))
      CTX_TASK_GOAL=$line
    elif [ "$section" = plan ]; then
      case "$line" in '- [ ] '*) CTX_TASK_REMAINING=$((CTX_TASK_REMAINING + 1)) ;; esac
      case "$line" in
        '- [ ] '*' ← NOW'|'- [x] '*' ← NOW')
          now_count=$((now_count + 1))
          item=${line#- \[ \] }
          [ "$item" != "$line" ] || item=${line#- \[x\] }
          CTX_TASK_NOW=${item% ← NOW}
          ;;
      esac
    fi
  done <"$task"
  [ "$goal_count" -eq 1 ] && [ "$now_count" -eq 1 ] || return 1
  [ "$CTX_TASK_REMAINING" -le 999999 ] || return 1
  CTX_TASK_GOAL=$(ctx_sanitize_line "$CTX_TASK_GOAL") || return 1
  CTX_TASK_NOW=$(ctx_sanitize_line "$CTX_TASK_NOW") || return 1
  CTX_TASK_GOAL=$(ctx_limit_utf8 "$CTX_TASK_GOAL" 180) || return 1
  CTX_TASK_NOW=$(ctx_limit_utf8 "$CTX_TASK_NOW" 300) || return 1
}

ctx_recite_main() {
  local interval output bytes
  CTX_HOOK_UID=$(id -u 2>/dev/null) || return 1
  ctx_hook_safe_runtime_dirs "${ARK_SESSION_DIR:-}" "${ARK_CACHE_DIR:-}" || return 1
  interval=${ARK_RECITE_INTERVAL:-10}
  case "$interval" in ''|*[!0-9]*) return 1 ;; esac
  [ "$interval" -ge 1 ] 2>/dev/null && [ "$interval" -le 100000 ] 2>/dev/null || return 1
  ctx_step_increment "$interval" || return 1
  [ "$CTX_STEP_DUE" -eq 1 ] || return 0
  # additionalContext is best-effort: a due batch is attempted once and never retried.
  ctx_task_parse "${ARK_SESSION_DIR:-}/task.md" || return 0
  output="Goal: $CTX_TASK_GOAL
NOW: $CTX_TASK_NOW
Remaining: $CTX_TASK_REMAINING"
  bytes=$(printf '%s\n' "$output" | wc -c | tr -d ' ')
  [ "$bytes" -le 600 ] || return 0
  printf '%s\n' "$output"
}

if ! ctx_recite_main; then
  printf '%s\n' 'ark-context recite: unexpected failure' >&2
fi
exit 0
