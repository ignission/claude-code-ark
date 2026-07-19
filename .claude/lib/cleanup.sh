#!/usr/bin/env bash
# .claude/lib/cleanup.sh
# flow P11 から呼ばれる cleanup ヘルパー。
# PR squash merge → main pull → tmux/ttyd 孤児回収 → Issue クローズヒント。
#
# 仕様:
#   flow P11 では worktree を **削除しない**。pm2 監視 (P12) で deploy 失敗時の
#   調査ができるよう、worktree は P12 完了後にユーザーが手動削除する。
#   `cleanup_remove_worktree` 関数は手動 cleanup 用途で残置（flow からは呼ばない）。
#
# 設計判断:
#   - worktree パスは <repo-parent>/ark-<sanitized> のみ
#   - PR state == MERGED を gh pr view で確認してから worktree 削除

set -euo pipefail

# === 公開関数 ===

# PR を squash merge し、ローカル main を最新化する。
cleanup_merge_pr() {
  local pr_number="$1"
  if [ -z "$pr_number" ]; then
    echo "ERROR: PR 番号が必要です" >&2
    return 1
  fi
  gh pr merge "$pr_number" --squash --delete-branch
}

# main worktree のルートに cd してローカル main を最新化する。
cleanup_pull_main() {
  local main_git_common_dir main_wt_root
  main_git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
    echo "ERROR: git common dir が取得できません" >&2
    return 1
  }
  main_wt_root="${main_git_common_dir%/.git}"
  cd "$main_wt_root"
  git checkout main && git pull

  # `[origin/...: gone]` のローカル branch を掃除。
  # P11 で worktree を削除しないため、worktree 経由で checkout 中のブランチを除外する必要がある。
  local worktree_branches
  worktree_branches=$(git worktree list --porcelain 2>/dev/null \
    | awk '/^branch /{sub("^refs/heads/", "", $2); print $2}')
  local gone_branches
  gone_branches=$(git branch -vv \
    | { grep '\[origin/.*: gone\]' || true; } \
    | sed -E 's/^[+* ]+//' \
    | awk '{print $1}')
  if [ -n "$gone_branches" ]; then
    if [ -n "$worktree_branches" ]; then
      gone_branches=$(printf '%s\n' "$gone_branches" \
        | { grep -vxF -f <(printf '%s\n' "$worktree_branches") || true; })
    fi
    [ -n "$gone_branches" ] && printf '%s\n' "$gone_branches" | xargs -r git branch -d
  fi
  printf '%s\n' "$main_wt_root"
}

# flow worktree を削除する (手動 cleanup 用途、flow からは呼ばない)。
cleanup_remove_worktree() {
  local wt_path="$1"
  local pr_number="$2"
  if [ -z "$wt_path" ] || [ -z "$pr_number" ]; then
    echo "ERROR: worktree path と PR 番号が必要です" >&2
    return 1
  fi
  if [ ! -d "$wt_path" ]; then
    echo "worktree 不在のためスキップ: $wt_path" >&2
    return 0
  fi
  local pr_state
  pr_state=$(gh pr view "$pr_number" --json state -q .state 2>/dev/null) || pr_state=""
  if [ "$pr_state" != "MERGED" ]; then
    echo "WARNING: PR #$pr_number state=$pr_state のため worktree を削除しません: $wt_path" >&2
    return 1
  fi

  local main_git_common_dir main_wt_root
  main_git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  main_wt_root="${main_git_common_dir%/.git}"
  git -C "$main_wt_root" worktree remove "$wt_path" --force
  git -C "$main_wt_root" worktree prune
  echo "worktree 削除: $wt_path" >&2
}

# 孤児 tmux/ttyd を回収する。
# ark 開発中の作業セッションは `ark-<branch>` の prefix なので、
# 該当 worktree が消えた tmux session のみ整理する (実セッションには手を出さない)。
# flow から worktree は残す方針なので、本関数は no-op としておくが、将来の手動 cleanup 用に
# シェルから呼び出せる形は残す。
cleanup_orphan_terminals() {
  echo "(flow では worktree を残すため、tmux/ttyd の自動 cleanup はスキップ)" >&2
}

