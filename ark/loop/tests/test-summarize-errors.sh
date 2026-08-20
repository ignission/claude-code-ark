#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
SUMMARIZE="$ROOT/ark/loop/scripts/summarize-errors.sh"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/loop/tests/test-helper.sh"

if [ ! -f "$SUMMARIZE" ]; then
  test_fail "summarize-errors.sh is missing"
  finish_tests "summarize errors tests"
fi

fakebin="$TEST_TMP/fakebin"
mkdir -m 700 "$fakebin"
curl_log="$TEST_TMP/curl.log"
: >"$curl_log"
printf '#!/usr/bin/env bash\nprintf "called\\n" >>"%s"\nexit 99\n' "$curl_log" >"$fakebin/curl"
printf '#!/usr/bin/env bash\nprintf "2099-01-01T01:02:03Z\\n"\n' >"$fakebin/date"
chmod 700 "$fakebin/curl" "$fakebin/date"

mode_of() {
  value=$(stat -c '%a' "$1" 2>/dev/null) || value=$(stat -f '%Lp' "$1" 2>/dev/null) || return 1
  while [ "${value#0}" != "$value" ]; do value=${value#0}; done
  printf '%s\n' "${value:-0}"
}

mtime_of() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1" 2>/dev/null
}

new_session() {
  target="$TEST_TMP/session-$1"
  mkdir -m 700 "$target" "$target/errors"
  printf '%s\n' "$target"
}

write_raw() {
  target=$1
  cat >"$target/errors/raw.log" <<'EOF'
{"at":"2026-08-20T00:00:01Z","tool":"Bash","error_type":"tool_error","exit_code":7,"is_interrupt":false,"error":"L1 secret bash","details":{}}
{"at":"2026-08-20T00:00:02Z","tool":"Read","error_type":"tool_error","exit_code":null,"is_interrupt":false,"error":"L2 secret read","details":{}}
{"at":"2026-08-20T00:00:03Z","tool":"Bash","error_type":"tool_error","exit_code":8,"is_interrupt":false,"error":"L3 secret bash","details":{}}
{"at":"2026-08-20T00:00:04Z","tool":"mcp__fixture","error_type":"failure","exit_code":null,"is_interrupt":false,"error":"L4 secret mcp","details":{}}
{"at":"2026-08-20T00:00:05Z","tool":"mcp__fixture","error_type":"failure","exit_code":null,"is_interrupt":false,"error":"L5 secret mcp","details":{}}
{"at":"2026-08-20T00:00:06Z","tool":"Bash","error_type":"tool_error","exit_code":9,"is_interrupt":false,"error":"L6 secret bash","details":{}}
EOF
  chmod 600 "$target/errors/raw.log"
}

run_summary() {
  target=$1
  shift
  run_case env PATH="$fakebin:$PATH" ARK_SESSION_DIR="$target" "$@" /bin/bash "$SUMMARIZE"
}

session=$(new_session grouped)
write_raw "$session"
expected="$TEST_TMP/expected-summary"
cat >"$expected" <<'EOF'
Error summary (mechanical)
- tool: Bash
  error_type: tool_error
  count: 3
  first_line: 1
  last_line: 6
  詳細: errors/raw.log:L1-L6
- tool: Read
  error_type: tool_error
  count: 1
  first_line: 2
  last_line: 2
  詳細: errors/raw.log:L2-L2
- tool: mcp__fixture
  error_type: failure
  count: 2
  first_line: 4
  last_line: 5
  詳細: errors/raw.log:L4-L5
