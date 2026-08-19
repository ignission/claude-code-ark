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

printf '7\n' >"$cache_dir/step_count"; chmod 600 "$cache_dir/step_count"
task_before=$(cat "$session_dir/task.md")
run_case run_init "$sid"
assert_success "same session re-init succeeds"
assert_eq "same session keeps task" "$task_before" "$(cat "$session_dir/task.md")"
assert_eq "same session keeps count" 7 "$(cat "$cache_dir/step_count")"

cp "$settings" "$TEST_TMP/live-owner-settings"
run_case run_init 22222222222222222222222222222222
assert_success "live competing owner disables without process failure"
assert_eq "live owner disabled" $'enabled\t0' "$(sed -n '1p' "$CASE_STDOUT")"
cmp -s "$settings" "$TEST_TMP/live-owner-settings" || test_fail "live competitor changed settings"

run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$sid"
assert_success "teardown succeeds"
cmp -s "$settings" "$TEST_TMP/lifecycle-original" || test_fail "teardown did not byte-restore settings"
assert_eq "teardown restores mode" 640 "$(loop_stat "$settings" | awk '{print $2}')"
repo_key=$(loop_sha256 "$repo")
state="$XDG_DATA_HOME/ark/loop/repos/$repo_key"
[ ! -e "$state/owner" ] || test_fail "teardown left owner"
[ ! -e "$state/settings.lock" ] || test_fail "teardown left lock"
[ ! -e "$repo/.claude/settings.local.json.ark-loop-tmp" ] || test_fail "teardown left tmp"

setup_repo missing-settings
sid=33333333333333333333333333333333
run_case run_init "$sid"
assert_success "missing settings init succeeds"
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$sid"
assert_success "missing settings teardown succeeds"
[ ! -e "$repo/.claude/settings.local.json" ] || test_fail "teardown retained originally missing settings"

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

finish_tests session-lifecycle
