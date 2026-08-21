#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
INIT="$ROOT/ark/context/scripts/session-init.sh"
TEARDOWN="$ROOT/ark/context/scripts/session-teardown.sh"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"
. "$ROOT/ark/context/scripts/lib/runtime.sh"

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
  printf '.claude/settings.local.json\n.claude/settings.local.json.ark-context-tmp\n' >"$repo/.gitignore"
  git -C "$repo" add .gitignore
  git -C "$repo" commit -qm init
}

run_init() {
  /bin/bash "$INIT" --repo "$repo" --owner-pid "$$" --session-id "$1" \
    --goal 'Lifecycle goal' --constraint 'Preserve bytes' --plan-item 'Run lifecycle'
}

prepare_lifecycle_output() {
  output_session=$1
  output_cache=$2
  mkdir -p "$output_session/artifacts" "$output_session/errors"
  chmod 700 "$output_session/artifacts" "$output_session/errors"
  printf '%s\n' '- artifacts/lifecycle.txt — Lifecycle evidence' >"$output_session/artifacts/index.md"
  printf '%s\n' 'artifact body must not enter handoff' >"$output_session/artifacts/lifecycle.txt"
  printf '%s\n' \
    '{"at":"2026-08-21T00:00:00Z","tool":"Bash","error_type":"nonzero_exit","exit_code":7,"is_interrupt":false,"error":"raw lifecycle secret","details":{}}' \
    >"$output_session/errors/raw.log"
  : >"$output_session/stop_once"
  chmod 600 "$output_session/artifacts/index.md" "$output_session/artifacts/lifecycle.txt" \
    "$output_session/errors/raw.log" "$output_session/stop_once"
  seed_step_count "$output_cache" 7
}

setup_repo invalid-owner-pid
invalid_owner_sid=09090909090909090909090909090909
run_case /bin/bash "$INIT" --repo "$repo" --owner-pid 0 --session-id "$invalid_owner_sid"
assert_success "PID zero input disables without process failure"
assert_eq "PID zero input is rejected" $'enabled\t0' "$(sed -n '1p' "$CASE_STDOUT")"
assert_eq "PID zero input reports invalid owner PID" $'reason\tinvalid owner pid' "$(sed -n '2p' "$CASE_STDOUT")"

setup_repo invalid-owner-marker
invalid_marker_sid=08080808080808080808080808080808
repo_key=$(ctx_sha256 "$repo")
invalid_marker_state="$XDG_DATA_HOME/ark/context/repos/$repo_key"
mkdir -p "$invalid_marker_state"
chmod 700 "$XDG_DATA_HOME/ark" "$XDG_DATA_HOME/ark/context" \
  "$XDG_DATA_HOME/ark/context/repos" "$invalid_marker_state"
printf '%s\t0\n' "$invalid_marker_sid" >"$invalid_marker_state/owner"
chmod 600 "$invalid_marker_state/owner"
cp "$invalid_marker_state/owner" "$TEST_TMP/invalid-owner-marker-original"
invalid_marker_mode=$(ctx_stat "$invalid_marker_state/owner" | awk '{print $2}')
run_case /bin/bash "$INIT" --repo "$repo" --owner-pid "$$" \
  --session-id 07070707070707070707070707070707
assert_success "PID zero owner marker disables without process failure"
assert_eq "PID zero owner marker is rejected" $'enabled\t0' "$(sed -n '1p' "$CASE_STDOUT")"
assert_eq "PID zero owner marker is not treated as live" $'reason\tinvalid owner marker' \
  "$(sed -n '2p' "$CASE_STDOUT")"
cmp -s "$invalid_marker_state/owner" "$TEST_TMP/invalid-owner-marker-original" \
  || test_fail "invalid owner marker content changed"
assert_eq "invalid owner marker mode is preserved" "$invalid_marker_mode" \
  "$(ctx_stat "$invalid_marker_state/owner" | awk '{print $2}')"
[ ! -e "$repo/.claude/settings.local.json" ] || test_fail "invalid owner marker changed settings"

