#!/bin/bash
# =============================================================================
# .claude/skills/flow-loop/lib/loop.sh のテスト
# 一時ディレクトリを FLOW_LOOP_STATE_DIR / FLOW_LOOP_RUNS_DIR にして hermetic に実行する
# =============================================================================
set -uo pipefail

TESTS=0
PASSES=0
FAILURES=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

assert_eq() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  TESTS=$((TESTS + 1))
  if [ "$expected" = "$actual" ]; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description"
    echo "  expected: $expected"
    echo "  actual:   $actual"
  fi
}

# コマンド (eval) の終了コードを検証する。expected_rc=0 で「成功するはず」、非 0 で「失敗するはず」
assert_rc() {
  local description="$1"
  local expected_rc="$2"
  local cmd="$3"
  TESTS=$((TESTS + 1))
  eval "$cmd" >/dev/null 2>&1
  local rc=$?
  local ok
  if [ "$expected_rc" = "0" ]; then
    [ "$rc" -eq 0 ] && ok=1 || ok=0
  else
    [ "$rc" -ne 0 ] && ok=1 || ok=0
  fi
  if [ "$ok" = "1" ]; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description (rc=$rc, expected ${expected_rc}=0?成功:失敗)"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOOP_LIB="$SCRIPT_DIR/../lib/loop.sh"

TMP_STATE="$(mktemp -d)"
TMP_RUNS="$(mktemp -d)"
trap 'rm -rf "$TMP_STATE" "$TMP_RUNS"' EXIT
export FLOW_LOOP_STATE_DIR="$TMP_STATE"
export FLOW_LOOP_RUNS_DIR="$TMP_RUNS"

# shellcheck source=/dev/null
source "$LOOP_LIB"
set +e  # loop.sh の set -e をテストランナー側では解除 (FAIL しても継続する)

# --- init (冪等) ---
flow_loop_init
assert_rc "init で loop.json が作られる" 0 '[ -f "$FLOW_LOOP_JSON" ]'
assert_eq "既定 wip_limit は 2" "2" "$(flow_loop_read '.wip_limit')"
assert_eq "既定 engine は codex" "codex" "$(flow_loop_read '.engine')"
assert_rc "既定 pick_query が入る" 0 '[ -n "$(flow_loop_read ".pick_query")" ]'
flow_loop_update '.wip_limit = 5'
flow_loop_init
assert_eq "init は既存 loop.json を上書きしない (冪等)" "5" "$(flow_loop_read '.wip_limit')"

# --- update は command mv 経由 (mv -i エイリアス・関数シャドウの回帰) ---
mv() { echo "refusing overwrite (simulated mv -i)" >&2; return 1; }
flow_loop_update '.consecutive_halts = 1'
assert_eq "mv を関数で隠しても update が永続化される" "1" "$(flow_loop_read '.consecutive_halts')"
unset -f mv

# --- ブレーカー ---
assert_rc "halt 1 回ではブレーカー未作動" 1 'flow_loop_breaker_tripped'
flow_loop_update '.consecutive_halts = 3'
assert_rc "連続 halt 3 でブレーカー作動" 0 'flow_loop_breaker_tripped'
flow_loop_update '.consecutive_halts = 0'
assert_rc "リセットで解除" 1 'flow_loop_breaker_tripped'

# --- kill switch ---
assert_rc "初期は停止フラグなし" 1 'flow_loop_stopped'
touch "$FLOW_LOOP_STOP"
assert_rc "loop-stop で停止判定" 0 'flow_loop_stopped'
rm -f "$FLOW_LOOP_STOP"
assert_rc "rm で再開" 1 'flow_loop_stopped'

# --- lock (多重 tick 防止) ---
assert_rc "lock を取得できる" 0 'flow_loop_lock'
assert_rc "取得中は 2 重取得できない" 1 'flow_loop_lock'
flow_loop_unlock
assert_rc "unlock 後は再取得できる" 0 'flow_loop_lock'
flow_loop_unlock
# stale lock の回収 (mtime を 2h 前にする)
mkdir -p "$FLOW_LOOP_LOCK"
if touch -t "$(date -v-2H +%Y%m%d%H%M 2>/dev/null || date -d '2 hours ago' +%Y%m%d%H%M)" "$FLOW_LOOP_LOCK" 2>/dev/null; then
  assert_rc "stale lock (2h 前) は回収して取得できる" 0 'flow_loop_lock'
  flow_loop_unlock
else
  echo "WARN: touch -t 不可 → stale lock テストを skip"
  rm -rf "$FLOW_LOOP_LOCK"
fi

# --- アクティブ run 列挙 (state-io.sh の progress ファイル形式を模す) ---
printf '{"phase":"P3","ticket":"issue-1"}' > "$TMP_RUNS/flow-progress-issue-1.json"
printf '{"phase":"P10","ticket":"issue-2"}' > "$TMP_RUNS/flow-progress-issue-2.json"
printf '{"note":"progress ではないファイルは数えない"}' > "$TMP_RUNS/flow-kpi-issue-1.json"
assert_eq "progress 2 件で active=2 (kpi/context は数えない)" "2" "$(flow_loop_active_count)"
printf '{"phase":"done","ticket":"issue-2"}' > "$TMP_RUNS/flow-progress-issue-2.json"
assert_eq "phase=done は active に数えない" "1" "$(flow_loop_active_count)"
assert_eq "active_scope_keys は scope_key を返す" "issue-1" "$(flow_loop_active_scope_keys)"

# --- 稼働時間帯 ---
flow_loop_update '.active_hours = ""'
assert_rc "active_hours 空は常時可" 0 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = "00-24"'
assert_rc "00-24 は常に範囲内" 0 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = "00-00"'
assert_rc "00-00 は常に範囲外" 1 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = "9x-19"'
assert_rc "形式不正は fail-open (常時可)" 0 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = ""'

# --- 新規着手予算 (日次) ---
flow_loop_update '.daily_budget = 2 | .picks_today = 0 | .pick_date = ""'
assert_eq "初期残数は daily_budget" "2" "$(flow_loop_pick_budget_left)"
flow_loop_record_pick
assert_eq "record_pick で残が減る" "1" "$(flow_loop_pick_budget_left)"
flow_loop_record_pick
assert_eq "予算到達で残 0" "0" "$(flow_loop_pick_budget_left)"
flow_loop_update '.pick_date = "2000-01-01"'
assert_eq "日付が変わると予算は自然リセット" "2" "$(flow_loop_pick_budget_left)"
flow_loop_record_pick
assert_eq "日付跨ぎの record_pick はカウンタを 1 から数え直す" "1" "$(flow_loop_read '.picks_today')"
# 旧 loop.json (フィールド欠落) でも既定値で動く
flow_loop_update 'del(.daily_budget, .picks_today, .pick_date, .active_hours)'
assert_eq "フィールド欠落は既定予算 3 で解釈" "3" "$(flow_loop_pick_budget_left)"
assert_rc "フィールド欠落の active_hours は常時可" 0 'flow_loop_within_active_hours'

# --- detached codex の生存確認 ---
assert_rc "自プロセスは alive" 0 'flow_loop_pid_alive "$$"'
assert_rc "存在しない pid は dead" 1 'flow_loop_pid_alive "999999"'
assert_rc "空 pid は dead" 1 'flow_loop_pid_alive ""'
assert_rc "非数値 pid は dead" 1 'flow_loop_pid_alive "abc"'

# --- 計測 (metrics.jsonl) ---
flow_loop_metrics_append "issue-1" "park" '{gate: "merge-review"}'
flow_loop_metrics_append "issue-1" "done" '{leadTimeSec: 120, deploy_status: "success"}'
assert_eq "metrics に 2 イベント追記" "2" "$(wc -l < "$FLOW_LOOP_METRICS" | tr -d ' ')"
assert_eq "event が記録される" "done" "$(tail -1 "$FLOW_LOOP_METRICS" | jq -r '.event')"
assert_eq "追加フィールドがマージされる" "120" "$(tail -1 "$FLOW_LOOP_METRICS" | jq -r '.leadTimeSec')"
assert_rc "全行が valid JSON (JSONL)" 0 'jq -es . "$FLOW_LOOP_METRICS" >/dev/null'
assert_rc "ticket 空は拒否" 1 'flow_loop_metrics_append "" "done"'
assert_rc "不正な extra は追記せず失敗" 1 'flow_loop_metrics_append "issue-1" "x" "not a valid expr ("'
assert_eq "失敗時に行が増えない" "2" "$(wc -l < "$FLOW_LOOP_METRICS" | tr -d ' ')"
assert_eq "metrics_tail が直近を返す" "done" "$(flow_loop_metrics_tail 1 | jq -r '.event')"

# --- 実行シェル非依存の回帰: zsh で source しても壊れない ---
# (BASH_SOURCE 依存のパス解決だと zsh で空になり全機能が壊れる)
if command -v zsh >/dev/null 2>&1; then
  ZTMP="$(mktemp -d)"
  if zsh -c "export FLOW_LOOP_STATE_DIR='$ZTMP'; export FLOW_LOOP_RUNS_DIR='$TMP_RUNS'; \
       source '$LOOP_LIB' \
       && flow_loop_init && flow_loop_lock && flow_loop_unlock \
       && [ \"\$(flow_loop_read '.wip_limit')\" = '2' ] \
       && flow_loop_active_scope_keys >/dev/null" >/dev/null 2>&1; then
    TESTS=$((TESTS + 1)); PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: zsh で source しても init/lock/read/active_scope_keys が動く"
  else
    TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: zsh 互換 (source 後の基本操作)"
  fi
  rm -rf "$ZTMP"
else
  echo "WARN: zsh 不在 → zsh 互換テストを skip"
fi

# --- 鮮度判定 (epoch 比較)。TZ 差の文字列比較バグ回帰防止 ---
assert_eq "Z 表記の ISO を UTC epoch へ変換" "1783560230" "$(flow_iso_to_epoch '2026-07-09T01:23:50Z')"
assert_eq "+09:00 表記でも同一 UTC 時刻は同じ epoch" "1783560230" "$(flow_iso_to_epoch '2026-07-09T10:23:50+09:00')"
# HEAD=00:54:31Z (=09:54:31+09:00) より後の 01:23:50Z を fresh と判定できる
# (ISO 文字列比較だと '01'<'09' で誤って stale になる並び)
HEAD_EP="$(flow_iso_to_epoch '2026-07-09T09:54:31+09:00')"
assert_rc "TZ 差 (+09:00 HEAD vs Z 承認) でも epoch で後を fresh 判定" 0 "flow_signal_after '2026-07-09T01:23:50Z' '$HEAD_EP'"
assert_rc "HEAD より前の時刻は stale" 1 "flow_signal_after '2026-07-09T00:00:00Z' '$HEAD_EP'"
assert_rc "空シグナルは stale (安全側)" 1 "flow_signal_after '' '$HEAD_EP'"

echo ""
echo "=== 結果: $PASSES/$TESTS PASS ==="
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
