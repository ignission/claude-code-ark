#!/bin/bash

# PostToolUse (Write|Edit) フック
# 編集したファイルを biome で整形し、残った違反を additionalContext として Claude に返す。
# 違反があっても編集は止めない（常に exit 0）ので set -eo pipefail は使わない。
#
# stdout に出す JSON は 1 つだけにする。2 つ並べると Claude Code は JSON として
# 読めず、どちらのメッセージも捨てる。

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

STDIN_INPUT=$(cat)
FILE_PATH=$(echo "$STDIN_INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null) || exit 0

# 削除された、またはパスが取れなかった場合は何もしない
[ -f "$FILE_PATH" ] || exit 0

case "${FILE_PATH##*.}" in
  ts | tsx | js | jsx) ;;
  *) exit 0 ;;
esac

# プロジェクトの外（スクラッチなど）は biome の設定が当たらないので対象にしない。
# `..` やシンボリックリンクで外へ出るパスを通さないよう、実体のパスで比べる。
PROJECT_ROOT=$(cd "$PROJECT_ROOT" 2>/dev/null && pwd -P) || exit 0
FILE_DIR=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd -P) || exit 0
[ -L "$FILE_PATH" ] && exit 0
FILE_PATH="$FILE_DIR/$(basename "$FILE_PATH")"
case "$FILE_PATH" in
  "$PROJECT_ROOT"/*) ;;
  *) exit 0 ;;
esac

cd "$PROJECT_ROOT" || exit 0

# 整形で中身が変わったかは、ファイルそのものの前後で比べる。
# git diff で比べると、編集しただけで「整形された」と誤報する。
BEFORE=$(cksum <"$FILE_PATH")
npx biome format --write --no-errors-on-unmatched "$FILE_PATH" >/dev/null 2>&1
AFTER=$(cksum <"$FILE_PATH")

MESSAGE=""
if [ "$BEFORE" != "$AFTER" ]; then
  MESSAGE="biome がこのファイルを整形しました。続けて編集するなら読み直してください。"
fi

# 違反の有無は終了コードで決める（CI の biome check と同じ基準）。
# 出力の文字列で判定すると、コード中の error という語に反応する。
if ! LINT_OUTPUT=$(npx biome check --no-errors-on-unmatched "$FILE_PATH" 2>&1); then
  [ -n "$MESSAGE" ] && MESSAGE="${MESSAGE}"$'\n\n'
  MESSAGE="${MESSAGE}リント違反が残っています。修正してください:"$'\n'"$(echo "$LINT_OUTPUT" | head -40)"
fi

if [ -n "$MESSAGE" ]; then
  jq -n --arg ctx "$MESSAGE" '{
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": $ctx
    }
  }'
fi

exit 0
