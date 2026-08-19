#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
HOOK="$ROOT/ark/loop/hooks/recite-todo.sh"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"
. "$ROOT/ark/loop/scripts/lib/runtime.sh"

mkdir -m 700 "$TEST_TMP/no-env"
run_case env -u ARK_SESSION_DIR -u ARK_CACHE_DIR /bin/bash "$HOOK"
assert_success "missing env is a successful no-op"
assert_eq "missing env stdout" '' "$(cat "$CASE_STDOUT")"
assert_eq "missing env stderr" '' "$(cat "$CASE_STDERR")"
assert_eq "missing env creates no file" '' "$(find "$TEST_TMP/no-env" -mindepth 1 -print)"

if ! /bin/sleep 0.005 2>/dev/null; then test_fail "supported platform lacks fractional sleep"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi

session="$TEST_TMP/session"
cache="$TEST_TMP/cache"
mkdir -m 700 "$session" "$cache"
write_task() {
  printf '%s\n' "$1" >"$session/task.md"
  chmod 600 "$session/task.md"
}
write_task '# Task

## Goal
Ship issue 333

## Constraints
- [ ] constraint checkbox

## Plan
- [x] finished
- [ ] current ← NOW
- [ ] later

## Artifacts
- fake ← NOW'

i=1
while [ "$i" -le 20 ]; do
  run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
  assert_success "batch $i exits zero"
  output=$(cat "$CASE_STDOUT")
  if [ "$i" -eq 10 ] || [ "$i" -eq 20 ]; then
    assert_eq "batch $i recites" 'Goal: Ship issue 333
NOW: current
Remaining: 2' "$output"
  else
    assert_eq "batch $i is quiet" '' "$output"
  fi
  i=$((i + 1))
done
assert_eq "step count reaches 20" 20 "$(cat "$cache/step_count")"
assert_eq "step count mode" 600 "$(loop_stat "$cache/step_count" | awk '{print $2}')"

printf 'corrupt\n' >"$cache/step_count"
chmod 600 "$cache/step_count"
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
assert_success "corrupt safe count does not block"
assert_eq "corrupt count regenerates at one" 1 "$(cat "$cache/step_count")"

rm -f "$cache/step_count"
ln -s "$ROOT/package.json" "$cache/step_count"
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
assert_success "count symlink does not block"
assert_eq "count symlink is unchanged" "$ROOT/package.json" "$(readlink "$cache/step_count")"
rm -f "$cache/step_count"

write_task '# Task

## Goal
Done goal

## Plan
- [x] first
- [x] last ← NOW

## Artifacts
- none'
printf '9\n' >"$cache/step_count"; chmod 600 "$cache/step_count"
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
assert_eq "all-complete recitation" 'Goal: Done goal
NOW: last
Remaining: 0' "$(cat "$CASE_STDOUT")"

for broken in '# Task
## Goal
one
two
## Plan
- [ ] work ← NOW' '# Task
## Goal
one
## Plan
- [ ] a ← NOW
- [ ] b ← NOW' '# Task
## Goal
one
## Plan
- [ ] no marker'; do
  write_task "$broken"
  printf '9\n' >"$cache/step_count"; chmod 600 "$cache/step_count"
  run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
  assert_success "broken task does not block"
  assert_eq "broken task emits no context" '' "$(cat "$CASE_STDOUT")"
  assert_eq "parse failure keeps increment" 10 "$(cat "$cache/step_count")"
done

long_goal=$(printf '目%.0s' $(seq 1 100))
long_now=$(printf '進%.0s' $(seq 1 180))
write_task "# Task

## Goal
$long_goal

## Plan
- [ ] $long_now ← NOW"
printf '9\n' >"$cache/step_count"; chmod 600 "$cache/step_count"
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
bytes=$(wc -c <"$CASE_STDOUT" | tr -d ' ')
[ "$bytes" -le 600 ] || test_fail "recitation exceeds 600 bytes"
iconv -f UTF-8 -t UTF-8 "$CASE_STDOUT" >/dev/null 2>&1 || test_fail "recitation is invalid UTF-8"
assert_eq "recitation has three lines" 3 "$(wc -l <"$CASE_STDOUT" | tr -d ' ')"

if grep -F '.claude/lib/state-io.sh' "$HOOK" >/dev/null 2>&1; then test_fail "hook sources state-io.sh"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi
if grep -E '\$(ARK_SESSION_DIR|ARK_CACHE_DIR|ARK_RECITE_INTERVAL)([^:{A-Za-z0-9_]|$)' "$HOOK" >/dev/null 2>&1; then test_fail "hook has unsafe env expansion"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi

# One batch remains one increment under contention; delivery attempts at 10 and 20 are not lost.
write_task '# Task

## Goal
Parallel

## Plan
- [ ] one ← NOW'
rm -f "$cache/step_count"
pids=
i=1
while [ "$i" -le 20 ]; do
  env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK" \
    >"$TEST_TMP/p-$i.out" 2>"$TEST_TMP/p-$i.err" &
  pids="$pids $!"
  i=$((i + 1))
done
for pid in $pids; do wait "$pid" || test_fail "parallel hook returned nonzero"; done
assert_eq "parallel count has no lost batch" 20 "$(cat "$cache/step_count")"
assert_eq "parallel lock failures" 0 "$(grep -l 'step_count lock unavailable' "$TEST_TMP"/p-*.err 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "parallel output attempts" 2 "$(grep -l '^Goal:' "$TEST_TMP"/p-*.out 2>/dev/null | wc -l | tr -d ' ')"

finish_tests recite-todo
