#!/usr/bin/env bash
# =============================================================================
# flow / flow-x codex stdin contract regression test
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
FLOW_SKILL="$PROJECT_DIR/.claude/skills/flow/SKILL.md"
FLOW_X_SKILL="$PROJECT_DIR/.claude/skills/flow-x/SKILL.md"
CODEX_GATE="$PROJECT_DIR/.claude/lib/codex-gate.sh"

for required_file in "$FLOW_SKILL" "$FLOW_X_SKILL" "$CODEX_GATE"; do
  TESTS=$((TESTS + 1))
  if [ -f "$required_file" ]; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: required file exists: $required_file"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: required file missing: $required_file"
  fi
done

FLOW_X_COMMANDS=$(awk '
  /^nohup codex exec / { command=$0; collecting=1; next }
  collecting { command=command " " $0 }
  collecting && /&[[:space:]]*$/ { print command; command=""; collecting=0 }
' "$FLOW_X_SKILL")

FLOW_X_INVOCATIONS=$(printf '%s\n' "$FLOW_X_COMMANDS" | grep -c '^nohup codex exec ' || true)
FLOW_X_OPEN_STDIN=$(printf '%s\n' "$FLOW_X_COMMANDS" | awk '
  /^nohup codex exec / && index($0, " < /dev/null ") == 0 { missing++ }
  END { print missing + 0 }
')
FLOW_X_UNSCOPED_LOGS=$(printf '%s\n' "$FLOW_X_COMMANDS" | awk '
  /^nohup codex exec / && $0 !~ /codex-(<phase>|p2|p3)-\$\{SCOPE_KEY\}-run\.log/ { missing++ }
  END { print missing + 0 }
')

echo "=== flow-x detached codex stdin ==="
assert_eq "detached codex invocation count" "4" "$FLOW_X_INVOCATIONS"
assert_eq "detached codex invocation missing closed stdin" "0" "$FLOW_X_OPEN_STDIN"
assert_eq "detached codex invocation missing scoped run log" "0" "$FLOW_X_UNSCOPED_LOGS"
assert_eq "P8 reuses the documented codex invocation" "1" \
  "$(grep -c 'codex exec.*前節.*invocation.*各 auto-fixable' "$FLOW_X_SKILL" || true)"

GATE_EXEC_COUNT=$(grep -c '_run_codex exec ' "$CODEX_GATE" || true)
GATE_DIFF_STDIN=$(awk '
  /git diff --no-ext-diff origin\/main\.\.\.HEAD/ { seen_diff=1 }
  seen_diff && /\| _run_codex exec / { found=1 }
  END { print found + 0 }
' "$CODEX_GATE")
GATE_PLAN_STDIN=$(awk '
  /_run_codex exec / { in_exec=1 }
  in_exec && /< "\$plan_path"/ { found=1; in_exec=0 }
  END { print found + 0 }
' "$CODEX_GATE")

echo ""
echo "=== normal flow supplied stdin ==="
assert_eq "codex-gate has two codex exec invocations" "2" "$GATE_EXEC_COUNT"
assert_eq "diff review supplies git diff on stdin" "1" "$GATE_DIFF_STDIN"
assert_eq "plan review supplies plan file on stdin" "1" "$GATE_PLAN_STDIN"
assert_eq "flow sources codex-gate.sh" "1" \
  "$(grep -c 'source .*\.claude/lib/codex-gate\.sh' "$FLOW_SKILL" || true)"
assert_eq "flow calls codex review gates" "1" \
  "$(grep -c 'codex_gate_review_plan ' "$FLOW_SKILL" | awk '{ print ($1 > 0) ? 1 : 0 }')"

echo ""
echo "========================================"
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
if [ "$FAILURES" -gt 0 ]; then
  echo -e "${RED}FAILED${NC}"
  exit 1
fi
echo -e "${GREEN}ALL PASSED${NC}"
