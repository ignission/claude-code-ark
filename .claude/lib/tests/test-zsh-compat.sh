#!/bin/bash
# =============================================================================
# skill ライブラリの zsh 互換性回帰テスト
#
# これらの lib は flow / flow-x skill から **zsh（Claude Code の Bash ツール）に
# source** されて動く。bash 専用の書き方（zsh 特殊変数 path/status を local に使う、
# 素の mv が mv -i エイリアスで対話化する、BASH_SOURCE での self-locate）は
# bash 実行の既存テストでは検出できないため、本テストは各関数を zsh 上で実行して
# 回帰を防ぐ。
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB_DIR="$REPO_ROOT/.claude/lib"

TESTS=0
PASSES=0
FAILURES=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

assert_eq() {
  local description="$1" expected="$2" actual="$3"
  TESTS=$((TESTS + 1))
  if [ "$expected" = "$actual" ]; then
    PASSES=$((PASSES + 1)); echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1)); echo -e "${RED}FAIL${NC}: $description"
    echo "  expected: $expected"; echo "  actual:   $actual"
  fi
}

require_zsh() {
  command -v zsh >/dev/null 2>&1 || { echo "SKIP: zsh が無いため zsh 互換テストをスキップ"; exit 0; }
}
require_zsh

# -----------------------------------------------------------------------------
# Test 1: state-io の atomic 書き込みが zsh の `mv -i` エイリアス下でも成功する
#   state-io.sh が素の `mv` を使うと、ユーザの `alias mv='mv -i'` が効いた zsh で
#   非対話（stdin=/dev/null）時に上書きを拒否し、state 更新が無言で失われる。
#   command mv を使えばエイリアスを迂回して必ず上書きできる。
# -----------------------------------------------------------------------------
SK="issue-9999"
cleanup_state() { rm -f /tmp/flow-progress-"$SK".json /tmp/flow-kpi-"$SK".json \
  /tmp/flow-context-"$SK".json /tmp/flow-"$SK".lock /tmp/flow-progress-"$SK".json.new.* 2>/dev/null; }
cleanup_state
phase_after_update=$(zsh -c "
  setopt aliases 2>/dev/null
  alias mv='mv -i'
  source '$LIB_DIR/state-io.sh'
  sk=\$(flow_state_init issue-9999 feature/issue-9999/zshcompat /tmp/zshcompat-wt 9999 2>/dev/null) || exit 7
  flow_state_update progress '.phase = \"P2\"' \"\$sk\" </dev/null 2>/dev/null
  flow_state_read progress '.phase' \"\$sk\"
" 2>/dev/null)
assert_eq "state-io: zsh の mv -i エイリアス下でも phase 更新が反映される" "P2" "$phase_after_update"
cleanup_state

# -----------------------------------------------------------------------------
# Test 2: worktree sibling source が zsh でも成功する（BASH_SOURCE 非依存）
#   zsh で source すると BASH_SOURCE は未定義のため、self-locate に依存すると
#   sibling lib の source が壊れる。CLAUDE_PROJECT_DIR 経由の絶対パス解決を検証。
# -----------------------------------------------------------------------------
zsh_compute=$(zsh -c "
  export CLAUDE_PROJECT_DIR='$REPO_ROOT'
  source '$LIB_DIR/worktree/compute-worktree-path.sh' || exit 7
  compute_worktree_path /home/user/dev/myrepo feature/issue-1/foo
" 2>/dev/null)
assert_eq "worktree: zsh でも sibling source + compute_worktree_path が動く" \
  "/home/user/dev/ark-feature-issue-1-foo" "$zsh_compute"

# CLAUDE_PROJECT_DIR 未設定なら fail loud（誤 path 推測で続行しない）
unset_rc=$(zsh -c "
  unset CLAUDE_PROJECT_DIR
  source '$LIB_DIR/worktree/compute-worktree-path.sh' 2>/dev/null && echo sourced || echo failed
" 2>/dev/null)
assert_eq "worktree: CLAUDE_PROJECT_DIR 未設定時は source が fail loud" "failed" "$unset_rc"

# -----------------------------------------------------------------------------
# Test 3: 静的ガード — zsh 特殊変数を local に使う / 素の mv を使う退行を防ぐ
#   awk スクリプト内の path= は対象外（シェル変数ではない）なので `local` 行に限定。
#   lib 配下の全シェルスクリプトを対象にし、将来の新規追加でも zsh 特殊変数
#   （PATH を破壊する path / read-only な status 等）の混入を検出する。
# -----------------------------------------------------------------------------
guard_files=()
while IFS= read -r f; do
  guard_files+=("$f")
done < <(find "$LIB_DIR" -name '*.sh' -type f ! -path '*/tests/*' 2>/dev/null | sort)
bad_local=0
for f in "${guard_files[@]}"; do
  [ -f "$f" ] || continue
  if grep -nE '^[[:space:]]*local[[:space:]].*\b(path|status|options|signals|cdpath|argv|pipestatus)\b' "$f" >/dev/null 2>&1; then
    echo "  -> zsh 特殊変数を local に使用: $f"
    grep -nE '^[[:space:]]*local[[:space:]].*\b(path|status|options|signals|cdpath|argv|pipestatus)\b' "$f"
    bad_local=1
  fi
done
assert_eq "静的ガード: zsh 特殊変数を local に使っていない" "0" "$bad_local"

bad_mv=0
if grep -nE '(^|[^_[:alnum:]])mv[[:space:]]' "$LIB_DIR/state-io.sh" | grep -vE 'command mv' >/dev/null 2>&1; then
  echo "  -> 素の mv を使用 (command mv にすべき): $LIB_DIR/state-io.sh"
  grep -nE '(^|[^_[:alnum:]])mv[[:space:]]' "$LIB_DIR/state-io.sh" | grep -vE 'command mv'
  bad_mv=1
fi
assert_eq "静的ガード: state-io は command mv を使う（素の mv なし）" "0" "$bad_mv"

# コメント行での言及は許容し、実コード行 (# 以前に BASH_SOURCE が現れる行) のみ検出する
bad_bash_source=0
for f in "${guard_files[@]}"; do
  [ -f "$f" ] || continue
  if grep -nE '^[^#]*BASH_SOURCE' "$f" >/dev/null 2>&1; then
    echo "  -> BASH_SOURCE self-locate を使用 (zsh で未定義): $f"
    grep -nE '^[^#]*BASH_SOURCE' "$f"
    bad_bash_source=1
  fi
done
assert_eq "静的ガード: lib は BASH_SOURCE self-locate を使わない (CLAUDE_PROJECT_DIR 解決)" "0" "$bad_bash_source"

# -----------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
echo "========================================"
[ "$FAILURES" -eq 0 ]
