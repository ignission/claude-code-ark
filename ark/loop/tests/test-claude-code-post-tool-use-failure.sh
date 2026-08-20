#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
WRAPPER="$ROOT/ark/loop/adapters/claude-code/post-tool-use-failure.sh"
FIXTURES="$ROOT/ark/loop/adapters/claude-code/tests/fixtures"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"

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

assert_quiet_success() {
  label=$1
  assert_eq "$label exits zero" 0 "$CASE_STATUS"
  assert_eq "$label stdout empty" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
  assert_eq "$label stderr empty" 0 "$(wc -c <"$CASE_STDERR" | tr -d ' ')"
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

invalid_dir="$TEST_TMP/invalid"
mkdir -m 700 "$invalid_dir"
printf 'not json\n' >"$invalid_dir/json"
printf '[]\n' >"$invalid_dir/array"
jq '.hook_event_name="PostToolUse"' "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$invalid_dir/event"
jq 'del(.error)' "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$invalid_dir/missing"
jq '.duration_ms="slow"' "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$invalid_dir/type"
before=$(cksum "$session/errors/raw.log")
for invalid in "$invalid_dir"/*; do
  run_wrapper "$invalid"
  assert_quiet_success "invalid adapter input"
done
assert_eq "invalid adapter input preserves raw" "$before" "$(cksum "$session/errors/raw.log")"

oversize="$TEST_TMP/oversize.json"
printf '%s' '{"session_id":"' >"$oversize"
dd if=/dev/zero bs=1048577 count=1 2>/dev/null | tr '\000' x >>"$oversize"
printf '%s\n' '"}' >>"$oversize"
before=$(cksum "$session/errors/raw.log")
run_wrapper "$oversize"
assert_quiet_success "oversize adapter input"
assert_eq "oversize adapter input preserves raw" "$before" "$(cksum "$session/errors/raw.log")"

marker="$TEST_TMP/must-not-exist"
command_data="$TEST_TMP/command-data.json"
jq --arg command "touch $marker" --arg error "\$(touch $marker); \\`touch $marker\\`" \
  '.tool_input={command:$command} | .error=$error' \
  "$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json" >"$command_data"
run_wrapper "$command_data"
assert_quiet_success "command-shaped data"
assert_eq "command-shaped data is not executed" no "$(if [ -e "$marker" ]; then printf yes; else printf no; fi)"
jq -e -s --arg command "touch $marker" --arg error "\$(touch $marker); \\`touch $marker\\`" \
  'any(.[]; .details.tool_input.command == $command and .error == $error)' "$session/errors/raw.log" >/dev/null 2>&1
assert_eq "command-shaped data remains data" 0 "$?"

run_case env -u ARK_SESSION_DIR /bin/bash "$WRAPPER" <"$FIXTURES/post-tool-use-failure-bash-exit-7-$version.json"
assert_quiet_success "Ark outside adapter no-op"

for forbidden in exitCode errorType failure_type tool_response tool_uses batch PostToolUseSuccess; do
  grep -F "$forbidden" "$WRAPPER" >/dev/null 2>&1
  assert_eq "adapter does not reference $forbidden" 1 "$?"
done
grep -E '(decision|continue|additionalContext|hookSpecificOutput)' "$WRAPPER" >/dev/null 2>&1
assert_eq "adapter emits no hook output schema" 1 "$?"
grep -F 'state-io.sh' "$WRAPPER" >/dev/null 2>&1
assert_eq "adapter does not source state-io" 1 "$?"

finish_tests "claude PostToolUseFailure tests"
