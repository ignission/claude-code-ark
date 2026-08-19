#!/bin/bash
# =============================================================================
# state-io 共通 lock の flock / mkdir fallback 回帰テスト
# =============================================================================
set -uo pipefail

TESTS=0
PASSES=0
FAILURES=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

assert_eq() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  TESTS=$((TESTS + 1))
  if [ "$expected" = "$actual" ]; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description"
    echo "  expected: $expected"
    echo "  actual:   $actual"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STATE_IO="$PROJECT_DIR/.claude/lib/state-io.sh"
CLEANUP_LIB="$PROJECT_DIR/.claude/lib/cleanup.sh"
TMP_TEST_DIR=$(mktemp -d "/tmp/test-state-lock.XXXXXX")
NO_FLOCK_BIN="$TMP_TEST_DIR/bin-no-flock"
HOLDER_PID=""
HOLDER_DIAGNOSTICS="$TMP_TEST_DIR/holder-diagnostics"
CONTENDER_DIAGNOSTICS="$TMP_TEST_DIR/contender-diagnostics"

print_lock_failure_diagnostics() {
  local lock_dir="${LOCK_FILE}.d"

  echo "  --- lock contention environment:"
  echo "  uname -s: $(uname -s 2>&1)"
  echo "  bash --version: $(/bin/bash --version 2>&1 | sed -n '1p')"
  echo "  test shell \$\$: $$"
  echo "  test shell BASHPID: ${BASHPID-<unavailable>}"
  echo "  holder process pid (\$!): $HOLDER_PID"
  if kill -0 "$HOLDER_PID" 2>/dev/null; then
    echo "  holder process kill -0: alive"
  else
    echo "  holder process kill -0: dead"
  fi
  echo "  --- holder observations:"
  if [ -s "$HOLDER_DIAGNOSTICS" ]; then
    sed 's/^/  /' "$HOLDER_DIAGNOSTICS"
  else
    echo "  (unavailable)"
  fi
  echo "  --- contender observations before acquire:"
  if [ -s "$CONTENDER_DIAGNOSTICS" ]; then
    sed 's/^/  /' "$CONTENDER_DIAGNOSTICS"
  else
    echo "  (unavailable)"
  fi
  echo "  --- zsh pid observations:"
  "$ZSH_BIN" -c '
    zmodload zsh/system 2>/dev/null || true
    print -r -- "zsh \$\$: $$"
    print -r -- "zsh sysparams[pid]: ${sysparams[pid]-<unavailable>}"
  ' 2>&1 | sed 's/^/  /'
  echo "  --- lock directory after contender: $lock_dir"
  if [ -d "$lock_dir" ]; then
    ls -la "$lock_dir" 2>&1 | sed 's/^/  /'
    for lock_entry in "$lock_dir"/*; do
      [ -f "$lock_entry" ] || continue
      echo "  file ${lock_entry##*/}:"
      sed 's/^/    /' "$lock_entry" 2>&1
    done
  else
    echo "  (missing)"
  fi
}

cleanup_test() {
  if [ -n "$HOLDER_PID" ] && kill -0 "$HOLDER_PID" 2>/dev/null; then
    kill -9 "$HOLDER_PID" 2>/dev/null || true
    wait "$HOLDER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_TEST_DIR"
}
trap cleanup_test EXIT

mkdir -p "$NO_FLOCK_BIN" "$TMP_TEST_DIR/state-no-flock" \
  "$TMP_TEST_DIR/state-no-flock-zsh" "$TMP_TEST_DIR/state-no-flock-cleanup" \
  "$TMP_TEST_DIR/state-normal"
chmod 700 "$TMP_TEST_DIR/state-no-flock" "$TMP_TEST_DIR/state-no-flock-zsh" \
  "$TMP_TEST_DIR/state-no-flock-cleanup" "$TMP_TEST_DIR/state-normal"

