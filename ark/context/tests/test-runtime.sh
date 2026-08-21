#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
# shellcheck source=test-helper.sh
. "$ROOT/ark/context/tests/test-helper.sh"
# shellcheck source=../scripts/lib/runtime.sh
. "$ROOT/ark/context/scripts/lib/runtime.sh"

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
CASE_STDOUT="$TEST_TMP/default.stdout"
CASE_STDERR="$TEST_TMP/default.stderr"
ctx_runtime_resolve "$repo" 0123456789abcdef0123456789abcdef >"$CASE_STDOUT" 2>"$CASE_STDERR"
CASE_STATUS=$?
assert_success "default paths resolve"
assert_eq "default config" "$HOME/.config/ark/context/config.toml" "$CTX_CONFIG_FILE"
assert_eq "default data" "$HOME/.local/share/ark/context" "$CTX_DATA_ROOT"
assert_eq "default cache" "$HOME/.cache/ark/context/0123456789abcdef0123456789abcdef" "$ARK_CACHE_DIR"
assert_eq "default knowledge" "$HOME/.local/share/ark/context/knowledge" "$ARK_KNOWLEDGE_DIR"
assert_eq "canonical repo" "$repo" "$ARK_REPO"
assert_eq "repo key format" 64 "${#ARK_REPO_KEY}"
case "$ARK_REPO_KEY" in *[!0-9a-f]*) test_fail "repo key is not lowercase hex" ;; *) TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)) ;; esac
first_key=$ARK_REPO_KEY

XDG_CONFIG_HOME="$TEST_TMP/config"
XDG_DATA_HOME="$TEST_TMP/data"
XDG_CACHE_HOME="$TEST_TMP/cache"
export XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
CASE_STDOUT="$TEST_TMP/override.stdout"
CASE_STDERR="$TEST_TMP/override.stderr"
ctx_runtime_resolve "$repo" fedcba9876543210fedcba9876543210 >"$CASE_STDOUT" 2>"$CASE_STDERR"
CASE_STATUS=$?
assert_success "XDG overrides resolve"
assert_eq "override config" "$XDG_CONFIG_HOME/ark/context/config.toml" "$CTX_CONFIG_FILE"
assert_eq "repo key ignores session" "$first_key" "$ARK_REPO_KEY"
assert_eq "override repo state" "$XDG_DATA_HOME/ark/context/repos/$first_key" "$CTX_REPO_STATE_DIR"

chmod 775 "$repo/.claude"
run_case ctx_validate_repo_path "$repo/.claude" directory required
assert_failure_reason "group-writable repo path rejected" "unsafe repo path"
chmod 755 "$repo/.claude"
run_case ctx_validate_repo_path "$repo/.claude" directory required
assert_success "current-owner repo directory 0755 accepted"

unsafe="$TEST_TMP/unsafe"
mkdir -m 755 "$unsafe"
run_case ctx_validate_xdg_dir "$unsafe"
assert_failure_reason "XDG directory 0755 rejected" "unsafe XDG directory"
safe="$TEST_TMP/safe"
mkdir -m 700 "$safe"
run_case ctx_validate_xdg_dir "$safe"
assert_success "XDG directory 0700 accepted"
printf x >"$TEST_TMP/file"
chmod 644 "$TEST_TMP/file"
run_case ctx_validate_xdg_file "$TEST_TMP/file"
assert_failure_reason "XDG file 0644 rejected" "unsafe XDG file"
ln -s "$safe" "$TEST_TMP/link"
run_case ctx_validate_xdg_dir "$TEST_TMP/link"
assert_failure_reason "XDG symlink rejected" "unsafe XDG directory"

known=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
assert_eq "sha256sum backend" "$known" "$(ctx_sha256 abc)"
stub="$TEST_TMP/stub"
mkdir -m 700 "$stub"
printf '#!/bin/sh\nprintf "%s  -\\n"\n' "$known" >"$stub/shasum"
printf '#!/bin/sh\nread first rest\nprintf "%%s\\n" "$first"\n' >"$stub/awk"
chmod 700 "$stub/shasum" "$stub/awk"
run_case env PATH="$stub" /bin/bash -c '. "$1"; ctx_sha256 abc' runtime "$ROOT/ark/context/scripts/lib/runtime.sh"
assert_success "shasum backend"
assert_eq "shasum output" "$known" "$(cat "$CASE_STDOUT")"
rm -f "$stub/shasum" "$stub/awk"
printf '#!/bin/sh\nprintf "SHA2-256(stdin)= %s\\n"\n' "$known" >"$stub/openssl"
printf '#!/bin/sh\nread line\nprintf "%%s\\n" "${line##*= }"\n' >"$stub/sed"
chmod 700 "$stub/openssl" "$stub/sed"
run_case env PATH="$stub" /bin/bash -c '. "$1"; ctx_sha256 abc' runtime "$ROOT/ark/context/scripts/lib/runtime.sh"
assert_success "openssl backend"
assert_eq "openssl output" "$known" "$(cat "$CASE_STDOUT")"
rm -f "$stub/openssl" "$stub/sed"
run_case env PATH="$stub" /bin/bash -c '. "$1"; ctx_sha256 abc' runtime "$ROOT/ark/context/scripts/lib/runtime.sh"
assert_failure_reason "missing SHA backend rejected" "sha256 command unavailable"

bsd_stat_case() {
  stat() {
    if [ "$1" = -c ]; then return 1; fi
    printf '%s 0700\n' "$(id -u)"
  }
  ctx_validate_xdg_dir "$safe"
}
run_case bsd_stat_case
assert_success "BSD stat fallback accepted"

foreign_owner_case() {
  stat() { printf '99999 0700\n'; }
  ctx_validate_xdg_dir "$safe"
}
run_case foreign_owner_case
assert_failure_reason "foreign owner rejected" "unsafe XDG directory"

finish_tests runtime