setup_repo lifecycle
settings="$repo/.claude/settings.local.json"
printf '{\n "before" : "日本語"\n}\n\n' >"$settings"; chmod 640 "$settings"
cp "$settings" "$TEST_TMP/lifecycle-original"
sid=11111111111111111111111111111111
run_case run_init "$sid"
assert_success "session init succeeds"
assert_eq "init enabled line" $'enabled\t1' "$(sed -n '1p' "$CASE_STDOUT")"
assert_eq "init output line count" 7 "$(wc -l <"$CASE_STDOUT" | tr -d ' ')"
assert_eq "init environment order" 'ARK_SESSION_ID ARK_SESSION_DIR ARK_CACHE_DIR ARK_RECITE_INTERVAL ARK_KNOWLEDGE_DIR ARK_REPO_KEY' \
  "$(sed -n '2,7p' "$CASE_STDOUT" | cut -f1 | tr '\n' ' ' | sed 's/ $//')"
session_dir=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$CASE_STDOUT")
cache_dir=$(awk -F '\t' '$1=="ARK_CACHE_DIR"{print $2}' "$CASE_STDOUT")
[ -f "$session_dir/task.md" ] || test_fail "init did not create task.md"
jq -e '.permissions.deny == ["TodoWrite","TaskCreate","TaskUpdate"]' "$settings" >/dev/null 2>&1 || test_fail "init did not inject deny"
repo_key=$(ctx_sha256 "$repo")
state="$XDG_DATA_HOME/ark/context/repos/$repo_key"
assert_eq "owner marker mode" 600 "$(ctx_stat "$state/owner" | awk '{print $2}')"
assert_eq "owner marker bytes" "$sid" "$(cut -f1 "$state/owner")"

run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$sid"
assert_success "populated task teardown before empty scaffold case"
empty_sid=10101010101010101010101010101010
run_case /bin/bash "$INIT" --repo "$repo" --owner-pid "$$" --session-id "$empty_sid"
assert_success "session init accepts omitted task arguments"
assert_eq "empty task init enabled" $'enabled\t1' "$(sed -n '1p' "$CASE_STDOUT")"
empty_session_dir=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$CASE_STDOUT")
grep -F '← NOW' "$empty_session_dir/task.md" >/dev/null 2>&1
assert_eq "empty task has no NOW marker" 1 "$?"
assert_eq "empty Goal body" '' "$(sed -n '/^## Goal$/,/^## Constraints$/p' "$empty_session_dir/task.md" | sed '1d;$d' | tr -d '\n')"
assert_eq "empty Constraints body" 'Previous failure summary: なし（通常起動）' \
  "$(sed -n '/^## Constraints$/,/^## Plan$/p' "$empty_session_dir/task.md" | sed '1d;$d' | sed '/^$/d')"
assert_eq "empty Plan body" '' "$(sed -n '/^## Plan$/,/^## Artifacts$/p' "$empty_session_dir/task.md" | sed '1d;$d' | tr -d '\n')"
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$empty_sid"
assert_success "empty task teardown succeeds"

run_case run_init "$sid"
assert_success "populated task can initialize after empty scaffold case"
session_dir=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$CASE_STDOUT")
cache_dir=$(awk -F '\t' '$1=="ARK_CACHE_DIR"{print $2}' "$CASE_STDOUT")

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

prepare_lifecycle_output "$session_dir" "$cache_dir"
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$sid"
assert_success "teardown succeeds"
cmp -s "$settings" "$TEST_TMP/lifecycle-original" || test_fail "teardown did not byte-restore settings"
assert_eq "teardown restores mode" 640 "$(ctx_stat "$settings" | awk '{print $2}')"
[ ! -e "$state/owner" ] || test_fail "teardown left owner"
[ ! -e "$state/settings.lock" ] || test_fail "teardown left lock"
[ ! -e "$repo/.claude/settings.local.json.ark-context-tmp" ] || test_fail "teardown left tmp"
[ ! -e "$cache_dir/steps" ] || test_fail "teardown left recitation steps"
[ ! -e "$session_dir/stop_once" ] || test_fail "teardown left stop_once"
[ -f "$session_dir/errors/summary.md" ] || test_fail "teardown did not generate summary"
[ -f "$session_dir/handoff.md" ] || test_fail "teardown did not generate handoff"
grep -F 'Goal: Lifecycle goal' "$session_dir/handoff.md" >/dev/null 2>&1 \
  || test_fail "teardown handoff lacks Goal"
