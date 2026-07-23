#!/usr/bin/env bash
# .claude/skills/flow-loop/lib/loop.sh
# flow-loop (運転ループ) の状態・排他・計測ヘルパー。
#
# 利用想定:
#   source "$CLAUDE_PROJECT_DIR/.claude/skills/flow-loop/lib/loop.sh"
#   flow_loop_init
#   flow_loop_lock && ... && flow_loop_unlock
#
# 設計判断:
#   - run state (state-io.sh の /tmp/flow-{progress,kpi,context}-*.json) には依存せず、
#     progress ファイルの列挙と jq 読み取りのみで active run を数える (疎結合)。
#   - loop 状態 (loop.json / metrics / kill switch) も state-io.sh と同じ /tmp 規約に置く
#     (kpi 履歴の /tmp/flow-kpi-history.jsonl と同格)。再起動で消えたら init が既定値で
#     再生成する。恒久化したい設定変更 (wip_limit / pick_query 等) は本ファイルの既定値を
#     PR で変える。/tmp の loop.json 直接編集は一時的な調整用。
#   - パス解決に BASH_SOURCE を使わない。Claude の Bash ツールは実体が zsh のことがあり、
#     zsh で source すると BASH_SOURCE が空になる (本ファイルは固定パス /tmp のみで完結)。
#   - tick 排他は mkdir の atomic 性を使う (flock ファイルと違い stale 回収を mtime で判定できる)。
#   - pick は GitHub Issue のみ対応。pick_query は gh issue list --search 用の
#     GitHub 検索構文で持つ。

set -euo pipefail

# loop 状態の配置先。テストでは一時ディレクトリに差し替える。
: "${FLOW_LOOP_STATE_DIR:=/tmp}"

# run state (state-io.sh) の配置先。テストでは一時ディレクトリに差し替える。
: "${FLOW_LOOP_RUNS_DIR:=/tmp}"

FLOW_LOOP_JSON="$FLOW_LOOP_STATE_DIR/flow-loop.json"
FLOW_LOOP_LOCK="$FLOW_LOOP_STATE_DIR/flow-loop.lock"
FLOW_LOOP_STOP="$FLOW_LOOP_STATE_DIR/flow-loop-stop"
FLOW_LOOP_METRICS="$FLOW_LOOP_STATE_DIR/flow-loop-metrics.jsonl"
: "${FLOW_LOOP_LOCK_STALE_SECONDS:=3600}"
: "${FLOW_LOOP_BREAKER_THRESHOLD:=3}"

# 新規 pick の既定クエリ (gh issue list --search に渡す GitHub 検索構文)。
# 運用に合わせて loop.json の .pick_query を書き換えてよい
# (init は既存 loop.json を上書きしないため、手で編集した値は保持される)。
# in-progress / review ラベルは flow が着手時・マージ後に付けるステータス代替なので除外する。
FLOW_LOOP_DEFAULT_PICK_QUERY='assignee:@me is:open is:issue -label:loop-exclude -label:in-progress -label:review sort:created-asc'

# init ── loop.json が無ければ既定値で作る (冪等。既存は一切変更しない)
flow_loop_init() {
  mkdir -p "$FLOW_LOOP_STATE_DIR"
  [ -f "$FLOW_LOOP_JSON" ] && return 0
  jq -n --arg q "$FLOW_LOOP_DEFAULT_PICK_QUERY" --argjson ts "$(date +%s)" \
    '{wip_limit: 2, engine: "codex", pick_query: $q,
      active_hours: "", daily_budget: 3, picks_today: 0, pick_date: "",
      consecutive_halts: 0, last_tick_at: 0, created_at: $ts}' \
    > "$FLOW_LOOP_JSON.$$.tmp" && command mv "$FLOW_LOOP_JSON.$$.tmp" "$FLOW_LOOP_JSON"
}

# read <jq_filter>
flow_loop_read() {
  [ -f "$FLOW_LOOP_JSON" ] || return 1
  jq -r "${1:?jq filter required}" "$FLOW_LOOP_JSON"
}

