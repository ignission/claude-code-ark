#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
HANDOFF_LIB="$ROOT/ark/context/scripts/lib/handoff.sh"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"
. "$ROOT/ark/context/scripts/lib/runtime.sh"

if [ ! -f "$HANDOFF_LIB" ]; then
  TESTS=$((TESTS + 1))
  test_fail "handoff.sh exists"
  finish_tests "handoff tests"
fi
. "$HANDOFF_LIB"

export HOME="$TEST_TMP/home"
export XDG_CONFIG_HOME="$TEST_TMP/config"
export XDG_DATA_HOME="$TEST_TMP/data"
export XDG_CACHE_HOME="$TEST_TMP/cache"
mkdir -m 700 "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

repo="$TEST_TMP/repo"
mkdir -m 700 "$repo"
git -C "$repo" init -q
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.invalid
git -C "$repo" checkout -qb feature/issue-336/loop-teardown-handoff

sid=33633633633633633633633633633633
session="$XDG_DATA_HOME/ark/context/sessions/$sid"
cache="$XDG_CACHE_HOME/ark/context/$sid"
mkdir -m 700 "$XDG_DATA_HOME/ark" "$XDG_DATA_HOME/ark/context" "$XDG_DATA_HOME/ark/context/sessions" \
  "$XDG_CACHE_HOME/ark" "$XDG_CACHE_HOME/ark/context" \
  "$session" "$session/artifacts" "$session/errors" "$cache"
{
  printf '%s\n' '# Task' '' '## Goal' 'Complete issue 336 safely' '' '## Constraints' '- Preserve settings' \
    '' '## Plan' '- [x] Read contracts' '- [X] Add Red fixtures' \
    '- [ ] Implement handoff ← NOW' '- [ ] Integrate lifecycle' \
    '' '## Artifacts' '- artifacts/design.md — Design evidence' '- artifacts/test.log — Test evidence'
} >"$session/task.md"
chmod 600 "$session/task.md"
{
  printf '%s\n' '# Artifact Index' '' '- artifacts/design.md — Design evidence' '- artifacts/test.log — Test evidence'
} >"$session/artifacts/index.md"
printf '%s\n' 'SECRET ARTIFACT BODY' >"$session/artifacts/design.md"
printf '%s\n' 'Error summary (mechanical)' '- tool: Bash' '  error_type: nonzero_exit' \
  '  count: 1' '  first_line: 2' '  last_line: 2' '  詳細: errors/raw.log:L2-L2' >"$session/errors/summary.md"
printf '%s\n' 'RAW SECRET ERROR' >"$session/errors/raw.log"
printf '%s\n' '{"phase":"secret-control-plane"}' >"$session/flow-progress-secret.json"
chmod 600 "$session/artifacts/index.md" "$session/artifacts/design.md" "$session/errors/summary.md" \
  "$session/errors/raw.log" "$session/flow-progress-secret.json"

expected="$TEST_TMP/handoff.expected"
{
  printf '%s\n' '# Handoff'
  printf '%s\n' 'Goal: Complete issue 336 safely'
  printf '%s\n' 'Completed Plan:' '- [x] Read contracts' '- [X] Add Red fixtures'
  printf '%s\n' 'Pending Plan:' '- [ ] Implement handoff ← NOW' '- [ ] Integrate lifecycle'
  printf '%s\n' 'Current NOW: Implement handoff'
  printf '%s\n' 'Artifacts:' '- artifacts/design.md — Design evidence' '- artifacts/test.log — Test evidence'
  printf '%s\n' "Latest error summary: $session/errors/summary.md"
  printf '%s\n' 'Next minimum action: Implement handoff'
  printf '%s\n' 'WORK_ID: issue-336'
  printf '%s\n' "Session ID: $sid"
} >"$expected"

recite() {
  env ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=1 \
    /bin/bash "$ROOT/ark/context/hooks/recite-todo.sh"
}
run_case recite
assert_success "baseline recitation succeeds"
recitation_before=$(cat "$CASE_STDOUT")

run_case ctx_handoff_write "$session" "$repo" "$sid"
assert_success "handoff write succeeds"
cmp -s "$expected" "$session/handoff.md" || {
  CASE_STDOUT="$session/handoff.md"
  CASE_STDERR="$expected"
  test_fail "handoff bytes match the fixed format"
}
assert_eq "handoff mode" 600 "$(ctx_stat "$session/handoff.md" | awk '{print $2}')"
assert_eq "handoff has no level-two headings" 0 "$(grep -Ec '^## ' "$session/handoff.md")"
grep -F 'SECRET ARTIFACT BODY' "$session/handoff.md" >/dev/null 2>&1
assert_eq "handoff excludes artifact bodies" 1 "$?"
grep -F 'RAW SECRET ERROR' "$session/handoff.md" >/dev/null 2>&1
assert_eq "handoff excludes raw errors" 1 "$?"
grep -F 'secret-control-plane' "$session/handoff.md" >/dev/null 2>&1
assert_eq "handoff excludes flow JSON" 1 "$?"

first_checksum=$(cksum "$session/handoff.md")
run_case ctx_handoff_write "$session" "$repo" "$sid"
assert_success "second handoff write succeeds"
assert_eq "handoff is deterministic" "$first_checksum" "$(cksum "$session/handoff.md")"
[ ! -e "$session/handoff.md.new" ] || test_fail "handoff left .new"

run_case recite
assert_success "recitation after handoff succeeds"
assert_eq "handoff does not alter Goal NOW Remaining recitation" "$recitation_before" "$(cat "$CASE_STDOUT")"