# Issue を「対応済み」相当にするためのコメントヒント。
# 引数: $1 issue_number（空ならスキップ）
cleanup_issue_close_hint() {
  local issue_number="$1"
  if [ -z "$issue_number" ] || [ "$issue_number" = "null" ]; then
    return 0
  fi
  cat <<EOF >&2
[Issue] #$issue_number に PR マージのコメントを残してください:
  gh issue comment $issue_number --body "PR #<num> をマージしました"
  必要に応じて gh issue close $issue_number （PR 側で `Closes #$issue_number` を含めていれば自動クローズ）
EOF
}

# flow state ファイル + codex-gate ログを scope-specific で削除する。
# 引数:
#   $1 scope_key (例: issue-123 / html-viewer-tab)
#   $2 mode (省略時 "final"):
#      - "final": 全 state (progress / kpi / context) を削除。success / no-target /
#                 abort (flow-loop の PR Close) で使用。削除後は --resume で再入
#                 できなくなる。kpi は削除前に flow-kpi-history.jsonl に append して
#                 KPI データを永続化 (kpi.json だけ残すと flow_state_init が同 scope
#                 再起動を拒否する。一方 kpi 完全削除は --kpi 集計を空にするので
#                 history file への append で両立)
#      - "resumable": progress / kpi / context を残す。failure / timeout / poll-error で
#                     使用。deploy 失敗の調査と /flow --resume 継続を可能にする
# 仕様:
#   - scope_key は whitelist `^[A-Za-z0-9_-]+$` のみ許容 (glob meta 文字 * ? [ ] /
#     . 空白 等を全て拒否)。ark の SCOPE_KEY (work_id) は元から whitelist 内
#   - .lock ファイルは削除しない (state-io.sh の inode 差し替え invariant のため)。
#     terminal 後の lock は永続化させて並行 reader との race を未然に防ぐ
#   - final mode の state 削除は state-io と同じ flock を取得して atomic に行う
#     (並行 writer (--resume / cron callback) が `mv` で recreate するレースを防ぐ)。
#     lock 取得失敗時は削除をスキップ (best-effort)
#   - codex-gate ログと .new.* (atomic write 中間) は両モードで削除 (履歴のみ)
cleanup_flow_state_files() {
  local scope_key="$1"
  local mode="${2:-final}"
  if [ -z "$scope_key" ]; then
    echo "ERROR: cleanup_flow_state_files: scope_key が必要です" >&2
    return 1
  fi
  # whitelist: 英数 + アンダースコア + ハイフンのみ許容
  if ! [[ "$scope_key" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "ERROR: cleanup_flow_state_files: scope_key に許容外文字 (whitelist ^[A-Za-z0-9_-]+$): $scope_key" >&2
    return 1
  fi
  case "$mode" in
    final|resumable) ;;
    *)
      echo "ERROR: cleanup_flow_state_files: 不明な mode: $mode (final|resumable)" >&2
      return 1
      ;;
  esac
  local base="${CLEANUP_FLOW_STATE_DIR:-/tmp}"
  # 削除対象 (state-io.sh / codex-gate.sh の出力に対応):
  #   final mode のみ削除 (flock 取得して atomic):
  #     /tmp/flow-progress-<scope>.json
  #     /tmp/flow-kpi-<scope>.json (削除前に flow-kpi-history.jsonl に append)
  #     /tmp/flow-context-<scope>.json
  #   両 mode で削除:
  #     /tmp/flow-{progress,kpi,context}-<scope>.json.new.* (atomic write 中間)
  #     /tmp/codex-gate-<phase>-<scope>-<random>.txt (codex review log)
  #   両 mode で残す:
  #     /tmp/flow-<scope>.lock (state-io invariant)
  local lock_file="$base/flow-${scope_key}.lock"
  # state-io 互換: lock file が無ければ作成 (state-io 側も touch ベースで作成する)
  : > "$lock_file" 2>/dev/null || true

  # 内部ヘルパー: scope-specific lock を取って関数を実行する。
  # bash/zsh ともに動く。flock 無し環境では裸実行。lock 取得失敗時は warning + return 0
  # (cleanup は best-effort)。state-io の writer / reader と race しないことを保証する。
  _cleanup_with_scope_lock() {
    local _action="$1"
    if command -v flock >/dev/null 2>&1; then
      (
        exec 9<"$lock_file"
        if ! flock -x -w 30 9; then
          echo "WARNING: cleanup_flow_state_files ($mode): flock 30 秒待機 timeout、$_action をスキップ" >&2
          exit 0
        fi
        $_action
      )
    else
      # flock 無し環境: state-io の writer も flock を取れないので race は元から制御外
      $_action
    fi
  }

  # 内部ヘルパー: .new.* (writer の atomic-write 中間ファイル) を削除する。
  # 両 mode で実行。lock 内呼び出し前提なので writer の `${file}.new.$$` を
  # race で消してしまう事故は防げる。
  _cleanup_delete_atomic_tmp_files() {
    find "$base" -maxdepth 1 -type f \
      \( -name "flow-progress-${scope_key}.json.new.*" \
      -o -name "flow-kpi-${scope_key}.json.new.*" \
      -o -name "flow-context-${scope_key}.json.new.*" \
      \) -delete 2>/dev/null || true
  }

  # 内部ヘルパー: KPI snapshot を flow-kpi-history.jsonl に append。
  # history file は cross-scope 共有なので専用 lock (`flow-kpi-history.lock`) で
  # serialize する。jq -c で JSONL 形式を保証。append 成功で 0、失敗で 1。
  # jq 必須: state-io.sh 自体が jq に依存しており jq 無い環境で flow は動かない
  # (raw cat fallback は pretty-print JSON の verbatim append で history JSONL を壊す)。
  _cleanup_archive_kpi_to_history() {
    [ -f "$base/flow-kpi-${scope_key}.json" ] || return 0
    if ! command -v jq >/dev/null 2>&1; then
      echo "ERROR: cleanup_flow_state_files: jq が必要 (KPI history への JSONL append のため)" >&2
      return 1
    fi
    local hist_lock="$base/flow-kpi-history.lock"
    : > "$hist_lock" 2>/dev/null || true
    (
      if command -v flock >/dev/null 2>&1; then
        exec 8<"$hist_lock"
        # scope lock と同じ -w 30 で timeout を統一。操作は jq -c の 1 行 append で
        # 短時間だが、stuck 時に無限待機する事態を避ける。
        if ! flock -x -w 30 8; then
          echo "WARNING: _cleanup_archive_kpi_to_history: history lock 30 秒待機 timeout" >&2
          exit 1
        fi
      fi
      jq -c . "$base/flow-kpi-${scope_key}.json" >> "$base/flow-kpi-history.jsonl"
    )
  }

  # 内部ヘルパー: final mode の state 削除本体。lock 内で呼ぶ。
  # 順序が重要:
  #   1. 既存 sentinel チェック (KPI 二重 archive 防止)
  #   2. branch を progress.json から読む (削除前)
  #   3. done sentinel を書く (state 削除前 → 「state も sentinel も無い窓」を作らない)
  #   4. KPI archive → state ファイル一括削除
  # この順序により、KPI archive 失敗時は全 state を残し (resume 可能)、並行 /flow から
  # 見ると常に state または sentinel のどちらかが存在する (race で「新規 run」扱いに
  # なる窓を消す)。
  _cleanup_do_final_delete() {
    # 既に sentinel が同 branch で存在 → 既に完了済み (前回の cleanup が
    # KPI archive 成功 + sentinel 書き込み成功で抜けている)。再実行で
    # KPI を二重 archive しないため early return する。
    if [ -f "$base/flow-done-${scope_key}.json" ]; then
      local existing_branch
      existing_branch=$(jq -r '.branch // ""' "$base/flow-done-${scope_key}.json" 2>/dev/null || echo "")
      local current_branch=""
      if [ -f "$base/flow-progress-${scope_key}.json" ]; then
        current_branch=$(jq -r '.branch // ""' "$base/flow-progress-${scope_key}.json" 2>/dev/null || echo "")
      fi
      if [ -n "$existing_branch" ] && [ "$existing_branch" = "$current_branch" ]; then
        # sentinel 既存 → archive 済み。state を削除してリトライ完了
        rm -f \
          "$base/flow-progress-${scope_key}.json" \
          "$base/flow-context-${scope_key}.json" \
          "$base/flow-kpi-${scope_key}.json"
        return 0
      fi
    fi

    # 1. branch を実 state から読む (caller CWD に依存しない)。progress.json が既に
    #    消えている場合 (リトライ実行等) は既存 sentinel から branch を引き継ぐ
    #    (空 branch で sentinel を上書きする事故を防ぐ)。
    local sentinel_branch=""
    if [ -f "$base/flow-progress-${scope_key}.json" ]; then
      sentinel_branch=$(jq -r '.branch // ""' "$base/flow-progress-${scope_key}.json" 2>/dev/null || echo "")
    fi
    if [ -z "$sentinel_branch" ] && [ -f "$base/flow-done-${scope_key}.json" ]; then
      sentinel_branch=$(jq -r '.branch // ""' "$base/flow-done-${scope_key}.json" 2>/dev/null || echo "")
    fi
    # 2. done sentinel を **KPI archive と state 削除の前に** 書く。
    #    sentinel 書き込み失敗時は何もせず return → 次回リトライで再開可能。
    if ! jq -n \
        --arg scope "$scope_key" \
        --arg branch "$sentinel_branch" \
        --arg now "$(date +%s)" \
        '{scope_key: $scope, branch: $branch, completed_at: ($now | tonumber), source: "cleanup_post_deploy(final)"}' \
        > "$base/flow-done-${scope_key}.json" 2>/dev/null; then
      echo "WARNING: cleanup_flow_state_files: done sentinel 書き込み失敗 (/tmp 満杯 / 権限不足 等)、cleanup を中止 (KPI 未 archive、state 残置)" >&2
      rm -f "$base/flow-done-${scope_key}.json" 2>/dev/null
      return 0
    fi
    # 3. KPI archive (sentinel 成功確認済みで再実行時は早期 return される)
    if ! _cleanup_archive_kpi_to_history; then
      echo "WARNING: cleanup_flow_state_files: KPI history append 失敗、cleanup を中止 (sentinel も削除して次回リトライで再 archive 可能に戻す)" >&2
      # sentinel を残置すると次回リトライが冒頭 early-return path に入り、archive
      # 未実行のまま state を削除して KPI が失われる。sentinel + state 両方残せば
      # リトライ時に通常 path を再実行できる。
      rm -f "$base/flow-done-${scope_key}.json" 2>/dev/null
      return 0
    fi
    # 4. state ファイル一括削除 (sentinel + archive 両方成功)
    rm -f \
      "$base/flow-progress-${scope_key}.json" \
      "$base/flow-context-${scope_key}.json" \
      "$base/flow-kpi-${scope_key}.json"
    _cleanup_delete_atomic_tmp_files
  }

  # mode 別本処理:
  #   final: state 削除 + .new.* 削除 (両方 lock 内)
  #   resumable: .new.* 削除のみ (lock 内、state は残置)
  if [ "$mode" = "final" ]; then
    _cleanup_with_scope_lock _cleanup_do_final_delete
  else
    _cleanup_with_scope_lock _cleanup_delete_atomic_tmp_files
  fi

  # 内部ヘルパーは関数スコープに留めるため後始末
  unset -f _cleanup_with_scope_lock _cleanup_delete_atomic_tmp_files \
           _cleanup_archive_kpi_to_history _cleanup_do_final_delete 2>/dev/null

  # codex-gate ログは atomic write の対象外で writer と race しないので lock 外で OK。
  # 両 mode で削除 (履歴のみ)。
  # scope_key は上の whitelist で sanitization 済みなので find -name の glob 展開は safe。
  find "$base" -maxdepth 1 -type f \
    -name "codex-gate-*-${scope_key}-*.txt" \
    -delete 2>/dev/null || true
}

