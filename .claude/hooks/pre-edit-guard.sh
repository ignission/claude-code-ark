#!/bin/bash
# PreToolUse (Write|Edit): リンター・ビルド設定ファイルの編集をブロック
# エージェントがリンター設定を変更してルールを回避するのを防ぐ

input="$(cat)"
file="$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)" || exit 0

# ファイルパスが空なら通過
[ -z "$file" ] && exit 0

# 品質ゲート本体の保護（パスベース判定 — basename判定より先に実行）
case "$file" in
  */.claude/hooks/*|.claude/hooks/*|*/.claude/settings.json|.claude/settings.json|*/.claude/settings.local.json|.claude/settings.local.json)
    echo "BLOCKED: $file はClaude Code品質ゲートの設定ファイルです。直接編集は禁止されています" >&2
    echo "  WHY: エージェントがガード自体を弱めるのを防止" >&2
    echo "  FIX: 変更が本当に必要な場合はユーザーに確認" >&2
    exit 2
    ;;
  */lefthook.yml|lefthook.yml|*/sgconfig.yml|sgconfig.yml)
    echo "BLOCKED: $file はgit hooks/リンター設定ファイルです。直接編集は禁止されています" >&2
    echo "  WHY: エージェントがガード自体を弱めるのを防止" >&2
    echo "  FIX: 変更が本当に必要な場合はユーザーに確認" >&2
    exit 2
    ;;
esac

# ファイル名（パスの末尾）を抽出
basename="$(basename "$file")"

# 保護対象の判定（basename判定）
case "$basename" in
  biome.json|biome.jsonc) ;;
  .eslintrc*|eslint.config.*) ;;
  .editorconfig) ;;
  tsconfig.json) ;;
  *) exit 0 ;;
esac

echo "BLOCKED: $basename はリンター・ビルド設定ファイルです。直接編集は禁止されています" >&2
echo "  WHY: エージェントがリンター設定を緩和してルール回避するのを防止" >&2
echo "  FIX: 変更が本当に必要な場合はユーザーに「○○の理由で△△を変更してよいか」と確認" >&2
exit 2
