#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"

SESSION_START="$ROOT/ark/context/adapters/claude-code/session-start.sh"
POST_TOOL_BATCH="$ROOT/ark/context/adapters/claude-code/post-tool-batch.sh"
POST_TOOL_USE_FAILURE="$ROOT/ark/context/adapters/claude-code/post-tool-use-failure.sh"
CAPTURE_ERROR="$ROOT/ark/context/hooks/capture-error.sh"
SUMMARIZE_ERRORS="$ROOT/ark/context/scripts/summarize-errors.sh"
FIXTURES="$ROOT/ark/context/adapters/claude-code/tests/fixtures"

no_jq_bin="$TEST_TMP/no-jq-bin"
mkdir -m 700 "$no_jq_bin"
for required_command in dirname stat id sed rm rmdir mkdir chmod grep; do
  command_path=$(command -v "$required_command")
  ln -s "$command_path" "$no_jq_bin/$required_command"
done
printf '%s\n' '#!/bin/sh' \
  'if [ "${1:-}" = +%s ]; then printf "2000000000\\n"; else printf "2026-08-21T00:00:00Z\\n"; fi' \
  >"$no_jq_bin/date"
chmod 700 "$no_jq_bin/date"
if PATH="$no_jq_bin" command -v jq >/dev/null 2>&1; then
  test_fail "no-jq PATH unexpectedly resolves jq"
else
  TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1))
fi

session="$TEST_TMP/session"
cache="$TEST_TMP/cache"
mkdir -m 700 "$session" "$session/errors" "$cache"
printf '%s\n' \
  '{"at":"2026-08-20T00:00:00Z","tool":"Bash","error_type":"tool_error","exit_code":7,"is_interrupt":false,"error":"existing","details":{}}' \
  >"$session/errors/raw.log"
chmod 600 "$session/errors/raw.log"

session_input="$TEST_TMP/session-start.json"
printf '%s\n' '{"session_id":"fixture","hook_event_name":"SessionStart","source":"startup"}' \
  >"$session_input"
batch_input="$FIXTURES/post-tool-batch-single-2.1.215.json"
failure_input="$FIXTURES/post-tool-use-failure-bash-exit-7-2.1.237.json"
capture_input="$ROOT/ark/context/tests/fixtures/capture-interrupt.json"

run_without_jq() {
  script=$1
  input=$2
  run_case env PATH="$no_jq_bin" ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" \
    /bin/bash "$script" <"$input"
  assert_success "$(basename "$script") without jq exits zero"
  assert_eq "$(basename "$script") without jq does not corrupt stdout" 0 \
    "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
  assert_eq "$(basename "$script") without jq keeps stderr quiet" 0 \
    "$(wc -c <"$CASE_STDERR" | tr -d ' ')"
}

run_without_jq "$SESSION_START" "$session_input"
run_without_jq "$POST_TOOL_BATCH" "$batch_input"
run_without_jq "$POST_TOOL_USE_FAILURE" "$failure_input"
run_without_jq "$CAPTURE_ERROR" "$capture_input"
run_without_jq "$SUMMARIZE_ERRORS" /dev/null

expected="$TEST_TMP/expected-raw.log"
printf '%s\n' \
  '{"at":"2026-08-20T00:00:00Z","tool":"Bash","error_type":"tool_error","exit_code":7,"is_interrupt":false,"error":"existing","details":{}}' \
  '{"at":"2026-08-21T00:00:00Z","tool":"ark/context","error_type":"missing_prerequisite","exit_code":null,"is_interrupt":null,"error":"jq command unavailable","details":{}}' \
  >"$expected"
TESTS=$((TESTS + 1))
if cmp -s "$expected" "$session/errors/raw.log"; then
  PASSES=$((PASSES + 1))
else
  test_fail "missing jq raw record bytes mismatch"
fi
assert_eq "missing jq is recorded once across one session" 2 \
  "$(wc -l <"$session/errors/raw.log" | tr -d ' ')"
