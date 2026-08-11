#!/bin/bash
# post-push-monitor / pre-bash-guard の push マーカー worktree 回帰テスト
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

assert_marker_absent() {
  local description="$1"
  TESTS=$((TESTS + 1))
  if [ ! -e "$MARKER" ]; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
POST_HOOK="$HOOK_DIR/post-push-monitor.sh"
PRE_HOOK="$HOOK_DIR/pre-bash-guard.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq 未インストールのため test-push-marker.sh をスキップ" >&2
  exit 0
fi

TMP_TEST_DIR=$(mktemp -d "/tmp/test-push-marker.XXXXXX")
trap 'rm -rf "$TMP_TEST_DIR"' EXIT

HOOK_PROJECT="$TMP_TEST_DIR/hook-project"
REPO_MAIN="$TMP_TEST_DIR/main-repo"
REPO_WORKTREE="$TMP_TEST_DIR/work tree"
REPO_WITHOUT_HEAD="$TMP_TEST_DIR/repo-without-head"
TEST_HOME="$TMP_TEST_DIR/home"
REPO_TILDE="$TEST_HOME/tilde-repo"
MARKER="$HOOK_PROJECT/.claude/push-completed.marker"
POST_STDERR="$TMP_TEST_DIR/post.stderr"

mkdir -p "$HOOK_PROJECT/.claude/hooks" "$REPO_MAIN" "$REPO_WORKTREE" \
  "$REPO_WITHOUT_HEAD" "$REPO_TILDE"

# post hook のマーカー書き込み後の処理だけを無害な fixture に差し替える。
printf '%s\n' \
  'UNRESOLVED_THREADS_ERROR=false' \
  'UNRESOLVED_THREADS_COUNT=0' \
  'UNRESOLVED_THREADS_JSON="[]"' \
  'fetch_unresolved_threads() { :; }' \
  > "$HOOK_PROJECT/.claude/hooks/fetch-unresolved-threads.sh"
printf '%s\n' '#!/bin/bash' 'printf '\''{"status":"success"}\n'\''' \
  > "$HOOK_PROJECT/.claude/hooks/check-ci-coderabbit.sh"
chmod +x "$HOOK_PROJECT/.claude/hooks/check-ci-coderabbit.sh"

init_repo() {
  local repo="$1"
  local content="$2"
  git -C "$repo" init -q
  git -C "$repo" config user.name "Push Marker Test"
  git -C "$repo" config user.email "push-marker@example.invalid"
  printf '%s\n' "$content" > "$repo/fixture.txt"
  git -C "$repo" add fixture.txt
  git -C "$repo" commit -qm "fixture"
}

init_repo "$REPO_MAIN" "main"
init_repo "$REPO_WORKTREE" "worktree"
init_repo "$REPO_TILDE" "tilde"
git -C "$REPO_WITHOUT_HEAD" init -q

MAIN_HEAD=$(git -C "$REPO_MAIN" rev-parse HEAD)
WORKTREE_HEAD=$(git -C "$REPO_WORKTREE" rev-parse HEAD)
TILDE_HEAD=$(git -C "$REPO_TILDE" rev-parse HEAD)

run_post() {
  local command="$1"
  local input_cwd="${2-}"
  local input

  rm -f "$MARKER"
  if [ -n "$input_cwd" ]; then
    input=$(jq -n --arg command "$command" --arg cwd "$input_cwd" \
      '{cwd: $cwd, tool_input: {command: $command}}')
  else
    input=$(jq -n --arg command "$command" '{tool_input: {command: $command}}')
  fi

  if POST_OUTPUT=$(cd "$REPO_MAIN" && printf '%s\n' "$input" | \
    HOME="$TEST_HOME" CLAUDE_PROJECT_DIR="$HOOK_PROJECT" bash "$POST_HOOK" \
    2>"$POST_STDERR"); then
    POST_STATUS=0
  else
    POST_STATUS=$?
  fi
}

echo "=== post-push-monitor: push 検出と SHA ==="

run_post "cd '$REPO_WORKTREE' && git push"
assert_eq "cd <worktree> && git push は cd 先の HEAD を記録する" \
  "$WORKTREE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"

run_post "git push" "$REPO_MAIN"
assert_eq "先頭の git push は従来どおり検出する" \
  "$MAIN_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"

run_post "cd '$REPO_WORKTREE'; git push"
assert_eq "セミコロン後の git push も検出する" \
  "$WORKTREE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"

run_post "false || git push"
assert_eq "OR 連結後の git push も検出する" \
  "$MAIN_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"

run_post "cd '$REPO_WORKTREE' && git stash push -m x"
assert_marker_absent "cd 先の git stash push は除外する"

run_post "git submodule foreach git push"
assert_marker_absent "git submodule 内の push は除外する"

run_post "git -C '$REPO_WORKTREE' stash push -m x"
assert_marker_absent "git -C <dir> stash push は除外する"

run_post "git -c core.pager=cat --no-pager stash push -m x"
assert_marker_absent "複数のグローバルオプション後の stash push は除外する"

run_post "git --git-dir '$REPO_MAIN/.git' submodule foreach git push"
assert_marker_absent "値が分離した --git-dir 後の submodule は除外する"

run_post "git --work-tree='$REPO_MAIN' --exec-path=/tmp submodule foreach git push"
assert_marker_absent "値が結合したグローバルオプション後の submodule は除外する"

run_post "git -C '$REPO_WORKTREE' push"
assert_eq "グローバルオプション後の git push は検出する" \
  "$MAIN_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"

run_post "git push --dry-run" "$REPO_MAIN"
assert_marker_absent "git push --dry-run はマーカーを書かない"

run_post "git push -n" "$REPO_MAIN"
assert_marker_absent "git push -n はマーカーを書かない"

run_post "cd ~/tilde-repo && git push"
assert_eq "クォートなしの ~ を展開して cd 先の HEAD を記録する" \
  "$TILDE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"

run_post "cd '$REPO_WORKTREE' && git push" "$REPO_MAIN"
assert_eq "stdin の cwd が main でもコマンド中の cd を優先する" \
  "$WORKTREE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"
assert_eq "マーカーの2行目に push したリポジトリを記録する" \
  "$REPO_WORKTREE" "$(sed -n '2p' "$MARKER" 2>/dev/null)"

run_post "git push" "$REPO_WORKTREE"
assert_eq "コマンド中に cd がなければ stdin の cwd を使う" \
  "$WORKTREE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"

run_post "cd '$TMP_TEST_DIR/missing-repo' && git push" "$REPO_MAIN"
assert_eq "存在しない cd 先は採用せず stdin の cwd に戻る" \
  "$MAIN_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"

run_post "git push" "$TMP_TEST_DIR/missing-cwd"
assert_eq "存在しない stdin の cwd は採用せず hook の cwd に戻る" \
  "$MAIN_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"

run_post "git push" "$REPO_WITHOUT_HEAD"
assert_marker_absent "HEAD を解決できない場合はマーカーを書かない"
assert_eq "HEAD を解決できなくても post hook は正常終了する" \
  "0" "$POST_STATUS"
assert_eq "HEAD を解決できなくても監視の起動 JSON を出力する" \
  "PostToolUse" "$(printf '%s\n' "$POST_OUTPUT" | jq -r '.hookSpecificOutput.hookEventName // ""' 2>/dev/null)"

echo ""
echo "=== pre-bash-guard: マーカー SHA 照合 ==="

printf '%s\n' "$WORKTREE_HEAD" > "$MARKER"
COMMENT_INPUT=$(jq -n --arg command "cd '$REPO_WORKTREE' && gh pr comment 1 --body ok" \
  '{tool_input: {command: $command}}')
(cd "$REPO_MAIN" && printf '%s\n' "$COMMENT_INPUT" | \
  CLAUDE_PROJECT_DIR="$HOOK_PROJECT" bash "$PRE_HOOK" >/dev/null 2>&1)
assert_eq "2行目がない旧形式でも cd 先の HEAD と照合する" "0" "$?"

printf '%s\n' "$MAIN_HEAD" > "$MARKER"
set +e
(cd "$REPO_MAIN" && printf '%s\n' "$COMMENT_INPUT" | \
  CLAUDE_PROJECT_DIR="$HOOK_PROJECT" bash "$PRE_HOOK" >/dev/null 2>&1)
MISMATCH_STATUS=$?
set -e
assert_eq "cd 先と異なる SHA のマーカーはブロックする" "2" "$MISMATCH_STATUS"

printf '%s\n%s\n' "$WORKTREE_HEAD" "$REPO_WORKTREE" > "$MARKER"
COMMENT_WITHOUT_CD_INPUT=$(jq -n --arg command "gh pr comment 1 --body ok" \
  --arg cwd "$REPO_MAIN" '{cwd: $cwd, tool_input: {command: $command}}')
(cd "$REPO_MAIN" && printf '%s\n' "$COMMENT_WITHOUT_CD_INPUT" | \
  CLAUDE_PROJECT_DIR="$HOOK_PROJECT" bash "$PRE_HOOK" >/dev/null 2>&1)
assert_eq "返信コマンドに cd がなくてもマーカーのリポジトリで照合する" "0" "$?"

printf '%s\n%s\n' "$WORKTREE_HEAD" "$TMP_TEST_DIR/deleted-repo" > "$MARKER"
set +e
(cd "$REPO_MAIN" && printf '%s\n' "$COMMENT_WITHOUT_CD_INPUT" | \
  CLAUDE_PROJECT_DIR="$HOOK_PROJECT" bash "$PRE_HOOK" >/dev/null 2>&1)
HEAD_FAILURE_STATUS=$?
set -e
assert_eq "照合先で git rev-parse が失敗したらブロックする" "2" "$HEAD_FAILURE_STATUS"

echo ""
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
[ "$FAILURES" -eq 0 ]
