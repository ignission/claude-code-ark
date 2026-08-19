#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"
. "$ROOT/ark/loop/scripts/lib/runtime.sh"
. "$ROOT/ark/loop/adapters/claude-code/settings.sh"

setup_repo() {
  name=$1
  repo="$TEST_TMP/$name"
  state="$TEST_TMP/$name-state"
  mkdir -m 700 "$repo" "$state"
  git -C "$repo" init -q
  git -C "$repo" config user.name fixture
  git -C "$repo" config user.email fixture@example.invalid
  mkdir -m 755 "$repo/.claude"
  printf '.claude/settings.local.json\n.claude/settings.local.json.ark-loop-tmp\n' >"$repo/.gitignore"
  git -C "$repo" add .gitignore
  git -C "$repo" commit -qm ignore
}

setup_repo existing
settings="$repo/.claude/settings.local.json"
manifest="$state/settings-ownership.json"
printf '{\n  "z-unknown" : "{},[],: 日本語",\n  "permissions" : {\n    "allow": [ "Read" ]\n  },\n  "hooks": { "Stop" : [ {"hooks":[]} ] },\n  "a-last": true\n}\n\n' >"$settings"
chmod 640 "$settings"
cp "$settings" "$TEST_TMP/original"
original_mode=$(loop_stat "$settings" | awk '{print $2}')

run_case claude_settings_inject "$repo" "$state"
assert_success "existing settings injected"
jq -e '.permissions.deny == ["TodoWrite","TaskCreate","TaskUpdate"]' "$settings" >/dev/null 2>&1 \
  || test_fail "deny list is not the three canonical write tools"
jq -e '[.permissions.deny[] | select(. == "TaskGet" or . == "TaskList" or . == "TaskOutput" or . == "TaskStop" or . == "Task" or . == "Agent")] | length == 0' "$settings" >/dev/null 2>&1 \
  || test_fail "read/background/subagent tool was denied"
jq -e '.hooks.PostToolBatch | length == 1 and .[0] | has("matcher") | not' "$settings" >/dev/null 2>&1 \
  || test_fail "PostToolBatch hook is missing or has matcher"
jq -e '.schema_version == 1 and .settings_existed == true and (.entries | length) == 4 and
  [.entries[].path] == ["permissions/deny","permissions/deny","permissions/deny","hooks/PostToolBatch"] and
  all(.entries[]; .abandoned == false)' "$manifest" >/dev/null 2>&1 \
  || test_fail "ownership manifest schema is invalid"
assert_eq "settings mode preserved" "$original_mode" "$(loop_stat "$settings" | awk '{print $2}')"

cp "$settings" "$TEST_TMP/injected"
cp "$manifest" "$TEST_TMP/manifest"
run_case claude_settings_inject "$repo" "$state"
assert_success "second injection succeeds"
cmp -s "$settings" "$TEST_TMP/injected" || test_fail "second injection changed settings"
cmp -s "$manifest" "$TEST_TMP/manifest" || test_fail "second injection changed ownership"

run_case claude_settings_restore "$repo" "$state"
assert_success "existing settings restored"
cmp -s "$settings" "$TEST_TMP/original" || test_fail "restore was not byte-identical"
assert_eq "restored mode" "$original_mode" "$(loop_stat "$settings" | awk '{print $2}')"

setup_repo missing
settings="$repo/.claude/settings.local.json"
run_case claude_settings_inject "$repo" "$state"
assert_success "missing settings injected"
[ -f "$settings" ] || test_fail "missing settings was not created"
run_case claude_settings_restore "$repo" "$state"
assert_success "missing settings restored"
[ ! -e "$settings" ] || test_fail "originally missing settings was not removed"

setup_repo existing-canonical
settings="$repo/.claude/settings.local.json"
hook='{"hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/ark/loop/adapters/claude-code/post-tool-batch.sh"}]}'
jq -n --argjson hook "$hook" '{permissions:{deny:["TodoWrite","TaskCreate","TaskUpdate"]},hooks:{PostToolBatch:[$hook]}}' >"$settings"
chmod 600 "$settings"
cp "$settings" "$TEST_TMP/canonical"
run_case claude_settings_inject "$repo" "$state"
assert_success "canonical entries are idempotent"
cmp -s "$settings" "$TEST_TMP/canonical" || test_fail "canonical settings changed"
[ ! -e "$state/settings-ownership.json" ] || test_fail "pre-existing entries were recorded as owned"

setup_repo session-change
settings="$repo/.claude/settings.local.json"
printf '{"existing":1}\n' >"$settings"; chmod 600 "$settings"
run_case claude_settings_inject "$repo" "$state"
assert_success "session-change fixture injected"
content=$(cat "$settings")
printf '%s\n' "${content%\}},\"user-added\":true}" >"$settings"
chmod 600 "$settings"
run_case claude_settings_restore "$repo" "$state"
assert_success "session change restored"
jq -e '.existing == 1 and .["user-added"] == true and (.permissions | not) and (.hooks | not)' "$settings" >/dev/null 2>&1 \
  || test_fail "restore lost non-Ark session changes"

finish_tests claude-settings