grep -F 'Current NOW: Run lifecycle' "$session_dir/handoff.md" >/dev/null 2>&1 \
  || test_fail "teardown handoff lacks NOW"
grep -F 'artifact body must not enter handoff' "$session_dir/handoff.md" >/dev/null 2>&1
assert_eq "teardown handoff excludes artifact body" 1 "$?"
knowledge="$XDG_DATA_HOME/ark/context/knowledge"
inbox="$knowledge/failures-inbox.md"
assert_eq "teardown appends one inbox marker" 1 \
  "$(grep -Fc -- "- Session ID: $sid" "$inbox" 2>/dev/null)"
[ ! -e "$knowledge/failures-inbox.lock" ] || test_fail "teardown left knowledge lock"

handoff_once=$(cksum "$session_dir/handoff.md")
inbox_once=$(cksum "$inbox")
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$sid"
assert_success "second teardown succeeds"
assert_eq "second teardown keeps deterministic handoff" "$handoff_once" "$(cksum "$session_dir/handoff.md")"
assert_eq "second teardown deduplicates inbox" "$inbox_once" "$(cksum "$inbox")"
[ ! -e "$state/owner" ] || test_fail "second teardown recreated owner"
[ ! -e "$state/settings.lock" ] || test_fail "second teardown left settings lock"
[ ! -e "$knowledge/failures-inbox.lock" ] || test_fail "second teardown left knowledge lock"

setup_repo teardown-restore-failure
restore_fail_sid=12121212121212121212121212121212
run_case run_init "$restore_fail_sid"
assert_success "restore-failure init succeeds"
restore_fail_session=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$CASE_STDOUT")
restore_fail_cache=$(awk -F '\t' '$1=="ARK_CACHE_DIR"{print $2}' "$CASE_STDOUT")
restore_fail_settings="$repo/.claude/settings.local.json"
restore_fail_key=$(ctx_sha256 "$repo")
restore_fail_state="$XDG_DATA_HOME/ark/context/repos/$restore_fail_key"
prepare_lifecycle_output "$restore_fail_session" "$restore_fail_cache"
chmod 644 "$restore_fail_state/settings-ownership.json"
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$restore_fail_sid"
assert_success "restore-failure teardown remains best effort"
[ -f "$restore_fail_session/errors/summary.md" ] || test_fail "restore failure skipped summary"
[ -f "$restore_fail_session/handoff.md" ] || test_fail "restore failure skipped handoff"
assert_eq "restore failure still appends inbox" 1 \
  "$(grep -Fc -- "- Session ID: $restore_fail_sid" "$inbox" 2>/dev/null)"
[ -e "$restore_fail_state/owner" ] || test_fail "restore failure removed owner"
jq -e '.permissions.deny | index("TodoWrite") != null' "$restore_fail_settings" >/dev/null 2>&1 \
  || test_fail "restore failure removed Ark settings"
[ ! -e "$restore_fail_session/stop_once" ] || test_fail "restore failure left stop_once"
[ ! -e "$restore_fail_cache/steps" ] || test_fail "restore failure left steps"
[ ! -e "$restore_fail_state/settings.lock" ] || test_fail "restore failure left settings lock"
[ ! -e "$knowledge/failures-inbox.lock" ] || test_fail "restore failure left knowledge lock"

