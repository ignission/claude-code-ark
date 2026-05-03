#!/usr/bin/env bash
# .claude/lib/cleanup.sh
# flow P11 から呼ばれる cleanup ヘルパー。
# PR squash merge → main pull → tmux/ttyd 孤児回収 → Issue クローズヒント。
#
# 仕様:
#   flow P11 では worktree を **削除しない**。pm2 監視 (P12) で deploy 失敗時の
#   調査ができるよう、worktree は P12 完了後にユーザーが手動削除する。
#   `cleanup_remove_worktree` 関数は手動 cleanup 用途で残置（flow からは呼ばない）。
#
# 設計判断:
#   - worktree パスは <repo-parent>/ark-<sanitized> のみ
#   - PR state == MERGED を gh pr view で確認してから worktree 削除

set -euo pipefail

# === 公開関数 ===

# PR を squash merge し、ローカル main を最新化する。
cleanup_merge_pr() {
  local pr_number="$1"
  if [ -z "$pr_number" ]; then
    echo "ERROR: PR 番号が必要です" >&2
    return 1
  fi
  gh pr merge "$pr_number" --squash --delete-branch
}

# main worktree のルートに cd してローカル main を最新化する。
cleanup_pull_main() {
  local main_git_common_dir main_wt_root
  main_git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
    echo "ERROR: git common dir が取得できません" >&2
    return 1
  }
  main_wt_root="${main_git_common_dir%/.git}"
  cd "$main_wt_root"
  git checkout main && git pull

  # `[origin/...: gone]` のローカル branch を掃除。
  # P11 で worktree を削除しないため、worktree 経由で checkout 中のブランチを除外する必要がある。
  local worktree_branches
  worktree_branches=$(git worktree list --porcelain 2>/dev/null \
    | awk '/^branch /{sub("^refs/heads/", "", $2); print $2}')
  local gone_branches
  gone_branches=$(git branch -vv \
    | { grep '\[origin/.*: gone\]' || true; } \
    | sed -E 's/^[+* ]+//' \
    | awk '{print $1}')
  if [ -n "$gone_branches" ]; then
    if [ -n "$worktree_branches" ]; then
      gone_branches=$(printf '%s\n' "$gone_branches" \
        | { grep -vxF -f <(printf '%s\n' "$worktree_branches") || true; })
    fi
    [ -n "$gone_branches" ] && printf '%s\n' "$gone_branches" | xargs -r git branch -d
  fi
  printf '%s\n' "$main_wt_root"
}

# flow worktree を削除する (手動 cleanup 用途、flow からは呼ばない)。
cleanup_remove_worktree() {
  local wt_path="$1"
  local pr_number="$2"
  if [ -z "$wt_path" ] || [ -z "$pr_number" ]; then
    echo "ERROR: worktree path と PR 番号が必要です" >&2
    return 1
  fi
  if [ ! -d "$wt_path" ]; then
    echo "worktree 不在のためスキップ: $wt_path" >&2
    return 0
  fi
  local pr_state
  pr_state=$(gh pr view "$pr_number" --json state -q .state 2>/dev/null) || pr_state=""
  if [ "$pr_state" != "MERGED" ]; then
    echo "WARNING: PR #$pr_number state=$pr_state のため worktree を削除しません: $wt_path" >&2
    return 1
  fi

  local main_git_common_dir main_wt_root
  main_git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  main_wt_root="${main_git_common_dir%/.git}"
  git -C "$main_wt_root" worktree remove "$wt_path" --force
  git -C "$main_wt_root" worktree prune
  echo "worktree 削除: $wt_path" >&2
}

# 孤児 tmux/ttyd を回収する。
# ark 開発中の作業セッションは `ark-<branch>` の prefix なので、
# 該当 worktree が消えた tmux session のみ整理する (実セッションには手を出さない)。
# flow から worktree は残す方針なので、本関数は no-op としておくが、将来の手動 cleanup 用に
# シェルから呼び出せる形は残す。
cleanup_orphan_terminals() {
  echo "(flow では worktree を残すため、tmux/ttyd の自動 cleanup はスキップ)" >&2
}

# Issue を「対応済み」相当にするためのコメントヒント。
# 引数: $1 issue_number（空ならスキップ）
cleanup_issue_close_hint() {
  local issue_number="$1"
  if [ -z "$issue_number" ] || [ "$issue_number" = "null" ]; then
    return 0
  fi
  cat <<EOF >&2
[Issue] #$issue_number に PR マージのコメントを残してください:
  gh issue comment $issue_number --body "PR #<num> をマージしました"
  必要に応じて gh issue close $issue_number （PR 側で `Closes #$issue_number` を含めていれば自動クローズ）
EOF
}
