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
#   - flock (利用不可なら atomic mkdir lock) + atomic rename で並行アクセスを保護
#   - SCOPE_KEY は <work_id>-<merge-base[:12]> で固定
#     work_id は Issue 紐付け時 `issue-<N>`、無い時はブランチの sanitized slug
#   - run_id (uuid) で同一作業の複数実行を識別

set -euo pipefail

if [ -z "${CLAUDE_PROJECT_DIR:-}" ]; then
  echo "ERROR: CLAUDE_PROJECT_DIR が未設定です (state-io.sh は project context から source してください)" >&2
  return 1
fi
# shellcheck source=/dev/null
source "$CLAUDE_PROJECT_DIR/.claude/lib/flow-state-dir.sh"

# === 内部ヘルパー ===

# work_id から SCOPE_KEY を計算する。
# 引数: $1 work_id  例) "issue-123" / "html-viewer-tab"
#
# 過去の検討では merge-base を含めて stale 誤継承を防ぐ方針もあったが、ark は短命
# feature ブランチが基本で main が進むと SCOPE_KEY が変わって `--resume` / hook
# resume が効かなくなる方が痛い (codex review [P2] 指摘)。WORK_ID 単独に統一する。
# stale 防止は flow_state_is_stale (1h + owner_pid 死亡) で行う。
_flow_scope_key() {
  local work_id="$1"
  printf '%s\n' "${work_id:-no-work}"
}

_flow_state_file() {
  local type="$1"
  local key="$2"
  printf '%s/flow-%s-%s.json\n' "$FLOW_STATE_DIR" "$type" "$key"
}

_flow_lock_file() {
  local key="$1"
  printf '%s/flow-%s.lock\n' "$FLOW_STATE_DIR" "$key"
}

# 現在の shell process の pid を返す。bash の subshell では $$ が親 shell の pid の
# ままなので、子 /bin/sh の PPID を使って実際に lock を保持する process を記録する。
# bash 3.2 / zsh のどちらにも依存しない方法にしている。
_flow_lock_current_pid() {
  /bin/sh -c 'printf "%s\n" "$PPID"'
}

_flow_lock_dir() {
  local lock_file="$1"
  local backend="$2"
  if [ "$backend" = "mkdir-direct" ]; then
    printf '%s\n' "$lock_file"
  else
    printf '%s.d\n' "$lock_file"
  fi
}

_flow_lock_mtime() {
  local lock_dir="$1"
  stat -c %Y "$lock_dir" 2>/dev/null \
    || stat -f %m "$lock_dir" 2>/dev/null
}

_flow_lock_discard_dir() {
  local lock_dir="$1"
  rm -f "$lock_dir/pid" 2>/dev/null || true
  rmdir "$lock_dir" 2>/dev/null || true
}

# mkdir lock が stale なら atomic rename で隔離する。
# owner pid が記録済みなら死亡時に即回収し、pid 未記録なら mkdir と pid 書き込みの
# 短い race を避けるため mtime が stale_seconds を超えた場合だけ回収する。
_flow_lock_reclaim_stale() {
  local lock_dir="$1"
  local stale_seconds="$2"
  local current_pid="$3"
  local observed_owner now lock_mtime reclaim_dir moved_owner

  observed_owner=$(cat "$lock_dir/pid" 2>/dev/null || true)
  case "$observed_owner" in ''|*[!0-9]*) observed_owner="" ;; esac
  if [ -n "$observed_owner" ]; then
    kill -0 "$observed_owner" 2>/dev/null && return 1
  else
    now=$(date +%s)
    lock_mtime=$(_flow_lock_mtime "$lock_dir" 2>/dev/null || printf '%s\n' "$now")
    case "$lock_mtime" in ''|*[!0-9]*) lock_mtime="$now" ;; esac
    [ $((now - lock_mtime)) -ge "$stale_seconds" ] || return 1
  fi

  reclaim_dir="${lock_dir}.reclaim.${current_pid}"
  if [ -e "$reclaim_dir" ]; then
    _flow_lock_discard_dir "$reclaim_dir"
    [ ! -e "$reclaim_dir" ] || return 1
  fi
  command mv "$lock_dir" "$reclaim_dir" 2>/dev/null || return 1

  # stale 判定後に別 process が lock を作り直していた場合は奪わない。観測した pid と
  # rename した directory の pid が一致するときだけ旧 lock として破棄する。
  moved_owner=$(cat "$reclaim_dir/pid" 2>/dev/null || true)
  case "$moved_owner" in ''|*[!0-9]*) moved_owner="" ;; esac
  if [ "$moved_owner" != "$observed_owner" ] \
    || { [ -n "$moved_owner" ] && kill -0 "$moved_owner" 2>/dev/null; }; then
    if [ ! -e "$lock_dir" ]; then
      command mv "$reclaim_dir" "$lock_dir" 2>/dev/null || true
    fi
    [ ! -e "$reclaim_dir" ] || _flow_lock_discard_dir "$reclaim_dir"
    return 1
  fi
  _flow_lock_discard_dir "$reclaim_dir"
  return 0
}

