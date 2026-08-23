import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupLegacyContextSettings } from "./legacy-context-settings-cleanup.js";

/**
 * 撤去済み ark/context が repo へ書き残した settings の掃除 (#367 の移行)。
 *
 * 永続 tmux セッションを持つ環境では teardown が走らないまま機構が消えるため、
 * 「注入されたまま残った hook と deny を取り除けること」と
 * 「利用者の設定に触れないこと」の両方を固定する。
 */
describe("cleanupLegacyContextSettings", () => {
  let worktree: string;
  let settingsPath: string;

  const write = (value: unknown): void => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      typeof value === "string" ? value : JSON.stringify(value, null, 2)
    );
  };
  const read = (): Record<string, never> =>
    JSON.parse(fs.readFileSync(settingsPath, "utf-8"));

  const legacyHook = (script: string) => ({
    hooks: [
      {
        type: "command",
        command: `"$CLAUDE_PROJECT_DIR"/ark/context/adapters/claude-code/${script}`,
      },
    ],
  });

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ark-legacy-"));
    settingsPath = path.join(worktree, ".claude", "settings.local.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("注入された hook と deny を取り除き、利用者の設定は残す", () => {
    write({
      permissions: {
        allow: ["Bash(pnpm check:*)"],
        deny: ["TodoWrite", "TaskCreate", "TaskUpdate", "Read(./secret)"],
      },
      enabledMcpjsonServers: ["spec-workflow"],
      hooks: {
        PostToolBatch: [legacyHook("post-tool-batch.sh")],
        PostToolUseFailure: [legacyHook("post-tool-use-failure.sh")],
      },
    });

    const result = cleanupLegacyContextSettings(worktree);

    expect(result.changed).toBe(true);
    expect(result.removedHooks).toBe(2);
    expect(result.removedDeny.sort()).toEqual([
      "TaskCreate",
      "TaskUpdate",
      "TodoWrite",
    ]);
    const after = read();
    expect(after).not.toHaveProperty("hooks");
    expect(after.permissions).toEqual({
      allow: ["Bash(pnpm check:*)"],
      deny: ["Read(./secret)"],
    });
    expect(after.enabledMcpjsonServers).toEqual(["spec-workflow"]);
  });

  it("同じ event に残る利用者の hook は消さない", () => {
    write({
      hooks: {
        PostToolBatch: [
          legacyHook("post-tool-batch.sh"),
          { hooks: [{ type: "command", command: "echo mine" }] },
        ],
      },
    });

    expect(cleanupLegacyContextSettings(worktree).removedHooks).toBe(1);
    expect(read().hooks).toEqual({
      PostToolBatch: [{ hooks: [{ type: "command", command: "echo mine" }] }],
    });
  });

  it("同じグループに legacy と利用者の command が同居しても利用者側を残す", () => {
    // entry 単位で落とすと matcher ごと消える。command 単位で除けているかを固定する。
    write({
      hooks: {
        PostToolBatch: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command:
                  '"$CLAUDE_PROJECT_DIR"/ark/context/adapters/claude-code/post-tool-batch.sh',
              },
              { type: "command", command: "echo mine" },
            ],
          },
        ],
      },
    });

    expect(cleanupLegacyContextSettings(worktree).removedHooks).toBe(1);
    expect(read().hooks).toEqual({
      PostToolBatch: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "echo mine" }],
        },
      ],
    });
  });

  it("settings が書き込めなくても例外を投げず no-op で返す", () => {
    // 掃除の失敗でセッション起動が止まってはならない。
    write({
      permissions: { deny: ["TodoWrite", "TaskCreate", "TaskUpdate"] },
      hooks: { PostToolBatch: [legacyHook("post-tool-batch.sh")] },
    });
    const before = fs.readFileSync(settingsPath, "utf-8");
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });
    const warn = vi.spyOn(console, "warn");

    expect(() => cleanupLegacyContextSettings(worktree)).not.toThrow();
    expect(cleanupLegacyContextSettings(worktree).changed).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EROFS"));

    spy.mockRestore();
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("ark/context の hook が無ければ deny に触れない", () => {
    // 同じ tool を利用者が自分で拒否しているだけ、という可能性を潰さない。
    // ファイルは ark/context を含む (= 早期 return では抜けない) が、
    // hook としては注入されていない状態を作る。
    const original = {
      permissions: {
        allow: ["Bash(cat ark/context/README.md)"],
        deny: ["TodoWrite", "TaskCreate", "TaskUpdate"],
      },
    };
    write(original);

    expect(cleanupLegacyContextSettings(worktree)).toMatchObject({
      changed: false,
      removedHooks: 0,
      removedDeny: [],
    });
    expect(read()).toEqual(original);
  });

  it("2 回目は何もしない（冪等）", () => {
    write({
      permissions: { deny: ["TodoWrite", "TaskCreate", "TaskUpdate"] },
      hooks: { PostToolBatch: [legacyHook("post-tool-batch.sh")] },
    });

    expect(cleanupLegacyContextSettings(worktree).changed).toBe(true);
    const afterFirst = fs.readFileSync(settingsPath, "utf-8");
    expect(cleanupLegacyContextSettings(worktree).changed).toBe(false);
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(afterFirst);
  });

  it("空文字や相対パスでは呼び出し元の cwd を掃除しない", () => {
    // worktreePath は pane_current_path を取れないと空文字で復元される。
    // そのまま渡すとサーバーの cwd を掃除してしまう。
    const cwdSettings = path.join(
      process.cwd(),
      ".claude",
      "settings.local.json"
    );
    const before = fs.existsSync(cwdSettings)
      ? fs.readFileSync(cwdSettings, "utf-8")
      : null;

    for (const bad of ["", ".", "./somewhere", "relative/path"]) {
      expect(cleanupLegacyContextSettings(bad)).toMatchObject({
        changed: false,
        removedHooks: 0,
      });
    }

    const after = fs.existsSync(cwdSettings)
      ? fs.readFileSync(cwdSettings, "utf-8")
      : null;
    expect(after).toBe(before);
  });

  it("settings が無ければ何もしない", () => {
    expect(cleanupLegacyContextSettings(worktree).changed).toBe(false);
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it("JSON が壊れていれば書き換えず理由を残す", () => {
    write('{"hooks": {"PostToolBatch": [ark/context');
    const warn = vi.spyOn(console, "warn");

    expect(cleanupLegacyContextSettings(worktree).changed).toBe(false);
    expect(fs.readFileSync(settingsPath, "utf-8")).toContain("ark/context");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("JSON として読めない")
    );
  });

  it("ark/context を含まないファイルは読むだけで書き換えない", () => {
    const original = { permissions: { allow: ["Bash(ls)"] } };
    write(original);
    const before = fs.statSync(settingsPath).mtimeMs;

    expect(cleanupLegacyContextSettings(worktree).changed).toBe(false);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(before);
    expect(read()).toEqual(original);
  });
});
