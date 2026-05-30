/**
 * BeaconManager (tmux 対話版 claude + JSONL tail 駆動) のユニットテスト。
 *
 * BeaconCliSession (tmux/JSONL の実体) をモックし、manager レイヤの責務を検証する:
 * - send-keys 相当 (cliSession.sendTurn) の結果を beacon:stream / beacon:message に変換
 * - ターン完了/タイムアウト/無応答のハンドリング
 * - ark-beacon MCP を永続 port + token で起動 (再起動後も同一エンドポイント)
 * - MCP 構成変更 (markMcpConfigStale) 時の tmux 貼り直し + stale token 非再露出
 * - clear / stop-and-reset / close での tmux セッション kill 方針
 * - 起動準備中 reset 時の turn 破棄
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- モック (vi.mock は hoist される) ---

// 起動ファイルの実書き込みを避け、内容を検査できるようにする
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:fs", () => fsMock);

vi.mock("./paths.js", () => ({ getDataDir: () => "/tmp/ark-test-data" }));

const dbMock = vi.hoisted(() => ({
  getBeaconMessages: vi.fn(() => [] as unknown[]),
  addBeaconMessage: vi.fn(),
  clearBeaconMessages: vi.fn(),
  deleteBeaconMessage: vi.fn(),
  getSetting: vi.fn(() => undefined as unknown),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));
vi.mock("./database.js", () => ({ db: dbMock }));

// ArkMcpServer.start を全インスタンス共有の hoisted mock にする
const arkStartMock = vi.hoisted(() =>
  vi.fn(async (_deps: unknown, _opts?: unknown) => ({
    url: "http://127.0.0.1:65000/mcp",
    token: "test-token",
  }))
);
const arkStopMock = vi.hoisted(() => vi.fn());
vi.mock("./ark-mcp-server.js", () => ({
  ArkMcpServer: class {
    start = arkStartMock;
    stop = arkStopMock;
    getEndpoint = vi.fn(() => null);
  },
}));

vi.mock("./mcp-oauth/build-mcp-servers.js", () => ({
  buildAuthenticatedExternalMcps: vi.fn(async () => []),
}));

// BeaconCliSession (tmux + JSONL) のモック。module-level state を介して制御する。
const cliMock = vi.hoisted(() => ({
  running: false,
  startConfigs: [] as Array<Record<string, unknown>>,
  sendTurnCalls: [] as Array<{
    message: string;
    isAborted?: () => boolean;
  }>,
  killCount: 0,
  /** attachIfRunning の戻り (running かつ ready 相当)。false で start パスへ誘導 */
  attachable: true,
  /** JSONL transcript を特定済みか (post-restart 初回 attach のみ false) */
  hasTranscript: false,
  /** recoverPending の戻り値 (取りこぼし回収の注入用)。null なら回収なし */
  recoverResult: null as null | {
    text: string;
    toolUse?: { toolName: string; input: string };
    completed: boolean;
  },
  /** start() の挙動を差し替える (未認証エラー注入等)。null なら running=true にするだけ */
  startImpl: null as null | ((cfg: Record<string, unknown>) => Promise<void>),
  /** sendTurn() の挙動を差し替える。null ならデフォルト応答 */
  sendTurnImpl: null as
    | null
    | ((
        message: string,
        handlers: { onText: (c: string) => void }
      ) => Promise<{
        text: string;
        toolUse?: { toolName: string; input: string };
        completed: boolean;
      }>),
}));
vi.mock("./beacon-cli-session.js", () => ({
  BEACON_TMUX_SESSION: "ark-beacon",
  BeaconCliSession: class {
    isRunning() {
      return cliMock.running;
    }
    attachIfRunning() {
      return cliMock.running && cliMock.attachable;
    }
    hasTranscript() {
      return cliMock.hasTranscript;
    }
    getTranscriptOffset() {
      return { path: "ark-beacon.jsonl", lines: 0 };
    }
    recoverPending(
      _saved: unknown,
      _handlers: { onText: (c: string) => void }
    ) {
      cliMock.hasTranscript = true;
      return cliMock.recoverResult;
    }
    async start(cfg: Record<string, unknown>, _timeout: number) {
      cliMock.startConfigs.push(cfg);
      if (cliMock.startImpl) {
        await cliMock.startImpl(cfg);
        return;
      }
      cliMock.running = true;
      // transcript の baseline/特定は reconcile (recoverPending) 側で行う (実体と同じ)
    }
    kill() {
      cliMock.killCount += 1;
      cliMock.running = false;
      cliMock.hasTranscript = false;
    }
    async sendTurn(
      message: string,
      handlers: { onText: (c: string) => void },
      _timeout: number,
      isAborted?: () => boolean
    ) {
      cliMock.sendTurnCalls.push({ message, isAborted });
      if (cliMock.sendTurnImpl) return cliMock.sendTurnImpl(message, handlers);
      handlers.onText("応答");
      return { text: "応答", toolUse: undefined, completed: true };
    }
  },
}));