setup_repo restart-flow
old_sid=abababababababababababababababab
new_sid=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
run_case run_init "$old_sid"
assert_success "restart source session init succeeds"
old_session=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$CASE_STDOUT")
old_cache=$(awk -F '\t' '$1=="ARK_CACHE_DIR"{print $2}' "$CASE_STDOUT")
normalized_capture="$TEST_TMP/restart-capture.json"
cp "$ROOT/ark/context/tests/fixtures/capture-interrupt.json" "$normalized_capture"
run_case env ARK_SESSION_DIR="$old_session" /bin/bash "$ROOT/ark/context/hooks/capture-error.sh" <"$normalized_capture"
assert_success "restart source failure captured"
run_case env ARK_SESSION_DIR="$old_session" CTX_CONFIG_FILE="$XDG_CONFIG_HOME/ark/context/config.toml" \
  /bin/bash "$ROOT/ark/context/scripts/summarize-errors.sh"
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
  /bin/bash "$ROOT/ark/context/hooks/recite-todo.sh"
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
[ -f "$repo/.claude/settings.local.json" ] || test_fail "missing settings init did not create settings"
repo_key=$(ctx_sha256 "$repo")
state="$XDG_DATA_HOME/ark/context/repos/$repo_key"
[ -f "$state/settings-ownership.json" ] || test_fail "missing settings init did not create manifest"
command rm -f "$repo/.claude/settings.local.json"
run_case run_init "$sid"
assert_success "same session repairs manifest without settings"
assert_eq "repaired same session remains enabled" $'enabled\t1' "$(sed -n '1p' "$CASE_STDOUT")"
jq -e '.hooks.PostToolBatch | length == 1' "$repo/.claude/settings.local.json" >/dev/null 2>&1 \
  || test_fail "same session reported enabled without repairing settings"
run_case /bin/bash "$TEARDOWN" --repo "$repo" --session-id "$sid"
assert_success "missing settings teardown succeeds"
[ ! -e "$repo/.claude/settings.local.json" ] || test_fail "teardown retained originally missing settings"

setup_repo owner-write-failure
repo_key=$(ctx_sha256 "$repo")
state="$XDG_DATA_HOME/ark/context/repos/$repo_key"
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
knowledge="$XDG_DATA_HOME/ark/context/knowledge"
printf '%s\n' '# Human curated knowledge' '- never distribute inbox candidates' >"$knowledge/failures.md"
chmod 600 "$knowledge/failures.md"
curated_hash=$(cksum "$knowledge/failures.md")
/bin/sleep 60 & owner1=$!
/bin/bash "$INIT" --repo "$repo" --owner-pid "$owner1" --session-id 44444444444444444444444444444444 \
  --goal goal --constraint safe --plan-item one >"$TEST_TMP/orphan-1.out" 2>"$TEST_TMP/orphan-1.err"
assert_eq "first orphan-chain init enabled" $'enabled\t1' "$(sed -n '1p' "$TEST_TMP/orphan-1.out")"
orphan1_session=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$TEST_TMP/orphan-1.out")
orphan1_cache=$(awk -F '\t' '$1=="ARK_CACHE_DIR"{print $2}' "$TEST_TMP/orphan-1.out")
prepare_lifecycle_output "$orphan1_session" "$orphan1_cache"
kill "$owner1"; wait "$owner1" 2>/dev/null || true
content=$(cat "$settings")
printf '%s\n' "${content%\}},\"user-kept\":1}" >"$settings"; chmod 600 "$settings"
/bin/sleep 60 & owner2=$!
/bin/bash "$INIT" --repo "$repo" --owner-pid "$owner2" --session-id 55555555555555555555555555555555 \
  --goal goal --constraint safe --plan-item two >"$TEST_TMP/orphan-2.out" 2>"$TEST_TMP/orphan-2.err"
assert_eq "first dead owner recovered" $'enabled\t1' "$(sed -n '1p' "$TEST_TMP/orphan-2.out")"
[ -f "$orphan1_session/errors/summary.md" ] || test_fail "first dead owner recovery skipped summary"
[ -f "$orphan1_session/handoff.md" ] || test_fail "first dead owner recovery skipped handoff"
[ ! -e "$orphan1_session/stop_once" ] || test_fail "first dead owner recovery left stop_once"
[ ! -e "$orphan1_cache/steps" ] || test_fail "first dead owner recovery left steps"
assert_eq "first dead owner inbox marker is unique" 1 \
  "$(grep -Fc -- '- Session ID: 44444444444444444444444444444444' "$knowledge/failures-inbox.md")"
