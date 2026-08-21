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
  jq -e '(.transcript_path | type) == "string" and (.transcript_path | startswith("<workspace>/"))' \
    "$file" >/dev/null 2>&1 || fail "$name transcript path is not anonymized"
}

assert_fixture post-tool-batch-single-2.1.215.json 1
assert_fixture post-tool-batch-parallel-2.1.215.json 2

failure_provenance=$(find "$FIXTURES" -type f -name 'post-tool-use-failure-provenance-*.txt' | LC_ALL=C sort)
[ "$(printf '%s\n' "$failure_provenance" | grep -c .)" -eq 1 ] 2>/dev/null \
  || fail "exactly one PostToolUseFailure provenance file is required"
failure_version=
if [ -n "$failure_provenance" ] && [ -f "$failure_provenance" ]; then
  full_version=$(sed -n 's/^claude_version=//p' "$failure_provenance")
  failure_version=${full_version%% *}
  [ -n "$failure_version" ] || fail "failure provenance misses claude_version"
  [ "$(basename "$failure_provenance")" = "post-tool-use-failure-provenance-$failure_version.txt" ] \
    || fail "failure provenance suffix does not match claude_version"
  grep -E '^binary=<workspace>/node_modules/\.pnpm/@anthropic-ai\+claude-code-[^/]+@[^/]+/node_modules/@anthropic-ai/claude-code-[^/]+/claude$' "$failure_provenance" >/dev/null 2>&1 \
    || fail "failure provenance misses the resolved platform package binary path"
  grep -E '^package=@anthropic-ai/claude-code-(darwin|linux)-' "$failure_provenance" >/dev/null 2>&1 \
    || fail "failure provenance misses the platform package"
  grep -E '^platform=(darwin|linux)$' "$failure_provenance" >/dev/null 2>&1 \
    || fail "failure provenance has an unsupported platform"
  grep -E '^arch=(arm64|x64)$' "$failure_provenance" >/dev/null 2>&1 \
    || fail "failure provenance has an unsupported architecture"
  grep -Fx 'version_exit_code=0' "$failure_provenance" >/dev/null 2>&1 \
    || fail "failure provenance version command did not exit zero"
fi

# Claude Code 2.1.237 linux-arm64 の実ダンプ field 表（3 case 共通）:
# session_id:string, transcript_path:string, cwd:string, prompt_id:string,
# permission_mode:string, effort:object, hook_event_name:string, tool_name:string,
# tool_input:object, tool_use_id:string, error:string, is_interrupt:boolean,
# duration_ms:number。error_type / exit_code / tool_response field は存在しない。
# is_interrupt は実fixtureでは全件false。正規化coreのnullはfield不在を表し、
# fixtureに無い別名fieldから補完しない（このversionのenvelopeでは不在をinvalidとする）。
failure_keys='["session_id","transcript_path","cwd","prompt_id","permission_mode","effort","hook_event_name","tool_name","tool_input","tool_use_id","error","is_interrupt","duration_ms"]'
assert_failure_fixture() {
  case_name=$1
  expected_tool=$2
  expected_error=$3
  fixture="$FIXTURES/post-tool-use-failure-$case_name-$failure_version.json"
  [ -f "$fixture" ] || { fail "$case_name failure fixture is missing"; return; }
  [ "$(basename "$fixture")" = "post-tool-use-failure-$case_name-$failure_version.json" ] \
    || fail "$case_name failure fixture suffix mismatch"
  jq -e --argjson keys "$failure_keys" --arg tool "$expected_tool" --arg error "$expected_error" '
    type == "object"
    and keys_unsorted == $keys
    and .hook_event_name == "PostToolUseFailure"
    and .tool_name == $tool
    and .error == $error
    and (.session_id | type) == "string"
    and (.transcript_path | type) == "string"
    and (.cwd | type) == "string"
    and (.prompt_id | type) == "string"
    and (.permission_mode | type) == "string"
    and (.effort | type) == "object"
    and (.tool_input | type) == "object"
    and (.tool_use_id | type) == "string"
    and (.is_interrupt | type) == "boolean"
    and .is_interrupt == false
    and (.duration_ms | type) == "number"
    and (has("error_type") | not)
    and (has("exit_code") | not)
    and (has("tool_response") | not)
  ' "$fixture" >/dev/null 2>&1 || fail "$case_name failure fixture field contract mismatch"
  grep -F "${case_name}_capture_count=1" "$failure_provenance" >/dev/null 2>&1 \
    || fail "$case_name capture count is not one"
}

