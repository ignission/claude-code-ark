#!/usr/bin/env bash
# .claude/lib/worktree/setup-worktree.sh
# 指定ブランチに対応する flow worktree を作成する。
# 設計判断:
#   - 既存があれば再利用（成功扱い）
#   - origin の最新を fetch してから branch を作る
#   - branch が既存ならそれを使う、無ければ origin/main から新規作成
#   - git fetch 失敗時は即エラー（意図しないコミット混入の温床になるため）

# shellcheck source=./compute-worktree-path.sh
source "$(dirname "${BASH_SOURCE[0]}")/compute-worktree-path.sh"

# 引数:
#   $1 main_root   main worktree の絶対パス
#   $2 branch      ブランチ名 (feature/issue-NNN/<slug> or feature/<slug>)
create_worktree() {
  local main_root="$1"
  local branch="$2"

  # ブランチ命名規約を関数境界で fail-fast 検証する。
  # ark の規約は以下のいずれか:
  #   feature/issue-<NNN>/<slug>  GitHub Issue 紐付け
  #   feature/<slug>              Issue なし (slug は英数 + ハイフンのみ)
  #   fix/<slug>                  バグ修正系
  #   chore/<slug>                雑務系
  if [[ ! "$branch" =~ ^(feature|fix|chore)/(issue-[0-9]+/.+|.+)$ ]]; then
    echo "ERROR: branch must match (feature|fix|chore)/(issue-<N>/<slug>|<slug>): $branch" >&2
    return 1
  fi

  local wt_path
  wt_path=$(compute_worktree_path "$main_root" "$branch") || return 1

  # main_root が main worktree であることを保証する
  local common_dir realmain
  common_dir=$(cd "$main_root" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
    echo "ERROR: $main_root は git repo として認識できません" >&2
    return 1
  }
  if command -v realpath >/dev/null 2>&1; then
    realmain=$(realpath "$main_root/.git" 2>/dev/null) || realmain="$main_root/.git"
  else
    realmain="$main_root/.git"
  fi
  if [ "$common_dir" != "$realmain" ]; then
    echo "ERROR: $main_root は main worktree ではありません（追加 worktree からの flow 起動は禁止）" >&2
    echo "  main worktree に cd してから再実行してください" >&2
    return 1
  fi

  if git -C "$main_root" worktree list --porcelain 2>/dev/null | grep -q "^worktree $wt_path$"; then
    echo "既存 worktree を再利用: $wt_path" >&2
    return 0
  fi

  if ! git -C "$main_root" fetch origin --quiet 2>/dev/null; then
    echo "ERROR: git fetch origin に失敗。ネットワークまたは権限を確認してください" >&2
    return 1
  fi

  # ローカル branch があればそれを使う
  if git -C "$main_root" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$main_root" worktree add "$wt_path" "$branch" >/dev/null 2>&1 || {
      echo "ERROR: worktree 作成に失敗 (既存 branch $branch)" >&2
      return 1
    }
    return 0
  fi

  # ローカルに無いがリモートに既存 branch があれば、それをベースに track する
  if git -C "$main_root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    git -C "$main_root" worktree add "$wt_path" -b "$branch" "origin/$branch" >/dev/null 2>&1 || {
      echo "ERROR: worktree 作成に失敗 (remote branch origin/$branch)" >&2
      return 1
    }
    return 0
  fi

  git -C "$main_root" worktree add "$wt_path" -b "$branch" origin/main >/dev/null 2>&1 || {
    echo "ERROR: worktree 作成に失敗 (新規 branch $branch from origin/main)" >&2
    return 1
  }
}
