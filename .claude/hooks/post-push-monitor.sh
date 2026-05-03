#!/bin/bash
set -eo pipefail

# PostToolUse: git push / gh pr create 成功後にCI・CodeRabbit監視を起動する
# 監視ロジック自体は check-ci-coderabbit.sh に集約し、このスクリプトは起動指示のみ

STDIN_INPUT=$(cat)
COMMAND=$(echo "$STDIN_INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0

IS_GIT_PUSH=false
IS_GH_PR_CREATE=false

if [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]]+(.+[[:space:]]+)?push([[:space:]]|$) ]] && ! [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]]+(stash|submodule)[[:space:]] ]]; then
  IS_GIT_PUSH=true
  if [[ "$COMMAND" =~ (^|[[:space:]])(-n|--dry-run)([[:space:]]|$) ]]; then
    exit 0
  fi
fi

if [[ "$COMMAND" =~ ^[[:space:]]*gh[[:space:]]+(.+[[:space:]]+)?pr[[:space:]]+create([[:space:]]|$) ]]; then
  IS_GH_PR_CREATE=true
fi

if ! $IS_GIT_PUSH && ! $IS_GH_PR_CREATE; then
  exit 0
fi

PUSH_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# 現ブランチから flow の WORK_ID を導出
FLOW_BRANCH=$(git branch --show-current 2>/dev/null) || FLOW_BRANCH=""
FLOW_WORK_ID=""
if [[ "$FLOW_BRANCH" =~ ^(feature|fix|chore)/issue-([0-9]+)/.+$ ]]; then
  FLOW_WORK_ID="issue-${BASH_REMATCH[2]}"
elif [[ "$FLOW_BRANCH" =~ ^(feature|fix|chore)/(.+)$ ]]; then
  FLOW_SLUG="${BASH_REMATCH[2]}"
  if [[ "$FLOW_SLUG" =~ ^[a-z0-9-]+$ ]]; then
    FLOW_WORK_ID="$FLOW_SLUG"
  fi
fi

FLOW_CAN_RESUME=false
FLOW_RESUME_CMD=""
if [ -n "$FLOW_WORK_ID" ] && [ -e "$PROJECT_DIR/.claude/lib/state-io.sh" ]; then
  source "$PROJECT_DIR/.claude/lib/state-io.sh"
  FLOW_SCOPE_KEY=$(flow_state_scope_key "$FLOW_WORK_ID" 2>/dev/null) || FLOW_SCOPE_KEY=""
  if [ -n "$FLOW_SCOPE_KEY" ] && flow_state_exists "$FLOW_SCOPE_KEY" 2>/dev/null; then
    FLOW_CAN_RESUME=true
    FLOW_CURRENT_PHASE=$(flow_state_read progress '.phase' "$FLOW_SCOPE_KEY" 2>/dev/null) || FLOW_CURRENT_PHASE="P7"
    if [[ "$FLOW_WORK_ID" =~ ^issue-([0-9]+)$ ]]; then
      FLOW_RESUME_ARG="#${BASH_REMATCH[1]}"
    else
      FLOW_RESUME_ARG="$FLOW_WORK_ID"
    fi
    FLOW_RESUME_CMD="/flow ${FLOW_RESUME_ARG} --resume --from ${FLOW_CURRENT_PHASE}"
  fi
fi
CHECK_SCRIPT="$PROJECT_DIR/.claude/hooks/check-ci-coderabbit.sh"

