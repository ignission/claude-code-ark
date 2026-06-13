import { describe, expect, it } from "vitest";
import {
  type JsonlParsedEvent,
  mergeJsonlLine,
  parseJsonlEvents,
} from "./jsonl-event-parser";

function jsonl(...objs: unknown[]): string[] {
  return objs.map(o => JSON.stringify(o));
}

describe("parseJsonlEvents", () => {
  it("user テキストメッセージを抽出する", () => {
    const events = parseJsonlEvents(
      jsonl({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "こんにちは" },
      })
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("user-input");
    expect(events[0].id).toBe("u1:u");
    if (events[0].kind === "user-input") {
      expect(events[0].text).toBe("こんにちは");
    }
  });

  it("local-command-caveat は除外する", () => {
    const events = parseJsonlEvents(
      jsonl({
        type: "user",
        uuid: "u1",
        message: {
          role: "user",
          content: "<local-command-caveat>...</local-command-caveat>",
        },
      })
    );
    expect(events).toHaveLength(0);
  });

  it("slash command を抽出する", () => {
    const events = parseJsonlEvents(
      jsonl({
        type: "user",
        uuid: "u1",
        message: {
          role: "user",
          content:
            "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
        },
      })
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("slash-command");
    if (events[0].kind === "slash-command") {
      expect(events[0].name).toBe("/clear");
    }
  });

  it("assistant の text/thinking/tool_use を抽出する", () => {
    const events = parseJsonlEvents(
      jsonl({
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "考え中..." },
            { type: "text", text: "答え" },
            {
              type: "tool_use",
              id: "tool_abc",
              name: "Bash",
              input: { command: "ls -la", description: "List" },
            },
          ],
        },
      })
    );
    expect(events.map(e => e.kind)).toEqual([
      "thinking",
      "assistant-text",
      "tool-call",
    ]);
    const toolCall = events.find(e => e.kind === "tool-call");
    if (toolCall?.kind === "tool-call") {
      expect(toolCall.tool).toBe("Bash");
      expect(toolCall.input.command).toBe("ls -la");
      expect(toolCall.status).toBe("running");
      expect(toolCall.toolUseId).toBe("tool_abc");
    }
  });

  it("tool_result を対応する tool_use にマージする", () => {
    const events = parseJsonlEvents(
      jsonl(
        {
          type: "assistant",
          uuid: "a1",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool_xyz",
                name: "Read",
                input: { file_path: "/tmp/foo.txt" },
              },
            ],
          },
        },
        {
          type: "user",
          uuid: "u2",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_xyz",
                content: "file contents here",
              },
            ],
          },
        }
      )
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("tool-call");
    if (events[0].kind === "tool-call") {
      expect(events[0].status).toBe("done");
      expect(events[0].result).toBe("file contents here");
    }
  });

  it("内部 type (file-history-snapshot / attachment / system) は無視する", () => {
    const events = parseJsonlEvents(
      jsonl(
        { type: "file-history-snapshot", messageId: "x" },
        { type: "attachment", attachment: { type: "hook_success" } },
        { type: "system" },
        { type: "last-prompt" },
        {
          type: "user",
          uuid: "u",
          message: { role: "user", content: "実コンテンツ" },
        }
      )
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("user-input");
  });

  it("壊れた JSON 行はスキップする (後続は処理続行)", () => {
    const events = parseJsonlEvents([
      "not-json",
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "ok" },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("user-input");
  });
});

describe("mergeJsonlLine (差分パース)", () => {
  it("1 行ずつ追加して累積結果が parseJsonlEvents と一致する", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "ひとこと" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "返事" }],
        },
      }),
    ];
    const expected = parseJsonlEvents(lines);

    const toolMap = new Map<
      string,
      Extract<JsonlParsedEvent, { kind: "tool-call" }>
    >();
    let events: JsonlParsedEvent[] = [];
    for (const l of lines) events = mergeJsonlLine(events, toolMap, l);
    expect(events).toEqual(expected);
  });

  it("行追加で events 参照が更新される (React 再描画用)", () => {
    const toolMap = new Map<
      string,
      Extract<JsonlParsedEvent, { kind: "tool-call" }>
    >();
    const initial: JsonlParsedEvent[] = [];
    const after = mergeJsonlLine(
      initial,
      toolMap,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "x" },
      })
    );
    expect(after).not.toBe(initial);
    expect(after).toHaveLength(1);
  });

  it("無視される行 (内部 type) は同じ events 参照を返す", () => {
    const toolMap = new Map<
      string,
      Extract<JsonlParsedEvent, { kind: "tool-call" }>
    >();
    const events: JsonlParsedEvent[] = [];
    const after = mergeJsonlLine(
      events,
      toolMap,
      JSON.stringify({ type: "file-history-snapshot" })
    );
    expect(after).toBe(events);
  });

  it("後から届いた tool_result が既存 tool-call にマージされる", () => {
    const toolMap = new Map<
      string,
      Extract<JsonlParsedEvent, { kind: "tool-call" }>
    >();
    let events: JsonlParsedEvent[] = [];
    events = mergeJsonlLine(
      events,
      toolMap,
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu",
              name: "Read",
              input: { file_path: "/x" },
            },
          ],
        },
      })
    );
    expect(events[0].kind).toBe("tool-call");
    if (events[0].kind === "tool-call") {
      expect(events[0].status).toBe("running");
    }
    events = mergeJsonlLine(
      events,
      toolMap,
      JSON.stringify({
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu", content: "本文" },
          ],
        },
      })
    );
    expect(events[0].kind).toBe("tool-call");
    if (events[0].kind === "tool-call") {
      expect(events[0].status).toBe("done");
      expect(events[0].result).toBe("本文");
    }
  });
});

