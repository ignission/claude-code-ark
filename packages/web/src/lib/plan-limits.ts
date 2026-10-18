/**
 * プランの使用量 (5時間枠と週枠) の表示の決まり。
 * 値はサーバーが使用量APIから読んで session:previews で配る (`plan-limits-collector.ts`)
 */

import type { PlanLimits, PlanLimitWindow } from "@ark/shared";

/** これを超えたら色を変える */
export const PLAN_LIMIT_HIGH_PERCENT = 80;

function sameWindow(a: PlanLimitWindow | null, b: PlanLimitWindow | null) {
  if (a === null || b === null) return a === b;
  return a.percent === b.percent && a.resetsAt === b.resetsAt;
}

/**
 * previews の値を Map に取り込む。変わらなければ prev をそのまま返す
 * (previews は毎秒届くので、毎回 Map を作ると入力欄まで描画し直す)
 */
export function mergePlanLimits(
  prev: ReadonlyMap<string, PlanLimits>,
  previews: ReadonlyArray<{ sessionId: string; planLimits?: PlanLimits | null }>
): Map<string, PlanLimits> {
  let next: Map<string, PlanLimits> | null = null;
  for (const { sessionId, planLimits } of previews) {
    const current = prev.get(sessionId);
    if (planLimits) {
      if (
        current &&
        sameWindow(current.fiveHour, planLimits.fiveHour) &&
        sameWindow(current.sevenDay, planLimits.sevenDay)
      )
        continue;
      next ??= new Map(prev);
      next.set(sessionId, planLimits);
    } else if (current) {
      next ??= new Map(prev);
      next.delete(sessionId);
    }
  }
  return next ?? (prev as Map<string, PlanLimits>);
}

/** リセット時刻。今日なら時刻だけ、別の日なら日付も付ける */
export function formatResetAt(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const hm = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  return at.toDateString() === now.toDateString()
    ? hm
    : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}

export interface PlanLimitRow {
  /** 短い名前 (`5h` / `週`) */
  short: string;
  /** 読み上げと title に使う名前 */
  name: string;
  percent: number;
  resetAt: string | null;
  high: boolean;
}

/**
 * 出す枠の一覧。値の無い枠と、リセット時刻を過ぎた枠は出さない
 * (切断中は previews が届かず、サーバーが落とした古い値が残るため、表示側でも判定する)
 */
export function planLimitRows(limits: PlanLimits, now: Date): PlanLimitRow[] {
  const rows: PlanLimitRow[] = [];
  const add = (short: string, name: string, w: PlanLimitWindow | null) => {
    if (!w) return;
    if (w.resetsAt && Date.parse(w.resetsAt) <= now.getTime()) return;
    const percent = Math.round(w.percent);
    rows.push({
      short,
      name,
      percent,
      resetAt: formatResetAt(w.resetsAt, now),
      // 丸める前の値で判定する (79.5%を80%と見なさない)
      high: w.percent > PLAN_LIMIT_HIGH_PERCENT,
    });
  };
  add("5h", "5時間枠", limits.fiveHour);
  add("週", "週枠", limits.sevenDay);
  return rows;
}
