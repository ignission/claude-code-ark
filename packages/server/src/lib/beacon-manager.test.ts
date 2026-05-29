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
import { buildAuthenticatedExternalMcps } from "./mcp-oauth/build-mcp-servers.js";

const mockedSpawn = vi.mocked(spawn);
const mockedBuildExternal = vi.mocked(buildAuthenticatedExternalMcps);

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
const deltaLine = (text: string) =>
  JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });

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
  // queue 済み mockImplementationOnce が次テストに漏れないよう実装ごとリセットする
  // (spawn が discard されたテストでは once-impl が未消費のまま残るため)
  mockedSpawn.mockReset();
  mockedBuildExternal.mockReset();
  mockedBuildExternal.mockResolvedValue([]);
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
  it("stream_event の text_delta をライブ配信し、result で beacon:message を確定する", async () => {
    programChild([
      initLine("sid-1"),
      // 逐次 delta (ライブ描画用)
      deltaLine("こんに"),
      deltaLine("ちは"),
      // 完全な assistant block (確定テキスト用)
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

    // user メッセージ + assistant メッセージ (確定テキストは assistant block 由来) が emit される
    expect(messages).toContainEqual({ role: "user", content: "やあ" });
    expect(messages).toContainEqual({
      role: "assistant",
      content: "こんにちは",
    });
    // delta がライブ配信され、最後に done (空 chunk) が来る
    expect(streams.join("")).toContain("こんにちは");
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
    // 逐次ストリーミング有効化フラグ
    expect(args).toContain("--include-partial-messages");
    // operator のグローバル MCP 設定を読み込ませないよう isolate する
    expect(args).toContain("--strict-mcp-config");
    // 権限モードを default に固定する
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    // 標準プロンプトを保持するため置換ではなく append を使う
    expect(args).toContain("--append-system-prompt");
    expect(args).not.toContain("--system-prompt");
  });

  it("非 success の result は beacon:error を emit する", async () => {
    programChild([
      initLine("sid-e"),
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "ターン上限に達しました",
      }),
    ]);

    const errors: string[] = [];
    beaconManager.on("beacon:error", e => errors.push(e.error));

    await beaconManager.sendMessage("test");

    expect(errors).toContain("ターン上限に達しました");
  });

  it("実在する登録リポジトリは --add-dir で workspace に追加される", async () => {
    // getRepos が実在ディレクトリ (/tmp) と非実在を返すケース
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
      getRepos: () => ["/tmp", "/nonexistent/repo/path/xyz"],
      listProfiles: () => [],
      linkWorktreeProfile: () => true,
    });
    programChild([initLine("sid-d"), assistantLine("ok"), resultLine("ok")]);

    await beaconManager.sendMessage("test");

    const args = mockedSpawn.mock.calls[0]?.[1] as string[];
    // 実在する /tmp は追加され、存在しないパスは除外される
    expect(args).toContain("--add-dir");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/tmp");
    expect(args).not.toContain("/nonexistent/repo/path/xyz");
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

    // セッションを事前確立して sendMessage が startSession を await しないようにする
    // (await すると A の sendMessage だけ 1 microtask 遅れ、ロック取得順が逆転する)
    await beaconManager.startSession();

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
    // 破棄された B の user message は履歴に記録されない (Claude が見ていないため)
    const recorded = dbMock.addBeaconMessage.mock.calls.map(
      c => (c[0] as { content?: string }).content
    );
    expect(recorded).not.toContain("B");
  });

  it("closeSession({resetConversation:true}) は cliSessionId を破棄する (stop-and-reset)", async () => {
    programChild([initLine("sid-R"), assistantLine("ok"), resultLine("ok")]);
    await beaconManager.sendMessage("x");
    expect(dbMock.setSetting).toHaveBeenCalledWith(
      "beacon_cli_session_id",
      "sid-R"
    );
    beaconManager.closeSession({ resetConversation: true });
    expect(dbMock.deleteSetting).toHaveBeenCalledWith("beacon_cli_session_id");
  });

  it("live session が無くても resetConversation は cliSessionId を破棄する (restart/idle 後)", () => {
    // beforeEach の closeSession で this.session は null の状態
    expect(beaconManager.hasSession()).toBe(false);
    beaconManager.closeSession({ resetConversation: true });
    // live session が無くても settings の cliSessionId は破棄される
    expect(dbMock.deleteSetting).toHaveBeenCalledWith("beacon_cli_session_id");
  });

  it("close 後にバッファ残留した stream_event delta は emit されない", async () => {
    const childA = makeFakeChild();
    mockedSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        childA.stdout.emit("data", Buffer.from(`${initLine("sid-c")}\n`));
        // result は出さず保留 (turn 進行中)
      });
      return childA as unknown as ReturnType<typeof spawn>;
    });

    const chunks: string[] = [];
    beaconManager.on("beacon:stream", e => {
      if (e.chunk) chunks.push(e.chunk);
    });

    const send = beaconManager.sendMessage("A");
    await new Promise(r => setTimeout(r, 20)); // spawn + init 済み

    beaconManager.closeSession(); // this.session=null, child を kill

    // close 後に stdout バッファ残留 delta が届く状況を再現
    childA.stdout.emit("data", Buffer.from(`${deltaLine("LEAK")}\n`));
    childA.emit("close", null);
    await send;

    // canceled turn の delta は UI に漏れない
    expect(chunks).not.toContain("LEAK");
  });

  it("進行中ターンを kill する closeSession は cliSessionId を破棄する", async () => {
    dbMock.getSetting.mockReturnValue("inflight-sid");
    const childA = makeFakeChild();
    mockedSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        // init は出すが result は出さず保留 (ターン進行中)
        childA.stdout.emit(
          "data",
          Buffer.from(`${initLine("inflight-sid")}\n`)
        );
      });
      return childA as unknown as ReturnType<typeof spawn>;
    });

    const send = beaconManager.sendMessage("A");
    await new Promise(r => setTimeout(r, 20)); // spawn + init 済み (turn 進行中)

    beaconManager.closeSession(); // resetConversation なしでも進行中なら破棄

    childA.emit("close", null);
    await send;

    // 中途半端な会話を次回 --resume しないよう cliSessionId は破棄される
    expect(dbMock.deleteSetting).toHaveBeenCalledWith("beacon_cli_session_id");
  });

  it("起動準備 (buildLaunchConfig) の最中に reset されたら spawn しない", async () => {
    // buildAuthenticatedExternalMcps を遅延させ、その await 中に closeSession する
    mockedBuildExternal.mockImplementationOnce(async () => {
      await new Promise(r => setTimeout(r, 40));
      return [];
    });
    programChild([initLine("sid-x"), assistantLine("ok"), resultLine("ok")]);

    const p = beaconManager.sendMessage("x"); // 起動準備に入る
    await new Promise(r => setTimeout(r, 10)); // buildLaunchConfig の await 中
    beaconManager.closeSession(); // activeChild はまだ null
    await p;

    // 準備完了後に reset を検知し、spawn には到達しない
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("resume 先が見つからない result エラーは新規会話で再試行する", async () => {
    dbMock.getSetting.mockReturnValue("stale-sid");
    // 1 回目 (--resume stale-sid): No conversation found エラー result
    const childA = makeFakeChild();
    mockedSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        childA.stdout.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              errors: ["No conversation found with session ID: stale-sid"],
            })}\n`
          )
        );
        childA.emit("close", 1);
      });
      return childA as unknown as ReturnType<typeof spawn>;
    });
    // 2 回目 (新規会話): 正常応答
    programChild([initLine("new-sid"), assistantLine("ok"), resultLine("ok")]);

    const errors: string[] = [];
    beaconManager.on("beacon:error", e => errors.push(e.error));

    await beaconManager.sendMessage("test");

    // 2 回 spawn され、1 回目は --resume 付き、2 回目は無し
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    const args1 = mockedSpawn.mock.calls[0]?.[1] as string[];
    const args2 = mockedSpawn.mock.calls[1]?.[1] as string[];
    expect(args1).toContain("--resume");
    expect(args2).not.toContain("--resume");
    // resume 失敗自体は beacon:error として表面化しない (retry で回復)
    expect(errors).not.toContain(
      "No conversation found with session ID: stale-sid"
    );
    // 古い cliSessionId は破棄される
    expect(dbMock.deleteSetting).toHaveBeenCalledWith("beacon_cli_session_id");
  });

  it("resume 以外の result エラーは beacon:error を出し cliSessionId を消さない", async () => {
    dbMock.getSetting.mockReturnValue("keep-sid");
    programChild([
      initLine("keep-sid"),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Tool execution failed"],
      }),
    ]);

    const errors: string[] = [];
    beaconManager.on("beacon:error", e => errors.push(e.error));

    await beaconManager.sendMessage("test");

    // 再試行しない (spawn は 1 回)
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    // エラーは通知される
    expect(errors).toContain("Tool execution failed");
    // cliSessionId は保持 (resume 失敗ではないため消さない)
    expect(dbMock.deleteSetting).not.toHaveBeenCalledWith(
      "beacon_cli_session_id"
    );
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
    // launch 失敗 (init 未受信) では user message を履歴に記録しない
    const recorded = dbMock.addBeaconMessage.mock.calls.map(
      c => (c[0] as { content?: string }).content
    );
    expect(recorded).not.toContain("test");
  });
});