orphan2_session=$(awk -F '\t' '$1=="ARK_SESSION_DIR"{print $2}' "$TEST_TMP/orphan-2.out")
orphan2_cache=$(awk -F '\t' '$1=="ARK_CACHE_DIR"{print $2}' "$TEST_TMP/orphan-2.out")
cmp -s "$knowledge/failures.md" "$orphan2_session/knowledge/failures.md" \
  || test_fail "new session knowledge was not copied from curated source"
grep -F 'ark-context-candidate:' "$orphan2_session/knowledge/failures.md" >/dev/null 2>&1
assert_eq "new session knowledge excludes inbox" 1 "$?"
prepare_lifecycle_output "$orphan2_session" "$orphan2_cache"
settings_after_first_recovery=$(cksum "$settings")
kill "$owner2"; wait "$owner2" 2>/dev/null || true
/bin/sleep 60 & owner3=$!
/bin/bash "$INIT" --repo "$repo" --owner-pid "$owner3" --session-id 66666666666666666666666666666666 \
  --goal goal --constraint safe --plan-item three >"$TEST_TMP/orphan-3.out" 2>"$TEST_TMP/orphan-3.err"
assert_eq "second dead owner recovered" $'enabled\t1' "$(sed -n '1p' "$TEST_TMP/orphan-3.out")"
[ -f "$orphan2_session/errors/summary.md" ] || test_fail "second dead owner recovery skipped summary"
[ -f "$orphan2_session/handoff.md" ] || test_fail "second dead owner recovery skipped handoff"
[ ! -e "$orphan2_session/stop_once" ] || test_fail "second dead owner recovery left stop_once"
[ ! -e "$orphan2_cache/steps" ] || test_fail "second dead owner recovery left steps"
assert_eq "second dead owner inbox marker is unique" 1 \
  "$(grep -Fc -- '- Session ID: 55555555555555555555555555555555' "$knowledge/failures-inbox.md")"
assert_eq "consecutive recovery settings bytes converge" "$settings_after_first_recovery" "$(cksum "$settings")"
assert_eq "orphan recovery preserves curated host bytes" "$curated_hash" "$(cksum "$knowledge/failures.md")"
[ ! -e "$knowledge/failures-inbox.lock" ] || test_fail "orphan recovery left knowledge lock"
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

failure_wrapper="$ROOT/ark/context/adapters/claude-code/post-tool-use-failure.sh"
batch_wrapper="$ROOT/ark/context/adapters/claude-code/post-tool-batch.sh"
failure_provenance_matches=$(find "$ROOT/ark/context/adapters/claude-code/tests/fixtures" \
  -type f -name 'post-tool-use-failure-provenance-*.txt' | LC_ALL=C sort)
failure_provenance_count=$(printf '%s\n' "$failure_provenance_matches" | grep -c .)
assert_eq "exactly one failure provenance fixture" 1 "$failure_provenance_count"
failure_provenance=$(printf '%s\n' "$failure_provenance_matches" | sed -n '1p')
failure_version=$(sed -n 's/^claude_version=\([0-9][0-9.]*\) .*/\1/p' "$failure_provenance")
failure_fixture="$ROOT/ark/context/adapters/claude-code/tests/fixtures/post-tool-use-failure-bash-exit-7-$failure_version.json"
batch_fixture="$ROOT/ark/context/adapters/claude-code/tests/fixtures/post-tool-batch-single-2.1.215.json"
failure_fixture_hash=$(cksum "$failure_fixture")
integration_bin="$TEST_TMP/integration-bin"
mkdir -m 700 "$integration_bin"
printf '#!/usr/bin/env bash\nprintf "2026-08-20T00:00:00Z\\n"\n' >"$integration_bin/date"
chmod 700 "$integration_bin/date"

prepare_hook_case() {
  hook_name=$1
  hook_session="$TEST_TMP/hook-$hook_name-session"
  hook_cache="$TEST_TMP/hook-$hook_name-cache"
  mkdir -m 700 "$hook_session" "$hook_session/errors" "$hook_cache"
  printf '# Task\n\n## Goal\nHook ordering\n\n## Plan\n- [ ] preserve order ← NOW\n' >"$hook_session/task.md"
  chmod 600 "$hook_session/task.md"
}