# update <jq_expr> ── updated_at を自動更新し atomic に書き戻す。
# command mv は zsh の `alias mv='mv -i'` を迂回するため (state-io.sh と同じ理由)。
# 一時ファイル名は $$ 付きで一意にする (init と同様。固定名だと同時書き込みで競合する)。
flow_loop_update() {
  [ -f "$FLOW_LOOP_JSON" ] || return 1
  jq --argjson ts "$(date +%s)" "(${1:?jq expr required}) | .updated_at = \$ts" "$FLOW_LOOP_JSON" \
    > "$FLOW_LOOP_JSON.$$.tmp" \
    && command mv "$FLOW_LOOP_JSON.$$.tmp" "$FLOW_LOOP_JSON" \
    || { rm -f "$FLOW_LOOP_JSON.$$.tmp"; return 1; }
}

# kill switch (loop-stop ファイルの有無。stop=touch / start=rm は skill 手順が行う)
flow_loop_stopped() { [ -f "$FLOW_LOOP_STOP" ]; }

# ブレーカー作動中か (連続 halt が閾値以上)
flow_loop_breaker_tripped() {
  local n
  n="$(flow_loop_read '.consecutive_halts // 0' 2>/dev/null)" || return 1
  [ -n "$n" ] && [ "$n" -eq "$n" ] 2>/dev/null && [ "$n" -ge "$FLOW_LOOP_BREAKER_THRESHOLD" ]
}

# tick 排他。mkdir の atomic 性で取得し、lock dir 内に所有者 pid を記録する。
# 回収条件: 所有 pid が死んでいる、または pid 不明かつ mtime が閾値超 (stale)。
# 所有 pid が生存している限り mtime に関わらず回収しない (1h を超える正当な長時間 tick を
# 横取りして二重実行になる事故を防ぐ)。
#
# 設計制約: tick は Claude が複数の Bash 呼び出しにまたがって実行するため、fd を保持し
# 続ける flock は使えない (呼び出し間で fd が生きない)。mkdir + pid 記録 + 取得後検証で
# 近似する。取得後検証 (pid read-back) により、reclaim レースで他プロセスに lock を
# 奪われた側は取得失敗を自覚して撤退する。pid 書き込み直前の極小窓は残るが、tick 間隔
# (分単位) に対して十分小さく、シングルユーザー運用では実害がない。

# 取得後検証: lock の pid が自分であること (reclaim レースの敗者検出)
_flow_loop_lock_owned_by_self() {
  [ "$(cat "$FLOW_LOOP_LOCK/pid" 2>/dev/null || echo "")" = "$$" ]
}

flow_loop_lock() {
  mkdir -p "$FLOW_LOOP_STATE_DIR"
  if mkdir "$FLOW_LOOP_LOCK" 2>/dev/null; then
    printf '%s' "$$" > "$FLOW_LOOP_LOCK/pid" 2>/dev/null || true
    _flow_loop_lock_owned_by_self && return 0
    return 1
  fi
  local owner
  owner="$(cat "$FLOW_LOOP_LOCK/pid" 2>/dev/null || echo "")"
  case "$owner" in *[!0-9]*) owner="" ;; esac
  # 所有者が生きている → 正当な実行中。回収しない
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    return 1
  fi
  local now mtime
  now="$(date +%s)"
  # GNU (stat -c %Y) を先に試す。BSD 先行 (stat -f %m) にすると GNU stat では
  # -f がファイルシステムモードになり %m が「マウントポイント文字列」で成功してしまう
  # (mtime に /tmp が入り算術式が爆発、stale 回収も永久に効かない) ため順序が重要。
  mtime="$(stat -c %Y "$FLOW_LOOP_LOCK" 2>/dev/null || stat -f %m "$FLOW_LOOP_LOCK" 2>/dev/null || echo "$now")"
  case "$mtime" in ''|*[!0-9]*) mtime="$now" ;; esac
  if { [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; } \
     || [ $((now - mtime)) -ge "$FLOW_LOOP_LOCK_STALE_SECONDS" ]; then
    # 回収は rename (atomic) で勝者を 1 人に絞る。素の削除だと、2 つの tick が
    # 同時に stale を観測したとき、一方が取得し直した新 lock をもう一方が削除して
    # 両者とも取得成功する二重実行レースがある。mv は同一パスに対して 1 プロセスしか
    # 成功しないため、敗者はそのまま通常の mkdir 競争 (どちらか一方だけ成功) に戻る。
    local reclaim="$FLOW_LOOP_LOCK.reclaim.$$"
    if command mv "$FLOW_LOOP_LOCK" "$reclaim" 2>/dev/null; then
      # mv した dir が本当に自分が stale 判定した旧 lock か検証してから捨てる。
      # 別プロセスが先に reclaim → 新 lock を作った直後だと、その新 lock を
      # 掴んでしまう可能性があるため、生存所有者の lock なら黙って返却する
      local stolen_owner
      stolen_owner="$(cat "$reclaim/pid" 2>/dev/null || echo "")"
      case "$stolen_owner" in *[!0-9]*) stolen_owner="" ;; esac
      if [ -n "$stolen_owner" ] && [ "$stolen_owner" != "$$" ] && kill -0 "$stolen_owner" 2>/dev/null; then
        command mv "$reclaim" "$FLOW_LOOP_LOCK" 2>/dev/null || rm -rf "$reclaim"
        return 1
      fi
      rm -rf "$reclaim"
    fi
    if mkdir "$FLOW_LOOP_LOCK" 2>/dev/null; then
      printf '%s' "$$" > "$FLOW_LOOP_LOCK/pid" 2>/dev/null || true
      _flow_loop_lock_owned_by_self && return 0
    fi
  fi
  return 1
}

