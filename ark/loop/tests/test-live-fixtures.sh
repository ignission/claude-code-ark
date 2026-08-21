#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
WRAPPER="$ROOT/ark/loop/adapters/claude-code/post-tool-batch.sh"
FAILURE_WRAPPER="$ROOT/ark/loop/adapters/claude-code/post-tool-use-failure.sh"
SINGLE="$ROOT/ark/loop/adapters/claude-code/tests/fixtures/post-tool-batch-single-2.1.215.json"
PARALLEL="$ROOT/ark/loop/adapters/claude-code/tests/fixtures/post-tool-batch-parallel-2.1.215.json"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/scripts/lib/runtime.sh"
. "$ROOT/ark/loop/adapters/claude-code/settings.sh"
. "$ROOT/ark/loop/tests/test-helper.sh"

command -v claude >/dev/null 2>&1 \
  || { printf 'live fixture requires claude command\n' >&2; exit 1; }
command -v strings >/dev/null 2>&1 \
  || { printf 'live fixture requires strings command\n' >&2; exit 1; }

now_ns() { date +%s%N; }
probe=$(now_ns)
case "$probe" in *[!0-9]*) printf 'live fixture requires nanosecond date support\n' >&2; exit 1 ;; esac

session="$TEST_TMP/session"
cache="$TEST_TMP/cache"
mkdir -m 700 "$session" "$cache"
printf '# Task\n\n## Goal\nLive fixture\n\n## Plan\n- [ ] measure ← NOW\n' >"$session/task.md"
chmod 600 "$session/task.md"
export ARK_SESSION_DIR="$session" ARK_CACHE_DIR="$cache" ARK_RECITE_INTERVAL=10

recite_max=0
i=1
while [ "$i" -le 20 ]; do
  start=$(now_ns)
  /bin/bash "$WRAPPER" <"$SINGLE" >"$TEST_TMP/recite-$i.out" 2>"$TEST_TMP/recite-$i.err"
  finish=$(now_ns)
  elapsed=$(((finish - start) / 1000000))
  [ "$elapsed" -le "$recite_max" ] || recite_max=$elapsed
  i=$((i + 1))
done
[ "$(step_count "$cache")" -eq 20 ] || { printf 'single fixture lost a batch\n' >&2; exit 1; }
[ "$(grep -l 'hookSpecificOutput' "$TEST_TMP"/recite-*.out | wc -l | tr -d ' ')" -eq 2 ] \
  || { printf 'single fixture did not output exactly at 10 and 20\n' >&2; exit 1; }

seed_step_count "$cache" 0
parallel_start=$(now_ns)
pids=
i=1
while [ "$i" -le 20 ]; do
  (
    start=$(now_ns)
    /bin/bash "$WRAPPER" <"$PARALLEL" >"$TEST_TMP/parallel-$i.out" 2>"$TEST_TMP/parallel-$i.err"
    finish=$(now_ns)
    printf '%s\n' "$(((finish - start) / 1000000))" >"$TEST_TMP/parallel-$i.ms"
  ) &
  pids="$pids $!"
  i=$((i + 1))
done
for pid in $pids; do wait "$pid" || { printf 'parallel wrapper failed\n' >&2; exit 1; }; done
parallel_finish=$(now_ns)
parallel_wall=$(((parallel_finish - parallel_start) / 1000000))
parallel_max=$(awk '{if ($1 > max) max=$1} END {print max+0}' "$TEST_TMP"/parallel-*.ms)
[ "$(step_count "$cache")" -eq 20 ] || { printf 'parallel fixture lost a batch\n' >&2; exit 1; }
[ "$(grep -l 'step_count lock unavailable' "$TEST_TMP"/parallel-*.err 2>/dev/null | wc -l | tr -d ' ')" -eq 0 ] \
  || { printf 'parallel fixture exhausted lock retries\n' >&2; exit 1; }
[ "$recite_max" -le 100 ] && [ "$parallel_max" -le 100 ] \
  || { printf 'recite timing exceeded 100ms: single=%s parallel=%s\n' "$recite_max" "$parallel_max" >&2; exit 1; }

