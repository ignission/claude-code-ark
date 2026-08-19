#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
WRAPPER="$ROOT/ark/loop/adapters/claude-code/post-tool-batch.sh"
FIXTURES="$ROOT/ark/loop/adapters/claude-code/tests/fixtures"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"

session="$TEST_TMP/session"
cache="$TEST_TMP/cache"
mkdir -m 700 "$session" "$cache"
printf '# Task\n\n## Goal\nWrapper goal\n\n## Plan\n- [ ] wrapper item ← NOW\n' >"$session/task.md"
chmod 600 "$session/task.md"

run_wrapper() {
  fixture=$1
  env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=2 \
    /bin/bash "$WRAPPER" <"$fixture"
}

run_case run_wrapper "$FIXTURES/post-tool-batch-single-2.1.215.json"
assert_success "single fixture accepted"
assert_eq "single increments once" 1 "$(step_count "$cache")"
assert_eq "not-due wrapper stdout" '' "$(cat "$CASE_STDOUT")"

run_case run_wrapper "$FIXTURES/post-tool-batch-parallel-2.1.215.json"
assert_success "parallel fixture accepted"
assert_eq "parallel batch increments once" 2 "$(step_count "$cache")"
jq -e 'keys == ["hookSpecificOutput"] and .hookSpecificOutput.hookEventName == "PostToolBatch"' "$CASE_STDOUT" >/dev/null 2>&1 \
  || test_fail "due wrapper output schema is invalid"
assert_eq "additionalContext bytes" 'Goal: Wrapper goal
NOW: wrapper item
Remaining: 1' "$(jq -r '.hookSpecificOutput.additionalContext' "$CASE_STDOUT")"

before=$(step_count "$cache")
printf 'not-json\n' >"$TEST_TMP/invalid"
printf '[]\n' >"$TEST_TMP/array"
printf '{"hook_event_name":"PostToolUse"}\n' >"$TEST_TMP/other"
for input in "$TEST_TMP/invalid" "$TEST_TMP/array" "$TEST_TMP/other"; do
  run_case run_wrapper "$input"
  assert_success "invalid envelope does not block"
  assert_eq "invalid envelope has no side effect" "$before" "$(step_count "$cache")"
  assert_eq "invalid envelope is quiet" '' "$(cat "$CASE_STDOUT")"
done

marker="$TEST_TMP/executed"
printf '{"hook_event_name":"PostToolBatch","tool_calls":[{"command":"touch %s"}]}\n' "$marker" >"$TEST_TMP/command"
run_case run_wrapper "$TEST_TMP/command"
assert_success "command-shaped data accepted without execution"
[ ! -e "$marker" ] || test_fail "wrapper executed fixture data"

dd if=/dev/zero bs=1024 count=1025 2>/dev/null | tr '\0' x >"$TEST_TMP/huge"
run_case run_wrapper "$TEST_TMP/huge"
assert_success "oversized stdin does not block"
assert_eq "oversized stdin has no side effect" 3 "$(step_count "$cache")"

if grep -E 'tool_calls|tool_uses|\.batch' "$WRAPPER" >/dev/null 2>&1; then test_fail "wrapper branches on batch internals"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi

finish_tests claude-post-tool-batch
