#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
INIT="$ROOT/ark/loop/scripts/session-init.sh"
TEARDOWN="$ROOT/ark/loop/scripts/session-teardown.sh"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"
. "$ROOT/ark/loop/scripts/lib/runtime.sh"

export HOME="$TEST_TMP/home"
export XDG_CONFIG_HOME="$TEST_TMP/config"
export XDG_DATA_HOME="$TEST_TMP/data"
export XDG_CACHE_HOME="$TEST_TMP/cache"
mkdir -m 700 "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

setup_repo() {
  repo="$TEST_TMP/$1"
  mkdir -m 700 "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.name fixture
  git -C "$repo" config user.email fixture@example.invalid
  mkdir -m 755 "$repo/.claude"
  printf '.claude/settings.local.json\n.claude/settings.local.json.ark-loop-tmp\n' >"$repo/.gitignore"
  git -C "$repo" add .gitignore
  git -C "$repo" commit -qm init
}

run_init() {
  /bin/bash "$INIT" --repo "$repo" --owner-pid "$$" --session-id "$1" \
    --goal 'Lifecycle goal' --constraint 'Preserve bytes' --plan-item 'Run lifecycle'
}

setup_repo lifecycle
settings="$repo/.claude/settings.local.json"
printf '{\n "before" : "日本語"\n}\n\n' >"$settings"; chmod 640 "$settings"
cp "$settings" "$TEST_TMP/lifecycle-original"
sid=11111111111111111111111111111111
run_case run_init "$sid"
assert_success "session init succeeds"
assert_eq "init enabled line" $'enabled\t1' "$(sed -n '1p' "$CASE_STDOUT")"
assert_eq "init output line count" 6 "$(wc -l <"$CASE_STDOUT" | tr -d ' ')"
assert_eq "init environment order" 'ARK_SESSION_ID ARK_SESSION_DIR ARK_CACHE_DIR ARK_RECITE_INTERVAL ARK_KNOWLEDGE_DIR' \
  "$(sed -n '2,6p' "$CASE_STDOUT" | cut -f1 | tr '\n' ' ' | sed 's/ $//')"
session_dir=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$CASE_STDOUT")
cache_dir=$(awk -F '\t' '$1=="ARK_CACHE_DIR"{print $2}' "$CASE_STDOUT")
[ -f "$session_dir/task.md" ] || test_fail "init did not create task.md"
jq -e '.permissions.deny == ["TodoWrite","TaskCreate","TaskUpdate"]' "$settings" >/dev/null 2>&1 || test_fail "init did not inject deny"
repo_key=$(loop_sha256 "$repo")
state="$XDG_DATA_HOME/ark/loop/repos/$repo_key"
assert_eq "owner marker mode" 600 "$(loop_stat "$state/owner" | awk '{print $2}')"
assert_eq "owner marker bytes" "$sid" "$(cut -f1 "$state/owner")"

seed_step_count "$cache_dir" 7
task_before=$(cat "$session_dir/task.md")
run_case run_init "$sid"
assert_success "same session re-init succeeds"
assert_eq "same session keeps task" "$task_before" "$(cat "$session_dir/task.md")"
assert_eq "same session keeps count" 7 "$(step_count "$cache_dir")"

cp "$settings" "$TEST_TMP/live-owner-settings"
run_case run_init 22222222222222222222222222222222
assert_success "live competing owner disables without process failure"
assert_eq "live owner disabled" $'enabled\t0' "$(sed -n '1p' "$CASE_STDOUT")"
cmp -s "$settings" "$TEST_TMP/live-owner-settings" || test_fail "live competitor changed settings"

run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$sid"
assert_success "teardown succeeds"
cmp -s "$settings" "$TEST_TMP/lifecycle-original" || test_fail "teardown did not byte-restore settings"
assert_eq "teardown restores mode" 640 "$(loop_stat "$settings" | awk '{print $2}')"
[ ! -e "$state/owner" ] || test_fail "teardown left owner"
[ ! -e "$state/settings.lock" ] || test_fail "teardown left lock"
[ ! -e "$repo/.claude/settings.local.json.ark-loop-tmp" ] || test_fail "teardown left tmp"
[ ! -e "$cache_dir/steps" ] || test_fail "teardown left recitation steps"

setup_repo restart-flow
old_sid=abababababababababababababababab
new_sid=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
run_case run_init "$old_sid"
assert_success "restart source session init succeeds"
old_session=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$CASE_STDOUT")
old_cache=$(awk -F '\t' '$1=="ARK_CACHE_DIR"{print $2}' "$CASE_STDOUT")
normalized_capture="$TEST_TMP/restart-capture.json"
cp "$ROOT/ark/loop/tests/fixtures/capture-interrupt.json" "$normalized_capture"
run_case env ARK_SESSION_DIR="$old_session" /bin/bash "$ROOT/ark/loop/hooks/capture-error.sh" <"$normalized_capture"
assert_success "restart source failure captured"
run_case env ARK_SESSION_DIR="$old_session" LOOP_CONFIG_FILE="$XDG_CONFIG_HOME/ark/loop/config.toml" \
  /bin/bash "$ROOT/ark/loop/scripts/summarize-errors.sh"
