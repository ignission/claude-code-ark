import type { ManagedSession, Worktree } from "@ark/shared";
import { describe, expect, it, vi } from "vitest";
import {
  describeDelivery,
  type LaunchState,
  looksReadyForPrompt,
  startTask,
  type TaskStartDeps,
  validateTaskInput,
  waitForPromptReady,
} from "./task-start.js";

const WAIT = { timeoutMs: 5_000, intervalMs: 500 };

const state = (over: Partial<LaunchState> = {}): LaunchState => ({
  bridgeStatus: "READY",
  cliState: "idle",
  cliRecordSupported: true,
  ...over,
});

/** readLaunchState が順に返す値を決めた、時計つきの deps */
function fakeDeps(states: Array<LaunchState | null>) {
  let now = 0;
  let i = 0;
  const worktree: Worktree = {
    id: "wt1",
    path: "/r/app-fix",
    branch: "fix",
    commit: "abc",
    isMain: false,
    isBare: false,
  };
  const deps: TaskStartDeps = {
    createWorktree: vi.fn(async () => worktree),
    startSession: vi.fn(
      async () => ({ id: "s1", worktreePath: worktree.path }) as ManagedSession
    ),
    readLaunchState: vi.fn(() => {
      const value = states[Math.min(i, states.length - 1)] ?? null;
      i++;
      return value;
    }),
    sendMessage: vi.fn(),
    recordTodoStarted: vi.fn(),
    sleep: vi.fn(async (ms: number) => {
      now += ms;
    }),
    now: () => now,
  };
  return deps;
}

describe("looksReadyForPrompt", () => {
  it("CLI が idle で、画面が READY か IDLE なら送ってよい", () => {
    expect(looksReadyForPrompt(state())).toBe(true);
    expect(looksReadyForPrompt(state({ bridgeStatus: "IDLE" }))).toBe(true);
  });

  it("CLI の記録が無い (claude がまだ起動していない) なら、画面が READY でも送らない", () => {
    // 起動コマンドを打った直後はシェルのプロンプトだけが画面にあり READY に倒れる
    expect(looksReadyForPrompt(state({ cliState: null }))).toBe(false);
  });

  it("確認の応答待ちや作業中なら送らない", () => {
    expect(looksReadyForPrompt(state({ bridgeStatus: "AWAITING" }))).toBe(
      false
    );
    expect(looksReadyForPrompt(state({ cliState: "busy" }))).toBe(false);
    expect(looksReadyForPrompt(state({ cliState: "waiting" }))).toBe(false);
  });
});

