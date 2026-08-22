#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
RECITE="$ROOT/ark/context/hooks/recite-todo.sh"
INJECT="$ROOT/ark/context/hooks/inject-context-rules.sh"
POST_TOOL_BATCH="$ROOT/ark/context/adapters/claude-code/post-tool-batch.sh"
SESSION_START="$ROOT/ark/context/adapters/claude-code/session-start.sh"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"

session="$TEST_TMP/session"
cache="$TEST_TMP/cache"
mkdir -m 700 "$session" "$session/errors" "$session/artifacts" \
  "$session/knowledge" "$cache"
: >"$session/knowledge/failures.md"
chmod 600 "$session/knowledge/failures.md"

write_task() {
  printf '%s\n' "$1" >"$session/task.md"
  chmod 600 "$session/task.md"
}

assert_parser_case() {
  local label=$1 goal=$2 now=$3 remaining=$4 task=$5
  write_task "$task"

  run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" \
    ARK_RECITE_INTERVAL=1 /bin/bash "$RECITE"
  assert_success "$label recite exits zero"
  assert_eq "$label recite output" "Goal: $goal
NOW: $now
Remaining: $remaining" "$(cat "$CASE_STDOUT")"
  assert_eq "$label recite stderr" '' "$(cat "$CASE_STDERR")"

  run_case env ARK_SESSION_DIR="$session" /bin/bash "$INJECT"
  assert_success "$label injection exits zero"
  assert_eq "$label injection Goal" 1 \
    "$(grep -Fxc -- "現在の Goal: $goal" "$CASE_STDOUT")"
  assert_eq "$label injection NOW" 1 \
    "$(grep -Fxc -- "現在の NOW: $now" "$CASE_STDOUT")"
  assert_eq "$label injection stderr" '' "$(cat "$CASE_STDERR")"
}

assert_parser_case 'canonical Unicode marker' 'Single goal' 'current' 2 '# Task

## Goal
Single goal

## Plan
- [x] done
- [ ] current ← NOW
- [ ] later'

assert_parser_case 'multiline Goal' 'First goal line Second goal line Third goal line' 'current' 1 '# Task

## Goal
First goal line
Second goal line
Third goal line

## Plan
- [ ] current ← NOW'

assert_parser_case 'ASCII marker' 'ASCII goal' 'ascii current' 1 '# Task

## Goal
ASCII goal

## Plan
- [ ] ascii current <- NOW'

mixed_space_task=$(printf '# Task\n\n## Goal\nMixed whitespace\n\n## Plan\n- [ ] spaced\t　 <-　 \tNOW\n')
assert_parser_case 'mixed repeated marker whitespace' 'Mixed whitespace' 'spaced' 1 \
  "$mixed_space_task"

assert_parser_case 'multiple NOW markers' 'Choose first' 'first current' 2 '# Task

## Goal
Choose first

## Plan
- [ ] first current ← NOW
- [ ] second current <- NOW'

assert_parser_case 'zero NOW markers' 'Goal remains useful' '（未設定）' 2 '# Task

## Goal
Goal remains useful

## Plan
- [ ] ordinary unchecked
- [ ] contains NOW but has no arrow
plain text ← NOW
- note <- NOW'

assert_eq 'successful variants do not create parse errors' no \
  "$(if [ -e "$session/errors/raw.log" ]; then printf yes; else printf no; fi)"

batch_input="$TEST_TMP/post-tool-batch.json"
printf '%s\n' '{"hook_event_name":"PostToolBatch","tool_calls":[]}' >"$batch_input"
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=1 \
  /bin/bash "$POST_TOOL_BATCH" <"$batch_input"
assert_success 'PostToolBatch tolerant parse exits zero'
jq -e '.hookSpecificOutput.hookEventName == "PostToolBatch"
  and .hookSpecificOutput.additionalContext == "Goal: Goal remains useful\nNOW: （未設定）\nRemaining: 2"' \
  "$CASE_STDOUT" >/dev/null 2>&1 || test_fail 'PostToolBatch stdout is not valid expected JSON'

bad_session="$TEST_TMP/bad-session"
bad_cache="$TEST_TMP/bad-cache"
mkdir -m 700 "$bad_session" "$bad_session/errors" "$bad_session/artifacts" \
  "$bad_session/knowledge" "$bad_cache"
: >"$bad_session/knowledge/failures.md"
chmod 600 "$bad_session/knowledge/failures.md"
printf '# Task\n\n## Goal\n\n## Plan\n- [ ] orphan item ← NOW\n' \
  >"$bad_session/task.md"
chmod 600 "$bad_session/task.md"

run_case env ARK_SESSION_DIR="$bad_session" ARK_CACHE_DIR="$bad_cache" \
  ARK_RECITE_INTERVAL=1 /bin/bash "$RECITE"
