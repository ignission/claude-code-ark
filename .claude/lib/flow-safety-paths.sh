#!/usr/bin/env bash
# flow / flow-x が共有する safety gate の監視 path と判定ロジック。

FLOW_GUARD_DB_SCHEMA_PATHS=(
  "packages/server/src/lib/database.ts"
)

FLOW_GUARD_SESSION_LIFECYCLE_PATHS=(
  "packages/server/src/lib/session-orchestrator.ts"
  "packages/server/src/lib/tmux-manager.ts"
  "packages/server/src/lib/ttyd-manager.ts"
)

# DB schema の対象 path に schema 語句を含む diff がある場合だけ成功する。
flow_guard_db_schema_changed() {
  local diff_range="${1:-origin/main...HEAD}"
  local changed_paths
  changed_paths=$(git diff --name-only "$diff_range" -- "${FLOW_GUARD_DB_SCHEMA_PATHS[@]}") || return 1
  [ -n "$changed_paths" ] || return 1

  git diff "$diff_range" -- "${FLOW_GUARD_DB_SCHEMA_PATHS[@]}" \
    | grep -qE '(CREATE TABLE|ALTER TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN)'
}

# halt はオーケストレータへの指示なので、呼び出し側の SKILL.md が実行する。
flow_guard_db_schema_halt_message() {
  printf 'DB スキーマ変更検出 (%s、人間レビュー必須)\n' "${FLOW_GUARD_DB_SCHEMA_PATHS[*]}"
}

# session lifecycle の対象 path が diff に含まれる場合だけ成功する。
flow_guard_session_lifecycle_changed() {
  local diff_range="${1:-origin/main...HEAD}"
  local changed_paths
  changed_paths=$(git diff --name-only "$diff_range" -- "${FLOW_GUARD_SESSION_LIFECYCLE_PATHS[@]}") || return 1
  [ -n "$changed_paths" ]
}

# 依存契約: 呼び出し側が先に .claude/lib/state-io.sh を source し、
# flow_state_update を利用可能にしておくこと。
flow_guard_warn_session_lifecycle_change() {
  local scope_key="$1"
  local diff_range="${2:-origin/main...HEAD}"
  if flow_guard_session_lifecycle_changed "$diff_range"; then
    flow_state_update progress \
      '.warnings += ["tmux/ttyd セッションライフサイクル変更あり、再起動時の挙動を確認すること"]' \
      "$scope_key"
  fi
}