assert_success "restart source summary generated"
grep -E '^## ' "$old_session/errors/summary.md" >/dev/null 2>&1
assert_eq "generated summary has no level-two headings" 1 "$?"
old_raw_hash=$(cksum "$old_session/errors/raw.log")
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$old_sid"
assert_success "restart source teardown succeeds"
assert_eq "teardown retains raw" "$old_raw_hash" "$(cksum "$old_session/errors/raw.log")"
[ -f "$old_session/errors/summary.md" ] || test_fail "teardown removed summary"

run_case /bin/bash "$INIT" --repo "$repo" --owner-pid "$$" --session-id "$new_sid" --restart "$old_sid" \
  --goal 'Restart lifecycle goal' --constraint 'Preserve raw' --plan-item 'Resume safely'
assert_success "restart destination init succeeds"
assert_eq "restart destination enabled" $'enabled\t1' "$(sed -n '1p' "$CASE_STDOUT")"
new_session=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$CASE_STDOUT")
new_cache=$(awk -F '\t' '$1=="ARK_CACHE_DIR"{print $2}' "$CASE_STDOUT")
[ "$new_session" != "$old_session" ] || test_fail "restart reused old session directory"
grep -F 'Previous failure summary: Error summary (mechanical)' "$new_session/task.md" >/dev/null 2>&1 \
  || test_fail "restart task omits mechanical summary"
assert_eq "restart raw path appears once" 1 "$(grep -oF "$old_session/errors/raw.log" "$new_session/task.md" | wc -l | tr -d ' ')"
grep -F 'Interrupted by user' "$new_session/task.md" >/dev/null 2>&1
assert_eq "restart task excludes raw error body" 1 "$?"
assert_eq "restart cache starts at zero" 0 "$(step_count "$new_cache")"
assert_eq "restart preserves old raw" "$old_raw_hash" "$(cksum "$old_session/errors/raw.log")"
restart_task_before=$(cksum "$new_session/task.md")
run_case /bin/bash "$INIT" --repo "$repo" --owner-pid "$$" --session-id "$new_sid" --restart "$old_sid" \
  --goal changed --constraint changed --plan-item changed
assert_success "same restart session re-init succeeds"
assert_eq "same restart session keeps task" "$restart_task_before" "$(cksum "$new_session/task.md")"
run_case env ARK_SESSION_DIR="$new_session" ARK_CACHE_DIR="$new_cache" ARK_RECITE_INTERVAL=1 \
  /bin/bash "$ROOT/ark/loop/hooks/recite-todo.sh"
assert_success "restart destination recitation succeeds"
assert_eq "restart recitation uses destination goal" 'Goal: Restart lifecycle goal
NOW: Resume safely
Remaining: 1' "$(cat "$CASE_STDOUT")"
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$new_sid"
assert_success "restart destination teardown succeeds"

setup_repo missing-settings
sid=33333333333333333333333333333333
run_case run_init "$sid"
assert_success "missing settings init succeeds"
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$sid"
assert_success "missing settings teardown succeeds"
[ ! -e "$repo/.claude/settings.local.json" ] || test_fail "teardown retained originally missing settings"

setup_repo owner-write-failure
repo_key=$(loop_sha256 "$repo")
state="$XDG_DATA_HOME/ark/loop/repos/$repo_key"
fake_bin="$TEST_TMP/owner-write-failure-bin"
mkdir -m 700 "$fake_bin"
real_mv=$(command -v mv)
printf '%s\n' '#!/bin/sh' \
  'case "$2" in */owner) exit 1 ;; esac' \
  'exec "$ARK_TEST_REAL_MV" "$@"' >"$fake_bin/mv"
chmod 700 "$fake_bin/mv"
run_case env PATH="$fake_bin:$PATH" ARK_TEST_REAL_MV="$real_mv" /bin/bash "$INIT" \
  --repo "$repo" --owner-pid "$$" --session-id 99999999999999999999999999999999 \
  --goal goal --constraint safe --plan-item one
assert_success "owner publish failure disables without process failure"
assert_eq "owner publish failure is explicit" $'enabled\t0' "$(sed -n '1p' "$CASE_STDOUT")"
owner_new_exists=0; [ ! -e "$state/owner.new" ] || owner_new_exists=1
owner_exists=0; [ ! -e "$state/owner" ] || owner_exists=1
assert_eq "owner publish failure removes owner.new" 0 "$owner_new_exists"
assert_eq "owner publish failure does not publish owner" 0 "$owner_exists"

