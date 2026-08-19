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

REPO_MAIN="$TMP_TEST_DIR/main-repo"
REPO_WORKTREE="$TMP_TEST_DIR/work tree"
REPO_WITHOUT_HEAD="$TMP_TEST_DIR/repo-without-head"
NON_GIT_DIR="$TMP_TEST_DIR/non-git-dir"
TEST_HOME="$TMP_TEST_DIR/home"
REPO_TILDE="$TEST_HOME/tilde-repo"
OTHER_REPO="$TMP_TEST_DIR/other-repo"
HOOK_PROJECT="$REPO_MAIN"
MARKER="$HOOK_PROJECT/.claude/push-completed.marker"
POST_STDERR="$TMP_TEST_DIR/post.stderr"
PRE_STDERR="$TMP_TEST_DIR/pre.stderr"

mkdir -p "$REPO_MAIN" "$REPO_WITHOUT_HEAD" "$NON_GIT_DIR" "$REPO_TILDE" \
  "$OTHER_REPO" "$HOOK_PROJECT/.claude/hooks"

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
git -C "$REPO_MAIN" worktree add -q -b worktree-test "$REPO_WORKTREE"
printf '%s\n' "worktree" > "$REPO_WORKTREE/fixture.txt"
git -C "$REPO_WORKTREE" add fixture.txt
git -C "$REPO_WORKTREE" commit -qm "worktree fixture"
init_repo "$REPO_TILDE" "tilde"
init_repo "$OTHER_REPO" "other"
git -C "$REPO_WITHOUT_HEAD" init -q

MAIN_HEAD=$(git -C "$REPO_MAIN" rev-parse HEAD)
WORKTREE_HEAD=$(git -C "$REPO_WORKTREE" rev-parse HEAD)
TILDE_HEAD=$(git -C "$REPO_TILDE" rev-parse HEAD)
OTHER_HEAD=$(git -C "$OTHER_REPO" rev-parse HEAD)

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