# 解錠は自分が所有する lock のみ。他プロセスが生存所有している lock は触らない
# (旧所有者の遅延 unlock が新所有者の lock を消して二重実行になる事故を防ぐ)。
flow_loop_unlock() {
  local owner
  owner="$(cat "$FLOW_LOOP_LOCK/pid" 2>/dev/null || echo "")"
  case "$owner" in *[!0-9]*) owner="" ;; esac
  if [ -n "$owner" ] && [ "$owner" != "$$" ] && kill -0 "$owner" 2>/dev/null; then
    return 0
  fi
  rm -rf "$FLOW_LOOP_LOCK" 2>/dev/null || true
}

# 現在のプロジェクト (repo) の git-common-dir。run の所属判定に使う。
# CLAUDE_PROJECT_DIR (loop 起動元) を基準に解決。repo 外なら空 (= 絞り込み無効)。
flow_loop_self_repo() {
  git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true
}

# run が現在のプロジェクトに属するか (別プロジェクトの run を掴まないためのフィルタ)。
# 判定は run の context.worktree_path の git-common-dir と self_repo の一致で行う。
#   - self_repo 空 (repo 外で起動)        → 真 (絞り込みしない = 旧挙動)
#   - context / worktree が解決できない    → 真 (permissive。active run は通常 worktree を持つ)
#   - worktree が別 repo                   → 偽 (掴まない)
# flow state は /tmp 共有のため、このフィルタが無いと他プロジェクトの run まで wip 算入・
# 走査・前進してしまう (クロスプロジェクト汚染。別 repo の PR を CI 判定/マージしかねない)。
_flow_loop_run_in_self_repo() {
  local key="$1" self_repo="$2" ctx wt run_repo
  [ -n "$self_repo" ] || return 0
  ctx="$FLOW_LOOP_RUNS_DIR/flow-context-$key.json"
  [ -f "$ctx" ] || return 0
  wt="$(jq -r '.worktree_path // empty' "$ctx" 2>/dev/null)" || return 0
  { [ -n "$wt" ] && [ -d "$wt" ]; } || return 0
  run_repo="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 0
  [ -n "$run_repo" ] || return 0
  [ "$run_repo" = "$self_repo" ]
}

