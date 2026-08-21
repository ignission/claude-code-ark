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

template=$(cat "$ROOT/ark/context/templates/task-review.md.tmpl")
last=0
for token in '# Task' '## Goal' '{{GOAL}}' '## Constraints' '{{CONSTRAINTS}}' \
  'Context rules: {{CONTEXT_RULES}}' 'Previous failure summary: {{PREV_FAILURE_SUMMARY}}' \
  '## Plan' '{{REVIEW_PLAN_ITEMS}}' '## Artifacts'; do
  line=$(printf '%s\n' "$template" | grep -nF "$token" | head -1 | cut -d: -f1)
  if [ -z "$line" ] || [ "$line" -le "$last" ]; then
    test_fail "review template token order: $token"
  else
    TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1))
  fi
  last=${line:-$last}
done

sid_one=00000000000000000000000000000000
sid_two=00000000000000000000000000000001
run_case ctx_review_plan_items "$sid_one"
assert_success "first review order generated"
order_one=$(cat "$CASE_STDOUT")
run_case ctx_review_plan_items "$sid_one"
assert_success "same session review order generated again"
assert_eq "same session review order is stable" "$order_one" "$(cat "$CASE_STDOUT")"
if [ -n "$CTX_ZSH" ]; then
  run_case "$CTX_ZSH" -c '. "$1"; . "$2"; ctx_review_plan_items "$3"' review-zsh \
    "$ROOT/ark/context/scripts/lib/runtime.sh" "$ROOT/ark/context/scripts/lib/task-template.sh" "$sid_one"
  assert_success "review order works in zsh"
  assert_eq "zsh review order matches bash" "$order_one" "$(cat "$CASE_STDOUT")"
else
  printf '%s\n' 'SKIP: zsh is unavailable; review order zsh case skipped'
fi
run_case ctx_review_plan_items "$sid_two"
assert_success "consecutive review order generated"
order_two=$(cat "$CASE_STDOUT")
TESTS=$((TESTS + 1))
if [ "$order_one" != "$order_two" ]; then
  PASSES=$((PASSES + 1))
else
  test_fail "consecutive session review order did not rotate"
fi

assert_eq "review perspective count" 6 "$(printf '%s\n' "$order_one" | wc -l | tr -d ' ')"
for perspective in \
  'diff 全ファイルを通読する' \
  'artifacts/index.md の更新を含む規約遵守を検査する' \
  'artifact 本文と artifacts/index.md の整合を検査する' \
  'エラー握りつぶしがないことを検査する' \
  'Goal からの逸脱がないことを検査する' \
  '再発性のある指摘を failures-inbox.md 候補にする'; do
  assert_eq "review perspective retained: $perspective" 1 \
    "$(printf '%s\n' "$order_one" | grep -Fxc -- "$perspective")"
done

review_session="$TEST_TMP/review-session"
review_cache="$TEST_TMP/review-cache"
mkdir -m 700 "$review_session" "$review_cache"
run_case ctx_task_render_review "$review_session" "$sid_one" 'Review the implementation' \
  'なし（通常起動）' --constraint '観点を削らない'
assert_success "review task rendered"
assert_eq "review task has all checklist items" 6 \
  "$(grep -c '^- \[ \] ' "$review_session/task.md")"
assert_eq "review task has one NOW" 1 "$(grep -Fc ' ← NOW' "$review_session/task.md")"
first_perspective=$(printf '%s\n' "$order_one" | sed -n '1p')
grep -Fx -- "- [ ] $first_perspective ← NOW" "$review_session/task.md" >/dev/null 2>&1
assert_eq "review task uses seeded first perspective" 0 "$?"

run_case env ARK_SESSION_DIR="$review_session" ARK_CACHE_DIR="$review_cache" \
  ARK_RECITE_INTERVAL=1 /bin/bash "$ROOT/ark/context/hooks/recite-todo.sh"
assert_success "review task recitation succeeds"
assert_eq "review recitation keeps three-line contract" "Goal: Review the implementation
NOW: $first_perspective
Remaining: 6" "$(cat "$CASE_STDOUT")"

finish_tests review-template