if $IS_GIT_PUSH; then
  UNRESOLVED_CONTEXT=""
  git rev-parse HEAD > "$PROJECT_DIR/.claude/push-completed.marker"

  source "$PROJECT_DIR/.claude/hooks/fetch-unresolved-threads.sh"
  fetch_unresolved_threads

  if [[ "$UNRESOLVED_THREADS_ERROR" == "true" ]]; then
    UNRESOLVED_CONTEXT="[CodeRabbit未解決スレッド: 取得失敗]\n"
    if $FLOW_CAN_RESUME; then
      UNRESOLVED_CONTEXT="${UNRESOLVED_CONTEXT}未解決スレッドの取得に失敗しました。${FLOW_RESUME_CMD} で再確認してください。\n\n"
    else
      UNRESOLVED_CONTEXT="${UNRESOLVED_CONTEXT}未解決スレッドの取得に失敗しました。通常運用としてユーザーに対応方針を確認してください。\n\n"
    fi
  elif [[ "$UNRESOLVED_THREADS_COUNT" -gt 0 ]]; then
    PUSH_UNRESOLVED_LIST=$(printf '%s\n' "$UNRESOLVED_THREADS_JSON" | jq -r '
      [.[] | "- " + (.path // "(no path)") + (if .line == null then "" else ":" + (.line | tostring) end) + " — " + ((.body // "") | split("\n")[0] | .[0:120])]
      | join("\n")
    ' 2>/dev/null) || PUSH_UNRESOLVED_LIST=""

    UNRESOLVED_CONTEXT="[CodeRabbit未解決スレッド: ${UNRESOLVED_THREADS_COUNT}件]\n"
    UNRESOLVED_CONTEXT="${UNRESOLVED_CONTEXT}以下のスレッドが未解決です。修正コミットを送信した場合は、各スレッドへの返信を忘れないでください。\n"
    UNRESOLVED_CONTEXT="${UNRESOLVED_CONTEXT}${PUSH_UNRESOLVED_LIST}\n\n"
  fi
fi

CONTEXT=""

if $IS_GIT_PUSH; then
  CONTEXT="[CI・CodeRabbit監視 - push後]\n"
  CONTEXT="${CONTEXT}${UNRESOLVED_CONTEXT}"
elif $IS_GH_PR_CREATE; then
  PR_NUMBER=$(gh pr view --json number -q '.number' 2>/dev/null) || true
  CONTEXT="[CI・CodeRabbit監視 - PR #${PR_NUMBER:-?} 作成後]\n"
fi

INITIAL_CHECK=$("$CHECK_SCRIPT" 2>/dev/null) || INITIAL_CHECK='{"status":"error","action":"stop_monitoring_failure"}'
INITIAL_STATUS=$(echo "$INITIAL_CHECK" | jq -r '.status' 2>/dev/null) || INITIAL_STATUS="error"

CONTEXT="${CONTEXT}初回チェック結果: ${INITIAL_STATUS}\n\n"

CONTEXT="${CONTEXT}[アクション]\n"
CONTEXT="${CONTEXT}CronCreateで1分間隔の監視ジョブを起動すること（既に同PRの監視ジョブがある場合は不要）。\n"
CONTEXT="${CONTEXT}prompt: bash ${CHECK_SCRIPT}\n\n"
CONTEXT="${CONTEXT}[監視結果の読み方]\n"
CONTEXT="${CONTEXT}スクリプトはJSON形式で結果を返す。actionフィールドに従って行動すること:\n"
CONTEXT="${CONTEXT}- continue_monitoring → 何もせず次回チェックを待つ\n"
CONTEXT="${CONTEXT}- stop_monitoring_success → CronDeleteで監視停止。「CI・CodeRabbit共に成功、新規指摘・未解決コメントなし」と報告\n"
CONTEXT="${CONTEXT}- stop_monitoring_failure → CronDeleteで監視停止。ci.details や coderabbit.status をユーザーに報告\n"
if $FLOW_CAN_RESUME; then
  CONTEXT="${CONTEXT}- run_check_coderabbit → CronDeleteで監視停止。\`${FLOW_RESUME_CMD}\` を自動起動する（mainブランチでは起動しない、未コミット変更がある場合は人に通知して停止）。flow が自律分類・修正・本体送信・返信を最大5回ループし、マージ直前のみユーザー判断を仰ぐ\n\n"
else
  CONTEXT="${CONTEXT}- run_check_coderabbit → CronDeleteで監視停止。通常運用としてユーザーに対応方針を確認する\n\n"
fi
CONTEXT="${CONTEXT}[対応完了後の返信ルール]\n"
CONTEXT="${CONTEXT}CodeRabbitの全コメントに必ず返信すること（対応済み・対応不要の両方。resolveはしない）。\n"
CONTEXT="${CONTEXT}返信は必ず送信完了後に行うこと（修正コミット→送信→返信の順。送信前に返信するとCodeRabbitが修正を確認できない）。"

jq -n --arg ctx "$CONTEXT" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $ctx
  }
}'
exit 0
