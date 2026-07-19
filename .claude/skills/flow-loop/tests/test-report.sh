#!/bin/bash
# =============================================================================
# .claude/skills/flow-loop/lib/report.sh のリードタイム内訳集計を固定 fixture で検証する
# =============================================================================
set -uo pipefail

TESTS=0
PASSES=0
FAILURES=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

assert_true() {
  local description="$1"
  local cmd="$2"
  TESTS=$((TESTS + 1))
  if eval "$cmd" >/dev/null 2>&1; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description (cond: $cmd)"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPORT="$SCRIPT_DIR/../lib/report.sh"

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# fixture: pick(t=0) → park plan-review(t=300) → fix(t=600・待ち300) →
#          park plan-review(t=900) → plan-approved(t=1200・待ち300) →
#          park merge-review(t=1800) → merged(t=2400・待ち600) → done(t=3000)
# total=3000s(50min) / wait=1200s(20min) / machine=1800s(30min) / wait%=40
cat > "$TMPD/metrics.jsonl" <<'EOF'
{"ts":1000000000,"ticket":"issue-1t","event":"pick","engine":"codex"}
{"ts":1000000300,"ticket":"issue-1t","event":"park","gate":"plan-review","pr_number":1}
{"ts":1000000600,"ticket":"issue-1t","event":"fix","pr_number":1}
{"ts":1000000900,"ticket":"issue-1t","event":"park","gate":"plan-review","pr_number":1}
{"ts":1000001200,"ticket":"issue-1t","event":"plan-approved","pr_number":1}
{"ts":1000001800,"ticket":"issue-1t","event":"park","gate":"merge-review","pr_number":1}
{"ts":1000002400,"ticket":"issue-1t","event":"merged","pr_number":1}
{"ts":1000003000,"ticket":"issue-1t","event":"done","deploy_status":"success"}
{"ts":1000000100,"ticket":"issue-2t","event":"pick","engine":"codex"}
EOF

OUT="$(bash "$REPORT" "$TMPD/metrics.jsonl")"
echo "$OUT"

assert_true "ヘッダ行が出る" 'echo "$OUT" | grep -q "TICKET"'
assert_true "total 50 分" 'echo "$OUT" | grep "issue-1t" | grep -qw "50"'
assert_true "人間待ち 20 分 (fix 300s + plan-approved 300s + merged 600s)" 'echo "$OUT" | grep "issue-1t" | grep -qw "20"'
assert_true "機械時間 30 分" 'echo "$OUT" | grep "issue-1t" | grep -qw "30"'
assert_true "待ち比率 40%" 'echo "$OUT" | grep "issue-1t" | grep -qw "40"'
assert_true "done が無い run は集計に出ない" '! echo "$OUT" | grep -q "issue-2t"'
assert_true "不在ファイルはエラー" '! bash "$REPORT" "$TMPD/nonexistent.jsonl"'

echo ""
echo "=== 結果: $PASSES/$TESTS PASS ==="
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
