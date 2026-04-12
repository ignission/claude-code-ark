#!/bin/bash
set -eo pipefail

# SessionStart: 開発環境の検証（全てwarning扱い、ブロックしない）

WARNINGS=""

# Node.js の確認
NODE_VERSION=$(node --version 2>/dev/null) || NODE_VERSION=""
if [ -z "$NODE_VERSION" ]; then
  WARNINGS="${WARNINGS}WARNING: Node.jsがインストールされていません\n"
else
  WARNINGS="${WARNINGS}Node: ${NODE_VERSION}\n"
fi

# pnpm の確認
PNPM_VERSION=$(pnpm --version 2>/dev/null) || PNPM_VERSION=""
if [ -z "$PNPM_VERSION" ]; then
  WARNINGS="${WARNINGS}WARNING: pnpmがインストールされていません。npm install -g pnpm でインストールしてください\n"
else
  WARNINGS="${WARNINGS}pnpm: ${PNPM_VERSION}\n"
fi

# tmux の確認
if ! command -v tmux &>/dev/null; then
  WARNINGS="${WARNINGS}WARNING: tmuxがインストールされていません。セッション管理に必要です\n"
else
  TMUX_VERSION=$(tmux -V 2>/dev/null) || TMUX_VERSION="(取得失敗)"
  WARNINGS="${WARNINGS}tmux: ${TMUX_VERSION}\n"
fi

# ttyd の確認
if ! command -v ttyd &>/dev/null; then
  WARNINGS="${WARNINGS}WARNING: ttydがインストールされていません。Webターミナルに必要です\n"
else
  TTYD_VERSION=$(ttyd --version 2>/dev/null | head -1) || TTYD_VERSION="(取得失敗)"
  WARNINGS="${WARNINGS}ttyd: ${TTYD_VERSION}\n"
fi

# gh CLI認証確認
if ! gh auth status &>/dev/null; then
  WARNINGS="${WARNINGS}WARNING: gh CLIが未認証です。gh auth login を実行してください\n"
fi

# ディスク容量チェック（5GB未満で警告）
AVAIL_KB=$(df -k / | tail -1 | awk '{print $4}')
AVAIL_GB=$((AVAIL_KB / 1048576))
if [ "$AVAIL_GB" -lt 5 ] 2>/dev/null; then
  WARNINGS="${WARNINGS}WARNING: ディスク残容量: ${AVAIL_GB}GB（5GB未満）\n"
  WARNINGS="${WARNINGS}  → docker system prune / pnpm store prune / /garbage-collect でクリーンアップを推奨\n"
fi

# 結果をstdoutに出力（Claudeのコンテキストに追加される）
if [ -n "$WARNINGS" ]; then
  echo -e "$WARNINGS"
fi

# === セッション復帰コンテキスト ===
BRANCH=$(git branch --show-current 2>/dev/null) || BRANCH="(不明)"
echo "ブランチ: ${BRANCH}"

# 直近のコミット（前セッションの作業内容把握）
echo ""
echo "=== 直近のコミット ==="
git log --oneline -5 2>/dev/null || echo "(取得失敗)"

# 未コミット変更の有無
UNCOMMITTED=$(git status --porcelain 2>/dev/null | head -5)
if [ -n "$UNCOMMITTED" ]; then
  echo ""
  echo "=== 未コミット変更あり ==="
  echo "$UNCOMMITTED"
fi

# stop_hook_activeフラグの確認
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "$PROJECT_ROOT/.claude/stop_hook_active" ]; then
  echo ""
  echo "WARNING: stop_hook_activeフラグが残っています。前回テストが失敗した可能性があります。"
  echo "確認後、rm $PROJECT_ROOT/.claude/stop_hook_active で削除してください。"
fi

exit 0