EOF
raw_hash=$(cksum "$session/errors/raw.log")
raw_size=$(wc -c <"$session/errors/raw.log" | tr -d ' ')
raw_mtime=$(mtime_of "$session/errors/raw.log")
raw_mode=$(mode_of "$session/errors/raw.log")
run_summary "$session" TZ=Asia/Tokyo LC_ALL=C
assert_success "mechanical summary succeeds"
assert_eq "mechanical summary stdout empty" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
assert_eq "mechanical summary stderr empty" 0 "$(wc -c <"$CASE_STDERR" | tr -d ' ')"
TESTS=$((TESTS + 1))
if cmp -s "$expected" "$session/errors/summary.md"; then PASSES=$((PASSES + 1)); else test_fail "mechanical summary bytes mismatch"; fi
assert_eq "summary mode" 600 "$(mode_of "$session/errors/summary.md")"
assert_eq "raw hash unchanged" "$raw_hash" "$(cksum "$session/errors/raw.log")"
assert_eq "raw size unchanged" "$raw_size" "$(wc -c <"$session/errors/raw.log" | tr -d ' ')"
assert_eq "raw mtime unchanged" "$raw_mtime" "$(mtime_of "$session/errors/raw.log")"
assert_eq "raw mode unchanged" "$raw_mode" "$(mode_of "$session/errors/raw.log")"
grep -E '^## ' "$session/errors/summary.md" >/dev/null 2>&1
assert_eq "summary has no Markdown level-two heading" 1 "$?"
rg -n 'secret|L[1-6]' "$session/errors/summary.md" >/dev/null 2>&1
assert_eq "summary excludes raw errors" 1 "$?"
assert_eq "default summary does not call curl" 0 "$(wc -l <"$curl_log" | tr -d ' ')"

cp "$session/errors/summary.md" "$TEST_TMP/first-summary"
run_summary "$session" TZ=UTC LC_ALL=C
assert_success "second mechanical summary succeeds"
TESTS=$((TESTS + 1))
if cmp -s "$TEST_TMP/first-summary" "$session/errors/summary.md"; then PASSES=$((PASSES + 1)); else test_fail "summary depends on environment"; fi

empty_session=$(new_session empty)
run_summary "$empty_session" TZ=UTC LC_ALL=C
assert_success "missing raw summarizes as empty"
printf 'Error summary (mechanical)\n- なし\n' >"$TEST_TMP/empty-expected"
TESTS=$((TESTS + 1))
if cmp -s "$TEST_TMP/empty-expected" "$empty_session/errors/summary.md"; then PASSES=$((PASSES + 1)); else test_fail "empty summary mismatch"; fi

invalid_session=$(new_session invalid)
write_raw "$invalid_session"
printf 'old summary\n' >"$invalid_session/errors/summary.md"
chmod 600 "$invalid_session/errors/summary.md"
cp "$invalid_session/errors/summary.md" "$TEST_TMP/old-summary"
printf '{"at":"bad"}\n' >>"$invalid_session/errors/raw.log"
run_summary "$invalid_session" TZ=UTC LC_ALL=C
assert_eq "invalid raw fails" 1 "$CASE_STATUS"
assert_eq "invalid raw stdout empty" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
TESTS=$((TESTS + 1))
if cmp -s "$TEST_TMP/old-summary" "$invalid_session/errors/summary.md"; then PASSES=$((PASSES + 1)); else test_fail "invalid raw replaced old summary"; fi
assert_eq "invalid raw leaves no temp" 0 "$(find "$invalid_session/errors" -mindepth 1 ! -name raw.log ! -name summary.md | wc -l | tr -d ' ')"

pretty_session=$(new_session pretty)
cat >"$pretty_session/errors/raw.log" <<'EOF'
{
  "at":"2026-08-20T00:00:00Z",
  "tool":"Bash",
  "error_type":"tool_error",
  "exit_code":null,
  "is_interrupt":null,
  "error":"multi physical line",
  "details":{}
}
EOF
chmod 600 "$pretty_session/errors/raw.log"
run_summary "$pretty_session" TZ=UTC LC_ALL=C
assert_eq "multiple physical lines fail" 1 "$CASE_STATUS"

