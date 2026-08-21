#!/usr/bin/env bash

# Keep this guard before stdin reads and before all optional environment use.
if [ -z "${ARK_SESSION_DIR:-}" ]; then
  exit 0
fi

CTX_RULES_HOOK_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || exit 0

ctx_rules_stat() {
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

ctx_rules_safe_session() {
  local value uid mode extra canonical
  [ -n "$1" ] && [ "${1#/}" != "$1" ] && [ ! -L "$1" ] && [ -d "$1" ] || return 1
  case "$1" in *"
"*|*""*|*"	"*) return 1 ;; esac
  canonical=$(cd "$1" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$1" ] || return 1
  value=$(ctx_rules_stat "$1") || return 1
  IFS=' ' read -r uid mode extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$uid" = "$CTX_RULES_UID" ] && [ "$mode" = 700 ]
}

ctx_rules_safe_task() {
  local value uid mode extra
  [ ! -L "$1" ] && [ -f "$1" ] || return 1
  value=$(ctx_rules_stat "$1") || return 1
  IFS=' ' read -r uid mode extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$uid" = "$CTX_RULES_UID" ] && [ "$mode" = 600 ]
}

ctx_rules_parse_task() {
  local task=$1 section line goal_count now_count item
  CTX_RULES_GOAL=
  CTX_RULES_NOW=
  ctx_rules_safe_task "$task" || return 1
  command -v iconv >/dev/null 2>&1 || return 1
  iconv -f UTF-8 -t UTF-8 "$task" >/dev/null 2>&1 || return 1
  section=
  goal_count=0
  now_count=0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in
      '## Goal') section=goal; continue ;;
      '## Plan') section=plan; continue ;;
      '## '*) section=other; continue ;;
    esac
    if [ "$section" = goal ] && [ -n "$line" ]; then
      goal_count=$((goal_count + 1))
      CTX_RULES_GOAL=$line
    elif [ "$section" = plan ]; then
      case "$line" in
        '- [ ] '*' ← NOW'|'- [x] '*' ← NOW')
          now_count=$((now_count + 1))
          item=${line#- \[ \] }
          [ "$item" != "$line" ] || item=${line#- \[x\] }
          CTX_RULES_NOW=${item% ← NOW}
          ;;
      esac
    fi
  done <"$task"
  [ "$goal_count" -le 1 ] && [ "$now_count" -le 1 ] || return 1
  case "$CTX_RULES_GOAL$CTX_RULES_NOW" in *"
"*|*""*|*"	"*) return 1 ;; esac
}

ctx_rules_main() {
  local session=${ARK_SESSION_DIR:-} task context_root rules state_context context bytes
  CTX_RULES_UID=$(id -u 2>/dev/null) || return 1
  ctx_rules_safe_session "$session" || return 1
  task="$session/task.md"
  context_root=$(cd "$CTX_RULES_HOOK_DIR/.." 2>/dev/null && pwd -P) || return 1
  rules="$context_root/templates/context-rules.md"
  [ -f "$rules" ] && [ ! -L "$rules" ] || return 1
  command -v iconv >/dev/null 2>&1 || return 1
  iconv -f UTF-8 -t UTF-8 "$rules" >/dev/null 2>&1 || return 1

  CTX_RULES_GOAL=
  CTX_RULES_NOW=
  ctx_rules_parse_task "$task" >/dev/null 2>&1 || true
  if [ -z "$CTX_RULES_GOAL" ]; then
    state_context='Goal が空です。最初のユーザー要求から Goal と Plan を task.md に起票し、Plan に項目を置いた時点で ← NOW をちょうど1個置くこと。'
  else
    state_context="現在の Goal: $CTX_RULES_GOAL
現在の NOW: ${CTX_RULES_NOW:-（未設定）}"
  fi
  context=$({
    command cat "$rules"
    printf '\ntask.md: %s\n' "$task"
    printf '%s\n' 'artifacts/index.md の追記形式: - artifacts/<path> — <1行要約>'
    printf '%s\n' "$state_context"
  }) || return 1
  bytes=$(printf '%s\n' "$context" | wc -c | tr -d ' ')
  [ "$bytes" -le 8192 ] 2>/dev/null || return 1
  printf '%s\n' "$context"
}

ctx_rules_main 2>/dev/null || true
exit 0
