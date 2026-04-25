/**
 * AccountLoginManager のユニットテスト
 *
 * tmuxManager / ttydLoginManager / CredentialsWatcher / fs.promises / spawnSync を
 * モックして、起動・完了・キャンセル・タイムアウト・ロールバック・stopAll を検証する。
 */

import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// vi.mock のファクトリは hoist されるため、外部参照は vi.hoisted 経由で渡す
const hoisted = vi.hoisted(() => {
  const watcherRef: { current: unknown } = { current: null };
  return { watcherRef };
});

// node:fs (promises) のモック。default + 名前付き両方を返す
vi.mock("node:fs", async () => {
  const mkdir = vi.fn(async () => undefined);
  const stat = vi.fn(async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  const promises = { mkdir, stat };
  return {
    default: { promises },
    promises,
  };
});

// node:child_process の spawnSync をモック
vi.mock("node:child_process", () => {
  return {
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    })),
  };
});

// CredentialsWatcher をモック化（EventEmitter ベースのスタブに置き換え）
vi.mock("./credentials-watcher.js", async () => {
  const { EventEmitter: NodeEventEmitter } = await import("node:events");
  class FakeCredentialsWatcher extends NodeEventEmitter {
    public start = vi.fn();
    public stop = vi.fn();
    constructor(
      public readonly credentialsPath: string,
      public readonly preLoginMtime: number | null
    ) {
      super();
      // 最後に作成されたインスタンスを hoist 経由で外部に晒す
      hoisted.watcherRef.current = this;
    }
  }
  return { CredentialsWatcher: FakeCredentialsWatcher };
});

type FakeWatcher = EventEmitter & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  credentialsPath: string;
  preLoginMtime: number | null;
};

const getLastWatcher = (): FakeWatcher =>
  hoisted.watcherRef.current as FakeWatcher;

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import type { AccountProfile } from "../../shared/types.js";
import {
  AccountLoginManager,
  extractOAuthUrl,
} from "./account-login-manager.js";

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>;
const fsMkdirMock = fsPromises.mkdir as unknown as ReturnType<typeof vi.fn>;
const fsStatMock = fsPromises.stat as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id: "profile-1",
    name: "テスト",
    configDir: "/tmp/account-test/profile-1",
    status: "pending",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

interface TmuxStub {
  createSession: ReturnType<typeof vi.fn>;
}

interface TtydStub {
  startTtyd: ReturnType<typeof vi.fn>;
  stopTtyd: ReturnType<typeof vi.fn>;
}

function makeTmuxStub(): TmuxStub {
  return {
    createSession: vi.fn(async (worktreePath: string) => ({
      id: "abc12345",
      tmuxSessionName: "arklogin-abc12345",
      worktreePath,
      createdAt: new Date(),
      lastActivity: new Date(),
      status: "running" as const,
    })),
  };
}

