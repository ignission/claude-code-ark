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

// system.js をモック化して resolveTmuxPath / resolveClaudePath を決定論的にする
// (実環境の PATH に依存して非決定的にならないように)。
// resolveClaudePath は default で null を返し、tmux-manager 側の "claude" フォールバックが
// 効くようにする。絶対パス挙動の検証は個別 test で mockReturnValue で上書きする。
vi.mock("./system.js", () => ({
  resolveTmuxPath: vi.fn(() => null),
  resolveClaudePath: vi.fn(() => null),
}));

import { execSync, spawnSync } from "node:child_process";
import { resolveClaudePath } from "./system.js";
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
      "-e",
      "NODE_ENV=",
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

  it("NODE_ENV= でリセットされ、options.env で明示上書きすれば last-wins で反映される", async () => {
    // tmux の -e は同じキーが複数指定された場合 last-wins で評価される (man tmux)。
    // デフォルトでベースの -e NODE_ENV= (空文字) が入り、その後ろに
    // 利用者が options.env で NODE_ENV=test を指定した場合は last-wins で test が
    // 採用される。これにより、特殊なテスト用セッションでは値を上書きできる。
    await manager.createSession("/path/to/worktree", {
      env: { NODE_ENV: "test" },
    });

    const args = findNewSessionArgs();
    if (!args) throw new Error("new-session args not found");

    // ベースの -e NODE_ENV= が含まれる
    const baseNodeEnvIdx = args.indexOf("NODE_ENV=");
    expect(baseNodeEnvIdx).toBeGreaterThan(-1);
    expect(args[baseNodeEnvIdx - 1]).toBe("-e");

    // 利用者指定の -e NODE_ENV=test が後に追加される
    const overrideIdx = args.indexOf("NODE_ENV=test");
    expect(overrideIdx).toBeGreaterThan(baseNodeEnvIdx);
    expect(args[overrideIdx - 1]).toBe("-e");
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

  it("resolveClaudePath が絶対パスを返したら send-keys に POSIX single-quote 付きで渡る (issue #186)", async () => {
    // .app 同梱 SDK の typical path を返すように mock を上書き
    const bundledClaudePath =
      "/Applications/Ark.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
    vi.mocked(resolveClaudePath).mockReturnValueOnce(bundledClaudePath);

    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    // POSIX single-quote で wrap した絶対パスがそのまま送られる
    // ($, `, \, " 等の shell メタ文字解釈を完全に抑止するため double-quote ではなく single-quote)
    expect(sendKeys[3]).toBe(`'${bundledClaudePath}'`);
  });

  it("空白を含むパス + skipPermissions=true で single-quote + フラグが付く (issue #186)", async () => {
    // ~/Library/Application Support/... の空白を含むパスでも壊れないことを併せて確認
    const bundledClaudePath =
      "/Users/test/Library/Application Support/Ark/claude-runtime/bin/claude";
    vi.mocked(resolveClaudePath).mockReturnValueOnce(bundledClaudePath);

    manager.setSkipPermissions(true);
    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).toBe(
      `'${bundledClaudePath}' --dangerously-skip-permissions`
    );
  });

  it("パスに single-quote を含む場合は POSIX 流の '\\'' エスケープが入る (shell injection 防御)", async () => {
    // 入力パス: /tmp/it's a/claude  →  '/tmp/it'\''s a/claude'
    const trickyPath = "/tmp/it's a/claude";
    vi.mocked(resolveClaudePath).mockReturnValueOnce(trickyPath);

    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).toBe("'/tmp/it'\\''s a/claude'");
  });

  it("resolveClaudePath が相対パスを返した場合はセッション作成自体を throw する (PATH 汚染への信頼境界拡張を拒否)", async () => {
    // 旧実装は "claude" にフォールバックしていたが、これは PATH 信頼境界を広げて
    // PATH 汚染時に意図しない claude を起動する余地を残す。
    // resolver が非 null で invalid を返す = resolver 側のバグ or 攻撃可能性なので、
    // セッション作成自体を fail-fast に倒す (codex P1 指摘対応)。
    vi.mocked(resolveClaudePath).mockReturnValueOnce("./bin/claude");

    await expect(manager.createSession("/path/to/worktree")).rejects.toThrow(
      /non-absolute path/
    );
  });

  it("resolveClaudePath が改行を含むパスを返した場合はセッション作成自体を throw する (shell injection 防御)", async () => {
    vi.mocked(resolveClaudePath).mockReturnValueOnce("/tmp/evil\npwn/claude");

    await expect(manager.createSession("/path/to/worktree")).rejects.toThrow(
      /control char/
    );
  });

  it.each([
    ["NUL (\\x00)", "/tmp/x\x00claude"],
    ["BS (\\x08)", "/tmp/x\x08claude"],
    ["ESC (\\x1B)", "/tmp/x\x1bclaude"],
    ["DEL (\\x7F)", "/tmp/x\x7fclaude"],
  ])("resolveClaudePath が %s を含むパスを返した場合は throw (control char 一括拒否)", async (_label, evilPath) => {
    vi.mocked(resolveClaudePath).mockReturnValueOnce(evilPath);

    await expect(manager.createSession("/path/to/worktree")).rejects.toThrow(
      /control char/
    );
  });
});
