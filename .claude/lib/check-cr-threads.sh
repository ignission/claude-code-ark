#!/usr/bin/env bash
# .claude/lib/check-cr-threads.sh
# 既存 hook (check-ci-coderabbit.sh / fetch-unresolved-threads.sh) を再利用する
# フロントエンド。flow P7 (CI/CR 監視) と P8 (自律修正) で利用。

set -euo pipefail

_cr_hooks_dir() {
  # 呼び出し元の cwd に依存せず CLAUDE_PROJECT_DIR で hook 配置を解決する。
  # zsh で source した場合 BASH_SOURCE は未定義、$0 も self-locate に使えないため、
  # 推測でずれた path を返すより未設定なら fail loud にする
  # (flow / flow-x は source 前に必ず CLAUDE_PROJECT_DIR を設定する)。
  if [ -z "${CLAUDE_PROJECT_DIR:-}" ]; then
    echo "ERROR: CLAUDE_PROJECT_DIR が未設定です (check-cr-threads.sh は flow context から source してください)" >&2
    return 1
  fi
  printf '%s/.claude/hooks\n' "$CLAUDE_PROJECT_DIR"
}

# CI / CodeRabbit の現在状態を取得して action 文字列を返す。
# 出力変数:
#   CR_STATE_JSON - check-ci-coderabbit.sh が返す JSON 全体
#   CR_ACTION     - .action フィールド
#
# check-ci-coderabbit.sh は repo/auth/branch エラー時に exit 1 だが
# 構造化 JSON ({status:error, action:stop_monitoring_failure}) は stdout に出している。
# `set -e` 下でコマンド置換が exit 1 だと caller も即死して JSON を失うため、
# `|| true` で吸収する (codex review [P2] 指摘への対応)。
check_cr_action_state() {
  local hooks
  hooks=$(_cr_hooks_dir)
  CR_STATE_JSON=$(bash "$hooks/check-ci-coderabbit.sh" || true)
  if [ -z "$CR_STATE_JSON" ]; then
    CR_STATE_JSON='{"status":"error","ci":{"status":"error","details":"check-ci-coderabbit.sh から JSON を取得できませんでした"},"coderabbit":{"status":"error","unresolved":0,"comments":[]},"action":"stop_monitoring_failure"}'
  fi
  CR_ACTION=$(printf '%s' "$CR_STATE_JSON" | jq -r '.action // "stop_monitoring_failure"' 2>/dev/null || echo "stop_monitoring_failure")
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
