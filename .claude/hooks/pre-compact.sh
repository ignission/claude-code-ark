#!/bin/bash
set -eo pipefail

# PreCompact: コンパクション前に重要なコンテキスト情報を保護する
# 長時間セッションでの情報損失を軽減するため、作業状態をadditionalContextとして出力

BRANCH=$(git branch --show-current 2>/dev/null) || BRANCH="(不明)"

DIFF_FILES=$(git diff --name-only origin/main...HEAD 2>/dev/null) || DIFF_FILES="(取得失敗)"

RECENT_COMMITS=$(git log --oneline -5 2>/dev/null) || RECENT_COMMITS="(取得失敗)"

UNCOMMITTED=$(git status --porcelain 2>/dev/null | head -10)
if [ -n "$UNCOMMITTED" ]; then
  UNCOMMITTED_STATUS="あり\n${UNCOMMITTED}"
else
  UNCOMMITTED_STATUS="なし"
fi

# ブランチから flow の WORK_ID と GitHub Issue # を抽出
FLOW_WORK_ID=""
FLOW_ISSUE_NUMBER=""
if [[ "$BRANCH" =~ ^(feature|fix|chore)/issue-([0-9]+)/.+$ ]]; then
  FLOW_ISSUE_NUMBER="${BASH_REMATCH[2]}"
  FLOW_WORK_ID="issue-${FLOW_ISSUE_NUMBER}"
elif [[ "$BRANCH" =~ ^(feature|fix|chore)/(.+)$ ]]; then
  FLOW_SLUG="${BASH_REMATCH[2]}"
  if [[ "$FLOW_SLUG" =~ ^[a-z0-9-]+$ ]]; then
    FLOW_WORK_ID="$FLOW_SLUG"
  fi
fi

CONTEXT="=== セッションコンテキスト ===\nブランチ: ${BRANCH}"

if [ -n "$FLOW_WORK_ID" ]; then
  CONTEXT="${CONTEXT}\nflow WORK_ID: ${FLOW_WORK_ID}"
fi
if [ -n "$FLOW_ISSUE_NUMBER" ]; then
  CONTEXT="${CONTEXT}\nGitHub Issue: #${FLOW_ISSUE_NUMBER}"
fi

CONTEXT="${CONTEXT}\n\n=== 変更ファイル（mainからの差分） ===\n${DIFF_FILES}"
CONTEXT="${CONTEXT}\n\n=== 直近コミット ===\n${RECENT_COMMITS}"
CONTEXT="${CONTEXT}\n\n=== 未コミット変更 ===\n${UNCOMMITTED_STATUS}"

jq -n --arg ctx "$CONTEXT" '{
  "hookSpecificOutput": {
    "hookEventName": "PreCompact",
    "additionalContext": $ctx
  }
}'

exit 0
