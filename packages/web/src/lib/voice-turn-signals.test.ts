import { describe, expect, it } from "vitest";
import type { JsonlParsedEvent } from "./jsonl-event-parser";
import { createTurnEndCursor, scanTurnEnds } from "./voice-turn-signals";

const user = (id: string): JsonlParsedEvent => ({
  id,
  kind: "user-input",
  text: "指示",
});
const reply = (
  id: string,
  text: string,
  options: { endTurn?: boolean; isSidechain?: boolean; timestamp?: number } = {}
): JsonlParsedEvent => ({
  id,
  kind: "assistant-text",
  text,
  endTurn: options.endTurn === false ? undefined : true,
  isSidechain: options.isSidechain,
  timestamp: options.timestamp,
});
const tool = (id: string): JsonlParsedEvent => ({
  id,
  kind: "tool-call",
  tool: "Bash",
  input: {},
  status: "done",
  toolUseId: id,
});

describe("scanTurnEnds", () => {
  it("入った時点の履歴は読まない", () => {
    const events = [user("u1"), reply("a1", "前の返答")];
    const cursor = createTurnEndCursor(events);
    expect(scanTurnEnds(cursor, events).turnEnd).toBeNull();
  });

  it("入った後に届いたターンの終わりを読む", () => {
    const before = [user("u1"), reply("a1", "前の返答")];
    const cursor = createTurnEndCursor(before);
    const after = [
      ...before,
      user("u2"),
      tool("t1"),
      reply("a2", "直しました"),
    ];
    expect(scanTurnEnds(cursor, after).turnEnd).toEqual({
      ids: ["a2"],
      text: "直しました",
    });
  });

  it("ツール実行の合間の独り言 (end_turn でない本文) は読まない", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [
      user("u1"),
      reply("n1", "見てみます", { endTurn: false }),
      tool("t1"),
    ];
    expect(scanTurnEnds(cursor, events).turnEnd).toBeNull();
  });

  it("subagent の発言は読まない", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [
      user("u1"),
      reply("s1", "subagentの返答", { isSidechain: true }),
    ];
    expect(scanTurnEnds(cursor, events).turnEnd).toBeNull();
  });

  it("同じ返答を二度読まない", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [user("u1"), reply("a1", "返答")];
    const first = scanTurnEnds(cursor, events);
    expect(first.turnEnd?.text).toBe("返答");
    expect(scanTurnEnds(first.cursor, events).turnEnd).toBeNull();
  });

  it("過去履歴の追加読み込みで先頭に足された返答は読まない", () => {
    const cursor = createTurnEndCursor([user("u1"), reply("a1", "返答")]);
    const withOlder = [
      user("u0"),
      reply("a0", "もっと前の返答"),
      user("u1"),
      reply("a1", "返答"),
    ];
    expect(scanTurnEnds(cursor, withOlder).turnEnd).toBeNull();
  });

  it("timestamp が前後していても、位置が後ろなら読む", () => {
    const cursor = createTurnEndCursor([
      user("u1"),
      tool("t1"),
      reply("a1", "前", { timestamp: 2000 }),
    ]);
    const events = [
      user("u1"),
      tool("t1"),
      reply("a1", "前", { timestamp: 2000 }),
      user("u2"),
      reply("a2", "新しい返答", { timestamp: 1000 }),
    ];
    expect(scanTurnEnds(cursor, events).turnEnd?.text).toBe("新しい返答");
  });

  it("/clear の空snapshotの後に届いた返答を読む", () => {
    const cursor = createTurnEndCursor([user("u1"), reply("a1", "返答")]);
    const cleared = scanTurnEnds(cursor, []);
    expect(cleared.turnEnd).toBeNull();
    const fresh = [user("n1"), reply("n2", "新しいファイルの返答")];
    expect(scanTurnEnds(cleared.cursor, fresh).turnEnd?.text).toBe(
      "新しいファイルの返答"
    );
  });

  it("再接続のsnapshotでは、切断中に届いた返答を読む", () => {
    const cursor = createTurnEndCursor([user("u1"), reply("a1", "返答")]);
    const snapshot = [
      user("u1"),
      reply("a1", "返答"),
      user("u2"),
      reply("a2", "切断中の返答"),
    ];
    expect(scanTurnEnds(cursor, snapshot).turnEnd?.text).toBe("切断中の返答");
  });

  it("一度に複数のターンの終わりが届いたら、最後のターンだけを読む", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [
      user("u1"),
      reply("a1", "一つ目"),
      user("u2"),
      reply("a2", "二つ目"),
    ];
    expect(scanTurnEnds(cursor, events).turnEnd).toEqual({
      ids: ["a2"],
      text: "二つ目",
    });
  });

  it("最後の返答が複数の本文に分かれていれば、つないで読む", () => {
    const cursor = createTurnEndCursor([user("u1")]);
    const events = [user("u1"), reply("b1", "前半"), reply("b2", "後半")];
    expect(scanTurnEnds(cursor, events).turnEnd).toEqual({
      ids: ["b1", "b2"],
      text: "前半\n\n後半",
    });
  });
});
