#!/usr/bin/env bash
# .claude/lib/deploy-watch.sh
# flow P12: ark の **ローカル pm2 デプロイ** を実行・監視するヘルパー。
#
# ark には GitHub Actions の deploy workflow が無く、main ブランチを pull した後に
# `pkill -f ttyd && pnpm build && pm2 restart claude-code-ark` で再起動する運用 (CLAUDE.md 参照)。
# 本ヘルパーは P11 のマージ完了後に呼ばれ、以下を行う:
#
#   1. deploy 対象パス変更を検出 (server/, client/, shared/, ecosystem.config.cjs, package.json)
#      → 変更が無ければ no-target finalize
#   2. pm2 で claude-code-ark プロセスが稼働しているかを判定
#      → 稼働していなければ "pnpm dev で動いている" とみなして no-target finalize
#   3. 稼働している場合は `pkill -f ttyd && pnpm build && pm2 restart claude-code-ark` を実行
#   4. 30 秒間隔で最大 5 回、health check (HTTP 200 on http://localhost:<PORT>/) を実施
#      → 成功で success、5 回連続失敗で failure、build/restart 失敗で failure
#
# 利用想定:
#   source "$CLAUDE_PROJECT_DIR/.claude/lib/deploy-watch.sh"
#   deploy_watch_init "$SCOPE_KEY" "$MERGE_SHA"
#   deploy_watch_tick "$SCOPE_KEY"
#   # → DEPLOY_WATCH_RESULT に success / failure / timeout / continue / no-target / poll-error を設定
#
# 設計判断:
#   - cron による定期発火は呼び出し側 (Claude tool: CronCreate / CronDelete) が担い、
#     本スクリプトは pure な関数群を提供する
#   - state は flow の context.deploy_watch に格納し、scope_key 単位で隔離
#   - terminal 状態 (success / failure / timeout / no-target / poll-error) になったら
#     呼び出し側で CronDelete + 通知を行う

set -euo pipefail

# === 内部設定 ===

# ark の pm2 プロセス名 (ecosystem.config.cjs に従う)
DEPLOY_WATCH_PM2_APP=${DEPLOY_WATCH_PM2_APP:-claude-code-ark}

# health check に使うエンドポイント。Express の `/api/settings` は GET で必ず JSON を返すので
# health 代替として使う。`/` だとクライアント SPA を返すため build 失敗を検知しにくい
DEPLOY_WATCH_HEALTH_URL=${DEPLOY_WATCH_HEALTH_URL:-http://localhost:4001/api/settings}

# deploy 対象とする path glob (改行区切り)。
# 1 つでも変更ファイルにマッチすれば deploy 対象とみなす。
_DEPLOY_WATCH_PATHS=(
  "server/**"
  "client/**"
  "shared/**"
  "ecosystem.config.cjs"
  "package.json"
  "pnpm-lock.yaml"
  "vite.config.ts"
  "biome.json"
  "tsconfig.json"
  "tsconfig.server.json"
  "tsconfig.client.json"
)

DEPLOY_WATCH_MAX_FIRES=${DEPLOY_WATCH_MAX_FIRES:-5}                  # 30 秒 × 5 = 2.5 分
DEPLOY_WATCH_TICK_INTERVAL=${DEPLOY_WATCH_TICK_INTERVAL:-30}         # 30 秒間隔
DEPLOY_WATCH_MAX_POLL_FAILURES=${DEPLOY_WATCH_MAX_POLL_FAILURES:-5}
DEPLOY_WATCH_MAX_WALL_SECONDS=${DEPLOY_WATCH_MAX_WALL_SECONDS:-180}  # 3 分

# === 内部ヘルパー ===

_deploy_watch_load_state_io() {
  if ! declare -F flow_state_read >/dev/null 2>&1; then
    local root
    root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
    # shellcheck source=/dev/null
    source "$root/.claude/lib/state-io.sh"
  fi
}

# pm2 で claude-code-ark プロセスが online か判定。
# 戻り値: 0=online, 1=not running / not pm2 / pm2 not installed
_deploy_watch_pm2_online() {
  command -v pm2 >/dev/null 2>&1 || return 1
  local status
  status=$(pm2 jlist 2>/dev/null \
    | jq -r --arg name "$DEPLOY_WATCH_PM2_APP" '.[] | select(.name == $name) | .pm2_env.status' 2>/dev/null) || return 1
  [ "$status" = "online" ]
}

# git diff の path 一覧と path glob のマッチを判定。
_deploy_watch_glob_matches() {
  local paths="$1"
  local glob="$2"
  local p
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$glob" in
      *'**'*)
        local prefix="${glob%%\*\**}"
        case "$p" in
          "$prefix"*) return 0 ;;
        esac
        ;;
      *)
        if [ "$p" = "$glob" ]; then
          return 0
        fi
        ;;
    esac
  done <<<"$paths"
  return 1
}

