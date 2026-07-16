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

  it("async handler は並行実行されず、publish 順に逐次処理される", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const order: string[] = [];

    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

    const unsub = subscribeBoardInserts("/tmp/wt-4", async insert => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      // 処理順によって待ち時間を変える（後の呼び出しほど短くして、並行実行なら
      // 順序が入れ替わる可能性を作る）
      await delay(insert.code === "a" ? 20 : 5);
      order.push(insert.code);
      running -= 1;
    });

    publishBoardInsert("/tmp/wt-4", { code: "a" });
    publishBoardInsert("/tmp/wt-4", { code: "b" });
    publishBoardInsert("/tmp/wt-4", { code: "c" });

    // すべての handler 呼び出しが完了するまで待つ
    await delay(100);

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
    unsub();
  });

  it("既存の同期 handler も引き続き動作する", () => {
    const got: string[] = [];
    const unsub = subscribeBoardInserts("/tmp/wt-5", i => {
      got.push(i.code);
    });
    publishBoardInsert("/tmp/wt-5", { code: "sync-1" });
    publishBoardInsert("/tmp/wt-5", { code: "sync-2" });
    expect(got).toEqual(["sync-1", "sync-2"]);
    unsub();
  });
});
