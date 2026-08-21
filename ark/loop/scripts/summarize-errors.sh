#!/usr/bin/env bash
set -uo pipefail

# Keep this guard before optional environment use.
if [ -z "${ARK_SESSION_DIR:-}" ]; then
  exit 0
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || exit 1
. "$SCRIPT_DIR/lib/runtime.sh" || exit 1
. "$SCRIPT_DIR/lib/config.sh" || exit 1

SUMMARY_INDEX=
SUMMARY_SORTED=
SUMMARY_NEW=
SUMMARY_REQUEST=
SUMMARY_RESPONSE=
SUMMARY_TEXT=
SUMMARY_ITEMS=

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
  for cleanup_file in "$SUMMARY_REQUEST" "$SUMMARY_RESPONSE" "$SUMMARY_TEXT" "$SUMMARY_ITEMS"; do
    if [ -n "$cleanup_file" ] && [ ! -L "$cleanup_file" ] && [ -f "$cleanup_file" ]; then
      command rm -f "$cleanup_file" >/dev/null 2>&1 || :
    fi
  done
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

summary_file_size() {
  local value
  value=$(stat -c '%s' "$1" 2>/dev/null) || value=$(stat -f '%z' "$1" 2>/dev/null) || return 1
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$value"
}

summary_try_llm() {
  local summary=$1 errors=$2 api_key response_status response_size action reason reference extra
  LOOP_SUMMARIZE_LLM=0
  LOOP_SUMMARIZE_MODEL=
  if [ -n "${LOOP_CONFIG_FILE:-}" ]; then
    loop_config_read_summarize >/dev/null 2>&1 || return 0
  fi
  [ "$LOOP_SUMMARIZE_LLM" -eq 1 ] || return 0
  api_key=${ANTHROPIC_API_KEY:-}
  [ -n "$api_key" ] || return 0
  [ -n "$LOOP_SUMMARIZE_MODEL" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0

  SUMMARY_REQUEST="$errors/.summary-request-$$"
  SUMMARY_RESPONSE="$errors/.summary-response-$$"
  SUMMARY_TEXT="$errors/.summary-text-$$"
  SUMMARY_ITEMS="$errors/.summary-items-$$"
  summary_create_private_file "$SUMMARY_REQUEST" || return 0
  summary_create_private_file "$SUMMARY_RESPONSE" || return 0
  summary_create_private_file "$SUMMARY_TEXT" || return 0
  summary_create_private_file "$SUMMARY_ITEMS" || return 0

  jq -n --arg model "$LOOP_SUMMARIZE_MODEL" --rawfile mechanical "$summary" '
    {
      model:$model,
      max_tokens:512,
      temperature:0,
      system:(
        "Return JSON only with schema {items:[{prohibited_action:string,reason:string,reference:string}]}. "
        + "Every reference must be copied exactly from the supplied mechanical summary. "
        + "Do not request or infer raw error text, tool input, transcript paths, credentials, or secrets."
      ),
      messages:[{role:"user",content:$mechanical}]
    }
  ' >"$SUMMARY_REQUEST" 2>/dev/null || return 0
  chmod 600 "$SUMMARY_REQUEST" || return 0

  curl -sS --fail-with-body --max-time 5 -X POST 'https://api.anthropic.com/v1/messages' \
    -H "x-api-key: $api_key" \
    -H 'anthropic-version: 2023-06-01' \
    -H 'content-type: application/json' \
    --data-binary "@$SUMMARY_REQUEST" 2>/dev/null \
    | head -c 1048577 >"$SUMMARY_RESPONSE" 2>/dev/null
  response_status=$?
  [ "$response_status" -eq 0 ] || return 0
  response_size=$(summary_file_size "$SUMMARY_RESPONSE") || return 0
  [ "$response_size" -le 1048576 ] || return 0
  iconv -f UTF-8 -t UTF-8 "$SUMMARY_RESPONSE" >/dev/null 2>&1 || return 0
  jq -er '.content[0].text | select(type == "string")' "$SUMMARY_RESPONSE" >"$SUMMARY_TEXT" 2>/dev/null || return 0
  jq -e '
    type == "object"
    and keys == ["items"]
    and (.items | type) == "array"
    and (.items | length) > 0
    and all(.items[];
      type == "object"
      and keys == ["prohibited_action","reason","reference"]
      and (.prohibited_action | type) == "string" and (.prohibited_action | length) > 0
      and (.reason | type) == "string" and (.reason | length) > 0
      and (.reference | type) == "string"
      and (.prohibited_action | utf8bytelength) <= 400
      and (.reason | utf8bytelength) <= 400
      and (.reference | utf8bytelength) <= 400
      and (.prohibited_action | test("[\u0000-\u001f\u007f]") | not)
      and (.reason | test("[\u0000-\u001f\u007f]") | not)
      and (.reference | test("[\u0000-\u001f\u007f]") | not)
      and (.reference | test("^errors/raw\\.log:L[0-9]+-L[0-9]+$"))
    )
  ' "$SUMMARY_TEXT" >/dev/null 2>&1 || return 0
  jq -e --rawfile mechanical "$summary" '
    [$mechanical | split("\n")[] | select(startswith("  詳細: ")) | ltrimstr("  詳細: ")] as $references
    | all(.items[]; .reference as $reference | ($references | index($reference) != null))
  ' "$SUMMARY_TEXT" >/dev/null 2>&1 || return 0

  jq -c '.items[]' "$SUMMARY_TEXT" >"$SUMMARY_ITEMS" 2>/dev/null || return 0
  SUMMARY_NEW="$errors/summary.md.new"
  summary_create_private_file "$SUMMARY_NEW" || return 0
  command cat "$summary" >"$SUMMARY_NEW" || return 0
  printf '%s\n' 'LLM summary (opt-in)' >>"$SUMMARY_NEW" || return 0
  while IFS= read -r item || [ -n "$item" ]; do
    [ -n "$item" ] || return 0
    action=$(printf '%s\n' "$item" | jq -r '.prohibited_action') || return 0
    reason=$(printf '%s\n' "$item" | jq -r '.reason') || return 0
    reference=$(printf '%s\n' "$item" | jq -r '.reference') || return 0
    [ -n "$action" ] && [ -n "$reason" ] && [ -n "$reference" ] || return 0
    printf '%s\n' "- 禁止手: $action" >>"$SUMMARY_NEW" || return 0
    printf '%s\n' "  理由: $reason" >>"$SUMMARY_NEW" || return 0
    printf '%s\n' "  詳細: $reference" >>"$SUMMARY_NEW" || return 0
  done <"$SUMMARY_ITEMS"
  iconv -f UTF-8 -t UTF-8 "$SUMMARY_NEW" >/dev/null 2>&1 || return 0
  grep -E '^## ' "$SUMMARY_NEW" >/dev/null 2>&1 && return 0
  chmod 600 "$SUMMARY_NEW" || return 0
  loop_validate_xdg_file "$SUMMARY_NEW" >/dev/null 2>&1 || return 0
  command mv "$SUMMARY_NEW" "$summary" || return 0
  SUMMARY_NEW=
  return 0
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
  summary_try_llm "$summary" "$errors"
  return 0
}

trap summary_cleanup EXIT HUP INT TERM
summary_main
status=$?
summary_cleanup
trap - EXIT HUP INT TERM
exit "$status"