# アクティブ run の scope_key 一覧 (progress の phase != done・かつ現プロジェクト所属)。
# WIP 算出・走査の起点。glob 展開はシェル依存 (zsh は no-match で全体がエラーになる) のため find で列挙する。
flow_loop_active_scope_keys() {
  [ -d "$FLOW_LOOP_RUNS_DIR" ] || return 0
  local f phase key self_repo
  self_repo="$(flow_loop_self_repo)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    phase="$(jq -r '.phase // empty' "$f" 2>/dev/null)" || continue
    if [ -z "$phase" ] || [ "$phase" = "done" ]; then continue; fi
    key="${f##*/flow-progress-}"
    key="${key%.json}"
    [ -n "$key" ] || continue
    # 別プロジェクトの run (worktree が別 repo) は掴まない。
    _flow_loop_run_in_self_repo "$key" "$self_repo" || continue
    printf '%s\n' "$key"
  done < <(find "$FLOW_LOOP_RUNS_DIR" -maxdepth 1 -name 'flow-progress-*.json' -type f 2>/dev/null)
  return 0
}

flow_loop_active_count() { flow_loop_active_scope_keys | grep -c . || true; }

# 稼働時間帯 (active_hours = "09-19" 形式・ローカル時刻・空なら常時可)。
# 自動起動 tick の抑制用。フィールド欠落・空 (旧 loop.json / 未設定) は常時可。
# **非空だが形式不正な値は fail-closed (稼働外扱い + stderr にエラー)**:
# 自動 pick・push・merge を抑制する安全設定なので、タイプミスで制限が
# 無効化される (fail-open) 挙動は Assertive Programming に反する。
flow_loop_within_active_hours() {
  local range start end hour
  range="$(flow_loop_read '.active_hours // ""' 2>/dev/null)" || range=""
  if [ -z "$range" ] || [ "$range" = "null" ]; then return 0; fi
  case "$range" in
    *-*) ;;
    *)
      echo "ERROR: active_hours の形式が不正です: '$range' (期待: \"HH-HH\"。tick を抑制します)" >&2
      return 1
      ;;
  esac
  start="${range%%-*}"; end="${range##*-}"
  case "$start$end" in
    ''|*[!0-9]*)
      echo "ERROR: active_hours の形式が不正です: '$range' (期待: \"HH-HH\"。tick を抑制します)" >&2
      return 1
      ;;
  esac
  if [ "$((10#$start))" -gt 24 ] || [ "$((10#$end))" -gt 24 ]; then
    echo "ERROR: active_hours の時刻が範囲外です: '$range' (0..24。tick を抑制します)" >&2
    return 1
  fi
  hour="$(date +%H)"
  # start > end は日付跨ぎ (例 "22-06" = 22時〜翌6時) として解釈する
  local h="$((10#$hour))" s="$((10#$start))" e="$((10#$end))"
  if [ "$s" -le "$e" ]; then
    [ "$h" -ge "$s" ] && [ "$h" -lt "$e" ]
  else
    [ "$h" -ge "$s" ] || [ "$h" -lt "$e" ]
  fi
}

# 1 日の新規着手予算の残数を返す。日付が変わればカウンタは自然リセット扱い。
# フィールド欠落 (旧 loop.json) は既定値 (daily_budget=3) で解釈するが、
# **非空で数値でない値は fail-closed (残 0 + stderr にエラー)**: 自動着手を抑制する
# 安全設定なので、設定ミスで既定値に戻って着手が再開する挙動を許さない (active_hours と同じ方針)。
flow_loop_pick_budget_left() {
  local budget picks pdate today
  budget="$(flow_loop_read '.daily_budget // 3' 2>/dev/null)" || budget=3
  case "$budget" in
    ''|null) budget=3 ;;
    *[!0-9]*)
      echo "ERROR: daily_budget が数値ではありません: '$budget' (新規着手を停止します)" >&2
      echo 0
      return 0
      ;;
  esac
  today="$(date +%Y-%m-%d)"
  pdate="$(flow_loop_read '.pick_date // ""' 2>/dev/null)" || pdate=""
  picks="$(flow_loop_read '.picks_today // 0' 2>/dev/null)" || picks=0
  case "$picks" in ''|null|*[!0-9]*) picks=0 ;; esac
  [ "$pdate" = "$today" ] || picks=0
  echo $((budget - picks))
}

# 新規着手 1 件を記録する (日付跨ぎはカウンタを 1 から数え直す)
flow_loop_record_pick() {
  local today; today="$(date +%Y-%m-%d)"
  flow_loop_update '.picks_today = (if (.pick_date // "") == "'"$today"'" then (.picks_today // 0) + 1 else 1 end) | .pick_date = "'"$today"'"'
}

