#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
WRAPPER="$ROOT/ark/loop/adapters/claude-code/post-tool-batch.sh"
SINGLE="$ROOT/ark/loop/adapters/claude-code/tests/fixtures/post-tool-batch-single-2.1.215.json"
PARALLEL="$ROOT/ark/loop/adapters/claude-code/tests/fixtures/post-tool-batch-parallel-2.1.215.json"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/scripts/lib/runtime.sh"
. "$ROOT/ark/loop/adapters/claude-code/settings.sh"
. "$ROOT/ark/loop/tests/test-helper.sh"

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

binary=$(readlink -f "$(command -v claude)")
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
claude_settings_inject "$repo" "$state"
settings="$repo/.claude/settings.local.json"
jq -e '.permissions.deny == ["TodoWrite","TaskCreate","TaskUpdate"]' "$settings" >/dev/null
jq -e '["TaskGet","TaskList","TaskOutput","TaskStop","Task","Agent"] - .permissions.deny | length == 6' "$settings" >/dev/null

printf '%s\n' '=== issue-333 live fixture ==='
printf 'claude_version=%s\n' "$version"
printf 'single_field=tool_calls count=%s\n' "$(jq '.tool_calls|length' "$SINGLE")"
printf 'parallel_field=tool_calls count=%s\n' "$(jq '.tool_calls|length' "$PARALLEL")"
printf 'additional_context_attempts=10,20 discard=end-turn/control-stream-close no_retry=11\n'
printf 'deny=TodoWrite,TaskCreate,TaskUpdate\n'
printf 'not_denied=TaskGet,TaskList,TaskOutput,TaskStop,Task,Agent\n'
printf 'timing_ms recite_single_max=%s recite_parallel_max=%s parallel_wall=%s post_push_max=%s post_edit_max=%s\n' \
  "$recite_max" "$parallel_max" "$parallel_wall" "$push_max" "$edit_max"