run_failure_hook() {
  target_session=$1
  output=$2
  error_output=$3
  env PATH="$integration_bin:$PATH" ARK_SESSION_DIR="$target_session" \
    /bin/bash "$failure_wrapper" <"$failure_fixture" >"$output" 2>"$error_output"
}

run_batch_hook() {
  target_session=$1
  target_cache=$2
  output=$3
  error_output=$4
  env ARK_SESSION_DIR="$target_session" ARK_CACHE_DIR="$target_cache" ARK_RECITE_INTERVAL=1 \
    /bin/bash "$batch_wrapper" <"$batch_fixture" >"$output" 2>"$error_output"
}

prepare_hook_case ab
ab_session=$hook_session; ab_cache=$hook_cache
run_failure_hook "$ab_session" "$TEST_TMP/ab-failure.out" "$TEST_TMP/ab-failure.err"
run_batch_hook "$ab_session" "$ab_cache" "$TEST_TMP/ab-batch.out" "$TEST_TMP/ab-batch.err"
prepare_hook_case ba
ba_session=$hook_session; ba_cache=$hook_cache
run_batch_hook "$ba_session" "$ba_cache" "$TEST_TMP/ba-batch.out" "$TEST_TMP/ba-batch.err"
run_failure_hook "$ba_session" "$TEST_TMP/ba-failure.out" "$TEST_TMP/ba-failure.err"
assert_eq "A-B and B-A raw entry count" "1 1" "$(wc -l <"$ab_session/errors/raw.log" | tr -d ' ') $(wc -l <"$ba_session/errors/raw.log" | tr -d ' ')"
TESTS=$((TESTS + 1))
if cmp -s "$ab_session/errors/raw.log" "$ba_session/errors/raw.log"; then PASSES=$((PASSES + 1)); else test_fail "A-B and B-A raw bytes differ"; fi
assert_eq "A-B and B-A step count" "1 1" "$(step_count "$ab_cache") $(step_count "$ba_cache")"
TESTS=$((TESTS + 1))
if cmp -s "$TEST_TMP/ab-batch.out" "$TEST_TMP/ba-batch.out"; then PASSES=$((PASSES + 1)); else test_fail "A-B and B-A additionalContext differ"; fi
assert_eq "failure wrappers stay quiet by order" 0 "$(wc -c "$TEST_TMP"/ab-failure.out "$TEST_TMP"/ab-failure.err "$TEST_TMP"/ba-failure.out "$TEST_TMP"/ba-failure.err | tail -1 | awk '{print $1}')"

prepare_hook_case concurrent-hooks
concurrent_session=$hook_session; concurrent_cache=$hook_cache
run_failure_hook "$concurrent_session" "$TEST_TMP/concurrent-failure.out" "$TEST_TMP/concurrent-failure.err" & failure_pid=$!
run_batch_hook "$concurrent_session" "$concurrent_cache" "$TEST_TMP/concurrent-batch.out" "$TEST_TMP/concurrent-batch.err" & batch_pid=$!
/bin/bash -c 'while IFS= read -r line; do :; done' <"$failure_fixture" >"$TEST_TMP/existing-post-tool-use.out" 2>"$TEST_TMP/existing-post-tool-use.err" & noop_pid=$!
wait "$failure_pid"; failure_status=$?
wait "$batch_pid"; batch_status=$?
wait "$noop_pid"; noop_status=$?
assert_eq "concurrent independent hooks exit zero" "0 0 0" "$failure_status $batch_status $noop_status"
assert_eq "concurrent raw entry count" 1 "$(wc -l <"$concurrent_session/errors/raw.log" | tr -d ' ')"
assert_eq "concurrent batch step count" 1 "$(step_count "$concurrent_cache")"
TESTS=$((TESTS + 1))
if cmp -s "$ab_session/errors/raw.log" "$concurrent_session/errors/raw.log"; then PASSES=$((PASSES + 1)); else test_fail "concurrent raw bytes differ"; fi
TESTS=$((TESTS + 1))
if cmp -s "$TEST_TMP/ab-batch.out" "$TEST_TMP/concurrent-batch.out"; then PASSES=$((PASSES + 1)); else test_fail "concurrent additionalContext differs"; fi
assert_eq "concurrent no-op stays quiet" 0 "$(wc -c "$TEST_TMP/existing-post-tool-use.out" "$TEST_TMP/existing-post-tool-use.err" | tail -1 | awk '{print $1}')"
assert_eq "hook fixture remains immutable" "$failure_fixture_hash" "$(cksum "$failure_fixture")"

