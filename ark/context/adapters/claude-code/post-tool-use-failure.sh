#!/usr/bin/env bash

# Keep this guard before reading stdin.
if [ -z "${ARK_SESSION_DIR:-}" ]; then
  exit 0
fi

ADAPTER_INPUT=
ADAPTER_RESULT=
ADAPTER_NORMALIZED=
ADAPTER_UID=

adapter_cleanup() {
  if [ -n "$ADAPTER_INPUT" ] && [ ! -L "$ADAPTER_INPUT" ] && [ -f "$ADAPTER_INPUT" ]; then
    command rm -f "$ADAPTER_INPUT" >/dev/null 2>&1 || :
  fi
  if [ -n "$ADAPTER_RESULT" ] && [ ! -L "$ADAPTER_RESULT" ] && [ -f "$ADAPTER_RESULT" ]; then
    command rm -f "$ADAPTER_RESULT" >/dev/null 2>&1 || :
  fi
  if [ -n "$ADAPTER_NORMALIZED" ] && [ ! -L "$ADAPTER_NORMALIZED" ] && [ -f "$ADAPTER_NORMALIZED" ]; then
    command rm -f "$ADAPTER_NORMALIZED" >/dev/null 2>&1 || :
  fi
}

adapter_stat() {
  local value uid mode size extra
  value=$(stat -c '%u %a %s' "$1" 2>/dev/null) \
    || value=$(stat -f '%u %Lp %z' "$1" 2>/dev/null) \
    || return 1
  IFS=' ' read -r uid mode size extra <<EOF
$value
EOF
  [ -n "$uid" ] && [ -n "$mode" ] && [ -n "$size" ] && [ -z "$extra" ] || return 1
  case "$uid" in ''|*[!0-9]*) return 1 ;; esac
  case "$mode" in ''|*[!0-7]*) return 1 ;; esac
  case "$size" in ''|*[!0-9]*) return 1 ;; esac
  while [ "${mode#0}" != "$mode" ]; do mode=${mode#0}; done
  printf '%s %s %s\n' "$uid" "${mode:-0}" "$size"
}

adapter_safe_dir() {
  local value uid mode size extra target=$1
  [ -n "$target" ] && [ "${target#/}" != "$target" ] || return 1
  case "$target" in *"
"*|*""*|*"	"*) return 1 ;; esac
  [ ! -L "$target" ] && [ -d "$target" ] || return 1
  value=$(adapter_stat "$target") || return 1
  IFS=' ' read -r uid mode size extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$uid" = "$ADAPTER_UID" ] && [ "$mode" = 700 ]
}

adapter_safe_file() {
  local value uid mode size extra target=$1
  [ ! -L "$target" ] && [ -f "$target" ] || return 1
  value=$(adapter_stat "$target") || return 1
  IFS=' ' read -r uid mode size extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$uid" = "$ADAPTER_UID" ] && [ "$mode" = 600 ]
}

adapter_record_rejection() {
  local session canonical_session errors rejected value uid mode rejected_size extra at
  ADAPTER_UID=$(id -u) || return 1
  session=${ARK_SESSION_DIR:-}
  adapter_safe_dir "$session" || return 1
  canonical_session=$(cd "$session" 2>/dev/null && pwd -P) || return 1
  [ "$canonical_session" = "$session" ] || return 1
  errors="$session/errors"
  adapter_safe_dir "$errors" || return 1
  rejected="$errors/rejected.log"

  at=$(date -u '+%Y-%m-%dT%H:%M:%SZ') || return 1
  case "$at" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  LC_ALL=C jq -ce --arg at "$at" '
    .rejected
    | select(
        type == "object"
        and (.reason | IN(
          "input_too_large", "malformed_json", "input_not_object",
          "field_set_mismatch", "field_type_mismatch", "hook_event_name_mismatch"
        ))
        and ((.hook_event_name == null) or ((.hook_event_name | type) == "string" and (.hook_event_name | length) <= 256))
        and ((.tool_name == null) or ((.tool_name | type) == "string" and (.tool_name | length) <= 256))
        and (.missing_fields | type) == "array"
        and (.invalid_type_fields | type) == "array"
        and (.unexpected_field_count | type) == "number"
        and .unexpected_field_count >= 0
        and .unexpected_field_count == (.unexpected_field_count | floor)
      )
    | {
        at:$at,
        reason:.reason,
        hook_event_name:.hook_event_name,
        tool_name:.tool_name,
        missing_fields:.missing_fields,
        invalid_type_fields:.invalid_type_fields,
        unexpected_field_count:.unexpected_field_count
      }
  ' "$ADAPTER_RESULT" >"$ADAPTER_NORMALIZED" || return 1
  [ "$(wc -l <"$ADAPTER_NORMALIZED" | tr -d ' ')" = 1 ] || return 1
  value=$(adapter_stat "$ADAPTER_NORMALIZED") || return 1
  IFS=' ' read -r uid mode rejected_size extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$rejected_size" -le 4096 ] || return 1

  umask 077
  if [ -e "$rejected" ] || [ -L "$rejected" ]; then
    adapter_safe_file "$rejected" || return 1
  elif (set -C; : >"$rejected") 2>/dev/null; then
    chmod 600 "$rejected" || return 1
  else
    adapter_safe_file "$rejected" || return 1
  fi
  adapter_safe_file "$rejected" || return 1
  value=$(adapter_stat "$rejected") || return 1
  IFS=' ' read -r uid mode rejected_size extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$rejected_size" -le 67108864 ] || return 1
  command cat "$ADAPTER_NORMALIZED" >>"$rejected" || return 1
  return 0
}