describe("waitForPromptReady", () => {
  it("送ってよい状態を 2 回続けて見たら ready", async () => {
    const deps = fakeDeps([
      state({ cliState: null }),
      state(),
      state({ cliState: null }),
      state(),
      state(),
    ]);
    expect(await waitForPromptReady(deps, "s1", WAIT)).toBe("ready");
    expect(deps.readLaunchState).toHaveBeenCalledTimes(5);
  });

  it("CLI が起動しないままならタイムアウト", async () => {
    const deps = fakeDeps([state({ cliState: null })]);
    expect(await waitForPromptReady(deps, "s1", WAIT)).toBe("timeout");
  });

  it("最後に確認の応答待ちが出ていたら awaiting", async () => {
    const deps = fakeDeps([
      state({ cliState: null }),
      state({ bridgeStatus: "AWAITING", cliState: "waiting" }),
    ]);
    expect(await waitForPromptReady(deps, "s1", WAIT)).toBe("awaiting");
  });

  it("状態ファイルを読めない環境では待たずに unsupported", async () => {
    const deps = fakeDeps([state({ cliRecordSupported: false })]);
    expect(await waitForPromptReady(deps, "s1", WAIT)).toBe("unsupported");
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("一度見えたセッションが消えたら gone", async () => {
    const deps = fakeDeps([state({ cliState: null }), null]);
    expect(await waitForPromptReady(deps, "s1", WAIT)).toBe("gone");
  });
});

describe("validateTaskInput", () => {
  it("空白はハイフンに寄せ、前後の空白を落とす", () => {
    expect(
      validateTaskInput({ name: "  fix log format ", prompt: " 直して \n" })
    ).toEqual({ name: "fix-log-format", prompt: "直して" });
  });

  it("空の名前・プロンプト、ブランチ名に使えない文字は拒否する", () => {
    expect(() => validateTaskInput({ name: "", prompt: "x" })).toThrow(
      "タスク名が空です"
    );
    expect(() => validateTaskInput({ name: "a", prompt: " " })).toThrow(
      "プロンプトが空です"
    );
    expect(() => validateTaskInput({ name: "ログ修正", prompt: "x" })).toThrow(
      "英数字"
    );
    expect(() => validateTaskInput({ name: "-x", prompt: "x" })).toThrow(
      "英数字"
    );
  });
});

describe("startTask", () => {
  it("worktree を作り、親つきで起動し、起動を待ってから prompt を送る", async () => {
    const deps = fakeDeps([state({ cliState: null }), state(), state()]);
    const started = await startTask(
      deps,
      {
        repoPath: "/r/app",
        name: "fix",
        prompt: "直して",
        baseBranch: "main",
        parentWorktreePath: "/r/app",
        todoId: "t1",
      },
      WAIT
    );
    expect(started).toMatchObject({
      sessionId: "s1",
      worktreePath: "/r/app-fix",
      branch: "fix",
    });
    expect(deps.createWorktree).toHaveBeenCalledWith("/r/app", "fix", "main");
    expect(deps.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/r/app-fix" }),
      "/r/app",
      "/r/app"
    );
    expect(deps.recordTodoStarted).toHaveBeenCalledWith("t1", "/r/app-fix");
    expect(await started.delivery).toEqual({ sent: true });
    expect(deps.sendMessage).toHaveBeenCalledWith("s1", "直して");
  });

  it("起動を確かめられなければ送らず、worktree とセッションは残す", async () => {
    const deps = fakeDeps([state({ cliState: null })]);
    const started = await startTask(
      deps,
      { repoPath: "/r/app", name: "fix", prompt: "直して" },
      WAIT
    );
    expect(await started.delivery).toEqual({ sent: false, reason: "timeout" });
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("送信の失敗は delivery の error にする (reject しない)", async () => {
    const deps = fakeDeps([state(), state()]);
    vi.mocked(deps.sendMessage).mockImplementation(() => {
      throw new Error("Session not found");
    });
    const started = await startTask(
      deps,
      { repoPath: "/r/app", name: "fix", prompt: "直して" },
      WAIT
    );
    expect(await started.delivery).toEqual({
      sent: false,
      reason: "error",
      error: "Session not found",
    });
  });

  it("worktree を作れなければ起動しない", async () => {
    const deps = fakeDeps([state()]);
    vi.mocked(deps.createWorktree).mockRejectedValue(new Error("使用中"));
    await expect(
      startTask(deps, { repoPath: "/r/app", name: "fix", prompt: "x" }, WAIT)
    ).rejects.toThrow("使用中");
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  it("TODO の記録に失敗しても起動を続ける", async () => {
    const deps = {
      ...fakeDeps([state(), state()]),
      recordTodoStarted: vi.fn(() => {
        throw new Error("db");
      }),
    };
    const started = await startTask(
      deps,
      { repoPath: "/r/app", name: "fix", prompt: "x", todoId: "t1" },
      WAIT
    );
    expect(deps.startSession).toHaveBeenCalled();
    expect(await started.delivery).toEqual({ sent: true });
  });
});

describe("describeDelivery", () => {
  it("送れなかった理由ごとに文を返す", () => {
    expect(describeDelivery({ sent: true })).toBe("最初の文を送りました");
    expect(describeDelivery({ sent: false, reason: "awaiting" })).toContain(
      "確認の応答"
    );
    expect(
      describeDelivery({ sent: false, reason: "error", error: "boom" })
    ).toContain("boom");
  });
});
