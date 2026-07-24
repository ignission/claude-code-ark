#!/usr/bin/env bash
# =============================================================================
# flow state directory resolver の security contract / integration audit
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

assert_success() {
  local description="$1"
  shift
  TESTS=$((TESTS + 1))
  if "$@"; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description"
  fi
}

assert_failure_reason() {
  local description="$1"
  local expected_reason="$2"
  shift 2
  local output rc
  output=$("$@" 2>&1)
  rc=$?
  TESTS=$((TESTS + 1))
  if [ "$rc" -ne 0 ] && printf '%s\n' "$output" | grep -q "$expected_reason"; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description"
    echo "  expected non-zero and diagnostic containing: $expected_reason"
    echo "  rc: $rc"
    echo "  output: $output"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RESOLVER="$SCRIPT_DIR/../flow-state-dir.sh"

if [ ! -f "$RESOLVER" ]; then
  echo -e "${RED}FAIL${NC}: resolver が存在しない: $RESOLVER"
  exit 1
fi

# shellcheck disable=SC1090
source "$RESOLVER"

TMP_TEST_DIR=$(mktemp -d "/tmp/test-flow-state-dir.XXXXXX")
FALLBACK_DIR="/tmp/ark-flow-$(id -u)"
trap 'rm -rf "$TMP_TEST_DIR"' EXIT

REAL_STAT=$(command -v stat)

run_default_init() {
  env -u FLOW_STATE_DIR -u XDG_RUNTIME_DIR \
    CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
    bash -c 'source "$CLAUDE_PROJECT_DIR/.claude/lib/flow-state-dir.sh"; flow_state_dir_init >/dev/null'
}

run_xdg_init() {
  local xdg_dir="$1"
  env -u FLOW_STATE_DIR XDG_RUNTIME_DIR="$xdg_dir" \
    CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
    bash -c 'source "$CLAUDE_PROJECT_DIR/.claude/lib/flow-state-dir.sh"; flow_state_dir_init >/dev/null'
}

echo "=== secure default path / creation ==="
unset FLOW_STATE_DIR XDG_RUNTIME_DIR
assert_eq "XDG 未設定時の既定 path" \
  "$FALLBACK_DIR" "$(_flow_state_dir_default)"
assert_success "XDG 未設定時の既定 directory を初期化できる" run_default_init
assert_eq "fallback directory mode は 0700" "700" "$("$REAL_STAT" -c '%a' "$FALLBACK_DIR")"

XDG_OK="$TMP_TEST_DIR/xdg-ok"
mkdir -m 700 "$XDG_OK"
unset FLOW_STATE_DIR
export XDG_RUNTIME_DIR="$XDG_OK"
assert_eq "XDG 設定時の既定 path" \
  "$XDG_OK/ark-flow-$(id -u)" "$(_flow_state_dir_default)"
assert_success "XDG 配下に既定 directory を作成できる" run_xdg_init "$XDG_OK"
assert_eq "XDG 配下の新規 directory mode は 0700" \
  "700" "$("$REAL_STAT" -c '%a' "$XDG_OK/ark-flow-$(id -u)")"
assert_success "既存 0700 directory は冪等に成功する" run_xdg_init "$XDG_OK"

echo ""
echo "=== fail-closed invariants ==="
XDG_BAD_MODE="$TMP_TEST_DIR/xdg-bad-mode"
mkdir -m 700 "$XDG_BAD_MODE"
mkdir -m 755 "$XDG_BAD_MODE/ark-flow-$(id -u)"
assert_failure_reason "既存 mode 0755 を拒否する" "mode" run_xdg_init "$XDG_BAD_MODE"

XDG_SYMLINK="$TMP_TEST_DIR/xdg-symlink"
XDG_SYMLINK_TARGET="$TMP_TEST_DIR/xdg-symlink-target"
mkdir -m 700 "$XDG_SYMLINK" "$XDG_SYMLINK_TARGET"
ln -s "$XDG_SYMLINK_TARGET" "$XDG_SYMLINK/ark-flow-$(id -u)"
assert_failure_reason "既存 symlink を拒否する" "symlink" run_xdg_init "$XDG_SYMLINK"

make_stat_stub() {
  local stub_dir="$1"
  local flavor="$2"
  mkdir -p "$stub_dir"
  if [ "$flavor" = "gnu" ]; then
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'if [ "${1:-}" = "-c" ]; then printf "%s %s\n" "$FLOW_TEST_STAT_UID" "$FLOW_TEST_STAT_MODE"; exit 0; fi' \
      'exit 1' > "$stub_dir/stat"
  elif [ "$flavor" = "bsd" ]; then
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'if [ "${1:-}" = "-c" ]; then exit 1; fi' \
      'if [ "${1:-}" = "-f" ]; then printf "%s %s\n" "$FLOW_TEST_STAT_UID" "$FLOW_TEST_STAT_MODE"; exit 0; fi' \
      'exit 1' > "$stub_dir/stat"
  else
    printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$stub_dir/stat"
  fi
  chmod 700 "$stub_dir/stat"
}

run_stubbed_default_init() {
  local stub_dir="$1"
  local uid="$2"
  local mode="$3"
  env -u FLOW_STATE_DIR -u XDG_RUNTIME_DIR \
    PATH="$stub_dir:$PATH" \
    FLOW_TEST_STAT_UID="$uid" \
    FLOW_TEST_STAT_MODE="$mode" \
    CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
    bash -c 'source "$CLAUDE_PROJECT_DIR/.claude/lib/flow-state-dir.sh"; flow_state_dir_init >/dev/null'
}

GNU_STUB="$TMP_TEST_DIR/stat-gnu"
BSD_STUB="$TMP_TEST_DIR/stat-bsd"
ERROR_STUB="$TMP_TEST_DIR/stat-error"
make_stat_stub "$GNU_STUB" gnu
make_stat_stub "$BSD_STUB" bsd
make_stat_stub "$ERROR_STUB" error

assert_failure_reason "foreign UID を拒否する (root 権限不要 stub)" "owner" \
  run_stubbed_default_init "$GNU_STUB" "$(( $(id -u) + 1 ))" 700
assert_success "GNU stat 形式を受理する" \
  run_stubbed_default_init "$GNU_STUB" "$(id -u)" 700
assert_success "BSD stat 形式へ fallback できる" \
  run_stubbed_default_init "$BSD_STUB" "$(id -u)" 700
assert_failure_reason "stat 不能を拒否する" "stat" \
  run_stubbed_default_init "$ERROR_STUB" "$(id -u)" 700

XDG_UNSAFE="$TMP_TEST_DIR/xdg-unsafe"
mkdir -m 770 "$XDG_UNSAFE"
assert_failure_reason "明示 XDG_RUNTIME_DIR の group-writable mode を拒否する" \
  "XDG_RUNTIME_DIR" run_xdg_init "$XDG_UNSAFE"

XDG_LINK_TARGET="$TMP_TEST_DIR/xdg-link-target"
XDG_LINK="$TMP_TEST_DIR/xdg-link"
mkdir -m 700 "$XDG_LINK_TARGET"
ln -s "$XDG_LINK_TARGET" "$XDG_LINK"
assert_failure_reason "symlink の XDG_RUNTIME_DIR を拒否する" \
  "XDG_RUNTIME_DIR" run_xdg_init "$XDG_LINK"

OVERRIDE_INSECURE="$TMP_TEST_DIR/operator-override"
mkdir -m 755 "$OVERRIDE_INSECURE"
OVERRIDE_OUTPUT=$(FLOW_STATE_DIR="$OVERRIDE_INSECURE" \
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" bash -c \
  'source "$CLAUDE_PROJECT_DIR/.claude/lib/flow-state-dir.sh"; flow_state_dir_init; printf "%s" "$FLOW_STATE_DIR"' \
  2>&1)
assert_eq "明示 FLOW_STATE_DIR は insecure mode でも拒否せず同じ path を使う" \
  "$OVERRIDE_INSECURE" "$(printf '%s\n' "$OVERRIDE_OUTPUT" | tail -1)"
assert_eq "明示 FLOW_STATE_DIR の mode を chmod で修復しない" \
  "755" "$("$REAL_STAT" -c '%a' "$OVERRIDE_INSECURE")"
assert_success "明示 FLOW_STATE_DIR が契約外なら security opt-out warning を出す" \
  bash -c "printf '%s\n' \"\$1\" | grep -q 'WARNING: FLOW_STATE_DIR override'" _ "$OVERRIDE_OUTPUT"

if command -v zsh >/dev/null 2>&1; then
  ZSH_XDG="$TMP_TEST_DIR/xdg-zsh"
  mkdir -m 700 "$ZSH_XDG"
  assert_success "zsh でも secure default resolver が動く" \
    env -u FLOW_STATE_DIR XDG_RUNTIME_DIR="$ZSH_XDG" CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
      zsh -c 'source "$CLAUDE_PROJECT_DIR/.claude/lib/flow-state-dir.sh"; flow_state_dir_init; [ "$FLOW_STATE_DIR" = "$XDG_RUNTIME_DIR/ark-flow-$(id -u)" ]'
fi

echo ""
echo "=== SKILL snippets / production literal audit ==="
assert_success "flow SKILL.md に /tmp/flow-* 直書きがない" \
  bash -c "! grep -nE '/tmp/(flow-)' '$PROJECT_DIR/.claude/skills/flow/SKILL.md'"
assert_success "flow-x SKILL.md に /tmp/flow-*・flowx-*・codex-* 直書きがない" \
  bash -c "! grep -nE '/tmp/(flow-|flowx-|codex-)' '$PROJECT_DIR/.claude/skills/flow-x/SKILL.md'"
assert_success "flow-loop SKILL.md に /tmp/flow-* 直書きがない" \
  bash -c "! grep -nE '/tmp/(flow-)' '$PROJECT_DIR/.claude/skills/flow-loop/SKILL.md'"

AUDIT_OUTPUT=$(rg -n '/tmp/(flow-|flowx-|codex-)' \
  "$PROJECT_DIR"/.claude/lib/*.sh \
  "$PROJECT_DIR"/.claude/skills/flow-loop/lib/*.sh \
  "$PROJECT_DIR"/.claude/skills/flow/SKILL.md \
  "$PROJECT_DIR"/.claude/skills/flow-x/SKILL.md \
  "$PROJECT_DIR"/.claude/skills/flow-loop/SKILL.md 2>/dev/null || true)
TESTS=$((TESTS + 1))
if [ -z "$AUDIT_OUTPUT" ]; then
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: production script / SKILL.md の flow/codex /tmp literal は 0 件"
else
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: production script / SKILL.md に flow/codex /tmp literal が残存"
  printf '%s\n' "$AUDIT_OUTPUT"
fi

echo ""
echo "========================================"
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
echo "========================================"
[ "$FAILURES" -eq 0 ]
