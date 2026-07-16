import { describe, expect, it } from "vitest";
import { publishBoardInsert, subscribeBoardInserts } from "./board-bus";

describe("board-bus", () => {
  it("購読中の handler に即時配送する", () => {
    const got: string[] = [];
    const unsub = subscribeBoardInserts("/tmp/wt-1", i => got.push(i.code));
    publishBoardInsert("/tmp/wt-1", { code: "graph TD; A-->B" });
    expect(got).toEqual(["graph TD; A-->B"]);
    unsub();
  });

  it("購読前の publish はキューされ、購読開始時に flush される", () => {
    publishBoardInsert("/tmp/wt-2", { code: "c1" });
    publishBoardInsert("/tmp/wt-2", { code: "c2" });
    const got: string[] = [];
    const unsub = subscribeBoardInserts("/tmp/wt-2", i => got.push(i.code));
    expect(got).toEqual(["c1", "c2"]);
    unsub();
  });

  it("unsubscribe 後の publish は再度キューされる", () => {
    const got: string[] = [];
    const unsub = subscribeBoardInserts("/tmp/wt-3", i => got.push(i.code));
    unsub();
    publishBoardInsert("/tmp/wt-3", { code: "after" });
    expect(got).toEqual([]);
    const got2: string[] = [];
    const unsub2 = subscribeBoardInserts("/tmp/wt-3", i => got2.push(i.code));
    expect(got2).toEqual(["after"]);
    unsub2();
  });

  it("worktree ごとに独立している", () => {
    const gotA: string[] = [];
    const unsubA = subscribeBoardInserts("/tmp/wt-a", i => gotA.push(i.code));
    publishBoardInsert("/tmp/wt-b", { code: "for-b" });
    expect(gotA).toEqual([]);
    unsubA();
  });
});
