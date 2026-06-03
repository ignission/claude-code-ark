/**
 * BeaconCliSession (tmux 対話版 claude 起動) のユニットテスト。
 *
 * 最重要: **対話版で起動している (= `claude -p` / stream-json を使っていない)** ことを
 * 起動コマンドのフラグ構成で保証する。2026/6/15 以降 `claude -p` / Agent SDK は
 * プラン枠ではなく別枠の Agent SDK クレジット課金になるため、ここが崩れると課金区分が
 * 変わってしまう (plan の検証項目 #3)。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

// launch ディレクトリ privacy assert (assertPrivateDir) 用のデフォルト stat:
// owner 専用 (mode 0700) かつ現ユーザー所有。これが無いと start() が私的ディレクトリ
// 検証で throw する。JSONL stat 用の mtimeMs/size も同梱して両用途を満たす。
const PRIVATE_DIR_UID = process.getuid?.() ?? 0;
const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(() => [] as string[]),
  readFileSync: vi.fn(() => ""),
  statSync: vi.fn(() => ({
    mode: 0o700,
    uid: process.getuid?.() ?? 0,
    mtimeMs: 0,
  })),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock("node:fs", () => fsMock);

vi.mock("node:os", () => ({ homedir: () => "/home/tester" }));

vi.mock("./system.js", () => ({
  resolveTmuxPath: () => "/usr/bin/tmux",
}));

// resolveValidatedClaudePath は tmux-manager から共有 (検証付き resolver)。
// 重い tmux-manager 実体をロードせずスタブする。
vi.mock("./tmux-manager.js", () => ({
  resolveValidatedClaudePath: () => "/opt/claude/bin/claude",
}));

import { BeaconCliSession, isReady } from "./beacon-cli-session.js";

/**
 * start() が beacon-launch スクリプトに書き出した「起動コマンド」文字列を取り出す。
 * 長い launch は send-keys では送らず writeFileSync でファイルへ書き、tmux には短い
 * `source <path>` のみを送る (MAX_CANON 切断回避) ため、起動コマンドの検証はファイル
 * 書き込み内容を見る。
 */
function launchScriptWrite(): [string, string] | undefined {
  const calls = fsMock.writeFileSync.mock.calls as Array<[string, string]>;
  // 書き込み対象は path で構造的に絞る (content の "claude" 部分一致は将来誤検出しうる)
  return calls.find(
    ([path]) => typeof path === "string" && path.endsWith("beacon-launch.sh")
  );
}

function launchCommand(): string {
  return launchScriptWrite()?.[1] ?? "";
}

/** beacon-launch スクリプトの書き込み先パスを取り出す */
function launchScriptPath(): string {
  return launchScriptWrite()?.[0] ?? "";
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  // has-session: 未起動 (status 1)。capture-pane: 即 ready。それ以外: 成功。
  spawnSyncMock.mockImplementation(
    (_bin: string, args: string[] | undefined) => {
      if (args?.[0] === "has-session") return { status: 1 };
      if (args?.[0] === "capture-pane") {
        return {
          stdout: "  > type your message\n  ? for shortcuts",
          status: 0,
        };
      }
      return { status: 0, stdout: "" };
    }
  );
  fsMock.readdirSync.mockReturnValue([]);
  fsMock.writeFileSync.mockClear();
  fsMock.rmSync.mockClear();
  // launch ディレクトリ privacy 検証用のデフォルト (owner 専用 0700 + 現ユーザー所有)。
  // 個別テストの mockReturnValue が後続へ漏れないよう毎回リセットする。
  fsMock.statSync.mockReturnValue({
    mode: 0o700,
    uid: PRIVATE_DIR_UID,
    mtimeMs: 0,
  });
});

