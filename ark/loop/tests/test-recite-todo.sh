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
assert_eq "step count reaches 20" 20 "$(step_count "$cache")"
assert_eq "steps mode" 700 "$(loop_stat "$cache/steps" | awk '{print $2}')"

seed_step_count "$cache" 0
printf 'corrupt\n' >"$cache/steps"
chmod 600 "$cache/steps"
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
assert_success "corrupt safe count does not block"
assert_eq "corrupt count regenerates at one" 1 "$(step_count "$cache")"

rm -rf "$cache/steps"
ln -s "$ROOT/package.json" "$cache/steps"
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
assert_success "count symlink does not block"
assert_eq "count symlink is unchanged" "$ROOT/package.json" "$(readlink "$cache/steps")"
rm -f "$cache/steps"

write_task '# Task

## Goal
Done goal

## Plan
- [x] first
- [x] last ← NOW

## Artifacts
- none'
seed_step_count "$cache" 9
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
  seed_step_count "$cache" 9
  run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
  assert_success "broken task does not block"
  assert_eq "broken task emits no context" '' "$(cat "$CASE_STDOUT")"
  assert_eq "parse failure keeps increment" 10 "$(step_count "$cache")"
done

printf '# Task\n\n## Goal\nbad\377\n\n## Plan\n- [ ] work ← NOW\n' >"$session/task.md"
chmod 600 "$session/task.md"
seed_step_count "$cache" 9
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
assert_success "invalid UTF-8 does not block"
assert_eq "invalid UTF-8 emits no context" '' "$(cat "$CASE_STDOUT")"
assert_eq "invalid UTF-8 still advances count" 10 "$(step_count "$cache")"

long_goal=
i=0
while [ "$i" -lt 100 ]; do long_goal="${long_goal}目"; i=$((i + 1)); done
long_now=
i=0
while [ "$i" -lt 180 ]; do long_now="${long_now}進"; i=$((i + 1)); done
write_task "# Task

## Goal
$long_goal

## Plan
- [ ] $long_now ← NOW"
seed_step_count "$cache" 9
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
bytes=$(wc -c <"$CASE_STDOUT" | tr -d ' ')
[ "$bytes" -le 600 ] || test_fail "recitation exceeds 600 bytes"
iconv -f UTF-8 -t UTF-8 "$CASE_STDOUT" >/dev/null 2>&1 || test_fail "recitation is invalid UTF-8"
assert_eq "recitation has three lines" 3 "$(wc -l <"$CASE_STDOUT" | tr -d ' ')"

if grep -F '.claude/lib/state-io.sh' "$HOOK" >/dev/null 2>&1; then test_fail "hook sources state-io.sh"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi
if grep -E '\$(ARK_SESSION_DIR|ARK_CACHE_DIR|ARK_RECITE_INTERVAL)([^:{A-Za-z0-9_]|$)' "$HOOK" >/dev/null 2>&1; then test_fail "hook has unsafe env expansion"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi
if grep -E 'step_count\.lock|/bin/sleep|flock' "$HOOK" >/dev/null 2>&1; then test_fail "hook retains lock or wait path"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi

seed_step_count "$cache" 9
run_case env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/zsh "$HOOK"
assert_success "zsh invocation exits zero"
assert_eq "zsh invocation increments" 10 "$(step_count "$cache")"
assert_eq "zsh invocation recites" 1 "$(grep -c '^Goal:' "$CASE_STDOUT" | tr -d ' ')"
assert_eq "zsh invocation stderr" '' "$(cat "$CASE_STDERR")"

bash_env="$TEST_TMP/bash-env"
nounset_out="$TEST_TMP/nounset.out"
printf '%s\n' "trap 'undefined_value=\$ARK_TEST_UNDEFINED; printf \"%s\\n\" \"\$-\" >\"\$NOUNSET_OUT\"' EXIT" >"$bash_env"
run_case env BASH_ENV="$bash_env" NOUNSET_OUT="$nounset_out" ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK"
assert_success "BASH_ENV EXIT trap preserves exit zero"
case "$(cat "$nounset_out")" in *u*) test_fail "hook leaked nounset to EXIT trap" ;; *) TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)) ;; esac

# One batch remains one increment under contention; delivery attempts at 10 and 20 are not lost.
write_task '# Task

## Goal
Parallel

## Plan
- [ ] one ← NOW'
seed_step_count "$cache" 0
pids=
i=1
while [ "$i" -le 20 ]; do
  env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK" \
    >"$TEST_TMP/p-$i.out" 2>"$TEST_TMP/p-$i.err" &
  pids="$pids $!"
  i=$((i + 1))
done
for pid in $pids; do wait "$pid" || test_fail "parallel hook returned nonzero"; done
assert_eq "parallel count has no lost batch" 20 "$(step_count "$cache")"
assert_eq "parallel lock failures" 0 "$(grep -l 'step_count lock unavailable' "$TEST_TMP"/p-*.err 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "parallel output attempts" 2 "$(grep -l '^Goal:' "$TEST_TMP"/p-*.out 2>/dev/null | wc -l | tr -d ' ')"

# Cross the 64-entry seal boundary under contention. Existing milestones make
# only 60 and 70 newly due, even while the active bucket is renamed and folded.
seed_step_count "$cache" 0
i=1
while [ "$i" -le 55 ]; do
  env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK" >/dev/null 2>&1
  i=$((i + 1))
done
pids=
i=1
while [ "$i" -le 20 ]; do
  env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10 /bin/bash "$HOOK" \
    >"$TEST_TMP/rollover-$i.out" 2>"$TEST_TMP/rollover-$i.err" &
  pids="$pids $!"
  i=$((i + 1))
done
for pid in $pids; do wait "$pid" || test_fail "rollover hook returned nonzero"; done
assert_eq "parallel rollover keeps every batch" 75 "$(step_count "$cache")"
assert_eq "parallel rollover output attempts" 2 "$(grep -l '^Goal:' "$TEST_TMP"/rollover-*.out 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "parallel rollover unexpected failures" 0 "$(grep -l 'unexpected failure' "$TEST_TMP"/rollover-*.err 2>/dev/null | wc -l | tr -d ' ')"

# Retiring full buckets keeps both batch entries and emission markers bounded.
seed_step_count "$cache" 0
i=1
while [ "$i" -le 70 ]; do
  env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=1 /bin/bash "$HOOK" >/dev/null 2>&1
  i=$((i + 1))
done
assert_eq "bounded buckets preserve count" 70 "$(step_count "$cache")"
entry_dirs=$(find "$cache/steps" -type d | wc -l | tr -d ' ')
[ "$entry_dirs" -le 130 ] || test_fail "step buckets grew beyond fixed bound"
TESTS=$((TESTS + 1)); [ "$entry_dirs" -le 130 ] && PASSES=$((PASSES + 1))

finish_tests recite-todo