# A handoff is untrusted output and must never become a task section boundary.
printf '%s\n' '# Handoff' 'Goal: ignored' 'Artifacts:' '- fake — ## Goal' >"$session/handoff.md"
chmod 600 "$session/handoff.md"
run_case recite
assert_success "recitation ignores untrusted handoff"
assert_eq "untrusted handoff cannot change recitation" "$recitation_before" "$(cat "$CASE_STDOUT")"

# Completed plans keep exactly one NOW marker but have no pending action.
complete="$XDG_DATA_HOME/ark/context/sessions/77777777777777777777777777777777"
mkdir -m 700 "$complete" "$complete/artifacts" "$complete/errors"
{
  printf '%s\n' '# Task' '' '## Goal' 'Done goal' '' '## Plan' '- [x] First' '- [X] Final ← NOW' '' '## Artifacts' '- (none)'
} >"$complete/task.md"
chmod 600 "$complete/task.md"
run_case ctx_handoff_write "$complete" "$repo" 77777777777777777777777777777777
assert_success "completed Plan handoff succeeds"
grep -F 'Pending Plan: なし（Plan 完了）' "$complete/handoff.md" >/dev/null 2>&1 \
  || test_fail "completed handoff lacks fixed pending value"
grep -F 'Current NOW: なし（Plan 完了）' "$complete/handoff.md" >/dev/null 2>&1 \
  || test_fail "completed handoff lacks fixed NOW value"
grep -F 'Artifacts: なし' "$complete/handoff.md" >/dev/null 2>&1 \
  || test_fail "missing artifact index lacks fixed value"
grep -F 'Latest error summary: なし' "$complete/handoff.md" >/dev/null 2>&1 \
  || test_fail "missing summary lacks fixed value"
grep -F 'Next minimum action: なし（Plan 完了）' "$complete/handoff.md" >/dev/null 2>&1 \
  || test_fail "completed handoff lacks fixed next action"

assert_unchanged_on_failure() {
  label=$1
  target_session=$2
  target_repo=$3
  target_sid=$4
  before=$(cksum "$target_session/handoff.md")
  run_case ctx_handoff_write "$target_session" "$target_repo" "$target_sid"
  assert_eq "$label fails closed" 1 "$CASE_STATUS"
  assert_eq "$label preserves existing handoff" "$before" "$(cksum "$target_session/handoff.md")"
  [ ! -e "$target_session/handoff.md.new" ] || test_fail "$label left .new"
}

# Each invalid fixture starts from a valid completed session and an existing handoff.
invalid_session() {
  invalid_name=$1
  invalid="$XDG_DATA_HOME/ark/context/sessions/$invalid_name"
  mkdir -m 700 "$invalid" "$invalid/artifacts" "$invalid/errors"
  {
    printf '%s\n' '# Task' '' '## Goal' 'Safe goal' '' '## Plan' '- [ ] Safe item ← NOW' '' '## Artifacts' '- (none)'
  } >"$invalid/task.md"
  printf '%s\n' 'existing handoff bytes' >"$invalid/handoff.md"
  chmod 600 "$invalid/task.md" "$invalid/handoff.md"
}

invalid_session 88888888888888888888888888888888
chmod 755 "$invalid"
assert_unchanged_on_failure "unsafe session mode" "$invalid" "$repo" 88888888888888888888888888888888

invalid_session 99999999999999999999999999999999
chmod 644 "$invalid/task.md"
assert_unchanged_on_failure "unsafe task mode" "$invalid" "$repo" 99999999999999999999999999999999

invalid_session aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
command rm -f "$invalid/task.md"
ln -s "$session/task.md" "$invalid/task.md"
assert_unchanged_on_failure "symlink task" "$invalid" "$repo" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

invalid_session bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
tab=$(printf '\t')
sed "s/Safe goal/Safe${tab}goal/" "$invalid/task.md" >"$invalid/task.md.changed"
chmod 600 "$invalid/task.md.changed"
command mv "$invalid/task.md.changed" "$invalid/task.md"
assert_unchanged_on_failure "control character" "$invalid" "$repo" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

invalid_session cccccccccccccccccccccccccccccccc
sed '/Safe item/a\
- [ ] Second ← NOW' "$invalid/task.md" >"$invalid/task.md.changed"
chmod 600 "$invalid/task.md.changed"
command mv "$invalid/task.md.changed" "$invalid/task.md"
assert_unchanged_on_failure "multiple NOW markers" "$invalid" "$repo" cccccccccccccccccccccccccccccccc

invalid_session dddddddddddddddddddddddddddddddd
sed '/## Goal/a\
- [ ] Outside checkbox' "$invalid/task.md" >"$invalid/task.md.changed"
chmod 600 "$invalid/task.md.changed"
command mv "$invalid/task.md.changed" "$invalid/task.md"
assert_unchanged_on_failure "checkbox outside Plan" "$invalid" "$repo" dddddddddddddddddddddddddddddddd

invalid_session eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
printf '%s\n' '- artifacts/file — evidence' >"$invalid/artifacts/index.md"
chmod 644 "$invalid/artifacts/index.md"
assert_unchanged_on_failure "unsafe artifact index" "$invalid" "$repo" eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee

invalid_session ffffffffffffffffffffffffffffffff
printf '%s\n' 'Error summary (mechanical)' '- なし' >"$invalid/errors/summary.md"
chmod 644 "$invalid/errors/summary.md"
assert_unchanged_on_failure "unsafe summary" "$invalid" "$repo" ffffffffffffffffffffffffffffffff

finish_tests "handoff tests"
