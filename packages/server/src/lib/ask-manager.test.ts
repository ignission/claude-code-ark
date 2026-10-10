import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AskState } from "@ark/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASK_SESSION_PREFIX,
  AskManager,
  type AskManagerDeps,
  parseAskLine,
  type TmuxResult,
} from "./ask-manager.js";
import { encodeProjectDir } from "./claude-projects.js";

let root: string;
let calls: string[][];
let sessions: Set<string>;
let panes: string[];
let ids: string[];
let clock: number;

const TRUST =
  " Accessing workspace:\n ❯ No, exit\n   Yes, I trust this folder\n";
const PROMPT = "────\n❯ \n────\n";

function tmux(args: string[]): TmuxResult {
  calls.push(args);
  const target = args[args.indexOf("-t") + 1];
  switch (args[0]) {
    case "list-sessions":
      return { status: 0, stdout: [...sessions].join("\n") };
    case "has-session":
      return { status: sessions.has(target) ? 0 : 1, stdout: "" };
    case "new-session":
      sessions.add(args[args.indexOf("-s") + 1]);
      return { status: 0, stdout: "" };
    case "kill-session":
      sessions.delete(target);
      return { status: 0, stdout: "" };
    case "capture-pane":
      return { status: 0, stdout: panes.shift() ?? PROMPT };
    default:
      return { status: 0, stdout: "" };
  }
}

function make(overrides: Partial<AskManagerDeps> = {}) {
  const manager = new AskManager({
    tmux,
    claudeCommand: "'/opt/claude'",
    dir: path.join(root, "ask"),
    projectsDir: path.join(root, "projects"),
    sleep: async () => {
      clock += 500;
    },
    now: () => clock,
    newId: () => ids.shift() ?? "id-x",
    ...overrides,
  });
  const states: AskState[] = [];
  manager.on("state", state => states.push(state));
  return { manager, states };
}

