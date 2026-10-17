import { describe, expect, it } from "vitest";
import { hasResolvedAuqSince, parseAuqInput } from "./ask-user-question-state";
import { parseJsonlEvents } from "./jsonl-event-parser";

function jsonl(...objs: unknown[]): string[] {
  return objs.map(o => JSON.stringify(o));
}

const FRUIT_INPUT = {
  questions: [
    {
      question: "どのフルーツ?",
      header: "フルーツ",
      multiSelect: false,
      options: [
        { label: "りんご", description: "赤い" },
        { label: "ばなな" },
        { label: "みかん" },
      ],
    },
  ],
};

function auqToolUseLine(id: string, input: unknown, sidechain = false) {
  return {
    type: "assistant",
    uuid: `a-${id}`,
    isSidechain: sidechain,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "AskUserQuestion", input }],
    },
  };
}

function auqResultLine(id: string, isError = false) {
  return {
    type: "user",
    uuid: `u-${id}`,
    toolUseResult: isError ? "User rejected tool use" : { answers: {} },
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: isError || undefined,
          content: "...",
        },
      ],
    },
  };
}

describe("parseAuqInput", () => {
  it("正常な input を正規化する", () => {
    const qs = parseAuqInput(FRUIT_INPUT);
    expect(qs).toHaveLength(1);
    expect(qs?.[0].question).toBe("どのフルーツ?");
    expect(qs?.[0].multiSelect).toBe(false);
    expect(qs?.[0].options.map(o => o.label)).toEqual([
      "りんご",
      "ばなな",
      "みかん",
    ]);
  });

  it("questions が無い/空なら null", () => {
    expect(parseAuqInput({})).toBeNull();
    expect(parseAuqInput({ questions: [] })).toBeNull();
  });

  it("options の label が欠けていれば null", () => {
    expect(
      parseAuqInput({
        questions: [{ question: "q", options: [{ description: "x" }] }],
      })
    ).toBeNull();
  });
});

describe("hasResolvedAuqSince", () => {
  // hook 受信時刻 (at) の後に解決イベントが書かれたか、の判定。
  // 対話版 claude は tool_use + tool_result を回答確定の瞬間にまとめて書くため
  // 「解決イベントの出現 = カードを閉じてよい」になる。
  const AT = Date.parse("2026-06-10T12:00:00.000Z");
  const after = "2026-06-10T12:00:30.000Z"; // at の 30 秒後に解決
  const longBefore = "2026-06-10T11:50:00.000Z"; // at の 10 分前 (別の質問)

  function resolvedAuqLines(id: string, ts: string, isError = false) {
    return [
      { ...auqToolUseLine(id, FRUIT_INPUT), timestamp: ts },
      { ...auqResultLine(id, isError), timestamp: ts },
    ];
  }

  it("at 以降に解決された AUQ があれば true (回答確定)", () => {
    const events = parseJsonlEvents(jsonl(...resolvedAuqLines("t1", after)));
    expect(hasResolvedAuqSince(events, AT)).toBe(true);
  });

  it("Esc 拒否 (is_error) の解決でも true", () => {
    const events = parseJsonlEvents(
      jsonl(...resolvedAuqLines("t1", after, true))
    );
    expect(hasResolvedAuqSince(events, AT)).toBe(true);
  });

  it("tool_use の時刻が hook より前でも、回答 (tool_result) が後なら true", () => {
    // tool_use の timestamp はモデルが出力した時刻で、回答確定の時刻ではない。
    // PreToolUse hook が遅い (実測 30 秒) と、tool_use は at - 5 秒より前になる
    const events = parseJsonlEvents(
      jsonl(
        {
          ...auqToolUseLine("t1", FRUIT_INPUT),
          timestamp: "2026-06-10T11:59:30.000Z",
        },
        { ...auqResultLine("t1"), timestamp: after }
      )
    );
    expect(hasResolvedAuqSince(events, AT)).toBe(true);
  });

  it("直前の質問への回答では、続けて出た新しい質問のカードを閉じない", () => {
    // 前の質問に答えた 1 秒後に次の質問の hook が届く。前の回答は at より前
    const events = parseJsonlEvents(
      jsonl(
        {
          ...auqToolUseLine("t1", FRUIT_INPUT),
          timestamp: "2026-06-10T11:59:50.000Z",
        },
        { ...auqResultLine("t1"), timestamp: "2026-06-10T11:59:59.000Z" }
      )
    );
    expect(hasResolvedAuqSince(events, AT)).toBe(false);
  });

  it("at より十分前の解決イベントしか無ければ false (過去の別質問)", () => {
    const events = parseJsonlEvents(
      jsonl(...resolvedAuqLines("t1", longBefore))
    );
    expect(hasResolvedAuqSince(events, AT)).toBe(false);
  });

  it("解決イベントが無ければ false (回答待ち継続)", () => {
    const events = parseJsonlEvents(
      jsonl({
        type: "user",
        uuid: "u1",
        timestamp: after,
        message: { role: "user", content: "普通の発言" },
      })
    );
    expect(hasResolvedAuqSince(events, AT)).toBe(false);
  });

  it("sidechain (subagent) の解決イベントは無視する", () => {
    const lines = resolvedAuqLines("t1", after).map(l => ({
      ...l,
      isSidechain: true,
    }));
    const events = parseJsonlEvents(jsonl(...lines));
    expect(hasResolvedAuqSince(events, AT)).toBe(false);
  });

  it("古い解決の後に新しい解決があれば true (最後の AUQ で判定)", () => {
    const events = parseJsonlEvents(
      jsonl(
        ...resolvedAuqLines("t1", longBefore),
        ...resolvedAuqLines("t2", after)
      )
    );
    expect(hasResolvedAuqSince(events, AT)).toBe(true);
  });
});
