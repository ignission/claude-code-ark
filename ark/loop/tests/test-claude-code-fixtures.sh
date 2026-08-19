#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
FIXTURES="$ROOT/ark/loop/adapters/claude-code/tests/fixtures"
FAILURES=0

fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL: %s\n' "$1" >&2
}

assert_fixture() {
  name="$1"
  minimum="$2"
  file="$FIXTURES/$name"
  [ -f "$file" ] || { fail "$name is missing"; return; }
  jq -e 'type == "object" and .hook_event_name == "PostToolBatch"' "$file" >/dev/null 2>&1 \
    || { fail "$name has an invalid PostToolBatch envelope"; return; }

  # Claude Code 2.1.215 の実ダンプでは tool_calls が実 field。production は参照しない。
  count=$(jq -r 'if (.tool_calls | type) == "array" then (.tool_calls | length) else -1 end' "$file" 2>/dev/null)
  [ "$count" -ge "$minimum" ] 2>/dev/null || fail "$name has fewer than $minimum batch entries"
}

assert_fixture post-tool-batch-single-2.1.215.json 1
assert_fixture post-tool-batch-parallel-2.1.215.json 2

catalog="$FIXTURES/tool-catalog-2.1.215.txt"
[ -f "$catalog" ] || fail "tool catalog is missing"
if [ -f "$catalog" ]; then
  # write tools (deny): TodoWrite TaskCreate TaskUpdate
  # read/background/subagent tools (keep): TaskGet TaskList TaskOutput TaskStop Task Agent
  for tool in Agent Task TaskCreate TaskGet TaskList TaskOutput TaskStop TaskUpdate TodoWrite; do
    grep -Fx "$tool" "$catalog" >/dev/null 2>&1 || fail "tool catalog misses $tool"
  done
fi

capture="$ROOT/ark/loop/adapters/claude-code/tests/capture-post-tool-batch.sh"
tmp=$(mktemp -d)
tmp=$(cd "$tmp" && pwd -P)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
printf 'old\n' >"$tmp/out"
printf '{}\n' | "$capture" >/dev/null 2>&1 && fail "capture accepted a missing output variable"
printf '{}\n' | ARK_HOOK_FIXTURE_OUT="$tmp/missing" "$capture" >/dev/null 2>&1 \
  && fail "capture created a missing output file"
ln -s "$tmp/out" "$tmp/link"
printf '{}\n' | ARK_HOOK_FIXTURE_OUT="$tmp/link" "$capture" >/dev/null 2>&1 \
  && fail "capture accepted a symlink"
printf '{}\n' | ARK_HOOK_FIXTURE_OUT="$tmp/out" "$capture" >/dev/null 2>&1 \
  || fail "capture rejected an existing regular file"
[ "$(cat "$tmp/out")" = '{}' ] || fail "capture did not write stdin once"

spec="$ROOT/docs/superpowers/specs/ark-loop-implementation-spec.md"
for phrase in \
  'permission deny の対象は `TodoWrite`、`TaskCreate`、`TaskUpdate` の3件だけ' \
  '`TaskGet` / `TaskList` は read-only' \
  '`TaskOutput` / `TaskStop` は background task' \
  '`Task` / `Agent` は subagent' \
  'additionalContext の出力試行' \
  'delivery receipt ではない' \
  'pending/retry state を作らない' \
  '欠落を次の interval まで補償しない' \
  '`task.md` が唯一の永続正本' \
  '並列 tool call があっても復唱は最大1回' \
  '10 batchごと' \
  '600 bytes以下' \
  'task 全文'; do
  grep -F "$phrase" "$spec" >/dev/null 2>&1 || fail "spec misses: $phrase"
done

if [ "$FAILURES" -ne 0 ]; then
  printf 'claude fixture tests: %s failure(s)\n' "$FAILURES" >&2
  exit 1
fi
printf 'claude fixture tests: PASS\n'
