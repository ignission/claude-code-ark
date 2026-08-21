#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
FAILURES_LIB="$ROOT/ark/loop/scripts/lib/failures-knowledge.sh"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"
. "$ROOT/ark/loop/scripts/lib/runtime.sh"
. "$ROOT/ark/loop/scripts/lib/task-template.sh"

if [ ! -f "$FAILURES_LIB" ]; then
  TESTS=$((TESTS + 1))
  test_fail "failures-knowledge.sh exists"
  finish_tests "failures knowledge tests"
fi
. "$FAILURES_LIB"
CLAUDE_PROJECT_DIR=$ROOT
export CLAUDE_PROJECT_DIR
. "$ROOT/.claude/lib/state-io.sh"
set +e
set -uo pipefail

export HOME="$TEST_TMP/home"
export XDG_CONFIG_HOME="$TEST_TMP/config"
export XDG_DATA_HOME="$TEST_TMP/data"
export XDG_CACHE_HOME="$TEST_TMP/cache"
mkdir -m 700 "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

knowledge="$XDG_DATA_HOME/ark/loop/knowledge"
session="$XDG_DATA_HOME/ark/loop/sessions/33633633633633633633633633633633"
mkdir -m 700 "$XDG_DATA_HOME/ark" "$XDG_DATA_HOME/ark/loop" "$XDG_DATA_HOME/ark/loop/sessions" \
  "$knowledge" "$session" "$session/errors"
printf '%s\n' '# Curated failures' '- preserve this exact text' >"$knowledge/failures.md"
chmod 600 "$knowledge/failures.md"
curated_before=$(cksum "$knowledge/failures.md")

run_case loop_knowledge_initialize "$session" "$knowledge"
assert_success "curated knowledge copy succeeds"
cmp -s "$knowledge/failures.md" "$session/knowledge/failures.md" || test_fail "session knowledge differs from curated source"
assert_eq "session knowledge mode" 600 "$(loop_stat "$session/knowledge/failures.md" | awk '{print $2}')"
session_copy_before=$(cksum "$session/knowledge/failures.md")
printf '%s\n' '- later host edit' >>"$knowledge/failures.md"
run_case loop_knowledge_initialize "$session" "$knowledge"
assert_success "knowledge re-init succeeds"
assert_eq "knowledge re-init preserves snapshot" "$session_copy_before" "$(cksum "$session/knowledge/failures.md")"

missing_session="$XDG_DATA_HOME/ark/loop/sessions/44444444444444444444444444444444"
missing_knowledge="$XDG_DATA_HOME/ark/loop/missing-knowledge"
mkdir -m 700 "$missing_session" "$missing_knowledge"
run_case loop_knowledge_initialize "$missing_session" "$missing_knowledge"
assert_success "missing curated source creates empty snapshot"
assert_eq "missing curated source snapshot is empty" 0 "$(wc -c <"$missing_session/knowledge/failures.md" | tr -d ' ')"
assert_eq "empty snapshot mode" 600 "$(loop_stat "$missing_session/knowledge/failures.md" | awk '{print $2}')"

printf '%s\n' 'Error summary (mechanical)' \
  '- tool: Bash' '  error_type: nonzero_exit' '  count: 2' '  first_line: 1' '  last_line: 3' \
  '  詳細: errors/raw.log:L1-L3' \
  '- tool: Read' '  error_type: permission_denied' '  count: 1' '  first_line: 4' '  last_line: 4' \
  '  詳細: errors/raw.log:L4-L4' >"$session/errors/summary.md"
printf '%s\n' '{"error":"RAW SECRET","tool_input":{"password":"credential"}}' >"$session/errors/raw.log"
chmod 600 "$session/errors/summary.md" "$session/errors/raw.log"

