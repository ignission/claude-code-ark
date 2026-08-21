#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"
. "$ROOT/ark/context/scripts/lib/runtime.sh"
. "$ROOT/ark/context/scripts/lib/task-template.sh"
ARK_SOURCE_ROOT=$ROOT
context_rules="$ROOT/ark/context/templates/context-rules.md"

template=$(cat "$ROOT/ark/context/templates/task.md.tmpl")
last=0
for token in '# Task' '## Goal' '{{GOAL}}' '## Constraints' '{{CONSTRAINTS}}' \
  'Context rules: {{CONTEXT_RULES}}' 'Previous failure summary: {{PREV_FAILURE_SUMMARY}}' \
  '## Plan' '{{PLAN_ITEMS}}' '## Artifacts'; do
  line=$(printf '%s\n' "$template" | grep -nF "$token" | head -1 | cut -d: -f1)
  if [ -z "$line" ] || [ "$line" -le "$last" ]; then test_fail "template token order: $token"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi
  last=${line:-$last}
done

session="$TEST_TMP/session"
mkdir -m 700 "$session"
run_case ctx_task_render "$session" '日本語 goal' 'なし（通常起動）' \
  --constraint '壊さない' --constraint '速くする' --plan-item 'Redを書く' --plan-item 'Greenにする'
assert_success "task rendered"
expected='# Task

## Goal
日本語 goal

## Constraints
- 壊さない
- 速くする

Context rules: CONTEXT_RULES_PATH

Previous failure summary: なし（通常起動）

## Plan
- [ ] Redを書く ← NOW
- [ ] Greenにする

## Artifacts
- (なし)'
expected=${expected/CONTEXT_RULES_PATH/$context_rules}
assert_eq "rendered task bytes" "$expected" "$(cat "$session/task.md")"
assert_eq "task mode" 600 "$(ctx_stat "$session/task.md" | awk '{print $2}')"

before=$(cat "$session/task.md")
run_case ctx_task_render "$session" changed changed --constraint changed --plan-item changed
assert_success "second render is idempotent"
assert_eq "second render preserves task" "$before" "$(cat "$session/task.md")"

empty_session="$TEST_TMP/empty"
mkdir -m 700 "$empty_session"
run_case ctx_task_render "$empty_session" '' 'なし（通常起動）'
assert_success "empty task scaffold rendered"
empty_expected='# Task

## Goal


## Constraints

Context rules: CONTEXT_RULES_PATH

Previous failure summary: なし（通常起動）

## Plan

## Artifacts
- (なし)'
empty_expected=${empty_expected/CONTEXT_RULES_PATH/$context_rules}
assert_eq "empty task scaffold bytes" "$empty_expected" "$(cat "$empty_session/task.md")"
empty_cache="$TEST_TMP/empty-cache"
mkdir -m 700 "$empty_cache"
run_case env ARK_SESSION_DIR="$empty_session" ARK_CACHE_DIR="$empty_cache" \
  ARK_RECITE_INTERVAL=1 /bin/bash "$ROOT/ark/context/hooks/recite-todo.sh"
assert_success "empty task recitation succeeds"
assert_eq "empty task recitation stays silent" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"

artifact_session="$TEST_TMP/artifact-session"
mkdir -m 700 "$artifact_session" "$artifact_session/artifacts"
run_case ctx_artifacts_index_initialize "$artifact_session"
assert_success "artifact index initialized"
assert_eq "artifact index starts empty" 0 "$(wc -c <"$artifact_session/artifacts/index.md" | tr -d ' ')"
assert_eq "artifact index mode" 600 "$(ctx_stat "$artifact_session/artifacts/index.md" | awk '{print $2}')"
printf '%s\n' '- artifacts/evidence.md — 1行要約' >>"$artifact_session/artifacts/index.md"
run_case ctx_artifacts_index_initialize "$artifact_session"
assert_success "artifact index initialization is idempotent"
assert_eq "artifact index keeps append format" '- artifacts/evidence.md — 1行要約' \
  "$(cat "$artifact_session/artifacts/index.md")"

for bad in 'line
break' '{{GOAL}}'; do
  fresh="$TEST_TMP/bad-$((TESTS + 1))"
  mkdir -m 700 "$fresh"
  run_case ctx_task_render "$fresh" "$bad" normal --constraint safe --plan-item work
  assert_failure_reason "bad goal rejected" "invalid task input"
done
long=$(printf '%0201d' 0)
fresh="$TEST_TMP/long"
mkdir -m 700 "$fresh"
run_case ctx_task_render "$fresh" "$long" normal --constraint safe --plan-item work
assert_failure_reason "long goal rejected" "invalid task input"

source_session="$TEST_TMP/source"
mkdir -m 700 "$source_session" "$source_session/errors"
printf '前回の要約です\n' >"$source_session/errors/summary.md"
chmod 600 "$source_session/errors/summary.md"
printf 'raw detail\n' >"$source_session/errors/raw.log"
chmod 600 "$source_session/errors/raw.log"
run_case ctx_previous_failure_summary "$source_session"
assert_success "restart summary read"
case "$(cat "$CASE_STDOUT")" in *'前回の要約です'*"$source_session/errors/raw.log"*) TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)) ;; *) test_fail "restart summary omits summary or raw path" ;; esac