# P12 terminal (success / failure / timeout / poll-error / no-target) で呼ぶ最終 cleanup。
# ark には testcontainers / Docker volume の孤児は無いため、flow state / codex log の
# 回収のみを行う。
# 引数:
#   $1 scope_key
#   $2 mode (省略時 "final", "resumable" / "final" のいずれか)
#      - "final" (success / no-target): state を削除して --resume 不可にする
#      - "resumable" (failure / timeout / poll-error): state を残し --resume 可能にする
cleanup_post_deploy() {
  local scope_key="$1"
  local mode="${2:-final}"
  if [ -z "$scope_key" ]; then
    echo "ERROR: cleanup_post_deploy: scope_key が必要です" >&2
    return 1
  fi
  cleanup_flow_state_files "$scope_key" "$mode"
}

# === テスト用エントリ ===
# __CLEANUP_LIB_SOURCED_FOR_TEST__=1 で source された場合は副作用処理 (将来追加されうる)
# をスキップする。現在 cleanup.sh は関数定義のみで副作用処理は持たないが、
# 将来 entrypoint を追加した場合に test-cleanup.sh が安全に source できるよう保険を置く。
if [ -n "${__CLEANUP_LIB_SOURCED_FOR_TEST__:-}" ]; then
  return 0 2>/dev/null || true
fi