assert_eq "missing jq leaves no lock artifacts" 1 \
  "$(find "$session/errors" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')"

stale_session="$TEST_TMP/stale-session"
stale_cache="$TEST_TMP/stale-cache"
stale_bin="$TEST_TMP/stale-bin"
mkdir -m 700 "$stale_session" "$stale_session/errors" "$stale_cache" "$stale_bin"
for required_command in dirname stat id rm rmdir mkdir chmod grep date; do
  ln -s "$no_jq_bin/$required_command" "$stale_bin/$required_command"
done
printf '#!/bin/sh\nexit 1\n' >"$stale_bin/sed"
chmod 700 "$stale_bin/sed"
run_case env PATH="$stale_bin" ARK_SESSION_DIR="$stale_session" ARK_CACHE_DIR="$stale_cache" \
  /bin/bash "$SESSION_START" <"$session_input"
assert_success "interrupted missing jq writer stays non-blocking"
stale_owner="$stale_session/errors/.raw.lock/owner"
if grep -E '^[0-9]+ [0-9]+-0$' "$stale_owner" >/dev/null 2>&1; then
  TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1))
else
  test_fail "missing jq lock owner is incompatible with capture recovery"
fi
run_case env PATH="$no_jq_bin:$PATH" ARK_SESSION_DIR="$stale_session" \
  /bin/bash "$CAPTURE_ERROR" <"$capture_input"
assert_success "capture recovers missing jq stale lock"
stale_expected="$TEST_TMP/stale-expected.log"
printf '%s\n' \
  '{"at":"2026-08-21T00:00:00Z","tool":"Bash","error_type":"tool_error","exit_code":null,"is_interrupt":true,"error":"Interrupted by user\n停止","details":{"elapsed_ms":12,"signal":null}}' \
  >"$stale_expected"
TESTS=$((TESTS + 1))
if cmp -s "$stale_expected" "$stale_session/errors/raw.log"; then
  PASSES=$((PASSES + 1))
else
  test_fail "capture did not recover and append after missing jq interruption"
fi
assert_eq "stale raw lock is removed after recovery" no \
  "$(if [ -e "$stale_session/errors/.raw.lock" ]; then printf yes; else printf no; fi)"

empty_lock_session="$TEST_TMP/empty-lock-session"
mkdir -m 700 "$empty_lock_session" "$empty_lock_session/errors" \
  "$empty_lock_session/errors/.raw.lock"
touch -t 200001010000 "$empty_lock_session/errors/.raw.lock"
run_case env PATH="$no_jq_bin:$PATH" ARK_SESSION_DIR="$empty_lock_session" \
  /bin/bash "$CAPTURE_ERROR" <"$capture_input"
assert_success "capture recovers an ownerless stale lock"
TESTS=$((TESTS + 1))
if cmp -s "$stale_expected" "$empty_lock_session/errors/raw.log"; then
  PASSES=$((PASSES + 1))
else
  test_fail "capture did not recover an ownerless stale lock"
fi
assert_eq "ownerless stale lock is removed after recovery" no \
  "$(if [ -e "$empty_lock_session/errors/.raw.lock" ]; then printf yes; else printf no; fi)"

parallel_session="$TEST_TMP/parallel-session"
parallel_cache="$TEST_TMP/parallel-cache"
mkdir -m 700 "$parallel_session" "$parallel_session/errors" "$parallel_cache"
parallel_pids=
parallel_index=1
while [ "$parallel_index" -le 20 ]; do
  env PATH="$no_jq_bin" ARK_SESSION_DIR="$parallel_session" ARK_CACHE_DIR="$parallel_cache" \
    /bin/bash "$SESSION_START" <"$session_input" \
    >"$TEST_TMP/parallel-$parallel_index.out" 2>"$TEST_TMP/parallel-$parallel_index.err" &
  parallel_pids="$parallel_pids $!"
  parallel_index=$((parallel_index + 1))
