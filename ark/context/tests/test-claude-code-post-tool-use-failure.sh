#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
WRAPPER="$ROOT/ark/context/adapters/claude-code/post-tool-use-failure.sh"
FIXTURES="$ROOT/ark/context/adapters/claude-code/tests/fixtures"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"

if [ ! -f "$WRAPPER" ]; then
  test_fail "post-tool-use-failure.sh is missing"
  finish_tests "claude PostToolUseFailure tests"
fi

version=$(sed -n 's/^claude_version=\([0-9][0-9.]*\) .*/\1/p' "$FIXTURES"/post-tool-use-failure-provenance-*.txt)
fakebin="$TEST_TMP/fakebin"
mkdir -m 700 "$fakebin"
printf '#!/usr/bin/env bash\nprintf "2026-08-20T00:00:00Z\\n"\n' >"$fakebin/date"
chmod 700 "$fakebin/date"

session="$TEST_TMP/session"
mkdir -m 700 "$session" "$session/errors"

run_wrapper() {
  input=$1
  run_case env PATH="$fakebin:$PATH" ARK_SESSION_DIR="$session" /bin/bash "$WRAPPER" <"$input"
}

run_wrapper_pipe() {
  input=$1
  run_case env PATH="$fakebin:$PATH" ARK_SESSION_DIR="$session" \
    /bin/bash -c 'cat "$1" | /bin/bash "$2"' wrapper-pipe "$input" "$WRAPPER"
}

assert_quiet_success() {
  label=$1
  assert_eq "$label exits zero" 0 "$CASE_STATUS"
  assert_eq "$label stdout empty" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
  assert_eq "$label stderr empty" 0 "$(wc -c <"$CASE_STDERR" | tr -d ' ')"
}

