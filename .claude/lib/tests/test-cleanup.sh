#!/bin/bash
# =============================================================================
# .claude/lib/cleanup.sh の純粋関数テスト (cleanup_flow_state_files / cleanup_post_deploy)
# ark に docker (testcontainers / dangling volume) 依存の cleanup は無いため対象外
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

assert_file_absent() {
  local description="$1"
  local file_path="$2"
  TESTS=$((TESTS + 1))
  if [ ! -e "$file_path" ]; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description (still exists: $file_path)"
  fi
}

assert_file_present() {
  local description="$1"
  local file_path="$2"
  TESTS=$((TESTS + 1))
  if [ -e "$file_path" ]; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description (expected: $file_path)"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLEANUP_LIB="$SCRIPT_DIR/../cleanup.sh"
export CLAUDE_PROJECT_DIR="$PROJECT_DIR"

# pre-flight: jq が無いと KPI archive のテストが意味を成さない
if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq 未インストールのため test-cleanup.sh をスキップ" >&2
  exit 0
fi

# 副作用回避ガード
export __CLEANUP_LIB_SOURCED_FOR_TEST__=1
# shellcheck disable=SC1090
source "$CLEANUP_LIB"

# テスト用 tmpdir を確保 (本物の /tmp を汚さない)
TMP_TEST_DIR=$(mktemp -d "/tmp/test-cleanup-flow-state.XXXXXX")
LEGACY_SCOPE="cleanup-common-$$"
trap 'rm -rf "$TMP_TEST_DIR"; rm -f "/tmp/flow-$LEGACY_SCOPE.lock"' EXIT

# cleanup_flow_state_files が参照する base dir を CLEANUP_FLOW_STATE_DIR で差し替える
export CLEANUP_FLOW_STATE_DIR="$TMP_TEST_DIR"

echo "=== cleanup_flow_state_files: scope-specific 削除 ==="
echo ""

SCOPE="issue-744"
OTHER_SCOPE="issue-999"

# 削除対象を作成
# progress.json は branch field を含む valid JSON (sentinel が branch を読むため)
echo '{"phase":"done","branch":"feature/issue-744/cleanup-test"}' > "$TMP_TEST_DIR/flow-progress-${SCOPE}.json"
touch "$TMP_TEST_DIR/flow-kpi-${SCOPE}.json"
touch "$TMP_TEST_DIR/flow-context-${SCOPE}.json"
touch "$TMP_TEST_DIR/flow-${SCOPE}.lock"
touch "$TMP_TEST_DIR/codex-gate-P2-${SCOPE}-AAAAAA.txt"
touch "$TMP_TEST_DIR/codex-gate-P5-${SCOPE}-BBBBBB.txt"
touch "$TMP_TEST_DIR/codex-gate-P8-${SCOPE}-CCCCCC.txt"
touch "$TMP_TEST_DIR/codex-gate-P9-${SCOPE}-DDDDDD.txt"
# 一時 .new.* ファイル (state-io の atomic write の中間ファイル)
touch "$TMP_TEST_DIR/flow-progress-${SCOPE}.json.new.12345"
touch "$TMP_TEST_DIR/flow-context-${SCOPE}.json.new.67890"

# 同 scope ではない別 ticket のファイル (削除されないことを確認)
touch "$TMP_TEST_DIR/flow-progress-${OTHER_SCOPE}.json"
touch "$TMP_TEST_DIR/codex-gate-P2-${OTHER_SCOPE}-XXXXXX.txt"

# 別 prefix のファイル (誤爆しないことを確認)
touch "$TMP_TEST_DIR/codex-final-review.txt"
touch "$TMP_TEST_DIR/flow-bash-blocks.sh"

# --- final mode (success / no-target): 全 state を消す (kpi は history に append) ---
echo '{"scope":"test","deploy_status":"success"}' > "$TMP_TEST_DIR/flow-kpi-${SCOPE}.json"
cleanup_flow_state_files "$SCOPE" final

assert_file_absent "[final] scope の progress.json が削除される" "$TMP_TEST_DIR/flow-progress-${SCOPE}.json"
assert_file_absent "[final] scope の kpi.json も削除される (flow_state_init の再起動阻害を解消)" "$TMP_TEST_DIR/flow-kpi-${SCOPE}.json"
assert_file_present "[final] kpi snapshot が flow-kpi-history.jsonl に append される" "$TMP_TEST_DIR/flow-kpi-history.jsonl"
TESTS=$((TESTS + 1))
if grep -q '"deploy_status":"success"' "$TMP_TEST_DIR/flow-kpi-history.jsonl" 2>/dev/null; then
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: kpi history に元の内容が含まれる"
else
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: kpi history に元の内容が含まれない"
fi
assert_file_absent "[final] scope の context.json が削除される" "$TMP_TEST_DIR/flow-context-${SCOPE}.json"
# .lock は state-io の inode invariant のため削除しない
assert_file_present "[final] scope の .lock は削除されない (state-io inode invariant)" "$TMP_TEST_DIR/flow-${SCOPE}.lock"
assert_file_absent "[final] scope の codex-gate P2 ログが削除される" "$TMP_TEST_DIR/codex-gate-P2-${SCOPE}-AAAAAA.txt"
assert_file_absent "[final] scope の codex-gate P5 ログが削除される" "$TMP_TEST_DIR/codex-gate-P5-${SCOPE}-BBBBBB.txt"
assert_file_absent "[final] scope の codex-gate P8 ログが削除される" "$TMP_TEST_DIR/codex-gate-P8-${SCOPE}-CCCCCC.txt"
assert_file_absent "[final] scope の codex-gate P9 ログが削除される" "$TMP_TEST_DIR/codex-gate-P9-${SCOPE}-DDDDDD.txt"
assert_file_absent "[final] scope の atomic write 中間 .new.* (progress) が削除される" "$TMP_TEST_DIR/flow-progress-${SCOPE}.json.new.12345"
assert_file_absent "[final] scope の atomic write 中間 .new.* (context) が削除される" "$TMP_TEST_DIR/flow-context-${SCOPE}.json.new.67890"

assert_file_present "別 scope の progress.json は残る" "$TMP_TEST_DIR/flow-progress-${OTHER_SCOPE}.json"
assert_file_present "別 scope の codex-gate ログは残る" "$TMP_TEST_DIR/codex-gate-P2-${OTHER_SCOPE}-XXXXXX.txt"
assert_file_present "別 prefix の codex-final-review.txt は残る" "$TMP_TEST_DIR/codex-final-review.txt"
assert_file_present "別 prefix の flow-bash-blocks.sh は残る" "$TMP_TEST_DIR/flow-bash-blocks.sh"

# done sentinel が残されること (「完了済み」検出用)
assert_file_present "[final] flow-done-<scope>.json sentinel が作成される" "$TMP_TEST_DIR/flow-done-${SCOPE}.json"
TESTS=$((TESTS + 1))
if jq -e '.scope_key' "$TMP_TEST_DIR/flow-done-${SCOPE}.json" >/dev/null 2>&1; then
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: done sentinel が valid JSON で scope_key を含む"
else
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: done sentinel が valid JSON でない"
fi
# branch field も含むこと (同 SCOPE_KEY 別 branch で誤 halt 防止)
TESTS=$((TESTS + 1))
SENTINEL_BRANCH=$(jq -r '.branch // ""' "$TMP_TEST_DIR/flow-done-${SCOPE}.json" 2>/dev/null)
if [ "$SENTINEL_BRANCH" = "feature/issue-744/cleanup-test" ]; then
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: done sentinel の branch が progress.json から読み取られている"
else
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: done sentinel の branch が誤り (expected: feature/issue-744/cleanup-test, actual: $SENTINEL_BRANCH)"
fi

# --- resumable mode (failure / timeout / poll-error): progress / context は残す ---
echo ""
echo "--- cleanup_flow_state_files: resumable mode (failure 系) では state を残す ---"
RESUMABLE_SCOPE="issue-444"
touch "$TMP_TEST_DIR/flow-progress-${RESUMABLE_SCOPE}.json" \
      "$TMP_TEST_DIR/flow-kpi-${RESUMABLE_SCOPE}.json" \
      "$TMP_TEST_DIR/flow-context-${RESUMABLE_SCOPE}.json" \
      "$TMP_TEST_DIR/flow-${RESUMABLE_SCOPE}.lock" \
      "$TMP_TEST_DIR/codex-gate-P5-${RESUMABLE_SCOPE}-RRRRRR.txt" \
      "$TMP_TEST_DIR/flow-progress-${RESUMABLE_SCOPE}.json.new.999" \
      "$TMP_TEST_DIR/flow-context-${RESUMABLE_SCOPE}.json.new.888"

cleanup_flow_state_files "$RESUMABLE_SCOPE" resumable

# resumable mode は state (progress/context/kpi/lock) を全て残し、log のみ消す
assert_file_present "[resumable] progress.json は残る (--resume 用)" "$TMP_TEST_DIR/flow-progress-${RESUMABLE_SCOPE}.json"
assert_file_present "[resumable] kpi.json は残る (--kpi 集計用)" "$TMP_TEST_DIR/flow-kpi-${RESUMABLE_SCOPE}.json"
assert_file_present "[resumable] context.json は残る (--resume 用)" "$TMP_TEST_DIR/flow-context-${RESUMABLE_SCOPE}.json"
assert_file_present "[resumable] .lock は残る (state-io invariant)" "$TMP_TEST_DIR/flow-${RESUMABLE_SCOPE}.lock"
assert_file_absent "[resumable] codex-gate ログは削除される" "$TMP_TEST_DIR/codex-gate-P5-${RESUMABLE_SCOPE}-RRRRRR.txt"
assert_file_absent "[resumable] .new.* (progress) は削除される" "$TMP_TEST_DIR/flow-progress-${RESUMABLE_SCOPE}.json.new.999"
assert_file_absent "[resumable] .new.* (context) は削除される" "$TMP_TEST_DIR/flow-context-${RESUMABLE_SCOPE}.json.new.888"
# done sentinel は作らない (resumable は完了扱いではないため)
assert_file_absent "[resumable] done sentinel は作らない" "$TMP_TEST_DIR/flow-done-${RESUMABLE_SCOPE}.json"

echo ""
echo "--- cleanup_flow_state_files: 不正な mode は fail-fast ---"
TESTS=$((TESTS + 1))
if cleanup_flow_state_files "VALID-1234abcd" "bogus_mode" >/dev/null 2>&1; then
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: 不明な mode を許容してしまった"
else
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: 不明な mode を fail-fast"
fi

echo ""
echo "--- cleanup_flow_state_files: scope_key 空の場合は fail-fast ---"
TESTS=$((TESTS + 1))
if cleanup_flow_state_files "" >/dev/null 2>&1; then
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: 空 scope_key で fail-fast されない"
else
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: 空 scope_key で fail-fast (return!=0)"
fi

echo ""
echo "--- cleanup_flow_state_files: scope_key 危険文字を whitelist 違反として拒否 ---"
# whitelist `^[A-Za-z0-9_-]+$` 違反パターンを網羅的にテスト
for bad_scope in \
  "../etc" \
  "/abs/path" \
  "with space" \
  "with*glob" \
  "with?glob" \
  "with[bracket" \
  "with;semicolon" \
  "with\$dollar" \
  "with.dot" \
  "with/slash"; do
  TESTS=$((TESTS + 1))
  if cleanup_flow_state_files "$bad_scope" >/dev/null 2>&1; then
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: 危険な scope_key を許容してしまった: $bad_scope"
  else
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: 危険 scope_key を fail-fast: $bad_scope"
  fi
done

echo ""
echo "--- cleanup_flow_state_files: glob 混入で別 scope を誤削除しないこと ---"
# whitelist チェックで弾くはずだが、実装漏れに備えて誤削除がないことも assert する
touch "$TMP_TEST_DIR/flow-progress-OTHER-1234567890ab.json"
cleanup_flow_state_files "OTHER-*" >/dev/null 2>&1 || true
assert_file_present "glob 混入 scope_key で別ファイルが残ること" "$TMP_TEST_DIR/flow-progress-OTHER-1234567890ab.json"

echo ""
echo "--- cleanup_flow_state_files: sentinel 二段階コミット (クラッシュ回復) ---"
# sentinel 書き込み後・KPI archive 前にクラッシュしたケースを再現:
# archived=false の sentinel + state が残っている状態で final を再実行したとき、
# 「archive 済み」と誤認して KPI を捨てず、archive してから削除すること
CRASH_SCOPE="issue-666"
echo '{"phase":"done","branch":"feature/issue-666/crash-test"}' > "$TMP_TEST_DIR/flow-progress-${CRASH_SCOPE}.json"
echo '{"scope":"crash","deploy_status":"success","marker":"crash-recovery-kpi"}' > "$TMP_TEST_DIR/flow-kpi-${CRASH_SCOPE}.json"
touch "$TMP_TEST_DIR/flow-context-${CRASH_SCOPE}.json"
# クラッシュ時に残る sentinel (archived=false 相当。旧版の archived 無し sentinel も同義)
echo '{"scope_key":"issue-666","branch":"feature/issue-666/crash-test","completed_at":1,"source":"cleanup_post_deploy(final)","archived":false}' \
  > "$TMP_TEST_DIR/flow-done-${CRASH_SCOPE}.json"
cleanup_flow_state_files "$CRASH_SCOPE" final
TESTS=$((TESTS + 1))
if grep -q 'crash-recovery-kpi' "$TMP_TEST_DIR/flow-kpi-history.jsonl" 2>/dev/null; then
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: archived=false sentinel 残存時も KPI が history に archive される (旧版は消失)"
else
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: archived=false sentinel 残存時に KPI が archive されず失われた"
fi
assert_file_absent "[crash-recovery] 再実行で state は削除される" "$TMP_TEST_DIR/flow-progress-${CRASH_SCOPE}.json"
TESTS=$((TESTS + 1))
if [ "$(jq -r '.archived' "$TMP_TEST_DIR/flow-done-${CRASH_SCOPE}.json" 2>/dev/null)" = "true" ]; then
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: 完了後の sentinel は archived=true にコミットされる"
else
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: sentinel の archived が true になっていない"
fi
# archived=true の sentinel での再実行は KPI を二重 archive しない
HIST_LINES_BEFORE=$(wc -l < "$TMP_TEST_DIR/flow-kpi-history.jsonl" | tr -d ' ')
echo '{"phase":"done","branch":"feature/issue-666/crash-test"}' > "$TMP_TEST_DIR/flow-progress-${CRASH_SCOPE}.json"
echo '{"scope":"crash","marker":"should-not-be-archived"}' > "$TMP_TEST_DIR/flow-kpi-${CRASH_SCOPE}.json"
cleanup_flow_state_files "$CRASH_SCOPE" final
assert_eq "[crash-recovery] archived=true での再実行は KPI を二重 archive しない" \
  "$HIST_LINES_BEFORE" "$(wc -l < "$TMP_TEST_DIR/flow-kpi-history.jsonl" | tr -d ' ')"
assert_file_absent "[crash-recovery] archived=true での再実行でも state は削除される" "$TMP_TEST_DIR/flow-progress-${CRASH_SCOPE}.json"

echo ""
echo "--- cleanup_post_deploy: cleanup_flow_state_files への委譲 ---"
PD_SCOPE="issue-555"
echo '{"phase":"done","branch":"feature/issue-555/pd-test"}' > "$TMP_TEST_DIR/flow-progress-${PD_SCOPE}.json"
echo '{"scope":"pd-test","deploy_status":"success"}' > "$TMP_TEST_DIR/flow-kpi-${PD_SCOPE}.json"
touch "$TMP_TEST_DIR/flow-context-${PD_SCOPE}.json"
cleanup_post_deploy "$PD_SCOPE" final
assert_file_absent "[post_deploy final] progress.json が削除される" "$TMP_TEST_DIR/flow-progress-${PD_SCOPE}.json"
assert_file_present "[post_deploy final] done sentinel が作成される" "$TMP_TEST_DIR/flow-done-${PD_SCOPE}.json"
TESTS=$((TESTS + 1))
if cleanup_post_deploy "" >/dev/null 2>&1; then
  FAILURES=$((FAILURES + 1))
  echo -e "${RED}FAIL${NC}: cleanup_post_deploy が空 scope_key を許容してしまった"
else
  PASSES=$((PASSES + 1))
  echo -e "${GREEN}PASS${NC}: cleanup_post_deploy は空 scope_key で fail-fast"
fi

echo ""
echo "--- cleanup override priority: specific > common > secure default ---"
COMMON_STATE_DIR="$TMP_TEST_DIR/common"
SPECIFIC_STATE_DIR="$TMP_TEST_DIR/specific"
mkdir -m 700 "$COMMON_STATE_DIR" "$SPECIFIC_STATE_DIR"

unset CLEANUP_FLOW_STATE_DIR
export FLOW_STATE_DIR="$COMMON_STATE_DIR"
echo '{"phase":"done","branch":"feature/common"}' > "$COMMON_STATE_DIR/flow-progress-${LEGACY_SCOPE}.json"
echo '{"scope":"common"}' > "$COMMON_STATE_DIR/flow-kpi-${LEGACY_SCOPE}.json"
touch "$COMMON_STATE_DIR/flow-context-${LEGACY_SCOPE}.json" \
  "$COMMON_STATE_DIR/codex-gate-P5-${LEGACY_SCOPE}-AAAAAA.txt" \
  "$COMMON_STATE_DIR/flow-progress-${LEGACY_SCOPE}.json.new.123"
cleanup_flow_state_files "$LEGACY_SCOPE" final
assert_file_absent "CLEANUP 未指定時は FLOW_STATE_DIR の state を削除する" \
  "$COMMON_STATE_DIR/flow-progress-${LEGACY_SCOPE}.json"
assert_file_present "CLEANUP 未指定時は FLOW_STATE_DIR に done sentinel を作る" \
  "$COMMON_STATE_DIR/flow-done-${LEGACY_SCOPE}.json"
assert_file_present "CLEANUP 未指定時は FLOW_STATE_DIR に KPI history を作る" \
  "$COMMON_STATE_DIR/flow-kpi-history.jsonl"
assert_file_absent "CLEANUP 未指定時は FLOW_STATE_DIR の codex log を削除する" \
  "$COMMON_STATE_DIR/codex-gate-P5-${LEGACY_SCOPE}-AAAAAA.txt"
assert_file_absent "CLEANUP 未指定時は FLOW_STATE_DIR の atomic tmp を削除する" \
  "$COMMON_STATE_DIR/flow-progress-${LEGACY_SCOPE}.json.new.123"

PRIORITY_SCOPE="cleanup-priority-$$"
export CLEANUP_FLOW_STATE_DIR="$SPECIFIC_STATE_DIR"
echo '{"phase":"done","branch":"feature/specific"}' > "$SPECIFIC_STATE_DIR/flow-progress-${PRIORITY_SCOPE}.json"
echo '{"scope":"specific"}' > "$SPECIFIC_STATE_DIR/flow-kpi-${PRIORITY_SCOPE}.json"
touch "$SPECIFIC_STATE_DIR/flow-context-${PRIORITY_SCOPE}.json"
echo '{"phase":"done","branch":"feature/common"}' > "$COMMON_STATE_DIR/flow-progress-${PRIORITY_SCOPE}.json"
cleanup_flow_state_files "$PRIORITY_SCOPE" final
assert_file_absent "両方指定時は CLEANUP_FLOW_STATE_DIR が優先される" \
  "$SPECIFIC_STATE_DIR/flow-progress-${PRIORITY_SCOPE}.json"
assert_file_present "限定 override 使用時は FLOW_STATE_DIR 側を処理しない" \
  "$COMMON_STATE_DIR/flow-progress-${PRIORITY_SCOPE}.json"

echo ""
echo "========================================"
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
echo "========================================"
[ "$FAILURES" -eq 0 ]
