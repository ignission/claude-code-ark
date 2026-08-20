#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"
. "$ROOT/ark/loop/scripts/lib/runtime.sh"
. "$ROOT/ark/loop/adapters/claude-code/settings.sh"

batch_hook='{"hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/ark/loop/adapters/claude-code/post-tool-batch.sh"}]}'
failure_hook='{"hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/ark/loop/adapters/claude-code/post-tool-use-failure.sh"}]}'

assert_eq "mode extraction rejects empty output in both paths" 2 \
  "$(grep -c '\[ -n "\$mode" \] || return 1' "$ROOT/ark/loop/adapters/claude-code/settings.sh" | tr -d ' ')"

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
jq -e '(.hooks.PostToolBatch | length) == 1 and (.hooks.PostToolBatch[0] | has("matcher") | not)' "$settings" >/dev/null 2>&1 \
  || test_fail "PostToolBatch hook is missing or has matcher"
jq -e '(.hooks.PostToolUseFailure | length) == 1 and (.hooks.PostToolUseFailure[0] | has("matcher") | not)' "$settings" >/dev/null 2>&1 \
  || test_fail "PostToolUseFailure hook is missing or has matcher"
jq -e '.schema_version == 1 and .settings_existed == true and (.entries | length) == 5 and
  ([.entries[].path] | sort) == ["hooks/PostToolBatch","hooks/PostToolUseFailure","permissions/deny","permissions/deny","permissions/deny"] and
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
if ! cmp -s "$settings" "$TEST_TMP/original"; then
  test_fail "restore was not byte-identical"
  diff -u "$TEST_TMP/original" "$settings" >&2 || true
fi
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
jq -n --argjson batch "$batch_hook" --argjson failure "$failure_hook" \
  '{permissions:{deny:["TodoWrite","TaskCreate","TaskUpdate"]},hooks:{PostToolBatch:[$batch],PostToolUseFailure:[$failure]}}' >"$settings"
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

setup_repo batch-only
settings="$repo/.claude/settings.local.json"
jq -n --argjson batch "$batch_hook" \
  '{permissions:{deny:["TodoWrite","TaskCreate","TaskUpdate"]},hooks:{PostToolBatch:[$batch]}}' >"$settings"
chmod 600 "$settings"
cp "$settings" "$TEST_TMP/batch-only-original"
run_case claude_settings_inject "$repo" "$state"
assert_success "batch-only settings injected"
jq -e --argjson batch "$batch_hook" --argjson failure "$failure_hook" '
  .hooks.PostToolBatch == [$batch] and .hooks.PostToolUseFailure == [$failure]
' "$settings" >/dev/null 2>&1 || test_fail "batch-only settings did not gain canonical failure hook"
jq -e --argjson failure "$failure_hook" '
  .entries == [{path:"hooks/PostToolUseFailure",value:$failure,abandoned:false}]
' "$state/settings-ownership.json" >/dev/null 2>&1 \
  || test_fail "batch-only manifest owns more than the added failure hook"
run_case claude_settings_restore "$repo" "$state"
assert_success "batch-only settings restored"
cmp -s "$settings" "$TEST_TMP/batch-only-original" || test_fail "batch-only restore was not byte-identical"

setup_repo existing-failure-hook
settings="$repo/.claude/settings.local.json"
user_failure='{"hooks":[{"type":"command","command":"user-failure-hook.sh"}]}'
jq -n --argjson user "$user_failure" \
  '{permissions:{deny:["TodoWrite","TaskCreate","TaskUpdate"]},hooks:{PostToolBatch:[],PostToolUseFailure:[$user]}}' >"$settings"
chmod 640 "$settings"
cp "$settings" "$TEST_TMP/existing-failure-original"
run_case claude_settings_inject "$repo" "$state"
assert_success "existing failure hook injected"
jq -e --argjson user "$user_failure" --argjson batch "$batch_hook" --argjson failure "$failure_hook" '
  .hooks.PostToolBatch == [$batch]
  and .hooks.PostToolUseFailure == [$user,$failure]
' "$settings" >/dev/null 2>&1 || test_fail "existing failure hook was not preserved"
jq -e '([.entries[].path] | sort) == ["hooks/PostToolBatch","hooks/PostToolUseFailure"]' \
  "$state/settings-ownership.json" >/dev/null 2>&1 \
  || test_fail "existing failure manifest paths mismatch"
