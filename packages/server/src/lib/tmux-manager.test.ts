/**
 * tmux-manager createSession optionsの後方互換テスト
 *
 * spawnSync / execSync をモックして、tmuxへ渡す引数を直接検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import fs from "node:fs";
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

    // send-keysにclaudeが渡される。プロファイル未指定なので、tmux サーバー
    // env からの CLAUDE_CONFIG_DIR 継承を断つ unset が前置される
    const sendKeys = findCommandSendKeysArgs();
    expect(sendKeys).toBeDefined();
    expect(sendKeys).toEqual([
      "send-keys",
      "-t",
      "ark-testid01",
      "unset CLAUDE_CONFIG_DIR; claude",
      "Enter",
    ]);

    // セッションがthis.sessionsに登録されている
    expect(manager.getSession(session.id)).toBeDefined();
    expect(session.tmuxSessionName).toBe("ark-testid01");
  });

  it("createSession の tmux 呼び出しすべてに timeout が付与される", async () => {
    // spawnSync は同期呼び出しでハングするとイベントループごと停止するため、
    // JS 側のタイムアウトでは救えない。timeout オプションで子プロセスを
    // kill させ、error → throw → restartSession の finally が in-flight を
    // 解放する経路を成立させる (CodeRabbit PR#221 指摘対応)
    await manager.createSession("/path/to/worktree");

    const tmuxCalls = mockedSpawnSync.mock.calls.filter(
      ([, args]) =>
        Array.isArray(args) &&
        ["new-session", "set-option", "send-keys"].includes(String(args[0]))
    );
    expect(tmuxCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of tmuxCalls) {
      const opts = call[2] as { timeout?: number } | undefined;
      expect(opts?.timeout).toBeGreaterThan(0);
    }
  });

  it("createSession 失敗時のクリーンアップ kill-session にも timeout が付与される", async () => {
    // new-session 成功 → set-option 失敗、でクリーンアップ経路に入れる
    mockedSpawnSync.mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === "set-option") {
        return { ...successResult, status: 1 } as never;
      }
      return successResult as never;
    });

    await expect(manager.createSession("/path/to/worktree")).rejects.toThrow();

    const killCall = mockedSpawnSync.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "kill-session"
    );
    expect(killCall).toBeDefined();
    const opts = killCall?.[2] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBeGreaterThan(0);
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
    expect(sendKeys[3]).toBe(
      "unset CLAUDE_CONFIG_DIR; claude --dangerously-skip-permissions"
    );
  });

  it("setClaudeMcpConfigPath 設定時は --mcp-config <quoted> のみが付与される (board_write を既存 MCP に上乗せ・strict なし)", async () => {
    manager.setClaudeMcpConfigPath("/tmp/sess-mcp.json");
    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).toContain("--mcp-config");
    expect(sendKeys[3]).toContain("/tmp/sess-mcp.json");
    // --strict-mcp-config は付けない: ユーザーの project .mcp.json / global の
    // 他 MCP (Slack/Jira/Figma 等) を無効化しないため (board MCP は上乗せ)。
    expect(sendKeys[3]).not.toContain("--strict-mcp-config");
    expect(sendKeys[3]).toBe(
      "unset CLAUDE_CONFIG_DIR; claude --mcp-config '/tmp/sess-mcp.json'"
    );
  });

  it("setClaudeMcpConfigPath は setSkipPermissions と併用でき、--dangerously-skip-permissions の後に付与される", async () => {
    manager.setSkipPermissions(true);
    manager.setClaudeMcpConfigPath("/tmp/sess-mcp.json");
    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).not.toContain("--strict-mcp-config");
    expect(sendKeys[3]).toBe(
      "unset CLAUDE_CONFIG_DIR; claude --dangerously-skip-permissions --mcp-config '/tmp/sess-mcp.json'"
    );
  });

  it("--settings と --mcp-config は渡し、--append-system-prompt は起動コマンドに含めない", async () => {
    manager.setClaudeSettingsPath("/tmp/ark-claude-settings.json");
    manager.setClaudeMcpConfigPath("/tmp/sess-mcp.json");
    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).toBe(
      "unset CLAUDE_CONFIG_DIR; claude --settings '/tmp/ark-claude-settings.json' --mcp-config '/tmp/sess-mcp.json'"
    );
    expect(sendKeys[3]).not.toContain("--append-system-prompt");
  });

  it("setClaudeMcpConfigPath(null) にリセットすると --mcp-config は付与されない (tmuxManager 共有インスタンスの安全確認)", async () => {
    manager.setClaudeMcpConfigPath("/tmp/sess-mcp.json");
    manager.setClaudeMcpConfigPath(null);
    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).toBe("unset CLAUDE_CONFIG_DIR; claude");
    expect(sendKeys[3]).not.toContain("--mcp-config");
  });

  it("未設定 (デフォルト) のときは --mcp-config を注入しない", async () => {
    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).not.toContain("--mcp-config");
    expect(sendKeys[3]).not.toContain("--strict-mcp-config");
  });

  it("options.env に CLAUDE_CONFIG_DIR がある場合 (プロファイル) は unset を前置しない", async () => {
    await manager.createSession("/path/to/worktree", {
      env: { CLAUDE_CONFIG_DIR: "/home/user/.claude-work" },
    });

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).toBe("claude");
  });

  it("resolveClaudePath が絶対パスを返したら send-keys に POSIX single-quote 付きで渡る (issue #186)", async () => {
    // .app 同梱 claude (claude-code) の typical path を返すように mock を上書き
    const bundledClaudePath =
      "/Applications/Ark.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude";
    vi.mocked(resolveClaudePath).mockReturnValueOnce(bundledClaudePath);

    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    // POSIX single-quote で wrap した絶対パスがそのまま送られる
    // ($, `, \, " 等の shell メタ文字解釈を完全に抑止するため double-quote ではなく single-quote)
    expect(sendKeys[3]).toBe(`unset CLAUDE_CONFIG_DIR; '${bundledClaudePath}'`);
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
      `unset CLAUDE_CONFIG_DIR; '${bundledClaudePath}' --dangerously-skip-permissions`
    );
  });

  it("パスに single-quote を含む場合は POSIX 流の '\\'' エスケープが入る (shell injection 防御)", async () => {
    // 入力パス: /tmp/it's a/claude  →  '/tmp/it'\''s a/claude'
    const trickyPath = "/tmp/it's a/claude";
    vi.mocked(resolveClaudePath).mockReturnValueOnce(trickyPath);

    await manager.createSession("/path/to/worktree");

    const sendKeys = findCommandSendKeysArgs();
    if (!sendKeys) throw new Error("send-keys args not found");
    expect(sendKeys[3]).toBe(
      "unset CLAUDE_CONFIG_DIR; '/tmp/it'\\''s a/claude'"
    );
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
  ])(
    "resolveClaudePath が %s を含むパスを返した場合は throw (control char 一括拒否)",
    async (_label, evilPath) => {
      vi.mocked(resolveClaudePath).mockReturnValueOnce(evilPath);

      await expect(manager.createSession("/path/to/worktree")).rejects.toThrow(
        /control char/
      );
    }
  );
});

/**
 * sendKeys / sendSpecialKey / sendLiteral の挙動を検証する。
 * sendKeys は Esc 後の重複送信を防ぐため、リテラル送信前に C-u
 * (kill-line) を送って tmux pane の入力欄をクリアする必要がある。
 */