printf '{"tool_input":{"command":"git status"},"cwd":"%s"}\n' "$ROOT" >"$TEST_TMP/non-push.json"
printf '{"tool_input":{"file_path":""}}\n' >"$TEST_TMP/non-edit.json"
measure_hook() {
  local script=$1 input=$2 maximum=0 n start finish elapsed
  n=1
  while [ "$n" -le 20 ]; do
    start=$(now_ns)
    CLAUDE_PROJECT_DIR="$ROOT" /bin/bash "$script" <"$input" >/dev/null 2>"$TEST_TMP/hook.err"
    finish=$(now_ns)
    elapsed=$(((finish - start) / 1000000))
    [ "$elapsed" -le "$maximum" ] || maximum=$elapsed
    n=$((n + 1))
  done
  printf '%s\n' "$maximum"
}
push_max=$(measure_hook "$ROOT/.claude/hooks/post-push-monitor.sh" "$TEST_TMP/non-push.json")
edit_max=$(measure_hook "$ROOT/.claude/hooks/post-edit-lint.sh" "$TEST_TMP/non-edit.json")

binary=$(command -v claude)
version=$(claude --version)
strings "$binary" | grep -F '[end-turn] PostToolBatch block discarded' >/dev/null \
  || { printf 'discard debug string missing\n' >&2; exit 1; }
strings "$binary" | grep -F 'PostToolBatch hooks cancelled (control stream closed)' >/dev/null \
  || { printf 'control stream close debug string missing\n' >&2; exit 1; }

repo="$TEST_TMP/permission-repo"
state="$TEST_TMP/permission-state"
mkdir -m 700 "$repo" "$state"
git -C "$repo" init -q
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.invalid
mkdir -m 755 "$repo/.claude"
printf '.claude/settings.local.json\n.claude/settings.local.json.ark-loop-tmp\n' >"$repo/.gitignore"
git -C "$repo" add .gitignore && git -C "$repo" commit -qm init
claude_settings_inject "$repo" "$state" \
  || { printf 'permission settings injection failed\n' >&2; exit 1; }
settings="$repo/.claude/settings.local.json"
jq -e '.permissions.deny == ["TodoWrite","TaskCreate","TaskUpdate"]' "$settings" >/dev/null \
  || { printf 'permission deny set mismatch\n' >&2; exit 1; }
jq -e '["TaskGet","TaskList","TaskOutput","TaskStop","Task","Agent"] - .permissions.deny | length == 6' "$settings" >/dev/null \
  || { printf 'read/background/subagent permission unexpectedly denied\n' >&2; exit 1; }

failure_provenance=$(find "$ROOT/ark/loop/adapters/claude-code/tests/fixtures" -type f -name 'post-tool-use-failure-provenance-*.txt')
[ "$(printf '%s\n' "$failure_provenance" | grep -c .)" -eq 1 ] \
  || { printf 'failure provenance count mismatch\n' >&2; exit 1; }
failure_version=$(sed -n 's/^claude_version=\([0-9][0-9.]*\) .*/\1/p' "$failure_provenance")
failure_full_version=$(sed -n 's/^claude_version=//p' "$failure_provenance")
failure_binary=$(sed -n 's/^binary=//p' "$failure_provenance")
[ -f "$failure_binary" ] && [ -x "$failure_binary" ] \
  || { printf 'provenance binary unavailable\n' >&2; exit 1; }
[ "$("$failure_binary" --version)" = "$failure_full_version" ] \
  || { printf 'provenance binary version mismatch\n' >&2; exit 1; }

failure_session="$TEST_TMP/failure-session"
mkdir -m 700 "$failure_session" "$failure_session/errors"
failure_max=0
for failure_case in bash-exit-7 mcp-error read-missing; do
  failure_fixture="$ROOT/ark/loop/adapters/claude-code/tests/fixtures/post-tool-use-failure-$failure_case-$failure_version.json"
  i=1
  while [ "$i" -le 20 ]; do
    start=$(now_ns)
    ARK_SESSION_DIR="$failure_session" /bin/bash "$FAILURE_WRAPPER" <"$failure_fixture" \
      >"$TEST_TMP/failure-$failure_case-$i.out" 2>"$TEST_TMP/failure-$failure_case-$i.err"
    finish=$(now_ns)
    elapsed=$(((finish - start) / 1000000))
    [ "$elapsed" -le "$failure_max" ] || failure_max=$elapsed
    i=$((i + 1))
  done