# 排他 lock を取得する共通 API。
# 引数: $1 lock_file, $2 flock fd, $3 wait 秒 (-1=無期限, 0=non-blocking),
#       $4 pid 未記録 directory の stale 秒, $5 backend (auto|mkdir|mkdir-direct)
# auto は flock があれば従来の fd lock、なければ <lock_file>.d の mkdir lock を使う。
# mkdir-direct は flow-loop の既存 flow-loop.lock directory path を維持するための指定。
# 成功時の実 backend / owner pid は FLOW_LOCK_ACQUIRED_BACKEND / FLOW_LOCK_ACQUIRED_PID
# に設定する。EXIT trap では pid 再計算時の subshell が異なるため、後者を release に渡す。
flow_lock_acquire() {
  local lock_file="${1:-}"
  local lock_fd="${2:-9}"
  local wait_seconds="${3:--1}"
  local stale_seconds="${4:-30}"
  local requested_backend="${5:-auto}"
  local lock_backend lock_dir current_pid deadline now
  [ -n "$lock_file" ] || return 1

  lock_backend="$requested_backend"
  if [ "$lock_backend" = "auto" ]; then
    if command -v flock >/dev/null 2>&1; then
      lock_backend="flock"
    else
      lock_backend="mkdir"
    fi
  fi

  if [ "$lock_backend" = "flock" ]; then
    case "$wait_seconds" in
      0) command flock -xn "$lock_fd" || return 1 ;;
      -1) command flock -x "$lock_fd" || return 1 ;;
      *) command flock -x -w "$wait_seconds" "$lock_fd" || return 1 ;;
    esac
    FLOW_LOCK_ACQUIRED_BACKEND="flock"
    FLOW_LOCK_ACQUIRED_PID=""
    return 0
  fi
  case "$lock_backend" in mkdir|mkdir-direct) ;; *) return 1 ;; esac

  lock_dir=$(_flow_lock_dir "$lock_file" "$lock_backend")
  current_pid=$(_flow_lock_current_pid) || return 1
  now=$(date +%s)
  deadline=$((now + wait_seconds))
  while :; do
    if mkdir "$lock_dir" 2>/dev/null; then
      if ! printf '%s\n' "$current_pid" > "$lock_dir/pid" 2>/dev/null; then
        _flow_lock_discard_dir "$lock_dir"
        return 1
      fi
      [ "$(cat "$lock_dir/pid" 2>/dev/null || true)" = "$current_pid" ] || return 1
      FLOW_LOCK_ACQUIRED_BACKEND="$lock_backend"
      FLOW_LOCK_ACQUIRED_PID="$current_pid"
      return 0
    fi
    # stale lock を回収できた場合は non-blocking 指定でも直ちに mkdir を再試行する。
    # ここで先に timeout 判定すると、回収だけして取得失敗を返してしまう。
    if _flow_lock_reclaim_stale "$lock_dir" "$stale_seconds" "$current_pid"; then
      continue
    fi
    if [ "$wait_seconds" -eq 0 ]; then
      return 1
    fi
    now=$(date +%s)
    if [ "$wait_seconds" -gt 0 ] && [ "$now" -ge "$deadline" ]; then
      return 1
    fi
    sleep 1
  done
}

