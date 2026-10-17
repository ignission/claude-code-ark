/**
 * プランの使用量 (5時間枠と週枠) を、入力欄の横のコンテキストのリングの隣に出す。
 *
 * 枠を使い切る前に気づけるようにする。2行の小さな文字で割合を出し、
 * 押すとリセット時刻に切り替わる (モバイルでは title が出ないので、押して見せる)。
 * 80%を超えた枠だけ色を変える。
 */

import type { PlanLimits } from "@ark/shared";
import { useState } from "react";
import { planLimitRows } from "@/lib/plan-limits";

export function PlanLimitsBadge({ limits }: { limits: PlanLimits }) {
  const [showReset, setShowReset] = useState(false);
  const rows = planLimitRows(limits, new Date());
  if (rows.length === 0) return null;
  const label = rows
    .map(
      r =>
        `${r.name} ${r.percent}%${r.resetAt ? ` (${r.resetAt}にリセット)` : ""}`
    )
    .join("、");
  return (
    <button
      type="button"
      onClick={() => setShowReset(v => !v)}
      aria-label={`プランの使用量: ${label}`}
      title={label}
      data-testid="plan-limits-badge"
      className="flex shrink-0 flex-col items-start self-center text-[10px] text-muted-foreground leading-tight tabular-nums"
    >
      {rows.map(r => (
        <span
          key={r.short}
          className={`whitespace-nowrap ${r.high ? "text-destructive" : ""}`}
        >
          {r.short} {showReset ? (r.resetAt ?? "-") : `${r.percent}%`}
        </span>
      ))}
    </button>
  );
}