assert_failure_wrapper_quiet() {
  failure_label=$1
  failure_session=$2
  failure_path=$3
  before_steps=$4
  run_case env PATH="$failure_path" ARK_SESSION_DIR="$failure_session" /bin/bash "$failure_wrapper" <"$failure_fixture"
  assert_success "$failure_label wrapper exits zero"
  assert_eq "$failure_label stdout empty" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
  assert_eq "$failure_label stderr empty" 0 "$(wc -c <"$CASE_STDERR" | tr -d ' ')"
  assert_eq "$failure_label recitation unchanged" "$before_steps" "$(step_count "$concurrent_cache")"
  assert_eq "$failure_label fixture unchanged" "$failure_fixture_hash" "$(cksum "$failure_fixture")"
}

no_jq_bin="$TEST_TMP/no-jq-bin"
mkdir -m 700 "$no_jq_bin"
for required_command in dirname mktemp head wc tr rm chmod stat id date iconv mkdir sed cat rmdir; do
  command_path=$(command -v "$required_command")
  ln -s "$command_path" "$no_jq_bin/$required_command"
done
prepare_hook_case no-jq-hook
assert_failure_wrapper_quiet "jq unavailable" "$hook_session" "$no_jq_bin" 1

fake_adapter_root="$TEST_TMP/fake-adapter-root"
mkdir -m 700 "$fake_adapter_root"
mkdir -m 700 "$fake_adapter_root/adapters" "$fake_adapter_root/hooks"
mkdir -m 700 "$fake_adapter_root/adapters/claude-code"
cp "$failure_wrapper" "$fake_adapter_root/adapters/claude-code/post-tool-use-failure.sh"
printf '#!/usr/bin/env bash\nexit 99\n' >"$fake_adapter_root/hooks/capture-error.sh"
chmod 000 "$fake_adapter_root/hooks/capture-error.sh"
prepare_hook_case core-unreadable
run_case env PATH="$integration_bin:$PATH" ARK_SESSION_DIR="$hook_session" \
  /bin/bash "$fake_adapter_root/adapters/claude-code/post-tool-use-failure.sh" <"$failure_fixture"
assert_success "unreadable core wrapper exits zero"
assert_eq "unreadable core wrapper stdout empty" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
assert_eq "unreadable core wrapper stderr empty" 0 "$(wc -c <"$CASE_STDERR" | tr -d ' ')"
chmod 600 "$fake_adapter_root/hooks/capture-error.sh"

prepare_hook_case lock-held
mkdir -m 700 "$hook_session/errors/.raw.lock"
printf '%s live-token\n' "$$" >"$hook_session/errors/.raw.lock/owner"
chmod 600 "$hook_session/errors/.raw.lock/owner"
assert_failure_wrapper_quiet "raw lock held" "$hook_session" "$integration_bin:$PATH" 1

prepare_hook_case unsafe-raw-hook
printf 'sentinel\n' >"$hook_session/errors/raw.log"; chmod 644 "$hook_session/errors/raw.log"
assert_failure_wrapper_quiet "unsafe raw" "$hook_session" "$integration_bin:$PATH" 1
assert_eq "unsafe raw remains unchanged" sentinel "$(cat "$hook_session/errors/raw.log")"

for hook_output in "$TEST_TMP"/ab-failure.out "$TEST_TMP"/ba-failure.out "$TEST_TMP"/concurrent-failure.out; do
  grep -E 'decision|continue|additionalContext|hookSpecificOutput' "$hook_output" >/dev/null 2>&1
  assert_eq "failure hook emits no control output" 1 "$?"
done

if grep -F '.gitignore' "$INIT" "$TEARDOWN" >/dev/null 2>&1; then test_fail "lifecycle script references .gitignore writes"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi

finish_tests session-lifecycle
