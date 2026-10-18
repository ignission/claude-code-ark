import type { PlanLimits } from "@ark/shared";
import { describe, expect, it } from "vitest";
import { formatResetAt, mergePlanLimits, planLimitRows } from "./plan-limits";

const limits = (five: number, week: number): PlanLimits => ({
  fiveHour: { percent: five, resetsAt: "2026-10-17T19:40:00" },
  sevenDay: { percent: week, resetsAt: "2026-10-20T03:00:00" },
});

describe("mergePlanLimits", () => {
  it("変わらなければ同じMapを返す (入力欄を描き直さない)", () => {
    const prev = new Map([["a", limits(10, 20)]]);
    expect(
      mergePlanLimits(prev, [{ sessionId: "a", planLimits: limits(10, 20) }])
    ).toBe(prev);
  });

  it("変われば新しいMapにし、nullなら消す", () => {
    const prev = new Map([
      ["a", limits(10, 20)],
      ["b", limits(1, 2)],
    ]);
    const next = mergePlanLimits(prev, [
      { sessionId: "a", planLimits: limits(11, 20) },
      { sessionId: "b", planLimits: null },
    ]);
    expect(next).not.toBe(prev);
    expect(next.get("a")?.fiveHour?.percent).toBe(11);
    expect(next.has("b")).toBe(false);
  });
});

describe("formatResetAt", () => {
  const now = new Date("2026-10-17T12:00:00");

  it("今日なら時刻だけ、別の日なら日付も付ける", () => {
    expect(formatResetAt("2026-10-17T19:05:00", now)).toBe("19:05");
    expect(formatResetAt("2026-10-20T03:00:00", now)).toBe("10/20 3:00");
  });

  it("無い、読めない、は null", () => {
    expect(formatResetAt(null, now)).toBeNull();
    expect(formatResetAt("x", now)).toBeNull();
  });
});

describe("planLimitRows", () => {
  const now = new Date("2026-10-17T12:00:00");

  it("値のある枠だけを並べ、80%を超えた枠を高いとする", () => {
    const rows = planLimitRows(
      { fiveHour: { percent: 80.2, resetsAt: null }, sevenDay: null },
      now
    );
    expect(rows).toEqual([
      { short: "5h", name: "5時間枠", percent: 80, resetAt: null, high: true },
    ]);
  });

  it("丸める前の値で判定する (79.5%と80%ちょうどは高くない)", () => {
    for (const percent of [79.5, 80]) {
      const [row] = planLimitRows(
        { fiveHour: { percent, resetsAt: null }, sevenDay: null },
        now
      );
      expect(row?.high).toBe(false);
    }
  });

  it("リセット時刻を過ぎた枠は出さない (切断中に古い値が残っても)", () => {
    const rows = planLimitRows(
      {
        fiveHour: { percent: 90, resetsAt: "2026-10-17T11:00:00" },
        sevenDay: { percent: 13, resetsAt: "2026-10-20T03:00:00" },
      },
      now
    );
    expect(rows.map(r => r.short)).toEqual(["週"]);
  });

  it("両方あれば5時間枠、週枠の順", () => {
    expect(planLimitRows(limits(5, 13), now).map(r => r.short)).toEqual([
      "5h",
      "週",
    ]);
  });
});
