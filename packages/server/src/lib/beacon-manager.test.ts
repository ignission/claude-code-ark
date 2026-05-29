/**
 * BeaconManager (claude CLI stream-json 駆動) のユニットテスト。
 *
 * child_process.spawn をモックして fake な claude プロセスの stream-json 出力を
 * 流し込み、beacon:stream / beacon:message の emit と cliSessionId 永続化を検証する。
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- モック (vi.mock は hoist される) ---
vi.mock("./system.js", () => ({
  resolveClaudePath: vi.fn(() => "/usr/bin/claude"),
}));

// dbMock は vi.mock factory より先に評価される必要があるため vi.hoisted で生成する
const dbMock = vi.hoisted(() => ({
  getBeaconMessages: vi.fn(() => [] as unknown[]),
  addBeaconMessage: vi.fn(),
  clearBeaconMessages: vi.fn(),
  getSetting: vi.fn(() => undefined as unknown),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));
vi.mock("./database.js", () => ({ db: dbMock }));

vi.mock("./ark-mcp-server.js", () => ({
  ArkMcpServer: class {
    start = vi.fn(async () => ({
      url: "http://127.0.0.1:65000/mcp",
      token: "test-token",
    }));
    stop = vi.fn();
    getEndpoint = vi.fn(() => null);
  },
}));

vi.mock("./mcp-oauth/build-mcp-servers.js", () => ({
  buildAuthenticatedExternalMcps: vi.fn(async () => []),
}));

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { beaconManager } from "./beacon-manager.js";

const mockedSpawn = vi.mocked(spawn);

/** fake な claude 子プロセス (EventEmitter + stdout/stderr/stdin) */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (s: string, cb?: () => void) => boolean; end: () => void };
  kill: (signal?: string) => boolean;
  killed: boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: (_s: string, cb?: () => void) => {
      cb?.();
      return true;
    },
    end: vi.fn(),
  };
  child.killed = false;
  child.kill = vi.fn((_signal?: string) => {
    child.killed = true;
    return true;
  });
  return child;
}

const initLine = (sessionId: string) =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
const assistantLine = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
const resultLine = (result: string) =>
  JSON.stringify({ type: "result", subtype: "success", result });

/**
 * spawn が呼ばれたら fake child を返し、指定の stream-json 行を順次 emit して
 * close する。各 emit は microtask で非同期に行う (実際の stdout 挙動に近づける)。
 */
function programChild(lines: string[], opts: { closeCode?: number } = {}) {
  const child = makeFakeChild();
  mockedSpawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      for (const line of lines) {
        child.stdout.emit("data", Buffer.from(`${line}\n`));
      }
      child.emit("close", opts.closeCode ?? 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.getBeaconMessages.mockReturnValue([]);
  dbMock.getSetting.mockReturnValue(undefined);
  beaconManager.removeAllListeners();
  beaconManager.closeSession();
  beaconManager.configure({
    getAllSessions: () => [],
    startSession: async () => ({}),
    stopSession: () => null,
    sendMessage: () => {},
    sendKey: () => {},
    capturePane: () => null,
    getPrUrl: async () => null,
    listWorktrees: async () => [],
    listAllWorktrees: async () => [],
    createWorktree: async () => ({}),
    deleteWorktree: async () => {},
    getRepos: () => [],
    listProfiles: () => [],
    linkWorktreeProfile: () => true,
  });
});

describe("BeaconManager (CLI stream-json)", () => {
  it("assistant テキストを beacon:stream で流し、result で beacon:message を確定する", async () => {
    programChild([
      initLine("sid-1"),
      assistantLine("こんにちは"),
      resultLine("こんにちは"),
    ]);

    const streams: string[] = [];
    const messages: { role: string; content: string }[] = [];
    beaconManager.on("beacon:stream", e => streams.push(e.chunk));
    beaconManager.on("beacon:message", m =>
      messages.push({ role: m.role, content: m.content })
    );

    await beaconManager.sendMessage("やあ");

    // user メッセージ + assistant メッセージが emit される
    expect(messages).toContainEqual({ role: "user", content: "やあ" });
    expect(messages).toContainEqual({
      role: "assistant",
      content: "こんにちは",
    });
    // streaming chunk が流れ、最後に done (空 chunk) が来る
    expect(streams.join("")).toContain("こんにちは");
    // 最後の beacon:stream は done=true (空文字)
    expect(streams[streams.length - 1]).toBe("");
  });

  it("init message の session_id を settings に永続化する (--resume 用)", async () => {
    programChild([initLine("sid-xyz"), assistantLine("hi"), resultLine("hi")]);
    await beaconManager.sendMessage("test");
    expect(dbMock.setSetting).toHaveBeenCalledWith(
      "beacon_cli_session_id",
      "sid-xyz"
    );
  });

  it("壊れた JSON 行はスキップして処理を継続する", async () => {
    programChild([
      initLine("sid-2"),
      "this is not json{{{",
      assistantLine("正常応答"),
      resultLine("正常応答"),
    ]);

    const messages: string[] = [];
    beaconManager.on("beacon:message", m => {
      if (m.role === "assistant") messages.push(m.content);
    });

    await beaconManager.sendMessage("test");
    expect(messages).toContain("正常応答");
  });

  it("既存 cliSessionId があれば spawn 引数に --resume が含まれる", async () => {
    dbMock.getSetting.mockReturnValue("existing-sid");
    programChild([
      initLine("existing-sid"),
      assistantLine("ok"),
      resultLine("ok"),
    ]);

    await beaconManager.sendMessage("test");

    const args = mockedSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("existing-sid");
    // stream-json 駆動の必須フラグも確認
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--strict-mcp-config");
  });

  it("session reset 後にキューされた turn は spawn せず破棄される", async () => {
    // turn A: result を出さず保留する child (turnLock を握り続ける)
    const childA = makeFakeChild();
    mockedSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        childA.stdout.emit("data", Buffer.from(`${initLine("sid-A")}\n`));
        // result を出さない → ターン進行中のまま
      });
      return childA as unknown as ReturnType<typeof spawn>;
    });

    const sendA = beaconManager.sendMessage("A"); // 進行中
    const sendB = beaconManager.sendMessage("B"); // turnLock 待ちで queue される

    // A が spawn 済み・B が lock 待ちになるまで待つ
    await new Promise(r => setTimeout(r, 20));
    expect(mockedSpawn).toHaveBeenCalledTimes(1); // A のみ起動

    // セッションを破棄 (clearHistory / stop-and-reset 相当)
    beaconManager.closeSession();
    // A の child は kill された扱いで close する
    childA.emit("close", null);

    await Promise.allSettled([sendA, sendB]);

    // B は破棄され、2 回目の spawn は起きない
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it("result を受信せず非0終了したら beacon:error を emit する (新規会話時)", async () => {
    // 新規会話 (cliSessionId なし) かつ init も来ずに異常終了
    const child = makeFakeChild();
    mockedSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("boom"));
        child.emit("close", 1);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });

    const errors: string[] = [];
    beaconManager.on("beacon:error", e => errors.push(e.error));

    await expect(beaconManager.sendMessage("test")).rejects.toThrow();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("boom");
  });
});