# === 公開関数 ===

# merge commit の差分が deploy 対象 path を含むか判定。
# 引数: $1 merge_sha
# 戻り値: 0=対象あり, 1=対象なし
deploy_watch_has_target() {
  local merge_sha="$1"
  if [ -z "$merge_sha" ]; then
    return 1
  fi
  local changed_paths
  changed_paths=$(git show --pretty=format: --name-only "$merge_sha" 2>/dev/null | awk 'NF') || return 1
  [ -z "$changed_paths" ] && return 1

  local glob
  for glob in "${_DEPLOY_WATCH_PATHS[@]}"; do
    if _deploy_watch_glob_matches "$changed_paths" "$glob"; then
      return 0
    fi
  done
  return 1
}

# context.deploy_watch を初期化する。
# 引数: $1 scope_key, $2 merge_sha
deploy_watch_init() {
  local scope_key="$1"
  local merge_sha="$2"
  if [ -z "$scope_key" ] || [ -z "$merge_sha" ]; then
    echo "ERROR: scope_key と merge_sha が必要です" >&2
    return 1
  fi
  _deploy_watch_load_state_io

  local has_target=false
  if deploy_watch_has_target "$merge_sha"; then
    has_target=true
  fi

  local pm2_online=false
  if _deploy_watch_pm2_online; then
    pm2_online=true
  fi

  local now
  now=$(date +%s)

  flow_state_update context \
    ".deploy_watch = {
       merge_sha: \"$merge_sha\",
       has_target: $has_target,
       pm2_online: $pm2_online,
       pm2_app: \"$DEPLOY_WATCH_PM2_APP\",
       health_url: \"$DEPLOY_WATCH_HEALTH_URL\",
       fires: 0,
       max_fires: $DEPLOY_WATCH_MAX_FIRES,
       tick_interval: $DEPLOY_WATCH_TICK_INTERVAL,
       poll_failures: 0,
       max_poll_failures: $DEPLOY_WATCH_MAX_POLL_FAILURES,
       max_wall_seconds: $DEPLOY_WATCH_MAX_WALL_SECONDS,
       started_at: $now,
       cron_id: null,
       result: null,
       last_detail: null,
       deploy_started_at: null,
       deploy_completed_at: null
     }" "$scope_key"
}

# cron job ID を保存。
deploy_watch_set_cron_id() {
  local scope_key="$1"
  local cron_id="$2"
  _deploy_watch_load_state_io
  flow_state_update context ".deploy_watch.cron_id = \"$cron_id\"" "$scope_key"
}

# main worktree で `pkill -f ttyd && pnpm build && pm2 restart claude-code-ark` を実行する。
# 戻り値: 0=成功, 1=失敗 (build / restart いずれか)
# 出力: stdout/stderr に build / restart のログを残す
# 副作用: context.deploy_watch.deploy_started_at / deploy_completed_at を更新
deploy_watch_run_pm2_deploy() {
  local scope_key="$1"
  _deploy_watch_load_state_io
  local main_root
  main_root=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
    echo "ERROR: main worktree 解決に失敗" >&2
    return 1
  }
  main_root="${main_root%/.git}"

  local started_at
  started_at=$(date +%s)
  flow_state_update context ".deploy_watch.deploy_started_at = $started_at" "$scope_key"

  echo "[deploy-watch] pkill -f ttyd"
  pkill -f ttyd || true  # ttyd プロセス無しは正常

  echo "[deploy-watch] cd $main_root && pnpm build"
  if ! (cd "$main_root" && pnpm build 2>&1); then
    echo "ERROR: pnpm build に失敗しました" >&2
    return 1
  fi

  echo "[deploy-watch] pm2 restart $DEPLOY_WATCH_PM2_APP"
  if ! pm2 restart "$DEPLOY_WATCH_PM2_APP" 2>&1; then
    echo "ERROR: pm2 restart に失敗しました" >&2
    return 1
  fi

  local completed_at
  completed_at=$(date +%s)
  flow_state_update context ".deploy_watch.deploy_completed_at = $completed_at" "$scope_key"
  return 0
}

