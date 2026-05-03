#!/usr/bin/env bash
# .claude/lib/worktree/compute-worktree-path.sh
# main worktree の絶対パスとブランチ名から flow worktree の絶対パスを計算する。
# 規約: <repo-parent>/ark-<sanitized-branch>/

# shellcheck source=./sanitize-branch.sh
source "$(dirname "${BASH_SOURCE[0]}")/sanitize-branch.sh"

compute_worktree_path() {
  local main_root="$1"
  local branch="$2"
  if [ -z "$main_root" ] || [ -z "$branch" ]; then
    echo "ERROR: main_root and branch are required" >&2
    return 1
  fi
  main_root="${main_root%/}"
  local parent dirname
  parent=$(dirname "$main_root")
  dirname=$(sanitize_branch_to_dirname "$branch") || return 1
  printf '%s/%s\n' "$parent" "$dirname"
}
