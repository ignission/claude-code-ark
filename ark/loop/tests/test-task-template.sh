#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"
. "$ROOT/ark/loop/scripts/lib/runtime.sh"
. "$ROOT/ark/loop/scripts/lib/task-template.sh"

template=$(cat "$ROOT/ark/loop/templates/task.md.tmpl")
last=0
for token in '# Task' '## Goal' '{{GOAL}}' '## Constraints' '{{CONSTRAINTS}}' \
  'Previous failure summary: {{PREV_FAILURE_SUMMARY}}' '## Plan' '{{PLAN_ITEMS}}' '## Artifacts'; do
  line=$(printf '%s\n' "$template" | grep -nF "$token" | head -1 | cut -d: -f1)
  if [ -z "$line" ] || [ "$line" -le "$last" ]; then test_fail "template token order: $token"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi
  last=${line:-$last}
done

session="$TEST_TMP/session"
mkdir -m 700 "$session"
run_case loop_task_render "$session" '日本語 goal' 'なし（通常起動）' \
  --constraint '壊さない' --constraint '速くする' --plan-item 'Redを書く' --plan-item 'Greenにする'
assert_success "task rendered"
expected='# Task

## Goal
日本語 goal

## Constraints
- 壊さない
- 速くする

Previous failure summary: なし（通常起動）

## Plan
- [ ] Redを書く ← NOW
- [ ] Greenにする

## Artifacts
- (なし)'
assert_eq "rendered task bytes" "$expected" "$(cat "$session/task.md")"
assert_eq "task mode" 600 "$(loop_stat "$session/task.md" | awk '{print $2}')"

before=$(cat "$session/task.md")
run_case loop_task_render "$session" changed changed --constraint changed --plan-item changed
assert_success "second render is idempotent"
assert_eq "second render preserves task" "$before" "$(cat "$session/task.md")"

for bad in '' 'line
break' '{{GOAL}}'; do
  fresh="$TEST_TMP/bad-$((TESTS + 1))"
  mkdir -m 700 "$fresh"
  run_case loop_task_render "$fresh" "$bad" normal --constraint safe --plan-item work
  assert_failure_reason "bad goal rejected" "invalid task input"
done
long=$(printf '%0201d' 0)
fresh="$TEST_TMP/long"
mkdir -m 700 "$fresh"
run_case loop_task_render "$fresh" "$long" normal --constraint safe --plan-item work
assert_failure_reason "long goal rejected" "invalid task input"

source_session="$TEST_TMP/source"
mkdir -m 700 "$source_session" "$source_session/errors"
printf '前回の要約です\n' >"$source_session/errors/summary.md"
chmod 600 "$source_session/errors/summary.md"
run_case loop_previous_failure_summary "$source_session"
assert_success "restart summary read"
case "$(cat "$CASE_STDOUT")" in *'前回の要約です'*"$source_session/errors/raw.log"*) TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)) ;; *) test_fail "restart summary omits summary or raw path" ;; esac

host="$TEST_TMP/host"
mkdir -m 700 "$host"
printf 'known failure\n' >"$host/failures.md"
chmod 600 "$host/failures.md"
run_case loop_knowledge_initialize "$session" "$host"
assert_success "knowledge copied"
assert_eq "knowledge bytes" 'known failure' "$(cat "$session/knowledge/failures.md")"
assert_eq "knowledge mode" 600 "$(loop_stat "$session/knowledge/failures.md" | awk '{print $2}')"

finish_tests task-template
