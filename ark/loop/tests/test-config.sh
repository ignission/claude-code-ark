#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"
. "$ROOT/ark/loop/scripts/lib/runtime.sh"
. "$ROOT/ark/loop/scripts/lib/config.sh"

expected='[loop]
recite_interval = 10

[loop.summarize]
# LLM summary is opt-in because it may incur usage charges.
llm = false'
assert_eq "config template bytes" "$expected" "$(cat "$ROOT/ark/loop/templates/config.toml.tmpl")"

repo="$TEST_TMP/repo"
mkdir -m 700 "$repo"
git -C "$repo" init -q
HOME="$TEST_TMP/home"
export HOME
mkdir -m 700 "$HOME"
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
loop_runtime_resolve "$repo" 0123456789abcdef0123456789abcdef >/dev/null

run_case loop_config_ensure
assert_success "missing config created"
[ -f "$LOOP_CONFIG_FILE" ] || test_fail "config was not created"
assert_eq "created template" "$expected" "$(cat "$LOOP_CONFIG_FILE")"
assert_eq "created mode" 600 "$(loop_stat "$LOOP_CONFIG_FILE" | awk '{print $2}')"
before=$(cat "$LOOP_CONFIG_FILE")
run_case loop_config_ensure
assert_success "existing config retained"
assert_eq "existing config bytes retained" "$before" "$(cat "$LOOP_CONFIG_FILE")"

printf '[loop]\nrecite_interval = 3 # fast\n\n[loop.summarize]\nrecite_interval = 99\n' >"$LOOP_CONFIG_FILE"
chmod 600 "$LOOP_CONFIG_FILE"
run_case loop_config_read_recite_interval
assert_success "valid interval parsed"
assert_eq "interval from loop table" 3 "$(cat "$CASE_STDOUT")"

for bad in 'recite_interval = 0' 'recite_interval = -1' 'recite_interval = nope' \
  'recite_interval = 1.5' 'recite_interval = 2\nrecite_interval = 3'; do
  printf '[loop]\n%b\n' "$bad" >"$LOOP_CONFIG_FILE"
  chmod 600 "$LOOP_CONFIG_FILE"
  run_case loop_config_read_recite_interval
  assert_failure_reason "invalid interval rejected: $bad" "invalid recite_interval"
done

printf '[loop]\nname = "keep"\n\n[future]\nvalue = 7\n' >"$LOOP_CONFIG_FILE"
chmod 600 "$LOOP_CONFIG_FILE"
run_case loop_config_read_recite_interval
assert_success "unknown config retained"
assert_eq "missing interval defaults" 10 "$(cat "$CASE_STDOUT")"

rm -f "$LOOP_CONFIG_FILE"
ln -s "$ROOT/package.json" "$LOOP_CONFIG_FILE"
run_case loop_config_ensure
assert_failure_reason "config symlink rejected" "unsafe XDG file"
rm -f "$LOOP_CONFIG_FILE"
printf '[loop]\n' >"$LOOP_CONFIG_FILE"
chmod 644 "$LOOP_CONFIG_FILE"
run_case loop_config_read_recite_interval
assert_failure_reason "config mode rejected" "unsafe XDG file"

finish_tests config
