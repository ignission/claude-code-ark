/**
 * SessionOrchestrator のプロファイル切替まわりのテスト
 *
 * - CLAUDE_CONFIG_DIR の env 注入条件
 * - 既存セッション再利用時の staleProfile 判定
 * - restartSession の kill→再作成
 *
 * 外部依存（TmuxManager / TtydManager / SessionDatabase）はモック化する。
 * vi.mock のhoist仕様に依存するため、import文より前にmock宣言を行う。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TmuxManager / TtydManager / SessionDatabase のシングルトンをモック化。
// SessionOrchestrator は constructor で `tmuxManager.getAllSessions()` を呼ぶため、
// 必ず import 前にスタブを用意する。
vi.mock("./tmux-manager.js", async () => {
  const { EventEmitter } = await import("node:events");
  // EventEmitter継承のスタブ（on/emit が必要）
  class TmuxManagerStub extends EventEmitter {
    getAllSessions = vi.fn(() => []);
    getSession = vi.fn();
    getSessionByWorktree = vi.fn();
    createSession = vi.fn();
    killSession = vi.fn();
    sendKeys = vi.fn();
    sendSpecialKey = vi.fn();
    capturePane = vi.fn();
    setClaudeMcpConfigPath = vi.fn();
    setClaudeAppendSystemPrompt = vi.fn();
    // restoreExistingSessions → detectEnvProfile が参照する (env 無し = null 相当)
    getEnv = vi.fn(() => undefined);
    getPaneEnv = vi.fn(() => undefined);
  }
  const tmuxManager = new TmuxManagerStub();
  // 複数の SessionOrchestrator インスタンス（各testで生成）が listener を追加するため
  // 上限警告を抑制する
  tmuxManager.setMaxListeners(0);
  return { tmuxManager };
});

vi.mock("./ttyd-manager.js", async () => {
  const { EventEmitter } = await import("node:events");
  class TtydManagerStub extends EventEmitter {
    startInstance = vi.fn(async (sessionId: string) => ({
      sessionId,
      port: 7681,
      tmuxSessionName: "ark-stub",
      basePath: `/ttyd/${sessionId}`,
    }));
    stopInstance = vi.fn();
    getInstance = vi.fn();
    cleanup = vi.fn();
  }
  const ttydManager = new TtydManagerStub();
  ttydManager.setMaxListeners(0);
  return { ttydManager };
});

vi.mock("./database.js", () => {
  const db = {
    getRepoProfileLink: vi.fn(),
    getWorktreeProfileLink: vi.fn(),
    getProfile: vi.fn(),
    getSessionByWorktreePath: vi.fn(),
    upsertSession: vi.fn(),
    replaceSession: vi.fn(),
    updateSessionRepoPath: vi.fn(),
    updateSessionStatus: vi.fn(),
    deleteSession: vi.fn(),
  };
  return { db };
});

// child_process は deriveRepoPath() の execFileSync 用にモック。
// テスト中は repoPath を resolveProfileForRepo に直接渡せるよう
// worktreePath==="/path/to/work" → repoPath==="/repo" を返す。
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "/repo/.git\n"),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIAGRAM_DIR } from "@ark/shared";
import type { BoardMcpServer } from "./board-mcp-server.js";
// BoardSessionRegistry は単純な token→worktreePath の in-memory map なので
// モック化せず実体を使い、register/resolve/unregister の実挙動を検証する。
import { BoardSessionRegistry } from "./board-mcp-server.js";
import { db } from "./database.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import { tmuxManager } from "./tmux-manager.js";
import { ttydManager } from "./ttyd-manager.js";

const mockedDb = vi.mocked(db);
const mockedTmux = vi.mocked(tmuxManager);
const mockedTtyd = vi.mocked(ttydManager);

/**
 * テスト用のtmuxセッション雛形
 */
function makeTmuxSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sess-id-1",
    tmuxSessionName: "ark-sess1",
    worktreePath: "/path/to/work",
    createdAt: new Date(),
    lastActivity: new Date(),
    status: "running" as const,
    ...overrides,
  };
}

