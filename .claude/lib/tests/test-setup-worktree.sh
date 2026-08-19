#!/usr/bin/env bash
# =============================================================================
# setup-worktree mise trust contract regression test
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
  local output status
  output=$("$@" 2>&1)
  status=$?
  TESTS=$((TESTS + 1))
  if [ "$status" -ne 0 ] && printf '%s\n' "$output" | grep -q "$expected_reason"; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description"
    echo "  expected non-zero and diagnostic containing: $expected_reason"
    echo "  status: $status"
    echo "  output: $output"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SETUP_WORKTREE="$PROJECT_DIR/.claude/lib/worktree/setup-worktree.sh"

if [ ! -f "$SETUP_WORKTREE" ]; then
  echo -e "${RED}FAIL${NC}: setup-worktree.sh が存在しない"
  exit 1
fi

TMP_TEST_DIR=$(mktemp -d "/tmp/test-setup-worktree.XXXXXX")
trap 'rm -rf "$TMP_TEST_DIR"' EXIT

ORIGIN_REPO="$TMP_TEST_DIR/origin.git"
REAL_ROOT="$TMP_TEST_DIR/real"
LINK_ROOT="$TMP_TEST_DIR/link"
MAIN_REPO="$REAL_ROOT/main"
LINK_MAIN_REPO="$LINK_ROOT/main"
FAKE_BIN="$TMP_TEST_DIR/bin"
MISE_LOG="$TMP_TEST_DIR/mise.log"
GIT_WORKTREE_ADD_LOG="$TMP_TEST_DIR/git-worktree-add.log"

git init -q --bare "$ORIGIN_REPO"
mkdir -p "$REAL_ROOT"
ln -s "$REAL_ROOT" "$LINK_ROOT"
git init -q "$MAIN_REPO"
git -C "$MAIN_REPO" config user.email harness-test@example.invalid
git -C "$MAIN_REPO" config user.name 'harness test'
printf '%s\n' '[tools]' 'node = "22"' > "$MAIN_REPO/.mise.toml"
git -C "$MAIN_REPO" add .mise.toml
git -C "$MAIN_REPO" commit -q -m baseline
git -C "$MAIN_REPO" branch -M main
git -C "$MAIN_REPO" remote add origin "$ORIGIN_REPO"
git -C "$MAIN_REPO" push -q -u origin main
git -C "$ORIGIN_REPO" symbolic-ref HEAD refs/heads/main

mkdir -p "$FAKE_BIN"
REAL_GIT_BIN=$(command -v git)
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\n" "$*" >> "$MISE_TEST_LOG"' \
  'exit "${MISE_TEST_STATUS:-0}"' \
  > "$FAKE_BIN/mise"
chmod 700 "$FAKE_BIN/mise"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [ "${1:-}" = "-C" ] && [ "${3:-}" = "worktree" ] && [ "${4:-}" = "add" ]; then' \
  '  printf "%s\n" "$*" >> "$GIT_WORKTREE_ADD_TEST_LOG"' \
  'fi' \
  'exec "$REAL_GIT_TEST_BIN" "$@"' \
  > "$FAKE_BIN/git"
chmod 700 "$FAKE_BIN/git"
: > "$MISE_LOG"
: > "$GIT_WORKTREE_ADD_LOG"

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
export MISE_TEST_LOG="$MISE_LOG"
export MISE_TEST_STATUS=0
export REAL_GIT_TEST_BIN="$REAL_GIT_BIN"
export GIT_WORKTREE_ADD_TEST_LOG="$GIT_WORKTREE_ADD_LOG"
export PATH="$FAKE_BIN:$PATH"
# shellcheck disable=SC1090
source "$SETUP_WORKTREE"

mise_call_count() {
  if [ ! -s "$MISE_LOG" ]; then
    printf '0\n'
    return
  fi
  wc -l < "$MISE_LOG" | tr -d ' '
}

git_worktree_add_count() {
  if [ ! -s "$GIT_WORKTREE_ADD_LOG" ]; then
    printf '0\n'
    return
  fi
  wc -l < "$GIT_WORKTREE_ADD_LOG" | tr -d ' '
}

worktree_path() {
  compute_worktree_path "$MAIN_REPO" "$1"
}

