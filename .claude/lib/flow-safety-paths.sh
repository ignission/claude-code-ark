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

# DB schema の対象 path に schema 操作を含む diff がある場合は 0、
# 変更なしは 1、git diff などで評価できない場合は 2 を返す。
# git config の色設定に関わらず判定するため、すべての diff で --no-color を指定する。
flow_guard_db_schema_changed() {
  local diff_range="${1:-origin/main...HEAD}"
  local changed_paths
  local git_status
  local schema_diff
  local grep_status

  changed_paths=$(git diff --no-color --name-only "$diff_range" -- "${FLOW_GUARD_DB_SCHEMA_PATHS[@]}")
  git_status=$?
  if [ "$git_status" -ne 0 ]; then
    printf 'DB スキーマ変更の判定不能: git diff が失敗しました (range: %s)\n' "$diff_range" >&2
    return 2
  fi
  [ -n "$changed_paths" ] || return 1

  schema_diff=$(git diff --no-color --unified=0 "$diff_range" -- "${FLOW_GUARD_DB_SCHEMA_PATHS[@]}")
  git_status=$?
  if [ "$git_status" -ne 0 ]; then
    printf 'DB スキーマ変更の判定不能: git diff が失敗しました (range: %s)\n' "$diff_range" >&2
    return 2
  fi

  grep -E '^[+-]' <<< "$schema_diff" \
    | grep -vE '^(\+\+\+|---)' \
    | grep -qE '(CREATE TABLE|ALTER TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN|CREATE (UNIQUE )?INDEX|DROP INDEX)'
  grep_status=$?
  case "$grep_status" in
    0) return 0 ;;
    1) return 1 ;;
    *)
      printf 'DB スキーマ変更の判定不能: schema 語句の検索に失敗しました\n' >&2
      return 2
      ;;
  esac
}

# halt はオーケストレータへの指示なので、呼び出し側の SKILL.md が実行する。
flow_guard_db_schema_halt_message() {
  printf 'DB スキーマ変更検出 (%s、人間レビュー必須)\n' "${FLOW_GUARD_DB_SCHEMA_PATHS[*]}"
}

# session lifecycle の対象 path が diff に含まれる場合は 0、
# 変更なしは 1、git diff で評価できない場合は 2 を返す。
flow_guard_session_lifecycle_changed() {
  local diff_range="${1:-origin/main...HEAD}"
  local changed_paths
  local git_status

  changed_paths=$(git diff --name-only "$diff_range" -- "${FLOW_GUARD_SESSION_LIFECYCLE_PATHS[@]}")
  git_status=$?
  if [ "$git_status" -ne 0 ]; then
    printf 'セッションライフサイクル変更の判定不能: git diff が失敗しました (range: %s)\n' "$diff_range" >&2
    return 2
  fi
  [ -n "$changed_paths" ]
}

# 依存契約: 呼び出し側が先に .claude/lib/state-io.sh を source し、
# flow_state_update を利用可能にしておくこと。
flow_guard_warn_session_lifecycle_change() {
  local scope_key="$1"
  local diff_range="${2:-origin/main...HEAD}"
  local guard_status

  flow_guard_session_lifecycle_changed "$diff_range"
  guard_status=$?
  case "$guard_status" in
    0)
      flow_state_update progress \
        '.warnings += ["tmux/ttyd セッションライフサイクル変更あり、再起動時の挙動を確認すること"]' \
        "$scope_key"
      ;;
    1)
      return 0
      ;;
    2)
      flow_state_update progress \
        '.warnings += ["tmux/ttyd セッションライフサイクル変更を判定不能 (git diff が失敗)、origin/main と diff range を確認すること"]' \
        "$scope_key" || return 2
      return 2
      ;;
  esac
}
