#!/usr/bin/env bash
# .claude/lib/state-io.sh
# flow skill の状態 JSON 永続化ヘルパー。
#
# 利用想定:
#   source "$CLAUDE_PROJECT_DIR/.claude/lib/state-io.sh"
#   flow_state_init "issue-123" "feature/issue-123/foo" "/path/to/worktree"
#   flow_state_update progress '.phase = "P3"'
#   flow_state_read progress '.phase'
#
# 設計判断:
#   - 状態を 3 ファイルに分離: progress / kpi / context
#   - flock + atomic rename で並行アクセスを保護
#   - SCOPE_KEY は <work_id>-<merge-base[:12]> で固定
#     work_id は Issue 紐付け時 `issue-<N>`、無い時はブランチの sanitized slug
#   - run_id (uuid) で同一作業の複数実行を識別

set -euo pipefail

# === 内部ヘルパー ===

# work_id (issue-<N> or slug) と merge-base から SCOPE_KEY を計算する。
# 引数: $1 work_id  例) "issue-123" / "html-viewer-tab"
_flow_scope_key() {
  local work_id="$1"
  local merge_base
  merge_base=$(git merge-base origin/main HEAD 2>/dev/null | cut -c1-12) || merge_base="nobase"
  printf '%s-%s\n' "${work_id:-no-work}" "$merge_base"
}

_flow_state_file() {
  local type="$1"
  local key="$2"
  printf '/tmp/flow-%s-%s.json\n' "$type" "$key"
}

_flow_lock_file() {
  local key="$1"
  printf '/tmp/flow-%s.lock\n' "$key"
}

_flow_gen_run_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    local hex
    hex=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
    printf '%s-%s-4%s-a%s-%s\n' \
      "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" "${hex:17:3}" "${hex:20:12}"
  fi
}

# === 公開関数 ===

# state 3 ファイルを初期化する。
# 引数: $1 work_id (issue-<N> or slug), $2 branch, $3 worktree_path, [$4 issue_number]
flow_state_init() {
  local work_id="$1"
  local branch="$2"
  local worktree_path="$3"
  local issue_number="${4:-}"
  local scope_key
  scope_key=$(_flow_scope_key "$work_id")
  local now run_id
  now=$(date +%s)
  run_id=$(_flow_gen_run_id)

  local progress_file kpi_file context_file lock_file
  progress_file=$(_flow_state_file progress "$scope_key")
  kpi_file=$(_flow_state_file kpi "$scope_key")
  context_file=$(_flow_state_file context "$scope_key")
  lock_file=$(_flow_lock_file "$scope_key")

  : > "$lock_file"
  (
    flock -xn 9 || { echo "ERROR: state lock 取得失敗 (重複起動?): $scope_key" >&2; return 1; }

    if [ -e "$progress_file" ] || [ -e "$kpi_file" ] || [ -e "$context_file" ]; then
      echo "ERROR: state already exists for $scope_key (cleanup_stale を先に呼んでください)" >&2
      return 1
    fi

    local tmp_progress="${progress_file}.new.$$"
    local tmp_kpi="${kpi_file}.new.$$"
    local tmp_context="${context_file}.new.$$"

    local progress_json
    progress_json=$(jq -n \
      --arg run_id "$run_id" \
      --arg scope_key "$scope_key" \
      --argjson now "$now" \
      --arg work_id "$work_id" \
      --arg branch "$branch" \
      '{
        version: 1,
        run_id: $run_id,
        scope_key: $scope_key,
        updated_at: $now,
        owner_pid: '"$$"',
        work_id: $work_id,
        branch: $branch,
        phase: "P-1",
        iter: 0,
        safety_level: "ok",
        phase_history: [],
        warnings: [],
        gate_findings_seen: []
      }')
    printf '%s' "$progress_json" > "$tmp_progress"

    local kpi_json
    kpi_json=$(jq -n \
      --arg run_id "$run_id" \
      --arg scope_key "$scope_key" \
      --argjson now "$now" \
      '{
        version: 1,
        run_id: $run_id,
        scope_key: $scope_key,
        updated_at: $now,
        owner_pid: '"$$"',
        start_at: $now,
        phase_durations: {},
        wait_durations: {},
        intervention_timestamps: [],
        expected_fires: []
      }')
    printf '%s' "$kpi_json" > "$tmp_kpi"

    local context_json
    context_json=$(jq -n \
      --arg run_id "$run_id" \
      --arg scope_key "$scope_key" \
      --argjson now "$now" \
      --arg work_id "$work_id" \
      --arg branch "$branch" \
      --arg worktree "$worktree_path" \
      --arg issue_number "$issue_number" \
      '{
        version: 1,
        run_id: $run_id,
        scope_key: $scope_key,
        updated_at: $now,
        owner_pid: '"$$"',
        work_id: $work_id,
        branch: $branch,
        worktree_path: $worktree,
        issue_number: (if $issue_number == "" then null else ($issue_number | tonumber) end),
        cron_task_history: []
      }')
    printf '%s' "$context_json" > "$tmp_context"

    if ! mv "$tmp_progress" "$progress_file" \
      || ! mv "$tmp_kpi" "$kpi_file" \
      || ! mv "$tmp_context" "$context_file"; then
      rm -f "$tmp_progress" "$tmp_kpi" "$tmp_context" \
            "$progress_file" "$kpi_file" "$context_file"
      echo "ERROR: state ファイル公開に失敗: $scope_key" >&2
      return 1
    fi
  ) 9>"$lock_file" || return 1

  printf '%s\n' "$scope_key"
}