echo "=== matching config ==="
MATCH_BRANCH='fix/issue-340/mise-match'
MATCH_WORKTREE=$(worktree_path "$MATCH_BRANCH")
assert_success "matching config worktree を作成できる" \
  create_worktree "$MAIN_REPO" "$MATCH_BRANCH"
assert_eq "matching config は mise trust を 1 回呼ぶ" "1" "$(mise_call_count)"
assert_eq "matching config の trust 引数" \
  "trust --yes $MATCH_WORKTREE/.mise.toml" "$(tail -n 1 "$MISE_LOG")"

assert_success "existing worktree を再利用できる" \
  create_worktree "$MAIN_REPO" "$MATCH_BRANCH"
assert_eq "reuse でも trust check を 1 回行う" "2" "$(mise_call_count)"

echo ""
echo "=== untrusted config is skipped ==="
printf '%s\n' '[tools]' 'node = "99"' > "$MATCH_WORKTREE/.mise.toml"
assert_success "mismatched config の worktree を再利用できる" \
  create_worktree "$MAIN_REPO" "$MATCH_BRANCH"
assert_eq "mismatched config は trust しない" "2" "$(mise_call_count)"
git -C "$MATCH_WORKTREE" checkout -q -- .mise.toml

NO_MAIN_BRANCH='fix/issue-340/no-main-config'
NO_MAIN_WORKTREE=$(worktree_path "$NO_MAIN_BRANCH")
mv "$MAIN_REPO/.mise.toml" "$MAIN_REPO/.mise.toml.saved"
assert_success "main config 不在でも作成できる" \
  create_worktree "$MAIN_REPO" "$NO_MAIN_BRANCH"
assert_eq "main config 不在は trust しない" "2" "$(mise_call_count)"
mv "$MAIN_REPO/.mise.toml.saved" "$MAIN_REPO/.mise.toml"

NO_WORKTREE_BRANCH='fix/issue-340/no-worktree-config'
NO_WORKTREE_WORKTREE=$(worktree_path "$NO_WORKTREE_BRANCH")
assert_success "worktree config fixture を作成できる" \
  create_worktree "$MAIN_REPO" "$NO_WORKTREE_BRANCH"
assert_eq "fixture 作成時は trust する" "3" "$(mise_call_count)"
rm "$NO_WORKTREE_WORKTREE/.mise.toml"
assert_success "worktree config 不在でも再利用できる" \
  create_worktree "$MAIN_REPO" "$NO_WORKTREE_BRANCH"
assert_eq "worktree config 不在は trust しない" "3" "$(mise_call_count)"

NO_MISE_BRANCH='fix/issue-340/no-mise-command'
assert_success "mise command 不在でも作成できる" \
  env PATH="/usr/bin:/bin" bash -c \
    'source "$CLAUDE_PROJECT_DIR/.claude/lib/worktree/setup-worktree.sh"; create_worktree "$1" "$2"' \
    bash "$MAIN_REPO" "$NO_MISE_BRANCH"
assert_eq "mise command 不在は trust しない" "3" "$(mise_call_count)"

echo ""
echo "=== symlink path reuse ==="
SYMLINK_BRANCH='fix/issue-340/symlink-path-reuse'
: > "$GIT_WORKTREE_ADD_LOG"
assert_success "symlink 経由で worktree を作成できる" \
  create_worktree "$LINK_MAIN_REPO" "$SYMLINK_BRANCH"
assert_success "symlink 経由でも existing worktree を再利用できる" \
  create_worktree "$LINK_MAIN_REPO" "$SYMLINK_BRANCH"
assert_eq "symlink 経由の reuse では worktree add を再実行しない" \
  "1" "$(git_worktree_add_count)"
assert_eq "symlink 経由の reuse でも trust check を 1 回行う" \
  "5" "$(mise_call_count)"

echo ""
echo "=== trust failure is fail-fast ==="
export MISE_TEST_STATUS=23
FAIL_BRANCH='fix/issue-340/mise-failure'
assert_failure_reason "mise trust failure で create_worktree が失敗する" \
  "mise trust に失敗" create_worktree "$MAIN_REPO" "$FAIL_BRANCH"
assert_eq "failure case でも trust は 1 回だけ" "6" "$(mise_call_count)"

echo ""
echo "========================================"
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
if [ "$FAILURES" -gt 0 ]; then
  echo -e "${RED}FAILED${NC}"
  exit 1
fi
echo -e "${GREEN}ALL PASSED${NC}"