# detached codex の生存確認 (pid が数値かつ生きていれば 0)
flow_loop_pid_alive() {
  case "${1:-}" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2>/dev/null
}

# ── 計測 (metrics) ──────────────────────────────────────────────
# run のイベントを 1 行 JSON で metrics.jsonl へ追記する。
# 記録点: pick (新規着手) / park (承認・監視待ち) / halt / merged (P11) / done (P12 terminal)。
# 既存 KPI (/tmp/flow-kpi-*.json / flow-kpi-history.jsonl) とはレイヤが別:
# KPI は run 内の自走時間、metrics.jsonl は loop 視点のイベント列 (人間待ち内訳の集計用)。

# append <work_id> <event> [<jq_object_expr>]
# extra は jq 式として評価する (キーのクォート不要。--argjson は厳密 JSON を要求するため使わない)。
# 例: flow_loop_metrics_append issue-700 halt '{reason: "CI failure", phase: "P7"}'
# extra が不正な式なら何も追記せず非 0 を返す。
flow_loop_metrics_append() {
  local work_id="${1-}" event="${2-}" extra="${3-}" line
  [ -n "$work_id" ] && [ -n "$event" ] || return 1
  [ -n "$extra" ] || extra='{}'
  line="$(jq -cn --arg t "$work_id" --arg e "$event" --argjson ts "$(date +%s)" \
    "{ts: \$ts, ticket: \$t, event: \$e} + ($extra)" 2>/dev/null)" || return 1
  [ -n "$line" ] || return 1
  mkdir -p "$FLOW_LOOP_STATE_DIR"
  printf '%s\n' "$line" >> "$FLOW_LOOP_METRICS"
}

# 直近 N 件を返す (digest 用の簡易リーダ)
flow_loop_metrics_tail() {
  [ -f "$FLOW_LOOP_METRICS" ] || return 0
  tail -n "${1:-20}" "$FLOW_LOOP_METRICS"
}

# ── 承認/レビューシグナルの鮮度判定 (必ず epoch=UTC秒 で比較する) ──
# 背景: HEAD を `git log --format=%cI` (`...+09:00` ローカルオフセット) で取り、GitHub API の
# `createdAt`/`submittedAt` (`...Z`=UTC) と ISO 文字列で大小比較すると誤判定する。
# 例 HEAD `09:54:31+09:00`(=00:54:31Z) vs コメント `01:23:50Z` は、実時刻ではコメントが後なのに
# 文字列比較では `01`<`09` で「前」と判定され、有効な承認が取りこぼされる。必ず epoch で比較する。

# ISO8601 (末尾 Z または +hh:mm) → unix epoch (UTC秒)。BSD/macOS date と GNU date の両対応。
flow_iso_to_epoch() {
  local iso="${1-}" norm
  [ -n "$iso" ] || return 1
  # `Z`→`+0000`、`+hh:mm`→`+hhmm` (BSD の %z はコロン無しを要求する)
  norm="$(printf '%s' "$iso" | sed 's/Z$/+0000/; s/\([+-][0-9][0-9]\):\([0-9][0-9]\)$/\1\2/')"
  date -j -f "%Y-%m-%dT%H:%M:%S%z" "$norm" +%s 2>/dev/null && return 0   # BSD/macOS
  date -d "$iso" +%s 2>/dev/null && return 0                             # GNU
  return 1
}

# worktree の HEAD commit の committer epoch (鮮度の基準時刻)。
flow_head_epoch() { git -C "${1:?worktree}" log -1 --format=%ct 2>/dev/null; }

# シグナル時刻(ISO) が基準 epoch より後か。0=fresh (後・有効) / 1=stale (前・無効)。
# 使い方: flow_signal_after "$comment_createdAt" "$(flow_head_epoch "$WORKTREE_PATH")"
flow_signal_after() {
  local sig_iso="${1-}" base_epoch="${2-}" se
  se="$(flow_iso_to_epoch "$sig_iso")" || return 1
  [ -n "$se" ] && [ -n "$base_epoch" ] && [ "$se" -gt "$base_epoch" ]
}
