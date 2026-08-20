#!/usr/bin/env bash
set -uo pipefail

# Keep this guard before optional environment use.
if [ -z "${ARK_SESSION_DIR:-}" ]; then
  exit 0
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || exit 1
. "$SCRIPT_DIR/lib/runtime.sh" || exit 1

SUMMARY_INDEX=
SUMMARY_SORTED=
SUMMARY_NEW=

summary_cleanup() {
  if [ -n "$SUMMARY_INDEX" ] && [ ! -L "$SUMMARY_INDEX" ] && [ -f "$SUMMARY_INDEX" ]; then
    command rm -f "$SUMMARY_INDEX" >/dev/null 2>&1 || :
  fi
  if [ -n "$SUMMARY_SORTED" ] && [ ! -L "$SUMMARY_SORTED" ] && [ -f "$SUMMARY_SORTED" ]; then
    command rm -f "$SUMMARY_SORTED" >/dev/null 2>&1 || :
  fi
  if [ -n "$SUMMARY_NEW" ] && [ ! -L "$SUMMARY_NEW" ] && [ -f "$SUMMARY_NEW" ]; then
    command rm -f "$SUMMARY_NEW" >/dev/null 2>&1 || :
  fi
}

summary_create_private_file() {
  local target=$1
  if [ -e "$target" ] || [ -L "$target" ]; then
    loop_validate_xdg_file "$target" || return 1
    : >"$target" || return 1
  else
    (set -C; : >"$target") 2>/dev/null || return 1
    chmod 600 "$target" || return 1
  fi
  loop_validate_xdg_file "$target"
}

summary_emit_group() {
  local tool=$1 error_type=$2 count=$3 first=$4 last=$5 output=$6
  {
    printf '%s\n' "- tool: $tool"
    printf '%s\n' "  error_type: $error_type"
    printf '%s\n' "  count: $count"
    printf '%s\n' "  first_line: $first"
    printf '%s\n' "  last_line: $last"
    printf '%s\n' "  詳細: errors/raw.log:L$first-L$last"
  } >>"$output"
}

summary_main() {
  local session canonical errors raw summary line line_number tool error_type
  local current_tool current_error current_count current_first current_last sorted_line extra
  session=${ARK_SESSION_DIR:-}
  [ -n "$session" ] && [ "${session#/}" != "$session" ] || return 1
  case "$session" in *"
"*|*""*|*"	"*) return 1 ;; esac
  loop_validate_xdg_dir "$session" || return 1
  canonical=$(cd "$session" 2>/dev/null && pwd -P) || return 1
  [ "$canonical" = "$session" ] || return 1
  errors="$session/errors"
  loop_validate_xdg_dir "$errors" || return 1
  raw="$errors/raw.log"
  summary="$errors/summary.md"
  if [ -e "$raw" ] || [ -L "$raw" ]; then loop_validate_xdg_file "$raw" || return 1; fi
  if [ -e "$summary" ] || [ -L "$summary" ]; then loop_validate_xdg_file "$summary" || return 1; fi

  umask 077
  SUMMARY_INDEX="$errors/.summary-index-$$"
  SUMMARY_SORTED="$errors/.summary-sorted-$$"
  SUMMARY_NEW="$errors/summary.md.new"
  summary_create_private_file "$SUMMARY_INDEX" || return 1
  summary_create_private_file "$SUMMARY_SORTED" || return 1
  summary_create_private_file "$SUMMARY_NEW" || return 1

  line_number=0
  if [ -f "$raw" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line_number=$((line_number + 1))
      printf '%s\n' "$line" | LC_ALL=C jq -e '
        type == "object"
        and keys_unsorted == ["at","tool","error_type","exit_code","is_interrupt","error","details"]
        and (.at | type) == "string"
        and (.at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
        and (.tool | type) == "string"
        and (.tool | test("[\u0000-\u001f\u007f]") | not)
        and (.error_type | type) == "string"
        and (.error_type | test("[\u0000-\u001f\u007f]") | not)
        and ((.exit_code == null) or ((.exit_code | type) == "number" and .exit_code == (.exit_code | floor)))
        and ((.is_interrupt == null) or ((.is_interrupt | type) == "boolean"))
        and (.error | type) == "string"
        and (.details | type) == "object"
        and ((.details | keys_unsorted) == (.details | keys))
      ' >/dev/null 2>&1 || return 1
      tool=$(printf '%s\n' "$line" | jq -r '.tool') || return 1
      error_type=$(printf '%s\n' "$line" | jq -r '.error_type') || return 1
      printf '%s%s' "$tool" "$error_type" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1 && return 1
      printf '%s\t%s\t%s\n' "$tool" "$error_type" "$line_number" >>"$SUMMARY_INDEX" || return 1
    done <"$raw"
  fi

  LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2,2 -k3,3n "$SUMMARY_INDEX" >"$SUMMARY_SORTED" || return 1
  printf '%s\n' 'Error summary (mechanical)' >"$SUMMARY_NEW" || return 1
  current_tool=
  current_error=
  current_count=0
  current_first=0
  current_last=0
  while IFS="$(printf '\t')" read -r tool error_type sorted_line extra || [ -n "$tool$error_type$sorted_line$extra" ]; do
    [ -n "$tool" ] && [ -n "$error_type" ] && [ -n "$sorted_line" ] && [ -z "$extra" ] || return 1
    case "$sorted_line" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$current_count" -gt 0 ] && { [ "$tool" != "$current_tool" ] || [ "$error_type" != "$current_error" ]; }; then
      summary_emit_group "$current_tool" "$current_error" "$current_count" "$current_first" "$current_last" "$SUMMARY_NEW" || return 1
      current_count=0
    fi
    if [ "$current_count" -eq 0 ]; then
      current_tool=$tool
      current_error=$error_type
      current_first=$sorted_line
      current_last=$sorted_line
    else
      if [ "$sorted_line" -lt "$current_first" ]; then current_first=$sorted_line; fi
      if [ "$sorted_line" -gt "$current_last" ]; then current_last=$sorted_line; fi
    fi
    current_count=$((current_count + 1))
  done <"$SUMMARY_SORTED"
  if [ "$current_count" -gt 0 ]; then
    summary_emit_group "$current_tool" "$current_error" "$current_count" "$current_first" "$current_last" "$SUMMARY_NEW" || return 1
  else
    printf '%s\n' '- なし' >>"$SUMMARY_NEW" || return 1
  fi

  command -v iconv >/dev/null 2>&1 || return 1
  iconv -f UTF-8 -t UTF-8 "$SUMMARY_NEW" >/dev/null 2>&1 || return 1
  grep -E '^## ' "$SUMMARY_NEW" >/dev/null 2>&1 && return 1
  LC_ALL=C awk '
    NR == 1 { if ($0 != "Error summary (mechanical)") exit 1; next }
    /^- なし$/ { next }
    /^- tool: / { next }
    /^  error_type: / { next }
    /^  count: [0-9]+$/ { next }
    /^  first_line: [0-9]+$/ { next }
    /^  last_line: [0-9]+$/ { next }
    /^  詳細: errors\/raw\.log:L[0-9]+-L[0-9]+$/ { next }
    { exit 1 }
  ' "$SUMMARY_NEW" || return 1
  chmod 600 "$SUMMARY_NEW" || return 1
  loop_validate_xdg_file "$SUMMARY_NEW" || return 1
  command mv "$SUMMARY_NEW" "$summary" || return 1
  SUMMARY_NEW=
  return 0
}

trap summary_cleanup EXIT HUP INT TERM
summary_main
status=$?
summary_cleanup
trap - EXIT HUP INT TERM
exit "$status"
