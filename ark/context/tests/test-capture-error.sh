#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
CAPTURE="$ROOT/ark/context/hooks/capture-error.sh"
FIXTURES="$ROOT/ark/context/tests/fixtures"
LIVE_FIXTURES="$ROOT/ark/context/adapters/claude-code/tests/fixtures"
TEST_TMP=$(mktemp -d)
TEST_TMP=$(cd "$TEST_TMP" && pwd -P)
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
. "$ROOT/ark/context/tests/test-helper.sh"

if [ ! -f "$CAPTURE" ]; then
  test_fail "capture-error.sh is missing"
  finish_tests "capture error tests"
fi

fakebin="$TEST_TMP/fakebin"
mkdir -m 700 "$fakebin"
printf '#!/usr/bin/env bash\nprintf "2026-08-20T00:00:00Z\\n"\n' >"$fakebin/date"
chmod 700 "$fakebin/date"

mode_of() {
  value=$(stat -c '%a' "$1" 2>/dev/null) || value=$(stat -f '%Lp' "$1" 2>/dev/null) || return 1
  while [ "${value#0}" != "$value" ]; do value=${value#0}; done
  printf '%s\n' "${value:-0}"
}

new_session() {
  session="$TEST_TMP/session-$1"
  mkdir -m 700 "$session" "$session/errors"
  printf '%s\n' "$session"
}

run_capture() {
  input=$1
  target_session=$2
  run_case env PATH="$fakebin:$PATH" ARK_SESSION_DIR="$target_session" /bin/bash "$CAPTURE" <"$input"
}

run_capture_pipe() {
  input=$1
  target_session=$2
  run_case env PATH="$fakebin:$PATH" ARK_SESSION_DIR="$target_session" \
    /bin/bash -c 'cat "$1" | /bin/bash "$2"' capture-pipe "$input" "$CAPTURE"
}

assert_quiet_success() {
  label=$1
  assert_eq "$label exits zero" 0 "$CASE_STATUS"
  assert_eq "$label stdout empty" 0 "$(wc -c <"$CASE_STDOUT" | tr -d ' ')"
  assert_eq "$label stderr empty" 0 "$(wc -c <"$CASE_STDERR" | tr -d ' ')"
}

session=$(new_session exact)
run_capture "$FIXTURES/capture-powershell-nonzero.json" "$session"
assert_quiet_success "canonical capture"
expected="$TEST_TMP/expected.jsonl"
printf '%s\n' '{"at":"2026-08-20T00:00:00Z","tool":"PowerShell","error_type":"tool_error","exit_code":23,"is_interrupt":false,"error":"line 1\nline \"2\" \\ 日本語","details":{"a_object":{"nested":true},"m_number":3.5,"z_array":[1,"two",false,null]}}' >"$expected"
TESTS=$((TESTS + 1))
if cmp -s "$expected" "$session/errors/raw.log"; then PASSES=$((PASSES + 1)); else test_fail "canonical raw bytes mismatch"; fi
assert_eq "raw mode" 600 "$(mode_of "$session/errors/raw.log")"
assert_eq "one physical line" 1 "$(wc -l <"$session/errors/raw.log" | tr -d ' ')"
jq -e 'keys_unsorted == ["at","tool","error_type","exit_code","is_interrupt","error","details"] and (.details|keys_unsorted)==["a_object","m_number","z_array"]' "$session/errors/raw.log" >/dev/null 2>&1
assert_eq "fixed key order" 0 "$?"

pipe_payload="$TEST_TMP/pipe-300kb.json"
pipe_error="$TEST_TMP/pipe-300kb.error"
dd if=/dev/zero bs=1000 count=300 2>/dev/null | tr '\000' x >"$pipe_error"
jq -n --rawfile error "$pipe_error" \
  '{tool:"Bash",error_type:"tool_error",exit_code:null,is_interrupt:false,error:$error,details:{}}' \
  >"$pipe_payload"
pipe_session=$(new_session pipe-300kb)
run_capture_pipe "$pipe_payload" "$pipe_session"
assert_quiet_success "300KB piped capture"
jq -e '(.error | utf8bytelength) == 300000' "$pipe_session/errors/raw.log" >/dev/null 2>&1
assert_eq "300KB piped capture preserves the complete error" 0 "$?"

for fixture_name in capture-process-start-failure.json capture-interrupt.json; do
  run_capture "$FIXTURES/$fixture_name" "$session"
  assert_quiet_success "$fixture_name"
done
assert_eq "three core fixture entries" 3 "$(wc -l <"$session/errors/raw.log" | tr -d ' ')"
jq -e -s '
  .[1].exit_code == null and .[1].is_interrupt == null
  and .[1].error == "spawn ENOENT: \"missing-command\""
  and .[2].is_interrupt == true and .[2].error == "Interrupted by user\n停止"
  and (.[0].details.z_array == [1,"two",false,null])
' "$session/errors/raw.log" >/dev/null 2>&1
assert_eq "core values and types preserved" 0 "$?"

live_version=$(sed -n 's/^claude_version=\([0-9][0-9.]*\) .*/\1/p' "$LIVE_FIXTURES"/post-tool-use-failure-provenance-*.txt)
for case_name in bash-exit-7 mcp-error read-missing; do
  source_fixture="$LIVE_FIXTURES/post-tool-use-failure-$case_name-$live_version.json"
  normalized="$TEST_TMP/normalized-$case_name.json"
  jq -c --arg case_name "$case_name" '
    {
      tool:.tool_name,
      error_type:"tool_error",
      exit_code:(if $case_name == "bash-exit-7" and (.error|test("^Exit code [0-9]+$")) then (.error|capture("^Exit code (?<n>[0-9]+)$").n|tonumber) else null end),
      is_interrupt:.is_interrupt,
      error:.error,
      details:{tool_input:.tool_input,duration_ms:.duration_ms}
    }
  ' "$source_fixture" >"$normalized"
  run_capture "$normalized" "$session"
  assert_quiet_success "live normalized $case_name"
done
assert_eq "live fixtures appended" 6 "$(wc -l <"$session/errors/raw.log" | tr -d ' ')"
jq -e -s '.[3].exit_code == 7 and .[4].exit_code == null and .[5].exit_code == null and .[4].error == "fixture MCP error"' "$session/errors/raw.log" >/dev/null 2>&1
assert_eq "observed exit code mapping preserved" 0 "$?"

no_op_parent="$TEST_TMP/no-op"
mkdir -m 700 "$no_op_parent"
run_case env -u ARK_SESSION_DIR /bin/bash "$CAPTURE" </dev/null
assert_quiet_success "Ark outside no-op"
assert_eq "Ark outside creates no files" 0 "$(find "$no_op_parent" -mindepth 1 | wc -l | tr -d ' ')"

invalids="$TEST_TMP/invalids"
mkdir -m 700 "$invalids"
printf '%s\n' 'not json' >"$invalids/json"
printf '%s\n' '[]' >"$invalids/array"
printf '%s\n' '{"tool":"Bash","error_type":"tool_error","exit_code":"7","is_interrupt":false,"error":"bad","details":{}}' >"$invalids/schema"
printf '{"tool":"Bash","error_type":"tool_error","exit_code":null,"is_interrupt":null,"error":"\377","details":{}}\n' >"$invalids/utf8"
before=$(cksum "$session/errors/raw.log")
for invalid in "$invalids"/*; do
  run_capture "$invalid" "$session"
  assert_quiet_success "invalid input ignored"
done
assert_eq "invalid input preserves raw" "$before" "$(cksum "$session/errors/raw.log")"

unsafe_session="$TEST_TMP/unsafe-session"
mkdir -m 755 "$unsafe_session" "$unsafe_session/errors"
run_capture "$FIXTURES/capture-interrupt.json" "$unsafe_session"
assert_quiet_success "unsafe session ignored"
assert_eq "unsafe session raw absent" no "$(if [ -e "$unsafe_session/errors/raw.log" ]; then printf yes; else printf no; fi)"

symlink_session="$TEST_TMP/symlink-session"
symlink_target="$TEST_TMP/symlink-target"
mkdir -m 700 "$symlink_session" "$symlink_target"
ln -s "$symlink_target" "$symlink_session/errors"
run_capture "$FIXTURES/capture-interrupt.json" "$symlink_session"
assert_quiet_success "errors symlink ignored"
assert_eq "errors symlink target unchanged" 0 "$(find "$symlink_target" -mindepth 1 | wc -l | tr -d ' ')"

raw_link_session=$(new_session raw-link)
printf 'sentinel\n' >"$TEST_TMP/raw-target"
ln -s "$TEST_TMP/raw-target" "$raw_link_session/errors/raw.log"
run_capture "$FIXTURES/capture-interrupt.json" "$raw_link_session"
assert_quiet_success "raw symlink ignored"
assert_eq "raw symlink target unchanged" sentinel "$(cat "$TEST_TMP/raw-target")"

raw_mode_session=$(new_session raw-mode)
printf 'sentinel\n' >"$raw_mode_session/errors/raw.log"
chmod 644 "$raw_mode_session/errors/raw.log"
run_capture "$FIXTURES/capture-interrupt.json" "$raw_mode_session"
assert_quiet_success "unsafe raw mode ignored"
assert_eq "unsafe raw mode unchanged" sentinel "$(cat "$raw_mode_session/errors/raw.log")"

oversize="$TEST_TMP/oversize.json"
printf '%s' '{"tool":"Bash","error_type":"tool_error","exit_code":null,"is_interrupt":null,"error":"' >"$oversize"
dd if=/dev/zero bs=1048577 count=1 2>/dev/null | tr '\000' x >>"$oversize"
printf '%s\n' '","details":{}}' >>"$oversize"
limit_session=$(new_session entry-limit)
printf 'sentinel\n' >"$limit_session/errors/raw.log"
chmod 600 "$limit_session/errors/raw.log"
before=$(cksum "$limit_session/errors/raw.log")
run_capture "$oversize" "$limit_session"
assert_quiet_success "oversize entry ignored"
assert_eq "oversize entry preserves raw" "$before" "$(cksum "$limit_session/errors/raw.log")"

total_session=$(new_session total-limit)
dd if=/dev/zero of="$total_session/errors/raw.log" bs=1 count=0 seek=67108864 2>/dev/null
chmod 600 "$total_session/errors/raw.log"
before_size=$(wc -c <"$total_session/errors/raw.log" | tr -d ' ')
run_capture "$FIXTURES/capture-interrupt.json" "$total_session"
assert_quiet_success "raw total limit ignored"
assert_eq "raw total limit preserves size" "$before_size" "$(wc -c <"$total_session/errors/raw.log" | tr -d ' ')"

parallel_session=$(new_session parallel)
pids=
i=1
while [ "$i" -le 20 ]; do
  input="$TEST_TMP/parallel-$i.json"
  printf '{"tool":"Bash","error_type":"tool_error","exit_code":%s,"is_interrupt":false,"error":"parallel-%s","details":{"sequence":%s}}\n' "$i" "$i" "$i" >"$input"
  (env PATH="$fakebin:$PATH" ARK_SESSION_DIR="$parallel_session" /bin/bash "$CAPTURE" <"$input" >"$TEST_TMP/parallel-$i.out" 2>"$TEST_TMP/parallel-$i.err") &
  pids="$pids $!"
  i=$((i + 1))
done
parallel_status=0
for pid in $pids; do wait "$pid" || parallel_status=1; done
assert_eq "parallel processes exit zero" 0 "$parallel_status"
assert_eq "parallel stdout empty" 0 "$(wc -c "$TEST_TMP"/parallel-*.out | tail -1 | awk '{print $1}')"
assert_eq "parallel stderr empty" 0 "$(wc -c "$TEST_TMP"/parallel-*.err | tail -1 | awk '{print $1}')"
assert_eq "parallel entry count" 20 "$(wc -l <"$parallel_session/errors/raw.log" | tr -d ' ')"
jq -e -s 'length == 20 and ([.[].error] | unique | length) == 20' "$parallel_session/errors/raw.log" >/dev/null 2>&1
assert_eq "parallel JSON complete and unique" 0 "$?"

race_session=$(new_session lock-recovery-race)
race_lock="$race_session/errors/.raw.lock"
race_owner="$race_lock/owner"
mkdir -m 700 "$race_lock"
printf '%s\n' '99999999 stale-token' >"$race_owner"
chmod 600 "$race_owner"
race_bin="$TEST_TMP/race-bin"
mkdir -m 700 "$race_bin"
race_sed=$(command -v sed)
race_observed="$TEST_TMP/race-observed"
race_replaced="$TEST_TMP/race-replaced"
cat >"$race_bin/sed" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -eq 3 ] && [ "$1" = -n ] && [ "$2" = 1p ] && [ "$3" = "$RACE_LOCK_OWNER" ] \
  && [ ! -e "$RACE_OBSERVED" ]; then
  observed=$($RACE_REAL_SED "$@") || exit 1
  : >"$RACE_OBSERVED"
  attempt=0
  while [ ! -e "$RACE_REPLACED" ] && [ "$attempt" -lt 1000000 ]; do
    attempt=$((attempt + 1))
  done
  [ -e "$RACE_REPLACED" ] || exit 1
  printf '%s\n' "$observed"
  exit 0
fi
exec "$RACE_REAL_SED" "$@"
EOF
chmod 700 "$race_bin/sed"
race_out="$TEST_TMP/race.out"
race_err="$TEST_TMP/race.err"
env PATH="$race_bin:$fakebin:$PATH" ARK_SESSION_DIR="$race_session" \
  RACE_LOCK_OWNER="$race_owner" RACE_OBSERVED="$race_observed" \
  RACE_REPLACED="$race_replaced" RACE_REAL_SED="$race_sed" \
  /bin/bash "$CAPTURE" <"$FIXTURES/capture-interrupt.json" >"$race_out" 2>"$race_err" &
race_capture_pid=$!
race_wait=0
while [ ! -e "$race_observed" ] && [ "$race_wait" -lt 1000000 ]; do
  race_wait=$((race_wait + 1))
done
race_observed_result=no
if [ -e "$race_observed" ]; then
  race_observed_result=yes
  command rm -f "$race_owner"
  rmdir "$race_lock"
  mkdir -m 700 "$race_lock"
  printf '%s %s\n' "$$" live-token >"$race_owner"
  chmod 600 "$race_owner"
fi
: >"$race_replaced"
wait "$race_capture_pid"
race_status=$?
assert_eq "dead-lock recovery race reached owner observation" yes "$race_observed_result"
assert_eq "dead-lock recovery race exits zero" 0 "$race_status"
assert_eq "replacement live lock directory survives recovery" yes "$(if [ -d "$race_lock" ]; then printf yes; else printf no; fi)"
assert_eq "replacement live lock owner survives recovery" "$$ live-token" "$(sed -n '1p' "$race_owner" 2>/dev/null)"
assert_eq "dead-lock recovery race stdout empty" 0 "$(wc -c <"$race_out" | tr -d ' ')"
assert_eq "dead-lock recovery race stderr empty" 0 "$(wc -c <"$race_err" | tr -d ' ')"

assert_eq "errors directory mode remains 700" 700 "$(mode_of "$parallel_session/errors")"
assert_eq "raw mode remains 600" 600 "$(mode_of "$parallel_session/errors/raw.log")"
assert_eq "no capture temporary files remain" 0 "$(find "$parallel_session/errors" -mindepth 1 ! -name raw.log | wc -l | tr -d ' ')"

grep -E '(^|[^[:alnum:]_])(flock|sleep)([^[:alnum:]_]|$)' "$CAPTURE" >/dev/null 2>&1
assert_eq "capture avoids flock and sleep" 1 "$?"
grep -E '(truncate|rotate|raw\.log.*rm|rm.*raw\.log|raw\.log.*mv|mv.*raw\.log)' "$CAPTURE" >/dev/null 2>&1
assert_eq "capture has no raw rewrite delete rotation" 1 "$?"

finish_tests "capture error tests"
