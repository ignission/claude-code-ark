#!/bin/bash
# 未解決CodeRabbitレビュースレッドをGraphQL APIで取得する共通ヘルパー
#
# 使い方:
#   source fetch-unresolved-threads.sh
#   fetch_unresolved_threads
#
# 出力変数:
#   UNRESOLVED_THREADS_JSON - フィルタ済みの未解決CodeRabbitスレッド配列（JSON）
#   UNRESOLVED_THREADS_COUNT - 未解決スレッド数
#   UNRESOLVED_THREADS_ERROR - "true" or "false"（GraphQL取得失敗時）

fetch_unresolved_threads() {
  UNRESOLVED_THREADS_JSON="[]"
  UNRESOLVED_THREADS_COUNT=0
  UNRESOLVED_THREADS_ERROR="false"

  local pr_num
  pr_num=$(gh pr view --json number -q '.number' 2>/dev/null) || pr_num=""
  if [[ -z "$pr_num" ]]; then
    return 0
  fi

  local repo_info
  repo_info=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null) || repo_info=""
  if [[ -z "$repo_info" ]]; then
    return 0
  fi

  local repo_owner repo_name
  repo_owner=$(printf '%s\n' "$repo_info" | cut -d'/' -f1)
  repo_name=$(printf '%s\n' "$repo_info" | cut -d'/' -f2)

  local raw_data
  raw_data=$(gh api graphql -f query="
    {
      repository(owner: \"${repo_owner}\", name: \"${repo_name}\") {
        pullRequest(number: ${pr_num}) {
          reviewThreads(first: 100) {
            nodes {
              isResolved
              comments(first: 1) {
                nodes {
                  author { login }
                  body
                  path
                  line
                }
              }
            }
          }
        }
      }
    }
  " 2>/dev/null) || raw_data=""

  if [[ -z "$raw_data" ]]; then
    UNRESOLVED_THREADS_ERROR="true"
    return 0
  fi

  if printf '%s\n' "$raw_data" | jq -e '.errors | length > 0' >/dev/null 2>&1; then
    UNRESOLVED_THREADS_ERROR="true"
    return 0
  fi

  UNRESOLVED_THREADS_JSON=$(printf '%s\n' "$raw_data" | jq '
    [
      .data.repository.pullRequest.reviewThreads.nodes[]
      | select(.isResolved == false)
      | .comments.nodes[0]
      | select(.author.login == "coderabbitai")
    ]
  ' 2>/dev/null) || UNRESOLVED_THREADS_JSON="[]"

  UNRESOLVED_THREADS_COUNT=$(printf '%s\n' "$UNRESOLVED_THREADS_JSON" | jq 'length' 2>/dev/null) || UNRESOLVED_THREADS_COUNT=0
}