import type { ChatMessage } from "@ark/shared";
import { BeaconManager, beaconManager } from "./beacon-manager.js";
import { buildAuthenticatedExternalMcps } from "./mcp-oauth/build-mcp-servers.js";

const mockedBuildExternal = vi.mocked(buildAuthenticatedExternalMcps);

/** beacon イベントを収集する */
function collect() {
  const events = {
    stream: [] as Array<{ chunk: string; done: boolean }>,
    message: [] as ChatMessage[],
    error: [] as Array<{ error: string }>,
    external: [] as ChatMessage[],
    history: [] as Array<{ messages: ChatMessage[] }>,
  };
  beaconManager.on("beacon:stream", e => events.stream.push(e));
  beaconManager.on("beacon:message", e => events.message.push(e));
  beaconManager.on("beacon:error", e => events.error.push(e));
  beaconManager.on("beacon:external-message", e => events.external.push(e));
  beaconManager.on("beacon:history", e => events.history.push(e));
  return events;
}

/** writeFileSync に書かれた mcp-config.json をパースして返す (新しい順ではなく呼び出し順) */
function mcpConfigWrites(): Array<{ mcpServers: Record<string, unknown> }> {
  return fsMock.writeFileSync.mock.calls
    .filter(c => String(c[0]).endsWith("mcp-config.json"))
    .map(c => JSON.parse(String(c[1])));
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise(r => setTimeout(r, 5));
  }
}