if [ -n "$failure_version" ]; then
  assert_failure_fixture bash-exit-7 Bash 'Exit code 7'
  assert_failure_fixture mcp-error mcp__fixture__fixture_fail 'fixture MCP error'
  assert_failure_fixture read-missing Read 'File does not exist. Note: your current working directory is <fixture-tmp>/repo.'
  jq -e '.tool_input.command == "/bin/sh -c '\''exit 7'\''"' \
    "$FIXTURES/post-tool-use-failure-bash-exit-7-$failure_version.json" >/dev/null 2>&1 \
    || fail "Bash fixture command mismatch"
  grep -Fx 'bash-exit-7_normalized_exit_code=7' "$failure_provenance" >/dev/null 2>&1 \
    || fail "Bash fixture does not fix the observed exit code source"
  grep -Fx 'bash-exit-7_exit_code_source=error_exact_Exit_code_integer' "$failure_provenance" >/dev/null 2>&1 \
    || fail "Bash fixture exit code source mismatch"
  for case_name in mcp-error read-missing; do
    grep -Fx "${case_name}_normalized_exit_code=null" "$failure_provenance" >/dev/null 2>&1 \
      || fail "$case_name must normalize exit code to null"
  done

  provenance_binary=$(sed -n 's/^binary=//p' "$failure_provenance")
  provenance_package=$(sed -n 's/^package=//p' "$failure_provenance")
  provenance_platform=$(sed -n 's/^platform=//p' "$failure_provenance")
  provenance_arch=$(sed -n 's/^arch=//p' "$failure_provenance")
  for case_name in permission-deny validation-rejection; do
    evidence="$FIXTURES/post-tool-use-failure-$case_name-$failure_version.txt"
    [ -f "$evidence" ] || { fail "$case_name non-firing evidence is missing"; continue; }
    grep -Fx "claude_version=$full_version" "$evidence" >/dev/null 2>&1 \
      || fail "$case_name version mismatch"
    grep -Fx "binary=$provenance_binary" "$evidence" >/dev/null 2>&1 \
      || fail "$case_name binary mismatch"
    grep -Fx "package=$provenance_package" "$evidence" >/dev/null 2>&1 \
      || fail "$case_name package mismatch"
    grep -Fx "platform=$provenance_platform" "$evidence" >/dev/null 2>&1 \
      || fail "$case_name platform mismatch"
    grep -Fx "arch=$provenance_arch" "$evidence" >/dev/null 2>&1 \
      || fail "$case_name architecture mismatch"
    grep -Fx "case=$case_name" "$evidence" >/dev/null 2>&1 \
      || fail "$case_name case marker mismatch"
    grep -Fx 'post_tool_use_failure_invocations=0' "$evidence" >/dev/null 2>&1 \
      || fail "$case_name invocation count is not zero"
    grep -Fx 'capture_bytes=0' "$evidence" >/dev/null 2>&1 \
      || fail "$case_name capture output was not empty"
    grep -Fx 'reason=PostToolUseFailure did not fire' "$evidence" >/dev/null 2>&1 \
      || fail "$case_name non-firing reason mismatch"
    [ ! -e "$FIXTURES/post-tool-use-failure-$case_name-$failure_version.json" ] \
      || fail "$case_name must remain txt evidence, not an inferred JSON event"
  done
  grep -E '^tool_result_type=(no_such_tool_available_bash_disabled|tool_catalog_excluded_bash_by_deny)$' \
    "$FIXTURES/post-tool-use-failure-permission-deny-$failure_version.txt" >/dev/null 2>&1 \
    || fail "permission deny evidence misses the observed outcome"
  grep -Fx 'tool_result_type=InputValidationError' \
    "$FIXTURES/post-tool-use-failure-validation-rejection-$failure_version.txt" >/dev/null 2>&1 \
    || fail "validation evidence misses InputValidationError"
  grep -Fx 'mcp_tools_call_invocations=0' \
    "$FIXTURES/post-tool-use-failure-validation-rejection-$failure_version.txt" >/dev/null 2>&1 \
    || fail "validation rejection reached the MCP server"
  # Unknown tools, PermissionDenied 等の推測 event は補完しない。学習対象化は独立 Issue。
fi

if grep -R -E '/(home|Users)/[^/]+' "$FIXTURES" >/dev/null 2>&1; then
  fail "Claude Code fixtures contain an absolute local home path"
fi

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

failure_capture="$ROOT/ark/loop/adapters/claude-code/tests/capture-post-tool-use-failure.sh"
printf 'old\n' >"$tmp/failure-out"
chmod 600 "$tmp/failure-out"
printf '{}\n' | "$failure_capture" >/dev/null 2>&1 \
  && fail "failure capture accepted a missing output variable"
printf '{}\n' | ARK_HOOK_FIXTURE_OUT="$tmp/failure-missing" "$failure_capture" >/dev/null 2>&1 \
  && fail "failure capture created a missing output file"
ln -s "$tmp/failure-out" "$tmp/failure-link"
printf '{}\n' | ARK_HOOK_FIXTURE_OUT="$tmp/failure-link" "$failure_capture" >/dev/null 2>&1 \
  && fail "failure capture accepted a symlink"
printf '{"once":true}\n' | ARK_HOOK_FIXTURE_OUT="$tmp/failure-out" "$failure_capture" >/dev/null 2>&1 \
  || fail "failure capture rejected an existing regular file"
[ "$(cat "$tmp/failure-out")" = '{"once":true}' ] || fail "failure capture did not save stdin once"
printf '{"twice":true}\n' | ARK_HOOK_FIXTURE_OUT="$tmp/failure-out" "$failure_capture" >/dev/null 2>&1 \
  && fail "failure capture accepted a second process for one output"
[ "$(cat "$tmp/failure-out")" = '{"once":true}' ] || fail "failure capture changed output after reuse"

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