run_case claude_settings_restore "$repo" "$state"
assert_success "existing failure hook restored"
cmp -s "$settings" "$TEST_TMP/existing-failure-original" || test_fail "existing failure restore was not byte-identical"
assert_eq "existing failure mode restored" 640 "$(loop_stat "$settings" | awk '{print $2}')"

setup_repo canonical-failure
settings="$repo/.claude/settings.local.json"
jq -n --argjson failure "$failure_hook" \
  '{permissions:{deny:["TodoWrite","TaskCreate","TaskUpdate"]},hooks:{PostToolUseFailure:[$failure]}}' >"$settings"
chmod 600 "$settings"
run_case claude_settings_inject "$repo" "$state"
assert_success "canonical failure remains unique"
jq -e --argjson failure "$failure_hook" --argjson batch "$batch_hook" '
  .hooks.PostToolUseFailure == [$failure] and .hooks.PostToolBatch == [$batch]
' "$settings" >/dev/null 2>&1 || test_fail "canonical failure was duplicated"
jq -e '.entries == [{path:"hooks/PostToolBatch",value:.entries[0].value,abandoned:false}]' \
  "$state/settings-ownership.json" >/dev/null 2>&1 \
  || test_fail "canonical failure was incorrectly recorded as owned"

setup_repo invalid-schema
settings="$repo/.claude/settings.local.json"
printf '{"permissions":{"deny":"not-an-array"}}\n' >"$settings"; chmod 600 "$settings"
cp "$settings" "$TEST_TMP/invalid-before"
run_case claude_settings_inject "$repo" "$state"
assert_failure_reason "invalid settings schema rejected" "invalid Claude settings schema"
cmp -s "$settings" "$TEST_TMP/invalid-before" || test_fail "invalid settings was modified"
[ ! -e "$state/settings-ownership.json" ] || test_fail "invalid settings created ownership"
[ ! -e "$repo/.claude/settings.local.json.ark-loop-tmp" ] || test_fail "invalid settings created tmp"

setup_repo invalid-failure-schema
settings="$repo/.claude/settings.local.json"
printf '{"hooks":{"PostToolUseFailure":{}}}\n' >"$settings"; chmod 600 "$settings"
cp "$settings" "$TEST_TMP/invalid-failure-before"
run_case claude_settings_inject "$repo" "$state"
assert_failure_reason "invalid failure hook schema rejected" "invalid Claude settings schema"
cmp -s "$settings" "$TEST_TMP/invalid-failure-before" || test_fail "invalid failure settings was modified"

setup_repo no-jq
settings="$repo/.claude/settings.local.json"
printf '{}\n' >"$settings"; chmod 600 "$settings"
empty_path="$TEST_TMP/empty-path"; mkdir -m 700 "$empty_path"
run_case env PATH="$empty_path" /bin/bash -c '. "$1"; . "$2"; claude_settings_inject "$3" "$4"' \
  settings-no-jq "$ROOT/ark/loop/scripts/lib/runtime.sh" "$ROOT/ark/loop/adapters/claude-code/settings.sh" "$repo" "$state"
assert_failure_reason "missing jq rejected before writes" "jq command unavailable"
assert_eq "missing jq leaves settings" '{}' "$(cat "$settings")"
[ ! -e "$state/settings-ownership.json" ] || test_fail "missing jq created ownership"

setup_repo interrupted
settings="$repo/.claude/settings.local.json"
printf '{"before":true}\n' >"$settings"; chmod 600 "$settings"
cp "$settings" "$TEST_TMP/interrupted-original"
run_case claude_settings_inject "$repo" "$state"
assert_success "interruption fixture injected"
cp "$state/settings-ownership.json" "$TEST_TMP/interrupted-manifest"
cp "$TEST_TMP/interrupted-original" "$settings"; chmod 600 "$settings"
run_case claude_settings_restore "$repo" "$state"
assert_success "manifest-before-settings interruption converges"
cmp -s "$settings" "$TEST_TMP/interrupted-original" || test_fail "interrupted restore changed original"
[ ! -e "$state/settings-ownership.json" ] || test_fail "interrupted ownership remained"

