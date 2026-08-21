#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
HOOK="$ROOT/.claude/hooks/stop-gate.sh"
FIXTURE="$ROOT/ark/loop/adapters/claude-code/tests/fixtures/stop-incomplete.json"
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

repo="$TEST_TMP/repo"
mkdir -m 700 "$repo"
git -C "$repo" init -q
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.invalid
git -C "$repo" checkout -qb feature/issue-336/loop-teardown-handoff

input="$TEST_TMP/stop-input.json"
sed "s|<workspace>|$repo|g" "$FIXTURE" >"$input"
chmod 600 "$input"

settings_before=$(cksum "$ROOT/.claude/settings.json")
stop_command_before=$(jq -c '.hooks.Stop' "$ROOT/.claude/settings.json")

# An Ark-external invocation must return without reading a stdin that never
# reaches EOF and without consulting environment paths or helper commands.
fifo="$TEST_TMP/unreadable-input"
mkfifo "$fifo"
fake_bin="$TEST_TMP/fake-bin"
mkdir -m 700 "$fake_bin"
for command_name in git jq head; do
  {
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' ': >"$ARK_TEST_COMMAND_MARKER"'
    printf '%s\n' 'exit 97'
  } >"$fake_bin/$command_name"
  chmod 700 "$fake_bin/$command_name"
done
external_out="$TEST_TMP/external.out"
external_err="$TEST_TMP/external.err"
external_marker="$TEST_TMP/external-command-ran"
env -u ARK_SESSION_DIR PATH="$fake_bin:$PATH" ARK_TEST_COMMAND_MARKER="$external_marker" \
  ARK_CACHE_DIR="$TEST_TMP/forbidden-cache" ARK_KNOWLEDGE_DIR="$TEST_TMP/forbidden-knowledge" \
  /bin/bash "$HOOK" <>"$fifo" >"$external_out" 2>"$external_err" & external_pid=$!
wait "$external_pid"; external_status=$?
assert_eq "Ark-external hook exits zero" 0 "$external_status"
assert_eq "Ark-external hook stdout is empty" 0 "$(wc -c <"$external_out" | tr -d ' ')"
assert_eq "Ark-external hook stderr is empty" 0 "$(wc -c <"$external_err" | tr -d ' ')"
[ ! -e "$external_marker" ] || test_fail "Ark-external hook ran a helper command"
[ ! -e "$TEST_TMP/forbidden-cache" ] || test_fail "Ark-external hook touched cache"
[ ! -e "$TEST_TMP/forbidden-knowledge" ] || test_fail "Ark-external hook touched knowledge"

make_session() {
  session_path=$1
  plan_state=$2
  mkdir -m 700 "$session_path" "$session_path/artifacts" "$session_path/errors"
  if [ "$plan_state" = incomplete ]; then
    plan_line='- [ ] Finish implementation ← NOW'
  else
    plan_line='- [x] Finish implementation ← NOW'
  fi
  {
    printf '%s\n' '# Task' '' '## Goal' 'Finish issue 336' '' '## Constraints' '- Preserve contracts' '' '## Plan'
    printf '%s\n' "$plan_line"
    printf '%s\n' '' '## Artifacts' '- (none)'
  } >"$session_path/task.md"
  chmod 600 "$session_path/task.md"
}

session="$XDG_DATA_HOME/ark/loop/sessions/33633633633633633633633633633633"
mkdir -m 700 "$XDG_DATA_HOME/ark" "$XDG_DATA_HOME/ark/loop" "$XDG_DATA_HOME/ark/loop/sessions"
make_session "$session" incomplete
run_case env ARK_SESSION_DIR="$session" /bin/bash "$HOOK" <"$input"
assert_success "first incomplete Stop exits zero"
TESTS=$((TESTS + 1))
if jq -e '
  type == "object"
  and .decision == "block"
  and (.reason | type == "string" and length > 0)
  and .hookSpecificOutput.hookEventName == "Stop"
  and .hookSpecificOutput.additionalContext == .reason
' "$CASE_STDOUT" >/dev/null 2>&1; then
  PASSES=$((PASSES + 1))
else
  test_fail "first incomplete Stop returns the block schema"
  finish_tests "stop gate tests"
fi
assert_eq "one-shot flag mode" 600 "$(loop_stat "$session/stop_once" | awk '{print $2}')"
assert_eq "one-shot flag is the only root data addition" 'artifacts errors stop_once task.md' \
  "$(find "$session" -mindepth 1 -maxdepth 1 -print | sed 's|.*/||' | sort | tr '\n' ' ' | sed 's/ $//')"
[ ! -e "$repo/command-shaped-message-ran" ] || test_fail "command-shaped message was executed"

assert_quiet_stop() {
  label=$1
  shift
  run_case "$@"
  assert_success "$label exits zero"
  assert_eq "$label is quiet" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
}

assert_quiet_stop "second incomplete Stop" env ARK_SESSION_DIR="$session" /bin/bash "$HOOK" <"$input"

active_input="$TEST_TMP/active.json"
jq '.stop_hook_active = true' "$input" >"$active_input"
assert_quiet_stop "active Stop" env ARK_SESSION_DIR="$session" /bin/bash "$HOOK" <"$active_input"

complete_session="$XDG_DATA_HOME/ark/loop/sessions/44444444444444444444444444444444"
make_session "$complete_session" complete
assert_quiet_stop "completed Plan Stop" env ARK_SESSION_DIR="$complete_session" /bin/bash "$HOOK" <"$input"
printf '%s\n' '{invalid' >"$TEST_TMP/invalid.json"
assert_quiet_stop "invalid JSON Stop" env ARK_SESSION_DIR="$complete_session" /bin/bash "$HOOK" <"$TEST_TMP/invalid.json"
jq '.hook_event_name = "PostToolUse"' "$input" >"$TEST_TMP/other-event.json"
assert_quiet_stop "other event" env ARK_SESSION_DIR="$complete_session" /bin/bash "$HOOK" <"$TEST_TMP/other-event.json"