describe("BeaconCliSession.start (対話版起動コマンド)", () => {
  const cfg = {
    mcpConfigPath: "/data/beacon-launch/mcp-config.json",
    systemPromptFile: "/data/beacon-launch/system-prompt.txt",
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "mcp__ark-beacon__list_repositories",
    ],
    addDirs: ["/srv/repo-a", "/srv/repo-b"],
  };

  it("対話版フラグで起動し、-p / --print / stream-json を一切使わない", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(cfg, 5000);
    const cmd = launchCommand();

    expect(cmd).toContain("claude");
    // 課金区分を変える -p / ヘッドレス系フラグが無いこと (プラン枠維持の要)
    expect(cmd).not.toMatch(/(^|\s)-p(\s|$)/);
    expect(cmd).not.toContain("--print");
    expect(cmd).not.toContain("stream-json");
    expect(cmd).not.toContain("--input-format");
    expect(cmd).not.toContain("--output-format");
  });

  it("MCP / ツール制限 / system-prompt-file の必須フラグを含む", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(cfg, 5000);
    const cmd = launchCommand();

    expect(cmd).toContain("--mcp-config");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain("--permission-mode");
    expect(cmd).toContain("--tools");
    expect(cmd).toContain("--disable-slash-commands");
    // 巨大 system prompt は file 渡し (send-keys のコマンド長/エスケープ回避)
    expect(cmd).toContain("--append-system-prompt-file");
    // configDir 未指定: CLAUDE_CONFIG_DIR を unset してデフォルトプロファイルで起動
    expect(cmd).toContain("unset CLAUDE_CONFIG_DIR");
  });

  it("configDir 指定時は export CLAUDE_CONFIG_DIR=<dir> で起動する (#3 プロファイル)", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(
      { ...cfg, configDir: "/home/tester/.claude-profile-work" },
      5000
    );
    const cmd = launchCommand();
    expect(cmd).toContain(
      "export CLAUDE_CONFIG_DIR='/home/tester/.claude-profile-work'"
    );
    expect(cmd).not.toContain("unset CLAUDE_CONFIG_DIR");
  });

  it("configDir が null なら従来どおり unset する", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start({ ...cfg, configDir: null }, 5000);
    const cmd = launchCommand();
    expect(cmd).toContain("unset CLAUDE_CONFIG_DIR");
    expect(cmd).not.toContain("export CLAUDE_CONFIG_DIR");
  });

  it("addDirs を --add-dir で列挙し、--allowedTools を最後に置く", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(cfg, 5000);
    const cmd = launchCommand();

    expect(cmd).toContain("--add-dir");
    expect(cmd).toContain("/srv/repo-a");
    expect(cmd).toContain("/srv/repo-b");
    // --allowedTools は variadic なので後続フラグが来ないよう末尾
    const idx = cmd.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd.slice(idx)).not.toContain("--add-dir");
  });

  it("長い launch はファイルに書き、tmux には短い source <path> を送る (MAX_CANON 切断防止)", async () => {
    // シェル init 中 (canonical モード) に長い launch を送ると MAX_CANON (≈1KB) 超過分が
    // 破棄され切断される。長い起動コマンドはファイルへ書き出し、tmux には十分短い
    // `source <path>` のみ送ることで、zle (RAW モード) 起動前の canonical 状態でも切断
    // されない。
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(cfg, 5000);

    // 起動コマンドは send-keys ではなくファイル書き込みで渡される
    const scriptPath = launchScriptPath();
    expect(scriptPath).toContain("beacon-launch.sh");
    // launch スクリプトは beacon-launch ディレクトリ (mcp-config と同階層) に置く
    expect(scriptPath).toBe("/data/beacon-launch/beacon-launch.sh");

    // tmux へは長い launch ではなく短い `source <path>` を送る
    const sendKeys = (
      spawnSyncMock.mock.calls as Array<[string, string[]]>
    ).filter(([, a]) => a?.[0] === "send-keys");
    const sourceSend = sendKeys.find(([, a]) =>
      a.some(x => typeof x === "string" && x.startsWith("source "))
    );
    expect(sourceSend).toBeDefined();
    const sourceArg = sourceSend?.[1].find(
      x => typeof x === "string" && x.startsWith("source ")
    ) as string;
    // source 行は MAX_CANON (≈1024) 未満で、長い claude 起動コマンドを含まない
    expect(sourceArg.length).toBeLessThan(1024);
    expect(sourceArg).not.toContain("--add-dir");
    expect(sourceArg).toContain(scriptPath);
  });

  it("launch スクリプトは mode 0600 + 排他作成 (wx) で書き、内容は launch + 改行", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(cfg, 5000);

    const writeCall = (
      fsMock.writeFileSync.mock.calls as Array<
        [string, string, { mode?: number; flag?: string }]
      >
    ).find(([path]) => path.endsWith("beacon-launch.sh"));
    expect(writeCall).toBeDefined();
    const [, content, opts] = writeCall as [
      string,
      string,
      { mode?: number; flag?: string },
    ];
    // 秘密 (token) は mcp-config 側なので 0600 で十分だが、他ユーザー読取りは塞ぐ
    expect(opts?.mode).toBe(0o600);
    // symlink 追従上書きを防ぐ排他作成
    expect(opts?.flag).toBe("wx");
    // 書き込み内容は起動コマンド + 末尾改行 (source で 1 行として実行される)
    expect(content.endsWith("\n")).toBe(true);
    expect(content).toContain("--add-dir");
  });

  it("launch スクリプト書き込み前に既存エントリを rm する (symlink 追従防止)", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(cfg, 5000);

    // rm が呼ばれ、その対象が書き込み先と同一であること
    const rmIdx = (
      fsMock.rmSync.mock.calls as Array<[string, unknown]>
    ).findIndex(
      ([p]) => typeof p === "string" && p.endsWith("beacon-launch.sh")
    );
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    const rmCall = fsMock.rmSync.mock.calls[rmIdx] as [string, unknown];
    expect(rmCall[0]).toBe(launchScriptPath());
    // force: true (存在しなくてもエラーにしない)
    expect((rmCall[1] as { force?: boolean })?.force).toBe(true);

    // rm → wx 作成の順序を保証する (write 後に rm すると symlink 防御が無効になるため)。
    const writeIdx = (
      fsMock.writeFileSync.mock.calls as Array<[string, string]>
    ).findIndex(([path]) => path.endsWith("beacon-launch.sh"));
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    const rmOrder = fsMock.rmSync.mock.invocationCallOrder[rmIdx];
    const writeOrder = fsMock.writeFileSync.mock.invocationCallOrder[writeIdx];
    expect(rmOrder).toBeLessThan(writeOrder);
  });

  it("launch ディレクトリが owner 専用でない (group/other 権限あり) なら起動を拒否する (TOCTOU 差し替え防止)", async () => {
    // group 書き込み可 (0770) のディレクトリは第三者が source 対象を差し替え可能なので拒否
    fsMock.statSync.mockReturnValue({
      mode: 0o770,
      uid: PRIVATE_DIR_UID,
      mtimeMs: 0,
    });
    const session = new BeaconCliSession("/data/beacon-cwd");
    await expect(session.start(cfg, 5000)).rejects.toThrow(
      /owner 専用|private/
    );
    // 危険なディレクトリには launch script を書かない
    expect(launchScriptWrite()).toBeUndefined();
  });

  it("launch ディレクトリが現ユーザー所有でないなら起動を拒否する", async () => {
    fsMock.statSync.mockReturnValue({
      mode: 0o700,
      uid: PRIVATE_DIR_UID + 12345, // 別ユーザー
      mtimeMs: 0,
    });
    const session = new BeaconCliSession("/data/beacon-cwd");
    await expect(session.start(cfg, 5000)).rejects.toThrow(/所有/);
    expect(launchScriptWrite()).toBeUndefined();
  });

  it("既に起動済み (has-session 成功) なら再起動せず new-session を呼ばない", async () => {
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: 0 }; // 起動済み
        if (args?.[0] === "capture-pane") {
          return { stdout: "? for shortcuts", status: 0 };
        }
        return { status: 0, stdout: "" };
      }
    );
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(cfg, 5000);

    const newSessionCalled = (
      spawnSyncMock.mock.calls as Array<[string, string[]]>
    ).some(([, args]) => args?.[0] === "new-session");
    expect(newSessionCalled).toBe(false);
  });

  it("準備プロンプトが出ないまま timeout したら例外を投げる (黙って続行しない)", async () => {
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: 1 };
        // ずっと未準備 (起動途中の画面が残り続ける)
        if (args?.[0] === "capture-pane") {
          return { stdout: "Loading…", status: 0 };
        }
        return { status: 0, stdout: "" };
      }
    );
    const session = new BeaconCliSession("/data/beacon-cwd");
    await expect(session.start(cfg, 1500)).rejects.toThrow(
      /起動完了|タイムアウト/
    );
  });

  it("attachIfRunning: 生存かつ準備完了なら true (再接続)", () => {
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: 0 };
        if (args?.[0] === "capture-pane") {
          return { stdout: "? for shortcuts", status: 0 };
        }
        return { status: 0, stdout: "" };
      }
    );
    const session = new BeaconCliSession("/data/beacon-cwd");
    expect(session.attachIfRunning()).toBe(true);
  });

  it("attachIfRunning: 生存していても未準備 (login 画面のまま) なら false", () => {
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: 0 }; // セッションは残存
        if (args?.[0] === "capture-pane") {
          // 起動失敗で login 画面のまま wedge
          return { stdout: "Welcome to Claude Code\n/login", status: 0 };
        }
        return { status: 0, stdout: "" };
      }
    );
    const session = new BeaconCliSession("/data/beacon-cwd");
    // 未準備の pane に send-keys しないよう再接続を拒否する
    expect(session.attachIfRunning()).toBe(false);
  });

  it("tmux はあるが claude が死んでいる (stale) なら kill して作り直す", async () => {
    let killed = false;
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: killed ? 1 : 0 };
        if (args?.[0] === "kill-session") {
          killed = true;
          return { status: 0 };
        }
        if (args?.[0] === "capture-pane") {
          // kill 前: shell プロンプト (claude 死亡)。kill→再起動後: ready
          return {
            stdout: killed ? "? for shortcuts" : "user@host:~/work$ ",
            status: 0,
          };
        }
        return { status: 0, stdout: "" };
      }
    );
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(cfg, 5000);

    const calls = spawnSyncMock.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, a]) => a?.[0] === "kill-session")).toBe(true);
    expect(calls.some(([, a]) => a?.[0] === "new-session")).toBe(true);
  });

  it("isAborted が true なら起動待ちを即打ち切る (timeout/throw しない)", async () => {
    // 準備プロンプトは永遠に出ない (常に Loading)。中断が無ければ throw するはず。
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: 1 };
        if (args?.[0] === "capture-pane") {
          return { stdout: "Loading…", status: 0 };
        }
        return { status: 0, stdout: "" };
      }
    );
    const session = new BeaconCliSession("/data/beacon-cwd");
    // isAborted=true → 待たずに静かに return (例外なし)
    await expect(
      session.start(cfg, 60_000, () => true)
    ).resolves.toBeUndefined();
  });

  it("未認証 (オンボーディング画面) なら例外を投げる", async () => {
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: 1 };
        if (args?.[0] === "capture-pane") {
          return {
            stdout: "Welcome to Claude Code\n/login",
            status: 0,
          };
        }
        return { status: 0, stdout: "" };
      }
    );
    const session = new BeaconCliSession("/data/beacon-cwd");
    await expect(session.start(cfg, 1500)).rejects.toThrow(/未認証|login/i);
  });
});