# 1 fire 分の health check を行う。
# 引数: $1 scope_key
# 出力 (環境変数):
#   DEPLOY_WATCH_RESULT - success / failure / timeout / continue / no-target / poll-error
#   DEPLOY_WATCH_DETAIL - 通知用の jq -c JSON
#   DEPLOY_WATCH_CRON_ID - 削除すべき cron ID (terminal 時のみ)
#
# stdout には人間可読のサマリと最終行 `RESULT=<value> CRON_ID=<id> FIRES=<n>` を出す。
deploy_watch_tick() {
  local scope_key="$1"
  if [ -z "$scope_key" ]; then
    echo "ERROR: scope_key が必要です" >&2
    return 1
  fi
  _deploy_watch_load_state_io

  local merge_sha has_target pm2_online health_url fires max_fires cron_id
  merge_sha=$(flow_state_read context '.deploy_watch.merge_sha' "$scope_key")
  has_target=$(flow_state_read context '.deploy_watch.has_target' "$scope_key")
  pm2_online=$(flow_state_read context '.deploy_watch.pm2_online' "$scope_key")
  health_url=$(flow_state_read context '.deploy_watch.health_url' "$scope_key")
  fires=$(flow_state_read context '.deploy_watch.fires' "$scope_key")
  max_fires=$(flow_state_read context '.deploy_watch.max_fires' "$scope_key")
  cron_id=$(flow_state_read context '.deploy_watch.cron_id' "$scope_key")

  if [ -z "$merge_sha" ] || [ "$merge_sha" = "null" ]; then
    echo "ERROR: deploy_watch が未初期化です: $scope_key" >&2
    return 1
  fi

  DEPLOY_WATCH_CRON_ID="$cron_id"

  # has_target=false → no-target finalize
  if [ "$has_target" != "true" ]; then
    fires=$((fires + 1))
    flow_state_update context ".deploy_watch.fires = $fires | .deploy_watch.result = \"no-target\"" "$scope_key"
    DEPLOY_WATCH_RESULT="no-target"
    DEPLOY_WATCH_DETAIL='{"reason":"merge commit に deploy 対象 path への変更が無い"}'
    printf '[deploy-watch] no-target: server/ client/ shared/ 等を含まない (merge_sha=%s)\n' "$merge_sha"
    printf 'RESULT=no-target CRON_ID=%s FIRES=%s\n' "${cron_id:-null}" "$fires"
    return 0
  fi

  # pm2 で動いていない → no-target (pnpm dev 想定、デプロイは不要)
  if [ "$pm2_online" != "true" ]; then
    fires=$((fires + 1))
    flow_state_update context ".deploy_watch.fires = $fires | .deploy_watch.result = \"no-target\"" "$scope_key"
    DEPLOY_WATCH_RESULT="no-target"
    DEPLOY_WATCH_DETAIL='{"reason":"pm2 で claude-code-ark が稼働していない (pnpm dev 想定)"}'
    printf '[deploy-watch] no-target: pm2 で %s が稼働していない (merge_sha=%s)\n' "$DEPLOY_WATCH_PM2_APP" "$merge_sha"
    printf 'RESULT=no-target CRON_ID=%s FIRES=%s\n' "${cron_id:-null}" "$fires"
    return 0
  fi

  # 初回 fire (fires=0) → pm2 deploy を実行
  local started_at max_wall_seconds now elapsed
  started_at=$(flow_state_read context '.deploy_watch.started_at' "$scope_key")
  max_wall_seconds=$(flow_state_read context '.deploy_watch.max_wall_seconds' "$scope_key")
  now=$(date +%s)
  elapsed=$((now - started_at))

  local deploy_completed_at
  deploy_completed_at=$(flow_state_read context '.deploy_watch.deploy_completed_at' "$scope_key")
  if [ "$deploy_completed_at" = "null" ] || [ -z "$deploy_completed_at" ]; then
    echo "[deploy-watch] 初回 tick: pkill ttyd → pnpm build → pm2 restart 実行"
    if ! deploy_watch_run_pm2_deploy "$scope_key"; then
      DEPLOY_WATCH_RESULT="failure"
      DEPLOY_WATCH_DETAIL='{"reason":"pnpm build または pm2 restart 失敗"}'
      flow_state_update context '.deploy_watch.result = "failure"' "$scope_key"
      printf '[deploy-watch] FAILURE: build/restart 失敗\n'
      printf 'RESULT=failure CRON_ID=%s FIRES=%s\n' "${cron_id:-null}" "$fires"
      return 0
    fi
  fi

  # health check
  local http_code
  http_code=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$health_url" 2>/dev/null) || http_code="000"

  if [ "$http_code" = "200" ]; then
    fires=$((fires + 1))
    flow_state_update context \
      ".deploy_watch.fires = $fires | .deploy_watch.result = \"success\" | .deploy_watch.last_detail = {\"http_code\": \"$http_code\", \"health_url\": \"$health_url\"}" \
      "$scope_key"
    DEPLOY_WATCH_RESULT="success"
    DEPLOY_WATCH_DETAIL=$(jq -c -n --arg url "$health_url" --arg code "$http_code" \
      '{health_url: $url, http_code: $code}')
    printf '[deploy-watch] SUCCESS: health %s = %s\n' "$health_url" "$http_code"
    printf 'RESULT=success CRON_ID=%s FIRES=%s\n' "${cron_id:-null}" "$fires"
    return 0
  fi

  # health check 失敗 → poll_failures をインクリメント
  local poll_failures max_poll_failures
  poll_failures=$(flow_state_read context '.deploy_watch.poll_failures' "$scope_key")
  max_poll_failures=$(flow_state_read context '.deploy_watch.max_poll_failures' "$scope_key")
  poll_failures=$((poll_failures + 1))
  fires=$((fires + 1))
  flow_state_update context \
    ".deploy_watch.fires = $fires | .deploy_watch.poll_failures = $poll_failures | .deploy_watch.last_detail = {\"http_code\": \"$http_code\", \"health_url\": \"$health_url\"}" \
    "$scope_key"

  DEPLOY_WATCH_DETAIL=$(jq -c -n --arg url "$health_url" --arg code "$http_code" --argjson n "$poll_failures" \
    '{health_url: $url, http_code: $code, poll_failures: $n}')

  if [ "$poll_failures" -ge "$max_poll_failures" ]; then
    DEPLOY_WATCH_RESULT="failure"
    flow_state_update context '.deploy_watch.result = "failure"' "$scope_key"
    printf '[deploy-watch] FAILURE: health %s が %s 回連続失敗 (last code=%s)\n' "$health_url" "$poll_failures" "$http_code"
    printf 'RESULT=failure CRON_ID=%s FIRES=%s\n' "${cron_id:-null}" "$fires"
    return 0
  fi

  if [ "$fires" -ge "$max_fires" ] || [ "$elapsed" -ge "$max_wall_seconds" ]; then
    DEPLOY_WATCH_RESULT="timeout"
    flow_state_update context '.deploy_watch.result = "timeout"' "$scope_key"
    printf '[deploy-watch] TIMEOUT (fires=%s/%s, elapsed=%ss/%ss): http=%s\n' \
      "$fires" "$max_fires" "$elapsed" "$max_wall_seconds" "$http_code"
    printf 'RESULT=timeout CRON_ID=%s FIRES=%s\n' "${cron_id:-null}" "$fires"
    return 0
  fi

  DEPLOY_WATCH_RESULT="continue"
  printf '[deploy-watch] continue (fires=%s/%s, http=%s, poll_failures=%s/%s)\n' \
    "$fires" "$max_fires" "$http_code" "$poll_failures" "$max_poll_failures"
  printf 'RESULT=continue CRON_ID=%s FIRES=%s\n' "${cron_id:-null}" "$fires"
  return 0
}

