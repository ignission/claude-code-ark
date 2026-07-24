#!/bin/bash
# =============================================================================
# .claude/lib/codex-gate.sh の PASS センチネル判定 (_codex_gate_passed) の回帰テスト
#
# ark の codex ゲートは「最終非空白行が GATE_PASS 完全一致 かつ P0/P1 マーカー不在」
# を PASS 条件とするセンチネル方式 (否定形フレーズ除外方式に代わる後継)。
# マーカー引用の誤検知・但し書き付き GATE_PASS の誤 PASS を防ぐ契約を固定する。
# =============================================================================
set -uo pipefail

TESTS=0
PASSES=0
FAILURES=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../codex-gate.sh"

TMP_TEST_DIR=$(mktemp -d "/tmp/test-codex-gate-sentinel.XXXXXX")
export FLOW_STATE_DIR="$TMP_TEST_DIR/state"
mkdir -m 700 "$FLOW_STATE_DIR"
COLLECT_SCOPE="codex-gate-collect-$$"
trap 'rm -rf "$TMP_TEST_DIR"; rm -f "/tmp/flow-progress-$COLLECT_SCOPE.json"' EXIT

# assert_gate <description> <expected: pass|fail> <file content...>
assert_gate() {
  local description="$1" expected="$2" content="$3"
  local f="$TMP_TEST_DIR/out-$TESTS.txt"
  printf '%s' "$content" > "$f"
  TESTS=$((TESTS + 1))
  local actual
  if _codex_gate_passed "$f"; then actual="pass"; else actual="fail"; fi
  if [ "$expected" = "$actual" ]; then
    PASSES=$((PASSES + 1)); echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1)); echo -e "${RED}FAIL${NC}: $description (expected=$expected actual=$actual)"
  fi
}

# --- PASS すべきケース ---
assert_gate "指摘なし + 最終行 GATE_PASS" pass \
'レビューしました。問題ありません。
GATE_PASS'

assert_gate "GATE_PASS の後に空白行が続いても PASS (末尾空白行は除外)" pass \
'レビュー結果: 指摘なし
GATE_PASS

'

assert_gate "[P2] のみ + GATE_PASS は PASS" pass \
'[P2] 軽微: コメントの typo (修正必須ではない)
GATE_PASS'

# --- FAIL すべきケース ---
assert_gate "[P0] があれば GATE_PASS があっても FAIL" fail \
'[P0] 重大: データ破壊の可能性
GATE_PASS'

assert_gate "[P1] があれば GATE_PASS があっても FAIL" fail \
'[P1] 要修正: エラーハンドリング欠落
GATE_PASS'

assert_gate "GATE_PASS の後に但し書きが続くと FAIL (最終非空白行が別)" fail \
'GATE_PASS
実はビルドが通りませんでした'

assert_gate "行内に前後空白がある GATE_PASS は FAIL (完全一致契約)" fail \
'問題なし
  GATE_PASS'

assert_gate "GATE_PASS を含むだけの文は FAIL (完全一致でない)" fail \
'GATE_PASS とは出力できません'

assert_gate "空ファイルは FAIL" fail ''

assert_gate "GATE_PASS 無し・マーカー無しの本文のみは FAIL" fail \
'指摘はありません'

# マーカー引用の誤検知はセンチネル方式では「PASS 条件側」で防ぐ:
# 本文中の [P0] 引用があると FAIL に倒れる (fail-safe。誤 PASS よりよい)
assert_gate "本文中の [P0] 引用は fail-safe で FAIL (誤 PASS しない)" fail \
'このゲートは [P0] マーカーを検出します、という説明。
GATE_PASS'

echo ""
echo "=== codex gate output / finding state directory ==="
PLAN_FILE="$TMP_TEST_DIR/plan.md"
printf '%s\n' '# test plan' > "$PLAN_FILE"
_codex_available() { return 0; }
_run_codex() {
  local previous=""
  local argument
  for argument in "$@"; do
    if [ "$previous" = "--output-last-message" ]; then
      printf '%s\n' "GATE_PASS" > "$argument"
      break
    fi
    previous="$argument"
  done
  # review gate は git diff を stdin で渡すため、実 codex と同様に最後まで消費する。
  command cat >/dev/null || true
  printf '%s\n' "stub codex log"
}

TESTS=$((TESTS + 1))
if codex_gate_review_plan "$PLAN_FILE" "$COLLECT_SCOPE" >/dev/null 2>&1 \
  && [ "${CODEX_GATE_OUTPUT#"$FLOW_STATE_DIR/"}" != "$CODEX_GATE_OUTPUT" ] \
  && [ -f "$CODEX_GATE_OUTPUT" ] \
  && [ -f "${CODEX_GATE_OUTPUT}.final" ]; then
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: gate log と .final は FLOW_STATE_DIR 配下に作られる"
else
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: gate log または .final が FLOW_STATE_DIR 配下に作られない"
fi

TESTS=$((TESTS + 1))
if codex_gate_review "P5" "$COLLECT_SCOPE" >/dev/null 2>&1 \
  && [ "${CODEX_GATE_OUTPUT#"$FLOW_STATE_DIR/"}" != "$CODEX_GATE_OUTPUT" ] \
  && [ -f "$CODEX_GATE_OUTPUT" ] \
  && [ -f "${CODEX_GATE_OUTPUT}.final" ]; then
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: 通常 gate phase の log と .final も FLOW_STATE_DIR 配下に作られる"
else
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: 通常 gate phase の log または .final が FLOW_STATE_DIR 配下に作られない"
fi

SEEN_MSG="src/seen.ts:10 existing finding"
NEW_MSG="src/new.ts:20 new finding"
SEEN_FP=$(_codex_fingerprint "src/seen.ts" "10" "$SEEN_MSG")
printf '{"gate_findings_seen":["%s"]}\n' "$SEEN_FP" \
  > "$FLOW_STATE_DIR/flow-progress-$COLLECT_SCOPE.json"
CODEX_GATE_OUTPUT="$TMP_TEST_DIR/findings.txt"
printf '%s\n%s\n' "$SEEN_MSG" "$NEW_MSG" > "$CODEX_GATE_OUTPUT"
EXPECTED_NEW_FP=$(_codex_fingerprint "src/new.ts" "20" "$NEW_MSG")
ACTUAL_NEW_FP=$(codex_gate_collect_new_findings "$COLLECT_SCOPE")
TESTS=$((TESTS + 1))
if [ "$ACTUAL_NEW_FP" = "$EXPECTED_NEW_FP" ]; then
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: finding 重複判定は FLOW_STATE_DIR 配下の progress を読む"
else
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: finding 重複判定が FLOW_STATE_DIR 配下の progress を読まない"
  echo "  expected: $EXPECTED_NEW_FP"
  echo "  actual:   $ACTUAL_NEW_FP"
fi

echo ""
echo "========================================"
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
echo "========================================"
[ "$FAILURES" -eq 0 ]
