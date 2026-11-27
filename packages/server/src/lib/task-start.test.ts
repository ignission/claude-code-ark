import type { ManagedSession, Worktree } from "@ark/shared";
import { describe, expect, it, vi } from "vitest";
import {
  deriveTaskName,
  deriveTaskTitle,
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
    isNameAvailable: vi.fn(async () => true),
    setDisplayName: vi.fn(),
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

  it("名前は空でもよい (startTask がプロンプトから作る)", () => {
    expect(validateTaskInput({ name: " ", prompt: "x" })).toEqual({
      name: "",
      prompt: "x",
    });
    expect(validateTaskInput({ prompt: "x" })).toEqual({
      name: "",
      prompt: "x",
    });
  });

  it("空のプロンプトと、ブランチ名に使えない文字は拒否する", () => {
    expect(() => validateTaskInput({ name: "", prompt: " " })).toThrow(
      "プロンプトが空です"
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

describe("deriveTaskName", () => {
  const now = new Date(2026, 10, 27, 9, 5);

  it("先頭の行の英数字の語を小文字にしてハイフンでつなぐ", () => {
    expect(deriveTaskName("Fix the log format\n詳しくは下に", now)).toBe(
      "fix-the-log-format"
    );
    expect(deriveTaskName("\n  PR #12 の CI を直す", now)).toBe("pr-12-ci");
    // 全角の英数字も拾う
    expect(deriveTaskName("ＡＢＣ－１２３の見積もり", now)).toBe("abc-123");
  });

  it("語は5つまで、長さは40文字までに切る", () => {
    expect(deriveTaskName("one two three four five six seven", now)).toBe(
      "one-two-three-four-five"
    );
    const long = deriveTaskName(`${"a".repeat(30)} ${"b".repeat(30)}`, now);
    expect(long).toBe("a".repeat(30));
  });

  it("英数字が無ければ (日本語だけのプロンプト) task-<月日>-<時分> にする", () => {
    expect(deriveTaskName("ログの形式を直して", now)).toBe("task-1127-0905");
  });

  it("作った名前はブランチ名の検証を通る", () => {
    for (const prompt of ["ログを直す", "Fix: a/b..c", "--rm -rf"]) {
      const { name } = validateTaskInput({
        name: deriveTaskName(prompt, now),
        prompt,
      });
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});

describe("deriveTaskTitle", () => {
  it("先頭の空でない行を、40文字で切って表示名にする", () => {
    expect(deriveTaskTitle("\n  ログの   形式を直す \n二行目")).toBe(
      "ログの 形式を直す"
    );
    expect(deriveTaskTitle("あ".repeat(50))).toBe(`${"あ".repeat(40)}…`);
  });
});

describe("startTask", () => {
  it("名前を省くと、プロンプトから空いている名前を作り、プロンプトの先頭を表示名にする", async () => {
    const deps = fakeDeps([state(), state()]);
    vi.mocked(deps.isNameAvailable).mockImplementation(
      async (_repo, name) => name !== "fix-log" && name !== "fix-log-2"
    );
    await startTask(
      deps,
      { repoPath: "/r/app", name: "", prompt: "fix log\n詳細" },
      WAIT
    );
    expect(deps.createWorktree).toHaveBeenCalledWith(
      "/r/app",
      "fix-log-3",
      undefined
    );
    expect(deps.setDisplayName).toHaveBeenCalledWith("/r/app-fix", "fix log");
  });

  it("名前を渡したときは、空きを調べず表示名も付けない", async () => {
    const deps = fakeDeps([state(), state()]);
    await startTask(
      deps,
      { repoPath: "/r/app", name: "fix", prompt: "直して" },
      WAIT
    );
    expect(deps.isNameAvailable).not.toHaveBeenCalled();
    expect(deps.setDisplayName).not.toHaveBeenCalled();
  });

  it("空いている名前が見つからなければ worktree を作らない", async () => {
    const deps = fakeDeps([state()]);
    vi.mocked(deps.isNameAvailable).mockResolvedValue(false);
    await expect(
      startTask(deps, { repoPath: "/r/app", prompt: "fix" }, WAIT)
    ).rejects.toThrow("空きが見つかりません");
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

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