sid=33633633633633633633633633633633
lock="$knowledge/failures-inbox.lock"
append_with_lock() {
  target_session=$1
  target_knowledge=$2
  target_work=$3
  target_sid=$4
  target_lock="$target_knowledge/failures-inbox.lock"
  flow_lock_acquire "$target_lock" 9 30 30 mkdir-direct >/dev/null 2>&1 || return 1
  target_backend=$FLOW_LOCK_ACQUIRED_BACKEND
  target_pid=$FLOW_LOCK_ACQUIRED_PID
  target_token=$FLOW_LOCK_ACQUIRED_TOKEN
  loop_failures_inbox_append "$target_session" "$target_knowledge" "$target_work" "$target_sid"
  append_status=$?
  flow_lock_release "$target_lock" "$target_backend" "$target_pid" "$target_token" >/dev/null 2>&1 || return 1
  return "$append_status"
}

run_case append_with_lock "$session" "$knowledge" issue-336 "$sid"
assert_success "inbox append succeeds"
inbox="$knowledge/failures-inbox.md"
assert_eq "inbox mode" 600 "$(loop_stat "$inbox" | awk '{print $2}')"
assert_eq "inbox candidate count" 2 "$(grep -Ec '^<!-- ark-loop-candidate:[0-9a-f]{64} -->$' "$inbox")"
marker_separator=$(printf '\037')
bash_marker=$(loop_sha256 "$sid${marker_separator}Bash${marker_separator}nonzero_exit${marker_separator}1${marker_separator}3")
read_marker=$(loop_sha256 "$sid${marker_separator}Read${marker_separator}permission_denied${marker_separator}4${marker_separator}4")
grep -F -x "<!-- ark-loop-candidate:$bash_marker -->" "$inbox" >/dev/null 2>&1 \
  || test_fail "inbox lacks the fixed Bash marker"
grep -F -x "<!-- ark-loop-candidate:$read_marker -->" "$inbox" >/dev/null 2>&1 \
  || test_fail "inbox lacks the fixed Read marker"
assert_eq "inbox WORK_ID count" 2 "$(grep -Fc -- '- WORK_ID: issue-336' "$inbox")"
assert_eq "inbox session ID count" 2 "$(grep -Fc -- "- Session ID: $sid" "$inbox")"
grep -F -- '- Tool: Bash' "$inbox" >/dev/null 2>&1 || test_fail "inbox lacks Bash tool"
grep -F -- '- Error type: nonzero_exit' "$inbox" >/dev/null 2>&1 || test_fail "inbox lacks error type"
grep -F -- '- Count: 2' "$inbox" >/dev/null 2>&1 || test_fail "inbox lacks count"
grep -F -- '- Evidence: errors/raw.log:L1-L3' "$inbox" >/dev/null 2>&1 || test_fail "inbox lacks evidence"
grep -E 'RAW SECRET|password|credential' "$inbox" >/dev/null 2>&1
assert_eq "inbox excludes raw error and credential" 1 "$?"

inbox_once=$(cksum "$inbox")
run_case append_with_lock "$session" "$knowledge" issue-336 "$sid"
assert_success "second inbox append succeeds"
assert_eq "second append is deduplicated" "$inbox_once" "$(cksum "$inbox")"

publish_failure_knowledge="$TEST_TMP/publish-failure-knowledge"
publish_failure_bin="$TEST_TMP/publish-failure-bin"
mkdir -m 700 "$publish_failure_knowledge" "$publish_failure_bin"
printf '%s\n' '# Existing inbox' 'preserve every byte 日本語' \
  >"$publish_failure_knowledge/failures-inbox.md"
chmod 600 "$publish_failure_knowledge/failures-inbox.md"
cp "$publish_failure_knowledge/failures-inbox.md" "$TEST_TMP/publish-failure-before"
printf '%s\n' '#!/bin/sh' \
  'cp "$1" "$ARK_TEST_FAILED_REPLACEMENT" || exit 2' \
  'exit 1' >"$publish_failure_bin/mv"
