/**
 * tmux-manager createSession optionsの後方互換テスト
 *
 * spawnSync / execSync をモックして、tmuxへ渡す引数を直接検証する。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// child_process全体をモック化（top-level mockはhoistされる）
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

// nanoidをモック化して決定論的なIDを返す
vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "testid01"),
}));

import { execSync, spawnSync } from "node:child_process";
import { TmuxManager } from "./tmux-manager.js";

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedExecSync = vi.mocked(execSync);

/**
 * spawnSync を成功扱いにする標準的なレスポンス
 */
const successResult = {
  pid: 1234,
  output: [null, Buffer.from(""), Buffer.from("")],
  stdout: Buffer.from(""),
  stderr: Buffer.from(""),
  status: 0,
  signal: null,
};

/**
 * spawnSyncのコールから「new-session」呼び出しのargs配列を取り出す
 */
function findNewSessionArgs(): string[] | undefined {
  for (const call of mockedSpawnSync.mock.calls) {
    const [_cmd, args] = call;
    if (Array.isArray(args) && args[0] === "new-session") {
      return args;
    }
  }
  return undefined;
}

/**
 * spawnSyncのコールから「send-keys -t <name> <command> Enter」を取り出す
 * （リテラル送信 -l ではなく、コマンド送信パターン）
 */
function findCommandSendKeysArgs(): string[] | undefined {
  for (const call of mockedSpawnSync.mock.calls) {
    const [_cmd, args] = call;
    if (
      Array.isArray(args) &&
      args[0] === "send-keys" &&
      // -l リテラル送信ではない（claude起動コマンド系）
      !args.includes("-l") &&
      // Enter単独ではなく、コマンド + Enter のパターン
      args[args.length - 1] === "Enter" &&
      args.length >= 5
    ) {
      return args;
    }
  }
  return undefined;
}

describe("TmuxManager.createSession - options互換", () => {
  let manager: TmuxManager;

  beforeEach(() => {
    mockedSpawnSync.mockReset();
    mockedExecSync.mockReset();

    // コンストラクタが呼ぶ execSync (which tmux / list-sessions / set copy-command) を成功扱い
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("list-sessions")) {
        // 既存セッション無し
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    // spawnSyncはデフォルトで成功
    mockedSpawnSync.mockReturnValue(successResult as never);

    manager = new TmuxManager();
  });

  it("optionsを省略した場合、既存と同じargsでtmux new-sessionが呼ばれる", async () => {
    const session = await manager.createSession("/path/to/worktree");

    const args = findNewSessionArgs();
    expect(args).toBeDefined();
    expect(args).toEqual([
      "new-session",
      "-d",
      "-s",
      "ark-testid01",
      "-c",
      "/path/to/worktree",
      "-e",
      "CLAUDECODE=",
      "-e",
      "CLAUDE_CODE_NO_FLICKER=1",
    ]);

    // send-keysにclaudeが渡される
    const sendKeys = findCommandSendKeysArgs();
    expect(sendKeys).toBeDefined();
    expect(sendKeys).toEqual([
      "send-keys",
      "-t",
      "ark-testid01",
      "claude",
      "Enter",
    ]);

    // セッションがthis.sessionsに登録されている
    expect(manager.getSession(session.id)).toBeDefined();
    expect(session.tmuxSessionName).toBe("ark-testid01");
  });

  it("options.envで -e KEY=VALUE が追加される", async () => {
    await manager.createSession("/path/to/worktree", {
      env: { FOO: "bar", BAZ: "qux" },
    });

    const args = findNewSessionArgs();
    if (!args) throw new Error("new-session args not found");
    // ベースの -e CLAUDECODE= -e CLAUDE_CODE_NO_FLICKER=1 に加えて -e FOO=bar -e BAZ=qux
    expect(args).toContain("-e");
    expect(args).toContain("FOO=bar");
    expect(args).toContain("BAZ=qux");
    expect(args).toContain("CLAUDECODE=");
    expect(args).toContain("CLAUDE_CODE_NO_FLICKER=1");

    // 順序: 既存の -e が先、追加 envが後
    const fooIdx = args.indexOf("FOO=bar");
    const bazIdx = args.indexOf("BAZ=qux");
    const flickerIdx = args.indexOf("CLAUDE_CODE_NO_FLICKER=1");
    expect(fooIdx).toBeGreaterThan(flickerIdx);
    expect(bazIdx).toBeGreaterThan(flickerIdx);

    // 各 KEY=VALUE の直前は -e
    expect(args[fooIdx - 1]).toBe("-e");
    expect(args[bazIdx - 1]).toBe("-e");
  });

  it("options.namePrefix でセッション名のプレフィックスが変わる", async () => {
    const session = await manager.createSession("/path/to/worktree", {
      namePrefix: "arklogin-",
      autoDiscover: false,
    });

    const args = findNewSessionArgs();
    if (!args) throw new Error("new-session args not found");
    // -s arklogin-testid01
    const sIdx = args.indexOf("-s");
    expect(args[sIdx + 1]).toBe("arklogin-testid01");
    expect(session.tmuxSessionName).toBe("arklogin-testid01");
  });

  it("options.autoDiscover=falseのとき this.sessionsに登録されず、session:createdも発火しない", async () => {
    const createdListener = vi.fn();
    manager.on("session:created", createdListener);

    const session = await manager.createSession("/path/to/worktree", {
      namePrefix: "arklogin-",
      autoDiscover: false,
    });

    // sessionsマップに入っていない
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(manager.getAllSessions()).toHaveLength(0);

    // イベントが発火していない
    expect(createdListener).not.toHaveBeenCalled();
  });

  it("options.commandLine で send-keysに送られるコマンドが差し替わる", async () => {
    await manager.createSession("/path/to/worktree", {
      commandLine: "claude /login",
    });

    const sendKeys = findCommandSendKeysArgs();
    expect(sendKeys).toBeDefined();
    // commandLine引数がそのまま渡る
    expect(sendKeys).toEqual([
      "send-keys",
      "-t",
      "ark-testid01",
      "claude /login",
      "Enter",
    ]);
  });

  it("setSkipPermissions(true) かつ commandLine省略時は --dangerously-skip-permissions が付く（既存挙動）", async () => {
    manager.setSkipPermissions(true);
    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).toBe("claude --dangerously-skip-permissions");
  });
});