# flow_lock_acquire で得た lock を解放する。flock は fd close に任せる。
# 引数: $1 lock_file, $2 backend, $3 acquire 時の owner pid (省略時は現在 pid),
#       $4 stale_seconds (指定時は死亡 owner も回収)
# stale_seconds を指定した場合は、自分以外の既に死亡した owner も回収する
# (flow-loop の別 shell invocation からの unlock 用)。
flow_lock_release() {
  local lock_file="${1:-}"
  local lock_backend="${2:-}"
  local acquired_pid="${3:-}"
  local stale_seconds="${4:-}"
  local lock_dir current_pid owner_pid
  [ -n "$lock_file" ] || return 1
  [ "$lock_backend" != "flock" ] || return 0
  case "$lock_backend" in mkdir|mkdir-direct) ;; *) return 1 ;; esac

  lock_dir=$(_flow_lock_dir "$lock_file" "$lock_backend")
  [ -d "$lock_dir" ] || return 0
  if [ -n "$acquired_pid" ]; then
    current_pid="$acquired_pid"
  else
    current_pid=$(_flow_lock_current_pid) || return 1
  fi
  owner_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
  case "$owner_pid" in ''|*[!0-9]*) owner_pid="" ;; esac
  if [ "$owner_pid" = "$current_pid" ]; then
    _flow_lock_discard_dir "$lock_dir"
    return 0
  fi
  if [ -n "$stale_seconds" ]; then
    _flow_lock_reclaim_stale "$lock_dir" "$stale_seconds" "$current_pid" || true
  fi
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
  flow_state_dir_init || return 1
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
    flow_lock_acquire "$lock_file" 9 0 30 auto \
      || { echo "ERROR: state lock 取得失敗 (重複起動?): $scope_key" >&2; return 1; }
    local lock_backend="$FLOW_LOCK_ACQUIRED_BACKEND"
    local lock_owner_pid="$FLOW_LOCK_ACQUIRED_PID"
    trap 'flow_lock_release "$lock_file" "$lock_backend" "$lock_owner_pid" || true' EXIT

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

    # 3 ファイル揃ってから atomic rename で公開。1 つでも失敗したら全 tmp を削除。
    # command mv を使うのは、呼び出し元 zsh の `alias mv='mv -i'` を迂回するため
    # （対話プロンプト化すると非対話時に上書きが拒否され state 更新が無言で失われる）。
    if ! command mv "$tmp_progress" "$progress_file" \
      || ! command mv "$tmp_kpi" "$kpi_file" \
      || ! command mv "$tmp_context" "$context_file"; then
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
  flow_state_dir_init || return 1
  local type="$1"
  local filter="$2"
  local key="$3"
  local file lock
  file=$(_flow_state_file "$type" "$key")
  lock=$(_flow_lock_file "$key")
  [ -f "$file" ] || { echo "ERROR: state file not found: $file" >&2; return 1; }
  if command -v flock >/dev/null 2>&1; then
    (
      command flock -s 9
      jq -r "$filter" "$file"
    ) 9>"$lock"
  else
    # mkdir lock では共有 lock を表現できない。read を排他 lock に格上げすると、長い
    # reader が writer を不必要に直列化する。writer は同一 filesystem 上の atomic
    # rename で完成済み JSON だけを公開するため、fallback の read は lock を取らない。
    jq -r "$filter" "$file"
  fi
}