describe("BeaconCliSession.sendTurn 入力送信", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "capture-pane") {
          return { stdout: "? for shortcuts", status: 0 };
        }
        return { status: 0, stdout: "" };
      }
    );
    fsMock.readdirSync.mockReturnValue([]);
  });

  it("単一行は send-keys -l で送る (load-buffer を使わない)", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.sendTurn("hello world", { onText: () => {} }, 50);
    const calls = spawnSyncMock.mock.calls as Array<[string, string[]]>;
    expect(
      calls.some(
        ([, a]) => a?.[0] === "send-keys" && a?.includes("hello world")
      )
    ).toBe(true);
    expect(calls.some(([, a]) => a?.[0] === "load-buffer")).toBe(false);
  });

  it("制御文字を除去してから送信する (端末注入防止。\\t/\\n は維持)", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    // ESC / C-c / DEL を含む単一行
    await session.sendTurn("hithere!", { onText: () => {} }, 50);
    const calls = spawnSyncMock.mock.calls as Array<[string, string[]]>;
    const sk = calls.find(
      ([, a]) => a?.[0] === "send-keys" && a?.includes("-l")
    );
    const sent = sk?.[1]?.[(sk[1]?.indexOf("-l") ?? -1) + 1];
    expect(sent).toBe("hithere!"); // 制御文字のみ除去
  });

  it("送信後にセッションが消えていたら即 completed=false で返す (turn timeout を待たない)", async () => {
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: 1 }; // 消滅
        return { status: 0, stdout: "" };
      }
    );
    const session = new BeaconCliSession("/data/beacon-cwd");
    // turn timeout を 10 分にしても即返ることを確認 (実時間で検証)
    const r = await session.sendTurn("hi", { onText: () => {} }, 600_000);
    expect(r.completed).toBe(false);
  });

  it("複数行で load-buffer が失敗したら例外を投げる (空 turn を黙って送らない)", async () => {
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "capture-pane") {
          return { stdout: "? for shortcuts", status: 0 };
        }
        if (args?.[0] === "load-buffer") return { status: 1 }; // 失敗
        return { status: 0, stdout: "" };
      }
    );
    const session = new BeaconCliSession("/data/beacon-cwd");
    await expect(
      session.sendTurn("a\nb\nc", { onText: () => {} }, 50)
    ).rejects.toThrow(/load-buffer/);
  });

  it("複数行は load-buffer(stdin) + paste-buffer -p で 1 入力として送る", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.sendTurn("line1\nline2\nline3", { onText: () => {} }, 50);
    const calls = spawnSyncMock.mock.calls as Array<
      [string, string[], { input?: string }?]
    >;
    // 本文は stdin (input) で渡す (argv 上限回避)
    const load = calls.find(([, a]) => a?.[0] === "load-buffer");
    expect(load).toBeDefined();
    expect(load?.[2]?.input).toBe("line1\nline2\nline3");
    const paste = calls.find(([, a]) => a?.[0] === "paste-buffer");
    expect(paste?.[1]).toContain("-p"); // bracketed paste
    // 生 send-keys -l で複数行を送らない (各行が Enter として確定されるのを防ぐ)
    expect(
      calls.some(
        ([, a]) => a?.[0] === "send-keys" && a?.includes("line1\nline2\nline3")
      )
    ).toBe(false);
  });
});

