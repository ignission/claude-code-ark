#!/bin/bash
[ -z "${ARK_SESSION_DIR:-}" ] && exit 0

stop_exit() {
  [ -z "${input_file:-}" ] || command rm -f "$input_file" >/dev/null 2>&1 || :
  exit 0
}
trap stop_exit EXIT HUP INT TERM

session=${ARK_SESSION_DIR:-}
ARK_SOURCE_ROOT=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd -P) || exit 0
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/runtime.sh" >/dev/null 2>&1 || exit 0
. "$ARK_SOURCE_ROOT/ark/context/scripts/lib/handoff.sh" >/dev/null 2>&1 || exit 0

command -v head >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v mktemp >/dev/null 2>&1 || exit 0
umask 077
input_file=$(mktemp "${TMPDIR:-/tmp}/ark-stop-gate.XXXXXX") || exit 0
head -c 1048577 >"$input_file" 2>/dev/null || exit 0
input_size=$(wc -c <"$input_file" | tr -d ' ') || exit 0
case "$input_size" in ''|*[!0-9]*) exit 0 ;; esac
[ "$input_size" -le 1048576 ] || exit 0

ctx_handoff_validate_session "$session" >/dev/null 2>&1 || exit 0
session_id=${session##*/}
case "$session_id" in ''|*[!0-9a-f]*) exit 0 ;; esac
[ "${#session_id}" -eq 32 ] || exit 0

validated=$(jq -cer '
  select(
    type == "object"
    and .hook_event_name == "Stop"
    and (.stop_hook_active | type) == "boolean"
    and (.cwd | type) == "string" and (.cwd | length) > 0
    and (.session_id | type) == "string"
    and (.session_id | test("^[0-9a-f]{32}$"))
    and ((has("last_assistant_message") | not) or (.last_assistant_message | type) == "string")
  )
  | [.session_id, .cwd, .stop_hook_active]
  | @tsv
' "$input_file" 2>/dev/null) || exit 0
IFS=$(printf '\t') read -r input_session_id cwd stop_hook_active extra <<EOF
$validated
EOF
[ -n "$cwd" ] && [ -z "${extra:-}" ] || exit 0
[ "$input_session_id" = "$session_id" ] || exit 0
canonical_repo=$(ctx_resolve_repo "$cwd" 2>/dev/null) || exit 0
[ "$canonical_repo" = "$cwd" ] || exit 0

ctx_handoff_parse_task "$session/task.md" >/dev/null 2>&1 || exit 0
if [ "$stop_hook_active" = true ]; then
  ctx_handoff_write "$session" "$canonical_repo" "$session_id" >/dev/null 2>&1 || :
  exit 0
fi
if [ "$CTX_HANDOFF_INCOMPLETE" -eq 0 ]; then
  ctx_handoff_write "$session" "$canonical_repo" "$session_id" >/dev/null 2>&1 || :
  exit 0
fi

flag="$session/stop_once"
if [ -e "$flag" ] || [ -L "$flag" ]; then
  if ctx_validate_xdg_file "$flag" >/dev/null 2>&1; then
    ctx_handoff_write "$session" "$canonical_repo" "$session_id" >/dev/null 2>&1 || :
  fi
  exit 0
fi
(set -C; : >"$flag") 2>/dev/null || exit 0
chmod 600 "$flag" >/dev/null 2>&1 || exit 0
ctx_validate_xdg_file "$flag" >/dev/null 2>&1 || exit 0

reason='未完了の Plan があります。現在の最小項目を完了するか、状態を task.md に反映してから停止してください。'
block=$(jq -cn --arg reason "$reason" '
  {
    decision:"block",
    reason:$reason,
    hookSpecificOutput:{
      hookEventName:"Stop",
      additionalContext:$reason
    }
  }
' 2>/dev/null) || exit 0
printf '%s\n' "$block" || :
exit 0