chmod 700 "$publish_failure_bin/mv"
append_with_failing_publish() {
  ARK_TEST_FAILED_REPLACEMENT="$TEST_TMP/publish-failure-replacement"
  export ARK_TEST_FAILED_REPLACEMENT
  PATH="$publish_failure_bin:$PATH" \
    append_with_lock "$session" "$publish_failure_knowledge" issue-336 "$sid"
}
run_case append_with_failing_publish
assert_eq "inbox publish failure is reported" 1 "$CASE_STATUS"
[ -f "$TEST_TMP/publish-failure-replacement" ] \
  || test_fail "inbox publish failure did not reach atomic replacement"
assert_eq "failed replacement held two complete candidates" 2 \
  "$(grep -Fc -- "- Session ID: $sid" "$TEST_TMP/publish-failure-replacement")"
cmp -s "$TEST_TMP/publish-failure-before" "$publish_failure_knowledge/failures-inbox.md" \
  || test_fail "inbox publish failure changed existing bytes"
assert_eq "inbox publish failure preserves mode" 600 \
  "$(loop_stat "$publish_failure_knowledge/failures-inbox.md" | awk '{print $2}')"
publish_failure_temps=$(find "$publish_failure_knowledge" -maxdepth 1 \
  -type f -name '.failures-inbox.*' | wc -l | tr -d ' ')
assert_eq "inbox publish failure cleans replacement" 0 "$publish_failure_temps"

parallel_root=$(mktemp -d "$TEST_TMP/parallel.XXXXXX")
parallel_root=$(cd "$parallel_root" && pwd -P)
parallel_knowledge="$parallel_root/knowledge"
mkdir -m 700 "$parallel_knowledge"
parallel_number=1
while [ "$parallel_number" -le 20 ]; do
  (
    append_with_lock "$session" "$parallel_knowledge" issue-336 "$sid"
  ) >"$parallel_root/$parallel_number.out" 2>"$parallel_root/$parallel_number.err" &
  eval "parallel_pid_$parallel_number=$!"
  parallel_number=$((parallel_number + 1))
done
parallel_number=1
parallel_failures=0
while [ "$parallel_number" -le 20 ]; do
  eval "wait \$parallel_pid_$parallel_number" || parallel_failures=$((parallel_failures + 1))
  parallel_number=$((parallel_number + 1))
done
assert_eq "parallel append processes succeed" 0 "$parallel_failures"
parallel_inbox="$parallel_knowledge/failures-inbox.md"
assert_eq "parallel append keeps two markers" 2 "$(grep -Ec '^<!-- ark-loop-candidate:[0-9a-f]{64} -->$' "$parallel_inbox")"
assert_eq "parallel append keeps two complete candidates" 2 "$(grep -Fc -- "- Session ID: $sid" "$parallel_inbox")"
iconv -f UTF-8 -t UTF-8 "$parallel_inbox" >/dev/null 2>&1 || test_fail "parallel inbox is not valid UTF-8"
[ ! -e "$parallel_knowledge/failures-inbox.lock" ] || test_fail "parallel append left lock directory"

prefix_knowledge="$TEST_TMP/prefix-knowledge"
mkdir -m 700 "$prefix_knowledge"
printf '%s\n' '# Human notes' 'preserve bytes 日本語' >"$prefix_knowledge/failures-inbox.md"
chmod 600 "$prefix_knowledge/failures-inbox.md"
cp "$prefix_knowledge/failures-inbox.md" "$TEST_TMP/prefix-before"
run_case append_with_lock "$session" "$prefix_knowledge" issue-336 "$sid"
assert_success "existing inbox append succeeds"
prefix_bytes=$(wc -c <"$TEST_TMP/prefix-before" | tr -d ' ')
head -c "$prefix_bytes" "$prefix_knowledge/failures-inbox.md" >"$TEST_TMP/prefix-after"
cmp -s "$TEST_TMP/prefix-before" "$TEST_TMP/prefix-after" || test_fail "append changed existing inbox prefix"

