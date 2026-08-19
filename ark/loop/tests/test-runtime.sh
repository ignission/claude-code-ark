#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
# shellcheck source=test-helper.sh
. "$ROOT/ark/loop/tests/test-helper.sh"
# shellcheck source=../scripts/lib/runtime.sh
. "$ROOT/ark/loop/scripts/lib/runtime.sh"

repo="$TEST_TMP/repo-日本語"
mkdir -m 700 "$repo"
git -C "$repo" init -q
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.invalid
mkdir -m 755 "$repo/.claude"

HOME="$TEST_TMP/home"
mkdir -m 700 "$HOME"
export HOME
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
run_case loop_runtime_resolve "$repo" 0123456789abcdef0123456789abcdef
assert_success "default paths resolve"
assert_eq "default config" "$HOME/.config/ark/loop/config.toml" "$LOOP_CONFIG_FILE"
assert_eq "default data" "$HOME/.local/share/ark/loop" "$LOOP_DATA_ROOT"
assert_eq "default cache" "$HOME/.cache/ark/loop/0123456789abcdef0123456789abcdef" "$ARK_CACHE_DIR"
assert_eq "default knowledge" "$HOME/.local/share/ark/loop/knowledge" "$ARK_KNOWLEDGE_DIR"
assert_eq "canonical repo" "$repo" "$ARK_REPO"
assert_eq "repo key format" 64 "${#ARK_REPO_KEY}"
case "$ARK_REPO_KEY" in *[!0-9a-f]*) test_fail "repo key is not lowercase hex" ;; *) TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)) ;; esac
first_key=$ARK_REPO_KEY

XDG_CONFIG_HOME="$TEST_TMP/config"
XDG_DATA_HOME="$TEST_TMP/data"
XDG_CACHE_HOME="$TEST_TMP/cache"
export XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
run_case loop_runtime_resolve "$repo" fedcba9876543210fedcba9876543210
assert_success "XDG overrides resolve"
assert_eq "override config" "$XDG_CONFIG_HOME/ark/loop/config.toml" "$LOOP_CONFIG_FILE"
assert_eq "repo key ignores session" "$first_key" "$ARK_REPO_KEY"
assert_eq "override repo state" "$XDG_DATA_HOME/ark/loop/repos/$first_key" "$LOOP_REPO_STATE_DIR"

chmod 775 "$repo/.claude"
run_case loop_validate_repo_path "$repo/.claude" directory required
assert_failure_reason "group-writable repo path rejected" "unsafe repo path"
chmod 755 "$repo/.claude"
run_case loop_validate_repo_path "$repo/.claude" directory required
assert_success "current-owner repo directory 0755 accepted"

unsafe="$TEST_TMP/unsafe"
mkdir -m 755 "$unsafe"
run_case loop_validate_xdg_dir "$unsafe"
assert_failure_reason "XDG directory 0755 rejected" "unsafe XDG directory"
safe="$TEST_TMP/safe"
mkdir -m 700 "$safe"
run_case loop_validate_xdg_dir "$safe"
assert_success "XDG directory 0700 accepted"
printf x >"$TEST_TMP/file"
chmod 644 "$TEST_TMP/file"
run_case loop_validate_xdg_file "$TEST_TMP/file"
assert_failure_reason "XDG file 0644 rejected" "unsafe XDG file"
ln -s "$safe" "$TEST_TMP/link"
run_case loop_validate_xdg_dir "$TEST_TMP/link"
assert_failure_reason "XDG symlink rejected" "unsafe XDG directory"

finish_tests runtime
