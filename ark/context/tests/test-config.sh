#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"
. "$ROOT/ark/context/scripts/lib/runtime.sh"
. "$ROOT/ark/context/scripts/lib/config.sh"

expected='[context]
recite_interval = 10

[context.summarize]
# API 従量課金が発生し、Claude プラン枠の対象外
llm = false
model = ""'
assert_eq "config template bytes" "$expected" "$(cat "$ROOT/ark/context/templates/config.toml.tmpl")"

repo="$TEST_TMP/repo"
mkdir -m 700 "$repo"
git -C "$repo" init -q
HOME="$TEST_TMP/home"
export HOME
mkdir -m 700 "$HOME"
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
ctx_runtime_resolve "$repo" 0123456789abcdef0123456789abcdef >/dev/null

run_case ctx_config_ensure
assert_success "missing config created"
[ -f "$CTX_CONFIG_FILE" ] || test_fail "config was not created"
assert_eq "created template" "$expected" "$(cat "$CTX_CONFIG_FILE")"
assert_eq "created mode" 600 "$(ctx_stat "$CTX_CONFIG_FILE" | awk '{print $2}')"
before=$(cat "$CTX_CONFIG_FILE")
run_case ctx_config_ensure
assert_success "existing config retained"
assert_eq "existing config bytes retained" "$before" "$(cat "$CTX_CONFIG_FILE")"

printf '[context]\nrecite_interval = 3 # fast\n\n[context.summarize]\nrecite_interval = 99\n' >"$CTX_CONFIG_FILE"
chmod 600 "$CTX_CONFIG_FILE"
run_case ctx_config_read_recite_interval
assert_success "valid interval parsed"
assert_eq "interval from context table" 3 "$(cat "$CASE_STDOUT")"

printf '\t[context]\t\n\trecite_interval\t=\t7\t# tab-indented\n' >"$CTX_CONFIG_FILE"
chmod 600 "$CTX_CONFIG_FILE"
run_case ctx_config_read_recite_interval
assert_success "tab-indented config parsed"
assert_eq "tab-trimmed interval" 7 "$(cat "$CASE_STDOUT")"

for bad in 'recite_interval = 0' 'recite_interval = -1' 'recite_interval = nope' \
  'recite_interval = 1.5' 'recite_interval = 2\nrecite_interval = 3'; do
  printf '[context]\n%b\n' "$bad" >"$CTX_CONFIG_FILE"
  chmod 600 "$CTX_CONFIG_FILE"
  run_case ctx_config_read_recite_interval
  assert_failure_reason "invalid interval rejected: $bad" "invalid recite_interval"
done

printf '[context]\nname = "keep"\n\n[future]\nvalue = 7\n' >"$CTX_CONFIG_FILE"
chmod 600 "$CTX_CONFIG_FILE"
run_case ctx_config_read_recite_interval
assert_success "unknown config retained"
assert_eq "missing interval defaults" 10 "$(cat "$CASE_STDOUT")"

read_summarize() {
  ctx_config_read_summarize || return 1
  printf 'llm=%s\nmodel=%s\n' "$CTX_SUMMARIZE_LLM" "$CTX_SUMMARIZE_MODEL"
}

printf '[context.summarize]\nllm = true\nmodel = "fixture-model"\n' >"$CTX_CONFIG_FILE"
chmod 600 "$CTX_CONFIG_FILE"
run_case read_summarize
assert_success "summarize opt-in parsed"
assert_eq "summarize globals parsed" 'llm=1
model=fixture-model' "$(cat "$CASE_STDOUT")"

printf '[context]\nllm = true\nmodel = "wrong-table"\n\n[context.summarize]\nunknown = 7\n' >"$CTX_CONFIG_FILE"
chmod 600 "$CTX_CONFIG_FILE"
run_case read_summarize
assert_success "summarize unknown keys ignored"
assert_eq "summarize missing keys default" 'llm=0
model=' "$(cat "$CASE_STDOUT")"

long_model=$(printf '%0201d' 0 | tr 0 x)
for bad_summary in \
  'llm = yes' \
  'llm = true\nllm = false' \
  'model = bare' \
  'model = "unterminated' \
  'model = "one"\nmodel = "two"' \
  "model = \"$long_model\""; do
  printf '[context.summarize]\n%b\n' "$bad_summary" >"$CTX_CONFIG_FILE"
  chmod 600 "$CTX_CONFIG_FILE"
  run_case read_summarize
  assert_failure_reason "invalid summarize config rejected" "invalid summarize config"
done

printf '[context.summarize]\nmodel = "bad\tmodel"\n' >"$CTX_CONFIG_FILE"
chmod 600 "$CTX_CONFIG_FILE"
run_case read_summarize
assert_failure_reason "summarize control rejected" "invalid summarize config"

rm -f "$CTX_CONFIG_FILE"
ln -s "$ROOT/package.json" "$CTX_CONFIG_FILE"
run_case ctx_config_ensure
assert_failure_reason "config symlink rejected" "unsafe XDG file"
rm -f "$CTX_CONFIG_FILE"
printf '[context]\n' >"$CTX_CONFIG_FILE"
chmod 644 "$CTX_CONFIG_FILE"
run_case ctx_config_read_recite_interval
assert_failure_reason "config mode rejected" "unsafe XDG file"

rm -f "$CTX_CONFIG_FILE"
session_id=$(ctx_session_id_generate)
assert_eq "generated session id length" 32 "${#session_id}"
case "$session_id" in *[!0-9a-f]*) test_fail "generated session id is not lowercase hex" ;; *) TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)) ;; esac
restart_id=$(ctx_session_id_generate "$session_id")
if [ "$restart_id" = "$session_id" ]; then test_fail "restart reused the prior session id"; else TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1)); fi

finish_tests config
