#!/bin/bash
set -eo pipefail

# PreCompact: コンパクション前に重要なコンテキスト情報を保護する
# 長時間セッションでの情報損失を軽減するため、作業状態をadditionalContextとして出力

# 現在のブランチ名を取得
BRANCH=$(git branch --show-current 2>/dev/null) || BRANCH="(不明)"

# mainからの差分ファイル一覧を取得
DIFF_FILES=$(git diff --name-only origin/main...HEAD 2>/dev/null) || DIFF_FILES="(取得失敗)"

# 直近5コミットのログを取得
RECENT_COMMITS=$(git log --oneline -5 2>/dev/null) || RECENT_COMMITS="(取得失敗)"

# 未コミットの変更があるかチェック
UNCOMMITTED=$(git status --porcelain 2>/dev/null | head -10)
if [ -n "$UNCOMMITTED" ]; then
  UNCOMMITTED_STATUS="あり\n${UNCOMMITTED}"
else
  UNCOMMITTED_STATUS="なし"
fi

# additionalContextの組み立て
CONTEXT="=== セッションコンテキスト ===\nブランチ: ${BRANCH}"
CONTEXT="${CONTEXT}\n\n=== 変更ファイル（mainからの差分） ===\n${DIFF_FILES}"
CONTEXT="${CONTEXT}\n\n=== 直近コミット ===\n${RECENT_COMMITS}"
CONTEXT="${CONTEXT}\n\n=== 未コミット変更 ===\n${UNCOMMITTED_STATUS}"

# JSON形式でstdoutに出力
jq -n --arg ctx "$CONTEXT" '{
  "hookSpecificOutput": {
    "hookEventName": "PreCompact",
    "additionalContext": $ctx
  }
}'

exit 0
