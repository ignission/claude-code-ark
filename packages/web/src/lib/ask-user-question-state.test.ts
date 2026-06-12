import { describe, expect, it } from "vitest";
import {
  type AuqQuestion,
  buildKeySequence,
  freeTextDigit,
  hasResolvedAuqSince,
  needsReview,
  parseAuqInput,
} from "./ask-user-question-state";
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

describe("needsReview / freeTextDigit", () => {
  const single: AuqQuestion = {
    question: "q",
    multiSelect: false,
    options: [{ label: "a" }, { label: "b" }],
  };
  const multi: AuqQuestion = { ...single, multiSelect: true };

  it("単問 single-select は Review 無し", () => {
    expect(needsReview([single])).toBe(false);
  });

  it("multiSelect を含むと Review あり", () => {
    expect(needsReview([multi])).toBe(true);
  });

  it("複数質問は Review あり", () => {
    expect(needsReview([single, single])).toBe(true);
  });

  it("Type something. の番号は options.length+1", () => {
    expect(freeTextDigit(single)).toBe(3);
  });
});

describe("buildKeySequence", () => {
  const q3: AuqQuestion = {
    question: "どれ?",
    multiSelect: false,
    options: [{ label: "A" }, { label: "B" }, { label: "C" }],
  };
  const q3multi: AuqQuestion = { ...q3, multiSelect: true };

  function digitsOf(steps: ReturnType<typeof buildKeySequence>): string[] {
    return (steps ?? [])
      .filter(s => s.kind !== "wait")
      .map(s =>
        s.kind === "digit"
          ? s.value
          : s.kind === "key"
            ? `<${s.value}>`
            : `"${s.value}"`
      );
  }

  it("単問 single-select は digit 一発 (Review 無し)", () => {
    const steps = buildKeySequence([q3], [{ kind: "options", indexes: [1] }]);
    expect(digitsOf(steps)).toEqual(["2"]);
  });

  it("単問 multiSelect は digit トグル列 → Right → Review digit 1", () => {
    const steps = buildKeySequence(
      [q3multi],
      [{ kind: "options", indexes: [0, 2] }]
    );
    expect(digitsOf(steps)).toEqual(["1", "3", "<Right>", "1"]);
  });

  it("自由入力は digit(len+1) → literal → Enter", () => {
    const steps = buildKeySequence([q3], [{ kind: "free", text: "ぶどう" }]);
    expect(digitsOf(steps)).toEqual(["4", '"ぶどう"', "<Enter>"]);
  });

  it("複数質問 (全 single) は各 digit → 最後に Review digit 1", () => {
    const steps = buildKeySequence(
      [q3, q3],
      [
        { kind: "options", indexes: [0] },
        { kind: "options", indexes: [1] },
      ]
    );
    expect(digitsOf(steps)).toEqual(["1", "2", "1"]);
  });

  it("multi + single 混在: multi は Right でタブ送り", () => {
    const steps = buildKeySequence(
      [q3multi, q3],
      [
        { kind: "options", indexes: [1] },
        { kind: "options", indexes: [2] },
      ]
    );
    expect(digitsOf(steps)).toEqual(["2", "<Right>", "3", "1"]);
  });

  it("回答数が一致しなければ null", () => {
    expect(buildKeySequence([q3], [])).toBeNull();
  });

  it("multiSelect で 0 個選択は null", () => {
    expect(
      buildKeySequence([q3multi], [{ kind: "options", indexes: [] }])
    ).toBeNull();
  });

  it("digit が 9 を超える選択肢は null (ターミナル誘導)", () => {
    const big: AuqQuestion = {
      question: "q",
      multiSelect: false,
      options: Array.from({ length: 12 }, (_, i) => ({ label: `o${i}` })),
    };
    expect(
      buildKeySequence([big], [{ kind: "options", indexes: [10] }])
    ).toBeNull();
    // 選択肢 9 個だと free text が 10 番になるので free は不可
    const nine: AuqQuestion = {
      question: "q",
      multiSelect: false,
      options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })),
    };
    expect(buildKeySequence([nine], [{ kind: "free", text: "x" }])).toBeNull();
    // ただし 9 個でも option 選択自体は可能
    expect(
      buildKeySequence([nine], [{ kind: "options", indexes: [8] }])
    ).not.toBeNull();
  });

  it("範囲外の index (負数 / 選択肢数以上) は null", () => {
    expect(
      buildKeySequence([q3], [{ kind: "options", indexes: [-1] }])
    ).toBeNull();
    expect(
      buildKeySequence([q3], [{ kind: "options", indexes: [3] }])
    ).toBeNull();
    expect(
      buildKeySequence([q3multi], [{ kind: "options", indexes: [0, -1] }])
    ).toBeNull();
  });

  it("single-select で複数 index は null", () => {
    expect(
      buildKeySequence([q3], [{ kind: "options", indexes: [0, 1] }])
    ).toBeNull();
  });
});