describe("TmuxManager - 入力系メソッド", () => {
  let manager: TmuxManager;
  let sessionId: string;
  let tmuxSessionName: string;

  beforeEach(async () => {
    mockedSpawnSync.mockReset();
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("list-sessions")) {
        return Buffer.from("");
      }
      return Buffer.from("");
    });
    mockedSpawnSync.mockReturnValue(successResult as never);

    manager = new TmuxManager();
    const session = await manager.createSession("/wt");
    sessionId = session.id;
    tmuxSessionName = session.tmuxSessionName;

    // createSession 中に積まれた send-keys 呼び出しは別検証なので、
    // ここで mock の履歴をクリアして以降は sendKeys 呼び出しだけを検証する
    mockedSpawnSync.mockClear();
  });

  /** spawnSync 呼び出し履歴から tmux send-keys の引数だけを抽出 */
  function sendKeysCalls(): string[][] {
    return mockedSpawnSync.mock.calls
      .map(call => call[1])
      .filter((args): args is string[] => Array.isArray(args))
      .filter(args => args[0] === "send-keys");
  }

  describe("sendKeys (Enter 付き送信)", () => {
    it("リテラル送信の前に C-u を送って tmux pane の入力欄をクリアする", () => {
      manager.sendKeys(sessionId, "hello");

      const calls = sendKeysCalls();
      // 想定: 1) C-u クリア, 2) -l hello, 3) Enter
      expect(calls).toHaveLength(3);
      expect(calls[0]).toEqual(["send-keys", "-t", tmuxSessionName, "C-u"]);
      expect(calls[1]).toEqual([
        "send-keys",
        "-t",
        tmuxSessionName,
        "-l",
        "hello",
      ]);
      expect(calls[2]).toEqual(["send-keys", "-t", tmuxSessionName, "Enter"]);
    });

    it("送信順序: C-u → -l → Enter を厳密に守る", () => {
      // Esc 後の状態を模した重複防止フローの肝。
      // この順番が崩れると Claude 側に "残骸 + 新メッセージ" が連結されたり、
      // クリアが効かなかったりするので順序の固定化が重要。
      manager.sendKeys(sessionId, "msg");
      const calls = sendKeysCalls();
      const keys = calls.map(c =>
        c.includes("-l") ? "literal" : c[c.length - 1]
      );
      expect(keys).toEqual(["C-u", "literal", "Enter"]);
    });

    it("マルチバイト文字も -l でリテラル送信される", () => {
      manager.sendKeys(sessionId, "中止テスト");
      const calls = sendKeysCalls();
      expect(calls[1]).toEqual([
        "send-keys",
        "-t",
        tmuxSessionName,
        "-l",
        "中止テスト",
      ]);
    });

    it("不明なセッション ID なら例外", () => {
      expect(() => manager.sendKeys("unknown", "x")).toThrow(
        "Session not found"
      );
    });
  });

  describe("sendLiteral (Enter 無し送信)", () => {
    it("Enter も C-u も付与せずリテラルだけ送る", () => {
      manager.sendLiteral(sessionId, "abc");
      const calls = sendKeysCalls();
      expect(calls).toEqual([
        ["send-keys", "-t", tmuxSessionName, "-l", "abc"],
      ]);
    });
  });

  describe("sendSpecialKey", () => {
    it("ホワイトリストの Escape は tmux に直接渡る", () => {
      manager.sendSpecialKey(sessionId, "Escape");
      const calls = sendKeysCalls();
      expect(calls).toEqual([["send-keys", "-t", tmuxSessionName, "Escape"]]);
    });

    it("S-Tab は tmux 用の BTab にマップされる", () => {
      manager.sendSpecialKey(sessionId, "S-Tab");
      const calls = sendKeysCalls();
      expect(calls[0]).toEqual(["send-keys", "-t", tmuxSessionName, "BTab"]);
    });

    it("数字キー (AskUserQuestion 選択肢) はそのまま送信される", () => {
      manager.sendSpecialKey(sessionId, "3");
      const calls = sendKeysCalls();
      expect(calls).toEqual([["send-keys", "-t", tmuxSessionName, "3"]]);
    });

    it("Space (multiSelect トグル) はそのまま送信される", () => {
      manager.sendSpecialKey(sessionId, "Space");
      const calls = sendKeysCalls();
      expect(calls).toEqual([["send-keys", "-t", tmuxSessionName, "Space"]]);
    });

    it("ホワイトリスト外のキーは例外", () => {
      expect(() =>
        manager.sendSpecialKey(sessionId, "DangerousKey" as never)
      ).toThrow();
    });
  });
});