describe("SessionOrchestrator - プロファイル切替", () => {
  let orchestrator: SessionOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();

    // tmux: 既存セッションなし、createSessionは新規セッションを返す
    mockedTmux.getAllSessions.mockReturnValue([]);
    mockedTmux.getSessionByWorktree.mockReturnValue(undefined);
    mockedTmux.getSession.mockReturnValue(undefined);
    mockedTmux.createSession.mockResolvedValue(makeTmuxSession());

    // ttyd: 起動成功、未起動状態を返す
    mockedTtyd.getInstance.mockReturnValue(undefined);
    mockedTtyd.startInstance.mockResolvedValue({
      sessionId: "sess-id-1",
      port: 7681,
      tmuxSessionName: "ark-sess1",
      basePath: "/ttyd/sess-id-1",
    } as never);

    // db: link / profile / sessionは未設定
    mockedDb.getRepoProfileLink.mockReturnValue(null);
    mockedDb.getWorktreeProfileLink.mockReturnValue(null);
    mockedDb.getProfile.mockReturnValue(null);
    mockedDb.getSessionByWorktreePath.mockReturnValue(null);

    orchestrator = new SessionOrchestrator();
  });

  // ============================================================
  // startSession - 新規作成パス
  // ============================================================

  describe("startSession (新規作成)", () => {
    it("紐付けなし: env無しで createSession が呼ばれる", async () => {
      mockedDb.getRepoProfileLink.mockReturnValue(null);

      const managed = await orchestrator.startSession(
        "wt-1",
        "/path/to/work",
        "/repo"
      );

      expect(mockedTmux.createSession).toHaveBeenCalledTimes(1);
      const callArgs = mockedTmux.createSession.mock.calls[0];
      expect(callArgs[0]).toBe("/path/to/work");
      expect(callArgs[1]).toBeUndefined();
      expect(managed.profileId).toBeNull();
    });

    it("紐付けあり: env 注入される (configDir 存在チェックは行わない)", async () => {
      mockedDb.getRepoProfileLink.mockReturnValue({
        repoPath: "/repo",
        profileId: "prof-1",
        updatedAt: 0,
      });
      mockedDb.getProfile.mockReturnValue({
        id: "prof-1",
        name: "work",
        configDir: "/home/user/.claude-work",
        createdAt: 0,
        updatedAt: 0,
      });

      const managed = await orchestrator.startSession(
        "wt-1",
        "/path/to/work",
        "/repo"
      );

      const callArgs = mockedTmux.createSession.mock.calls[0];
      expect(callArgs[0]).toBe("/path/to/work");
      expect(callArgs[1]).toEqual({
        env: { CLAUDE_CONFIG_DIR: "/home/user/.claude-work" },
      });
      expect(managed.profileId).toBe("prof-1");
    });

    it("紐付けあるがプロファイルが削除済 (取得null): env 無し", async () => {
      mockedDb.getRepoProfileLink.mockReturnValue({
        repoPath: "/repo",
        profileId: "prof-deleted",
        updatedAt: 0,
      });
      mockedDb.getProfile.mockReturnValue(null);

      const managed = await orchestrator.startSession(
        "wt-1",
        "/path/to/work",
        "/repo"
      );

      const callArgs = mockedTmux.createSession.mock.calls[0];
      expect(callArgs[1]).toBeUndefined();
      expect(managed.profileId).toBeNull();
    });
  });

  // ============================================================
  // startSession - 既存セッション再利用パス (staleProfile)
  // ============================================================

  describe("startSession (既存セッション再利用)", () => {
    it("既存セッションのprofileIdが現在の紐付けと異なる: staleProfile=true", async () => {
      // まず prof-1 で新規作成
      mockedDb.getRepoProfileLink.mockReturnValue({
        repoPath: "/repo",
        profileId: "prof-1",
        updatedAt: 0,
      });
      mockedDb.getProfile.mockReturnValue({
        id: "prof-1",
        name: "work",
        configDir: "/home/user/.claude-work",
        createdAt: 0,
        updatedAt: 0,
      });
      await orchestrator.startSession("wt-1", "/path/to/work", "/repo");

      // 紐付けを別プロファイルに変更
      mockedDb.getRepoProfileLink.mockReturnValue({
        repoPath: "/repo",
        profileId: "prof-2",
        updatedAt: 0,
      });
      mockedDb.getProfile.mockReturnValue({
        id: "prof-2",
        name: "personal",
        configDir: "/home/user/.claude-personal",
        createdAt: 0,
        updatedAt: 0,
      });

      // 既存セッションが返されるよう設定
      const existing = makeTmuxSession();
      mockedTmux.getSessionByWorktree.mockReturnValue(existing);

      const managed = await orchestrator.startSession(
        "wt-1",
        "/path/to/work",
        "/repo"
      );

      expect(managed.staleProfile).toBe(true);
      expect(managed.profileId).toBe("prof-1");
    });

    it("既存セッションのprofileIdが現在の紐付けと一致: staleProfile=false", async () => {
      // prof-1 で新規作成
      mockedDb.getRepoProfileLink.mockReturnValue({
        repoPath: "/repo",
        profileId: "prof-1",
        updatedAt: 0,
      });
      mockedDb.getProfile.mockReturnValue({
        id: "prof-1",
        name: "work",
        configDir: "/home/user/.claude-work",
        createdAt: 0,
        updatedAt: 0,
      });
      await orchestrator.startSession("wt-1", "/path/to/work", "/repo");

      // 紐付け不変、既存セッション再利用
      const existing = makeTmuxSession();
      mockedTmux.getSessionByWorktree.mockReturnValue(existing);

      const managed = await orchestrator.startSession(
        "wt-1",
        "/path/to/work",
        "/repo"
      );

      expect(managed.staleProfile).toBe(false);
      expect(managed.profileId).toBe("prof-1");
    });

    it("両方未紐付け（current=null, desired=null）: staleProfile=false", async () => {
      // 新規作成: 紐付けなし
      mockedDb.getRepoProfileLink.mockReturnValue(null);
      await orchestrator.startSession("wt-1", "/path/to/work", "/repo");

      // 既存セッション再利用、紐付けは依然としてなし
      const existing = makeTmuxSession();
      mockedTmux.getSessionByWorktree.mockReturnValue(existing);

      const managed = await orchestrator.startSession(
        "wt-1",
        "/path/to/work",
        "/repo"
      );

      expect(managed.staleProfile).toBe(false);
      expect(managed.profileId).toBeNull();
    });

    it("既存セッションは未紐付け (~/.claude) で起動、後からプロファイルを紐付け: staleProfile=true", async () => {
      // 1. 紐付けなしで新規作成 (profileId=null)
      mockedDb.getRepoProfileLink.mockReturnValue(null);
      await orchestrator.startSession("wt-1", "/path/to/work", "/repo");

      // 2. 後からリポジトリにプロファイルを紐付け
      mockedDb.getRepoProfileLink.mockReturnValue({
        repoPath: "/repo",
        profileId: "prof-new",
        updatedAt: 0,
      });
      mockedDb.getProfile.mockReturnValue({
        id: "prof-new",
        name: "new",
        configDir: "/home/user/.claude-new",
        createdAt: 0,
        updatedAt: 0,
      });

      // 既存セッション再利用 → null から prof-new への変化を stale として検出
      const existing = makeTmuxSession();
      mockedTmux.getSessionByWorktree.mockReturnValue(existing);

      const managed = await orchestrator.startSession(
        "wt-1",
        "/path/to/work",
        "/repo"
      );

      expect(managed.staleProfile).toBe(true);
      expect(managed.profileId).toBeNull();
    });

    it("同じprofileIdでもconfigDirが変わると staleProfile=true", async () => {
      // 1. prof-1 (configDir=A) で新規作成
      mockedDb.getRepoProfileLink.mockReturnValue({
        repoPath: "/repo",
        profileId: "prof-1",
        updatedAt: 0,
      });
      mockedDb.getProfile.mockReturnValue({
        id: "prof-1",
        name: "work",
        configDir: "/home/user/.claude-A",
        createdAt: 0,
        updatedAt: 0,
      });
      await orchestrator.startSession("wt-1", "/path/to/work", "/repo");

      // 2. プロファイルのconfigDirを編集 (idは同じ、configDirが変わる)
      mockedDb.getProfile.mockReturnValue({
        id: "prof-1",
        name: "work",
        configDir: "/home/user/.claude-B",
        createdAt: 0,
        updatedAt: 1,
      });

      // 既存セッション再利用: 起動時のスナップショットは A、現在は B → stale
      const existing = makeTmuxSession();
      mockedTmux.getSessionByWorktree.mockReturnValue(existing);

      const managed = await orchestrator.startSession(
        "wt-1",
        "/path/to/work",
        "/repo"
      );

      expect(managed.staleProfile).toBe(true);
      expect(managed.profileId).toBe("prof-1");
    });
  });

  // ============================================================
  // restartSession
  // ============================================================

  describe("restartSession", () => {
    it("既存セッションをkillし、新しい env で再起動する", async () => {
      // 1) prof-1 で起動（古いセッション）
      mockedDb.getRepoProfileLink.mockReturnValue({
        repoPath: "/repo",
        profileId: "prof-1",
        updatedAt: 0,
      });
      mockedDb.getProfile.mockImplementation((id: string) => {
        if (id === "prof-1") {
          return {
            id: "prof-1",
            name: "work",
            configDir: "/home/user/.claude-work",
            createdAt: 0,
            updatedAt: 0,
          };
        }
        if (id === "prof-2") {
          return {
            id: "prof-2",
            name: "personal",
            configDir: "/home/user/.claude-personal",
            createdAt: 0,
            updatedAt: 0,
          };
        }
        return null;
      });

      const initial = await orchestrator.startSession(
        "wt-1",
        "/path/to/work",
        "/repo"
      );
      expect(initial.profileId).toBe("prof-1");

      // 紐付けを prof-2 に切替
      mockedDb.getRepoProfileLink.mockReturnValue({
        repoPath: "/repo",
        profileId: "prof-2",
        updatedAt: 0,
      });

      // restartSession 用に getSession が古いセッションを返す
      const oldSession = makeTmuxSession({ id: "sess-id-1" });
      mockedTmux.getSession.mockReturnValue(oldSession);
      mockedDb.getSessionByWorktreePath.mockReturnValue({
        id: "sess-id-1",
        worktreeId: "wt-1",
        worktreePath: "/path/to/work",
        repoPath: "/repo",
        status: "active",
        createdAt: "2026-04-25T00:00:00Z",
        updatedAt: "2026-04-25T00:00:00Z",
      } as never);

      // 再作成では新しいIDのtmuxセッションが返る
      mockedTmux.createSession.mockResolvedValue(
        makeTmuxSession({
          id: "sess-id-2",
          tmuxSessionName: "ark-sess2",
        })
      );
      // 再作成後は既存セッションなし扱い
      mockedTmux.getSessionByWorktree.mockReturnValue(undefined);

      // ttyd start も新しいIDで応答
      mockedTtyd.startInstance.mockResolvedValue({
        sessionId: "sess-id-2",
        port: 7682,
        tmuxSessionName: "ark-sess2",
        basePath: "/ttyd/sess-id-2",
      } as never);

      const restarted = await orchestrator.restartSession("sess-id-1");

      // 古いセッションのteardown
      expect(mockedTtyd.stopInstance).toHaveBeenCalledWith("sess-id-1");
      expect(mockedTmux.killSession).toHaveBeenCalledWith("sess-id-1");

      // 新しいセッションが prof-2 の env で起動された
      const lastCreateCall =
        mockedTmux.createSession.mock.calls[
          mockedTmux.createSession.mock.calls.length - 1
        ];
      expect(lastCreateCall[1]).toEqual({
        env: { CLAUDE_CONFIG_DIR: "/home/user/.claude-personal" },
      });

      expect(restarted.id).toBe("sess-id-2");
      expect(restarted.profileId).toBe("prof-2");
    });

    it("セッションが見つからない場合は throw", async () => {
      mockedTmux.getSession.mockReturnValue(undefined);
      await expect(
        orchestrator.restartSession("does-not-exist")
      ).rejects.toThrow(/Session not found/);
    });

    it("created → restarted → stopped の順で emit する (受信側の選択追従がイベント順序に依存するため)", async () => {
      const oldSession = makeTmuxSession({ id: "sess-id-1" });
      mockedTmux.getSession.mockReturnValue(oldSession);
      mockedDb.getSessionByWorktreePath.mockReturnValue({
        id: "sess-id-1",
        worktreeId: "wt-1",
        worktreePath: "/path/to/work",
        repoPath: "/repo",
        status: "active",
        createdAt: "2026-04-25T00:00:00Z",
        updatedAt: "2026-04-25T00:00:00Z",
      } as never);
      mockedTmux.createSession.mockResolvedValue(
        makeTmuxSession({ id: "sess-id-2", tmuxSessionName: "ark-sess2" })
      );
      mockedTmux.getSessionByWorktree.mockReturnValue(undefined);
      mockedTtyd.startInstance.mockResolvedValue({
        sessionId: "sess-id-2",
        port: 7682,
        tmuxSessionName: "ark-sess2",
        basePath: "/ttyd/sess-id-2",
      } as never);

      const order: string[] = [];
      orchestrator.on("session:created", () => order.push("created"));
      orchestrator.on("session:restarted", () => order.push("restarted"));
      orchestrator.on("session:stopped", () => order.push("stopped"));
      let restartedPayload: unknown;
      orchestrator.on("session:restarted", payload => {
        restartedPayload = payload;
      });

      await orchestrator.restartSession("sess-id-1");

      // stopped を先に流すと、受信側で「選択中セッション消失」フォールバックが
      // session:restarted より先に走り、選択追従 (prev === oldSessionId) が
      // 失敗するため、この順序を仕様として固定する
      expect(order).toEqual(["created", "restarted", "stopped"]);
      expect(restartedPayload).toMatchObject({
        oldSessionId: "sess-id-1",
        session: { id: "sess-id-2" },
      });
    });

    it("同一セッションの並行再起動は直列化され、同じ新セッションを返す", async () => {
      const oldSession = makeTmuxSession({ id: "sess-id-1" });
      mockedTmux.getSession.mockReturnValue(oldSession);
      mockedDb.getSessionByWorktreePath.mockReturnValue({
        id: "sess-id-1",
        worktreeId: "wt-1",
        worktreePath: "/path/to/work",
        repoPath: "/repo",
        status: "active",
        createdAt: "2026-04-25T00:00:00Z",
        updatedAt: "2026-04-25T00:00:00Z",
      } as never);
      // 並行実行が直列化されない場合は2つの新セッションが作られてしまう
      mockedTmux.createSession
        .mockResolvedValueOnce(
          makeTmuxSession({ id: "sess-id-2", tmuxSessionName: "ark-sess2" })
        )
        .mockResolvedValueOnce(
          makeTmuxSession({ id: "sess-id-3", tmuxSessionName: "ark-sess3" })
        );
      mockedTmux.getSessionByWorktree.mockReturnValue(undefined);
      mockedTtyd.startInstance
        .mockResolvedValueOnce({
          sessionId: "sess-id-2",
          port: 7682,
          tmuxSessionName: "ark-sess2",
          basePath: "/ttyd/sess-id-2",
        } as never)
        .mockResolvedValueOnce({
          sessionId: "sess-id-3",
          port: 7683,
          tmuxSessionName: "ark-sess3",
          basePath: "/ttyd/sess-id-3",
        } as never);

      const [r1, r2] = await Promise.all([
        orchestrator.restartSession("sess-id-1"),
        orchestrator.restartSession("sess-id-1"),
      ]);

      // 2つ目の呼び出しは進行中の再起動に相乗りし、新セッションは1つだけ
      expect(mockedTmux.createSession).toHaveBeenCalledTimes(1);
      expect(r1.id).toBe("sess-id-2");
      expect(r2.id).toBe("sess-id-2");
    });
  });
});