# 通知用 markdown 要約を生成する。
deploy_watch_format_summary() {
  local scope_key="$1"
  _deploy_watch_load_state_io
  local result merge_sha fires max_fires has_target pm2_online last_detail health_url
  result=$(flow_state_read context '.deploy_watch.result' "$scope_key")
  merge_sha=$(flow_state_read context '.deploy_watch.merge_sha' "$scope_key")
  fires=$(flow_state_read context '.deploy_watch.fires' "$scope_key")
  max_fires=$(flow_state_read context '.deploy_watch.max_fires' "$scope_key")
  has_target=$(flow_state_read context '.deploy_watch.has_target' "$scope_key")
  pm2_online=$(flow_state_read context '.deploy_watch.pm2_online' "$scope_key")
  health_url=$(flow_state_read context '.deploy_watch.health_url' "$scope_key")
  last_detail=$(flow_state_read context '.deploy_watch.last_detail' "$scope_key")

  local elapsed_sec
  elapsed_sec=$((fires * DEPLOY_WATCH_TICK_INTERVAL))

  cat <<EOF
## flow deploy 監視レポート (ark / pm2)

- 結果: **${result:-unknown}**
- merge SHA: ${merge_sha}
- pm2 process: ${DEPLOY_WATCH_PM2_APP} (online=${pm2_online})
- health URL: ${health_url}
- 経過: ${elapsed_sec} 秒 (${fires}/${max_fires} fire)
- has_target: ${has_target}
EOF

  if [ -n "$last_detail" ] && [ "$last_detail" != "null" ]; then
    echo
    echo "### 最終 health check 結果"
    echo
    printf '%s' "$last_detail" | jq -r '
      "- http_code: \(.http_code // "n/a")\n" +
      "- health_url: \(.health_url // "n/a")" +
      (if .poll_failures then "\n- poll_failures: \(.poll_failures)" else "" end)
    '
  fi
}
