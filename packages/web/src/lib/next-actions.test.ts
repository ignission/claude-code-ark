import { NEXT_ACTIONS_LIMITS, NEXT_ACTIONS_TOOL_USE_NAME } from "@ark/shared";
import { describe, expect, it } from "vitest";
import type { JsonlParsedEvent } from "./jsonl-event-parser";
import { pendingNextActions, readNextActions } from "./next-actions";

const user = (id: string): JsonlParsedEvent => ({
  id,
  kind: "user-input",
  text: "指示",
});
const reply = (id: string): JsonlParsedEvent => ({
  id,
  kind: "assistant-text",
  text: "終わりました",
  endTurn: true,
});
const tool = (id: string): JsonlParsedEvent => ({
  id,
  kind: "tool-call",
  tool: "Bash",
  input: {},
  status: "done",
  toolUseId: id,
});
const ACTIONS = [
  {
    label: "PRを作る",
    prompt: "コミットしてPRを作って。",
    reason: "差分が揃った",
  },
  { label: "テストを足す", prompt: "境界のテストを足して。" },
];
const next = (
  id: string,
  over: Partial<Extract<JsonlParsedEvent, { kind: "tool-call" }>> = {}
): JsonlParsedEvent => ({
  id,
  kind: "tool-call",
  tool: NEXT_ACTIONS_TOOL_USE_NAME,
  input: { actions: ACTIONS },
  status: "done",
  toolUseId: id,
  ...over,
});

describe("readNextActions", () => {
  it("ラベル、送る文、理由を読む", () => {
    expect(readNextActions({ actions: ACTIONS })).toEqual(ACTIONS);
  });

  it("前後の空白を落とす", () => {
    expect(
      readNextActions({ actions: [{ label: " a ", prompt: " b\n" }] })
    ).toEqual([{ label: "a", prompt: "b" }]);
  });

  it("形が違う入力は全体を捨てる", () => {
    for (const input of [
      null,
      {},
      { actions: "x" },
      { actions: [] },
      { actions: [null] },
      { actions: [{ label: "a" }] },
      { actions: [{ label: "", prompt: "b" }] },
      { actions: [{ label: "a", prompt: 1 }] },
      { actions: [ACTIONS[0], { label: "a" }] },
      {
        actions: Array.from(
          { length: NEXT_ACTIONS_LIMITS.maxActions + 1 },
          () => ACTIONS[1]
        ),
      },
      {
        actions: [
          { label: "a", prompt: "b".repeat(NEXT_ACTIONS_LIMITS.prompt + 1) },
        ],
      },
      {
        actions: [
          { label: "a".repeat(NEXT_ACTIONS_LIMITS.label + 1), prompt: "b" },
        ],
      },
    ]) {
      expect(readNextActions(input)).toEqual([]);
    }
  });

  it("理由だけが壊れているなら、理由を落として選択肢は残す", () => {
    expect(
      readNextActions({
        actions: [
          {
            label: "a",
            prompt: "b",
            reason: "c".repeat(NEXT_ACTIONS_LIMITS.reason + 1),
          },
          { label: "d", prompt: "e", reason: 3 },
        ],
      })
    ).toEqual([
      { label: "a", prompt: "b" },
      { label: "d", prompt: "e" },
    ]);
  });
});

describe("pendingNextActions", () => {
  it("最後の返答の前に呼ばれた選択肢を出す", () => {
    expect(
      pendingNextActions([user("u1"), tool("t1"), next("n1"), reply("a1")])
    ).toEqual({ toolUseId: "n1", actions: ACTIONS });
  });

  it("返答の本文が後ろに無くても出す", () => {
    expect(pendingNextActions([user("u1"), next("n1")])?.toolUseId).toBe("n1");
  });

  it("人が返事をしたら出さない", () => {
    expect(
      pendingNextActions([next("n1"), reply("a1"), user("u2")])
    ).toBeNull();
  });

  it("スラッシュコマンドや /compact のあとは出さない", () => {
    expect(
      pendingNextActions([
        next("n1"),
        { id: "s1", kind: "slash-command", name: "/model" },
      ])
    ).toBeNull();
    expect(
      pendingNextActions([next("n1"), { id: "c1", kind: "compact-marker" }])
    ).toBeNull();
  });

  it("Claude が別の作業を続けたら出さない", () => {
    expect(
      pendingNextActions([next("n1"), reply("a1"), tool("t2"), reply("a2")])
    ).toBeNull();
  });

  it("あとから呼び直されたら、新しいほうを出す", () => {
    expect(
      pendingNextActions([
        next("n1"),
        reply("a1"),
        user("u2"),
        next("n2"),
        reply("a2"),
      ])?.toolUseId
    ).toBe("n2");
  });

  it("バックグラウンド作業の完了通知が来ても出したままにする", () => {
    expect(
      pendingNextActions([
        next("n1"),
        reply("a1"),
        {
          id: "sn1",
          kind: "system-note",
          source: "task-notification",
          summary: "完了",
          text: "完了",
        },
      ])?.toolUseId
    ).toBe("n1");
  });

  it("呼び出しの途中と、失敗した呼び出しは出さない", () => {
    expect(pendingNextActions([next("n1", { status: "running" })])).toBeNull();
    expect(pendingNextActions([next("n1", { isError: true })])).toBeNull();
  });

  it("入力の形が違う呼び出しは出さない", () => {
    expect(
      pendingNextActions([next("n1", { input: { actions: [] } })])
    ).toBeNull();
  });

  it("subagent の中の呼び出しと発言は見ない", () => {
    expect(
      pendingNextActions([
        next("n1"),
        reply("a1"),
        { ...user("u2"), isSidechain: true },
        { ...tool("t2"), isSidechain: true },
      ])?.toolUseId
    ).toBe("n1");
    expect(
      pendingNextActions([{ ...next("n1"), isSidechain: true }])
    ).toBeNull();
  });

  it("会話が空なら出さない", () => {
    expect(pendingNextActions([])).toBeNull();
  });
});
