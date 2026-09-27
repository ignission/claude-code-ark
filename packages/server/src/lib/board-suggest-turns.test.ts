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
  it("ユーザー発話以降の text block を束ね、end_turn の本文の行で終わりの候補を知らせる", () => {
    const a = new TurnAssembler();
    expect(a.push(user("図解して"))).toBe(false);
    expect(
      a.push(
        assistant([{ type: "text", text: "まず確認します。" }], "tool_use")
      )
    ).toBe(false);
    expect(a.push(assistant([{ type: "tool_use" }], "tool_use"))).toBe(false);
    // tool_result の user 行は区切りにしない
    expect(a.push(user([{ type: "tool_result", content: "ok" }]))).toBe(false);
    expect(
      a.push(assistant([{ type: "text", text: "結論です。" }], "end_turn"))
    ).toBe(true);
    expect(a.take()?.text).toBe("まず確認します。\n\n結論です。");
    // 取り出したら空になる
    expect(a.take()).toBeNull();
  });

  it("thinking と本文が別の行で end_turn を持つとき、thinking の行では終わりの候補にしない", () => {
    // 対話版 claude は 1 つの返答を content block ごとに別の行で書き、どの行にも
    // 返答全体の stop_reason が付く。thinking の行で終えると最後の本文が判定から漏れる
    const a = new TurnAssembler();
    a.push(user("調べて"));
    a.push(assistant([{ type: "text", text: "確認します。" }], "tool_use"));
    a.push(user([{ type: "tool_result", content: "ok" }]));
    expect(a.push(assistant([{ type: "thinking" }], "end_turn"))).toBe(false);
    expect(
      a.push(assistant([{ type: "text", text: "結論です。" }], "end_turn"))
    ).toBe(true);
    expect(a.take()?.text).toBe("確認します。\n\n結論です。");
  });

  it("1 つの返答の本文が複数の行に分かれても、取り出すまで 1 つのターンに束ねる", () => {
    // どの本文の行も end_turn を持つので、行を見ただけでは返答の終わりが分からない。
    // 呼び出し側が少し待ってから take する
    const a = new TurnAssembler();
    a.push(user("まとめて"));
    expect(
      a.push(assistant([{ type: "text", text: "前半です。" }], "end_turn"))
    ).toBe(true);
    expect(
      a.push(assistant([{ type: "text", text: "後半です。" }], "end_turn"))
    ).toBe(true);
    expect(a.take()?.text).toBe("前半です。\n\n後半です。");
  });

  it("ユーザーの新しい発話で溜めた本文を捨てる", () => {
    const a = new TurnAssembler();
    a.push(assistant([{ type: "text", text: "途中" }], "tool_use"));
    a.push(user("別の話"));
    a.push(assistant([{ type: "text", text: "新しい返答" }], "end_turn"));
    expect(a.take()?.text).toBe("新しい返答");
  });

  it("thinking だけの end_turn や sidechain、壊れた行、空白だけの本文は無視する", () => {
    const a = new TurnAssembler();
    expect(a.push("not json")).toBe(false);
    expect(a.push(assistant([{ type: "thinking" }], "end_turn"))).toBe(false);
    expect(
      a.push(
        assistant([{ type: "text", text: "sub" }], "end_turn", {
          isSidechain: true,
        })
      )
    ).toBe(false);
    expect(a.push(assistant([{ type: "text", text: "  " }], "end_turn"))).toBe(
      false
    );
    expect(a.take()).toBeNull();
  });

  it("reset で溜めた本文を捨てる", () => {
    const a = new TurnAssembler();
    a.push(assistant([{ type: "text", text: "古い" }], "tool_use"));
    a.reset();
    a.push(assistant([{ type: "text", text: "新しい" }], "end_turn"));
    expect(a.take()?.text).toBe("新しい");
  });
});
