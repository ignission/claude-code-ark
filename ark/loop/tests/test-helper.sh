#!/usr/bin/env bash

TESTS=${TESTS:-0}
PASSES=${PASSES:-0}
FAILURES=${FAILURES:-0}
CASE_STATUS=0
CASE_STDOUT=
CASE_STDERR=

test_fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL: %s\n' "$1" >&2
  [ -z "${CASE_STDOUT:-}" ] || { printf '%s\n' '  stdout:' >&2; sed 's/^/    /' "$CASE_STDOUT" >&2; }
  [ -z "${CASE_STDERR:-}" ] || { printf '%s\n' '  stderr:' >&2; sed 's/^/    /' "$CASE_STDERR" >&2; }
}

assert_eq() {
  TESTS=$((TESTS + 1))
  if [ "$2" = "$3" ]; then PASSES=$((PASSES + 1)); else test_fail "$1 (expected '$2', got '$3')"; fi
}

assert_success() {
  TESTS=$((TESTS + 1))
  if [ "$CASE_STATUS" -eq 0 ]; then PASSES=$((PASSES + 1)); else test_fail "$1 (exit $CASE_STATUS)"; fi
}

assert_failure_reason() {
  TESTS=$((TESTS + 1))
  if [ "$CASE_STATUS" -ne 0 ] && grep -F "$2" "$CASE_STDERR" >/dev/null 2>&1; then
    PASSES=$((PASSES + 1))
  else
    test_fail "$1 (exit $CASE_STATUS, missing reason '$2')"
  fi
}

run_case() {
  case_dir="$TEST_TMP/case-$((TESTS + 1))"
  mkdir -m 700 "$case_dir" || exit 1
  CASE_STDOUT="$case_dir/stdout"
  CASE_STDERR="$case_dir/stderr"
  ( "$@" ) >"$CASE_STDOUT" 2>"$CASE_STDERR"
  CASE_STATUS=$?
}

step_count() {
  local cache=$1 steps path name number highest found entries entry
  steps="$cache/steps"
  [ -d "$steps" ] && [ ! -L "$steps" ] || { printf '0\n'; return; }
  highest=0
  found=0
  for path in "$steps"/bucket-*; do
    [ -d "$path" ] && [ ! -L "$path" ] || continue
    name=${path##*/}
    number=${name#bucket-}
    case "$number" in ''|*[!0-9]*|0[0-9]*) continue ;; esac
    if [ "$found" -eq 0 ] || [ "$number" -gt "$highest" ]; then highest=$number; fi
    found=1
  done
  [ "$found" -eq 1 ] || { printf '0\n'; return; }
  entries=0
  for entry in "$steps/bucket-$highest"/step-*; do
    [ -d "$entry" ] && [ ! -L "$entry" ] || continue
    entries=$((entries + 1))
  done
  printf '%s\n' "$((highest + entries))"
}

seed_step_count() {
  local cache=$1 count=$2 slot
  command rm -rf "$cache/steps"
  [ "$count" -gt 0 ] || return 0
  mkdir -m 700 "$cache/steps" "$cache/steps/bucket-0" "$cache/steps/initialized" || return 1
  slot=1
  while [ "$slot" -le "$count" ]; do
    mkdir -m 700 "$cache/steps/bucket-0/step-0-$slot" || return 1
    slot=$((slot + 1))
  done
}

finish_tests() {
  if [ "$FAILURES" -ne 0 ]; then
    printf '%s: %s/%s passed, %s failed\n' "$1" "$PASSES" "$TESTS" "$FAILURES" >&2
    exit 1
  fi
  printf '%s: %s/%s passed\n' "$1" "$PASSES" "$TESTS"
}