done
parallel_status=0
for parallel_pid in $parallel_pids; do
  wait "$parallel_pid" || parallel_status=1
done
assert_eq "parallel missing jq hooks exit zero" 0 "$parallel_status"
parallel_expected="$TEST_TMP/parallel-expected.log"
printf '%s\n' \
  '{"at":"2026-08-21T00:00:00Z","tool":"ark/context","error_type":"missing_prerequisite","exit_code":null,"is_interrupt":null,"error":"jq command unavailable","details":{}}' \
  >"$parallel_expected"
TESTS=$((TESTS + 1))
if cmp -s "$parallel_expected" "$parallel_session/errors/raw.log"; then
  PASSES=$((PASSES + 1))
else
  test_fail "parallel missing jq record is not exactly once"
fi
assert_eq "parallel missing jq hooks keep all output channels empty" 0 \
  "$(wc -c "$TEST_TMP"/parallel-*.out "$TEST_TMP"/parallel-*.err | tail -1 | awk '{print $1}')"

outside_root="$TEST_TMP/outside-root"
mkdir -m 700 "$outside_root"
printf '%s\n' sentinel >"$outside_root/sentinel"
chmod 600 "$outside_root/sentinel"
outside_before=$(cksum "$outside_root/sentinel")
for script in "$SESSION_START" "$POST_TOOL_BATCH" "$POST_TOOL_USE_FAILURE" "$CAPTURE_ERROR" "$SUMMARIZE_ERRORS"; do
  run_case env -u ARK_SESSION_DIR PATH="$no_jq_bin" HOME="$outside_root" \
    XDG_DATA_HOME="$outside_root" /bin/bash "$script" </dev/null
  assert_success "$(basename "$script") without ARK_SESSION_DIR exits zero"
  assert_eq "$(basename "$script") without ARK_SESSION_DIR writes no output" 0 \
    "$(wc -c "$CASE_STDOUT" "$CASE_STDERR" | tail -1 | awk '{print $1}')"
done
assert_eq "no-session execution preserves existing content" "$outside_before" \
  "$(cksum "$outside_root/sentinel")"
assert_eq "no-session execution creates no files" sentinel \
  "$(find "$outside_root" -mindepth 1 -maxdepth 1 -type f -exec basename {} \;)"

if [ -n "$CTX_ZSH" ]; then
  zsh_session="$TEST_TMP/zsh-session"
  zsh_cache="$TEST_TMP/zsh-cache"
  mkdir -m 700 "$zsh_session" "$zsh_session/errors" "$zsh_cache"
  for zsh_case in \
    "$SESSION_START:$session_input" \
    "$POST_TOOL_BATCH:$batch_input" \
    "$POST_TOOL_USE_FAILURE:$failure_input" \
    "$CAPTURE_ERROR:$capture_input" \
    "$SUMMARIZE_ERRORS:/dev/null"; do
    zsh_script=${zsh_case%%:*}
    zsh_input=${zsh_case#*:}
    run_case env PATH="$no_jq_bin" ARK_SESSION_DIR="$zsh_session" ARK_CACHE_DIR="$zsh_cache" \
      "$CTX_ZSH" "$zsh_script" <"$zsh_input"
    assert_success "$(basename "$zsh_script") missing jq path works in zsh"
    assert_eq "$(basename "$zsh_script") zsh output remains empty" 0 \
      "$(wc -c "$CASE_STDOUT" "$CASE_STDERR" | tail -1 | awk '{print $1}')"
  done
  TESTS=$((TESTS + 1))
  if cmp -s "$parallel_expected" "$zsh_session/errors/raw.log"; then
    PASSES=$((PASSES + 1))
  else
    test_fail "zsh missing jq record bytes mismatch"
  fi
else
  printf '%s\n' 'SKIP: zsh is unavailable; missing jq zsh case skipped'
fi

finish_tests jq-prerequisite