wrong_order_session=$(new_session wrong-order)
printf '%s\n' '{"tool":"Bash","at":"2026-08-20T00:00:00Z","error_type":"tool_error","exit_code":null,"is_interrupt":null,"error":"bad order","details":{}}' >"$wrong_order_session/errors/raw.log"
chmod 600 "$wrong_order_session/errors/raw.log"
run_summary "$wrong_order_session" TZ=UTC LC_ALL=C
assert_eq "wrong top-level order fails" 1 "$CASE_STATUS"

control_session=$(new_session control)
printf '%s\n' '{"at":"2026-08-20T00:00:00Z","tool":"bad\ttool","error_type":"tool_error","exit_code":null,"is_interrupt":null,"error":"control","details":{}}' >"$control_session/errors/raw.log"
chmod 600 "$control_session/errors/raw.log"
run_summary "$control_session" TZ=UTC LC_ALL=C
assert_eq "control in grouping key fails" 1 "$CASE_STATUS"

unsafe_session="$TEST_TMP/unsafe-session"
mkdir -m 755 "$unsafe_session" "$unsafe_session/errors"
run_summary "$unsafe_session" TZ=UTC LC_ALL=C
assert_eq "unsafe session fails" 1 "$CASE_STATUS"

errors_link_session="$TEST_TMP/errors-link-session"
errors_link_target="$TEST_TMP/errors-link-target"
mkdir -m 700 "$errors_link_session" "$errors_link_target"
ln -s "$errors_link_target" "$errors_link_session/errors"
run_summary "$errors_link_session" TZ=UTC LC_ALL=C
assert_eq "errors symlink fails" 1 "$CASE_STATUS"
assert_eq "errors symlink target unchanged" 0 "$(find "$errors_link_target" -mindepth 1 | wc -l | tr -d ' ')"

raw_link_session=$(new_session raw-link)
printf 'target\n' >"$TEST_TMP/raw-link-target"
ln -s "$TEST_TMP/raw-link-target" "$raw_link_session/errors/raw.log"
run_summary "$raw_link_session" TZ=UTC LC_ALL=C
assert_eq "raw symlink fails" 1 "$CASE_STATUS"
assert_eq "raw symlink target unchanged" target "$(cat "$TEST_TMP/raw-link-target")"

raw_mode_session=$(new_session raw-mode)
printf '{}\n' >"$raw_mode_session/errors/raw.log"
chmod 644 "$raw_mode_session/errors/raw.log"
run_summary "$raw_mode_session" TZ=UTC LC_ALL=C
assert_eq "unsafe raw mode fails" 1 "$CASE_STATUS"

summary_link_session=$(new_session summary-link)
printf 'target summary\n' >"$TEST_TMP/summary-link-target"
ln -s "$TEST_TMP/summary-link-target" "$summary_link_session/errors/summary.md"
run_summary "$summary_link_session" TZ=UTC LC_ALL=C
assert_eq "summary symlink fails" 1 "$CASE_STATUS"
assert_eq "summary symlink target unchanged" 'target summary' "$(cat "$TEST_TMP/summary-link-target")"

summary_mode_session=$(new_session summary-mode)
printf 'old\n' >"$summary_mode_session/errors/summary.md"
chmod 644 "$summary_mode_session/errors/summary.md"
run_summary "$summary_mode_session" TZ=UTC LC_ALL=C
assert_eq "unsafe summary mode fails" 1 "$CASE_STATUS"
assert_eq "unsafe summary preserved" old "$(cat "$summary_mode_session/errors/summary.md")"

run_case env -u ARK_SESSION_DIR /bin/bash "$SUMMARIZE" </dev/null
assert_success "Ark outside summary no-op"
assert_eq "Ark outside summary stdout empty" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
assert_eq "Ark outside summary stderr empty" 0 "$(wc -c <"$CASE_STDERR" | tr -d ' ')"

grep -E '(raw\.log.*(rm|mv|truncate)|(^|[[:space:]])(rm|mv|truncate).*raw\.log)' "$SUMMARIZE" >/dev/null 2>&1
assert_eq "summary never writes deletes or moves raw" 1 "$?"

finish_tests "summarize errors tests"