setup_repo concurrent
out1="$TEST_TMP/init-1.out"; out2="$TEST_TMP/init-2.out"
/bin/bash "$INIT" --repo "$repo" --owner-pid "$$" --session-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --goal goal --constraint safe --plan-item one >"$out1" 2>"$TEST_TMP/init-1.err" & p1=$!
/bin/bash "$INIT" --repo "$repo" --owner-pid "$$" --session-id bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --goal goal --constraint safe --plan-item one >"$out2" 2>"$TEST_TMP/init-2.err" & p2=$!
wait "$p1"; c1=$?; wait "$p2"; c2=$?
assert_eq "concurrent init process one" 0 "$c1"
assert_eq "concurrent init process two" 0 "$c2"
assert_eq "concurrent init has one winner" 1 "$(grep -l $'enabled\t1' "$out1" "$out2" | wc -l | tr -d ' ')"
assert_eq "concurrent init has one disabled" 1 "$(grep -l $'enabled\t0' "$out1" "$out2" | wc -l | tr -d ' ')"
winner=$(awk -F '\t' '$1=="ARK_SESSION_ID"{print $2}' "$out1" "$out2")
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$winner"
assert_success "concurrent winner teardown succeeds"

setup_repo orphan-chain
settings="$repo/.claude/settings.local.json"
printf '{"base":true}\n' >"$settings"; chmod 600 "$settings"
/bin/sleep 60 & owner1=$!
/bin/bash "$INIT" --repo "$repo" --owner-pid "$owner1" --session-id 44444444444444444444444444444444 \
  --goal goal --constraint safe --plan-item one >"$TEST_TMP/orphan-1.out" 2>"$TEST_TMP/orphan-1.err"
assert_eq "first orphan-chain init enabled" $'enabled\t1' "$(sed -n '1p' "$TEST_TMP/orphan-1.out")"
kill "$owner1"; wait "$owner1" 2>/dev/null || true
content=$(cat "$settings")
printf '%s\n' "${content%\}},\"user-kept\":1}" >"$settings"; chmod 600 "$settings"
/bin/sleep 60 & owner2=$!
/bin/bash "$INIT" --repo "$repo" --owner-pid "$owner2" --session-id 55555555555555555555555555555555 \
  --goal goal --constraint safe --plan-item two >"$TEST_TMP/orphan-2.out" 2>"$TEST_TMP/orphan-2.err"
assert_eq "first dead owner recovered" $'enabled\t1' "$(sed -n '1p' "$TEST_TMP/orphan-2.out")"
kill "$owner2"; wait "$owner2" 2>/dev/null || true
/bin/sleep 60 & owner3=$!
/bin/bash "$INIT" --repo "$repo" --owner-pid "$owner3" --session-id 66666666666666666666666666666666 \
  --goal goal --constraint safe --plan-item three >"$TEST_TMP/orphan-3.out" 2>"$TEST_TMP/orphan-3.err"
assert_eq "second dead owner recovered" $'enabled\t1' "$(sed -n '1p' "$TEST_TMP/orphan-3.out")"
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id 66666666666666666666666666666666
assert_success "orphan-chain teardown succeeds"
kill "$owner3"; wait "$owner3" 2>/dev/null || true
jq -e '.base == true and .["user-kept"] == 1 and (.permissions | not) and (.hooks | not)' "$settings" >/dev/null 2>&1 \
  || test_fail "orphan recovery lost non-Ark changes or retained Ark entries"

setup_repo independent-a
repo_a=$repo
setup_repo independent-b
repo_b=$repo
/bin/bash "$INIT" --repo "$repo_a" --owner-pid "$$" --session-id 77777777777777777777777777777777 \
  --goal goal --constraint safe --plan-item one >"$TEST_TMP/independent-a.out"
/bin/bash "$INIT" --repo "$repo_b" --owner-pid "$$" --session-id 88888888888888888888888888888888 \
  --goal goal --constraint safe --plan-item one >"$TEST_TMP/independent-b.out"
assert_eq "independent repo A enabled" $'enabled\t1' "$(sed -n '1p' "$TEST_TMP/independent-a.out")"
assert_eq "independent repo B enabled" $'enabled\t1' "$(sed -n '1p' "$TEST_TMP/independent-b.out")"
run_case /bin/bash "$TEARDOWN" --repo "$repo_a" --session-id 77777777777777777777777777777777
assert_success "independent repo A teardown"
run_case /bin/bash "$TEARDOWN" --repo "$repo_b" --session-id 88888888888888888888888888888888
assert_success "independent repo B teardown"

if grep -F '.gitignore' "$INIT" "$TEARDOWN" >/dev/null 2>&1; then test_fail "lifecycle script references .gitignore writes"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi

finish_tests session-lifecycle
