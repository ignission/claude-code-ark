/**
 * auq-hook-bridge のテスト
 *
 * PendingAuq が screen (hook 受信時の tmux 画面 verbatim スナップショット)
 * を保持し、再接続時の再送 (getPending) でも返せることを検証する。
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./database.js", () => ({
  db: {
    getSetting: vi.fn(() => null),
    setSetting: vi.fn(),
  },
}));

vi.mock("./paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/ark-test-data"),
}));

import { AuqHookBridge } from "./auq-hook-bridge.js";
import {
  BOARD_SESSION_CONTEXT,
  BOARD_SESSION_START_HOOK_FILENAME,
} from "./board-session-start-hook.js";
import { getDataDir } from "./paths.js";

const mockedGetDataDir = vi.mocked(getDataDir);
const tempDirs: string[] = [];

function createDataDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-hook-settings-"))
  );
  tempDirs.push(dir);
  mockedGetDataDir.mockReturnValue(dir);
  return dir;
}

afterEach(() => {
  mockedGetDataDir.mockReturnValue("/tmp/ark-test-data");
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("AuqHookBridge - hooks settings", () => {
  it("SessionStart と PreToolUse を同じ妥当な settings JSON に 0600 で書く", () => {
    const dataDir = createDataDir();
    const settingsPath = new AuqHookBridge().writeSettingsFile(4012);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));

    expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "PreToolUse"]);
    expect(settings.hooks.SessionStart).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `/bin/sh '${path.join(dataDir, BOARD_SESSION_START_HOOK_FILENAME)}'`,
          },
        ],
      },
    ]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
      "/api/internal/auq-event"
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).not.toContain(
      "このセッションにはボードペイン"
    );
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(
      fs.statSync(path.join(dataDir, BOARD_SESSION_START_HOOK_FILENAME)).mode &
        0o777
    ).toBe(0o600);
  });

  it("既存 settings と hook の mode を 0600 に矯正する", () => {
    const dataDir = createDataDir();
    const settingsPath = path.join(dataDir, "ark-claude-settings.json");
    const hookPath = path.join(dataDir, BOARD_SESSION_START_HOOK_FILENAME);
    fs.writeFileSync(settingsPath, "{}\n", { mode: 0o644 });
    fs.writeFileSync(hookPath, "old\n", { mode: 0o644 });
    fs.chmodSync(settingsPath, 0o644);
    fs.chmodSync(hookPath, 0o644);

    new AuqHookBridge().writeSettingsFile(4012);

    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(hookPath).mode & 0o777).toBe(0o600);
  });

  it("SessionStart hook はボードの説明を additionalContext として返す", () => {
    createDataDir();
    const settingsPath = new AuqHookBridge().writeSettingsFile(4012);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const command = settings.hooks.SessionStart[0].hooks[0].command;

    // hook は stdin を読まず静的 JSON を返す契約なので、stdin を渡さない。
    // input を書き込むと子プロセスが先に終了して EPIPE になり、
    // 負荷のかかるフルスイートでだけ落ちる flaky になる。
    const stdout = execSync(command, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const output = JSON.parse(stdout);

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: BOARD_SESSION_CONTEXT,
      },
    });
    expect(output.hookSpecificOutput.additionalContext).toContain("board_open");
    expect(output.hookSpecificOutput.additionalContext).toContain("todo_add");
  });
});

describe("AuqHookBridge - 回答待ちの質問", () => {
  it("setPending で渡した質問を getPending が返し、再 setPending で上書きする", () => {
    const bridge = new AuqHookBridge();
    const questions = [{ question: "どちらにしますか?" }];
    bridge.setPending("s1", []);
    bridge.setPending("s1", questions);
    expect(bridge.getPending("s1")?.questions).toBe(questions);
  });
});