done
[ "$(wc -l <"$failure_session/errors/raw.log" | tr -d ' ')" -eq 60 ] \
  || { printf 'failure wrapper lost an entry\n' >&2; exit 1; }
jq -e -s 'length == 60 and all(.[]; keys_unsorted == ["at","tool","error_type","exit_code","is_interrupt","error","details"])' \
  "$failure_session/errors/raw.log" >/dev/null \
  || { printf 'failure wrapper produced incomplete JSONL\n' >&2; exit 1; }

capture_parallel_session="$TEST_TMP/capture-parallel-session"
mkdir -m 700 "$capture_parallel_session" "$capture_parallel_session/errors"
capture_parallel_fixture="$ROOT/ark/loop/adapters/claude-code/tests/fixtures/post-tool-use-failure-bash-exit-7-$failure_version.json"
capture_parallel_start=$(now_ns)
pids=
i=1
while [ "$i" -le 20 ]; do
  (
    start=$(now_ns)
    ARK_SESSION_DIR="$capture_parallel_session" /bin/bash "$FAILURE_WRAPPER" <"$capture_parallel_fixture" \
      >"$TEST_TMP/capture-parallel-$i.out" 2>"$TEST_TMP/capture-parallel-$i.err"
    finish=$(now_ns)
    printf '%s\n' "$(((finish - start) / 1000000))" >"$TEST_TMP/capture-parallel-$i.ms"
  ) &
  pids="$pids $!"
  i=$((i + 1))
done
for pid in $pids; do wait "$pid" || { printf 'parallel capture wrapper failed\n' >&2; exit 1; }; done
capture_parallel_finish=$(now_ns)
capture_parallel_wall=$(((capture_parallel_finish - capture_parallel_start) / 1000000))
capture_parallel_max=$(awk '{if ($1 > max) max=$1} END {print max+0}' "$TEST_TMP"/capture-parallel-*.ms)
[ "$(wc -l <"$capture_parallel_session/errors/raw.log" | tr -d ' ')" -eq 20 ] \
  || { printf 'parallel capture lost an entry\n' >&2; exit 1; }
jq -e -s 'length == 20' "$capture_parallel_session/errors/raw.log" >/dev/null \
  || { printf 'parallel capture JSONL incomplete\n' >&2; exit 1; }
[ "$failure_max" -le 100 ] \
  || { printf 'capture serial timing exceeded 100ms: serial=%s\n' "$failure_max" >&2; exit 1; }

printf '%s\n' '=== issue-333 live fixture ==='
printf 'claude_version=%s\n' "$version"
printf 'single_field=tool_calls count=%s\n' "$(jq '.tool_calls|length' "$SINGLE")"
printf 'parallel_field=tool_calls count=%s\n' "$(jq '.tool_calls|length' "$PARALLEL")"
printf 'additional_context_attempts=10,20 discard=end-turn/control-stream-close no_retry=11\n'
printf 'deny=TodoWrite,TaskCreate,TaskUpdate\n'
printf 'not_denied=TaskGet,TaskList,TaskOutput,TaskStop,Task,Agent\n'
printf 'timing_ms recite_single_max=%s recite_parallel_max=%s parallel_wall=%s post_push_max=%s post_edit_max=%s\n' \
  "$recite_max" "$parallel_max" "$parallel_wall" "$push_max" "$edit_max"
printf '%s\n' '=== issue-335 live fixture ==='
printf 'failure_binary=%s\n' "$failure_binary"
printf 'failure_version=%s\n' "$failure_full_version"
printf 'failure_entries=60 parallel_entries=20 timing_ms serial_max=%s parallel_max=%s parallel_wall=%s\n' \
  "$failure_max" "$capture_parallel_max" "$capture_parallel_wall"
