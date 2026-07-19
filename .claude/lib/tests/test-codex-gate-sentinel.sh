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
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../codex-gate.sh"

TMP_TEST_DIR=$(mktemp -d "/tmp/test-codex-gate-sentinel.XXXXXX")
trap 'rm -rf "$TMP_TEST_DIR"' EXIT

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
echo "========================================"
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
echo "========================================"
[ "$FAILURES" -eq 0 ]