# PATH 全体を test bin に限定し、state-io が使うコマンドだけを symlink する。
# 単に PATH の先頭へ空 directory を足すだけでは後段の /usr/bin/flock が見えるため、
# この構成で command -v flock が確実に失敗する状態を作る。
for tool_name in cat chmod date find id jq mkdir mv od rm rmdir sleep stat tr uuidgen; do
  tool_target=$(command -v "$tool_name" 2>/dev/null || true)
  case "$tool_target" in
    /*) ln -s "$tool_target" "$NO_FLOCK_BIN/$tool_name" ;;
  esac
done

echo "=== state lock: flock fallback ==="

NO_FLOCK_SCOPE="no-flock-state-$$"
no_flock_state_output=$(env PATH="$NO_FLOCK_BIN" \
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" FLOW_STATE_DIR="$TMP_TEST_DIR/state-no-flock" \
  /bin/bash -c '
    source "$1"
    scope=$(flow_state_init "$2" "feature/$2" /tmp/no-flock-worktree) || exit 1
    flow_state_update progress '\''.phase = "P2"'\'' "$scope" || exit 2
    phase=$(flow_state_read progress '\''.phase'\'' "$scope") || exit 3
    [ ! -d "$FLOW_STATE_DIR/flow-$scope.lock.d" ] || exit 4
    printf "%s|%s\n" "$scope" "$phase"
  ' bash "$STATE_IO" "$NO_FLOCK_SCOPE" 2>&1)
assert_eq "flock 不在でも init → update → read が成功する" \
  "$NO_FLOCK_SCOPE|P2" "$no_flock_state_output"

# zsh 経路も lock の backend 切り替えと一体で検証するため、この専用テストに置く。
# test-zsh-compat.sh は汎用の zsh 互換検証に専念でき、かつ本テストの単独実行でも
# mkdir fallback が zsh から利用できる保証を失わない。
ZSH_BIN=$(command -v zsh) || { echo "ERROR: zsh が必要です" >&2; exit 1; }
NO_FLOCK_ZSH_SCOPE="no-flock-zsh-state-$$"
no_flock_zsh_output=$(env PATH="$NO_FLOCK_BIN" \
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" FLOW_STATE_DIR="$TMP_TEST_DIR/state-no-flock-zsh" \
  "$ZSH_BIN" -c '
    source "$1"
    scope=$(flow_state_init "$2" "feature/$2" /tmp/no-flock-zsh-worktree) || exit 1
    flow_state_update progress '\''.phase = "P2"'\'' "$scope" || exit 2
    phase=$(flow_state_read progress '\''.phase'\'' "$scope") || exit 3
    [ ! -d "$FLOW_STATE_DIR/flow-$scope.lock.d" ] || exit 4
    printf "%s|%s\n" "$scope" "$phase"
  ' zsh "$STATE_IO" "$NO_FLOCK_ZSH_SCOPE" 2>&1)
assert_eq "zsh でも flock 不在時の init → update → read が成功する" \
  "$NO_FLOCK_ZSH_SCOPE|P2" "$no_flock_zsh_output"

LOCK_FILE="$TMP_TEST_DIR/state-no-flock/contention.lock"
READY_FILE="$TMP_TEST_DIR/holder-ready"
env PATH="$NO_FLOCK_BIN" CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
  /bin/bash -c '
    source "$1"
    exec 9>"$2"
    flow_lock_acquire "$2" 9 0 1 auto || exit 1
    [ "$FLOW_LOCK_ACQUIRED_BACKEND" = "mkdir" ] || exit 2
    printf "holder \$\$: %s\nholder BASHPID: %s\nrecorded owner pid: %s\n" \
      "$$" "${BASHPID-<unavailable>}" "$FLOW_LOCK_ACQUIRED_PID" > "$4"
    : > "$3"
    sleep 30
  ' bash "$STATE_IO" "$LOCK_FILE" "$READY_FILE" "$HOLDER_DIAGNOSTICS" &
HOLDER_PID=$!

ready_attempts=0
while [ ! -f "$READY_FILE" ] && kill -0 "$HOLDER_PID" 2>/dev/null \
  && [ "$ready_attempts" -lt 50 ]; do
  sleep 0.1
  ready_attempts=$((ready_attempts + 1))
done

contention_result="holder-failed"
if [ -f "$READY_FILE" ]; then
  if env PATH="$NO_FLOCK_BIN" CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
    /bin/bash -c '
      source "$1"
      exec 9>"$2"
      observed_owner=$(cat "$2.d/pid" 2>/dev/null || true)
      if [ -n "$observed_owner" ] && kill -0 "$observed_owner" 2>/dev/null; then
        observed_owner_liveness=alive
      else
        observed_owner_liveness=dead
      fi
      printf "contender \$\$: %s\ncontender BASHPID: %s\nobserved owner pid: %s\nobserved owner kill -0: %s\n" \
        "$$" "${BASHPID-<unavailable>}" "$observed_owner" \
        "$observed_owner_liveness" > "$3"
      flow_lock_acquire "$2" 9 0 1 auto
    ' bash "$STATE_IO" "$LOCK_FILE" "$CONTENDER_DIAGNOSTICS" >/dev/null 2>&1; then
    contention_result="acquired"
  else
    contention_result="blocked"
  fi
fi
assert_eq "mkdir lock 保持中は別 process の non-blocking 取得が失敗する" \
  "blocked" "$contention_result"
if [ "$contention_result" != "blocked" ]; then
  print_lock_failure_diagnostics
fi

# SIGKILL では release trap を実行できない。directory に残った holder pid が死亡済みと
# 判定され、次の process が stale lock を奪取できることを検証する。
kill -9 "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
sleep 1
stale_result=$(env PATH="$NO_FLOCK_BIN" CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
  /bin/bash -c '
    source "$1"
    exec 9>"$2"
    flow_lock_acquire "$2" 9 0 1 auto || exit 1
    backend="$FLOW_LOCK_ACQUIRED_BACKEND"
    owner_pid="$FLOW_LOCK_ACQUIRED_PID"
    owner_token="$FLOW_LOCK_ACQUIRED_TOKEN"
    flow_lock_release "$2" "$backend" "$owner_pid" "$owner_token"
    printf "%s" "$backend"
  ' bash "$STATE_IO" "$LOCK_FILE" 2>&1)
assert_eq "異常終了した process の pid lock は stale として奪取できる" \
  "mkdir" "$stale_result"

REUSED_PID_LOCK="$TMP_TEST_DIR/state-no-flock/reused-pid.lock"
mkdir "$REUSED_PID_LOCK.d"
printf '%s\n' "$$" > "$REUSED_PID_LOCK.d/pid"
printf '%s\n' "simulated-reused-pid" > "$REUSED_PID_LOCK.d/token"
if env PATH="$NO_FLOCK_BIN" CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
  /bin/bash -c '
    source "$1"
    exec 9>"$2"
    flow_lock_acquire "$2" 9 0 0 auto
  ' bash "$STATE_IO" "$REUSED_PID_LOCK" >/dev/null 2>&1; then
  reused_pid_result="acquired"
else
  reused_pid_result="blocked"
fi
assert_eq "pid が別の生存 process に再利用された場合は stale lock を奪取しない" \
  "blocked" "$reused_pid_result"
rm -f "$REUSED_PID_LOCK.d/pid" "$REUSED_PID_LOCK.d/token"
rmdir "$REUSED_PID_LOCK.d"

OWNERSHIP_LOCK="$TMP_TEST_DIR/state-no-flock/ownership.lock"
ownership_result=$(env PATH="$NO_FLOCK_BIN" CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
  /bin/bash -c '
    source "$1"
    exec 9>"$2"
    flow_lock_acquire "$2" 9 0 1 auto || exit 1
    old_pid="$FLOW_LOCK_ACQUIRED_PID"
    old_token="$FLOW_LOCK_ACQUIRED_TOKEN"
    flow_lock_release "$2" mkdir "$old_pid" "$old_token" || exit 2
    flow_lock_acquire "$2" 9 0 1 auto || exit 3
    new_pid="$FLOW_LOCK_ACQUIRED_PID"
    new_token="$FLOW_LOCK_ACQUIRED_TOKEN"
    flow_lock_release "$2" mkdir "$old_pid" "$old_token" 2>/dev/null && exit 4
    [ -d "$2.d" ] || exit 5
    [ "$(cat "$2.d/token")" = "$new_token" ] || exit 6
    flow_lock_release "$2" mkdir "$new_pid" "$new_token" || exit 7
    printf protected
  ' bash "$STATE_IO" "$OWNERSHIP_LOCK" 2>&1)
assert_eq "release は取得時 token が一致する自分の lock だけを解放する" \
  "protected" "$ownership_result"

NO_FLOCK_CLEANUP_SCOPE="no-flock-cleanup-$$"
cleanup_result=$(env PATH="$NO_FLOCK_BIN" CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
  CLEANUP_FLOW_STATE_DIR="$TMP_TEST_DIR/state-no-flock-cleanup" \
  __CLEANUP_LIB_SOURCED_FOR_TEST__=1 /bin/bash -c '
    source "$1"
    base="$CLEANUP_FLOW_STATE_DIR"
    printf '\''{"branch":"feature/%s"}'\'' "$2" > "$base/flow-progress-$2.json"
    printf '\''{"scope_key":"%s"}'\'' "$2" > "$base/flow-kpi-$2.json"
    printf '\''{}'\'' > "$base/flow-context-$2.json"
    cleanup_flow_state_files "$2" final || exit 1
    [ ! -e "$base/flow-progress-$2.json" ] || exit 2
    [ ! -e "$base/flow-kpi-$2.json" ] || exit 3
    [ ! -e "$base/flow-context-$2.json" ] || exit 4
    [ -f "$base/flow-done-$2.json" ] || exit 5
    [ -f "$base/flow-kpi-history.jsonl" ] || exit 6
    [ ! -d "$base/flow-$2.lock.d" ] || exit 7
    printf cleaned
  ' bash "$CLEANUP_LIB" "$NO_FLOCK_CLEANUP_SCOPE" 2>&1)
cleanup_rc=$?
assert_eq "cleanup も flock 不在時に共通 mkdir lock で state を安全に削除する" \
  "0|cleaned" "$cleanup_rc|$cleanup_result"

NORMAL_SCOPE="normal-state-$$"
if command -v flock >/dev/null 2>&1; then
  expected_normal_backend="flock"
else
  expected_normal_backend="mkdir"
fi
normal_output=$(CLAUDE_PROJECT_DIR="$PROJECT_DIR" FLOW_STATE_DIR="$TMP_TEST_DIR/state-normal" \
  /bin/bash -c '
    source "$1"
    exec 9>"$2/backend.lock"
    flow_lock_acquire "$2/backend.lock" 9 0 30 auto || exit 1
    selected_backend="$FLOW_LOCK_ACQUIRED_BACKEND"
    selected_pid="$FLOW_LOCK_ACQUIRED_PID"
    selected_token="$FLOW_LOCK_ACQUIRED_TOKEN"
    flow_lock_release "$2/backend.lock" "$selected_backend" \
      "$selected_pid" "$selected_token"
    scope=$(flow_state_init "$3" "feature/$3" /tmp/normal-worktree) || exit 2
    flow_state_update progress '\''.phase = "P3"'\'' "$scope" || exit 3
    printf "%s|" "$selected_backend"
    flow_state_read progress '\''.phase'\'' "$scope"
  ' bash "$STATE_IO" "$TMP_TEST_DIR/state-normal" "$NORMAL_SCOPE" 2>&1)
assert_eq "通常 PATH では利用可能な backend で従来の state 経路が動く" \
  "$expected_normal_backend|P3" "$normal_output"

echo ""
echo "========================================"
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
echo "========================================"
[ "$FAILURES" -eq 0 ]