describe("BeaconCliSession.recoverPending (取りこぼし回収)", () => {
  const JSONL_PATH = "/home/tester/.claude/projects/-data-beacon-cwd/s.jsonl";
  const lines = [
    JSON.stringify({ type: "user", cwd: "/data/beacon-cwd" }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "古い応答" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "停止中に完走した応答" }] },
    }),
  ];

  beforeEach(() => {
    spawnSyncMock.mockReset();
    // セッションは生存 (has-session 成功)
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: 0 };
        return { status: 0, stdout: "" };
      }
    );
    fsMock.readdirSync.mockReturnValue(["s.jsonl"]);
    fsMock.writeFileSync.mockClear();
    fsMock.rmSync.mockClear();
    fsMock.statSync.mockReturnValue({
      mode: 0o700,
      uid: PRIVATE_DIR_UID,
      mtimeMs: 1,
      size: 100,
    });
    // 実在するのは JSONL_PATH のみ。他パスは ENOENT で読めない (resume は保存パスを直接読む)。
    // 実 transcript と同様に各行 (最終行含む) は改行で終端する (= 完全な行)。
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (String(p) === JSONL_PATH) return `${lines.join("\n")}\n`;
      throw new Error("ENOENT");
    });
  });

  it("保存オフセット以降の未処理 assistant を回収する", () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    const texts: string[] = [];
    const r = session.recoverPending(
      { path: JSONL_PATH, lines: 2 }, // 行 0,1 は処理済み → 行 2 が取りこぼし
      { onText: c => texts.push(c) }
    );
    expect(r?.text).toBe("停止中に完走した応答");
    expect(texts).toContain("停止中に完走した応答");
  });

  it("保存パスが現在の JSONL と一致しなければ baseline のみで null を返す", () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    const r = session.recoverPending(
      { path: "/other/path.jsonl", lines: 0 },
      { onText: () => {} }
    );
    // 別会話のオフセットでは過去会話全体を誤って回収しない
    expect(r).toBeNull();
  });

  it("fresh launch では保存オフセットを無視する (古い transcript を再利用しない)", async () => {
    // start() が new-session を作る = wasFreshLaunch=true。has-session は作成前 1 / 作成後 0。
    let created = false;
    spawnSyncMock.mockImplementation(
      (_bin: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: created ? 0 : 1 };
        if (args?.[0] === "new-session") {
          created = true;
          return { status: 0 };
        }
        if (args?.[0] === "capture-pane") {
          return { stdout: "? for shortcuts", status: 0 };
        }
        return { status: 0, stdout: "" };
      }
    );
    const cfg = {
      mcpConfigPath: "/x/mcp.json",
      systemPromptFile: "/x/sp.txt",
      allowedTools: ["Read"],
      addDirs: [],
    };
    const session = new BeaconCliSession("/data/beacon-cwd");
    await session.start(cfg, 5000); // new-session → wasFreshLaunch=true

    const texts: string[] = [];
    // 古い JSONL_PATH は実在するが、fresh なので保存オフセットを使ってはいけない
    const r = session.recoverPending(
      { path: JSONL_PATH, lines: 0 },
      { onText: c => texts.push(c) }
    );
    expect(r).toBeNull();
    expect(texts).toEqual([]); // 古い会話を再生しない
  });

  it("保存オフセット無し + 既存セッション再接続 (非 fresh) なら既存 transcript を baseline し再生しない", () => {
    // wasFreshLaunch は start() 未呼び出しなら false (= attach / 再接続相当)
    const session = new BeaconCliSession("/data/beacon-cwd");
    const texts: string[] = [];
    const r = session.recoverPending(null, { onText: c => texts.push(c) });
    expect(r).toBeNull(); // 回収はしない
    // 過去会話全体を新規行として再生しない (P1: rollout 直後 / settings 消失時の重複防止)
    expect(texts).toEqual([]);
  });
});

