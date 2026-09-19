import { describe, expect, it } from "vitest";
import { BOARD_SESSION_CONTEXT } from "./board-session-start-hook.js";

describe("BOARD_SESSION_CONTEXT の data-ark-author=human 規約", () => {
  it("human は人間が手を入れた本文であって、決定そのものではないと述べる", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("手を入れた");
  });

  it("human が無いブロックを人間の決定として扱わない、という古い断定は残っていない", () => {
    expect(BOARD_SESSION_CONTEXT).not.toContain("人間の決定として扱わない");
  });

  it("容器ブロックには human が付かない旨を述べる", () => {
    expect(BOARD_SESSION_CONTEXT).toContain("容器ブロックには付かない");
  });
});
