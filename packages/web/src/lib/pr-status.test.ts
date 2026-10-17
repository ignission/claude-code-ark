import type { SessionPrStatus } from "@ark/shared";
import { describe, expect, it } from "vitest";
import { mergePrStatuses, prBadge } from "./pr-status";

const status = (over: Partial<SessionPrStatus> = {}): SessionPrStatus => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  isDraft: false,
  checks: "pending",
  headRefOid: "h1",
  ...over,
});

describe("mergePrStatuses", () => {
  it("変わらなければ同じMapを返す (一覧を描き直さない)", () => {
    const prev = new Map([["a", status()]]);
    expect(
      mergePrStatuses(prev, [{ sessionId: "a", prStatus: status() }])
    ).toBe(prev);
  });

  it("変われば新しいMapにし、nullなら消し、previewsに無いセッションは残す", () => {
    const prev = new Map([
      ["a", status()],
      ["b", status({ number: 8 })],
      ["c", status({ number: 9 })],
    ]);
    const next = mergePrStatuses(prev, [
      { sessionId: "a", prStatus: status({ checks: "failed" }) },
      { sessionId: "b", prStatus: null },
    ]);
    expect(next).not.toBe(prev);
    expect(next.get("a")?.checks).toBe("failed");
    expect(next.has("b")).toBe(false);
    expect(next.get("c")?.number).toBe(9);
  });
});

describe("prBadge", () => {
  it("チェックの結果を出し、落ちたときだけ色を付ける", () => {
    expect(prBadge(status({ checks: "failed" }))).toMatchObject({
      text: "#7 ✕",
      tone: "ng",
    });
    expect(prBadge(status({ checks: "passed" }))).toMatchObject({
      text: "#7 ✓",
      tone: "ok",
    });
    expect(prBadge(status())).toMatchObject({ text: "#7 待ち", tone: "wait" });
    expect(prBadge(status({ checks: "none" })).text).toBe("#7");
  });

  it("マージ済み・クローズはチェックより先に出す", () => {
    expect(
      prBadge(status({ state: "MERGED", checks: "failed" }))
    ).toMatchObject({ text: "#7 マージ済み", tone: "muted" });
    expect(prBadge(status({ state: "CLOSED" })).text).toBe("#7 クローズ");
  });
});