mode_of() {
  value=$(stat -c '%a' "$1" 2>/dev/null) || value=$(stat -f '%Lp' "$1" 2>/dev/null) || return 1
  while [ "${value#0}" != "$value" ]; do value=${value#0}; done
  printf '%s\n' "${value:-0}"
}

expected="$TEST_TMP/expected.jsonl"
: >"$expected"
for case_name in bash-exit-7 mcp-error read-missing; do
  fixture="$FIXTURES/post-tool-use-failure-$case_name-$version.json"
  run_wrapper "$fixture"
  assert_quiet_success "$case_name"
  jq -c --arg at '2026-08-20T00:00:00Z' --arg case_name "$case_name" '
    {
      at:$at,
      tool:.tool_name,
      error_type:"tool_error",
      exit_code:(if $case_name == "bash-exit-7" then (.error|capture("^Exit code (?<n>[0-9]+)$").n|tonumber) else null end),
      is_interrupt:.is_interrupt,
      error:.error,
      details:{duration_ms:.duration_ms,tool_input:.tool_input}
    }
  ' "$fixture" >>"$expected"
done
TESTS=$((TESTS + 1))
if cmp -s "$expected" "$session/errors/raw.log"; then PASSES=$((PASSES + 1)); else test_fail "adapter raw bytes mismatch"; fi
assert_eq "adapter writes three physical lines" 3 "$(wc -l <"$session/errors/raw.log" | tr -d ' ')"
jq -e -s '
  length == 3
  and all(.[]; keys_unsorted == ["at","tool","error_type","exit_code","is_interrupt","error","details"])
  and .[0].tool == "Bash" and .[0].exit_code == 7
  and .[1].tool == "mcp__fixture__fixture_fail" and .[1].exit_code == null
  and .[2].tool == "Read" and .[2].exit_code == null
  and all(.[]; (.details|keys_unsorted)==["duration_ms","tool_input"])
  and all(.[]; .is_interrupt == false and .error_type == "tool_error")
' "$session/errors/raw.log" >/dev/null 2>&1
assert_eq "adapter fixed mapping" 0 "$?"
jq -e -s '
  all(.[].details;
    (has("session_id")|not)
    and (has("transcript_path")|not)
    and (has("cwd")|not)
    and (has("prompt_id")|not)
    and (has("permission_mode")|not)
    and (has("effort")|not)
    and (has("hook_event_name")|not)
    and (has("tool_name")|not)
    and (has("tool_use_id")|not)
    and (has("error")|not)
    and (has("is_interrupt")|not)
  )
' "$session/errors/raw.log" >/dev/null 2>&1
assert_eq "transport envelope excluded" 0 "$?"

reordered="$TEST_TMP/reordered.json"
jq -S . "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$reordered"
run_wrapper "$reordered"
assert_quiet_success "reordered valid input"
assert_eq "reordered valid input is appended" 4 "$(wc -l <"$session/errors/raw.log" | tr -d ' ')"
jq -e -s '
  .[3].tool == "Bash"
  and .[3].exit_code == 7
  and .[3].error == "Exit code 7"
  and .[3].details.duration_ms == 80
  and .[3].details.tool_input.command == "/bin/sh -c '\''exit 7'\''"
' "$session/errors/raw.log" >/dev/null 2>&1
assert_eq "reordered valid input mapping" 0 "$?"
assert_eq "reordered valid input is not rejected" no "$(if [ -e "$session/errors/rejected.log" ]; then printf yes; else printf no; fi)"

invalid_dir="$TEST_TMP/invalid"
mkdir -m 700 "$invalid_dir"
printf 'not json\n' >"$invalid_dir/json"
printf '[]\n' >"$invalid_dir/array"
jq '.hook_event_name="PostToolUse"' "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$invalid_dir/event"
jq 'del(.error)' "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$invalid_dir/missing"
rejected_secret='issue-352-tool-input-must-not-be-copied'
jq --arg secret "$rejected_secret" \
  '.duration_ms="slow" | .tool_input={command:$secret} | .error=$secret' \
  "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$invalid_dir/type"
before=$(cksum "$session/errors/raw.log")
for invalid in "$invalid_dir"/*; do
  run_wrapper "$invalid"
  assert_quiet_success "invalid adapter input"
done
assert_eq "invalid adapter input preserves raw" "$before" "$(cksum "$session/errors/raw.log")"
assert_eq "invalid adapter input rejection count" 5 "$(wc -l <"$session/errors/rejected.log" | tr -d ' ')"
assert_eq "rejected log mode" 600 "$(mode_of "$session/errors/rejected.log")"
jq -e -s '
  length == 5
  and ([.[].reason] | sort) == [
    "field_set_mismatch", "field_type_mismatch", "hook_event_name_mismatch",
    "input_not_object", "malformed_json"
  ]
  and any(.[]; .reason == "field_set_mismatch" and .missing_fields == ["error"])
  and any(.[]; .reason == "field_type_mismatch" and .invalid_type_fields == ["duration_ms"])
  and all(.[].missing_fields[]; IN(
    "cwd", "duration_ms", "effort", "error", "hook_event_name", "is_interrupt",
    "permission_mode", "prompt_id", "session_id", "tool_input", "tool_name",
    "tool_use_id", "transcript_path"
  ))
  and all(.[];
    (has("error") | not)
    and (has("tool_input") | not)
    and (has("input") | not)
  )
' "$session/errors/rejected.log" >/dev/null 2>&1
assert_eq "invalid adapter rejection reasons are sanitized" 0 "$?"
grep -F "$rejected_secret" "$session/errors/rejected.log" >/dev/null 2>&1
assert_eq "rejected log omits input body" 1 "$?"

oversize="$TEST_TMP/oversize.json"
printf '%s' '{"session_id":"' >"$oversize"
dd if=/dev/zero bs=1048577 count=1 2>/dev/null | tr '\000' x >>"$oversize"
printf '%s\n' '"}' >>"$oversize"
before=$(cksum "$session/errors/raw.log")
run_wrapper "$oversize"
assert_quiet_success "oversize adapter input"
assert_eq "oversize adapter input preserves raw" "$before" "$(cksum "$session/errors/raw.log")"
jq -e -s '.[-1].reason == "input_too_large"' "$session/errors/rejected.log" >/dev/null 2>&1
assert_eq "oversize adapter rejection is visible" 0 "$?"

pipe_error="$TEST_TMP/pipe-300kb.error"
pipe_input="$TEST_TMP/pipe-300kb.json"
dd if=/dev/zero bs=1000 count=300 2>/dev/null | tr '\000' x >"$pipe_error"
jq --rawfile error "$pipe_error" '.error=$error' \
  "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$pipe_input"
run_wrapper_pipe "$pipe_input"
assert_quiet_success "300KB piped adapter input"
jq -e -s 'any(.[]; (.error | utf8bytelength) == 300000)' "$session/errors/raw.log" >/dev/null 2>&1
assert_eq "300KB piped adapter input preserves the complete error" 0 "$?"

marker="$TEST_TMP/must-not-exist"
command_data="$TEST_TMP/command-data.json"
command_error='$(touch '"$marker"'); `touch '"$marker"'`'
jq --arg command "touch $marker" --arg error "$command_error" \
  '.tool_input={command:$command} | .error=$error' \
  "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$command_data"
assert_eq "command-shaped test data construction is not executed" no "$(if [ -e "$marker" ]; then printf yes; else printf no; fi)"
run_wrapper "$command_data"
assert_quiet_success "command-shaped data"
assert_eq "command-shaped data is not executed" no "$(if [ -e "$marker" ]; then printf yes; else printf no; fi)"
jq -e -s --arg command "touch $marker" --arg error "$command_error" \
  'any(.[]; .details.tool_input.command == $command and .error == $error)' "$session/errors/raw.log" >/dev/null 2>&1
assert_eq "command-shaped data remains data" 0 "$?"

fifo="$TEST_TMP/unreadable-input"
mkfifo "$fifo"
external_out="$TEST_TMP/external.out"
external_err="$TEST_TMP/external.err"
env -u ARK_SESSION_DIR /bin/bash "$WRAPPER" <>"$fifo" >"$external_out" 2>"$external_err" &
external_pid=$!
wait "$external_pid"
external_status=$?
assert_eq "Ark outside adapter no-op exits zero" 0 "$external_status"
assert_eq "Ark outside adapter no-op stdout empty" 0 "$(wc -c <"$external_out" | tr -d ' ')"
assert_eq "Ark outside adapter no-op stderr empty" 0 "$(wc -c <"$external_err" | tr -d ' ')"

for forbidden in exitCode errorType failure_type tool_response tool_uses batch PostToolUseSuccess; do
  grep -F "$forbidden" "$WRAPPER" >/dev/null 2>&1
  assert_eq "adapter does not reference $forbidden" 1 "$?"
done
grep -E '(decision|continue|additionalContext|hookSpecificOutput)' "$WRAPPER" >/dev/null 2>&1
assert_eq "adapter emits no hook output schema" 1 "$?"
grep -F 'state-io.sh' "$WRAPPER" >/dev/null 2>&1
assert_eq "adapter does not source state-io" 1 "$?"

finish_tests "claude PostToolUseFailure tests"