/**
 * board_write MCP (Task 4) の per-session token/mcp-config 注入まわりのテスト。
 *
 * BoardSessionRegistry は token→worktreePath の単純な in-memory map なので、
 * モック化せず実体を使って register/resolve/unregister の実挙動を検証する。
 * per-session mcp-config ファイルは実際に OS tmpdir 配下へ書き込まれるため、
 * 各テストで生成したファイルは afterEach で確実に削除する。
 */
describe("SessionOrchestrator - board MCP 注入 (Task 4)", () => {
  let orchestrator: SessionOrchestrator;
  const fakeBoardMcp = { getPort: () => 39123 } as unknown as BoardMcpServer;
  let writtenConfigPaths: string[] = [];
  /** テスト内で実際に作った worktree ディレクトリ (afterEach で削除する) */
  let createdWorktrees: string[] = [];

  /** 直近の setClaudeMcpConfigPath 呼び出しに渡された path (null なら例外) */
  function lastMcpConfigPath(): string {
    const calls = mockedTmux.setClaudeMcpConfigPath.mock.calls;
    const path = calls[calls.length - 1]?.[0];
    if (!path) throw new Error("setClaudeMcpConfigPath(path) が呼ばれていない");
    writtenConfigPaths.push(path);
    return path;
  }

  /** cfgPath の中身から ark-board の bearer token を取り出す */
  function readToken(cfgPath: string): string {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const auth = parsed.mcpServers["ark-board"].headers.Authorization as string;
    return auth.replace("Bearer ", "");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    writtenConfigPaths = [];
    createdWorktrees = [];

    mockedTmux.getAllSessions.mockReturnValue([]);
    mockedTmux.getSessionByWorktree.mockReturnValue(undefined);
    mockedTmux.getSession.mockReturnValue(undefined);
    mockedTmux.createSession.mockResolvedValue(makeTmuxSession());

    mockedTtyd.getInstance.mockReturnValue(undefined);
    mockedTtyd.startInstance.mockResolvedValue({
      sessionId: "sess-id-1",
      port: 7681,
      tmuxSessionName: "ark-sess1",
      basePath: "/ttyd/sess-id-1",
    } as never);

    mockedDb.getRepoProfileLink.mockReturnValue(null);
    mockedDb.getWorktreeProfileLink.mockReturnValue(null);
    mockedDb.getProfile.mockReturnValue(null);
    mockedDb.getSessionByWorktreePath.mockReturnValue(null);

    orchestrator = new SessionOrchestrator();
  });

  afterEach(() => {
    for (const p of writtenConfigPaths) {
      try {
        fs.unlinkSync(p);
      } catch {
        // 既にテスト内で削除済み等は無視 (ベストエフォート)
      }
    }
    writtenConfigPaths = [];
    for (const dir of createdWorktrees) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    createdWorktrees = [];
  });

  it("setBoardMcp 未呼び出しなら MCP config と append system prompt が null になる", async () => {
    await orchestrator.startSession("wt-1", "/path/to/work", "/repo");

    expect(mockedTmux.setClaudeMcpConfigPath).toHaveBeenCalledWith(null);
    expect(mockedTmux.setClaudeMcpConfigPath).toHaveBeenCalledTimes(1);
    expect(mockedTmux.setClaudeAppendSystemPrompt).toHaveBeenCalledWith(null);
    expect(mockedTmux.setClaudeAppendSystemPrompt).toHaveBeenCalledTimes(1);
  });

  it("setBoardMcp 後の新規セッションで per-session token を生成し、mcp-config を書いて registry に登録する", async () => {
    const registry = new BoardSessionRegistry();
    orchestrator.setBoardMcp(fakeBoardMcp, registry);

    await orchestrator.startSession("wt-1", "/path/to/work", "/repo");

    const cfgPath = lastMcpConfigPath();
    expect(cfgPath).toContain("ark-board-mcp");
    expect(cfgPath.endsWith(".json")).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const server = parsed.mcpServers["ark-board"];
    expect(server.type).toBe("http");
    expect(server.url).toBe("http://127.0.0.1:39123/mcp");

    const token = readToken(cfgPath);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    // registry に (token → worktreePath) が実際に登録されている
    expect(registry.resolve(token)).toBe("/path/to/work");

    // token 秘匿: cfgPath (--mcp-config で ps aux 露出する) に token 文字列を
    // 含めない。token は内容の headers.Authorization のみに置く。
    expect(cfgPath).not.toContain(token);
    // ファイル名 (basename) も token と無関係なランダム id であること
    const basename = cfgPath.split("/").pop() ?? "";
    expect(basename).toMatch(/^[0-9a-f]{32}\.json$/);

    // 格納 dir が存在し 0700 (他ユーザーから列挙不可) で作られている
    const dir = cfgPath.slice(0, cfgPath.lastIndexOf("/"));
    expect(fs.existsSync(dir)).toBe(true);
    const dirMode = fs.statSync(dir).mode & 0o777;
    expect(dirMode).toBe(0o700);

    // bearer token を含むため 0600 で書かれている
    const mode = fs.statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("新規セッションの prompt はボード上の図・文書とコメントの往復手順を案内する", async () => {
    const registry = new BoardSessionRegistry();
    orchestrator.setBoardMcp(fakeBoardMcp, registry);

    await orchestrator.startSession("wt-1", "/path/to/work", "/repo");

    const prompt =
      mockedTmux.setClaudeAppendSystemPrompt.mock.calls.at(-1)?.[0];
    expect(prompt).not.toContain("\n");
    expect(prompt).toContain(DIAGRAM_DIR);
    expect(prompt).not.toContain("docs/diagrams");
    expect(prompt).toContain("書き込む直前");
    expect(prompt).toContain("存在しない場合");
    expect(prompt).toContain("board_open");
    expect(prompt).toContain("board_comments");
    expect(prompt).toContain("board_authoring_guide");
    expect(prompt).not.toContain("diagram-authoring skill");
    expect(prompt).toContain('model の type を "doc"');
    expect(prompt).toContain("本文をテキスト選択してコメントを付けられる");
    expect(prompt).toContain(
      "引用された箇所を直してから board_open で開き直す"
    );
  });

  it("既存セッション再利用パスでは token を発行しない (setClaudeMcpConfigPath も呼ばれない)", async () => {
    const registry = new BoardSessionRegistry();
    orchestrator.setBoardMcp(fakeBoardMcp, registry);

    const existing = makeTmuxSession();
    mockedTmux.getSessionByWorktree.mockReturnValue(existing);

    await orchestrator.startSession("wt-1", "/path/to/work", "/repo");

    expect(mockedTmux.setClaudeMcpConfigPath).not.toHaveBeenCalled();
    expect(mockedTmux.createSession).not.toHaveBeenCalled();
  });

  it("stopSession で token を unregister し、per-session mcp-config ファイルを削除する", async () => {
    const registry = new BoardSessionRegistry();
    orchestrator.setBoardMcp(fakeBoardMcp, registry);

    const managed = await orchestrator.startSession(
      "wt-1",
      "/path/to/work",
      "/repo"
    );
    const cfgPath = lastMcpConfigPath();
    const token = readToken(cfgPath);
    expect(registry.resolve(token)).toBe("/path/to/work");

    // stopSession は tmuxManager.getSession() から worktreePath を得る
    mockedTmux.getSession.mockReturnValue(makeTmuxSession());

    orchestrator.stopSession(managed.id);

    expect(registry.resolve(token)).toBeNull();
    expect(fs.existsSync(cfgPath)).toBe(false);
  });

  it("getAllSessions の孤児クリーンアップ (worktree 削除済み) でも token を unregister し mcp-config を削除する", async () => {
    const registry = new BoardSessionRegistry();
    orchestrator.setBoardMcp(fakeBoardMcp, registry);

    await orchestrator.startSession("wt-1", "/path/to/work", "/repo");
    const cfgPath = lastMcpConfigPath();
    const token = readToken(cfgPath);
    expect(registry.resolve(token)).toBe("/path/to/work");

    // worktree 削除済みの状態。"/path/to/work" は実在しないパスなので
    // getAllSessions() の fs.existsSync 判定が false となり孤児として掃除される。
    // 掃除後は tmux 側からも消えるため 2 回目以降は空配列を返す。
    mockedTmux.getAllSessions
      .mockReturnValueOnce([makeTmuxSession()] as never)
      .mockReturnValue([]);

    orchestrator.getAllSessions();

    // 削除済み worktree を指す token が registry に残ると、その token での
    // board_write が「board scene の保存先 worktree が見つかりません」で
    // 失敗し続ける (realpathSync が ENOENT を投げ検証が null になるため)。
    expect(registry.resolve(token)).toBeNull();
    expect(fs.existsSync(cfgPath)).toBe(false);
  });

  it("setBoardMcp 時に、復元済みセッションの board token を cfg ファイルから registry へ復帰させる", async () => {
    // 稼働中の claude は起動時に渡された古い token を保持し続けるため、
    // サーバー再起動後もその token が解決できないと board_write が 401 で
    // 全滅する (セッションを作り直すまで復旧しない)。
    // worktree は実在させる (存在しないと復元時に孤児として掃除されてしまう)。
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ark-restore-wt-"));
    createdWorktrees.push(worktree);

    const registry1 = new BoardSessionRegistry();
    orchestrator.setBoardMcp(fakeBoardMcp, registry1);
    mockedTmux.createSession.mockResolvedValue(
      makeTmuxSession({ worktreePath: worktree })
    );
    await orchestrator.startSession("wt-1", worktree, "/repo");
    const cfgPath = lastMcpConfigPath();
    const token = readToken(cfgPath);
    expect(registry1.resolve(token)).toBe(worktree);

    // --- サーバー再起動相当 ---
    // tmux セッションは生き残り、DB に cfgPath が永続化されている状態
    mockedTmux.getAllSessions.mockReturnValue([
      makeTmuxSession({ worktreePath: worktree }),
    ] as never);
    mockedDb.getSessionByWorktreePath.mockReturnValue({
      id: "sess-id-1",
      worktreeId: "wt-1",
      worktreePath: worktree,
      repoPath: "/repo",
      status: "active",
      boardMcpConfigPath: cfgPath,
      createdAt: "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:00:00Z",
    } as never);

    const restarted = new SessionOrchestrator();
    const registry2 = new BoardSessionRegistry();
    restarted.setBoardMcp(fakeBoardMcp, registry2);

    expect(registry2.resolve(token)).toBe(worktree);
  });

  it("restartSession で新token を登録し、旧token を unregister する", async () => {
    const registry = new BoardSessionRegistry();
    orchestrator.setBoardMcp(fakeBoardMcp, registry);

    await orchestrator.startSession("wt-1", "/path/to/work", "/repo");
    const oldCfgPath = lastMcpConfigPath();
    const oldToken = readToken(oldCfgPath);
    expect(registry.resolve(oldToken)).toBe("/path/to/work");

    // restartSession 用のスタブ設定 (既存の restartSession テストと同じ形)
    const oldSession = makeTmuxSession({ id: "sess-id-1" });
    mockedTmux.getSession.mockReturnValue(oldSession);
    mockedDb.getSessionByWorktreePath.mockReturnValue({
      id: "sess-id-1",
      worktreeId: "wt-1",
      worktreePath: "/path/to/work",
      repoPath: "/repo",
      status: "active",
      createdAt: "2026-04-25T00:00:00Z",
      updatedAt: "2026-04-25T00:00:00Z",
    } as never);
    mockedTmux.createSession.mockResolvedValue(
      makeTmuxSession({ id: "sess-id-2", tmuxSessionName: "ark-sess2" })
    );
    mockedTmux.getSessionByWorktree.mockReturnValue(undefined);
    mockedTtyd.startInstance.mockResolvedValue({
      sessionId: "sess-id-2",
      port: 7682,
      tmuxSessionName: "ark-sess2",
      basePath: "/ttyd/sess-id-2",
    } as never);

    await orchestrator.restartSession("sess-id-1");

    const newCfgPath = lastMcpConfigPath();
    const newToken = readToken(newCfgPath);

    // 旧token は解除され、ファイルも削除されている
    expect(registry.resolve(oldToken)).toBeNull();
    expect(fs.existsSync(oldCfgPath)).toBe(false);
    // 新token は新しい worktreePath (変わらないので同じ値) で登録されている
    expect(registry.resolve(newToken)).toBe("/path/to/work");
  });

  it("tmuxManager.createSession が失敗したら mcp-config ファイルは削除され、tmuxManager の設定も null に戻る", async () => {
    const registry = new BoardSessionRegistry();
    orchestrator.setBoardMcp(fakeBoardMcp, registry);
    mockedTmux.createSession.mockRejectedValueOnce(new Error("boom"));

    await expect(
      orchestrator.startSession("wt-1", "/path/to/work", "/repo")
    ).rejects.toThrow("boom");

    // 1回目 (prepareBoardMcpConfig) で実際に書かれた path、
    // 2回目 (discardBoardMcpConfig の後始末) で null にリセットされる
    const calls = mockedTmux.setClaudeMcpConfigPath.mock.calls;
    expect(calls).toHaveLength(2);
    const cfgPath = calls[0]?.[0];
    if (!cfgPath) throw new Error("cfgPath not set");
    expect(calls[1]?.[0]).toBeNull();

    // 失敗時は registerBoardToken に到達しないため、後始末でファイルが消える
    // (createSession 失敗時点では registry.register も未実行)
    expect(fs.existsSync(cfgPath)).toBe(false);
  });
});
