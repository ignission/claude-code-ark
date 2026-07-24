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
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOOP_LIB="$SCRIPT_DIR/../lib/loop.sh"

TMP_STATE="$(mktemp -d)"
TMP_RUNS="$(mktemp -d)"
TMP_XDG="$(mktemp -d)"
trap 'rm -rf "$TMP_STATE" "$TMP_RUNS" "$TMP_XDG"' EXIT
export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
export FLOW_LOOP_STATE_DIR="$TMP_STATE"
export FLOW_LOOP_RUNS_DIR="$TMP_RUNS"

# shellcheck source=/dev/null
source "$LOOP_LIB"
set +e  # loop.sh の set -e をテストランナー側では解除 (FAIL しても継続する)

echo "=== directory resolution / override priority ==="
DEFAULT_XDG="$TMP_XDG/default"
mkdir -m 700 "$DEFAULT_XDG"
DEFAULT_RESULT=$(env -u FLOW_STATE_DIR -u FLOW_LOOP_STATE_DIR -u FLOW_LOOP_RUNS_DIR \
  XDG_RUNTIME_DIR="$DEFAULT_XDG" CLAUDE_PROJECT_DIR="$PROJECT_DIR" \
  bash -c '
    source "$CLAUDE_PROJECT_DIR/.claude/skills/flow-loop/lib/loop.sh" || exit 1
    expected="$XDG_RUNTIME_DIR/ark-flow-$(id -u)"
    if [ "$FLOW_LOOP_STATE_DIR" != "$expected" ] || [ "$FLOW_LOOP_RUNS_DIR" != "$expected" ]; then
      printf "%s|%s||\n" "$FLOW_LOOP_STATE_DIR" "$FLOW_LOOP_RUNS_DIR"
      exit 0
    fi
    flow_loop_init || exit 2
    flow_loop_lock || exit 3
    [ -f "$FLOW_LOOP_LOCK/pid" ] || exit 4
    flow_loop_unlock
    touch "$FLOW_LOOP_STOP"
    flow_loop_metrics_append issue-default park "{}" || exit 5
    printf "%s|%s|%s|%s\n" "$FLOW_LOOP_STATE_DIR" "$FLOW_LOOP_RUNS_DIR" \
      "$([ -f "$FLOW_LOOP_JSON" ] && echo json)" \
      "$([ -f "$FLOW_LOOP_STOP" ] && [ -f "$FLOW_LOOP_METRICS" ] && echo artifacts)"
  ' 2>/dev/null)
EXPECTED_DEFAULT="$DEFAULT_XDG/ark-flow-$(id -u)"
assert_eq "override 無しでは loop/run とも XDG secure default を使う" \
  "$EXPECTED_DEFAULT|$EXPECTED_DEFAULT|json|artifacts" "$DEFAULT_RESULT"

COMMON_DIR="$TMP_XDG/common"
LIMITED_STATE_DIR="$TMP_XDG/limited-state"
LIMITED_RUNS_DIR="$TMP_XDG/limited-runs"
mkdir -m 700 "$COMMON_DIR" "$LIMITED_STATE_DIR" "$LIMITED_RUNS_DIR"
PRIORITY_RESULT=$(FLOW_STATE_DIR="$COMMON_DIR" \
  FLOW_LOOP_STATE_DIR="$LIMITED_STATE_DIR" FLOW_LOOP_RUNS_DIR="$LIMITED_RUNS_DIR" \
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" bash -c '
    source "$CLAUDE_PROJECT_DIR/.claude/skills/flow-loop/lib/loop.sh"
    printf "%s|%s\n" "$FLOW_LOOP_STATE_DIR" "$FLOW_LOOP_RUNS_DIR"
  ' 2>/dev/null)
assert_eq "限定 override は共通 FLOW_STATE_DIR より優先される" \
  "$LIMITED_STATE_DIR|$LIMITED_RUNS_DIR" "$PRIORITY_RESULT"

COMMON_RESULT=$(FLOW_STATE_DIR="$COMMON_DIR" \
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" bash -c '
    unset FLOW_LOOP_STATE_DIR FLOW_LOOP_RUNS_DIR
    source "$CLAUDE_PROJECT_DIR/.claude/skills/flow-loop/lib/loop.sh"
    printf "%s|%s\n" "$FLOW_LOOP_STATE_DIR" "$FLOW_LOOP_RUNS_DIR"
  ' 2>/dev/null)
assert_eq "限定 override 未指定時は loop/run とも共通 FLOW_STATE_DIR を使う" \
  "$COMMON_DIR|$COMMON_DIR" "$COMMON_RESULT"

UNSAFE_XDG="$TMP_XDG/unsafe"
mkdir -m 700 "$UNSAFE_XDG"
mkdir -m 755 "$UNSAFE_XDG/ark-flow-$(id -u)"
assert_rc "mode 0755 の自動既定候補では init が fail closed" 1 \
  "env -u FLOW_STATE_DIR -u FLOW_LOOP_STATE_DIR -u FLOW_LOOP_RUNS_DIR XDG_RUNTIME_DIR='$UNSAFE_XDG' CLAUDE_PROJECT_DIR='$PROJECT_DIR' bash -c 'source \"\$CLAUDE_PROJECT_DIR/.claude/skills/flow-loop/lib/loop.sh\" || exit 1; expected=\"\$XDG_RUNTIME_DIR/ark-flow-\$(id -u)\"; [ \"\$FLOW_LOOP_STATE_DIR\" = \"\$expected\" ] || exit 0; flow_loop_init'"
assert_rc "mode 0755 の自動既定候補では lock も fail closed" 1 \
  "env -u FLOW_STATE_DIR -u FLOW_LOOP_STATE_DIR -u FLOW_LOOP_RUNS_DIR XDG_RUNTIME_DIR='$UNSAFE_XDG' CLAUDE_PROJECT_DIR='$PROJECT_DIR' bash -c 'source \"\$CLAUDE_PROJECT_DIR/.claude/skills/flow-loop/lib/loop.sh\" || exit 1; expected=\"\$XDG_RUNTIME_DIR/ark-flow-\$(id -u)\"; [ \"\$FLOW_LOOP_STATE_DIR\" = \"\$expected\" ] || exit 0; flow_loop_lock'"

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
# stale lock の回収 (pid 不明 + mtime を 2h 前にする)
mkdir -p "$FLOW_LOOP_LOCK"
if touch -t "$(date -v-2H +%Y%m%d%H%M 2>/dev/null || date -d '2 hours ago' +%Y%m%d%H%M)" "$FLOW_LOOP_LOCK" 2>/dev/null; then
  assert_rc "stale lock (pid 不明・2h 前) は回収して取得できる" 0 'flow_loop_lock'
  flow_loop_unlock
else
  echo "WARN: touch -t 不可 → stale lock テストを skip"
  rm -rf "$FLOW_LOOP_LOCK"
fi
# 所有者 pid ベースの回収判定
mkdir -p "$FLOW_LOOP_LOCK"; printf '%s' "999999" > "$FLOW_LOOP_LOCK/pid"
assert_rc "所有 pid が死んでいる lock は mtime に関わらず即回収できる" 0 'flow_loop_lock'
flow_loop_unlock
mkdir -p "$FLOW_LOOP_LOCK"; printf '%s' "$$" > "$FLOW_LOOP_LOCK/pid"
if touch -t "$(date -v-2H +%Y%m%d%H%M 2>/dev/null || date -d '2 hours ago' +%Y%m%d%H%M)" "$FLOW_LOOP_LOCK" 2>/dev/null; then
  assert_rc "所有 pid が生存中なら mtime が stale でも横取りしない" 1 'flow_loop_lock'
fi
# 所有者が自分 (生存) の lock は unlock で消える (後始末を兼ねる)
flow_loop_unlock
assert_rc "自分所有の lock は unlock で消える" 1 '[ -d "$FLOW_LOOP_LOCK" ]'

# --- アクティブ run 列挙 (state-io.sh の progress ファイル形式を模す) ---
printf '{"phase":"P3","ticket":"issue-1"}' > "$TMP_RUNS/flow-progress-issue-1.json"
printf '{"phase":"P10","ticket":"issue-2"}' > "$TMP_RUNS/flow-progress-issue-2.json"
printf '{"note":"progress ではないファイルは数えない"}' > "$TMP_RUNS/flow-kpi-issue-1.json"
assert_eq "progress 2 件で active=2 (kpi/context は数えない)" "2" "$(flow_loop_active_count)"
printf '{"phase":"done","ticket":"issue-2"}' > "$TMP_RUNS/flow-progress-issue-2.json"
assert_eq "phase=done は active に数えない" "1" "$(flow_loop_active_count)"
assert_eq "active_scope_keys は scope_key を返す" "issue-1" "$(flow_loop_active_scope_keys)"

# --- クロスプロジェクト分離 (別 repo の run を掴まない) ---
# flow state は /tmp 共有なので、active_scope は「現プロジェクト所属の run」だけを返すべき。
# 別 repo の worktree を持つ run を掴むと、別プロジェクトの PR を CI 判定/マージしかねない。
REPO_A="$TMP_RUNS/repo-a"; REPO_B="$TMP_RUNS/repo-b"
git init -q "$REPO_A"; git init -q "$REPO_B"
printf '{"phase":"P3"}' > "$TMP_RUNS/flow-progress-run-a.json"
printf '{"worktree_path":"%s"}' "$REPO_A" > "$TMP_RUNS/flow-context-run-a.json"
printf '{"phase":"P3"}' > "$TMP_RUNS/flow-progress-run-b.json"
printf '{"worktree_path":"%s"}' "$REPO_B" > "$TMP_RUNS/flow-context-run-b.json"
# 現プロジェクト = repo-a。run-a (同 repo) と context 無しの issue-1 (permissive) は出て、
# run-b (別 repo) は出ない。
_scope="$(CLAUDE_PROJECT_DIR="$REPO_A" flow_loop_active_scope_keys | sort | tr '\n' ',')"
assert_eq "別 repo の run は active_scope に出ない (現 repo + permissive のみ)" "issue-1,run-a," "$_scope"
# 後片付け (以降の active 系テストに影響させない)
rm -f "$TMP_RUNS/flow-progress-run-a.json" "$TMP_RUNS/flow-context-run-a.json" \
      "$TMP_RUNS/flow-progress-run-b.json" "$TMP_RUNS/flow-context-run-b.json"

# --- 稼働時間帯 ---
flow_loop_update '.active_hours = ""'
assert_rc "active_hours 空は常時可" 0 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = "00-24"'
assert_rc "00-24 は常に範囲内" 0 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = "00-00"'
assert_rc "00-00 は常に範囲外" 1 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = "9x-19"'
assert_rc "形式不正は fail-closed (稼働外扱い。安全設定のタイプミスで制限が消えない)" 1 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = "0919"'
assert_rc "区切り無しも fail-closed" 1 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = "09-99"'
assert_rc "時刻範囲外 (99) も fail-closed" 1 'flow_loop_within_active_hours'
# 日付跨ぎ (start > end) は「start 以降 または end 未満」として解釈する
flow_loop_update '.active_hours = "00-24"'
_NOW_H="$(date +%H)"
flow_loop_update '.active_hours = "'"$_NOW_H"'-'"$_NOW_H"'"'  # 現在時-現在時 (同値) は範囲外
assert_rc "start=end は常に範囲外" 1 'flow_loop_within_active_hours'
# 現在時刻を必ず含む日付跨ぎ範囲 (現在時+1 → 現在時-…では複雑なので、跨ぎ判定の両側を直接検証)
_H1=$(( (10#$_NOW_H + 1) % 24 )); _H1=$(printf '%02d' "$_H1")
flow_loop_update '.active_hours = "'"$_H1"'-'"$_NOW_H"'"'
# start=now+1 > end=now: 跨ぎ範囲 [now+1, 24) ∪ [0, now)。現在時 now はどちらにも入らない
assert_rc "日付跨ぎ範囲で現在時刻が範囲外なら偽" 1 'flow_loop_within_active_hours'
flow_loop_update '.active_hours = "'"$_NOW_H"'-'"$_H1"'"' 2>/dev/null || true
# 通常範囲 [now, now+1) は現在時刻を含む… now=23 のとき end=00 で跨ぎ扱いになるが
# 跨ぎ解釈 [23,24)∪[0,0) でも 23 時は真になるため両解釈で成立する
assert_rc "現在時刻を含む範囲 (跨ぎ解釈含む) は真" 0 'flow_loop_within_active_hours'
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
# 非空で数値でない daily_budget は fail-closed (残 0。設定ミスで自動着手が再開しない)
flow_loop_update '.daily_budget = "off"'
assert_eq "daily_budget 不正値は fail-closed (残 0)" "0" "$(flow_loop_pick_budget_left 2>/dev/null)"
flow_loop_update '.daily_budget = 3'

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
  if zsh -c "export CLAUDE_PROJECT_DIR='$PROJECT_DIR'; export FLOW_LOOP_STATE_DIR='$ZTMP'; export FLOW_LOOP_RUNS_DIR='$TMP_RUNS'; \
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
