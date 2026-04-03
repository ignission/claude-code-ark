#!/bin/bash

# PostToolUse (Write|Edit) フック
# ファイル編集後に自動リント・フォーマットを実行し、残った違反をadditionalContextとしてClaudeに返す
# 自動修正を先に行い、残った違反だけを報告する方針
# リントエラーでスクリプト自体が終了しないよう set -eo pipefail は使わない

# プロジェクトルート
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# stdinからJSON読み取り
STDIN_INPUT=$(cat)

# tool_input.file_path または tool_input.path を抽出（どちらもない場合はスキップ）
FILE_PATH=$(echo "$STDIN_INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null) || exit 0

# ファイルパスが空の場合はスキップ
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# ファイルが存在しない場合はスキップ（削除操作等）
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# 拡張子を取得
EXT="${FILE_PATH##*.}"

case "$EXT" in
  ts|tsx|js|jsx)
    # --- TypeScript/JavaScriptファイル ---

    # biome formatで自動フォーマット（出力は捨てる）
    (cd "$PROJECT_ROOT" && npx biome format --write "$FILE_PATH" >/dev/null 2>&1) || true

    # フォーマットが変更されたか確認（git diffで検出）
    if [ -n "$(git diff --name-only "$FILE_PATH" 2>/dev/null)" ]; then
      jq -n '{
        "hookSpecificOutput": {
          "hookEventName": "PostToolUse",
          "additionalContext": "biomeによりフォーマットが自動修正されました。変更内容を確認してください。"
        }
      }'
    fi

    # biome checkで残りの違反を取得
    LINT_OUTPUT=$(cd "$PROJECT_ROOT" && npx biome check "$FILE_PATH" 2>&1 | head -20) || true

    # biomeの出力にエラーや警告が含まれている場合のみ報告
    if echo "$LINT_OUTPUT" | grep -qE '(diagnostics|FIXABLE|error|×)'; then
      jq -n --arg violations "$LINT_OUTPUT" '{
        "hookSpecificOutput": {
          "hookEventName": "PostToolUse",
          "additionalContext": ("リント違反が検出されました。修正してください:\n" + $violations)
        }
      }'
    fi
    ;;

  *)
    # その他のファイルは何もしない
    ;;
esac

# 常にexit 0（フックがClaudeの操作をブロックしない）
exit 0
