#!/bin/bash
# CI・CodeRabbit監視スクリプト
# git push / gh pr create 後のCI・CodeRabbit状態を定期チェックし、
# 結果を構造化JSON形式でstdoutに出力する。
#
# 使い方:
#   ./check-ci-coderabbit.sh
#

# APIエラーでスクリプト全体が停止しないよう、set -eo pipefail は使わない

# 第1引数は後方互換のため受け付けるが使用しない（以前はREPO_INFOとして誤用されていた）

# === リポジトリ情報の取得 ===

  REPO_INFO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null)
  if [[ -z "$REPO_INFO" ]]; then
    jq -n '{
      status: "error",
      ci: { status: "error", details: "リポジトリ情報を取得できませんでした" },
      coderabbit: { status: "error", new_comments: 0, unresolved: 0, comments: [] },
      action: "stop_monitoring_failure"
    }'
    exit 1
  fi

# === 現在のブランチ名を取得 ===

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
if [[ -z "$CURRENT_BRANCH" ]]; then
  jq -n '{
    status: "error",
    ci: { status: "error", details: "現在のブランチを取得できませんでした" },
    coderabbit: { status: "error", new_comments: 0, unresolved: 0, comments: [] },
    action: "stop_monitoring_failure"
  }'
  exit 1
fi

# === 1. CI状態チェック ===

if ! CI_RAW=$(gh run list --branch "$CURRENT_BRANCH" --limit 3 --json name,conclusion 2>/dev/null) || [[ -z "$CI_RAW" ]]; then
  CI_STATUS="error"
  CI_DETAILS="CI情報の取得に失敗しました"
else
  CI_DETAILS=$(echo "$CI_RAW" | jq -r '.[] | .name + ": " + (.conclusion // "pending")')
  CI_STATUS=$(echo "$CI_RAW" | jq -r '
    if length == 0 then "pending"
    elif [.[] | .conclusion] | any(. == null or . == "" or . == "pending" or . == "queued" or . == "in_progress" or . == "waiting") then "pending"
    elif [.[] | .conclusion] | any(. == "failure" or . == "cancelled" or . == "timed_out" or . == "action_required" or . == "stale") then "failure"
    else "success"
    end
  ')
fi

# === 2. CodeRabbit状態チェック ===

if ! HEAD_SHA=$(gh pr view --json headRefOid -q '.headRefOid' 2>/dev/null) || [[ -z "$HEAD_SHA" ]]; then
  CR_STATUS="not_found"
else
  if ! CR_STATUS_RAW=$(gh api "repos/${REPO_INFO}/commits/${HEAD_SHA}/statuses" 2>/dev/null) || [[ -z "$CR_STATUS_RAW" ]]; then
    CR_STATUS="error"
  else
    CR_STATUS=$(echo "$CR_STATUS_RAW" | jq -r '
      [.[] | select(.context == "CodeRabbit")] |
      sort_by(.updated_at) |
      last |
      .state // "not_found"
    ')
    if [[ -z "$CR_STATUS" ]] || [[ "$CR_STATUS" == "null" ]]; then
      CR_STATUS="not_found"
    fi
  fi
fi

# === 3. 未解決レビュースレッド取得（GraphQL API） ===
# PUSH_TIMEベースのフィルタは不要。未解決スレッド数がCodeRabbit指摘の判定基準。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/fetch-unresolved-threads.sh"
fetch_unresolved_threads

CR_UNRESOLVED="$UNRESOLVED_THREADS_COUNT"
CR_GQL_ERROR="$UNRESOLVED_THREADS_ERROR"

# 監視スクリプト用のJSON形式に変換
CR_COMMENTS_JSON=$(printf '%s\n' "$UNRESOLVED_THREADS_JSON" | jq '
  [.[] | {
    path: .path,
    line: (.line // 0),
    body_preview: (.body | .[0:100])
  }]
' 2>/dev/null) || CR_COMMENTS_JSON="[]"

# === 4. 総合判定と出力 ===

# 判定ロジック:
#   CI=pending OR CR=pending → status="pending", action="continue_monitoring"
#   CI=failure OR CR=failure/error → status="error", action="stop_monitoring_failure"
#   CI=success AND CR=success AND unresolved>0 → status="action_required", action="run_check_coderabbit"
#   CI=success AND CR=success AND unresolved=0 → status="complete", action="stop_monitoring_success"

jq -n \
  --arg ci_status "$CI_STATUS" \
  --arg ci_details "$CI_DETAILS" \
  --arg cr_status "$CR_STATUS" \
  --argjson cr_unresolved "${CR_UNRESOLVED:-0}" \
  --arg cr_gql_error "${CR_GQL_ERROR:-false}" \
  --argjson cr_comments "${CR_COMMENTS_JSON:-[]}" \
  '
  (
    if $ci_status == "failure" or $cr_status == "failure" or $cr_status == "error" or $cr_gql_error == "true" then
      { status: "error", action: "stop_monitoring_failure" }
    elif $ci_status == "pending" or $cr_status == "pending" or $cr_status == "not_found" then
      { status: "pending", action: "continue_monitoring" }
    elif $ci_status == "success" and $cr_status == "success" and $cr_unresolved > 0 then
      { status: "action_required", action: "run_check_coderabbit" }
    elif $ci_status == "success" and $cr_status == "success" and $cr_unresolved == 0 then
      { status: "complete", action: "stop_monitoring_success" }
    else
      { status: "error", action: "stop_monitoring_failure" }
    end
  ) as $result |
  {
    status: $result.status,
    ci: {
      status: $ci_status,
      details: $ci_details
    },
    coderabbit: {
      status: $cr_status,
      unresolved: $cr_unresolved,
      comments: $cr_comments
    },
    action: $result.action
  }
  '
