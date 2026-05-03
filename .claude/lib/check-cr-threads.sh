#!/usr/bin/env bash
# .claude/lib/check-cr-threads.sh
# 既存 hook (check-ci-coderabbit.sh / fetch-unresolved-threads.sh) を再利用する
# フロントエンド。flow P7 (CI/CR 監視) と P8 (自律修正) で利用。

set -euo pipefail

_cr_hooks_dir() {
  local root
  root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  printf '%s/.claude/hooks\n' "$root"
}

# CI / CodeRabbit の現在状態を取得して action 文字列を返す。
# 出力変数:
#   CR_STATE_JSON - check-ci-coderabbit.sh が返す JSON 全体
#   CR_ACTION     - .action フィールド
check_cr_action_state() {
  local hooks
  hooks=$(_cr_hooks_dir)
  CR_STATE_JSON=$(bash "$hooks/check-ci-coderabbit.sh")
  CR_ACTION=$(printf '%s' "$CR_STATE_JSON" | jq -r '.action')
}

# CodeRabbit の未解決スレッドを取得する。
# 出力変数:
#   UNRESOLVED_THREADS_JSON, UNRESOLVED_THREADS_COUNT, UNRESOLVED_THREADS_ERROR
check_cr_unresolved_threads() {
  local hooks
  hooks=$(_cr_hooks_dir)
  # shellcheck source=/dev/null
  source "$hooks/fetch-unresolved-threads.sh"
  fetch_unresolved_threads
}

check_cr_pr_number() {
  gh pr view --json number -q '.number' 2>/dev/null
}

check_cr_repo() {
  gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null
}
