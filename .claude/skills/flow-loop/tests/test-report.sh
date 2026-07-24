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
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
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

write_minimal_metrics() {
  local metrics_file="$1"
  local ticket="$2"
  mkdir -p "$(dirname "$metrics_file")"
  printf '%s\n' \
    "{\"ts\":100,\"ticket\":\"$ticket\",\"event\":\"pick\"}" \
    "{\"ts\":160,\"ticket\":\"$ticket\",\"event\":\"done\"}" \
    > "$metrics_file"
}

echo ""
echo "=== metrics path priority ==="
CLI_DIR="$TMPD/cli"
LOOP_DIR="$TMPD/loop"
COMMON_DIR="$TMPD/common"
XDG_DIR="$TMPD/xdg"
mkdir -m 700 "$CLI_DIR" "$LOOP_DIR" "$COMMON_DIR" "$XDG_DIR"
write_minimal_metrics "$CLI_DIR/metrics.jsonl" "cli-ticket"
write_minimal_metrics "$LOOP_DIR/flow-loop-metrics.jsonl" "loop-ticket"
write_minimal_metrics "$COMMON_DIR/flow-loop-metrics.jsonl" "common-ticket"
DEFAULT_DIR="$XDG_DIR/ark-flow-$(id -u)"
mkdir -m 700 "$DEFAULT_DIR"
write_minimal_metrics "$DEFAULT_DIR/flow-loop-metrics.jsonl" "default-ticket"

PRIORITY_OUT=$(FLOW_LOOP_STATE_DIR="$LOOP_DIR" FLOW_STATE_DIR="$COMMON_DIR" \
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" bash "$REPORT" "$CLI_DIR/metrics.jsonl")
assert_true "CLI 第1引数が最優先" \
  'echo "$PRIORITY_OUT" | grep -q "cli-ticket" && ! echo "$PRIORITY_OUT" | grep -q "loop-ticket"'

LOOP_OUT=$(FLOW_LOOP_STATE_DIR="$LOOP_DIR" FLOW_STATE_DIR="$COMMON_DIR" \
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" bash "$REPORT")
assert_true "FLOW_LOOP_STATE_DIR は FLOW_STATE_DIR より優先" \
  'echo "$LOOP_OUT" | grep -q "loop-ticket" && ! echo "$LOOP_OUT" | grep -q "common-ticket"'

COMMON_OUT=$(env -u FLOW_LOOP_STATE_DIR FLOW_STATE_DIR="$COMMON_DIR" \
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" bash "$REPORT")
assert_true "限定 override 未指定時は FLOW_STATE_DIR を使う" \
  'echo "$COMMON_OUT" | grep -q "common-ticket"'

DEFAULT_OUT=$(env -u FLOW_LOOP_STATE_DIR -u FLOW_STATE_DIR \
  XDG_RUNTIME_DIR="$XDG_DIR" bash "$REPORT")
assert_true "全 override 未指定時は XDG secure default を使う" \
  'echo "$DEFAULT_OUT" | grep -q "default-ticket"'

echo ""
echo "=== 結果: $PASSES/$TESTS PASS ==="
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