run_pre() {
  local command="$1"
  local input_cwd="${2:-$REPO_MAIN}"
  local input

  input=$(jq -n --arg command "$command" --arg cwd "$input_cwd" \
    '{cwd: $cwd, tool_input: {command: $command}}')
  if PRE_OUTPUT=$(cd "$input_cwd" && printf '%s\n' "$input" | \
    CLAUDE_PROJECT_DIR="$HOOK_PROJECT" bash "$PRE_HOOK" 2>"$PRE_STDERR"); then
    PRE_STATUS=0
  else
    PRE_STATUS=$?
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
  "$WORKTREE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"
assert_eq "git -C の指定先をマーカー2行目に記録する" \
  "$REPO_WORKTREE" "$(sed -n '2p' "$MARKER" 2>/dev/null)"

run_post "git -c key=value -C '$REPO_WORKTREE' --no-pager push"
assert_eq "mixed global options の git -C は指定先 HEAD を記録する" \
  "$WORKTREE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"
assert_eq "mixed global options の git -C は指定先 path を記録する" \
  "$REPO_WORKTREE" "$(sed -n '2p' "$MARKER" 2>/dev/null)"

run_post "git -C'$REPO_WORKTREE' push"
assert_eq "value-joined git -C は指定先 HEAD を記録する" \
  "$WORKTREE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"
assert_eq "value-joined git -C は指定先 path を記録する" \
  "$REPO_WORKTREE" "$(sed -n '2p' "$MARKER" 2>/dev/null)"

run_post "git -C '../work tree' push" "$REPO_MAIN"
assert_eq "relative git -C は input cwd 基準の HEAD を記録する" \
  "$WORKTREE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"
assert_eq "relative git -C は canonical path を記録する" \
  "$REPO_WORKTREE" "$(sed -n '2p' "$MARKER" 2>/dev/null)"

run_post "git -C '$TMP_TEST_DIR' -C 'work tree' push" "$REPO_MAIN"
assert_eq "repeated git -C は直前の指定先基準の HEAD を記録する" \
  "$WORKTREE_HEAD" "$(head -1 "$MARKER" 2>/dev/null)"
assert_eq "repeated git -C は最終 canonical path を記録する" \
  "$REPO_WORKTREE" "$(sed -n '2p' "$MARKER" 2>/dev/null)"

run_post "git -C '$TMP_TEST_DIR/missing-repo' push" "$REPO_MAIN"
assert_marker_absent "存在しない git -C は hook cwd へ fallback しない"

run_post "git -C '$REPO_WORKTREE' push -n" "$REPO_MAIN"
assert_marker_absent "git -C <dir> push -n はマーカーを書かない"

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

run_post "git push" "$NON_GIT_DIR"
assert_marker_absent "非 Git ディレクトリが cwd の場合はマーカーを書かない"
assert_eq "非 Git ディレクトリが cwd でも監視の起動 JSON を出力する" \
  "PostToolUse" "$(printf '%s\n' "$POST_OUTPUT" | jq -r '.hookSpecificOutput.hookEventName // ""' 2>/dev/null)"

echo ""
echo "=== pre-bash-guard: git hook bypass ==="

run_pre "printf 'git docs' | grep -n docs.md"
assert_eq "unrelated grep -n is allowed" "0" "$PRE_STATUS"

run_pre "git status && sed -n '1,3p' file"
assert_eq "unrelated sed -n after git status is allowed" "0" "$PRE_STATUS"

run_pre "git commit -m 'document --no-verify and -n'"
assert_eq "bypass strings in commit message are allowed" "0" "$PRE_STATUS"

run_pre "git commit -m '-n'"
assert_eq "short bypass string as commit message is allowed" "0" "$PRE_STATUS"

run_pre "git tag -n"
assert_eq "git tag -n is allowed" "0" "$PRE_STATUS"

run_pre "git push -n"
assert_eq "git push -n dry-run is allowed" "0" "$PRE_STATUS"

run_pre "git commit -m '破壊的削除コマンドの扱いを修正'"
assert_eq "destructive-command wording in commit message is allowed" "0" "$PRE_STATUS"

run_pre "git commit -m '過剰な権限付与のガードを追加'"
assert_eq "permission wording in commit message is allowed" "0" "$PRE_STATUS"

run_pre "git commit -m '自動 resolve ガードの誤検知を直す'"
assert_eq "resolve wording in commit message is allowed" "0" "$PRE_STATUS"

run_pre "git commit -m 'claude-pre-push-review-done の誤検知を修正'"
assert_eq "review flag basename in commit message is allowed" "0" "$PRE_STATUS"

run_pre "git commit -n -m x"
assert_eq "actual git commit -n is blocked" "2" "$PRE_STATUS"

run_pre "git commit -an -m x"
assert_eq "actual git commit short option cluster containing n is blocked" "2" "$PRE_STATUS"

run_pre "git commit --no-verify -m x"
assert_eq "actual git commit --no-verify is blocked" "2" "$PRE_STATUS"

run_pre "git -C '$REPO_WORKTREE' commit --no-verify -m x"
assert_eq "git global options do not hide commit --no-verify" "2" "$PRE_STATUS"

run_pre "git push --no-verify"
assert_eq "actual git push --no-verify is blocked" "2" "$PRE_STATUS"

run_pre "echo ok && git commit -n -m x"
assert_eq "linked actual git commit -n is blocked" "2" "$PRE_STATUS"

echo ""
echo "=== pre-bash-guard: review flag creation ==="

run_pre "grep -r claude-pre-push-review-done '$TMP_TEST_DIR'"
assert_eq "grep mention of review flag is allowed" "0" "$PRE_STATUS"

run_pre "cat '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "cat mention of review flag is allowed" "0" "$PRE_STATUS"

run_pre "ls '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "ls mention of review flag is allowed" "0" "$PRE_STATUS"

run_pre "find '$TMP_TEST_DIR' -name claude-pre-push-review-done"
assert_eq "find mention of review flag is allowed" "0" "$PRE_STATUS"

run_pre "gh issue create --body 'claude-pre-push-review-done is documented'"
assert_eq "issue body mention of review flag is allowed" "0" "$PRE_STATUS"

run_pre "echo 'claude-pre-push-review-done' > '$TMP_TEST_DIR/note.txt'"
assert_eq "review flag text redirected to another basename is allowed" "0" "$PRE_STATUS"

run_pre 'touch "$(git rev-parse --git-dir)/claude-pre-push-review-done"'
assert_eq "canonical git-dir touch is allowed" "0" "$PRE_STATUS"

run_pre 'touch "$(git rev-parse --absolute-git-dir)/claude-pre-push-review-done"'
assert_eq "canonical absolute-git-dir touch is allowed" "0" "$PRE_STATUS"

run_pre "cd '$REPO_WORKTREE' && touch \"\$(git rev-parse --absolute-git-dir)/claude-pre-push-review-done\""
assert_eq "canonical touch after cd is allowed" "0" "$PRE_STATUS"

run_pre "touch \"\$(git -C '$REPO_WORKTREE' rev-parse --absolute-git-dir)/claude-pre-push-review-done\""
assert_eq "canonical git -C touch is allowed" "0" "$PRE_STATUS"

run_pre "touch '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "manual touch of review flag is blocked" "2" "$PRE_STATUS"

run_pre "printf x > '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "redirection creation of review flag is blocked" "2" "$PRE_STATUS"

run_pre "install /dev/null '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "install creation of review flag is blocked" "2" "$PRE_STATUS"

run_pre "cp /dev/null '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "cp creation of review flag is blocked" "2" "$PRE_STATUS"

run_pre "mv '$TMP_TEST_DIR/note.txt' '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "mv creation of review flag is blocked" "2" "$PRE_STATUS"

run_pre "ln '$TMP_TEST_DIR/note.txt' '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "ln creation of review flag is blocked" "2" "$PRE_STATUS"

run_pre "printf x | tee '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "tee creation of review flag is blocked" "2" "$PRE_STATUS"

run_pre "truncate -s 0 '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "truncate creation of review flag is blocked" "2" "$PRE_STATUS"

run_pre "dd if=/dev/null of='$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "dd creation of review flag is blocked" "2" "$PRE_STATUS"

run_pre "touch \"\$(git rev-parse --absolute-git-dir)/claude-pre-push-review-done\" && touch '$TMP_TEST_DIR/claude-pre-push-review-done'"
assert_eq "canonical touch cannot hide another creation" "2" "$PRE_STATUS"

REVIEW_FLAG="$(git -C "$REPO_MAIN" rev-parse --absolute-git-dir)/claude-pre-push-review-done"
rm -f "$REVIEW_FLAG"
run_pre "gh pr create --title test --body test"
assert_eq "PR create without review flag is blocked" "2" "$PRE_STATUS"

touch "$REVIEW_FLAG"
run_pre "gh pr create --title test --body test"
assert_eq "PR create with recent review flag is allowed" "0" "$PRE_STATUS"
assert_eq "recent review flag is consumed" "0" "$([ -e "$REVIEW_FLAG" ] && echo 1 || echo 0)"

touch "$REVIEW_FLAG"
touch -t 202001010000 "$REVIEW_FLAG"
run_pre "gh pr create --title test --body test"
assert_eq "PR create with stale review flag is blocked" "2" "$PRE_STATUS"
rm -f "$REVIEW_FLAG"

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
echo "=== pre-bash-guard: marker identity and age ==="

printf '%s\n%s\n' "$WORKTREE_HEAD" "$REPO_WORKTREE" > "$MARKER"
touch -t 202001010000 "$MARKER"
run_pre "cd '$REPO_WORKTREE' && gh pr comment 1 --body ok"
assert_eq "old matching marker allows PR comment" "0" "$PRE_STATUS"

run_pre "gh issue comment 340 --body ok" "$REPO_MAIN"
assert_eq "old matching marker allows Issue comment" "0" "$PRE_STATUS"

rm -f "$MARKER"
run_pre "gh issue comment 340 --body ok" "$REPO_MAIN"
assert_eq "missing marker blocks comment" "2" "$PRE_STATUS"

printf '\n%s\n' "$REPO_WORKTREE" > "$MARKER"
run_pre "gh issue comment 340 --body ok" "$REPO_MAIN"
assert_eq "empty marker SHA blocks comment" "2" "$PRE_STATUS"

printf '%s\n%s\n' "$WORKTREE_HEAD" "$TMP_TEST_DIR/missing-repo" > "$MARKER"
run_pre "gh issue comment 340 --body ok" "$REPO_MAIN"
assert_eq "missing marker repository blocks comment" "2" "$PRE_STATUS"

printf '%s\n%s\n' "$MAIN_HEAD" "$REPO_WORKTREE" > "$MARKER"
touch -t 202001010000 "$MARKER"
run_pre "gh issue comment 340 --body ok" "$REPO_MAIN"
assert_eq "mismatched marker HEAD blocks comment regardless of age" "2" "$PRE_STATUS"

printf '%s\n%s\n' "$WORKTREE_HEAD" "$REPO_WORKTREE" > "$MARKER"
printf '%s\n' "after push" >> "$REPO_WORKTREE/fixture.txt"
git -C "$REPO_WORKTREE" add fixture.txt
git -C "$REPO_WORKTREE" commit -qm "after push"
run_pre "gh issue comment 340 --body ok" "$REPO_MAIN"
assert_eq "new commit after marker blocks comment" "2" "$PRE_STATUS"

printf '%s\n%s\n' "$OTHER_HEAD" "$OTHER_REPO" > "$MARKER"
run_pre "gh issue comment 340 --body ok" "$REPO_MAIN"
assert_eq "self-consistent marker from another repository is blocked" "2" "$PRE_STATUS"

echo ""
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
[ "$FAILURES" -eq 0 ]