describe("チャット UI v3 拡張", () => {
  it("isCompactSummary レコードは compact-marker になり本文は表示されない", () => {
    // /compact は JSONL ファイルを切り替えず、巨大な要約 user レコードを
    // 同一ファイルに挿入する。user-input として描画すると巨大バブルになる
    const events = parseJsonlEvents(
      jsonl({
        type: "user",
        uuid: "c1",
        isCompactSummary: true,
        message: {
          role: "user",
          content: "巨大な要約テキスト...".repeat(100),
        },
      })
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("compact-marker");
  });

  it("local-command-stdout も除外する", () => {
    const events = parseJsonlEvents(
      jsonl({
        type: "user",
        uuid: "u1",
        message: {
          role: "user",
          content: "<local-command-stdout>出力...</local-command-stdout>",
        },
      })
    );
    expect(events).toHaveLength(0);
  });

  it("tool_result の toolUseResult / is_error を tool-call にマージする", () => {
    const events = parseJsonlEvents(
      jsonl(
        {
          type: "assistant",
          uuid: "a1",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "auq1",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    {
                      question: "どっち？",
                      header: "選択",
                      multiSelect: false,
                      options: [{ label: "A" }, { label: "B" }],
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          type: "user",
          uuid: "u2",
          toolUseResult: {
            questions: [{ question: "どっち？" }],
            answers: { "どっち？": "A" },
          },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "auq1",
                content: 'User has answered your questions: "どっち？"="A"',
              },
            ],
          },
        }
      )
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("tool-call");
    if (events[0].kind === "tool-call") {
      expect(events[0].status).toBe("done");
      expect(events[0].isError).toBeUndefined();
      expect(events[0].structuredResult).toEqual({
        questions: [{ question: "どっち？" }],
        answers: { "どっち？": "A" },
      });
    }
  });

  it("Esc 拒否 (is_error: true) は isError として届く", () => {
    const events = parseJsonlEvents(
      jsonl(
        {
          type: "assistant",
          uuid: "a1",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "auq2",
                name: "AskUserQuestion",
                input: { questions: [] },
              },
            ],
          },
        },
        {
          type: "user",
          uuid: "u2",
          toolUseResult: "User rejected tool use",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "auq2",
                is_error: true,
                content: "The user doesn't want to proceed with this tool use.",
              },
            ],
          },
        }
      )
    );
    expect(events[0].kind).toBe("tool-call");
    if (events[0].kind === "tool-call") {
      expect(events[0].isError).toBe(true);
      expect(events[0].structuredResult).toBe("User rejected tool use");
    }
  });

  it("isSidechain が全イベント種別に伝播する", () => {
    const events = parseJsonlEvents(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          isSidechain: true,
          message: { role: "user", content: "subagent への指示" },
        },
        {
          type: "assistant",
          uuid: "a1",
          isSidechain: true,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "..." },
              { type: "text", text: "subagent の返答" },
              { type: "tool_use", id: "t1", name: "Read", input: {} },
            ],
          },
        }
      )
    );
    expect(events).toHaveLength(4);
    for (const e of events) {
      expect(e.isSidechain).toBe(true);
    }
  });

  it("isSidechain でない行には isSidechain が付かない", () => {
    const events = parseJsonlEvents(
      jsonl({
        type: "user",
        uuid: "u1",
        isSidechain: false,
        message: { role: "user", content: "メイン会話" },
      })
    );
    expect(events[0].isSidechain).toBeUndefined();
  });
});
