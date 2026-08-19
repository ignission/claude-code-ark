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
HOOK_UTILS="$REPO_ROOT/.claude/hooks/push-marker-utils.sh"

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
# scope はテスト専用の一意な値にする (固定値 issue-9999 だと、万一同名の本番 run が
# 進行中の場合にその state をテストが破壊するため。pid で衝突を避ける)
SK="zshcompat-test-$$"
TMP_STATE=$(mktemp -d "/tmp/test-zsh-flow-state.XXXXXX")
TMP_STATE=$(cd "$TMP_STATE" && pwd -P)
cleanup_state() {
  rm -f "$TMP_STATE"/flow-progress-"$SK".json "$TMP_STATE"/flow-kpi-"$SK".json \
    "$TMP_STATE"/flow-context-"$SK".json "$TMP_STATE"/flow-"$SK".lock \
    "$TMP_STATE"/flow-progress-"$SK".json.new.* \
    /tmp/flow-progress-"$SK".json /tmp/flow-kpi-"$SK".json \
    /tmp/flow-context-"$SK".json /tmp/flow-"$SK".lock \
    /tmp/flow-progress-"$SK".json.new.* 2>/dev/null
}
trap 'cleanup_state; rm -rf "$TMP_STATE"' EXIT
cleanup_state
phase_after_update=$(zsh -c "
  setopt aliases 2>/dev/null
  alias mv='mv -i'
  export CLAUDE_PROJECT_DIR='$REPO_ROOT'
  export FLOW_STATE_DIR='$TMP_STATE'
  source '$LIB_DIR/state-io.sh'
  sk=\$(flow_state_init '$SK' 'feature/$SK' /tmp/zshcompat-wt 2>/dev/null) || exit 7
  flow_state_update progress '.phase = \"P2\"' \"\$sk\" </dev/null 2>/dev/null
  flow_state_read progress '.phase' \"\$sk\"
" 2>/dev/null)
assert_eq "state-io: zsh の mv -i エイリアス下でも phase 更新が反映される" "P2" "$phase_after_update"
assert_eq "state-io: progress は FLOW_STATE_DIR 配下に作られる" \
  "yes" "$([ -f "$TMP_STATE/flow-progress-$SK.json" ] && echo yes || echo no)"
assert_eq "state-io: kpi は FLOW_STATE_DIR 配下に作られる" \
  "yes" "$([ -f "$TMP_STATE/flow-kpi-$SK.json" ] && echo yes || echo no)"
assert_eq "state-io: context は FLOW_STATE_DIR 配下に作られる" \
  "yes" "$([ -f "$TMP_STATE/flow-context-$SK.json" ] && echo yes || echo no)"
assert_eq "state-io: scope lock は FLOW_STATE_DIR 配下に作られる" \
  "yes" "$([ -f "$TMP_STATE/flow-$SK.lock" ] && echo yes || echo no)"
assert_eq "state-io: atomic update の中間 file が残らない" \
  "0" "$(find "$TMP_STATE" -maxdepth 1 -name '*.new.*' -type f | wc -l | tr -d ' ')"

# deploy-watch は外部状態判定を stub し、context update の配置だけを integration 確認する。
deploy_merge_sha="0123456789abcdef"
deploy_context=$(zsh -c "
  export CLAUDE_PROJECT_DIR='$REPO_ROOT'
  export FLOW_STATE_DIR='$TMP_STATE'
  source '$LIB_DIR/state-io.sh'
  source '$LIB_DIR/deploy-watch.sh'
  deploy_watch_has_target() { return 1; }
  _deploy_watch_pm2_online() { return 1; }
  deploy_watch_init '$SK' '$deploy_merge_sha'
  flow_state_read context '.deploy_watch.merge_sha' '$SK'
" 2>/dev/null)
assert_eq "deploy-watch: context update は FLOW_STATE_DIR 配下の state を更新する" \
  "$deploy_merge_sha" "$deploy_context"
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
# Test 3: push marker utils が zsh source でも bash と同じ判定を返す
# -----------------------------------------------------------------------------
zsh_push_detect=$(zsh -c '
  source "$1" || exit 7
  push_marker_detect_git_push "git -C /tmp push"
  print -r -- "$PUSH_MARKER_IS_GIT_PUSH:$PUSH_MARKER_IS_DRY_RUN"
' zsh "$HOOK_UTILS" 2>&1)
assert_eq "push marker: zsh でも git -C push を検出する" \
  "true:false" "$zsh_push_detect"

zsh_stash_detect=$(zsh -c '
  source "$1" || exit 7
  push_marker_detect_git_push "git -C /tmp stash push"
  print -r -- "$PUSH_MARKER_IS_GIT_PUSH:$PUSH_MARKER_IS_DRY_RUN"
' zsh "$HOOK_UTILS" 2>&1)
assert_eq "push marker: zsh でも stash push を除外する" \
  "false:false" "$zsh_stash_detect"

zsh_dry_run_detect=$(zsh -c '
  source "$1" || exit 7
  push_marker_detect_git_push "git push -n"
  print -r -- "$PUSH_MARKER_IS_GIT_PUSH:$PUSH_MARKER_IS_DRY_RUN"
' zsh "$HOOK_UTILS" 2>&1)
assert_eq "push marker: zsh でも push -n を dry-run 判定する" \
  "true:true" "$zsh_dry_run_detect"

zsh_repo_dir=$(zsh -c '
  source "$1" || exit 7
  push_marker_resolve_repo_dir "" "git -C \"$2\" push" /tmp
' zsh "$HOOK_UTILS" "$TMP_STATE" 2>&1)
assert_eq "push marker: zsh でも git -C の effective cwd を解決する" \
  "$TMP_STATE" "$zsh_repo_dir"

# -----------------------------------------------------------------------------
# Test 4: 静的ガード — zsh 特殊変数を local に使う / 素の mv を使う退行を防ぐ
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