/**
 * 読み取り系メソッドの失敗分類 (#393)
 *
 * 以前は tmux コマンドの失敗と「値が無い」を同じ null に畳んでいたため、
 * セッション消滅・復元失敗の原因を事後に追えなかった。ここでは spawnSync を
 * 失敗させたとき、失敗要因が型 (failure.kind) で区別され、tmux の stderr /
 * exit status / errno が結果に残ることを検証する。
 */
describe("TmuxManager - 読み取り系メソッドの失敗分類 (#393)", () => {
  let manager: TmuxManager;
  let sessionId: string;
  let tmuxSessionName: string;

  /** encoding: "utf-8" 指定時の spawnSync 戻り値 (stdout/stderr は string) */
  const textResult = (over: {
    status?: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  }) => ({
    pid: 1234,
    output: [null, over.stdout ?? "", over.stderr ?? ""],
    stdout: over.stdout ?? "",
    stderr: over.stderr ?? "",
    // null は「signal で終了 / 起動失敗」を表す正当な値なので ?? で潰さない
    status: over.status === undefined ? 0 : over.status,
    signal: over.signal ?? null,
    error: over.error,
  });

  /** 指定の tmux サブコマンドだけ差し替え、他は成功扱いにする */
  function mockTmux(
    handlers: Record<string, (args: string[]) => ReturnType<typeof textResult>>
  ) {
    mockedSpawnSync.mockImplementation((_cmd, args) => {
      const list = Array.isArray(args) ? (args as string[]) : [];
      const handler = handlers[list[0] ?? ""];
      return (handler ? handler(list) : textResult({})) as never;
    });
  }

  function callsOf(sub: string): string[][] {
    return mockedSpawnSync.mock.calls
      .map(call => call[1])
      .filter((args): args is string[] => Array.isArray(args))
      .filter(args => args[0] === sub);
  }

  beforeEach(async () => {
    mockedSpawnSync.mockReset();
    mockedExecSync.mockReset();
    mockedSpawnSync.mockReturnValue(successResult as never);
    manager = new TmuxManager();
    const session = await manager.createSession("/wt");
    sessionId = session.id;
    tmuxSessionName = session.tmuxSessionName;
    mockedSpawnSync.mockClear();
  });

  describe("getEnv", () => {
    it("不明なセッション ID は no-session (tmux を呼ばない)", () => {
      const result = manager.getEnv("unknown", "FOO");
      expect(result).toEqual({ ok: false, failure: { kind: "no-session" } });
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it("session env 一覧 (show-environment -t <session>) から値を取り出す", () => {
      mockTmux({
        "show-environment": () =>
          textResult({ stdout: "-DISPLAY\nFOO=bar=baz\nOTHER=1\n" }),
      });
      expect(manager.getEnv(sessionId, "FOO")).toEqual({
        ok: true,
        value: "bar=baz",
      });
      expect(callsOf("show-environment")).toEqual([
        ["show-environment", "-t", tmuxSessionName],
      ]);
    });

    it("一覧に変数が無ければ not-set", () => {
      mockTmux({
        "show-environment": () => textResult({ stdout: "OTHER=1\n" }),
      });
      expect(manager.getEnv(sessionId, "FOO")).toEqual({
        ok: false,
        failure: { kind: "not-set" },
      });
    });

    it("unset マーカー (-NAME) は not-set", () => {
      mockTmux({
        "show-environment": () => textResult({ stdout: "-FOO\nFOOBAR=1\n" }),
      });
      expect(manager.getEnv(sessionId, "FOO")).toEqual({
        ok: false,
        failure: { kind: "not-set" },
      });
    });

    it("前方一致する別名 (FOOBAR) を FOO と誤認しない", () => {
      mockTmux({
        "show-environment": () => textResult({ stdout: "FOOBAR=1\n" }),
      });
      expect(manager.getEnv(sessionId, "FOO")).toEqual({
        ok: false,
        failure: { kind: "not-set" },
      });
    });

    it("空文字の値は not-set ではなく ok (値が空) として返す", () => {
      mockTmux({
        "show-environment": () => textResult({ stdout: "FOO=\n" }),
      });
      expect(manager.getEnv(sessionId, "FOO")).toEqual({ ok: true, value: "" });
    });

    it("tmux が非 0 で終了したら tmux-failed で status と stderr を残す", () => {
      mockTmux({
        "show-environment": () =>
          textResult({ status: 1, stderr: "no such session: ark-x\n" }),
      });
      expect(manager.getEnv(sessionId, "FOO")).toEqual({
        ok: false,
        failure: {
          kind: "tmux-failed",
          command: "show-environment",
          status: 1,
          signal: null,
          stderr: "no such session: ark-x",
        },
      });
    });

    it("tmux の起動自体に失敗 (spawnSync error) したら errno code と message を残す", () => {
      const error = Object.assign(new Error("spawnSync tmux ENOENT"), {
        code: "ENOENT",
      });
      mockTmux({
        "show-environment": () => textResult({ status: null, error }),
      });
      const result = manager.getEnv(sessionId, "FOO");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.failure).toMatchObject({
        kind: "tmux-failed",
        command: "show-environment",
        status: null,
        code: "ENOENT",
        message: "spawnSync tmux ENOENT",
      });
    });

    it("timeout で kill された場合は signal と ETIMEDOUT を残す", () => {
      const error = Object.assign(new Error("spawnSync tmux ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
      mockTmux({
        "show-environment": () =>
          textResult({ status: null, signal: "SIGTERM", error }),
      });
      const result = manager.getEnv(sessionId, "FOO");
      if (result.ok) throw new Error("unreachable");
      expect(result.failure).toMatchObject({
        kind: "tmux-failed",
        signal: "SIGTERM",
        code: "ETIMEDOUT",
      });
      // ハング時にイベントループごと止まらないよう timeout を付けて呼ぶ
      const opts = callsOf("show-environment").length
        ? (mockedSpawnSync.mock.calls.find(
            ([, args]) => Array.isArray(args) && args[0] === "show-environment"
          )?.[2] as { timeout?: number } | undefined)
        : undefined;
      expect(opts?.timeout).toBeGreaterThan(0);
    });
  });

  describe("getPaneEnv", () => {
    const originalPlatform = process.platform;
    const setPlatform = (value: string) =>
      Object.defineProperty(process, "platform", { value, configurable: true });

    afterEach(() => {
      setPlatform(originalPlatform);
      vi.restoreAllMocks();
    });

    it("不明なセッション ID は no-session", () => {
      expect(manager.getPaneEnv("unknown", "FOO")).toEqual({
        ok: false,
        failure: { kind: "no-session" },
      });
    });

    it("Linux 以外では /proc を読まずに unsupported-platform", () => {
      setPlatform("darwin");
      expect(manager.getPaneEnv(sessionId, "FOO")).toEqual({
        ok: false,
        failure: { kind: "unsupported-platform", platform: "darwin" },
      });
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it("list-panes が失敗したら tmux-failed", () => {
      setPlatform("linux");
      mockTmux({
        "list-panes": () =>
          textResult({ status: 1, stderr: "can't find session: ark-x" }),
      });
      expect(manager.getPaneEnv(sessionId, "FOO")).toMatchObject({
        ok: false,
        failure: {
          kind: "tmux-failed",
          command: "list-panes",
          status: 1,
          stderr: "can't find session: ark-x",
        },
      });
    });

    it("pane_pid が数値でなければ invalid-pane-pid", () => {
      setPlatform("linux");
      mockTmux({ "list-panes": () => textResult({ stdout: "abc\n" }) });
      expect(manager.getPaneEnv(sessionId, "FOO")).toEqual({
        ok: false,
        failure: { kind: "invalid-pane-pid", raw: "abc" },
      });
    });

    it("/proc/<pid>/environ が読めなければ proc-error (errno 付き)", () => {
      setPlatform("linux");
      mockTmux({ "list-panes": () => textResult({ stdout: "4242\n" }) });
      vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      });
      expect(manager.getPaneEnv(sessionId, "FOO")).toEqual({
        ok: false,
        failure: {
          kind: "proc-error",
          code: "EACCES",
          message: "EACCES: permission denied",
        },
      });
      expect(fs.readFileSync).toHaveBeenCalledWith(
        "/proc/4242/environ",
        "utf-8"
      );
    });

    it("environ に変数があれば ok、無ければ not-set", () => {
      setPlatform("linux");
      mockTmux({ "list-panes": () => textResult({ stdout: "4242\n" }) });
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        "PATH=/bin\0FOO=/home/u/.claude-work\0"
      );
      expect(manager.getPaneEnv(sessionId, "FOO")).toEqual({
        ok: true,
        value: "/home/u/.claude-work",
      });
      expect(manager.getPaneEnv(sessionId, "BAR")).toEqual({
        ok: false,
        failure: { kind: "not-set" },
      });
    });
  });

  describe("getBuffer", () => {
    it("不明なセッション ID は no-session", () => {
      expect(manager.getBuffer("unknown")).toEqual({
        ok: false,
        failure: { kind: "no-session" },
      });
    });

    it("バッファが 1 つも無い場合は tmux-failed ではなく no-buffer", () => {
      mockTmux({ "list-buffers": () => textResult({ stdout: "" }) });
      expect(manager.getBuffer(sessionId)).toEqual({
        ok: false,
        failure: { kind: "no-buffer" },
      });
      expect(callsOf("show-buffer")).toHaveLength(0);
    });

    it("list-buffers が失敗したら tmux-failed", () => {
      mockTmux({
        "list-buffers": () =>
          textResult({ status: 1, stderr: "no server running" }),
      });
      expect(manager.getBuffer(sessionId)).toMatchObject({
        ok: false,
        failure: {
          kind: "tmux-failed",
          command: "list-buffers",
          stderr: "no server running",
        },
      });
    });

    it("show-buffer が失敗したら tmux-failed (command=show-buffer)", () => {
      mockTmux({
        "list-buffers": () => textResult({ stdout: "buffer0\n" }),
        "show-buffer": () => textResult({ status: 1, stderr: "boom" }),
      });
      expect(manager.getBuffer(sessionId)).toMatchObject({
        ok: false,
        failure: { kind: "tmux-failed", command: "show-buffer" },
      });
    });

    it("バッファがあれば末尾改行を落として返す", () => {
      mockTmux({
        "list-buffers": () => textResult({ stdout: "buffer0\n" }),
        "show-buffer": () => textResult({ stdout: "copied text\n" }),
      });
      expect(manager.getBuffer(sessionId)).toEqual({
        ok: true,
        value: "copied text",
      });
    });
  });

  describe("capturePane / capturePaneVisible", () => {
    it("不明なセッション ID は no-session", () => {
      expect(manager.capturePane("unknown")).toEqual({
        ok: false,
        failure: { kind: "no-session" },
      });
      expect(manager.capturePaneVisible("unknown")).toEqual({
        ok: false,
        failure: { kind: "no-session" },
      });
    });

    it("capture-pane が失敗したら tmux-failed に stderr を残す", () => {
      mockTmux({
        "capture-pane": () =>
          textResult({ status: 1, stderr: "can't find pane: ark-x" }),
      });
      const expected = {
        ok: false,
        failure: {
          kind: "tmux-failed",
          command: "capture-pane",
          status: 1,
          stderr: "can't find pane: ark-x",
        },
      };
      expect(manager.capturePane(sessionId, 50)).toMatchObject(expected);
      expect(manager.capturePaneVisible(sessionId)).toMatchObject(expected);
    });

    it("成功時は画面テキストを返し、空画面は失敗ではなく空文字", () => {
      mockTmux({
        "capture-pane": args =>
          textResult({ stdout: args.includes("-S") ? "scrollback\n" : "" }),
      });
      expect(manager.capturePane(sessionId, 50)).toEqual({
        ok: true,
        value: "scrollback",
      });
      expect(manager.capturePaneVisible(sessionId)).toEqual({
        ok: true,
        value: "",
      });
      expect(callsOf("capture-pane")).toEqual([
        ["capture-pane", "-t", tmuxSessionName, "-p", "-S", "-50"],
        ["capture-pane", "-t", tmuxSessionName, "-p"],
      ]);
    });
  });
});
