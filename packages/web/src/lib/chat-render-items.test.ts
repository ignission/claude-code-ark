import { describe, expect, it } from "vitest";
import {
  type ChatRenderItem,
  groupSidechain,
  groupToolCalls,
  type ToolCallEvent,
} from "./chat-render-items";
import type { JsonlParsedEvent } from "./jsonl-event-parser";

function tool(
  id: string,
  status: "running" | "done" = "done",
  extra: Partial<ToolCallEvent> = {}
): ToolCallEvent {
  return {
    id,
    kind: "tool-call",
    tool: "Bash",
    input: { command: `echo ${id}` },
    status,
    toolUseId: id,
    ...extra,
  };
}

function askUserQuestion(
  id: string,
  status: "running" | "done" = "done"
): ToolCallEvent {
  return tool(id, status, {
    tool: "AskUserQuestion",
    input: { questions: [] },
  });
}

const userInput = (id: string): JsonlParsedEvent => ({
  id,
  kind: "user-input",
  text: "依頼",
});
const assistantText = (id: string): JsonlParsedEvent => ({
  id,
  kind: "assistant-text",
  text: "返答",
});
const thinking = (id: string): JsonlParsedEvent => ({
  id,
  kind: "thinking",
  text: "考え中",
});

/** groupSidechain → groupToolCallsを通した結果を、比較しやすい文字列の列に写す */
function shape(events: JsonlParsedEvent[]): string[] {
  return groupToolCalls(groupSidechain(events)).map(item => {
    if (item.kind === "sidechain") {
      return `sidechain:${item.events.map(e => e.id).join(",")}`;
    }
    if (item.kind === "tool-group") {
      return `tools:${item.calls.map(c => c.id).join(",")}`;
    }
    return `${item.event.kind}:${item.event.id}`;
  });
}

type ToolGroup = Extract<ChatRenderItem, { kind: "tool-group" }>;

/** まとまりが1つだけできる入力から、そのまとまりを取り出す */
function onlyToolGroup(events: JsonlParsedEvent[]): ToolGroup {
  const groups = groupToolCalls(groupSidechain(events)).filter(
    (item): item is ToolGroup => item.kind === "tool-group"
  );
  expect(groups).toHaveLength(1);
  return groups[0];
}

describe("groupSidechain", () => {
  it("連続するsidechainイベントを1つのまとまりにし、idは先頭のイベントから作る", () => {
    const items = groupSidechain([
      userInput("u1"),
      tool("s1", "done", { isSidechain: true }),
      { id: "s2", kind: "assistant-text", text: "調査結果", isSidechain: true },
      assistantText("a1"),
    ]);

    expect(items.map(item => item.kind)).toEqual([
      "event",
      "sidechain",
      "event",
    ]);
    const group = items[1];
    expect(group.kind === "sidechain" && group.id).toBe("sc:s1");
    expect(group.kind === "sidechain" && group.events.map(e => e.id)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("本流のイベントを挟んだsidechainは別のまとまりになる", () => {
    expect(
      shape([
        tool("s1", "done", { isSidechain: true }),
        userInput("u1"),
        tool("s2", "done", { isSidechain: true }),
      ])
    ).toEqual(["sidechain:s1", "user-input:u1", "sidechain:s2"]);
  });
});

describe("groupToolCalls", () => {
  it("連続するtool-callを1つのまとまりにし、idは先頭のtool-callから作る", () => {
    expect(
      shape([userInput("u1"), tool("t1"), tool("t2"), assistantText("a1")])
    ).toEqual(["user-input:u1", "tools:t1,t2", "assistant-text:a1"]);
    expect(onlyToolGroup([tool("t1"), tool("t2")]).id).toBe("tg:t1");
  });

  it("1件だけのまとまりも折りたたむ", () => {
    expect(shape([userInput("u1"), tool("t1"), assistantText("a1")])).toEqual([
      "user-input:u1",
      "tools:t1",
      "assistant-text:a1",
    ]);
  });

  const boundaries: Array<[string, JsonlParsedEvent]> = [
    ["user-input", userInput("b")],
    ["assistant-text", assistantText("b")],
    ["slash-command", { id: "b", kind: "slash-command", name: "/compact" }],
    ["compact-marker", { id: "b", kind: "compact-marker" }],
  ];

  it.each(boundaries)("%sでまとまりを閉じる", (kind, boundary) => {
    expect(shape([tool("t1"), boundary, tool("t2")])).toEqual([
      "tools:t1",
      `${kind}:b`,
      "tools:t2",
    ]);
  });

  it("sidechainのまとまりでまとまりを閉じる", () => {
    expect(
      shape([tool("t1"), tool("s1", "done", { isSidechain: true }), tool("t2")])
    ).toEqual(["tools:t1", "sidechain:s1", "tools:t2"]);
  });

  it("sidechainの中のtool-callは折りたたみの対象にしない", () => {
    expect(
      shape([
        tool("s1", "done", { isSidechain: true }),
        tool("s2", "running", { isSidechain: true }),
      ])
    ).toEqual(["sidechain:s1,s2"]);
  });

  it.each(["done", "running"] as const)(
    "AskUserQuestion (%s) は折りたたまずに独立して出し、まとまりを閉じる",
    status => {
      expect(
        shape([tool("t1"), askUserQuestion("q1", status), tool("t2")])
      ).toEqual(["tools:t1", "tool-call:q1", "tools:t2"]);
    }
  );

  it("thinkingはまとまりを閉じず、まとまりの途中にあれば出力に含めない", () => {
    expect(shape([tool("t1"), thinking("th1"), tool("t2")])).toEqual([
      "tools:t1,t2",
    ]);
  });

  it("まとまりの外のthinkingはそのまま出す", () => {
    expect(shape([userInput("u1"), thinking("th1"), tool("t1")])).toEqual([
      "user-input:u1",
      "thinking:th1",
      "tools:t1",
    ]);
  });

  it("全件doneのまとまりはlatestRunningがnull", () => {
    expect(onlyToolGroup([tool("t1"), tool("t2")]).latestRunning).toBeNull();
  });

  it("latestRunningはrunningのうち配列順で最後の1件", () => {
    const group = onlyToolGroup([
      tool("a", "running"),
      tool("b", "done"),
      tool("c", "running"),
    ]);
    expect(group.latestRunning?.id).toBe("c");
  });

  it("最後の1件がdoneでも、それより前にrunningがあれば実行中として扱う (並列の呼び出し)", () => {
    const group = onlyToolGroup([
      tool("a", "running"),
      tool("b", "running"),
      tool("c", "done"),
    ]);
    expect(group.latestRunning?.id).toBe("b");
  });
});