describe("isReady (起動完了アンカー)", () => {
  it('footer hint "for shortcuts" 表示で ready', () => {
    expect(isReady("─────\n❯\n─────\n  ? for shortcuts")).toBe(true);
  });

  it("入力プロンプト記号 ❯ だけでも ready (hint が rotate / スプラッシュで消えても検出)", () => {
    // 実機: claude 2.1.156 の Welcome/"What's new" スプラッシュ + カスタム statusline 環境では
    // footer が "← for agents" / "PR #201" になり "for shortcuts" が出ない。
    const welcomeSplashPane = [
      "╭─── Claude Code v2.1.156 ───╮",
      "│        Welcome back Shoma! │",
      "│        What's new          │",
      "╰────────────────────────────╯",
      "──────────────────────────────",
      "❯ ",
      "──────────────────────────────",
      "  PR #201 · ← for agents",
    ].join("\n");
    expect(isReady(welcomeSplashPane)).toBe(true);
  });

  it("プロンプトも hint も無い起動途中の pane は ready ではない", () => {
    expect(isReady("Loading…\nConnecting to MCP servers…")).toBe(false);
  });
});

describe("tmuxExec の非0終了ハンドリング (#1)", () => {
  it("send-keys が非0終了したら stderr 付きで例外化する", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    spawnSyncMock.mockImplementation(
      (_b: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") return { status: 0 }; // 送信時点では生存
        if (args?.[0] === "send-keys")
          return { status: 1, stderr: Buffer.from("no server running") };
        if (args?.[0] === "capture-pane") return { stdout: "", status: 0 };
        return { status: 0, stdout: "" };
      }
    );
    await expect(
      session.sendTurn("hi", { onText: () => {} }, 5000)
    ).rejects.toThrow(/send-keys が異常終了.*no server running/);
  });

  it("kill-session の非0終了は許容する (冪等な破棄)", () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    spawnSyncMock.mockImplementation(
      (_b: string, args: string[] | undefined) => {
        if (args?.[0] === "kill-session")
          return { status: 1, stderr: Buffer.from("can't find session") };
        return { status: 0, stdout: "" };
      }
    );
    expect(() => session.kill()).not.toThrow();
  });
});

describe("sendTurn のターン中セッション生存確認 (#2)", () => {
  it("ターン中にセッションが消えたら turnTimeout を待たず completed=false で抜ける", async () => {
    const session = new BeaconCliSession("/data/beacon-cwd");
    let hasSessionCalls = 0;
    spawnSyncMock.mockImplementation(
      (_b: string, args: string[] | undefined) => {
        if (args?.[0] === "has-session") {
          hasSessionCalls += 1;
          // 1 回目 (送信直後) は生存、以降は消失 (tmux/claude クラッシュ相当)
          return { status: hasSessionCalls <= 1 ? 0 : 1 };
        }
        // 常に ready/busy いずれでもない空 pane → 生存確認が無いと deadline まで回る
        if (args?.[0] === "capture-pane") return { stdout: "", status: 0 };
        return { status: 0, stdout: "" };
      }
    );
    // turnTimeoutMs を 10 分にしても、生存確認で即抜けるので数秒で解決する
    const r = await session.sendTurn(
      "hi",
      { onText: () => {} },
      10 * 60 * 1000
    );
    expect(r.completed).toBe(false);
    expect(hasSessionCalls).toBeGreaterThanOrEqual(2);
  });
});
