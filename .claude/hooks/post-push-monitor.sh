#!/bin/bash
set -eo pipefail

# PostToolUse: git push / gh pr create 成功後にCI・CodeRabbit監視を起動する
# 監視ロジック自体は check-ci-coderabbit.sh に集約し、このスクリプトは起動指示のみ

# stdinからツール入力JSONを読み取り、コマンドを抽出（パース失敗時はスキップ）
STDIN_INPUT=$(cat)
COMMAND=$(echo "$STDIN_INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0

# コマンド種別を判定
IS_GIT_PUSH=false
IS_GH_PR_CREATE=false

# git push の検出（git stash push 等の誤検出を防ぐ）
if [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]]+(.+[[:space:]]+)?push([[:space:]]|$) ]] && ! [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]]+(stash|submodule)[[:space:]] ]]; then
  IS_GIT_PUSH=true
fi

# gh pr create の検出（gh -R owner/repo pr create 等、オプションが間に入るケースにも対応）
if [[ "$COMMAND" =~ ^[[:space:]]*gh[[:space:]]+(.+[[:space:]]+)?pr[[:space:]]+create([[:space:]]|$) ]]; then
  IS_GH_PR_CREATE=true
fi

# どちらにも該当しない場合はスキップ
if ! $IS_GIT_PUSH && ! $IS_GH_PR_CREATE; then
  exit 0
fi

# -------------------------------------------------------------------
# 共通: push/PR作成時刻を記録（CodeRabbit新規指摘の判定基準）
# -------------------------------------------------------------------
PUSH_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
CHECK_SCRIPT="$PROJECT_DIR/.claude/hooks/check-ci-coderabbit.sh"

# -------------------------------------------------------------------
# git push 成功時: 返信ガード用マーカーファイルを作成
# CodeRabbit返信はpush完了後にのみ許可するため、push成功の証跡を残す
# -------------------------------------------------------------------
if $IS_GIT_PUSH; then
  # dry-run（-n/--dry-run）は実際にpushしないためマーカー作成をスキップ
  if ! [[ "$COMMAND" =~ (^|[[:space:]])(-n|--dry-run)([[:space:]]|$) ]]; then
    # マーカーにpush時のHEAD commit SHAを記録（push完了の証跡+SHA一致検証用）
    git rev-parse HEAD > "$PROJECT_DIR/.claude/push-completed.marker"
  fi
fi

# -------------------------------------------------------------------
# git push / gh pr create 共通の監視指示
# -------------------------------------------------------------------
CONTEXT=""

if $IS_GIT_PUSH; then
  CONTEXT="[CI・CodeRabbit監視 - push後]\n"
elif $IS_GH_PR_CREATE; then
  PR_NUMBER=$(gh pr view --json number -q '.number' 2>/dev/null) || true
  CONTEXT="[CI・CodeRabbit監視 - PR #${PR_NUMBER:-?} 作成後]\n"
fi

# 監視スクリプトで初回チェックを即実行し、現在の状態を報告
INITIAL_CHECK=$("$CHECK_SCRIPT" 2>/dev/null) || INITIAL_CHECK='{"status":"error","action":"stop_monitoring_failure"}'
INITIAL_STATUS=$(echo "$INITIAL_CHECK" | jq -r '.status' 2>/dev/null) || INITIAL_STATUS="error"

CONTEXT="${CONTEXT}初回チェック結果: ${INITIAL_STATUS}\n\n"

# 監視指示: Claudeへの指示はシンプルに。判断はスクリプトが行う
CONTEXT="${CONTEXT}[アクション]\n"
CONTEXT="${CONTEXT}CronCreateで1分間隔の監視ジョブを起動すること（既に同PRの監視ジョブがある場合は不要）。\n"
CONTEXT="${CONTEXT}prompt: bash ${CHECK_SCRIPT}\n\n"
CONTEXT="${CONTEXT}[監視結果の読み方]\n"
CONTEXT="${CONTEXT}スクリプトはJSON形式で結果を返す。actionフィールドに従って行動すること:\n"
CONTEXT="${CONTEXT}- continue_monitoring → 何もせず次回チェックを待つ\n"
CONTEXT="${CONTEXT}- stop_monitoring_success → CronDeleteで監視停止。「CI・CodeRabbit共に成功、新規指摘・未解決コメントなし」と報告\n"
CONTEXT="${CONTEXT}- stop_monitoring_failure → CronDeleteで監視停止。ci.details や coderabbit.status をユーザーに報告\n"
CONTEXT="${CONTEXT}- run_check_coderabbit → CronDeleteで監視停止。coderabbit.new_comments（新規指摘）と coderabbit.unresolved（未解決スレッド）を確認。/check-coderabbit で詳細を確認し、対応方針をまとめてユーザーに判断を仰ぐこと（勝手に修正しない）\n\n"
CONTEXT="${CONTEXT}[対応完了後の返信ルール]\n"
CONTEXT="${CONTEXT}CodeRabbitの全コメントに必ず返信すること（対応済み・対応不要の両方。resolveはしない）。\n"
CONTEXT="${CONTEXT}返信は必ずpush後に行うこと（修正コミット→push→返信の順。push前に返信するとCodeRabbitが修正を確認できない）。"

# JSON出力でClaudeのコンテキストに監視指示を追加
jq -n --arg ctx "$CONTEXT" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $ctx
  }
}'
exit 0