empty_session="$XDG_DATA_HOME/ark/loop/sessions/55555555555555555555555555555555"
mkdir -m 700 "$empty_session" "$empty_session/errors"
printf '%s\n' 'Error summary (mechanical)' '- なし' >"$empty_session/errors/summary.md"
chmod 600 "$empty_session/errors/summary.md"
empty_before=$(cksum "$inbox")
run_case append_with_lock "$empty_session" "$knowledge" issue-336 55555555555555555555555555555555
assert_success "empty summary append succeeds"
assert_eq "empty summary adds no candidate" "$empty_before" "$(cksum "$inbox")"

unsafe_knowledge="$TEST_TMP/unsafe-knowledge"
mkdir -m 755 "$unsafe_knowledge"
run_case append_with_lock "$session" "$unsafe_knowledge" issue-336 "$sid"
assert_eq "unsafe knowledge fails closed" 1 "$CASE_STATUS"
[ ! -e "$unsafe_knowledge/failures-inbox.md" ] || test_fail "unsafe knowledge created inbox"

unsafe_summary_before=$(cksum "$inbox")
chmod 644 "$session/errors/summary.md"
run_case append_with_lock "$session" "$knowledge" issue-336 "$sid"
assert_eq "unsafe summary fails closed" 1 "$CASE_STATUS"
assert_eq "unsafe summary preserves inbox" "$unsafe_summary_before" "$(cksum "$inbox")"
chmod 600 "$session/errors/summary.md"

symlink_knowledge="$TEST_TMP/symlink-knowledge"
ln -s "$knowledge" "$symlink_knowledge"
run_case append_with_lock "$session" "$symlink_knowledge" issue-336 "$sid"
assert_eq "symlink knowledge fails closed" 1 "$CASE_STATUS"

unsafe_inbox_knowledge="$TEST_TMP/unsafe-inbox-knowledge"
mkdir -m 700 "$unsafe_inbox_knowledge"
printf '%s\n' 'unsafe inbox sentinel' >"$unsafe_inbox_knowledge/failures-inbox.md"
chmod 644 "$unsafe_inbox_knowledge/failures-inbox.md"
unsafe_inbox_before=$(cksum "$unsafe_inbox_knowledge/failures-inbox.md")
run_case append_with_lock "$session" "$unsafe_inbox_knowledge" issue-336 "$sid"
assert_eq "unsafe inbox fails closed" 1 "$CASE_STATUS"
assert_eq "unsafe inbox bytes are preserved" "$unsafe_inbox_before" \
  "$(cksum "$unsafe_inbox_knowledge/failures-inbox.md")"

assert_eq "curated host remains unchanged except explicit fixture edit" 1 \
  "$(grep -Fc -- '- later host edit' "$knowledge/failures.md")"
assert_eq "session snapshot remains immutable" "$session_copy_before" "$(cksum "$session/knowledge/failures.md")"

production_mentions="$TEST_TMP/production-failures-mentions"
find "$ROOT/ark/loop/adapters" "$ROOT/ark/loop/hooks" "$ROOT/ark/loop/scripts" -type f -name '*.sh' -print \
  | while IFS= read -r production_file; do
      grep -nE '(>>|>|cp|mv|rm).*(/|")failures\.md' "$production_file" 2>/dev/null \
        && printf '%s\n' "$production_file"
    done >"$production_mentions"
TESTS=$((TESTS + 1))
if grep -v 'task-template.sh' "$production_mentions" >/dev/null 2>&1; then
  CASE_STDERR=$production_mentions
  test_fail "production has a failures.md writer outside init copy"
else
  PASSES=$((PASSES + 1))
fi
grep -E '(cp|mv).*(failures-inbox\.md).*(failures\.md)' "$ROOT/ark/loop"/scripts/*.sh \
  "$ROOT/ark/loop"/scripts/lib/*.sh >/dev/null 2>&1
assert_eq "production has no inbox promotion path" 1 "$?"

finish_tests "failures knowledge tests"