printf 'failure detail\n## Goal\nsummary heading\n## Plan\n- [ ] summary item ← NOW\n' >"$source_session/errors/summary.md"
chmod 600 "$source_session/errors/summary.md"
run_case ctx_previous_failure_summary "$source_session"
assert_success "markdown restart summary read"
assert_eq "restart summary is folded to one line" 1 "$(wc -l <"$CASE_STDOUT" | tr -d ' ')"
case "$(cat "$CASE_STDOUT")" in *'failure detail ## Goal summary heading ## Plan - [ ] summary item ← NOW'*) TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)) ;; *) test_fail "restart summary was not folded safely" ;; esac
previous=$(cat "$CASE_STDOUT")
restart_session="$TEST_TMP/restart-session"
restart_cache="$TEST_TMP/restart-cache"
mkdir -m 700 "$restart_session" "$restart_cache"
run_case ctx_task_render "$restart_session" 'Restart goal' "$previous" \
  --constraint safe --plan-item 'Resume work'
assert_success "task with markdown restart summary rendered"
run_case env ARK_SESSION_DIR="$restart_session" ARK_CACHE_DIR="$restart_cache" \
  ARK_RECITE_INTERVAL=1 /bin/bash "$ROOT/ark/context/hooks/recite-todo.sh"
assert_success "restart task recitation succeeds"
assert_eq "restart task recites canonical goal and plan" 'Goal: Restart goal
NOW: Resume work
Remaining: 1' "$(cat "$CASE_STDOUT")"

for boundary in 1999 2000 2001; do
  dd if=/dev/zero bs=1 count="$boundary" 2>/dev/null | tr '\000' x >"$source_session/errors/summary.md"
  chmod 600 "$source_session/errors/summary.md"
  raw_before=$(cksum "$source_session/errors/raw.log")
  run_case ctx_previous_failure_summary "$source_session"
  assert_success "restart summary boundary $boundary"
  previous_output=$(cat "$CASE_STDOUT")
  previous_prefix=${previous_output%; raw log:*}
  expected_prefix=$boundary
  [ "$expected_prefix" -le 2000 ] || expected_prefix=2000
  assert_eq "restart prefix byte boundary $boundary" "$expected_prefix" "$(printf '%s' "$previous_prefix" | wc -c | tr -d ' ')"
  printf '%s' "$previous_prefix" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
  assert_eq "restart prefix UTF-8 boundary $boundary" 0 "$?"
  assert_eq "raw path appears once boundary $boundary" 1 "$(printf '%s' "$previous_output" | grep -oF "$source_session/errors/raw.log" | wc -l | tr -d ' ')"
  assert_eq "restart raw unchanged boundary $boundary" "$raw_before" "$(cksum "$source_session/errors/raw.log")"
done

dd if=/dev/zero bs=1 count=1999 2>/dev/null | tr '\000' x >"$source_session/errors/summary.md"
printf 'あ' >>"$source_session/errors/summary.md"
chmod 600 "$source_session/errors/summary.md"
run_case ctx_previous_failure_summary "$source_session"
assert_success "restart summary avoids split Japanese code point"
japanese_output=$(cat "$CASE_STDOUT")
japanese_prefix=${japanese_output%; raw log:*}
assert_eq "Japanese boundary falls back to valid prefix" 1999 "$(printf '%s' "$japanese_prefix" | wc -c | tr -d ' ')"
printf '%s' "$japanese_prefix" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
assert_eq "Japanese boundary remains UTF-8" 0 "$?"

printf 'safe summary\n' >"$source_session/errors/summary.md"; chmod 600 "$source_session/errors/summary.md"
chmod 644 "$source_session/errors/raw.log"
run_case ctx_previous_failure_summary "$source_session"
assert_failure_reason "unsafe restart raw mode rejected" "unsafe XDG file"
chmod 600 "$source_session/errors/raw.log"
raw_target="$TEST_TMP/raw-target"
printf 'target\n' >"$raw_target"
rm -f "$source_session/errors/raw.log"
ln -s "$raw_target" "$source_session/errors/raw.log"
run_case ctx_previous_failure_summary "$source_session"
assert_failure_reason "restart raw symlink rejected" "unsafe XDG file"
rm -f "$source_session/errors/raw.log"
run_case ctx_previous_failure_summary "$source_session"
assert_success "missing restart raw is allowed with predicted path"
case "$(cat "$CASE_STDOUT")" in *"$source_session/errors/raw.log") TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)) ;; *) test_fail "missing raw path was not predicted" ;; esac
chmod 755 "$source_session/errors"
run_case ctx_previous_failure_summary "$source_session"
assert_failure_reason "unsafe restart errors directory rejected" "unsafe XDG directory"
chmod 700 "$source_session/errors"

host="$TEST_TMP/host"
mkdir -m 700 "$host"
printf 'known failure\n' >"$host/failures.md"
chmod 600 "$host/failures.md"
run_case ctx_knowledge_initialize "$session" "$host"
assert_success "knowledge copied"
assert_eq "knowledge bytes" 'known failure' "$(cat "$session/knowledge/failures.md")"
assert_eq "knowledge mode" 600 "$(ctx_stat "$session/knowledge/failures.md" | awk '{print $2}')"

finish_tests task-template