# state JSON のフィールドを read する。
# 引数: $1 type (progress|kpi|context), $2 jq_filter, $3 scope_key
flow_state_read() {
  local type="$1"
  local filter="$2"
  local key="$3"
  local file lock
  file=$(_flow_state_file "$type" "$key")
  lock=$(_flow_lock_file "$key")
  [ -f "$file" ] || { echo "ERROR: state file not found: $file" >&2; return 1; }
  (
    flock -s 9
    jq -r "$filter" "$file"
  ) 9>"$lock"
}

# state JSON のフィールドを atomic rename で update する。
# 引数: $1 type, $2 jq_assign_expr, $3 scope_key
flow_state_update() {
  local type="$1"
  local expr="$2"
  local key="$3"
  local file lock now
  file=$(_flow_state_file "$type" "$key")
  lock=$(_flow_lock_file "$key")
  [ -f "$file" ] || { echo "ERROR: state file not found: $file" >&2; return 1; }
  now=$(date +%s)

  (
    flock -x 9
    local tmp="${file}.new.$$"
    jq "$expr | .updated_at = $now | .owner_pid = $$" "$file" > "$tmp" || {
      rm -f "$tmp"
      echo "ERROR: jq failed for expr: $expr" >&2
      return 1
    }
    mv "$tmp" "$file"
  ) 9>"$lock"
}

# stale state を判定する。1h 経過 + owner_pid 死亡で stale。
flow_state_is_stale() {
  local key="$1"
  local file lock
  file=$(_flow_state_file progress "$key")
  lock=$(_flow_lock_file "$key")
  [ -f "$file" ] || return 0

  : > "$lock"
  local updated_at owner_pid now
  if ! { read -r updated_at; read -r owner_pid; } < <(
    flock -s "$lock" jq -r '.updated_at, .owner_pid' "$file"
  ); then
    return 0
  fi
  now=$(date +%s)

  if [ $((now - updated_at)) -lt 3600 ]; then
    return 1
  fi
  if kill -0 "$owner_pid" 2>/dev/null; then
    return 1
  fi
  return 0
}

flow_state_cleanup_stale() {
  local key="$1"
  local lock
  lock=$(_flow_lock_file "$key")
  : > "$lock"
  (
    flock -x 9
    if flow_state_is_stale "$key"; then
      rm -f \
        "$(_flow_state_file progress "$key")" \
        "$(_flow_state_file kpi "$key")" \
        "$(_flow_state_file context "$key")"
      echo "stale state removed: $key" >&2
    fi
  ) 9>"$lock"
  # lock ファイルは削除しない (inode 競合防止)
}

flow_state_exists() {
  local key="$1"
  [ -f "$(_flow_state_file progress "$key")" ] \
    && [ -f "$(_flow_state_file kpi "$key")" ] \
    && [ -f "$(_flow_state_file context "$key")" ]
}

flow_state_scope_key() {
  _flow_scope_key "$1"
}