# state JSON のフィールドを atomic rename で update する。
# 引数: $1 type, $2 jq_assign_expr, $3 scope_key
flow_state_update() {
  flow_state_dir_init || return 1
  local type="$1"
  local expr="$2"
  local key="$3"
  local file lock now
  file=$(_flow_state_file "$type" "$key")
  lock=$(_flow_lock_file "$key")
  [ -f "$file" ] || { echo "ERROR: state file not found: $file" >&2; return 1; }
  now=$(date +%s)

  (
    flow_lock_acquire "$lock" 9 -1 30 auto || return 1
    local lock_backend="$FLOW_LOCK_ACQUIRED_BACKEND"
    local lock_owner_pid="$FLOW_LOCK_ACQUIRED_PID"
    trap 'flow_lock_release "$lock" "$lock_backend" "$lock_owner_pid" || true' EXIT
    local tmp="${file}.new.$$"
    jq "$expr | .updated_at = $now | .owner_pid = $$" "$file" > "$tmp" || {
      rm -f "$tmp"
      echo "ERROR: jq failed for expr: $expr" >&2
      return 1
    }
    # command mv で zsh の `alias mv='mv -i'` を迂回する（前述の理由）。
    command mv "$tmp" "$file"
  ) 9>"$lock"
}

# stale state を判定する。1h 経過 + owner_pid 死亡で stale。
flow_state_is_stale() {
  flow_state_dir_init || return 1
  local key="$1"
  local file lock
  file=$(_flow_state_file progress "$key")
  lock=$(_flow_lock_file "$key")
  [ -f "$file" ] || return 0

  : > "$lock"
  local updated_at owner_pid now
  if command -v flock >/dev/null 2>&1; then
    if ! { read -r updated_at; read -r owner_pid; } < <(
      command flock -s "$lock" jq -r '.updated_at, .owner_pid' "$file"
    ); then
      return 0
    fi
  elif ! { read -r updated_at; read -r owner_pid; } < <(
    # flow_state_read と同じく、atomic rename で公開済みの完全な JSON を lockless に読む。
    jq -r '.updated_at, .owner_pid' "$file"
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
  flow_state_dir_init || return 1
  local key="$1"
  local lock progress_file
  lock=$(_flow_lock_file "$key")
  progress_file=$(_flow_state_file progress "$key")
  : > "$lock"
  (
    flow_lock_acquire "$lock" 9 -1 30 auto || return 1
    local lock_backend="$FLOW_LOCK_ACQUIRED_BACKEND"
    local lock_owner_pid="$FLOW_LOCK_ACQUIRED_PID"
    trap 'flow_lock_release "$lock" "$lock_backend" "$lock_owner_pid" || true' EXIT
    # 排他ロック保持中に flow_state_is_stale を呼ぶと、process substitution 内の
    # `flock -s "$lock"` が同じパスを別 fd で再ロックしようとしてデッドロックする
    # (codex review [P2] 指摘)。ロック取得済みなので、ファイルを直接読んで判定する。
    [ -f "$progress_file" ] || exit 0
    local updated_at owner_pid now
    if ! { read -r updated_at; read -r owner_pid; } < <(
      jq -r '.updated_at, .owner_pid' "$progress_file" 2>/dev/null
    ); then
      # 読めない state は破壊済みとみなして削除
      rm -f \
        "$progress_file" \
        "$(_flow_state_file kpi "$key")" \
        "$(_flow_state_file context "$key")"
      echo "corrupt state removed: $key" >&2
      exit 0
    fi
    now=$(date +%s)
    if [ $((now - updated_at)) -ge 3600 ] && ! kill -0 "$owner_pid" 2>/dev/null; then
      rm -f \
        "$progress_file" \
        "$(_flow_state_file kpi "$key")" \
        "$(_flow_state_file context "$key")"
      echo "stale state removed: $key" >&2
    fi
  ) 9>"$lock"
  # lock ファイルは削除しない (inode 競合防止)
}

flow_state_exists() {
  flow_state_dir_init || return 1
  local key="$1"
  [ -f "$(_flow_state_file progress "$key")" ] \
    && [ -f "$(_flow_state_file kpi "$key")" ] \
    && [ -f "$(_flow_state_file context "$key")" ]
}

flow_state_scope_key() {
  _flow_scope_key "$1"
}