unsafe_session="$XDG_DATA_HOME/ark/loop/sessions/55555555555555555555555555555555"
make_session "$unsafe_session" incomplete
chmod 755 "$unsafe_session"
assert_quiet_stop "unsafe session mode" env ARK_SESSION_DIR="$unsafe_session" /bin/bash "$HOOK" <"$input"
chmod 700 "$unsafe_session"
chmod 644 "$unsafe_session/task.md"
assert_quiet_stop "unsafe task mode" env ARK_SESSION_DIR="$unsafe_session" /bin/bash "$HOOK" <"$input"
command rm -f "$unsafe_session/task.md"
ln -s "$session/task.md" "$unsafe_session/task.md"
assert_quiet_stop "symlink task" env ARK_SESSION_DIR="$unsafe_session" /bin/bash "$HOOK" <"$input"

no_jq_bin="$TEST_TMP/no-jq-bin"
mkdir -m 700 "$no_jq_bin"
real_head=$(command -v head)
real_iconv=$(command -v iconv)
real_dirname=$(command -v dirname)
ln -s "$real_head" "$no_jq_bin/head"
ln -s "$real_iconv" "$no_jq_bin/iconv"
ln -s "$real_dirname" "$no_jq_bin/dirname"
assert_quiet_stop "missing jq" env PATH="$no_jq_bin" ARK_SESSION_DIR="$complete_session" /bin/bash "$HOOK" <"$input"

bad_flag_session="$XDG_DATA_HOME/ark/loop/sessions/77777777777777777777777777777777"
make_session "$bad_flag_session" incomplete
: >"$bad_flag_session/stop_once"
chmod 644 "$bad_flag_session/stop_once"
assert_quiet_stop "unsafe one-shot mode" env ARK_SESSION_DIR="$bad_flag_session" /bin/bash "$HOOK" <"$input"

ln -s "$complete_session" "$XDG_DATA_HOME/ark/loop/sessions/symlink-session"
assert_quiet_stop "symlink session" env ARK_SESSION_DIR="$XDG_DATA_HOME/ark/loop/sessions/symlink-session" \
  /bin/bash "$HOOK" <"$input"

# A valid payload larger than the observed single-read pipe chunk must remain
# intact. This catches regressions to dd bs=N count=1.
large_message="$TEST_TMP/large-message"
LC_ALL=C awk 'BEGIN { for (i = 0; i < 300000; i++) printf "x" }' >"$large_message"
large_input="$TEST_TMP/large-input.json"
jq --rawfile message "$large_message" '.last_assistant_message = $message' "$input" >"$large_input"
large_session="$XDG_DATA_HOME/ark/loop/sessions/88888888888888888888888888888888"
make_session "$large_session" incomplete
run_case env ARK_SESSION_DIR="$large_session" /bin/bash "$HOOK" <"$large_input"
assert_success "300KB Stop exits zero"
jq -e '.decision == "block"' "$CASE_STDOUT" >/dev/null 2>&1 \
  || test_fail "300KB Stop was truncated before JSON validation"

oversize_input="$TEST_TMP/oversize-input.json"
LC_ALL=C awk 'BEGIN { for (i = 0; i < 1048578; i++) printf "x" }' >"$oversize_input"
assert_quiet_stop "oversize Stop" env ARK_SESSION_DIR="$complete_session" /bin/bash "$HOOK" <"$oversize_input"

parallel_session="$XDG_DATA_HOME/ark/loop/sessions/66666666666666666666666666666666"
make_session "$parallel_session" incomplete
parallel_dir="$TEST_TMP/parallel"
mkdir -m 700 "$parallel_dir"
parallel_pid=1
while [ "$parallel_pid" -le 20 ]; do
  env ARK_SESSION_DIR="$parallel_session" /bin/bash "$HOOK" <"$input" \
    >"$parallel_dir/$parallel_pid.out" 2>"$parallel_dir/$parallel_pid.err" &
  eval "parallel_process_$parallel_pid=$!"
  parallel_pid=$((parallel_pid + 1))
done
parallel_pid=1
parallel_failures=0
while [ "$parallel_pid" -le 20 ]; do
  eval "wait \$parallel_process_$parallel_pid" || parallel_failures=$((parallel_failures + 1))
  parallel_pid=$((parallel_pid + 1))
done
assert_eq "parallel Stop processes all exit zero" 0 "$parallel_failures"
block_count=0
for output in "$parallel_dir"/*.out; do
  if [ -s "$output" ]; then
    jq -e '.decision == "block"' "$output" >/dev/null 2>&1 || test_fail "parallel Stop emitted invalid output"
    block_count=$((block_count + 1))
  fi
done
assert_eq "parallel Stop blocks exactly once" 1 "$block_count"
assert_eq "parallel one-shot flag mode" 600 "$(loop_stat "$parallel_session/stop_once" | awk '{print $2}')"

assert_eq "settings checksum is unchanged" "$settings_before" "$(cksum "$ROOT/.claude/settings.json")"
assert_eq "Stop registration is unchanged" "$stop_command_before" "$(jq -c '.hooks.Stop' "$ROOT/.claude/settings.json")"
[ ! -e "$repo/command-shaped-message-ran" ] || test_fail "fixture executed its command-shaped data"

finish_tests "stop gate tests"
