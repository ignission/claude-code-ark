#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
CORE="$ROOT/ark/context/hooks/inject-context-rules.sh"
WRAPPER="$ROOT/ark/context/adapters/claude-code/session-start.sh"
RULES="$ROOT/ark/context/templates/context-rules.md"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"

assert_eq "context rules contain ten numbered rules" 10 \
  "$(grep -Ec '^[1-4]\. ' "$RULES")"
grep -F '空から記入済みへの一方向の初回記入を除いて' "$RULES" >/dev/null 2>&1
assert_eq "Goal and Constraints initial-fill exception is explicit" 0 "$?"

fifo="$TEST_TMP/unreadable-input"
mkfifo "$fifo"
for hook in "$CORE" "$WRAPPER"; do
  external_out="$TEST_TMP/$(basename "$hook").external.out"
  external_err="$TEST_TMP/$(basename "$hook").external.err"
  env -u ARK_SESSION_DIR /bin/bash "$hook" <>"$fifo" >"$external_out" 2>"$external_err" &
  external_pid=$!
  wait "$external_pid"
  assert_eq "Ark outside $(basename "$hook") exits zero" 0 "$?"
  assert_eq "Ark outside $(basename "$hook") stdout empty" 0 "$(wc -c <"$external_out" | tr -d ' ')"
  assert_eq "Ark outside $(basename "$hook") stderr empty" 0 "$(wc -c <"$external_err" | tr -d ' ')"
done

session="$TEST_TMP/session"
mkdir -m 700 "$session"
printf '# Task\n\n## Goal\n\n\n## Constraints\n\n## Plan\n\n## Artifacts\n- (なし)\n' \
  >"$session/task.md"
chmod 600 "$session/task.md"

run_case env ARK_SESSION_DIR="$session" /bin/bash "$CORE"
assert_success "empty task context is generated"
rules_body=$(cat "$RULES")
context=$(cat "$CASE_STDOUT")
case "$context" in
  "$rules_body"*) TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)) ;;
  *) test_fail "additional context does not begin with the canonical rules" ;;
esac
assert_eq "additional context includes absolute task path" 1 \
  "$(grep -Fxc -- "task.md: $session/task.md" "$CASE_STDOUT")"
grep -F '最初のユーザー要求から Goal と Plan を task.md に起票' "$CASE_STDOUT" >/dev/null 2>&1
assert_eq "empty task receives initial filing instruction" 0 "$?"
grep -F -- 'artifacts/index.md の追記形式: - artifacts/<path> — <1行要約>' "$CASE_STDOUT" >/dev/null 2>&1
assert_eq "artifact append format is injected" 0 "$?"

printf '# Task\n\n## Goal\nCurrent goal\n\n## Constraints\n- fixed\n\n## Plan\n- [ ] Current step ← NOW\n' \
  >"$session/task.md"
chmod 600 "$session/task.md"
run_case env ARK_SESSION_DIR="$session" /usr/bin/zsh "$CORE"
assert_success "populated task context works in zsh"
grep -F '現在の Goal: Current goal' "$CASE_STDOUT" >/dev/null 2>&1
assert_eq "populated context presents current Goal" 0 "$?"
grep -F '現在の NOW: Current step' "$CASE_STDOUT" >/dev/null 2>&1
assert_eq "populated context presents current NOW" 0 "$?"

input="$TEST_TMP/session-start.json"
printf '%s\n' '{"session_id":"fixture","hook_event_name":"SessionStart","source":"startup"}' >"$input"
run_case env ARK_SESSION_DIR="$session" /bin/bash "$WRAPPER" <"$input"
assert_success "SessionStart adapter accepts event"
jq -e 'keys == ["hookSpecificOutput"]
  and .hookSpecificOutput.hookEventName == "SessionStart"
  and (.hookSpecificOutput.additionalContext | contains("タスク管理:"))
  and (.hookSpecificOutput.additionalContext | contains("現在の Goal: Current goal"))' \
  "$CASE_STDOUT" >/dev/null 2>&1 || test_fail "SessionStart output schema or context is invalid"

printf '%s\n' '{"hook_event_name":"PostToolBatch"}' >"$TEST_TMP/other.json"
run_case env ARK_SESSION_DIR="$session" /bin/bash "$WRAPPER" <"$TEST_TMP/other.json"
assert_success "non-SessionStart event does not block"
assert_eq "non-SessionStart event is quiet" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"

chmod 644 "$session/task.md"
run_case env ARK_SESSION_DIR="$session" /bin/bash "$WRAPPER" <"$input"
assert_success "unsafe task does not block SessionStart"
jq -e '.hookSpecificOutput.additionalContext
  | contains("最初のユーザー要求から Goal と Plan を task.md に起票")' \
  "$CASE_STDOUT" >/dev/null 2>&1 || test_fail "unsafe task content was trusted"

finish_tests claude-session-start
