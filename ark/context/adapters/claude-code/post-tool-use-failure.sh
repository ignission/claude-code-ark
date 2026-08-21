#!/usr/bin/env bash

# Keep this guard before reading stdin.
if [ -z "${ARK_SESSION_DIR:-}" ]; then
  exit 0
fi

ADAPTER_INPUT=
ADAPTER_NORMALIZED=

adapter_cleanup() {
  if [ -n "$ADAPTER_INPUT" ] && [ ! -L "$ADAPTER_INPUT" ] && [ -f "$ADAPTER_INPUT" ]; then
    command rm -f "$ADAPTER_INPUT" >/dev/null 2>&1 || :
  fi
  if [ -n "$ADAPTER_NORMALIZED" ] && [ ! -L "$ADAPTER_NORMALIZED" ] && [ -f "$ADAPTER_NORMALIZED" ]; then
    command rm -f "$ADAPTER_NORMALIZED" >/dev/null 2>&1 || :
  fi
}

adapter_main() {
  local script_dir core input_size tmp_root
  tmp_root=${TMPDIR:-/tmp}
  [ -n "$tmp_root" ] && [ "${tmp_root#/}" != "$tmp_root" ] || return 1
  case "$tmp_root" in *"
"*|*""*|*"	"*) return 1 ;; esac
  umask 077
  ADAPTER_INPUT=$(mktemp "$tmp_root/ark-context-failure-input.XXXXXX") || return 1
  ADAPTER_NORMALIZED=$(mktemp "$tmp_root/ark-context-failure-normalized.XXXXXX") || return 1
  [ ! -L "$ADAPTER_INPUT" ] && [ -f "$ADAPTER_INPUT" ] || return 1
  [ ! -L "$ADAPTER_NORMALIZED" ] && [ -f "$ADAPTER_NORMALIZED" ] || return 1
  chmod 600 "$ADAPTER_INPUT" "$ADAPTER_NORMALIZED" || return 1

  head -c 1048577 >"$ADAPTER_INPUT" 2>/dev/null || return 1
  input_size=$(wc -c <"$ADAPTER_INPUT" | tr -d ' ') || return 1
  case "$input_size" in ''|*[!0-9]*) return 1 ;; esac
  [ "$input_size" -le 1048576 ] || return 1

  LC_ALL=C jq -ce '
    select(
      type == "object"
      and keys_unsorted == [
        "session_id","transcript_path","cwd","prompt_id","permission_mode","effort",
        "hook_event_name","tool_name","tool_input","tool_use_id","error","is_interrupt","duration_ms"
      ]
      and (.session_id | type) == "string"
      and (.transcript_path | type) == "string"
      and (.cwd | type) == "string"
      and (.prompt_id | type) == "string"
      and (.permission_mode | type) == "string"
      and (.effort | type) == "object"
      and .hook_event_name == "PostToolUseFailure"
      and (.tool_name | type) == "string"
      and (.tool_input | type) == "object"
      and (.tool_use_id | type) == "string"
      and (.error | type) == "string"
      and (.is_interrupt | type) == "boolean"
      and (.duration_ms | type) == "number"
    )
    | {
        tool:.tool_name,
        error_type:"tool_error",
        exit_code:(
          if .tool_name == "Bash" and (.error | test("^Exit code [0-9]+$"))
          then (.error | capture("^Exit code (?<code>[0-9]+)$").code | tonumber)
          else null
          end
        ),
        is_interrupt:.is_interrupt,
        error:.error,
        details:{tool_input:.tool_input,duration_ms:.duration_ms}
      }
  ' "$ADAPTER_INPUT" >"$ADAPTER_NORMALIZED" || return 1

  script_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || return 1
  core=$(cd "$script_dir/../../hooks" 2>/dev/null && pwd -P) || return 1
  core="$core/capture-error.sh"
  [ ! -L "$core" ] && [ -f "$core" ] || return 1
  /bin/bash "$core" <"$ADAPTER_NORMALIZED" >/dev/null 2>&1 || :
  return 0
}

trap adapter_cleanup EXIT HUP INT TERM
adapter_main >/dev/null 2>&1 || :
exit 0