adapter_fixed_rejection() {
  LC_ALL=C jq -cn --arg reason "$1" '
    {
      rejected:{
        reason:$reason,
        hook_event_name:null,
        tool_name:null,
        missing_fields:[],
        invalid_type_fields:[],
        unexpected_field_count:0
      }
    }
  ' >"$ADAPTER_RESULT" || return 1
  adapter_record_rejection || :
  return 1
}

adapter_main() {
  local script_dir core input_size tmp_root
  tmp_root=${TMPDIR:-/tmp}
  [ -n "$tmp_root" ] && [ "${tmp_root#/}" != "$tmp_root" ] || return 1
  case "$tmp_root" in *"
"*|*""*|*"	"*) return 1 ;; esac
  umask 077
  ADAPTER_INPUT=$(mktemp "$tmp_root/ark-context-failure-input.XXXXXX") || return 1
  ADAPTER_RESULT=$(mktemp "$tmp_root/ark-context-failure-result.XXXXXX") || return 1
  ADAPTER_NORMALIZED=$(mktemp "$tmp_root/ark-context-failure-normalized.XXXXXX") || return 1
  [ ! -L "$ADAPTER_INPUT" ] && [ -f "$ADAPTER_INPUT" ] || return 1
  [ ! -L "$ADAPTER_RESULT" ] && [ -f "$ADAPTER_RESULT" ] || return 1
  [ ! -L "$ADAPTER_NORMALIZED" ] && [ -f "$ADAPTER_NORMALIZED" ] || return 1
  chmod 600 "$ADAPTER_INPUT" "$ADAPTER_RESULT" "$ADAPTER_NORMALIZED" || return 1

  head -c 1048577 >"$ADAPTER_INPUT" 2>/dev/null || return 1
  input_size=$(wc -c <"$ADAPTER_INPUT" | tr -d ' ') || return 1
  case "$input_size" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$input_size" -gt 1048576 ]; then
    adapter_fixed_rejection input_too_large
    return 1
  fi

  if ! LC_ALL=C jq -ce '
    def expected_fields: [
      "cwd", "duration_ms", "effort", "error", "hook_event_name", "is_interrupt",
      "permission_mode", "prompt_id", "session_id", "tool_input", "tool_name",
      "tool_use_id", "transcript_path"
    ];
    def safe_label($value):
      if ($value | type) == "string" then $value[0:256] else null end;
    def invalid_type_fields($input):
      [
        ["session_id", "string"],
        ["transcript_path", "string"],
        ["cwd", "string"],
        ["prompt_id", "string"],
        ["permission_mode", "string"],
        ["effort", "object"],
        ["hook_event_name", "string"],
        ["tool_name", "string"],
        ["tool_input", "object"],
        ["tool_use_id", "string"],
        ["error", "string"],
        ["is_interrupt", "boolean"],
        ["duration_ms", "number"]
      ]
      | map(select(($input[.[0]] | type) != .[1]) | .[0]);
    def rejected($input; $reason; $missing; $invalid_types; $unexpected_count):
      {
        rejected:{
          reason:$reason,
          hook_event_name:(if ($input | type) == "object" then safe_label($input.hook_event_name) else null end),
          tool_name:(if ($input | type) == "object" then safe_label($input.tool_name) else null end),
          missing_fields:$missing,
          invalid_type_fields:$invalid_types,
          unexpected_field_count:$unexpected_count
        }
      };
    . as $input
    | if type != "object" then
        rejected($input; "input_not_object"; []; []; 0)
      elif (keys != expected_fields) then
        rejected(
          $input;
          "field_set_mismatch";
          (expected_fields - ($input | keys));
          [];
          ((($input | keys) - expected_fields) | length)
        )
      elif (invalid_type_fields($input) | length) > 0 then
        rejected($input; "field_type_mismatch"; []; invalid_type_fields($input); 0)
      elif .hook_event_name != "PostToolUseFailure" then
        rejected($input; "hook_event_name_mismatch"; []; []; 0)
      else
        {
          accepted:{
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
        }
      end
  ' "$ADAPTER_INPUT" >"$ADAPTER_RESULT"; then
    adapter_fixed_rejection malformed_json
    return 1
  fi

  if LC_ALL=C jq -ce '.accepted' "$ADAPTER_RESULT" >"$ADAPTER_NORMALIZED"; then
    :
  else
    adapter_record_rejection || :
    return 1
  fi

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