const EXTERNAL_E = {
  connectionId: "conn-jira",
  label: "My Jira",
  providerId: "atlassian",
  config: { type: "http" as const, url: "https://x.atlassian.net/mcp" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedBuildExternal.mockReset();
  mockedBuildExternal.mockResolvedValue([]);
  arkStartMock.mockReset();
  arkStartMock.mockResolvedValue({
    url: "http://127.0.0.1:65000/mcp",
    token: "test-token",
  });
  dbMock.getBeaconMessages.mockReturnValue([]);
  dbMock.getSetting.mockReturnValue(undefined);

  cliMock.running = false;
  cliMock.startConfigs.length = 0;
  cliMock.sendTurnCalls.length = 0;
  cliMock.killCount = 0;
  cliMock.attachable = true;
  cliMock.hasTranscript = false;
  cliMock.recoverResult = null;
  cliMock.startImpl = null;
  cliMock.sendTurnImpl = null;

  // シングルトンの in-memory フラグはテスト間で leak するため明示的にリセットする
  // (launchArkAvailable は constructor 時に DB から読むだけで再評価されないため)。
  const internals = beaconManager as unknown as {
    launchArkAvailable: boolean;
    mcpStale: boolean;
    activeTurnCount: number;
    pendingExternalMessages: unknown[];
    reconnectRecovered: boolean;
    pendingHistoryReset: boolean;
    reconnectRetryTimer: ReturnType<typeof setTimeout> | null;
    reconcileSettleTimer: ReturnType<typeof setTimeout> | null;
  };
  // 前テストが仕掛けた遅延タイマーを解除する (firing が後続テストに漏れないように)
  if (internals.reconnectRetryTimer)
    clearTimeout(internals.reconnectRetryTimer);
  if (internals.reconcileSettleTimer)
    clearTimeout(internals.reconcileSettleTimer);
  internals.reconnectRetryTimer = null;
  internals.reconcileSettleTimer = null;
  internals.launchArkAvailable = true;
  internals.mcpStale = false;
  internals.activeTurnCount = 0;
  internals.pendingExternalMessages = [];
  internals.reconnectRecovered = false;
  internals.pendingHistoryReset = false;

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

describe("BeaconManager (tmux 対話版)", () => {
  it("応答を beacon:stream(live) で配信し beacon:message(確定) で締める", async () => {
    const ev = collect();
    await beaconManager.sendMessage("こんにちは");

    // live チャンク
    expect(ev.stream.some(s => s.chunk === "応答" && !s.done)).toBe(true);
    // 確定 assistant メッセージ
    const assistant = ev.message.find(m => m.role === "assistant");
    expect(assistant?.content).toBe("応答");
    // done で締める
    expect(ev.stream.at(-1)).toEqual({ chunk: "", done: true });
  });

  it("user メッセージを起動確定後に記録・配信する (user→assistant 順)", async () => {
    const ev = collect();
    await beaconManager.sendMessage("質問です");

    expect(ev.message[0]?.role).toBe("user");
    expect(ev.message[0]?.content).toBe("質問です");
    expect(ev.message[1]?.role).toBe("assistant");
    // DB へ user + assistant が記録される
    const roles = dbMock.addBeaconMessage.mock.calls.map(
      c => (c[0] as ChatMessage).role
    );
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("ターン未完了 (タイムアウト) は runaway を kill し beacon:error を emit する", async () => {
    cliMock.sendTurnImpl = async () => ({
      text: "途中まで",
      completed: false,
    });
    const ev = collect();
    const killsBefore = cliMock.killCount;
    await beaconManager.sendMessage("x");

    // 10分超の runaway は kill して中断 (遅延応答による desync を防ぐ)
    expect(cliMock.killCount).toBe(killsBefore + 1);
    expect(ev.error.length).toBe(1);
    expect(ev.error[0].error).toContain("タイムアウト");
    // 中断した partial は DB に記録しない (claude 文脈も破棄したため)
    const roles = dbMock.addBeaconMessage.mock.calls.map(
      c => (c[0] as ChatMessage).role
    );
    expect(roles).not.toContain("assistant");
    expect(ev.stream.at(-1)).toEqual({ chunk: "", done: true });
  });

  it("完了したが応答が空なら無応答エラーを emit する", async () => {
    cliMock.sendTurnImpl = async () => ({ text: "", completed: true });
    const ev = collect();
    await beaconManager.sendMessage("x");

    expect(ev.error.some(e => e.error.includes("応答を取得できません"))).toBe(
      true
    );
    // 空応答では assistant メッセージは記録しない
    expect(ev.message.some(m => m.role === "assistant")).toBe(false);
  });

  it("ArkMcpServer を永続 port + token で起動する", async () => {
    // 永続化済みの port/token を返す
    dbMock.getSetting.mockImplementation((key: string) => {
      if (key === "beacon_ark_mcp_port") return 65123;
      if (key === "beacon_ark_mcp_token") return "x".repeat(64);
      return undefined;
    });
    await beaconManager.sendMessage("x");

    expect(arkStartMock).toHaveBeenCalledWith(expect.anything(), {
      port: 65123,
      token: "x".repeat(64),
    });
  });

  it("ark-beacon MCP token が無ければ生成して永続化する", async () => {
    await beaconManager.sendMessage("x");
    expect(dbMock.setSetting).toHaveBeenCalledWith(
      "beacon_ark_mcp_token",
      expect.any(String)
    );
    // 確定した実ポートも永続化する (url=65000)
    expect(dbMock.setSetting).toHaveBeenCalledWith(
      "beacon_ark_mcp_port",
      65000
    );
  });

  it("実在する登録リポジトリは --add-dir (start cfg.addDirs) に含まれる", async () => {
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
      getRepos: () => ["/srv/repo-a"],
      listProfiles: () => [],
      linkWorktreeProfile: () => true,
    });
    await beaconManager.sendMessage("x");
    expect(cliMock.startConfigs[0].addDirs).toContain("/srv/repo-a");
  });

  it("ArkMcpServer 起動失敗時も ark-beacon ツール無しでチャット継続する", async () => {
    arkStartMock.mockRejectedValue(new Error("listen 拒否"));
    const ev = collect();
    await beaconManager.sendMessage("x");

    // チャットは継続 (assistant 応答あり)
    expect(ev.message.some(m => m.role === "assistant")).toBe(true);
    // allowedTools に ark-beacon ツールは含まれない
    const allowed = cliMock.startConfigs[0].allowedTools as string[];
    expect(allowed.some(t => t.startsWith("mcp__ark-beacon__"))).toBe(false);
    // built-in は残る
    expect(allowed).toContain("Read");
  });

  it("ark MCP 無しで起動した degraded セッションは、回復後の次ターンで貼り直す", async () => {
    // 1ターン目: ArkMcpServer 起動失敗 → degraded 起動
    arkStartMock.mockRejectedValueOnce(new Error("listen 拒否"));
    await beaconManager.sendMessage("1");
    const killsBefore = cliMock.killCount;
    // 以降は ark が回復 (default mock が成功を返す)
    await beaconManager.sendMessage("2");

    // degraded → 回復で貼り直し (kill) が起きる
    expect(cliMock.killCount).toBe(killsBefore + 1);
    // 貼り直し後は ark-beacon ツールが allowedTools に載る
    const lastCfg = cliMock.startConfigs.at(-1);
    const allowed = lastCfg?.allowedTools as string[];
    expect(allowed.some(t => t.startsWith("mcp__ark-beacon__"))).toBe(true);
  });

  it("ark MCP が回復しないままなら degraded セッションを貼り直さない", async () => {
    arkStartMock.mockRejectedValue(new Error("listen 拒否")); // 常に失敗
    await beaconManager.sendMessage("1");
    const killsBefore = cliMock.killCount;
    await beaconManager.sendMessage("2");
    expect(cliMock.killCount).toBe(killsBefore);
  });

  it("degraded 起動を settings に永続化する (再起動跨ぎの検出用)", async () => {
    arkStartMock.mockRejectedValue(new Error("listen 拒否"));
    await beaconManager.sendMessage("1");
    expect(dbMock.setSetting).toHaveBeenCalledWith(
      "beacon_launch_ark_available",
      false
    );
  });

  it("再起動後: 永続化された degraded フラグで、回復後の初ターンに貼り直す", async () => {
    // 「前回プロセスで degraded 起動」を settings に永続化済みと仮定
    dbMock.getSetting.mockImplementation((key: string) =>
      key === "beacon_launch_ark_available" ? false : undefined
    );
    // 再起動相当: 新しい BeaconManager。tmux セッションは生存している (running=true)
    const mgr = new BeaconManager();
    mgr.configure({
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
    cliMock.running = true; // 前プロセスの degraded セッションが detached で生存
    const killsBefore = cliMock.killCount;
    // ark は回復している (default mock 成功) → degraded を検出して貼り直す
    await mgr.sendMessage("hello");
    expect(cliMock.killCount).toBe(killsBefore + 1);
    mgr.cleanup();
  });

  it("外部MCP取得が一時失敗しても直近成功分を再利用する (再起動相当の貼り直し時)", async () => {
    mockedBuildExternal.mockResolvedValueOnce([EXTERNAL_E]);
    await beaconManager.sendMessage("1"); // [E] で起動

    // resetConversation で kill → 次ターンは貼り直し
    beaconManager.closeSession({ resetConversation: true });
    mockedBuildExternal.mockRejectedValueOnce(new Error("refresh 瞬断"));
    await beaconManager.sendMessage("2"); // 再起動相当、直近成功分 [E] を再利用

    const writes = mcpConfigWrites();
    expect(writes.at(-1)?.mcpServers).toHaveProperty("conn-jira");
  });

  it("markMcpConfigStale 後は tmux を貼り直し、削除済み connection の token を再露出しない", async () => {
    mockedBuildExternal.mockResolvedValueOnce([EXTERNAL_E]);
    await beaconManager.sendMessage("1"); // [E] で起動 (running=true)
    const killsBefore = cliMock.killCount;

    beaconManager.markMcpConfigStale();
    // disconnect 直後の refresh 一時失敗を模す
    mockedBuildExternal.mockRejectedValueOnce(new Error("refresh 瞬断"));
    await beaconManager.sendMessage("2");

    // tmux を貼り直した (kill された)
    expect(cliMock.killCount).toBe(killsBefore + 1);
    // stale でキャッシュ無効化 → 再利用されず E は mcp-config に出ない
    const writes = mcpConfigWrites();
    expect(writes.at(-1)?.mcpServers).not.toHaveProperty("conn-jira");
    // 貼り直しで claude 文脈が消えるため UI 履歴もリセットする (C-B4)
    expect(dbMock.clearBeaconMessages).toHaveBeenCalled();
  });

  it("closeSession({resetConversation:true}) は tmux セッションを kill する", async () => {
    await beaconManager.sendMessage("x"); // running=true
    const before = cliMock.killCount;
    beaconManager.closeSession({ resetConversation: true });
    expect(cliMock.killCount).toBe(before + 1);
  });

  it("通常の closeSession() は tmux セッションを kill しない (文脈保持)", async () => {
    await beaconManager.sendMessage("x");
    const before = cliMock.killCount;
    beaconManager.closeSession();
    expect(cliMock.killCount).toBe(before);
  });

  it("clearHistory は tmux kill + DB クリアを行う", async () => {
    await beaconManager.sendMessage("x");
    const before = cliMock.killCount;
    beaconManager.clearHistory();
    expect(cliMock.killCount).toBe(before + 1);
    expect(dbMock.clearBeaconMessages).toHaveBeenCalled();
  });

  it("未認証等で start が失敗したら reject する (beacon:error は socket 側が emit)", async () => {
    cliMock.startImpl = async () => {
      throw new Error("Beacon 用 claude が未認証です");
    };
    const ev = collect();
    await expect(beaconManager.sendMessage("x")).rejects.toThrow("未認証");
    // loading 解除のため done だけは emit される
    expect(ev.stream.at(-1)).toEqual({ chunk: "", done: true });
  });

  it("close (非reset) 中に完了したターンは DB に記録する (UI=claude 文脈の維持)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => {
      release = r;
    });
    cliMock.sendTurnImpl = async (_msg, handlers) => {
      await gate;
      handlers.onText("遅延応答");
      return { text: "遅延応答", completed: true };
    };
    const p = beaconManager.sendMessage("q");
    await waitFor(() => cliMock.sendTurnCalls.length === 1);
    // 非 reset close: this.session=null。tmux は kill しない (claude は裏で完走)
    beaconManager.closeSession();
    release();
    await p;

    const roles = dbMock.addBeaconMessage.mock.calls.map(
      c => (c[0] as ChatMessage).role
    );
    // close 後でも claude が保持した応答を DB に確定する
    expect(roles).toContain("assistant");
  });

  it("stop-and-reset (kill) 中のターンは DB に記録しない (claude 文脈も破棄)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => {
      release = r;
    });
    cliMock.sendTurnImpl = async () => {
      await gate;
      return { text: "破棄される応答", completed: true };
    };
    const ev = collect();
    const p = beaconManager.sendMessage("q");
    await waitFor(() => cliMock.sendTurnCalls.length === 1);
    // reset: tmux kill → running=false。claude 文脈が消えるので応答も記録しない
    beaconManager.closeSession({ resetConversation: true });
    release();
    await p;

    const roles = dbMock.addBeaconMessage.mock.calls.map(
      c => (c[0] as ChatMessage).role
    );
    expect(roles).not.toContain("assistant");
    // 早期記録した user プロンプトも取り消す (claude 文脈リセットと一致させる)
    const userMsg = dbMock.addBeaconMessage.mock.calls
      .map(c => c[0] as ChatMessage)
      .find(m => m.role === "user");
    expect(dbMock.deleteBeaconMessage).toHaveBeenCalledWith(userMsg?.id);
    // 接続中クライアントの表示からも phantom プロンプトを除去するため履歴を再同期する
    expect(ev.history.length).toBeGreaterThan(0);
    // Stop を押した送信側の loading を解除するため done は必ず emit する (live=false でも)
    expect(ev.stream.some(s => s.done)).toBe(true);
    // ユーザ自身のキャンセルなのでエラーは出さない
    expect(ev.error.length).toBe(0);
  });

  it("read-only 再接続 (getHistory) でも停止中の取りこぼし応答を回収して返す", () => {
    cliMock.running = true; // 常駐セッション生存
    cliMock.attachable = true; // ready (再接続可)
    cliMock.hasTranscript = false; // post-restart 初回
    cliMock.recoverResult = { text: "停止中の応答", completed: true };
    // send せず履歴取得のみ
    const history = beaconManager.getHistory();
    // DB へ取り込まれ、getHistory (DB fallback) の結果にも含まれる
    expect(
      dbMock.addBeaconMessage.mock.calls.some(
        c => (c[0] as ChatMessage).content === "停止中の応答"
      )
    ).toBe(true);
    // dbMock.getBeaconMessages は [] を返すモックなので history 自体は空だが、
    // 回収が発火したこと (addBeaconMessage) を確認すれば十分
    expect(Array.isArray(history)).toBe(true);
  });

  it("再起動後の初回 attach で、停止中に完走した取りこぼし応答を DB へ回収する", async () => {
    cliMock.running = true; // 前プロセスの常駐セッションが生存
    cliMock.hasTranscript = false; // post-restart の初回 attach
    // 停止中に claude が裏で完走した応答が JSONL にある状態を注入
    cliMock.recoverResult = { text: "停止中に生成された応答", completed: true };
    const ev = collect();
    await beaconManager.sendMessage("次の質問");

    // 取りこぼし応答が assistant として DB に取り込まれる
    const recovered = dbMock.addBeaconMessage.mock.calls
      .map(c => c[0] as ChatMessage)
      .find(m => m.content === "停止中に生成された応答");
    expect(recovered?.role).toBe("assistant");
    // 全クライアントへ beacon:history broadcast で再同期される (回収応答を含む)
    expect(
      ev.history.some(h =>
        h.messages.some(m => m.content === "停止中に生成された応答")
      )
    ).toBe(true);
  });

  it("stop-and-reset は queue 済み external message を破棄する (新会話に漏らさない)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => {
      release = r;
    });
    cliMock.sendTurnImpl = async () => {
      await gate;
      return { text: "破棄", completed: true };
    };
    const p = beaconManager.sendMessage("q");
    await waitFor(() => cliMock.sendTurnCalls.length === 1);
    // turn 進行中に external message を queue (activeTurnCount>0 で defer される)
    beaconManager.postExternalMessage("stale usage");
    // stop-and-reset → queue は破棄されるべき
    beaconManager.closeSession({ resetConversation: true });
    release();
    await p;

    // 中断 turn の unwind で flush されても stale external は出ない
    const persisted = dbMock.addBeaconMessage.mock.calls.map(
      c => (c[0] as ChatMessage).content
    );
    expect(persisted).not.toContain("stale usage");
  });

  it("再起動 + busy で attach 不可 → start 経由でも取りこぼし応答を回収する", async () => {
    cliMock.running = true; // 常駐セッション生存
    cliMock.attachable = false; // busy で再接続不可 → start パスへ
    cliMock.recoverResult = { text: "停止中に完走した応答", completed: true };
    await beaconManager.sendMessage("q");

    const recovered = dbMock.addBeaconMessage.mock.calls
      .map(c => c[0] as ChatMessage)
      .find(m => m.content === "停止中に完走した応答");
    expect(recovered?.role).toBe("assistant");
  });

  it("tmux セッションが消えた状態で履歴が残っていれば fresh 起動時に履歴をリセットする", async () => {
    // 既存履歴あり (server 再起動前の会話) を DB が返す
    dbMock.getBeaconMessages.mockReturnValue([
      {
        id: "old",
        role: "user",
        content: "前会話",
        timestamp: new Date(),
      } as ChatMessage,
    ]);
    cliMock.running = false; // セッションは死んでいる (外部 kill / crash)
    await beaconManager.sendMessage("新規");
    // fresh claude は文脈ゼロ → 古い履歴を残さずリセットする
    expect(dbMock.clearBeaconMessages).toHaveBeenCalled();
  });

  it("再起動後 ark MCP が起動できない (bind 失敗) と degraded で貼り直す", async () => {
    cliMock.running = true; // 前プロセスの ark 有りセッションが生存
    arkStartMock.mockRejectedValue(new Error("bind 失敗")); // ark 死亡
    const before = cliMock.killCount;
    await beaconManager.sendMessage("x");
    // 旧 endpoint を指したまま黙って失敗させず、degraded で貼り直す
    expect(cliMock.killCount).toBe(before + 1);
  });

  it("再起動後 ark ポート競合 (ephemeral fallback) でセッションを貼り直す", async () => {
    let storedPort: number | undefined = 65123; // 前回の希望ポート
    dbMock.getSetting.mockImplementation((key: string) =>
      key === "beacon_ark_mcp_port" ? storedPort : undefined
    );
    dbMock.setSetting.mockImplementation((key: string, val: unknown) => {
      if (key === "beacon_ark_mcp_port") storedPort = val as number;
    });
    // 旧ポートが競合 → ark は別ポート (ephemeral) で起動
    arkStartMock.mockResolvedValue({
      url: "http://127.0.0.1:7000/mcp",
      token: "t",
    });
    cliMock.running = true; // 前プロセスの常駐セッションが生存
    const before = cliMock.killCount;
    await beaconManager.sendMessage("x");
    // 旧ポートを指す mcp-config のままでは ark ツールが全滅するため貼り直す
    expect(cliMock.killCount).toBe(before + 1);
  });

  it("sendTurn が throw したら user プロンプトを取り消し done を emit して reject する", async () => {
    cliMock.sendTurnImpl = async () => {
      throw new Error("tmux load-buffer に失敗しました");
    };
    const ev = collect();
    await expect(beaconManager.sendMessage("送信失敗する")).rejects.toThrow(
      /load-buffer/
    );
    // claude は受け取っていないので user プロンプトを DB から取り消す
    const userMsg = dbMock.addBeaconMessage.mock.calls
      .map(c => c[0] as ChatMessage)
      .find(m => m.role === "user");
    expect(dbMock.deleteBeaconMessage).toHaveBeenCalledWith(userMsg?.id);
    // loading 解除のため done は emit する
    expect(ev.stream.some(s => s.done)).toBe(true);
    // 表示済み user プロンプト除去のため履歴を再同期する
    expect(ev.history.length).toBeGreaterThan(0);
  });

  it("close 中の in-flight turn でも external message は assistant 後に確定する (順序保護)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => {
      release = r;
    });
    cliMock.sendTurnImpl = async (_msg, handlers) => {
      await gate;
      handlers.onText("assistant応答");
      return { text: "assistant応答", completed: true };
    };
    const p = beaconManager.sendMessage("q");
    await waitFor(() => cliMock.sendTurnCalls.length === 1);

    // turn 進行中に /usage 等の external message が届く → defer される
    beaconManager.postExternalMessage("usage summary");
    // 非 reset close (turn は裏で継続)。ここで flush してはいけない
    beaconManager.closeSession();
    const beforeRelease = dbMock.addBeaconMessage.mock.calls.map(
      c => (c[0] as ChatMessage).content
    );
    expect(beforeRelease).not.toContain("usage summary");

    release();
    await p;

    // turn 完了後に assistant → external の順で確定する
    const order = dbMock.addBeaconMessage.mock.calls.map(
      c => (c[0] as ChatMessage).content
    );
    const ai = order.indexOf("assistant応答");
    const ei = order.indexOf("usage summary");
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(ei).toBeGreaterThan(ai);
  });

  it("session reset 後にキューされた turn は sendTurn せず破棄される", async () => {
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>(r => {
      releaseA = r;
    });
    cliMock.sendTurnImpl = async (message, handlers) => {
      if (message === "A") {
        await aGate;
        return { text: "A応答", completed: true };
      }
      handlers.onText(message);
      return { text: message, completed: true };
    };

    const pA = beaconManager.sendMessage("A");
    await waitFor(() => cliMock.sendTurnCalls.length === 1);
    // B を投入 (turnLock 待ち)。この時点では this.session は A と同一
    const pB = beaconManager.sendMessage("B");
    await new Promise(r => setTimeout(r, 10));
    // stop-and-reset: 会話世代が上がる。A 完了後に (enqueue 後 reset された) B は破棄される
    beaconManager.closeSession({ resetConversation: true });
    releaseA();
    await Promise.all([pA, pB]);

    // B は sendTurn に到達しない
    expect(cliMock.sendTurnCalls.map(c => c.message)).toEqual(["A"]);
  });

  it("起動準備 (start) の最中に reset されたら sendTurn しない", async () => {
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>(r => {
      releaseStart = r;
    });
    cliMock.startImpl = async () => {
      await startGate;
      cliMock.running = true;
    };

    const p = beaconManager.sendMessage("X");
    await waitFor(() => cliMock.startConfigs.length === 1);
    // start 待ちの間に stop-and-reset (会話世代を上げる) → 起動完了後に破棄される
    beaconManager.closeSession({ resetConversation: true });
    releaseStart();
    await p;

    expect(cliMock.sendTurnCalls.length).toBe(0);
  });

  it("plain close (非reset) では待機中の turn を破棄せず裏で送信する", async () => {
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>(r => {
      releaseStart = r;
    });
    cliMock.startImpl = async () => {
      await startGate;
      cliMock.running = true;
    };

    const p = beaconManager.sendMessage("background");
    await waitFor(() => cliMock.startConfigs.length === 1);
    // plain close (パネルを閉じただけ) → turn は破棄されず裏で完走する
    beaconManager.closeSession();
    releaseStart();
    await p;

    // 起動後に send されている (= プロンプトを失わない)
    expect(cliMock.sendTurnCalls.map(c => c.message)).toContain("background");
  });
});
