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

finish_tests() {
  if [ "$FAILURES" -ne 0 ]; then
    printf '%s: %s/%s passed, %s failed\n' "$1" "$PASSES" "$TESTS" "$FAILURES" >&2
    exit 1
  fi
  printf '%s: %s/%s passed\n' "$1" "$PASSES" "$TESTS"
}
