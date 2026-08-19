#!/usr/bin/env bash

if [ -z "${ARK_SESSION_DIR:-}" ] || [ -z "${ARK_CACHE_DIR:-}" ]; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

input=$(LC_ALL=C awk '
  {
    if (NR > 1) total++
    total += length($0)
    if (total > 1048576) exit 42
    print
  }
  END { if (total > 1048576) exit 42 }
')
read_status=$?
[ "$read_status" -eq 0 ] || exit 0

printf '%s' "$input" | jq -e \
  'type == "object" and .hook_event_name == "PostToolBatch"' >/dev/null 2>&1 \
  || exit 0

adapter_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || exit 0
source_root=$(cd "$adapter_dir/../.." 2>/dev/null && pwd -P) || exit 0
core="$source_root/hooks/recite-todo.sh"
[ -f "$core" ] && [ ! -L "$core" ] || exit 0

context=$(/bin/bash "$core")
core_status=$?
[ "$core_status" -eq 0 ] || exit 0
[ -n "$context" ] || exit 0
line_count=$(printf '%s\n' "$context" | awk 'END { print NR }')
[ "$line_count" -eq 3 ] 2>/dev/null || exit 0
bytes=$(printf '%s\n' "$context" | wc -c | tr -d ' ')
[ "$bytes" -le 600 ] 2>/dev/null || exit 0

jq -n --arg context "$context" \
  '{hookSpecificOutput:{hookEventName:"PostToolBatch",additionalContext:$context}}' 2>/dev/null \
  || true
exit 0
