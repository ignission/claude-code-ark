#!/usr/bin/env bash
# metrics.jsonl から run 別のリードタイム内訳 (人間待ち vs 機械時間) を集計する。
# 使い方: bash report.sh [metrics.jsonl のパス]
#
# 待ち時間の定義: 人間の判断シグナル (plan-approved / merged / fix) ごとに、その直前の
# 人間ゲート park (gate=plan-review|merge-review) からの経過を積算する。既存 KPI
# (/flow --kpi、自走時間 4 指標) とはレイヤが別で、こちらは loop 視点の
# 「マージ 1 件に人間を何分待ったか」を見る。
# 差し戻し修正に要した機械時間も直前 park からの区間に含まれるため、待ち時間はやや過大に出る (v1 の近似)。
set -euo pipefail

METRICS="${1:-${FLOW_LOOP_STATE_DIR:-/tmp}/flow-loop-metrics.jsonl}"
[ -f "$METRICS" ] || { echo "metrics ファイルが見つかりません: $METRICS" >&2; exit 1; }

jq -s -r '
  def human_parks: map(select(.event == "park" and (.gate == "plan-review" or .gate == "merge-review")));
  group_by(.ticket) | map(
    . as $ev |
    ($ev | map(select(.event == "pick")) | first) as $pick |
    ($ev | map(select(.event == "done")) | first) as $done |
    select($pick != null and $done != null) |
    ([ $ev[] | select(.event == "plan-approved" or .event == "merged" or .event == "fix") | . as $sig |
       ($ev | human_parks | map(select(.ts < $sig.ts)) | sort_by(.ts) | last) as $park |
       if $park != null then ($sig.ts - $park.ts) else 0 end
     ] | add // 0) as $wait |
    (($done.ts - $pick.ts)) as $total |
    { ticket: $pick.ticket,
      totalMin: ($total / 60 | floor),
      waitMin: ($wait / 60 | floor),
      machineMin: (($total - $wait) / 60 | floor),
      waitPct: (if $total > 0 then (100 * $wait / $total | floor) else 0 end) }
  ) |
  (["TICKET", "TOTAL_MIN", "WAIT_MIN", "MACHINE_MIN", "WAIT_PCT"] | @tsv),
  (.[] | [.ticket, .totalMin, .waitMin, .machineMin, .waitPct] | @tsv)
' "$METRICS" | column -t
