import { describe, expect, it } from "vitest";
import { BOARD_SESSION_CONTEXT } from "./board-session-start-hook.js";

describe("BOARD_SESSION_CONTEXT の data-ark-author=human 規約", () => {
  it("human は人間が手を入れた本文であって、決定そのものではないと述べる", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("手を入れた");
    expect(BOARD_SESSION_CONTEXT).toContain("決定かどうかは");
  });

  it("human が無いブロックを人間の決定として扱わない、という古い断定は残っていない", () => {
    expect(BOARD_SESSION_CONTEXT).not.toContain("人間の決定として扱わない");
  });

  it("容器ブロックには human が付かない旨を述べる", () => {
    // 言い回しが変わっても壊れにくいよう、1つの完全一致ではなく2つの要素で見る。
    expect(BOARD_SESSION_CONTEXT).toContain("容器ブロック");
    expect(BOARD_SESSION_CONTEXT).toContain("付かない");
  });
});