function makeTtydStub(): TtydStub {
  return {
    startTtyd: vi.fn(async (_sessionName: string, profileId: string) => ({
      sessionName: _sessionName,
      profileId,
      port: 7800,
      url: `/ttyd-login/${profileId}/`,
    })),
    stopTtyd: vi.fn(async () => undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AccountLoginManager", () => {
  beforeEach(() => {
    fsMkdirMock.mockReset();
    fsMkdirMock.mockResolvedValue(undefined);
    fsStatMock.mockReset();
    fsStatMock.mockImplementation(async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startLogin: configDir を recursive で mkdir する", async () => {
    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();
    const mgr = new AccountLoginManager(tmux as never, ttyd as never);
    const profile = makeProfile();

    await mgr.startLogin(profile);

    expect(fsMkdirMock).toHaveBeenCalledWith(profile.configDir, {
      recursive: true,
    });
  });

  it("startLogin: tmuxManager.createSession を正しいオプションで呼ぶ", async () => {
    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();
    const mgr = new AccountLoginManager(tmux as never, ttyd as never);
    const profile = makeProfile();

    await mgr.startLogin(profile);

    expect(tmux.createSession).toHaveBeenCalledTimes(1);
    expect(tmux.createSession).toHaveBeenCalledWith(profile.configDir, {
      namePrefix: "arklogin-",
      autoDiscover: false,
      env: { CLAUDE_CONFIG_DIR: profile.configDir },
      commandLine: "claude /login",
    });
  });

  it("startLogin: ttydLoginManager.startTtyd を呼び ttydUrl を返す", async () => {
    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();
    const mgr = new AccountLoginManager(tmux as never, ttyd as never);
    const profile = makeProfile();

    const result = await mgr.startLogin(profile);

    expect(ttyd.startTtyd).toHaveBeenCalledWith(
      "arklogin-abc12345",
      profile.id
    );
    expect(result).toEqual({ ttydUrl: `/ttyd-login/${profile.id}/` });
  });

  it("startLogin: CredentialsWatcher を起動する", async () => {
    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();
    const mgr = new AccountLoginManager(tmux as never, ttyd as never);
    const profile = makeProfile();

    await mgr.startLogin(profile);

    const watcher = getLastWatcher();
    expect(watcher).toBeDefined();
    expect(watcher.credentialsPath).toBe(
      `${profile.configDir}/.credentials.json`
    );
    expect(watcher.preLoginMtime).toBeNull();
    expect(watcher.start).toHaveBeenCalledTimes(1);
  });

  it("startLogin: 同一 profileId で重複起動するとエラー", async () => {
    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();
    const mgr = new AccountLoginManager(tmux as never, ttyd as never);
    const profile = makeProfile();

    await mgr.startLogin(profile);

    await expect(mgr.startLogin(profile)).rejects.toThrow(
      "Login already in progress"
    );
  });

  it('credentialsWatcher の "authenticated" で "completed" emit + cleanup', async () => {
    vi.useFakeTimers();
    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();
    const mgr = new AccountLoginManager(tmux as never, ttyd as never);
    const profile = makeProfile();

    const completedPromise = new Promise<string>(resolve => {
      mgr.on("completed", (id: string) => resolve(id));
    });

    await mgr.startLogin(profile);

    // watcher が認証成功イベントを発火
    const watcher = getLastWatcher();
    watcher.emit("authenticated");

    // grace period (5秒) を進めて completed を発火させる
    await vi.advanceTimersByTimeAsync(6000);

    const completedId = await completedPromise;
    expect(completedId).toBe(profile.id);

    // cleanup 検証
    expect(watcher.stop).toHaveBeenCalled();
    expect(ttyd.stopTtyd).toHaveBeenCalledWith("arklogin-abc12345");
    // tmux kill-session が呼ばれる
    const tmuxKillCalls = spawnSyncMock.mock.calls.filter(
      call =>
        call[0] === "tmux" &&
        Array.isArray(call[1]) &&
        call[1][0] === "kill-session"
    );
    expect(tmuxKillCalls.length).toBeGreaterThanOrEqual(1);
    expect(tmuxKillCalls[0][1]).toEqual([
      "kill-session",
      "-t",
      "arklogin-abc12345",
    ]);

    // active から外れている
    expect(mgr.isActive(profile.id)).toBe(false);
  });

  it('cancelLogin("cancelled") で cleanup + "failed" emit', async () => {
    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();
    const mgr = new AccountLoginManager(tmux as never, ttyd as never);
    const profile = makeProfile();

    const failedPromise = new Promise<{ id: string; reason: string }>(
      resolve => {
        mgr.on("failed", (id: string, reason: string) =>
          resolve({ id, reason })
        );
      }
    );

    await mgr.startLogin(profile);
    const watcher = getLastWatcher();

    await mgr.cancelLogin(profile.id, "cancelled");

    const failed = await failedPromise;
    expect(failed).toEqual({ id: profile.id, reason: "cancelled" });
    expect(watcher.stop).toHaveBeenCalled();
    expect(ttyd.stopTtyd).toHaveBeenCalledWith("arklogin-abc12345");
    expect(mgr.isActive(profile.id)).toBe(false);
  });

  it('10分タイムアウトで "failed" reason="timeout" を emit', async () => {
    vi.useFakeTimers();

    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();
    const mgr = new AccountLoginManager(tmux as never, ttyd as never);
    const profile = makeProfile();

    const failedPromise = new Promise<{ id: string; reason: string }>(
      resolve => {
        mgr.on("failed", (id: string, reason: string) =>
          resolve({ id, reason })
        );
      }
    );

    await mgr.startLogin(profile);

    // 10分 + α 進める
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

    const failed = await failedPromise;
    expect(failed).toEqual({ id: profile.id, reason: "timeout" });
    expect(mgr.isActive(profile.id)).toBe(false);
  });

  it("ロールバック: ttyd 起動失敗時に tmux セッションが kill される", async () => {
    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();
    ttyd.startTtyd.mockRejectedValueOnce(new Error("ttyd boot failed"));

    const mgr = new AccountLoginManager(tmux as never, ttyd as never);
    const profile = makeProfile();

    await expect(mgr.startLogin(profile)).rejects.toThrow("ttyd boot failed");

    // tmux kill-session が呼ばれている
    const tmuxKillCalls = spawnSyncMock.mock.calls.filter(
      call =>
        call[0] === "tmux" &&
        Array.isArray(call[1]) &&
        call[1][0] === "kill-session" &&
        call[1][2] === "arklogin-abc12345"
    );
    expect(tmuxKillCalls.length).toBe(1);

    // active には残っていない
    expect(mgr.isActive(profile.id)).toBe(false);

    // ttyd の stopTtyd は startTtyd 失敗時には呼ばない（まだ起動できていないため）
    expect(ttyd.stopTtyd).not.toHaveBeenCalled();
  });

  it("stopAll: 全アクティブログインをキャンセルする", async () => {
    const tmux = makeTmuxStub();
    const ttyd = makeTtydStub();

    // createSession を呼び出しごとに別の名前にする
    let counter = 0;
    tmux.createSession.mockImplementation(async (worktreePath: string) => {
      counter++;
      return {
        id: `id${counter}`,
        tmuxSessionName: `arklogin-id${counter}`,
        worktreePath,
        createdAt: new Date(),
        lastActivity: new Date(),
        status: "running" as const,
      };
    });

    const mgr = new AccountLoginManager(tmux as never, ttyd as never);

    const profileA = makeProfile({
      id: "profile-A",
      configDir: "/tmp/A",
    });
    const profileB = makeProfile({
      id: "profile-B",
      configDir: "/tmp/B",
    });

    await mgr.startLogin(profileA);
    await mgr.startLogin(profileB);

    expect(mgr.isActive("profile-A")).toBe(true);
    expect(mgr.isActive("profile-B")).toBe(true);

    const failedEvents: { id: string; reason: string }[] = [];
    mgr.on("failed", (id: string, reason: string) => {
      failedEvents.push({ id, reason });
    });

    await mgr.stopAll();

    expect(mgr.isActive("profile-A")).toBe(false);
    expect(mgr.isActive("profile-B")).toBe(false);
    // 両方とも cancelled で通知される
    expect(failedEvents).toHaveLength(2);
    expect(failedEvents.map(e => e.id).sort()).toEqual([
      "profile-A",
      "profile-B",
    ]);
    expect(failedEvents.every(e => e.reason === "cancelled")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractOAuthUrl: tmux capture-pane 出力からの URL 抽出ロジック
// ---------------------------------------------------------------------------
describe("extractOAuthUrl", () => {
  // 実機 (Claude CLI 2.1.120) が出す URL 形式
  const FULL_URL =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=QA6rGXdk1NhadFPlwyN22cM_NP-LBShdurLrPqtLmX8&code_challenge_method=S256&state=Z1AIuRUuYTpPyNPluQ2SvzhSxadFheELe92vLerpYE4";

  it("通常の出力から URL を抽出できる", () => {
    const input = `Open URL:\n\n${FULL_URL}\n\nPaste code:`;
    expect(extractOAuthUrl(input)).toBe(FULL_URL);
  });

  it("ターミナル幅で折り返された URL を結合できる", () => {
    const wrapped = `${FULL_URL.slice(0, 80)}\n${FULL_URL.slice(80, 160)}\n${FULL_URL.slice(160)}\n\nPaste:`;
    expect(extractOAuthUrl(wrapped)).toBe(FULL_URL);
  });

  it("ANSIエスケープ (CSI) を除去して抽出できる", () => {
    const input = `\x1b[34;4m${FULL_URL}\x1b[0m\n\nNext`;
    expect(extractOAuthUrl(input)).toBe(FULL_URL);
  });

  it("redirect_uri を含まない不完全な URL は null", () => {
    expect(
      extractOAuthUrl(
        "https://claude.ai/oauth/authorize?response_type=code&client_id=abc"
      )
    ).toBeNull();
  });

  it("空行で URL が終了する場合、後続テキストを取り込まない", () => {
    const input = `${FULL_URL}\n\nPaste the code:`;
    expect(extractOAuthUrl(input)).toBe(FULL_URL);
  });

  it("URL が出力に含まれない場合は null", () => {
    expect(extractOAuthUrl("ただのターミナル出力\nプロンプト>")).toBeNull();
  });

  it("OSC エスケープシーケンスも除去できる", () => {
    const input = `\x1b]0;title\x07${FULL_URL}\n\nNext`;
    expect(extractOAuthUrl(input)).toBe(FULL_URL);
  });

  it("複数のスペースで区切られた場合、後続文字列を取り込まない", () => {
    const input = `${FULL_URL}    other text on same line`;
    expect(extractOAuthUrl(input)).toBe(FULL_URL);
  });
});
