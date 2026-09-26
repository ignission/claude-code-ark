import { describe, expect, it } from "vitest";
import { TurnAssembler } from "./board-suggest-turns.js";

function assistant(
  blocks: Array<{ type: string; text?: string }>,
  stopReason: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: "assistant",
    message: { stop_reason: stopReason, content: blocks },
    ...extra,
  });
}

function user(content: unknown): string {
  return JSON.stringify({ type: "user", message: { content } });
}

describe("TurnAssembler", () => {
  it("ユーザー発話以降の text block を end_turn で 1 本に束ねる", () => {
    const a = new TurnAssembler();
    expect(a.push(user("図解して"))).toBeNull();
    expect(
      a.push(
        assistant([{ type: "text", text: "まず確認します。" }], "tool_use")
      )
    ).toBeNull();
    expect(a.push(assistant([{ type: "tool_use" }], "tool_use"))).toBeNull();
    // tool_result の user 行は区切りにしない
    expect(a.push(user([{ type: "tool_result", content: "ok" }]))).toBeNull();
    const turn = a.push(
      assistant([{ type: "text", text: "結論です。" }], "end_turn")
    );
    expect(turn?.text).toBe("まず確認します。\n\n結論です。");
  });

  it("ユーザーの新しい発話で溜めた本文を捨てる", () => {
    const a = new TurnAssembler();
    a.push(assistant([{ type: "text", text: "途中" }], "tool_use"));
    a.push(user("別の話"));
    const turn = a.push(
      assistant([{ type: "text", text: "新しい返答" }], "end_turn")
    );
    expect(turn?.text).toBe("新しい返答");
  });

  it("thinking だけの end_turn や sidechain、壊れた行は無視する", () => {
    const a = new TurnAssembler();
    expect(a.push("not json")).toBeNull();
    expect(a.push(assistant([{ type: "thinking" }], "end_turn"))).toBeNull();
    expect(
      a.push(
        assistant([{ type: "text", text: "sub" }], "end_turn", {
          isSidechain: true,
        })
      )
    ).toBeNull();
    expect(
      a.push(assistant([{ type: "text", text: "  " }], "end_turn"))
    ).toBeNull();
  });

  it("reset で溜めた本文を捨てる", () => {
    const a = new TurnAssembler();
    a.push(assistant([{ type: "text", text: "古い" }], "tool_use"));
    a.reset();
    const turn = a.push(
      assistant([{ type: "text", text: "新しい" }], "end_turn")
    );
    expect(turn?.text).toBe("新しい");
  });
});