assert_success 'unparseable recite exits zero'
assert_eq 'unparseable recite stdout stays empty' '' "$(cat "$CASE_STDOUT")"
assert_eq 'unparseable recite stderr stays empty' '' "$(cat "$CASE_STDERR")"

run_case env ARK_SESSION_DIR="$bad_session" ARK_CACHE_DIR="$bad_cache" \
  ARK_RECITE_INTERVAL=1 /bin/bash "$RECITE"
assert_success 'repeated unparseable recite exits zero'
assert_eq 'repeated unparseable recite stdout stays empty' '' "$(cat "$CASE_STDOUT")"

run_case env ARK_SESSION_DIR="$bad_session" /bin/bash "$INJECT"
assert_success 'unparseable injection exits zero'
grep -F 'Goal が空です。' "$CASE_STDOUT" >/dev/null 2>&1 \
  || test_fail 'unparseable injection omits the explicit fallback reason'

assert_eq 'parse failure is recorded once per session' 1 \
  "$(wc -l <"$bad_session/errors/raw.log" | tr -d ' ')"
jq -e '.tool == "ark/context"
  and .error_type == "task_parse_failed"
  and .error == "task.md parse failed"
  and .details == {"goal_lines":0,"now_items":1,"reason":"goal_missing"}' \
  "$bad_session/errors/raw.log" >/dev/null 2>&1 \
  || test_fail 'parse failure raw record lacks exact counts or reason'

session_input="$TEST_TMP/session-start.json"
printf '%s\n' '{"session_id":"fixture","hook_event_name":"SessionStart","source":"startup"}' \
  >"$session_input"
run_case env ARK_SESSION_DIR="$bad_session" /bin/bash "$SESSION_START" <"$session_input"
assert_success 'SessionStart with unparseable task exits zero'
jq -e '.hookSpecificOutput.hookEventName == "SessionStart"
  and (.hookSpecificOutput.additionalContext | contains("Goal が空です。"))' \
  "$CASE_STDOUT" >/dev/null 2>&1 \
  || test_fail 'SessionStart stdout JSON is invalid after parse failure'
assert_eq 'SessionStart does not duplicate parse failure record' 1 \
  "$(wc -l <"$bad_session/errors/raw.log" | tr -d ' ')"

parallel_session="$TEST_TMP/parallel-session"
parallel_cache="$TEST_TMP/parallel-cache"
mkdir -m 700 "$parallel_session" "$parallel_session/errors" "$parallel_cache"
printf '# Task\n\n## Goal\n\n## Plan\n- [ ] parallel orphan ← NOW\n' \
  >"$parallel_session/task.md"
chmod 600 "$parallel_session/task.md"
parallel_pids=
parallel_index=1
while [ "$parallel_index" -le 20 ]; do
  env ARK_SESSION_DIR="$parallel_session" ARK_CACHE_DIR="$parallel_cache" \
    ARK_RECITE_INTERVAL=1 /bin/bash "$RECITE" \
    >"$TEST_TMP/parallel-$parallel_index.out" \
    2>"$TEST_TMP/parallel-$parallel_index.err" &
  parallel_pids="$parallel_pids $!"
  parallel_index=$((parallel_index + 1))
done
parallel_status=0
for parallel_pid in $parallel_pids; do
  wait "$parallel_pid" || parallel_status=1
done
assert_eq 'parallel parse failures all exit zero' 0 "$parallel_status"
assert_eq 'parallel parse failure is recorded exactly once' 1 \
  "$(wc -l <"$parallel_session/errors/raw.log" | tr -d ' ')"
jq -e '.error_type == "task_parse_failed"
  and .details == {"goal_lines":0,"now_items":1,"reason":"goal_missing"}' \
  "$parallel_session/errors/raw.log" >/dev/null 2>&1 \
  || test_fail 'parallel parse failure record is invalid'
assert_eq 'parallel parse failures keep stdout and stderr empty' 0 \
  "$(wc -c "$TEST_TMP"/parallel-*.out "$TEST_TMP"/parallel-*.err \
    | tail -1 | awk '{print $1}')"

if [ -n "$CTX_ZSH" ]; then
  write_task "$mixed_space_task"
  run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=1 \
    "$CTX_ZSH" "$RECITE"
  assert_success 'mixed whitespace recite works in zsh'
  assert_eq 'zsh recite matches bash parser' 'Goal: Mixed whitespace
NOW: spaced
Remaining: 1' "$(cat "$CASE_STDOUT")"
  run_case env ARK_SESSION_DIR="$session" "$CTX_ZSH" "$INJECT"
  assert_success 'mixed whitespace injection works in zsh'
  assert_eq 'zsh injection matches bash parser' 1 \
    "$(grep -Fxc -- '現在の NOW: spaced' "$CASE_STDOUT")"
else
  printf '%s\n' 'SKIP: zsh is unavailable; recite task parser zsh cases skipped'
fi

finish_tests recite-task-parser
