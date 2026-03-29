#!/bin/bash
set -eo pipefail

# PreToolUse (Bash) 統合ガードフック
# git push / gh pr create 時のみチェックを実行し、それ以外は即スキップ

# stdinからツール入力JSONを読み取り、コマンドを抽出（パース失敗時はスキップ）
STDIN_INPUT=$(cat)
COMMAND=$(echo "$STDIN_INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0

# --- git commit / git tag はメッセージ内容を検査しない（誤検出防止） ---
if [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]]+(commit|tag)[[:space:]] ]]; then
  exit 0
fi



# --- pre-push-reviewフラグファイル作成のガード ---
if [[ "$COMMAND" =~ claude-pre-push-review-done ]]; then
  if [[ "$COMMAND" =~ ^[[:space:]]*touch[[:space:]] ]] && \
     [[ "$COMMAND" =~ git[[:space:]]+rev-parse[[:space:]]+--git-dir ]] && \
     ! [[ "$COMMAND" =~ [\;\|\&] ]] && \
     ! [[ "$COMMAND" =~ \# ]] && \
     ! [[ "$COMMAND" =~ \> ]] && \
     ! [[ "$COMMAND" =~ $'\n' ]]; then
    exit 0
  fi
  echo "BLOCKED: pre-push-reviewフラグファイルの手動作成は禁止されています" >&2
  echo "  WHY: /pre-push-review スキルを実行せずにPR作成ガードをバイパスするのを防止" >&2
  echo "  FIX: /pre-push-review を実行してください。スキルが完了時にフラグを自動作成します" >&2
  exit 2
fi


# --- 破壊的コマンドガード ---
if [[ "$COMMAND" =~ rm[[:space:]]+-[[:alpha:]]*r[[:alpha:]]*f ]] || [[ "$COMMAND" =~ rm[[:space:]]+-[[:alpha:]]*f[[:alpha:]]*r ]] || [[ "$COMMAND" =~ rm[[:space:]]+--recursive[[:space:]]+--force ]] || [[ "$COMMAND" =~ rm[[:space:]]+--force[[:space:]]+--recursive ]] || [[ "$COMMAND" =~ rm[[:space:]]+-r[[:space:]]+-f ]] || [[ "$COMMAND" =~ rm[[:space:]]+-f[[:space:]]+-r ]]; then
  SAFE_DIRS="node_modules|target|dist|\.next|build|__pycache__|\.pytest_cache"
  ALL_SAFE=true
  for arg in $COMMAND; do
    case "$arg" in
      rm|-*) continue ;;
    esac
    arg_base=$(basename "$arg" 2>/dev/null) || arg_base="$arg"
    if ! [[ "$arg_base" =~ ^(${SAFE_DIRS})$ ]]; then
      ALL_SAFE=false
      break
    fi
  done
  if ! $ALL_SAFE; then
    echo "BLOCKED: rm -rf は危険なコマンドです" >&2
    echo "  WHY: エージェントが意図せず重要ファイルを削除するインシデントを防止" >&2
    echo "  FIX: ビルドキャッシュ削除なら rm -rf node_modules / rm -rf dist を使用" >&2
    exit 2
  fi
fi

if [[ "$COMMAND" =~ git[[:space:]]+reset[[:space:]]+--hard ]]; then
  echo "BLOCKED: git reset --hard は作業ツリーの全変更を破棄する危険なコマンドです" >&2
  exit 2
fi

if [[ "$COMMAND" =~ git[[:space:]]+clean[[:space:]]+-[[:alpha:]]*f ]]; then
  echo "BLOCKED: git clean -f は未追跡ファイルを削除する危険なコマンドです" >&2
  exit 2
fi

if [[ "$COMMAND" =~ git[[:space:]]+checkout[[:space:]]+--[[:space:]]+\. ]]; then
  echo "BLOCKED: git checkout -- . は作業ツリーの全変更を破棄する危険なコマンドです" >&2
  exit 2
fi

if [[ "$COMMAND" =~ git[[:space:]]+(.+[[:space:]]+)?push[[:space:]]+.*--force ]] || [[ "$COMMAND" =~ git[[:space:]]+(.+[[:space:]]+)?push[[:space:]]+.*-f([[:space:]]|$) ]]; then
  if ! [[ "$COMMAND" =~ --force-with-lease ]]; then
    echo "BLOCKED: git push --force は危険なコマンドです。--force-with-lease を使用してください" >&2
    exit 2
  fi
fi

if [[ "$COMMAND" =~ git[[:space:]]+.+--no-verify ]]; then
  echo "BLOCKED: --no-verify によるgit hookのバイパスは禁止されています" >&2
  exit 2
fi

if [[ "$COMMAND" =~ git[[:space:]]+.+-n([[:space:]]|$) ]]; then
  if [[ "$COMMAND" =~ git[[:space:]]+push ]] || [[ "$COMMAND" =~ git[[:space:]]+.*push ]]; then
    : # git push -n はdry-run、許可
  else
    echo "BLOCKED: -n（--no-verify短縮形）によるgit hookのバイパスは禁止されています" >&2
    exit 2
  fi
fi

if [[ "$COMMAND" =~ chmod[[:space:]]+777 ]]; then
  echo "BLOCKED: chmod 777 は過度な権限付与です" >&2
  exit 2
fi

if [[ "$COMMAND" =~ \>[[:space:]]*/dev/sd ]] || [[ "$COMMAND" =~ \>[[:space:]]*/dev/nvme ]] || [[ "$COMMAND" =~ \>[[:space:]]*/dev/hd ]]; then
  echo "BLOCKED: デバイスファイルへの直接書き込みは禁止されています" >&2
  exit 2
fi

# --- git push ガード: ソースコード変更時のCIチェック ---
if [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]]+(.+[[:space:]]+)?push([[:space:]]|$) ]]; then
  PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  LOG=""

  CHANGED_FILES=$(git diff --name-only origin/main...HEAD 2>/dev/null) || CHANGED_FILES=""
  HAS_SOURCE_CHANGES=$(echo "$CHANGED_FILES" | grep -qE '(^biome\.json$|^package\.json$|\.(ts|tsx|js|jsx|json|css)$)' && echo "1" || echo "0")

  if [ "$HAS_SOURCE_CHANGES" = "1" ]; then
    LOG="${LOG}pre-bash-guard: ソースコードに変更あり。biome・型チェックを実行します...\n"

    LOG="${LOG}pre-bash-guard: biome check を実行中...\n"
    if ! CMD_OUTPUT=$(cd "$PROJECT_ROOT" && npx biome check . 2>&1); then
      echo "$CMD_OUTPUT" >&2
      echo "BLOCKED: biome check が失敗しました。'pnpm format'を実行してからpushしてください" >&2
      exit 2
    fi

    LOG="${LOG}pre-bash-guard: tsc --noEmit を実行中...\n"
    if ! CMD_OUTPUT=$(cd "$PROJECT_ROOT" && npx tsc --noEmit 2>&1); then
      echo "$CMD_OUTPUT" >&2
      echo "BLOCKED: 型チェックが失敗しました。型エラーを修正してからpushしてください" >&2
      exit 2
    fi

    LOG="${LOG}pre-bash-guard: 全チェック成功\n"
  else
    LOG="${LOG}pre-bash-guard: ソースコード変更なし。チェックをスキップします\n"
  fi

  LOG="${LOG}pre-bash-guard: 全てのチェックが成功しました"

  jq -n --arg reason "$LOG" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "permissionDecisionReason": $reason
    }
  }'
  exit 0
