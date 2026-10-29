import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_TODO_REASON,
  type BranchTodoStopDeps,
  BranchTodoStopHandler,
  extractLastTurn,
  parseStopHookInput,
  readTranscriptTail,
  type StopHookInput,
} from "./branch-todo-stop-hook.js";

const human = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });
const meta = (text: string) =>
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: { role: "user", content: text },
  });
const toolResult = () =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t" }] },
  });
const say = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    ...extra,
    message: { content: [{ type: "text", text }] },
  });
const tool = (name: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name, input: {} }] },
  });

describe("extractLastTurn", () => {
  it("最後の人の発話より後の本文を、ツール呼び出しをまたいで連結する", () => {
    const turn = extractLastTurn([
      human("前の質問"),
      say("前の返答"),
      human("今の質問"),
      say("前半"),
      tool("Bash"),
      toolResult(),
      say("後半"),
    ]);
    expect(turn).toEqual({
      text: "前半\n\n後半",
      prompt: "今の質問",
      addedTodo: false,
    });
  });

  it("isMeta の行・subagent の行・壊れた行ではターンを区切らない", () => {
    const turn = extractLastTurn([
      human("q"),
      say("本文"),
      meta("Stop hook feedback:\n..."),
      say("subagent", { isSidechain: true }),
      "{broken",
    ]);
    expect(turn.text).toBe("本文");
  });
});

describe("extractLastTurn の prompt と addedTodo", () => {
  it("区切りになった人の発話を prompt に入れる (text block の配列も読む)", () => {
    const turn = extractLastTurn([
      human("前の質問"),
      say("前の返答"),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "今の質問" }] },
      }),
      say("返答"),
    ]);
    expect(turn.prompt).toBe("今の質問");
  });

  it("そのターンで todo_add していれば addedTodo を立てる", () => {
    expect(
      extractLastTurn([
        human("q"),
        tool("mcp__ark-board__todo_add"),
        toolResult(),
        say("足した"),
      ]).addedTodo
    ).toBe(true);
    // 前のターンの todo_add は数えない
    expect(
      extractLastTurn([
        human("q1"),
        tool("mcp__ark-board__todo_add"),
        human("q2"),
        say("a"),
      ]).addedTodo
    ).toBe(false);
  });
});

describe("parseStopHookInput", () => {
  it("Stop の入力だけを受け付け、.jsonl 以外の transcript_path は捨てる", () => {
    expect(
      parseStopHookInput({ hook_event_name: "PreToolUse", cwd: "/w" })
    ).toBeNull();
    expect(parseStopHookInput({ hook_event_name: "Stop" })).toBeNull();
    expect(
      parseStopHookInput({
        hook_event_name: "Stop",
        cwd: "/w",
        transcript_path: "/etc/passwd",
        stop_hook_active: true,
        last_assistant_message: "hi",
      })
    ).toEqual({
      cwd: "/w",
      transcriptPath: null,
      stopHookActive: true,
      lastAssistantMessage: "hi",
    });
  });
});

describe("readTranscriptTail", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true });
  });

  it("末尾だけ読み、途中から読んだ欠けた行を捨てる", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-stop-"));
    dirs.push(dir);
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, `${"x".repeat(50)}\nline2\nline3\n`);
    expect(await readTranscriptTail(file, 14)).toEqual(["line2", "line3"]);
    expect(await readTranscriptTail(file)).toEqual([
      "x".repeat(50),
      "line2",
      "line3",
    ]);
  });
});

describe("BranchTodoStopHandler", () => {
  const input = (over: Partial<StopHookInput> = {}): StopHookInput => ({
    cwd: "/w",
    transcriptPath: "/t.jsonl",
    stopHookActive: false,
    lastAssistantMessage: "最後",
    ...over,
  });
  const make = (over: Partial<BranchTodoStopDeps> = {}) => {
    const deps: BranchTodoStopDeps = {
      apiKey: () => "sk",
      todoEnabled: () => true,
      todoThreshold: () => 0.7,
      decideDeferred: vi.fn(async () => ({ deferred: 0.9, cost: 0 })),
      readTranscript: async () => [human("q"), say("長い説明")],
      log: vi.fn(),
      ...over,
    };
    return { deps, handler: new BranchTodoStopHandler(deps) };
  };

  it("保留ありならTODOのreasonでblockする", async () => {
    const { deps, handler } = make();
    expect(await handler.handle("s1", input())).toEqual({
      decision: "block",
      reason: BRANCH_TODO_REASON,
    });
    // hook の時点で transcript に無い最後のメッセージは末尾に補う
    expect(deps.decideDeferred).toHaveBeenCalledWith(
      "q",
      "長い説明\n\n最後",
      "sk"
    );
  });

  it("transcript に最後のメッセージが書かれていれば二重にしない", async () => {
    const { deps, handler } = make({
      readTranscript: async () => [human("q"), say("前半"), say("最後")],
    });
    await handler.handle("s1", input());
    expect(deps.decideDeferred).toHaveBeenCalledWith("q", "前半\n\n最後", "sk");
  });

  it("閾値未満なら止める", async () => {
    const { handler } = make({
      decideDeferred: async () => ({ deferred: 0.5, cost: 0 }),
    });
    expect(await handler.handle("s1", input())).toBeNull();
  });

  it("block で続けたターン・todo_add 済み・無効・鍵なし・発話が読めないときは Jev を呼ばない", async () => {
    for (const [over, inp] of [
      [{}, input({ stopHookActive: true })],
      [
        {
          readTranscript: async () => [
            human("q"),
            tool("mcp__ark-board__todo_add"),
            toolResult(),
            say("足した"),
          ],
        },
        input(),
      ],
      [{ todoEnabled: () => false }, input()],
      [{ apiKey: () => null }, input()],
      [
        {
          readTranscript: async () => {
            throw new Error("ENOENT");
          },
        },
        input(),
      ],
    ] as const) {
      const { deps, handler } = make(over);
      expect(await handler.handle("s1", inp)).toBeNull();
      expect(deps.decideDeferred).not.toHaveBeenCalled();
    }
  });

  it("Jev の失敗は投げずに止め、同じセッションの失敗は 1 回だけ出す", async () => {
    let fail = true;
    const log = vi.fn();
    const { handler } = make({
      log,
      decideDeferred: async () => {
        if (fail) throw new Error("timeout");
        return { deferred: 0.1, cost: 0 };
      },
    });
    expect(await handler.handle("s1", input())).toBeNull();
    expect(await handler.handle("s1", input())).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    fail = false;
    await handler.handle("s1", input());
    expect(log).toHaveBeenLastCalledWith("s1: Jev が回復した");
  });
});