function transcript(id: string): string {
  const dir = path.join(
    root,
    "projects",
    encodeProjectDir(path.join(root, "ask"))
  );
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.jsonl`);
}
function append(id: string, ...rows: object[]) {
  fs.appendFileSync(
    transcript(id),
    rows.map(row => `${JSON.stringify(row)}\n`).join("")
  );
}
const user = (uuid: string, text: string) => ({
  type: "user",
  uuid,
  message: { role: "user", content: text },
});
const assistant = (
  uuid: string,
  text: string,
  stop: string | null = "end_turn"
) => ({
  type: "assistant",
  uuid,
  message: { content: [{ type: "text", text }], stop_reason: stop },
});
const tick = () => vi.advanceTimersByTime(400);
const sent = () =>
  calls.filter(c => c[0] === "send-keys").map(c => c.slice(3).join(" "));

beforeEach(() => {
  vi.useFakeTimers();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ark-ask-")));
  calls = [];
  sessions = new Set();
  panes = [];
  ids = ["id-1", "id-2"];
  clock = 1_000;
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("parseAskLine", () => {
  it("人の発話と Claude の text を取り出し、ターンの終わりを知らせる", () => {
    expect(parseAskLine(JSON.stringify(user("u1", "こんにちは")), 1)).toEqual({
      message: { id: "u1", role: "user", text: "こんにちは" },
      done: false,
    });
    expect(parseAskLine(JSON.stringify(assistant("a1", "やあ")), 2)).toEqual({
      message: { id: "a1", role: "assistant", text: "やあ" },
      done: true,
    });
    expect(
      parseAskLine(JSON.stringify(assistant("a2", "途中", null)), 3)?.done
    ).toBe(false);
  });

  it("hook やローカルコマンドの行、考え中だけの行、壊れた行は出さない", () => {
    expect(
      parseAskLine(JSON.stringify({ ...user("u", "x"), isMeta: true }), 1)
    ).toBeNull();
    expect(
      parseAskLine(JSON.stringify(user("u", "<local-command-stdout>")), 1)
    ).toBeNull();
    expect(
      parseAskLine(
        JSON.stringify(user("u", "<command-name>/clear</command-name>")),
        1
      )
    ).toBeNull();
    expect(
      parseAskLine(
        JSON.stringify({
          type: "assistant",
          uuid: "a",
          message: { content: [{ type: "thinking", thinking: "…" }] },
        }),
        1
      )
    ).toEqual({ message: null, done: false });
    expect(parseAskLine("{壊れた", 1)).toBeNull();
    expect(parseAskLine(JSON.stringify({ type: "mode" }), 1)).toBeNull();
  });
});

describe("AskManager", () => {
  it("最初に聞くとき、専用のフォルダで道具なしの claude を起動してから文を送る", async () => {
    const { manager, states } = make();
    await manager.ask("1+1は?");
    const created = calls.find(c => c[0] === "new-session");
    expect(created).toContain(`${ASK_SESSION_PREFIX}id-1`);
    expect(created?.[created.indexOf("-c") + 1]).toBe(path.join(root, "ask"));
    expect(fs.existsSync(path.join(root, "ask"))).toBe(true);
    expect(sent()).toEqual([
      "unset CLAUDE_CONFIG_DIR; exec '/opt/claude' --tools '' --strict-mcp-config --session-id id-1 Enter",
      "-l 1+1は?",
      "Enter",
    ]);
    // 送った文はすぐに出し、答えを待つ
    expect(states.at(-1)).toMatchObject({
      messages: [{ role: "user", text: "1+1は?" }],
      busy: true,
      error: null,
    });
  });

  it("フォルダの信頼の確認が出ていたら「はい」を選んでから進む", async () => {
    panes = [TRUST, "起動中…", PROMPT];
    const { manager } = make();
    await manager.ask("やあ");
    expect(sent().slice(1, 3)).toEqual(["Down", "Enter"]);
    expect(sent().at(-2)).toBe("-l やあ");
  });

  it("答えは transcript から読み、ターンが終わったら待つのをやめる", async () => {
    const { manager, states } = make();
    await manager.ask("1+1は?");
    append("id-1", user("u1", "1+1は?"), assistant("a1", "考えます", null));
    tick();
    expect(states.at(-1)).toMatchObject({
      messages: [
        { id: "u1", role: "user", text: "1+1は?" },
        { id: "a1", role: "assistant", text: "考えます" },
      ],
      busy: true,
    });
    append("id-1", assistant("a2", "2 です"));
    tick();
    expect(states.at(-1)?.busy).toBe(false);
    expect(states.at(-1)?.messages).toHaveLength(3);
  });

  it("続けて聞くと同じセッションへ送り、前の答えのあとも次の答えを待つ", async () => {
    const { manager, states } = make();
    await manager.ask("1つ目");
    await manager.ask("2つ目");
    expect(calls.filter(c => c[0] === "new-session")).toHaveLength(1);
    append("id-1", user("u1", "1つ目"), assistant("a1", "答え1"));
    tick();
    // 2つ目がまだ transcript に出ていないので、待ち続ける
    expect(states.at(-1)?.busy).toBe(true);
    expect(states.at(-1)?.messages.map(m => m.text)).toEqual([
      "1つ目",
      "答え1",
      "2つ目",
    ]);
    append("id-1", user("u2", "2つ目"), assistant("a2", "答え2"));
    tick();
    expect(states.at(-1)?.busy).toBe(false);
  });

  it("`<` で始まる質問も発話として扱い、答えたら待つのをやめる", async () => {
    const { manager, states } = make();
    await manager.ask("<div>これは何?</div>");
    append("id-1", user("u1", "<div>これは何?</div>"), assistant("a1", "HTML"));
    tick();
    expect(states.at(-1)).toMatchObject({
      messages: [
        { role: "user", text: "<div>これは何?</div>" },
        { role: "assistant", text: "HTML" },
      ],
      busy: false,
    });
  });

  it("改行は空白にして送る (改行は入力の確定になる)", async () => {
    const { manager } = make();
    await manager.ask("1行目\n  2行目");
    expect(sent().at(-2)).toBe("-l 1行目 2行目");
  });

  it("空の文と長すぎる文は送らない", async () => {
    const { manager } = make();
    await expect(manager.ask("  \n ")).rejects.toThrow("空");
    await expect(manager.ask("あ".repeat(8_001))).rejects.toThrow("長すぎ");
    expect(calls.filter(c => c[0] === "new-session")).toHaveLength(0);
  });

  it("起動しなければセッションを片付け、失敗を状態に出す", async () => {
    panes = Array.from({ length: 200 }, () => "起動中…");
    const { manager, states } = make();
    await expect(manager.ask("やあ")).rejects.toThrow("起動しません");
    expect(sessions.size).toBe(0);
    expect(states.at(-1)).toMatchObject({
      messages: [],
      busy: false,
      error: "裏の Claude が起動しませんでした",
    });
  });

  it("答えが長く来なければ、待つのをやめて知らせる", async () => {
    const { manager, states } = make();
    await manager.ask("やあ");
    clock += 5 * 60_000 + 1;
    tick();
    expect(states.at(-1)).toMatchObject({
      busy: false,
      error: "答えが返ってきませんでした",
    });
  });

  it("まっさらにするとセッションを終わらせ、次は新しい会話で始める", async () => {
    const { manager, states } = make();
    await manager.ask("1つ目");
    append("id-1", user("u1", "1つ目"), assistant("a1", "答え1"));
    tick();
    await manager.reset();
    expect(sessions.size).toBe(0);
    expect(states.at(-1)).toEqual({ messages: [], busy: false, error: null });
    await manager.ask("2つ目");
    expect([...sessions]).toEqual([`${ASK_SESSION_PREFIX}id-2`]);
    expect(states.at(-1)?.messages.map(m => m.text)).toEqual(["2つ目"]);
  });

  it("サーバーを再起動しても、残っているセッションの会話を読み直す", () => {
    sessions.add("ark-main");
    sessions.add(`${ASK_SESSION_PREFIX}old-id`);
    append("old-id", user("u1", "前の質問"), assistant("a1", "前の答え"));
    const { manager } = make();
    manager.init();
    expect(manager.getState()).toEqual({
      messages: [
        { id: "u1", role: "user", text: "前の質問" },
        { id: "a1", role: "assistant", text: "前の答え" },
      ],
      busy: false,
      error: null,
    });
    expect(calls.some(c => c[0] === "new-session")).toBe(false);
  });

  it("セッションが外から消えていたら、聞いたときに作り直す", async () => {
    const { manager } = make();
    await manager.ask("1つ目");
    sessions.clear();
    await manager.ask("2つ目");
    expect([...sessions]).toEqual([`${ASK_SESSION_PREFIX}id-2`]);
  });
});