fi

# --- gh pr create ガード: pre-push-review 実行済み確認 ---
if [[ "$COMMAND" =~ ^[[:space:]]*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$) ]]; then
  FLAG_FILE="$(git rev-parse --git-dir)/claude-pre-push-review-done"

  if [ -f "$FLAG_FILE" ]; then
    if find "$FLAG_FILE" -mmin -30 | grep -q .; then
      rm -f "$FLAG_FILE"
      exit 0
    fi
  fi

  echo "BLOCKED: PR作成前に /pre-push-review を実行してください（CLAUDE.mdルール）" >&2
  exit 2
fi

# --- resolveReviewThread ガード ---
if [[ "$COMMAND" =~ resolveReviewThread ]]; then
  echo "BLOCKED: resolveReviewThreadの実行は禁止されています。レビューコメントの解決はユーザーが手動で行ってください" >&2
  exit 2
fi

# --- CodeRabbit返信ガード ---
if [[ "$COMMAND" =~ gh[[:space:]]+api.*replies.*-f[[:space:]]+body= ]] || [[ "$COMMAND" =~ /replies.sh ]]; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
  MARKER="$PROJECT_DIR/.claude/push-completed.marker"
  if [ ! -f "$MARKER" ]; then
    echo "BLOCKED: push完了前にCodeRabbit返信はできません" >&2
    exit 2
  fi
  MARKER_MTIME=$(stat -c %Y "$MARKER" 2>/dev/null || stat -f %m "$MARKER" 2>/dev/null) || {
    echo "BLOCKED: pushマーカーの読み取りに失敗しました" >&2
    exit 2
  }
  MARKER_AGE=$(( $(date +%s) - MARKER_MTIME ))
  if [ "$MARKER_AGE" -gt 60 ]; then
    echo "BLOCKED: pushマーカーが古くなっています（${MARKER_AGE}秒前）。git pushを再実行してください" >&2
    exit 2
  fi
  MARKER_HEAD=$(head -1 "$MARKER" 2>/dev/null) || MARKER_HEAD=""
  CURRENT_HEAD=$(git rev-parse HEAD 2>/dev/null) || CURRENT_HEAD=""
  if [ -n "$CURRENT_HEAD" ] && [ "$MARKER_HEAD" != "$CURRENT_HEAD" ]; then
    echo "BLOCKED: push後に新しいコミットがあります。git pushしてから返信してください" >&2
    exit 2
  fi

  if [[ "$COMMAND" =~ (次回|今後|後日|将来的に|検討します|改善予定|後で対応|いずれ対応|追って対応) ]]; then
    echo "BLOCKED: PRコメント返信に先送り表現が含まれています" >&2
    exit 2
  fi
fi

exit 0
