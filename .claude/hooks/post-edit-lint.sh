#!/bin/bash

# PostToolUse (Write|Edit) フック
# ファイル編集後に自動フォーマットを実行
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

    # prettierで自動フォーマット（出力は捨てる）
    (cd "$PROJECT_ROOT" && npx prettier --write "$FILE_PATH" >/dev/null 2>&1) || true

    # フォーマットが変更されたか確認（git diffで検出）
    if [ -n "$(git diff --name-only "$FILE_PATH" 2>/dev/null)" ]; then
      jq -n '{
        "hookSpecificOutput": {
          "hookEventName": "PostToolUse",
          "additionalContext": "prettierによりフォーマットが自動修正されました。変更内容を確認してください。"
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