setup_repo changed-owner
settings="$repo/.claude/settings.local.json"
printf '{}\n' >"$settings"; chmod 600 "$settings"
run_case claude_settings_inject "$repo" "$state"
assert_success "changed-owner fixture injected"
content=$(cat "$settings")
content=${content/post-tool-use-failure.sh/changed-by-user.sh}
printf '%s\n' "$content" >"$settings"; chmod 600 "$settings"
run_case claude_settings_restore "$repo" "$state"
assert_success "changed owner entry does not block restore"
jq -e '.hooks.PostToolUseFailure[0].hooks[0].command | endswith("changed-by-user.sh")' "$settings" >/dev/null 2>&1 \
  || test_fail "changed owner hook was removed"
jq -e 'any(.entries[]; .path == "hooks/PostToolUseFailure" and .abandoned == true)
  and all(.entries[]; select(.path != "hooks/PostToolUseFailure") | .abandoned == false)' "$state/settings-ownership.json" >/dev/null 2>&1 \
  || test_fail "changed owner hook was not abandoned"
jq -e '(.hooks.PostToolBatch // []) | length == 0' "$settings" >/dev/null 2>&1 \
  || test_fail "unchanged batch hook was not restored"

assert_preflight_rejects() {
  description=$1
  cp "$repo/.gitignore" "$TEST_TMP/preflight-ignore"
  if [ -f "$repo/.claude/settings.local.json" ]; then cp "$repo/.claude/settings.local.json" "$TEST_TMP/preflight-settings"; had_settings=1; else had_settings=0; fi
  before_status=$(git -C "$repo" status --short --ignored)
  run_case claude_settings_inject "$repo" "$state"
  if [ "$CASE_STATUS" -eq 0 ]; then test_fail "$description was accepted"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi
  cmp -s "$repo/.gitignore" "$TEST_TMP/preflight-ignore" || test_fail "$description changed .gitignore"
  if [ "$had_settings" -eq 1 ]; then cmp -s "$repo/.claude/settings.local.json" "$TEST_TMP/preflight-settings" || test_fail "$description changed settings"; fi
  assert_eq "$description preserves status" "$before_status" "$(git -C "$repo" status --short --ignored)"
  [ ! -e "$state/settings-ownership.json" ] || test_fail "$description created ownership"
}

setup_repo unsafe-claude
chmod 775 "$repo/.claude"
assert_preflight_rejects "group-writable .claude"

setup_repo settings-symlink
ln -s "$ROOT/package.json" "$repo/.claude/settings.local.json"
assert_preflight_rejects "settings symlink"

setup_repo unsafe-tmp
printf '{}\n' >"$repo/.claude/settings.local.json"; chmod 600 "$repo/.claude/settings.local.json"
ln -s "$ROOT/package.json" "$repo/.claude/settings.local.json.ark-loop-tmp"
assert_preflight_rejects "tmp symlink"

setup_repo ignore-missing
printf '.claude/settings.local.json\n' >"$repo/.gitignore"
git -C "$repo" add .gitignore && git -C "$repo" commit -qm missing
assert_preflight_rejects "missing exact tmp ignore"

setup_repo ignore-wildcard
printf '.claude/settings.local.json*\n' >"$repo/.gitignore"
git -C "$repo" add .gitignore && git -C "$repo" commit -qm wildcard
assert_preflight_rejects "wildcard-only ignore"

setup_repo tracked-settings
printf '{}\n' >"$repo/.claude/settings.local.json"; chmod 600 "$repo/.claude/settings.local.json"
git -C "$repo" add -f .claude/settings.local.json && git -C "$repo" commit -qm tracked
assert_preflight_rejects "tracked settings"

setup_repo safe-orphan
printf '{}\n' >"$repo/.claude/settings.local.json.ark-loop-tmp"; chmod 600 "$repo/.claude/settings.local.json.ark-loop-tmp"
run_case claude_settings_inject "$repo" "$state"
assert_success "safe orphan tmp is recovered"
[ ! -e "$repo/.claude/settings.local.json.ark-loop-tmp" ] || test_fail "safe orphan tmp remained"

finish_tests claude-settings
