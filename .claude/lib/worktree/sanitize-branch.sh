#!/usr/bin/env bash
# .claude/lib/worktree/sanitize-branch.sh
# ブランチ名から worktree ディレクトリ名を生成する。
# 規約:
#   feature/issue-NNN/<slug>  → ark-feature-issue-NNN-<slug>
#   feature/<slug>            → ark-feature-<slug>
# Ark/Conductor が detect する prefix `ark-` を付ける（リポジトリ名は `claude-code-ark`）。

# ブランチ名 → worktree ディレクトリ名
sanitize_branch_to_dirname() {
  local branch="$1"
  if [ -z "$branch" ]; then
    echo "ERROR: branch name is empty" >&2
    return 1
  fi
  # スラッシュをハイフン化、連続ハイフンを1つに圧縮、先頭・末尾のハイフンを除去
  local sanitized
  sanitized=$(printf '%s' "$branch" | tr '/' '-' | sed 's/--*/-/g; s/-$//; s/^-//')
  printf 'ark-%s\n' "$sanitized"
}
