#!/bin/bash
# pre-bash-guard.sh の汎用ガードの回帰テスト。
# 危険文字列はこのスクリプト自身が guard に引っかからないよう変数連結で組み立てる。
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/../../.." && pwd)
GUARD="$PROJECT_DIR/.claude/hooks/pre-bash-guard.sh"

TESTS=0
FAILURES=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

if [ ! -f "$GUARD" ]; then
  printf '%bpre-bash-guard.sh が見つからない: %s%b\n' "$RED" "$GUARD" "$NC"
  exit 1
fi

export PROJECT_DIR

# guard に渡す hook 入力を組み立てる。command は JSON 文字列として正しく escape する。
guard_verdict() {
  local cmd="$1" payload rc
  payload=$(COMMAND_TO_ENCODE="$cmd" python3 -c '
import json, os
print(json.dumps({
    "session_id": "test",
    "cwd": os.environ["PROJECT_DIR"],
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": {"command": os.environ["COMMAND_TO_ENCODE"]},
}))') || { printf 'error\n'; return 0; }
  printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$PROJECT_DIR" /bin/bash "$GUARD" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then printf 'allow\n'; else printf 'block\n'; fi
}

assert_verdict() {
  local want="$1" desc="$2" cmd="$3" got
  TESTS=$((TESTS + 1))
  got=$(guard_verdict "$cmd")
  if [ "$got" = "$want" ]; then
    printf '%b  PASS%b %s\n' "$GREEN" "$NC" "$desc"
  else
    FAILURES=$((FAILURES + 1))
    printf '%b  FAIL%b %s — 期待 %s / 実際 %s\n' "$RED" "$NC" "$desc" "$want" "$got"
  fi
}

# 危険操作の文字列は連結して作る（このテスト自身がブロックされないため）
RM_RECURSIVE="rm ""-rf"
RESET_HARD="git reset -""-hard HEAD~3"
CLEAN_UNTRACKED="git cl""ean -fd"
FORCE_PUSH="git push --for""ce origin main"
CHMOD_OPEN="chmo""d 777"
NO_VERIFY="--no-""verify"

echo "=== 危険操作はブロックされる ==="
assert_verdict block "再帰削除" "$RM_RECURSIVE /home/user/data"
assert_verdict block "作業ツリーの巻き戻し" "$RESET_HARD"
assert_verdict block "未追跡ファイルの削除" "$CLEAN_UNTRACKED"
assert_verdict block "強制 push" "$FORCE_PUSH"
assert_verdict block "過剰な権限付与" "$CHMOD_OPEN /etc/passwd"

echo
echo "=== git hook のバイパスはブロックされる ==="
assert_verdict block "commit の長い形" "git commit $NO_VERIFY -m x"
assert_verdict block "commit の短縮形" "git commit -n -m x"
assert_verdict block "短縮形のクラスタ" "git commit -nm x"

echo
echo "=== 未知の long option を短縮形と誤認しない ==="
# `--no-edit` は先頭の - を 1 つ剥がすと -no-edit となり n を含むため、
# 素朴な実装では -n（バイパス）と誤認される。`--dry-run` も末尾が n。
assert_verdict allow "commit --amend --no-edit" "git commit --amend --no-edit"
assert_verdict allow "commit --dry-run" "git commit --dry-run"
assert_verdict allow "commit --allow-empty" "git commit --allow-empty -m x"
assert_verdict allow "commit --amend 単体" "git commit --amend"

echo
echo "=== 通常の操作は通る ==="
assert_verdict allow "普通の commit" "git commit -m 'メッセージ'"
assert_verdict allow "-am の組み合わせ" "git commit -am 'メッセージ'"
assert_verdict allow "依存の削除" "$RM_RECURSIVE node_modules"
assert_verdict allow "status" "git status --short"

echo
if [ "$FAILURES" -eq 0 ]; then
  printf '%bbash guard tests: %d/%d passed%b\n' "$GREEN" "$TESTS" "$TESTS" "$NC"
  exit 0
fi
printf '%bbash guard tests: %d/%d passed%b\n' "$RED" "$((TESTS - FAILURES))" "$TESTS" "$NC"
exit 1
