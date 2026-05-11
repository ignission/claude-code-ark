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

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  });
});
